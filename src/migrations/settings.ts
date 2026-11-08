import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { MigrationContext, MigrationStep } from '../migrate.ts';
import { decodeRow, encodeValue, getSetting, settingDef, SETTINGS, type SettingDef, type SettingKey } from '../settingsSchema.ts';
import { DEFAULT_ACCOUNT, KEYCHAIN_SERVICE } from '../slackapi.ts';
import { keychain } from '../secrets.ts';

// Settings, legacy install (§12 steps 1 and 2).
//
// Every registry key that has no stored row gets its EFFECTIVE pre-registry
// value written out, so flipping the defaults to their new-install values later
// cannot move this install. Rows that exist and parse are never touched.
//
// Most effective values are the key's `legacyUnset`. A few are read from the
// install's own data instead, because the code literal they replace is one
// person's (a lane name, a skill name) and does not belong in the registry:
//
//   review_skill / voice_skill   the skills the install's own watcher briefs load
//   watcher_default_target       the lane its watcher workers actually started in
//   find_chat_bin                the old fixed path, only when something is there
//   orchestrator_trust           on only if ~/.claude.json already trusts the folder
//   codex_hook                   on only if ~/.codex/hooks.json already runs the hook
//   slack_mode                   direct when a token is reachable, else off
//
// `slack_watchers` becomes an explicit `watchers_enabled` row and is deleted.
// After commit, a legacy Slack token file is copied into the Keychain (the file stays).

const rowKey = (d: SettingDef) => d.storageKey ?? d.key;

function readRow(db: Database.Database, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return undefined;
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

/** The legacy watcher brief files this install points at (whatever exists of them). */
function legacyBriefs(db: Database.Database): string[] {
  if (!tableExists(db, 'watchers')) return [];
  const cols = (db.prepare(`PRAGMA table_info(watchers)`).all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('brief_path')) return [];
  const out: string[] = [];
  for (const { brief_path } of db.prepare(`SELECT brief_path FROM watchers WHERE brief_path != '' ORDER BY id`).all() as { brief_path: string }[]) {
    try {
      out.push(fs.readFileSync(brief_path, 'utf-8'));
    } catch {
      /* gone: nothing to learn from it */
    }
  }
  return out;
}

const SKILL = '([A-Za-z0-9_.:-]{2,80})';

/** "Load the <skill> skill" in a brief: the review skill its PR worker used. */
export function reviewSkillFromBriefs(briefs: string[]): string | undefined {
  const re = new RegExp(`\\bload the ${SKILL} skill\\b`, 'i');
  for (const b of briefs) {
    const m = re.exec(b);
    if (m && !/^(the|a|an)$/i.test(m[1])) return m[1];
  }
  return undefined;
}

/** "load <skill> first" / "load <skill> + …" in a brief: the writing-voice skill loaded before drafting. */
export function voiceSkillFromBriefs(briefs: string[]): string | undefined {
  const re = new RegExp(`\\bload ${SKILL}(?: \\+| first\\b)`, 'i');
  for (const b of briefs) {
    const m = re.exec(b);
    if (m && !/^(the|a|an)$/i.test(m[1])) return m[1];
  }
  return undefined;
}

/**
 * The lane the install's watcher workers started in: the most common lane among
 * its recorded spawns' panes (`<prefix><lane>-<n>:w.p`). Undefined when there are none.
 */
export function laneFromSpawns(db: Database.Database, prefix: string): string | undefined {
  if (!tableExists(db, 'watcher_spawns')) return undefined;
  const counts = new Map<string, number>();
  for (const { pane_where } of db.prepare(`SELECT pane_where FROM watcher_spawns WHERE pane_where != ''`).all() as { pane_where: string }[]) {
    const session = pane_where.split(':')[0];
    if (!session.startsWith(prefix)) continue;
    const m = /^(.+)-(\d+)$/.exec(session.slice(prefix.length));
    if (!m || !/^[A-Za-z0-9_-]{1,32}$/.test(m[1])) continue;
    counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
  }
  let best: string | undefined;
  let n = 0;
  for (const [lane, c] of counts) if (c > n) [best, n] = [lane, c];
  return best;
}

function trustsFolder(claudeJson: string, dir: string): boolean {
  const data = readJson(claudeJson) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> } | undefined;
  return data?.projects?.[path.resolve(dir)]?.hasTrustDialogAccepted === true;
}

function codexRunsHook(hooksJson: string): boolean {
  try {
    return fs.readFileSync(hooksJson, 'utf-8').includes('record-placement.sh');
  } catch {
    return false;
  }
}

function legacyTokenFile(file: string): string {
  const t = (readJson(file) as { user_token?: unknown } | undefined)?.user_token;
  return typeof t === 'string' ? t.trim() : '';
}

function keychainHasToken(): boolean {
  try {
    return !!keychain().get(KEYCHAIN_SERVICE, DEFAULT_ACCOUNT)?.trim();
  } catch {
    return false;
  }
}

/**
 * The value this install effectively had for `key` before the registry, or
 * undefined to fall back to getSetting (legacyUnset / the legacy row).
 */
function derived(key: SettingKey, ctx: MigrationContext, briefs: () => string[]): unknown {
  switch (key) {
    case 'review_skill':
      return reviewSkillFromBriefs(briefs());
    case 'voice_skill':
      return voiceSkillFromBriefs(briefs());
    case 'watcher_default_target': {
      const lane = laneFromSpawns(ctx.db, getSetting(ctx.db, 'session_prefix', { env: ctx.env }));
      return lane ? `lane:${lane}` : undefined;
    }
    case 'find_chat_bin': {
      const p = getSetting(ctx.db, 'find_chat_bin', { env: false });
      return p && fs.existsSync(p) ? p : '';
    }
    case 'orchestrator_trust':
      return trustsFolder(ctx.claudeJsonPath, path.join(ctx.loomHome, 'orchestrator'));
    case 'codex_hook':
      return codexRunsHook(ctx.codexHooksPath);
    case 'slack_mode':
      return legacyTokenFile(ctx.slackTokenPath) || ctx.env.SLACK_USER_TOKEN?.trim() || keychainHasToken() ? 'direct' : 'off';
    default:
      return undefined;
  }
}

export interface SettingsMigrationReport {
  written: Record<string, unknown>;
  /** Rows that existed but did not parse, replaced by the value they read as. */
  repaired: string[];
  /** Keys left unset because their legacy value is "auto" (no storable value). */
  leftUnset: string[];
}

export function migrateSettings(ctx: MigrationContext): SettingsMigrationReport {
  const { db } = ctx;
  const report: SettingsMigrationReport = { written: {}, repaired: [], leftUnset: [] };
  let briefCache: string[] | null = null;
  const briefs = () => (briefCache ??= legacyBriefs(db));

  // Resolve everything first (against the untouched legacy DB), then write.
  const plan: [SettingDef, unknown][] = [];
  for (const def of SETTINGS) {
    const d = def as SettingDef;
    if (d.internal) continue; // Loom's own bookkeeping: legacy and new defaults agree
    const raw = readRow(db, rowKey(d));
    if (raw !== undefined && decodeRow(d, raw) !== undefined) continue; // set by the user: untouched
    let value = derived(d.key as SettingKey, ctx, briefs);
    if (value === undefined) value = getSetting(db, d.key as SettingKey, { env: false });
    const check = d.validate(value);
    if (!check.ok) {
      // terminal / launch_target: unset on an old install means "auto", which has no
      // stored form. Their readers treat a missing row as auto either way.
      if (raw === undefined) report.leftUnset.push(d.key);
      continue;
    }
    if (raw !== undefined) report.repaired.push(d.key);
    plan.push([d, check.value]);
  }

  const put = db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [d, v] of plan) {
    put.run(rowKey(d), encodeValue(d, v));
    report.written[d.key] = v;
  }
  // watchers_enabled now has its own row (written above from the old one); retire the old name.
  if (readRow(db, rowKey(settingDef('watchers_enabled'))) !== undefined) db.prepare(`DELETE FROM settings WHERE key = 'slack_watchers'`).run();

  const keys = Object.keys(report.written);
  if (keys.length) ctx.log(`settings: wrote ${keys.length} effective values (${keys.join(', ')})`);
  if (report.repaired.length) ctx.log(`settings: replaced unreadable rows with the value they read as: ${report.repaired.join(', ')}`);
  return report;
}

/** §12 step 2: the legacy token file's token goes into the Keychain too. The file is left in place. */
export function copyTokenToKeychain(ctx: MigrationContext): 'copied' | 'already' | 'none' {
  const token = legacyTokenFile(ctx.slackTokenPath);
  if (!/^xox[a-z]-/.test(token)) return 'none';
  const kc = keychain();
  if (kc.get(KEYCHAIN_SERVICE, DEFAULT_ACCOUNT)?.trim() === token) return 'already';
  kc.set(KEYCHAIN_SERVICE, DEFAULT_ACCOUNT, token);
  ctx.log('settings: copied the Slack token file into the Keychain (the file is unchanged)');
  return 'copied';
}

export const step: MigrationStep = {
  id: 'settings',
  run: (ctx) => void migrateSettings(ctx),
  afterCommit: (ctx) => void copyTokenToKeychain(ctx),
};
