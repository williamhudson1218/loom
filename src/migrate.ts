import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

// The one-time move of an existing install onto the settings registry
// (settings_schema 2). It runs from openDb, after applySchema.
//
//   current  settings_schema >= 2: nothing to do (the cheap, every-open case)
//   fresh    a brand-new DB (no schema row, no chats, no settings beyond the
//            default_agent row applySchema seeds): write settings_schema=2 and
//            nothing else, so the setup wizard runs
//   legacy   anything else: back the DB up with VACUUM INTO, then run every
//            MigrationStep and the setup marker in ONE immediate transaction.
//            Any throw rolls the whole thing back, the install keeps running on
//            its legacy defaults, and the next open tries again
//
// Each step writes an install's EFFECTIVE values out as explicit rows, so the
// registry's defaults can change afterwards without moving it. Steps must be
// idempotent: running one twice changes nothing the second time.
//
// A step added after installs were already migrated is marked `late`. It runs
// in the legacy migration like any other, and ALSO once on a `current` DB that
// has not had it: same backup, same one-transaction rollback, and its id is
// then recorded in the `migration_steps_done` row so it never runs again. A
// fresh DB records every late step as done (it has nothing to convert). The
// every-open check stays one read: the schema row and that row in one statement.

/** What every step gets. Paths are injectable so tests never touch the real home. */
export interface MigrationContext {
  db: Database.Database;
  /** The user's home folder (~). */
  home: string;
  /** Loom's data folder ($LOOM_HOME, ~/.loom). */
  loomHome: string;
  /** ~/.claude */
  claudeHome: string;
  /** ~/.claude.json, where Claude Code records folder trust. */
  claudeJsonPath: string;
  /** ~/.codex/hooks.json */
  codexHooksPath: string;
  /** The pre-Loom Slack CLI token file (~/.claude/tools/slack/token.json). */
  slackTokenPath: string;
  /** The legacy state folder (~/.claude/state) the toolbox hooks write. */
  legacyStateDir: string;
  /** The environment (for $LOOM_SHIP_REPOS and friends). Steps read it, never process.env. */
  env: NodeJS.ProcessEnv;
  /** Migration time, epoch ms. Every step stamps this, not Date.now(). */
  now: number;
  /** One line per change, for the log. Never pass a secret. */
  log: (line: string) => void;
}

/**
 * One part of the legacy migration (settings, ship, watchers, state). Lives in
 * src/migrations/<id>.ts and is exported as `step`.
 */
export interface MigrationStep {
  id: string;
  /**
   * Runs inside the migration transaction, on a DB whose settings_schema is
   * still < 2 (so getSetting returns legacy effective values). Synchronous
   * (better-sqlite3). Write rows directly, not through setSetting: change events
   * must not fire for a transaction that may still roll back. Throw to roll the
   * whole migration back. Must be idempotent.
   */
  run(ctx: MigrationContext): void;
  /**
   * Optional work outside the DB (Keychain, files), run once the transaction
   * has committed. Best effort: a throw is logged and does not undo the
   * migration, so anything here must be safe to skip and to repeat.
   */
  afterCommit?(ctx: MigrationContext): void;
  /**
   * Added after the first migration shipped: also run once on a DB that is
   * already at settings_schema 2 (then getSetting returns the stored values,
   * so read rows directly where it matters). Must be safe on both.
   */
  late?: boolean;
}

/** The settings row listing the late steps an install has had (JSON array of ids). */
export const LATE_STEPS_KEY = 'migration_steps_done';

export type Detection = 'current' | 'fresh' | 'legacy';

export interface MigrateResult {
  outcome: 'current' | 'fresh' | 'migrated' | 'failed';
  /** The backup made before a legacy migration (kept on success, removed on failure). */
  backup?: string;
  error?: string;
  /** Step ids that ran, in order. */
  steps: string[];
}

export interface MigrateOpts {
  /** The DB file, for the backup. ':memory:' or unset = no backup. */
  dbPath?: string;
  /** Defaults to every step in src/migrations/index.ts. */
  steps?: MigrationStep[];
  /** Override any context path (tests). */
  context?: Partial<Omit<MigrationContext, 'db'>>;
}

const readRow = (db: Database.Database, key: string): string | undefined =>
  (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;

const putRow = (db: Database.Database, key: string, value: string): void => {
  db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
};

export function storedSchema(db: Database.Database): number {
  const n = Number(readRow(db, 'settings_schema')?.trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

const isCurrentSchema = (v: string | undefined): boolean => {
  if (v === undefined) return false;
  const n = Number(v.trim());
  return Number.isInteger(n) && n >= 2;
};

/** The schema row and the late-step list, in one statement. */
function readMarkers(db: Database.Database): { schema: string | undefined; done: string[] } {
  const rows = db.prepare(`SELECT key, value FROM settings WHERE key IN (?, ?)`).all('settings_schema', LATE_STEPS_KEY) as { key: string; value: string }[];
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  let done: string[] = [];
  try {
    const v: unknown = JSON.parse(get(LATE_STEPS_KEY) ?? '[]');
    if (Array.isArray(v)) done = v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* unreadable: treat as none done (late steps are idempotent) */
  }
  return { schema: get('settings_schema'), done };
}

function recordLateDone(db: Database.Database, ids: string[]): void {
  if (!ids.length) return;
  const { done } = readMarkers(db);
  const next = [...new Set([...done, ...ids])];
  if (next.length !== done.length) putRow(db, LATE_STEPS_KEY, JSON.stringify(next));
}

export function detect(db: Database.Database): Detection {
  // The every-open case: one indexed read.
  const schema = readRow(db, 'settings_schema');
  if (schema !== undefined) {
    const n = Number(schema.trim());
    return Number.isInteger(n) && n >= 2 ? 'current' : 'legacy';
  }
  // No schema row: fresh only if nothing has ever been stored. applySchema seeds
  // default_agent=claude on every DB, so that one row alone is not a sign of use;
  // a row in any other table (chats, watchers, projects, tags...) is.
  const rows = db.prepare(`SELECT key, value FROM settings LIMIT 2`).all() as { key: string; value: string }[];
  if (rows.some((r) => !(r.key === 'default_agent' && r.value === 'claude'))) return 'legacy';
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'settings'`).all() as { name: string }[];
  for (const { name } of tables) {
    if (db.prepare(`SELECT 1 FROM "${name.replace(/"/g, '""')}" LIMIT 1`).get()) return 'legacy';
  }
  return 'fresh';
}

export function defaultContext(db: Database.Database, loomHome: string, env: NodeJS.ProcessEnv = process.env): MigrationContext {
  const home = os.homedir();
  const claudeHome = path.join(home, '.claude');
  return {
    db,
    home,
    loomHome,
    claudeHome,
    claudeJsonPath: path.join(home, '.claude.json'),
    codexHooksPath: path.join(home, '.codex', 'hooks.json'),
    slackTokenPath: path.join(claudeHome, 'tools', 'slack', 'token.json'),
    legacyStateDir: path.join(claudeHome, 'state'),
    env,
    now: Date.now(),
    log: (line) => console.log('[loom migrate] ' + line),
  };
}

/** The backup file for a DB at `dbPath`: `<db>.pre-v2-<ts>`. */
export function backupPath(dbPath: string, now: number): string {
  return `${dbPath}.pre-v2-${now}`;
}

function errText(e: unknown): string {
  const s = e instanceof Error ? e.message : String(e);
  // No step puts a secret in an error, but mask anything token-shaped regardless.
  return s.replace(/xox[abposr]-[A-Za-z0-9-]+/g, 'xox?-…').replace(/Bearer\s+\S+/g, 'Bearer …');
}

/**
 * The "setup done" marker (§6.3): the page shows the wizard iff this is false.
 * Done = setup_completed_at is set, or the install was migrated (it never sees
 * the wizard unless the user picks Run setup again).
 */
export function setupDone(db: Database.Database): boolean {
  const at = Number(readRow(db, 'setup_completed_at') ?? 0);
  return (Number.isFinite(at) && at > 0) || readRow(db, 'setup_origin') === 'migrated';
}

/** The setup marker (§6.3) for a migrated install. Leaves an existing marker alone. */
export function writeMigratedMarker(db: Database.Database, now: number): void {
  const done = Number(readRow(db, 'setup_completed_at') ?? 0);
  if (!(Number.isFinite(done) && done > 0)) putRow(db, 'setup_completed_at', String(now));
  if (!readRow(db, 'setup_origin')) putRow(db, 'setup_origin', 'migrated');
  putRow(db, 'settings_schema', '2');
}

/**
 * Detect and, when needed, migrate. Never throws: a failure is rolled back,
 * logged, and reported as `failed`, and the install keeps its legacy defaults.
 */
export function runMigration(db: Database.Database, opts: MigrateOpts = {}): MigrateResult {
  let kind: Detection;
  let lateDone: string[] = [];
  try {
    // The every-open case is this one statement.
    const m = readMarkers(db);
    if (isCurrentSchema(m.schema)) {
      kind = 'current';
      lateDone = m.done;
    } else {
      kind = detect(db);
    }
  } catch (e) {
    return { outcome: 'failed', error: errText(e), steps: [] };
  }
  const allSteps = () => opts.steps ?? registered ?? [];
  if (kind === 'current') {
    const pending = allSteps().filter((s) => s.late && !lateDone.includes(s.id));
    if (!pending.length) return { outcome: 'current', steps: [] };
    // A late step that failed is not retried on every open in this process (each try
    // is a full VACUUM INTO backup): the board is served without it, and it is tried
    // again after LATE_RETRY_MS or on the next start.
    const failedAt = lateFailures.get(opts.dbPath ?? '');
    if (failedAt !== undefined && Date.now() - failedAt < LATE_RETRY_MS) return { outcome: 'current', steps: [] };
    return runLateSteps(db, opts);
  }

  const loomHome = opts.context?.loomHome ?? (opts.dbPath && opts.dbPath !== ':memory:' ? path.dirname(opts.dbPath) : os.tmpdir());
  const ctx: MigrationContext = { ...defaultContext(db, loomHome), ...opts.context, db };

  if (kind === 'fresh') {
    try {
      db.transaction(() => {
        if (detect(db) !== 'fresh') return;
        putRow(db, 'settings_schema', '2');
        // Nothing to convert on a new install: its late steps count as done.
        recordLateDone(db, allSteps().filter((s) => s.late).map((s) => s.id));
      }).immediate();
      return { outcome: 'fresh', steps: [] };
    } catch (e) {
      return { outcome: 'failed', error: errText(e), steps: [] };
    }
  }

  // Legacy. Back up first; no backup, no migration.
  let backup: string | undefined;
  const file = opts.dbPath && opts.dbPath !== ':memory:' ? opts.dbPath : undefined;
  if (file) {
    backup = backupPath(file, ctx.now);
    try {
      db.prepare(`VACUUM INTO ?`).run(backup);
    } catch (e) {
      try {
        fs.rmSync(backup, { force: true });
      } catch {
        /* nothing there */
      }
      const error = 'backup failed, not migrating: ' + errText(e);
      ctx.log(error);
      return { outcome: 'failed', error, steps: [] };
    }
  }

  const steps = opts.steps ?? loadSteps();
  const ran: string[] = [];
  try {
    db.transaction(() => {
      // Another process may have migrated between detect() and the write lock.
      if (detect(db) !== 'legacy') return;
      for (const s of steps) {
        s.run(ctx);
        ran.push(s.id);
      }
      recordLateDone(db, steps.filter((s) => s.late).map((s) => s.id));
      writeMigratedMarker(db, ctx.now);
    }).immediate();
  } catch (e) {
    const error = `rolled back${ran.length < steps.length ? ` at step ${steps[ran.length].id}` : ''}: ${errText(e)}`;
    ctx.log(error);
    // The DB is exactly as it was, so the backup is a duplicate; the next open makes a new one.
    if (backup) {
      try {
        fs.rmSync(backup, { force: true });
      } catch {
        /* leave it */
      }
    }
    return { outcome: 'failed', error, steps: [] };
  }

  if (!ran.length) {
    // Someone else migrated first; our backup is redundant.
    if (backup) fs.rmSync(backup, { force: true });
    return { outcome: 'current', steps: [] };
  }

  for (const s of steps) {
    if (!s.afterCommit) continue;
    try {
      s.afterCommit(ctx);
    } catch (e) {
      ctx.log(`${s.id}: after-commit work failed (the migration stands): ${errText(e)}`);
    }
  }
  ctx.log(`migrated to settings_schema 2 (${ran.join(', ')})${backup ? `; backup at ${backup}` : ''}`);
  return { outcome: 'migrated', backup, steps: ran };
}

/** How long a process waits before trying a failed late step again. */
export const LATE_RETRY_MS = 10 * 60_000;
const lateFailures = new Map<string, number>();
/** Tests: forget the failed late steps, so the next open retries at once. */
export function resetLateFailures(): void {
  lateFailures.clear();
}

/**
 * A `current` DB that has not had every late step: back it up, then run the
 * missing ones in one immediate transaction and record them. A throw rolls back
 * (the backup is then removed as redundant) and the next open tries again.
 */
function runLateSteps(db: Database.Database, opts: MigrateOpts): MigrateResult {
  const loomHome = opts.context?.loomHome ?? (opts.dbPath && opts.dbPath !== ':memory:' ? path.dirname(opts.dbPath) : os.tmpdir());
  const ctx: MigrationContext = { ...defaultContext(db, loomHome), ...opts.context, db };
  const all = (opts.steps ?? registered ?? []).filter((s) => s.late);
  let backup: string | undefined;
  const file = opts.dbPath && opts.dbPath !== ':memory:' ? opts.dbPath : undefined;
  if (file) {
    backup = `${file}.pre-${all.map((s) => s.id).join('-')}-${ctx.now}`;
    try {
      db.prepare(`VACUUM INTO ?`).run(backup);
    } catch (e) {
      try {
        fs.rmSync(backup, { force: true });
      } catch {
        /* nothing there */
      }
      const error = 'backup failed, not running late steps: ' + errText(e);
      ctx.log(error);
      return { outcome: 'failed', error, steps: [] };
    }
  }
  const ran: MigrationStep[] = [];
  let failedAt = '';
  try {
    db.transaction(() => {
      // Another process may have run them between the check and the write lock.
      const { schema, done } = readMarkers(db);
      if (!isCurrentSchema(schema)) return;
      for (const s of all) {
        if (done.includes(s.id)) continue;
        failedAt = s.id;
        s.run(ctx);
        ran.push(s);
      }
      recordLateDone(db, ran.map((s) => s.id));
    }).immediate();
  } catch (e) {
    const error = `rolled back at late step ${failedAt}: ${errText(e)}; the DB is unchanged, retrying in ${LATE_RETRY_MS / 60_000} min or on the next start`;
    ctx.log(error);
    lateFailures.set(opts.dbPath ?? '', Date.now());
    if (backup) {
      try {
        fs.rmSync(backup, { force: true });
      } catch {
        /* leave it */
      }
    }
    return { outcome: 'failed', error, steps: [] };
  }
  lateFailures.delete(opts.dbPath ?? '');
  if (!ran.length) {
    // Another process ran them first; our backup is redundant.
    if (backup) fs.rmSync(backup, { force: true });
    return { outcome: 'current', steps: [] };
  }
  for (const s of ran) {
    if (!s.afterCommit) continue;
    try {
      s.afterCommit(ctx);
    } catch (e) {
      ctx.log(`${s.id}: after-commit work failed (the step stands): ${errText(e)}`);
    }
  }
  ctx.log(`late step(s) ${ran.map((s) => s.id).join(', ')} applied${backup ? `; backup at ${backup}` : ''}`);
  return { outcome: 'migrated', backup, steps: ran.map((s) => s.id) };
}

// The step list is set by src/migrations/index.ts, which imports this file for
// its types; registering avoids an import cycle at module load.
let registered: MigrationStep[] | null = null;
export function registerSteps(steps: MigrationStep[]): void {
  registered = steps;
}
function loadSteps(): MigrationStep[] {
  if (!registered) throw new Error('no migration steps registered (import src/migrations/index.ts)');
  return registered;
}
