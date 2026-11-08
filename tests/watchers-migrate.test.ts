import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { resetLateFailures, runMigration, type MigrationContext, type MigrationStep } from '../src/migrate.ts';
import { STEPS } from '../src/migrations/index.ts';
import { EM_WATCHERS, emArchivePath, step as watchersStep } from '../src/migrations/watchers.ts';
import { getWatcher, listWatchers } from '../src/watchers/model.ts';
import { newEngineState, tickWatchers, type EngineDeps } from '../src/watchers/engine.ts';
import { launchCommand } from '../src/watchers/actions.ts';
import { LEGACY_LAUNCH_SETTINGS } from '../src/launch.ts';
import { memoryBackend, setKeychainBackend } from '../src/secrets.ts';
import type { LanePane } from '../src/compact.ts';

// The watchers + EM part of the migration (§9.5), on a fixture shaped like a
// long-lived install: two enabled Slack watchers with brief files, a spawn
// history on one lane (spawned, queued, dry run), em_mode=shadow and an EM
// ledger. Run both ways an install can reach it: in the first (legacy)
// migration, and as a step added after an install was already at schema 2.

const NOW = 1_800_000_000_000;
const TICKETS_BRIEF = 'New ticket: {{TITLE}}\nThread: {{URL}}\n\nDo NOT react to the thread.\n';
const PRS_BRIEF = 'New pull request posted: {{TITLE}}\nSlack message: {{URL}}\n\nLoad the acme-review skill.\n';

let root: string;
const dbs: Database.Database[] = [];
const logs: string[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wmig-'));
  setKeychainBackend(memoryBackend());
  logs.length = 0;
});
afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
  setKeychainBackend(null);
  fs.rmSync(root, { recursive: true, force: true });
});

function ctxFor(): Partial<MigrationContext> {
  const home = path.join(root, 'home');
  return {
    home,
    loomHome: path.join(root, 'loom'),
    claudeHome: path.join(home, '.claude'),
    claudeJsonPath: path.join(home, '.claude.json'),
    codexHooksPath: path.join(home, '.codex', 'hooks.json'),
    slackTokenPath: path.join(home, '.claude', 'tools', 'slack', 'token.json'),
    legacyStateDir: path.join(home, '.claude', 'state'),
    env: {},
    now: NOW,
    log: (l) => void logs.push(l),
  };
}

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

const SPAWNS = 89;

/** A pre-v2 install's DB (watchers as the previous build stored them). Returns its path. */
function legacyInstall(opts: { emMode?: string | null; schema2?: boolean } = {}): string {
  const c = ctxFor();
  const dbPath = path.join(c.loomHome!, 'manager.db');
  const db = openDb(dbPath, { migrate: false });
  // The previous build created these; this build no longer does.
  db.exec(`CREATE TABLE IF NOT EXISTS em_findings (id INTEGER PRIMARY KEY AUTOINCREMENT, agent TEXT NOT NULL, session_id TEXT NOT NULL, kind TEXT NOT NULL, signals_json TEXT NOT NULL, detected_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'new');
           CREATE TABLE IF NOT EXISTS em_actions (id INTEGER PRIMARY KEY AUTOINCREMENT, finding_id INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, taken_at INTEGER NOT NULL, shadow INTEGER NOT NULL DEFAULT 1, result TEXT NOT NULL DEFAULT '');`);
  const put = db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  put.run('launch_target', 'managed');
  if (opts.emMode !== null) put.run('em_mode', opts.emMode ?? 'shadow');
  if (opts.schema2) {
    // What the first migration (without this step) left: explicit rows + the marker.
    for (const [k, v] of [['settings_schema', '2'], ['setup_origin', 'migrated'], ['watcher_default_target', 'lane:xy'], ['watchers_enabled', 'on'], ['perm_watchers', 'skip'], ['rc_watchers', 'on'], ['watcher_brief_prune_days', '0']]) put.run(k, v);
  }
  db.prepare(
    `INSERT INTO chats (session_id, project_dir, jsonl_path, started_at, ended_at, last_active_at, message_count, jsonl_mtime, last_indexed_at)
     VALUES ('s1', '/Users/someone/dev/app', '/x.jsonl', 1, 2, 2, 5, 2, 2)`,
  ).run();
  const briefs = path.join(c.loomHome!, 'watchers');
  write(path.join(briefs, 'tickets.brief.md'), TICKETS_BRIEF);
  write(path.join(briefs, 'prs.brief.md'), PRS_BRIEF);
  // The old table shape: legacy columns only, no defaults on the NOT NULL ones.
  db.exec(`DROP TABLE watchers; CREATE TABLE watchers (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, channel TEXT NOT NULL, rule_kind TEXT NOT NULL, rule_params TEXT NOT NULL DEFAULT '{}',
    brief_path TEXT NOT NULL, project_dir TEXT NOT NULL, workspace TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 0,
    baselined INTEGER NOT NULL DEFAULT 0, watermark TEXT NOT NULL DEFAULT '', last_poll_at INTEGER NOT NULL DEFAULT 0, last_ok_at INTEGER NOT NULL DEFAULT 0,
    last_error TEXT NOT NULL DEFAULT '', error_count INTEGER NOT NULL DEFAULT 0, next_poll_at INTEGER NOT NULL DEFAULT 0)`);
  const w = db.prepare(`INSERT INTO watchers (id, label, channel, rule_kind, rule_params, brief_path, project_dir, workspace, enabled, baselined, watermark, last_poll_at, last_ok_at, next_poll_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'acme', 1, 1, ?, 5, 5, 6)`);
  w.run('tickets', 'Tickets', 'C0AAAAAAAAA', 'bot-post-contains', JSON.stringify({ bot_ids: ['BBOT'], user_ids: ['UBOT'], needle: 'New engineering ticket' }), path.join(briefs, 'tickets.brief.md'), '/Users/someone/dev/app', '1700000000.000100');
  w.run('prs', 'PRs', 'C0BBBBBBBBB', 'pr-link-post', JSON.stringify({ repos: ['acme/app'], exclude_user_ids: ['UOWNER'] }), path.join(briefs, 'prs.brief.md'), '/Users/someone/dev/app', '1700000000.000200');
  db.prepare(`INSERT INTO watcher_seen (watcher_id, ts, seen_at, baseline) VALUES ('prs', '1700000000.000200', 1, 1)`).run();
  const s = db.prepare(`INSERT INTO watcher_spawns (watcher_id, ts, title, permalink, status, pane_id, pane_name, pane_where, brief_path, queued_at, spawned_at, detail) VALUES (?, ?, ?, 'https://acme.slack.com/x', ?, ?, 'cozy', ?, '/b.md', ?, ?, '')`);
  for (let i = 0; i < SPAWNS; i++) s.run(i % 2 ? 'prs' : 'tickets', `1700000${String(i).padStart(3, '0')}.000000`, `#${i}`, 'spawned', `%${i}`, `loom-xy-${(i % 3) + 1}:1.2`, 1000 + i, 2000 + i);
  s.run('prs', '1700001000.000000', '#q', 'queued', '', '', 5000, 0);
  s.run('tickets', '1700001001.000000', '#d', 'dry_run', '%9', 'loom-xy-1:1.0', 5001, 5002);
  const f = db.prepare(`INSERT INTO em_findings (agent, session_id, kind, signals_json, detected_at, status) VALUES ('claude', ?, 'BLOCKED', '{}', ?, 'new')`);
  for (let i = 0; i < 40; i++) f.run('s' + i, i);
  const a = db.prepare(`INSERT INTO em_actions (finding_id, kind, payload, taken_at, shadow, result) VALUES (?, 'answer', 'p', ?, 1, 'shadow')`);
  for (let i = 0; i < 25; i++) a.run(i + 1, i);
  db.close();
  return dbPath;
}

const open = (p: string) => {
  const db = openDb(p, { migrate: false });
  dbs.push(db);
  return db;
};

function assertConverted(db: Database.Database, lane: string) {
  const ws = listWatchers(db);
  const slack = ws.filter((w) => w.source.kind === 'slack');
  expect(slack.map((w) => [w.id, w.enabled, w.run_mode, w.trigger.kind, w.action.kind, w.action.params.target, w.action.params.perm, w.max_per_hour, w.cooldown_min])).toEqual([
    ['prs', true, 'live', 'pr-link-post', 'start_chat', lane, 'inherit', 0, 0],
    ['tickets', true, 'live', 'bot-post-contains', 'start_chat', lane, 'inherit', 0, 0],
  ]);
  const t = getWatcher(db, 'tickets')!;
  expect(t.source.params).toEqual({ channel: 'C0AAAAAAAAA', workspace: 'acme' });
  expect(t.trigger.params).toEqual({ bot_ids: ['BBOT'], user_ids: ['UBOT'], needle: 'New engineering ticket' });
  expect(t.action.params).toEqual({ project_dir: '/Users/someone/dev/app', target: lane, brief_template: TICKETS_BRIEF, perm: 'inherit' });
  expect(getWatcher(db, 'prs')!.action.params.brief_template).toBe(PRS_BRIEF);
  expect(getWatcher(db, 'prs')!.trigger.params).toEqual({ repos: ['acme/app'], exclude_user_ids: ['UOWNER'] });
  // Poll state and the dedupe set are kept: no re-baseline, nothing replayed.
  expect(t.poll).toMatchObject({ baselined: true, watermark: '1700000000.000100', last_ok_at: 5, next_poll_at: 6 });
  expect(db.prepare(`SELECT COUNT(*) n FROM watcher_seen`).get()).toEqual({ n: 1 });
  // Legacy columns stay for one release (the previous build still reads them).
  expect(db.prepare(`SELECT channel, rule_kind, brief_path FROM watchers WHERE id = 'tickets'`).get()).toMatchObject({ channel: 'C0AAAAAAAAA', rule_kind: 'bot-post-contains' });
  // Spawns -> events.
  const ev = db.prepare(`SELECT mode, decision, result, COUNT(*) n FROM watcher_events GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`).all();
  expect(ev).toEqual([
    { mode: 'live', decision: 'fired', result: 'queued', n: 1 },
    { mode: 'live', decision: 'fired', result: 'started', n: SPAWNS },
    { mode: 'shadow', decision: 'would_fire', result: '', n: 1 },
  ]);
  expect(db.prepare(`SELECT reviewed_at FROM watcher_events WHERE mode = 'shadow'`).get()).toEqual({ reviewed_at: NOW });
  expect(db.prepare(`SELECT event_key, subject, pane_where, acted_at FROM watcher_events WHERE event_key = '1700000001.000000'`).get()).toEqual({ event_key: '1700000001.000000', subject: 'slack:C0BBBBBBBBB/1700000001.000000', pane_where: 'loom-xy-2:1.2', acted_at: 2001 });
}

describe('watchers migration, inside the first (legacy) migration', () => {
  it('converts the Slack watchers Live on their lane with the same briefs, the spawns, and em_mode=shadow to 3 Shadow chat watchers', () => {
    const p = legacyInstall();
    const db = openDb(p, { migrate: false });
    const r = runMigration(db, { dbPath: p, context: ctxFor() });
    db.close();
    expect(r.outcome).toBe('migrated');
    expect(r.steps).toContain('watchers');
    const d = open(p);
    // The settings step derived lane:xy from the spawn history first.
    assertConverted(d, 'lane:xy');
    const em = EM_WATCHERS.map((w) => getWatcher(d, w.id)!);
    expect(em.map((w) => [w.label, w.enabled, w.run_mode, w.source.kind, w.trigger.kind, w.action.kind, w.cooldown_min])).toEqual([
      ['Waiting on you', true, 'shadow', 'chats', 'waiting_on_user', 'tell_orch', 60],
      ['Finished, ready to wrap up', true, 'shadow', 'chats', 'done_idle', 'notify', 60],
      ['Context nearly full', true, 'shadow', 'chats', 'context_over', 'message_chat', 60],
    ]);
    expect(em.map((w) => w.trigger.params)).toEqual([{ min_sec: 90, max_h: 24 }, { min: 10 }, { fraction: 0.7 }]);
    expect(d.prepare(`SELECT 1 FROM settings WHERE key = 'em_mode'`).get()).toBeUndefined();
    // EM ledger: exported, not converted; the tables stay.
    const file = emArchivePath(ctxFor().loomHome!, NOW);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.filter((l) => l.table === 'em_findings')).toHaveLength(40);
    expect(lines.filter((l) => l.table === 'em_actions')).toHaveLength(25);
    expect(d.prepare(`SELECT COUNT(*) n FROM em_findings`).get()).toEqual({ n: 40 });
    expect(d.prepare(`SELECT COUNT(*) n FROM watcher_events WHERE mode = 'shadow' AND reviewed_at = 0`).get()).toEqual({ n: 0 });
  });
  it('em_mode=off creates no chat watchers; live creates them Live; unset reads as the EM read it (shadow)', () => {
    for (const [mode, want] of [['off', []], ['live', ['live', 'live', 'live']], [undefined, ['shadow', 'shadow', 'shadow']], ['garbage', []]] as const) {
      fs.rmSync(root, { recursive: true, force: true });
      const p = legacyInstall({ emMode: mode === undefined ? null : mode });
      const db = openDb(p, { migrate: false });
      expect(runMigration(db, { dbPath: p, context: ctxFor() }).outcome).toBe('migrated');
      expect(EM_WATCHERS.map((w) => getWatcher(db, w.id)?.run_mode).filter(Boolean)).toEqual(want);
      db.close();
    }
  });
});

describe('watchers migration, added after the install was already at schema 2 (the owner’s case)', () => {
  // The first migration ran without this step: everything else is done and the
  // marker says schema 2. The step must still run, exactly once.
  const firstMigration = STEPS.filter((s) => s.id !== 'watchers');

  it('runs once on a current DB, with a backup, and never again', () => {
    const p = legacyInstall({ schema2: true });
    const db = openDb(p, { migrate: false });
    const r = runMigration(db, { dbPath: p, context: ctxFor() });
    expect(r.outcome).toBe('migrated');
    expect(r.steps).toEqual(['watchers']);
    expect(r.backup && fs.existsSync(r.backup)).toBe(true);
    assertConverted(db, 'lane:xy');
    expect(EM_WATCHERS.map((w) => getWatcher(db, w.id)!.run_mode)).toEqual(['shadow', 'shadow', 'shadow']);
    expect(fs.existsSync(emArchivePath(ctxFor().loomHome!, NOW))).toBe(true);
    const snapshot = () => ({
      w: db.prepare(`SELECT * FROM watchers ORDER BY id`).all(),
      e: db.prepare(`SELECT * FROM watcher_events ORDER BY id`).all(),
      s: db.prepare(`SELECT * FROM settings ORDER BY key`).all(),
    });
    const before = snapshot();
    const again = runMigration(db, { dbPath: p, context: { ...ctxFor(), now: NOW + 1 } });
    expect(again).toMatchObject({ outcome: 'current', steps: [] });
    expect(snapshot()).toEqual(before);
    db.close();
    // openDb (the every-open path) also leaves it alone.
    const d2 = openDb(p);
    dbs.push(d2);
    expect(d2.prepare(`SELECT * FROM watchers ORDER BY id`).all()).toEqual(before.w);
  });

  it('the step itself is idempotent: run twice in a row, the second changes nothing', () => {
    const p = legacyInstall({ schema2: true });
    const db = open(p);
    const ctx = { ...(ctxFor() as MigrationContext), db };
    db.transaction(() => watchersStep.run(ctx))();
    const before = { w: db.prepare(`SELECT * FROM watchers ORDER BY id`).all(), e: db.prepare(`SELECT COUNT(*) n FROM watcher_events`).get() };
    db.transaction(() => watchersStep.run({ ...ctx, now: NOW + 5 }))();
    expect({ w: db.prepare(`SELECT * FROM watchers ORDER BY id`).all(), e: db.prepare(`SELECT COUNT(*) n FROM watcher_events`).get() }).toEqual(before);
  });

  it('a throw rolls the step back, leaves the DB as it was, and the next open retries', () => {
    const p = legacyInstall({ schema2: true });
    const db = open(p);
    const before = db.prepare(`SELECT * FROM watchers ORDER BY id`).all();
    const boom: MigrationStep = { id: 'watchers', late: true, run(ctx) { watchersStep.run(ctx); throw new Error('boom'); } };
    const r = runMigration(db, { dbPath: p, context: ctxFor(), steps: [...firstMigration, boom] });
    expect(r.outcome).toBe('failed');
    expect(db.prepare(`SELECT * FROM watchers ORDER BY id`).all()).toEqual(before);
    expect(db.prepare(`SELECT COUNT(*) n FROM watcher_events`).get()).toEqual({ n: 0 });
    expect(fs.readdirSync(path.dirname(p)).filter((f) => f.includes('.pre-'))).toEqual([]);
    // Not retried on every open in this process; after the retry window (or a restart) it is.
    expect(runMigration(db, { dbPath: p, context: ctxFor() }).steps).toEqual([]);
    resetLateFailures();
    expect(runMigration(db, { dbPath: p, context: ctxFor() }).steps).toEqual(['watchers']);
  });

  it('the migrated Slack watcher fires exactly as the previous build did: same lane, same brief text, same launch line', async () => {
    const p = legacyInstall({ schema2: true });
    const db = open(p);
    runMigration(db, { dbPath: p, context: ctxFor() });
    const briefs = path.join(root, 'briefs');
    const launches: [string, string][] = [];
    const pane = (id: string, s: string): LanePane => ({ pane_id: id, tmux_session: s, window_index: '1', pane_index: '0', command: 'zsh', name: 'cozy-' + id.slice(1), group: '', agent: false });
    const deps: EngineDeps = {
      now: () => NOW,
      history: async () => [{ ts: '1700000500.000500', bot_id: 'BBOT', text: 'New engineering ticket: <https://x/t/5|#5 Export broken>' }],
      slackOn: () => true,
      slackSelf: () => '',
      threadOwner: () => null,
      chats: () => [],
      prs: () => [],
      world: () => ({ panes: [pane('%31', 'loom-other-1'), pane('%30', 'loom-xy-2'), pane('%33', 'loom-xy-3')], focused: null }),
      launch: async (pid, c) => void launches.push([pid, c]),
      acquireManaged: () => ({ ok: false, detail: 'must not be used' }),
      launchSettings: () => LEGACY_LAUNCH_SETTINGS,
      relay: () => ({ status: 'failed', detail: '' }),
      notify: () => false,
      tellOrch: () => false,
      dryRun: false,
      briefsDir: briefs,
    };
    // One pass: the spawn that was still queued before the migration (prs) drains into the
    // first free pane of the lane, and the new ticket post starts in the next one.
    await tickWatchers(db, deps, newEngineState());
    expect(db.prepare(`SELECT result, pane_id FROM watcher_events WHERE watcher_id = 'prs' AND event_key = '1700001000.000000'`).get()).toEqual({ result: 'started', pane_id: '%30' });
    const t = db.prepare(`SELECT result, pane_id, pane_where, brief_path FROM watcher_events WHERE watcher_id = 'tickets' AND event_key = '1700000500.000500'`).get() as Record<string, string>;
    expect(t).toMatchObject({ result: 'started', pane_id: '%33', pane_where: 'loom-xy-3:1.0' });
    expect(t.brief_path).toBe(path.join(briefs, 'tickets-1700000500-000500.md'));
    expect(fs.readFileSync(t.brief_path, 'utf-8')).toBe('New ticket: #5 Export broken\nThread: https://acme.slack.com/archives/C0AAAAAAAAA/p1700000500000500\n\nDo NOT react to the thread.\n');
    expect(launches).toEqual([
      ['%30', launchCommand('/Users/someone/dev/app', path.join(briefs, 'prs-1700001000-000000.md'), 'cozy-30', LEGACY_LAUNCH_SETTINGS)],
      ['%33', launchCommand('/Users/someone/dev/app', t.brief_path, 'cozy-33', LEGACY_LAUNCH_SETTINGS)],
    ]);
    expect(launches[1][1]).toBe(`cd '/Users/someone/dev/app' && claude --dangerously-skip-permissions --remote-control 'cozy-33' "$(cat '${t.brief_path}')"`);
    // A pane from another lane is never used.
    expect(launches.some((l) => l[0] === '%31')).toBe(false);
  });
});

describe('watchers migration on a fresh install', () => {
  it('a fresh DB gets no watchers, and the step is recorded so it never runs later', () => {
    const p = path.join(root, 'fresh', 'manager.db');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const db = openDb(p, { migrate: false });
    dbs.push(db);
    expect(runMigration(db, { dbPath: p, context: ctxFor() }).outcome).toBe('fresh');
    expect(listWatchers(db)).toEqual([]);
    expect(runMigration(db, { dbPath: p, context: ctxFor() })).toMatchObject({ outcome: 'current', steps: [] });
    expect(listWatchers(db)).toEqual([]);
  });
});
