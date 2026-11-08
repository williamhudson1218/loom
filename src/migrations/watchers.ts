import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { MigrationContext, MigrationStep } from '../migrate.ts';
import { getSetting } from '../settingsSchema.ts';
import { ensureWatcherColumns } from '../schema.ts';
import { laneFromSpawns } from './settings.ts';

// Watchers and EM data (§9.5). One transaction with the rest of the migration,
// idempotent, and safe on a DB that is already at settings_schema 2 (the step
// was added after the first migration shipped, so an install can reach it
// either way).
//
//   legacy Slack watchers  -> v2 rows in place: source slack {channel, workspace},
//                             the same trigger and params, action start_chat in
//                             the same project, on the lane its workers used,
//                             with the brief file's text. Run mode Live, enabled
//                             as it was, no caps, poll state and watcher_seen kept
//   watcher_spawns         -> watcher_events (spawned = fired/started, queued =
//                             fired/queued so the new loop drains it, dry_run =
//                             shadow/would_fire, already reviewed)
//   em_mode shadow|live    -> the 3 EM detectors as chat watchers, enabled, in
//                             that run mode, with the EM's thresholds. off: none.
//                             The em_mode row is then deleted
//   em_findings/em_actions -> NOT converted (D15). afterCommit exports them once
//                             to $LOOM_HOME/archive/em-ledger-<date>.jsonl; the
//                             tables are left in place, unread
//
// Converting a watcher is keyed on its trigger_kind being empty, events on
// (watcher_id, event_key), the EM watchers on their fixed ids: a second run
// finds everything done and changes nothing.

const tableExists = (db: Database.Database, name: string): boolean =>
  !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);

const readRow = (db: Database.Database, key: string): string | undefined =>
  (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;

/** The EM's thresholds (src/em/detectors.ts THRESHOLDS), so Shadow data stays comparable. */
export const EM_THRESHOLDS = { blockedIdleMs: 90_000, blockedMaxIdleMs: 24 * 3_600_000, wrappableIdleMs: 10 * 60_000, bloatedFraction: 0.7 };
/** The EM's one-intervention-per-(session, detector)-per-hour cooldown and its hourly pane-write cap. */
const EM_COOLDOWN_MIN = 60;
const EM_PER_HOUR = 30;

export const EM_WATCHERS = [
  {
    id: 'em-waiting-on-you',
    label: 'Waiting on you',
    trigger: ['waiting_on_user', { min_sec: EM_THRESHOLDS.blockedIdleMs / 1000, max_h: EM_THRESHOLDS.blockedMaxIdleMs / 3_600_000 }],
    action: ['tell_orch', { template: '{{CHAT_TITLE}} has been waiting on you for {{IDLE_MIN}} min' }],
  },
  {
    id: 'em-ready-to-wrap',
    label: 'Finished, ready to wrap up',
    trigger: ['done_idle', { min: EM_THRESHOLDS.wrappableIdleMs / 60_000 }],
    action: ['notify', { template: '{{CHAT_TITLE}} is done and ready to wrap up' }],
  },
  {
    id: 'em-context-full',
    label: 'Context nearly full',
    trigger: ['context_over', { fraction: EM_THRESHOLDS.bloatedFraction }],
    action: ['message_chat', { template: 'Your context is {{PERCENT}}% full. Write a short handoff brief now (goal, what is done with file names, what is left, decisions to keep) so a fresh session can continue.' }],
  },
] as const;

interface LegacyWatcher {
  id: string;
  channel: string;
  rule_kind: string;
  rule_params: string;
  brief_path: string;
  project_dir: string;
  workspace: string;
}

/** The lane an old watcher's workers ran in: the stored default target, else its spawn history, else managed. */
function legacyTarget(ctx: Pick<MigrationContext, 'db' | 'env'>): string {
  const row = readRow(ctx.db, 'watcher_default_target');
  if (row && (row === 'managed' || /^lane:[a-z0-9][a-z0-9-]*$/.test(row))) return row;
  let prefix = 'loom-';
  try {
    prefix = String(getSetting(ctx.db, 'session_prefix', { env: ctx.env }));
  } catch {
    /* default prefix */
  }
  const lane = laneFromSpawns(ctx.db, prefix);
  return lane ? `lane:${lane}` : 'managed';
}

export function convertWatchers(ctx: Pick<MigrationContext, 'db' | 'env' | 'now' | 'log'>): number {
  const { db } = ctx;
  ensureWatcherColumns(db);
  const rows = db.prepare(`SELECT id, channel, rule_kind, rule_params, brief_path, project_dir, workspace FROM watchers WHERE trigger_kind = '' AND rule_kind != ''`).all() as LegacyWatcher[];
  if (!rows.length) return 0;
  const target = legacyTarget(ctx);
  const up = db.prepare(
    `UPDATE watchers SET run_mode = 'live', source_kind = 'slack', source_params = ?, trigger_kind = ?, trigger_params = ?,
       action_kind = 'start_chat', action_params = ?, max_per_hour = 0, cooldown_min = 0, quiet_start = '', quiet_end = '',
       created_at = CASE WHEN created_at = 0 THEN ? ELSE created_at END, updated_at = ?
     WHERE id = ? AND trigger_kind = ''`,
  );
  for (const w of rows) {
    let brief = '';
    try {
      brief = fs.readFileSync(w.brief_path, 'utf-8');
    } catch {
      ctx.log(`watchers: ${w.id}: brief ${w.brief_path} is unreadable; converted with an empty brief (it reports that instead of starting)`);
    }
    let params: unknown = {};
    try {
      params = JSON.parse(w.rule_params || '{}');
    } catch {
      /* the old loop threw on this too */
    }
    up.run(
      JSON.stringify({ channel: w.channel, workspace: w.workspace }),
      w.rule_kind,
      JSON.stringify(params && typeof params === 'object' ? params : {}),
      JSON.stringify({ project_dir: w.project_dir, target, brief_template: brief, perm: 'inherit' }),
      ctx.now,
      ctx.now,
      w.id,
    );
  }
  ctx.log(`watchers: ${rows.length} Slack watcher(s) converted (target ${target})`);
  return rows.length;
}

interface SpawnRow {
  watcher_id: string;
  ts: string;
  title: string;
  permalink: string;
  status: string;
  pane_id: string;
  pane_name: string;
  pane_where: string;
  brief_path: string;
  queued_at: number;
  spawned_at: number;
  detail: string;
}

export function convertSpawns(ctx: Pick<MigrationContext, 'db' | 'now' | 'log'>): number {
  const { db } = ctx;
  if (!tableExists(db, 'watcher_spawns')) return 0;
  const channels = new Map((db.prepare(`SELECT id, channel FROM watchers`).all() as { id: string; channel: string }[]).map((r) => [r.id, r.channel]));
  const ins = db.prepare(
    `INSERT OR IGNORE INTO watcher_events (watcher_id, event_key, subject, title, permalink, detected_at, mode, decision, result, detail, pane_id, pane_name, pane_where, brief_path, acted_at, reviewed_at)
     VALUES (@watcher_id, @event_key, @subject, @title, @permalink, @detected_at, @mode, @decision, @result, @detail, @pane_id, @pane_name, @pane_where, @brief_path, @acted_at, @reviewed_at)`,
  );
  let n = 0;
  for (const s of db.prepare(`SELECT * FROM watcher_spawns ORDER BY id`).all() as SpawnRow[]) {
    const dry = s.status === 'dry_run';
    const queued = s.status === 'queued';
    n += ins.run({
      watcher_id: s.watcher_id,
      event_key: s.ts,
      subject: `slack:${channels.get(s.watcher_id) ?? ''}/${s.ts}`,
      title: s.title,
      permalink: s.permalink,
      detected_at: s.queued_at,
      mode: dry ? 'shadow' : 'live',
      decision: dry ? 'would_fire' : 'fired',
      result: dry ? '' : queued ? 'queued' : 'started',
      detail: s.detail,
      pane_id: s.pane_id,
      pane_name: s.pane_name,
      pane_where: s.pane_where,
      brief_path: s.brief_path,
      acted_at: s.spawned_at,
      reviewed_at: dry ? ctx.now : 0,
    }).changes;
  }
  if (n) ctx.log(`watchers: ${n} spawn record(s) copied to watcher_events`);
  return n;
}

/** The EM's mode as the EM read it: unset = shadow, unparseable = off. */
export function legacyEmMode(db: Database.Database): 'off' | 'shadow' | 'live' {
  const v = readRow(db, 'em_mode');
  if (v === undefined) return 'shadow';
  return v === 'shadow' || v === 'live' ? v : 'off';
}

export function convertEm(ctx: Pick<MigrationContext, 'db' | 'now' | 'log'>): number {
  const { db } = ctx;
  // A fresh DB never had the EM; only an install that ran it (its tables, or an em_mode row) gets the watchers.
  const hadEm = tableExists(db, 'em_findings') || readRow(db, 'em_mode') !== undefined;
  if (!hadEm) return 0;
  const mode = legacyEmMode(db);
  let n = 0;
  if (mode !== 'off') {
    const ins = db.prepare(
      `INSERT OR IGNORE INTO watchers (id, label, channel, rule_kind, rule_params, brief_path, project_dir, workspace, enabled,
         run_mode, source_kind, source_params, trigger_kind, trigger_params, action_kind, action_params,
         max_per_hour, cooldown_min, quiet_start, quiet_end, template_id, created_at, updated_at)
       VALUES (?, ?, '', '', '{}', '', '', '', 1, ?, 'chats', ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?)`,
    );
    for (const w of EM_WATCHERS) {
      n += ins.run(w.id, w.label, mode, JSON.stringify({ projects: [], tags: [] }), w.trigger[0], JSON.stringify(w.trigger[1]), w.action[0], JSON.stringify(w.action[1]), EM_PER_HOUR, EM_COOLDOWN_MIN, ctx.now, ctx.now).changes;
    }
    if (n) ctx.log(`watchers: em_mode=${mode} -> ${n} chat watcher(s) in ${mode === 'live' ? 'Live' : 'Shadow'}`);
  }
  db.prepare(`DELETE FROM settings WHERE key = 'em_mode'`).run();
  return n;
}

/** The archive file for the EM ledger. One per install: the date is the migration's. */
export function emArchivePath(loomHome: string, now: number): string {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return path.join(loomHome, 'archive', `em-ledger-${day}.jsonl`);
}

/**
 * Export em_findings and em_actions, one JSON object per line ({table, ...row}),
 * for threshold calibration. Skipped when an export already exists. Written to a
 * temp file and renamed, so a crash never leaves a half file that reads as done.
 */
export function exportEmLedger(ctx: Pick<MigrationContext, 'db' | 'loomHome' | 'now' | 'log'>): string | null {
  const { db } = ctx;
  if (!tableExists(db, 'em_findings') && !tableExists(db, 'em_actions')) return null;
  const dir = path.join(ctx.loomHome, 'archive');
  try {
    if (fs.readdirSync(dir).some((f) => f.startsWith('em-ledger-') && f.endsWith('.jsonl'))) return null;
  } catch {
    /* no archive yet */
  }
  fs.mkdirSync(dir, { recursive: true });
  const file = emArchivePath(ctx.loomHome, ctx.now);
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  let n = 0;
  try {
    for (const table of ['em_findings', 'em_actions']) {
      if (!tableExists(db, table)) continue;
      let buf = '';
      for (const row of db.prepare(`SELECT * FROM ${table} ORDER BY id`).iterate() as Iterable<Record<string, unknown>>) {
        buf += JSON.stringify({ table, ...row }) + '\n';
        n++;
        if (buf.length > 1 << 20) {
          fs.writeSync(fd, buf);
          buf = '';
        }
      }
      if (buf) fs.writeSync(fd, buf);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  ctx.log(`watchers: EM ledger (${n} rows) exported to ${file}; em_findings/em_actions are left unread`);
  return file;
}

export const step: MigrationStep = {
  id: 'watchers',
  late: true,
  run(ctx) {
    convertWatchers(ctx);
    convertSpawns(ctx);
    convertEm(ctx);
  },
  afterCommit(ctx) {
    exportEmLedger(ctx);
  },
};
