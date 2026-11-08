import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import { openDb } from '../src/db.ts';
import { LATE_STEPS_KEY, detect, registerSteps, resetLateFailures, runMigration, setupDone, type MigrationContext, type MigrationStep } from '../src/migrate.ts';
import { STEPS } from '../src/migrations/index.ts';
import { LEGACY_SHIP_REPO } from '../src/migrations/ship.ts';
import { keepOrchPrompt } from '../src/migrations/orchprompt.ts';
import { ORCH_PROMPT, orchPromptText } from '../src/orchsession.ts';
import { copyTokenToKeychain, laneFromSpawns, reviewSkillFromBriefs, voiceSkillFromBriefs } from '../src/migrations/settings.ts';
import { getSetting, SETTINGS, settingDef, type SettingKey } from '../src/settingsSchema.ts';
import { memoryBackend, setKeychainBackend } from '../src/secrets.ts';
import { KEYCHAIN_SERVICE, DEFAULT_ACCOUNT } from '../src/slackapi.ts';

// The migration of an existing install onto settings_schema 2 (design §12).
// The legacy fixture mirrors the shape of a real long-lived install (the rows
// its settings table actually holds, two Slack watchers with brief files, a
// worker-spawn history on one lane, a trusted orchestrator folder, a Codex hook
// and a Slack CLI token file), with neutral names.

const OLD_PROMPT = 'You are the orchestrator. Be brief; the user reads this on a phone.\n';
const TOKEN = 'xoxp-1111-2222-3333-abcdefabcdef';
const LEGACY_ROWS: [string, string][] = [
  ['auto_resume_parked', 'on'],
  ['default_agent', 'claude'],
  ['em_mode', 'shadow'],
  ['last_project_dir', '/Users/someone/dev/app'],
  ['launch_target', 'managed'],
  ['orchestrator_pane_id', '%72'],
  ['orchestrator_session_id', 'f488e043-0000-4000-8000-000000000000'],
  ['slack_goto_hotkey', 'Command+Shift+L'],
  ['terminal', 'inside'],
];

let root: string;
let kc: ReturnType<typeof memoryBackend>;
const dbs: Database.Database[] = [];
const logs: string[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-migrate-'));
  kc = memoryBackend();
  setKeychainBackend(kc);
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
    now: 1_800_000_000_000,
    log: (l) => void logs.push(l),
  };
}

const write = (file: string, body: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
};

/** A legacy install's DB file plus the files around it. Returns the DB path. */
function legacyInstall(): string {
  const c = ctxFor();
  const dbPath = path.join(c.loomHome!, 'manager.db');
  const db = openDb(dbPath, { migrate: false });
  const put = db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
  for (const [k, v] of LEGACY_ROWS) put.run(k, v);
  db.prepare(
    `INSERT INTO chats (session_id, project_dir, jsonl_path, started_at, ended_at, last_active_at, message_count, jsonl_mtime, last_indexed_at)
     VALUES ('s1', '/Users/someone/dev/app', '/x.jsonl', 1, 2, 2, 5, 2, 2)`,
  ).run();
  const briefs = path.join(c.loomHome!, 'watchers');
  write(path.join(briefs, 'tickets.brief.md'), 'Investigate.\n2. **Draft reply**: load jo-voice + writing-slack first; the full text.\n');
  write(path.join(briefs, 'prs.brief.md'), 'Load the acme-review skill and run its full analysis.\n4. Findings (load jo-voice first).\n');
  const w = db.prepare(`INSERT INTO watchers (id, label, channel, rule_kind, brief_path, project_dir, workspace, enabled) VALUES (?, ?, ?, ?, ?, ?, 'ws', 1)`);
  w.run('tickets', 'Tickets', 'C0AAAAAAAAA', 'bot-post-contains', path.join(briefs, 'tickets.brief.md'), '/Users/someone/dev/app');
  w.run('prs', 'PRs', 'C0BBBBBBBBB', 'pr-link-post', path.join(briefs, 'prs.brief.md'), '/Users/someone/dev/app');
  const s = db.prepare(`INSERT INTO watcher_spawns (watcher_id, ts, title, permalink, status, pane_where, queued_at) VALUES ('prs', ?, 't', 'p', 'spawned', ?, 1)`);
  ['loom-xy-5:1.2', 'loom-xy-4:1.2', 'loom-xy-7:1.0', 'loom-other-2:1.0', ''].forEach((where, i) => s.run(String(i), where));
  db.close();
  write(c.claudeJsonPath!, JSON.stringify({ projects: { [path.join(c.loomHome!, 'orchestrator')]: { hasTrustDialogAccepted: true } } }, null, 2));
  write(c.codexHooksPath!, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x/hooks/record-placement.sh' }] }] } }));
  write(c.slackTokenPath!, JSON.stringify({ user_token: TOKEN }));
  write(path.join(c.loomHome!, 'orchestrator', 'prompt.md'), OLD_PROMPT);
  // The one repo a pre-ship_projects install shipped, as a git checkout.
  const repo = path.join(c.home!, LEGACY_SHIP_REPO);
  fs.mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  write(path.join(c.legacyStateDir!, 'ship-labels.json'), JSON.stringify({ sess1: { label: 'a ship label', repo, at: 5 } }));
  return dbPath;
}

const open = (p: string) => {
  const db = openDb(p, { migrate: false });
  dbs.push(db);
  return db;
};
const rows = (db: Database.Database) => db.prepare(`SELECT key, value FROM settings ORDER BY key`).all() as { key: string; value: string }[];
const effective = (db: Database.Database) =>
  Object.fromEntries(SETTINGS.map((d) => [d.key, getSetting(db, d.key as SettingKey, { env: false })])) as Record<string, unknown>;

// What the pre-registry code did for the keys the migration reads from the
// install's own data (the registry's legacyUnset for them is generic now).
const FROM_DATA: Record<string, unknown> = {
  review_skill: 'acme-review', // the PR watcher brief
  voice_skill: 'jo-voice', // the Slack watcher briefs
  watcher_default_target: 'lane:xy', // where its workers started
  slack_mode: 'direct', // a token file is present
  orchestrator_trust: true, // ~/.claude.json already trusts the folder
  codex_hook: true, // ~/.codex/hooks.json already runs the hook
};
const MARKER = new Set(['settings_schema', 'setup_completed_at', 'setup_origin']);

describe('migration: a legacy install', () => {
  it('keeps every effective value, writes them as rows, and marks setup done', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    expect(detect(db)).toBe('legacy');
    const before = { ...effective(db), ...FROM_DATA };
    const rowsBefore = rows(db);

    const r = runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    expect(r.outcome).toBe('migrated');
    expect(r.steps).toEqual(['settings', 'ship', 'orch-prompt', 'watchers', 'state']);

    const after = effective(db);
    for (const key of Object.keys(after)) {
      if (MARKER.has(key)) continue;
      if (key === 'find_chat_bin' && !fs.existsSync(String(before.find_chat_bin))) {
        expect(after[key], key).toBe(''); // nothing at the old fixed path: detect instead
        continue;
      }
      expect(after[key], key).toEqual(before[key]);
    }
    // Every row that existed is byte-identical, except em_mode: the watchers step
    // turns it into chat watchers and deletes it (§9.5, tests/watchers-migrate.test.ts).
    const now = new Map(rows(db).map((x) => [x.key, x.value]));
    for (const { key, value } of rowsBefore) if (key !== 'em_mode') expect(now.get(key), key).toBe(value);
    expect(now.has('em_mode')).toBe(false);
    // Every non-internal key now has a row of its own, so new defaults cannot move it.
    for (const d of SETTINGS) {
      const def = settingDef(d.key as SettingKey);
      if (def.internal) continue;
      expect(now.has(def.storageKey ?? def.key), def.key).toBe(true);
    }
    expect(getSetting(db, 'settings_schema')).toBe(2);
    expect(getSetting(db, 'setup_origin')).toBe('migrated');
    expect(getSetting(db, 'setup_completed_at')).toBe(1_800_000_000_000);
    expect(setupDone(db)).toBe(true);
    expect(getSetting(db, 'tour_completed_at')).toBe(0); // Help offers the tour; it does not auto-start
  });

  it('backs the DB up first with VACUUM INTO and keeps the backup', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    const before = rows(db);
    const r = runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    expect(r.backup).toBe(`${dbPath}.pre-v2-1800000000000`);
    const b = new Database(r.backup!, { readonly: true });
    try {
      expect(b.prepare(`SELECT key, value FROM settings ORDER BY key`).all()).toEqual(before);
      expect((b.prepare(`SELECT COUNT(*) AS n FROM chats`).get() as { n: number }).n).toBe(1);
    } finally {
      b.close();
    }
  });

  it('is idempotent: a second open is a no-op, and re-running the steps changes nothing', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    const once = rows(db);
    expect(runMigration(db, { dbPath, steps: STEPS, context: ctxFor() }).outcome).toBe('current');
    expect(rows(db)).toEqual(once);
    // Force the steps to run again over their own output (as if the marker were lost).
    db.prepare(`UPDATE settings SET value = '1' WHERE key = 'settings_schema'`).run();
    expect(runMigration(db, { dbPath, steps: STEPS, context: { ...ctxFor(), now: 1_900_000_000_000 } }).outcome).toBe('migrated');
    expect(rows(db)).toEqual(once); // the original setup_completed_at is kept too
  });

  it('rolls everything back when a step throws, removes its backup, and retries cleanly next open', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    const before = rows(db);
    const boom: MigrationStep = {
      id: 'boom',
      run: () => {
        throw new Error(`injected failure ${TOKEN}`);
      },
    };
    let afterCommitRan = false;
    const settingsStep: MigrationStep = { ...STEPS[0], afterCommit: () => void (afterCommitRan = true) };
    const r = runMigration(db, { dbPath, steps: [settingsStep, boom], context: ctxFor() });
    expect(r.outcome).toBe('failed');
    expect(r.error).toContain('at step boom');
    expect(r.error).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(rows(db)).toEqual(before); // the settings step's writes are gone too
    expect(detect(db)).toBe('legacy');
    expect(afterCommitRan).toBe(false);
    expect(kc.items.size).toBe(0);
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('pre-v2'))).toEqual([]);

    expect(runMigration(db, { dbPath, steps: STEPS, context: ctxFor() }).outcome).toBe('migrated');
  });

  it('does not migrate without a backup', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    const before = rows(db);
    fs.mkdirSync(`${dbPath}.pre-v2-1800000000000`); // VACUUM INTO cannot write over a directory
    const r = runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    expect(r.outcome).toBe('failed');
    expect(r.error).toContain('backup failed');
    expect(rows(db)).toEqual(before);
  });

  it('copies the Slack token file into the Keychain after commit, leaving the file, and never logs it', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    const c = ctxFor();
    const file = fs.readFileSync(c.slackTokenPath!, 'utf-8');
    runMigration(db, { dbPath, steps: STEPS, context: c });
    expect(kc.get(KEYCHAIN_SERVICE, DEFAULT_ACCOUNT)).toBe(TOKEN);
    expect(fs.readFileSync(c.slackTokenPath!, 'utf-8')).toBe(file);
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(JSON.stringify(rows(db))).not.toContain(TOKEN);
    expect(copyTokenToKeychain({ ...(c as MigrationContext), db })).toBe('already');
  });

  it('a Keychain failure does not undo the migration (the token file is still read)', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    setKeychainBackend({
      get: () => null,
      set: () => {
        throw new Error('keychain set failed: denied');
      },
      delete: () => {},
    });
    const r = runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    expect(r.outcome).toBe('migrated');
    expect(logs.some((l) => l.includes('after-commit work failed'))).toBe(true);
    expect(getSetting(db, 'slack_mode')).toBe('direct');
  });

  it('turns slack_watchers into watchers_enabled and drops the old row', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    db.prepare(`INSERT INTO settings(key, value) VALUES ('slack_watchers', 'off')`).run();
    runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    expect(getSetting(db, 'watchers_enabled', { env: false })).toBe(false);
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = 'slack_watchers'`).get()).toBeUndefined();
  });

  it('without the trust entry, Codex hook or token, writes those consents off', () => {
    const dbPath = legacyInstall();
    const c = ctxFor();
    fs.rmSync(c.claudeJsonPath!);
    fs.rmSync(c.codexHooksPath!);
    fs.rmSync(c.slackTokenPath!);
    const db = open(dbPath);
    runMigration(db, { dbPath, steps: STEPS, context: c });
    expect(getSetting(db, 'orchestrator_trust')).toBe(false);
    expect(getSetting(db, 'codex_hook')).toBe(false);
    expect(getSetting(db, 'slack_mode')).toBe('off');
  });

  it('replaces an unreadable row with the value it read as, and leaves "auto" keys unset', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    db.prepare(`UPDATE settings SET value = 'banana' WHERE key = 'auto_resume_parked'`).run();
    db.prepare(`DELETE FROM settings WHERE key IN ('terminal', 'launch_target')`).run();
    const was = getSetting(db, 'auto_resume_parked', { env: false });
    runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    expect(getSetting(db, 'auto_resume_parked', { env: false })).toBe(was);
    expect(db.prepare(`SELECT 1 FROM settings WHERE key IN ('terminal', 'launch_target')`).all()).toEqual([]);
  });
});

describe('migration: what else a legacy install keeps', () => {
  it('ships the legacy repo with /ship and labels required, imports its labels, on the legacy path only', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    const repo = path.join(ctxFor().home!, LEGACY_SHIP_REPO);
    const rowsShip = db.prepare(`SELECT project_dir, ship_command, label_required, enabled FROM ship_projects WHERE project_dir = ?`).all(repo);
    expect(rowsShip).toEqual([{ project_dir: repo, ship_command: '/ship', label_required: 1, enabled: 1 }]);
    expect(db.prepare(`SELECT label FROM ship_labels WHERE session_id = 'sess1'`).get()).toEqual({ label: 'a ship label' });

    const fresh = openDb(path.join(root, 'fresh', 'manager.db'));
    dbs.push(fresh);
    expect((fresh.prepare(`SELECT COUNT(*) AS n FROM ship_projects`).get() as { n: number }).n).toBe(0);
  });

  it('LOOM_SHIP_REPOS comes from the context env, not process.env', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    const other = path.join(root, 'other');
    execFileSync('git', ['init', '-q', '-b', 'main', other]);
    process.env.LOOM_SHIP_REPOS = '/nowhere';
    try {
      runMigration(db, { dbPath, steps: STEPS, context: { ...ctxFor(), env: { LOOM_SHIP_REPOS: other } } });
    } finally {
      delete process.env.LOOM_SHIP_REPOS;
    }
    const enabled = (db.prepare(`SELECT project_dir FROM ship_projects WHERE enabled = 1`).all() as { project_dir: string }[]).map((r) => r.project_dir);
    expect(enabled).toEqual([other]);
  });

  it('keeps the orchestrator prompt the install ran as prompt.override.md, never overwriting one', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    const dir = path.join(ctxFor().loomHome!, 'orchestrator');
    runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    expect(fs.readFileSync(path.join(dir, 'prompt.override.md'), 'utf-8')).toBe(OLD_PROMPT);
    expect(orchPromptText(dir)).toBe(OLD_PROMPT.trim()); // what the next start runs
    // Idempotent, and an override the user wrote is never replaced.
    fs.writeFileSync(path.join(dir, 'prompt.override.md'), 'mine\n');
    expect(keepOrchPrompt({ loomHome: ctxFor().loomHome!, log: () => {} })).toBe('override-exists');
    expect(fs.readFileSync(path.join(dir, 'prompt.override.md'), 'utf-8')).toBe('mine\n');
  });

  it('writes no override when prompt.md is missing or already the default', () => {
    const loomHome = path.join(root, 'lh');
    expect(keepOrchPrompt({ loomHome, log: () => {} })).toBe('no-prompt');
    write(path.join(loomHome, 'orchestrator', 'prompt.md'), ORCH_PROMPT + '\n');
    expect(keepOrchPrompt({ loomHome, log: () => {} })).toBe('same-as-default');
    expect(fs.existsSync(path.join(loomHome, 'orchestrator', 'prompt.override.md'))).toBe(false);
  });
});

describe('migration: detection', () => {
  it('an existing DB with rows but no settings rows is legacy, never fresh', () => {
    for (const seed of [
      `INSERT INTO projects (path, name, added_at) VALUES ('/p', 'p', 1)`,
      `INSERT INTO tags (name, color, created_at) VALUES ('t', 'blue', 1)`,
      `INSERT INTO watcher_seen (watcher_id, ts, seen_at) VALUES ('w', '1', 1)`,
    ]) {
      const file = path.join(fs.mkdtempSync(path.join(root, 'd-')), 'manager.db');
      const db = openDb(file, { migrate: false });
      db.prepare(`DELETE FROM settings`).run();
      try {
        db.prepare(seed).run();
      } catch (e) {
        db.close();
        throw new Error(`seed failed (${seed}): ${(e as Error).message}`);
      }
      expect(detect(db), seed).toBe('legacy');
      db.close();
      const again = openDb(file); // openDb migrates it as legacy
      dbs.push(again);
      expect(getSetting(again, 'setup_origin'), seed).toBe('migrated');
    }
  });

  it('only a truly new or empty file is fresh', () => {
    const file = path.join(root, 'empty', 'manager.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ''); // a zero-byte file
    const db = openDb(file);
    dbs.push(db);
    expect(getSetting(db, 'settings_schema')).toBe(2);
    expect(setupDone(db)).toBe(false);
    const changed = openDb(path.join(root, 'agent', 'manager.db'), { migrate: false });
    changed.prepare(`UPDATE settings SET value = 'codex' WHERE key = 'default_agent'`).run();
    expect(detect(changed)).toBe('legacy'); // a changed default_agent is a user choice
    changed.close();
  });

  it('after the first run the check is one read of one row', () => {
    const dbPath = legacyInstall();
    const db = open(dbPath);
    runMigration(db, { dbPath, steps: STEPS, context: ctxFor() });
    const sql: string[] = [];
    const real = db.prepare.bind(db);
    (db as unknown as { prepare: (s: string) => unknown }).prepare = (s: string) => (sql.push(s), real(s));
    expect(runMigration(db, { dbPath, steps: STEPS, context: ctxFor() }).outcome).toBe('current');
    expect(sql).toEqual(['SELECT key, value FROM settings WHERE key IN (?, ?)']); // the schema row and the late-step list together
  });

  it('two processes migrating the same file at once: one migrates, the other finds it done', async () => {
    const dbPath = legacyInstall();
    const before = (() => {
      const db = open(dbPath);
      const r = rows(db);
      db.close();
      dbs.pop();
      return r;
    })();
    const child = path.join(root, 'child.mts');
    const src = path.join(import.meta.dirname, '..', 'src');
    fs.writeFileSync(
      child,
      `import { openDb } from ${JSON.stringify(path.join(src, 'db.ts'))};
import { runMigration } from ${JSON.stringify(path.join(src, 'migrate.ts'))};
import { STEPS } from ${JSON.stringify(path.join(src, 'migrations', 'index.ts'))};
import { memoryBackend, setKeychainBackend } from ${JSON.stringify(path.join(src, 'secrets.ts'))};
setKeychainBackend(memoryBackend());
const ctx = JSON.parse(process.env.T7_CTX);
const db = openDb(process.env.T7_DB, { migrate: false });
// Hold the write lock a while so the other process has to wait on it.
const slow = { id: 'slow', run: () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400); } };
const r = runMigration(db, { dbPath: process.env.T7_DB, steps: [...STEPS, slow], context: { ...ctx, now: Number(process.env.T7_NOW), log: () => {} } });
process.stdout.write(JSON.stringify(r));
`,
    );
    const { home, loomHome, claudeHome, claudeJsonPath, codexHooksPath, slackTokenPath, legacyStateDir } = ctxFor();
    const ctxJson = JSON.stringify({ home, loomHome, claudeHome, claudeJsonPath, codexHooksPath, slackTokenPath, legacyStateDir, env: {} });
    const { spawn } = await import('node:child_process');
    const tsx = path.join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
    const runOne = (now: number) =>
      new Promise<{ outcome: string; backup?: string }>((resolve, reject) => {
        const p = spawn(tsx, [child], { env: { ...process.env, VITEST: '', T7_CTX: ctxJson, T7_DB: dbPath, T7_NOW: String(now) } });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
      });
    const results = await Promise.all([runOne(1_800_000_000_001), runOne(1_800_000_000_002)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['current', 'migrated']);
    const db = open(dbPath);
    expect(getSetting(db, 'settings_schema')).toBe(2);
    const now = new Map(rows(db).map((x) => [x.key, x.value]));
    for (const { key, value } of before) if (key !== 'em_mode') expect(now.get(key), key).toBe(value); // em_mode: the watchers step
    // One backup survives: the winner's. The loser removed its redundant copy.
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('pre-v2') && !f.endsWith('-wal') && !f.endsWith('-shm'))).toHaveLength(1);
  }, 30_000);
});

describe('migration: late steps on an install already at schema 2', () => {
  /** A legacy install migrated by a build that did not have the watchers step yet. */
  function schema2Install(): string {
    const dbPath = legacyInstall();
    const db = openDb(dbPath, { migrate: false });
    expect(runMigration(db, { dbPath, steps: STEPS.filter((s) => s.id !== 'watchers'), context: ctxFor() }).outcome).toBe('migrated');
    expect(db.prepare(`SELECT 1 FROM settings WHERE key = ?`).get(LATE_STEPS_KEY)).toBeUndefined();
    db.close();
    return dbPath;
  }
  const backups = (dbPath: string) => fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('.pre-') && !f.endsWith('-wal') && !f.endsWith('-shm')).sort();

  it('two processes opening it at once run a pending late step exactly once, and leave one backup', async () => {
    const dbPath = schema2Install();
    const [preV2] = backups(dbPath);
    expect(preV2).toMatch(/\.pre-v2-/);
    const preV2Bytes = fs.readFileSync(path.join(path.dirname(dbPath), preV2));
    const child = path.join(root, 'late-child.mts');
    const src = path.join(import.meta.dirname, '..', 'src');
    fs.writeFileSync(
      child,
      `import { openDb } from ${JSON.stringify(path.join(src, 'db.ts'))};
import { runMigration } from ${JSON.stringify(path.join(src, 'migrate.ts'))};
import { STEPS } from ${JSON.stringify(path.join(src, 'migrations', 'index.ts'))};
import { memoryBackend, setKeychainBackend } from ${JSON.stringify(path.join(src, 'secrets.ts'))};
setKeychainBackend(memoryBackend());
const ctx = JSON.parse(process.env.T7_CTX);
const db = openDb(process.env.T7_DB, { migrate: false });
// A second late step that holds the write lock a while, and counts its runs in the DB.
const slow = { id: 'slow', late: true, run: (c) => {
  c.db.prepare("INSERT INTO settings(key, value) VALUES ('slow_runs', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1").run();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
} };
const r = runMigration(db, { dbPath: process.env.T7_DB, steps: [...STEPS, slow], context: { ...ctx, now: Number(process.env.T7_NOW), log: () => {} } });
process.stdout.write(JSON.stringify(r));
`,
    );
    const { home, loomHome, claudeHome, claudeJsonPath, codexHooksPath, slackTokenPath, legacyStateDir } = ctxFor();
    const ctxJson = JSON.stringify({ home, loomHome, claudeHome, claudeJsonPath, codexHooksPath, slackTokenPath, legacyStateDir, env: {} });
    const { spawn } = await import('node:child_process');
    const tsx = path.join(import.meta.dirname, '..', 'node_modules', '.bin', 'tsx');
    const runOne = (now: number) =>
      new Promise<{ outcome: string; steps: string[] }>((resolve, reject) => {
        const p = spawn(tsx, [child], { env: { ...process.env, VITEST: '', T7_CTX: ctxJson, T7_DB: dbPath, T7_NOW: String(now) } });
        let out = '';
        let err = '';
        p.stdout.on('data', (d) => (out += d));
        p.stderr.on('data', (d) => (err += d));
        p.on('close', (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
      });
    const results = await Promise.all([runOne(1_800_000_000_101), runOne(1_800_000_000_102)]);
    expect(results.map((r) => r.outcome).sort()).toEqual(['current', 'migrated']);
    expect(results.find((r) => r.outcome === 'migrated')!.steps).toEqual(['watchers', 'slow']);
    const db = open(dbPath);
    const row = (k: string) => (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k) as { value: string } | undefined)?.value;
    expect(row('slow_runs')).toBe('1');
    expect(JSON.parse(row(LATE_STEPS_KEY)!)).toEqual(['watchers', 'slow']);
    // The watchers step ran once: each spawn became one event, each EM watcher one row.
    expect(db.prepare(`SELECT COUNT(*) n FROM watcher_events`).get()).toEqual({ n: 5 });
    expect(db.prepare(`SELECT COUNT(*) n FROM watchers WHERE id LIKE 'em-%'`).get()).toEqual({ n: 3 });
    // One late-step backup (the winner's), named apart from the pre-v2 one, which is untouched.
    const now = backups(dbPath);
    expect(now.filter((f) => f.includes('.pre-watchers-slow-'))).toHaveLength(1);
    expect(now.filter((f) => f.includes('.pre-v2-'))).toEqual([preV2]);
    expect(fs.readFileSync(path.join(path.dirname(dbPath), preV2)).equals(preV2Bytes)).toBe(true);
  }, 30_000);

  it('a late step that throws: openDb does not throw, logs, leaves the DB unchanged with no backup, and a later open retries', () => {
    const dbPath = schema2Install();
    // The watchers step is recorded done, so only the failing step is pending.
    const prep = openDb(dbPath, { migrate: false });
    prep.prepare(`INSERT INTO settings(key, value) VALUES (?, '["watchers"]')`).run(LATE_STEPS_KEY);
    const dump = () => JSON.stringify(['settings', 'watchers', 'watcher_events', 'ship_projects'].map((t) => prep.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));
    const before = dump();
    const backupsBefore = backups(dbPath);
    let tries = 0;
    let fail = true;
    const boom: MigrationStep = {
      id: 'boom',
      late: true,
      run(c) {
        tries++;
        c.db.prepare(`INSERT INTO settings(key, value) VALUES ('boom_was_here', '1')`).run();
        if (fail) throw new Error('boom');
      },
    };
    const errs: string[] = [];
    const realLog = console.log;
    console.log = (...a: unknown[]) => void errs.push(a.join(' '));
    registerSteps([...STEPS, boom]);
    try {
      const a = openDb(dbPath); // the server/app path
      a.close();
      expect(tries).toBe(1);
      expect(errs.some((l) => l.includes('rolled back at late step boom') && l.includes('boom'))).toBe(true);
      expect(dump()).toBe(before);
      expect(backups(dbPath)).toEqual(backupsBefore);
      // The same process does not retry on every open (each try is a full backup).
      openDb(dbPath).close();
      expect(tries).toBe(1);
      // A later open (after the retry window, or the next start) retries; once it passes it is recorded.
      resetLateFailures();
      fail = false;
      openDb(dbPath).close();
      expect(tries).toBe(2);
      expect(JSON.parse((prep.prepare(`SELECT value FROM settings WHERE key = ?`).get(LATE_STEPS_KEY) as { value: string }).value)).toEqual(['watchers', 'boom']);
      openDb(dbPath).close();
      expect(tries).toBe(2);
    } finally {
      console.log = realLog;
      registerSteps(STEPS);
      resetLateFailures();
      prep.close();
    }
  });
});

describe('migration: a fresh install', () => {
  it('openDb on a new file writes settings_schema=2 only, so the wizard shows', () => {
    const dbPath = path.join(root, 'loom', 'manager.db');
    const db = openDb(dbPath);
    dbs.push(db);
    expect(rows(db)).toEqual([
      { key: 'default_agent', value: 'claude' },
      // A new install has nothing for a late step to convert: they are recorded as done.
      { key: 'migration_steps_done', value: '["watchers"]' },
      { key: 'settings_schema', value: '2' },
    ]);
    expect(setupDone(db)).toBe(false);
    expect(getSetting(db, 'orchestrator_enabled', { env: false })).toBe('0');
    expect(getSetting(db, 'perm_chats', { env: false })).toBe('normal');
    expect(fs.readdirSync(path.dirname(dbPath)).filter((f) => f.includes('pre-v2'))).toEqual([]);
    // Reopening is a no-op.
    db.close();
    dbs.pop();
    const again = openDb(dbPath);
    dbs.push(again);
    expect(rows(again)).toHaveLength(3);
  });

  it('a wizard-finished install is done; an in-progress one is not', () => {
    const db = openDb(path.join(root, 'm.db'));
    dbs.push(db);
    expect(setupDone(db)).toBe(false);
    db.prepare(`INSERT INTO settings(key, value) VALUES ('setup_state', '{"version":1,"current":"slack"}')`).run();
    expect(setupDone(db)).toBe(false);
    db.prepare(`INSERT INTO settings(key, value) VALUES ('setup_completed_at', '5'), ('setup_origin', 'fresh')`).run();
    expect(setupDone(db)).toBe(true);
  });

  it(':memory: DBs are not migrated unless asked', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    expect(detect(db)).toBe('fresh');
    const m = openDb(':memory:', { migrate: true });
    dbs.push(m);
    expect(detect(m)).toBe('current');
  });
});

describe('reading an install’s values from its data', () => {
  it('skill names from briefs', () => {
    expect(reviewSkillFromBriefs(['Load the acme-review skill and run it.'])).toBe('acme-review');
    expect(reviewSkillFromBriefs(['load the skill'])).toBeUndefined();
    expect(voiceSkillFromBriefs(['Load the acme-review skill', 'load jo-voice + other first'])).toBe('jo-voice');
    expect(voiceSkillFromBriefs(['(load jo-voice first)'])).toBe('jo-voice');
    expect(voiceSkillFromBriefs(['nothing here'])).toBeUndefined();
  });

  it('the most common lane among recorded spawns', () => {
    const db = openDb(':memory:');
    dbs.push(db);
    const s = db.prepare(`INSERT INTO watcher_spawns (watcher_id, ts, title, permalink, status, pane_where, queued_at) VALUES ('w', ?, 't', 'p', 'spawned', ?, 1)`);
    ['loom-ab-1:1.0', 'loom-ab-2:1.1', 'loom-cd-3:1.0', 'loom-terminals:1.0', 'other-ab-1:1.0'].forEach((w, i) => s.run(String(i), w));
    expect(laneFromSpawns(db, 'loom-')).toBe('ab');
    expect(laneFromSpawns(openDb(':memory:'), 'loom-')).toBeUndefined();
  });
});

describe('legacy placement hook shim', () => {
  const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'record-placement.sh');
  const run = (payload: unknown, env: Record<string, string>, state?: unknown) => {
    const loomHome = path.join(root, 'hookhome');
    fs.mkdirSync(loomHome, { recursive: true });
    if (state !== undefined) fs.writeFileSync(path.join(loomHome, 'plugin-state.json'), typeof state === 'string' ? state : JSON.stringify(state));
    const clean = { ...process.env };
    delete clean.CLAUDE_PLUGIN_ROOT;
    delete clean.CODEX_HOME;
    execFileSync(HOOK, { input: JSON.stringify(payload), env: { ...clean, LOOM_HOME: loomHome, TMUX: '/tmp/x,1,0', TMUX_PANE: '%42', ...env }, encoding: 'utf-8' });
    const f = path.join(loomHome, 'placements.jsonl');
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).length : 0;
  };
  const claude = { session_id: 'c1', transcript_path: '/u/.claude/projects/x/c1.jsonl', cwd: '/u' };
  const codex = { session_id: 'x1', transcript_path: '/u/.codex/sessions/2026/rollout-2026-x1.jsonl', cwd: '/u' };

  it('records as before when the plugin is not installed (no file, corrupt file, no plugin_version)', () => {
    expect(run(claude, {})).toBe(1);
    expect(run(claude, {}, '{nope')).toBe(2);
    expect(run(claude, {}, { slack_mode: 'direct' })).toBe(3);
  });

  it('steps aside for Claude once the plugin is installed, but the plugin copy and Codex still record', () => {
    const st = { plugin_version: '0.1.0', slack_mode: 'off' };
    expect(run(claude, {}, st)).toBe(0);
    expect(run(claude, { CLAUDE_PLUGIN_ROOT: '/p/loom' }, st)).toBe(1);
    expect(run(codex, {}, st)).toBe(2);
  });
});

describe('install-hook (Codex only, consent first)', () => {
  it('prints the change without --yes, writes it with --yes, then reports already', async () => {
    const { install } = (await import('../scripts/install-hook.mjs')) as unknown as { install: (f: string, c: string, apply: boolean) => string };
    const file = path.join(root, 'codex', 'hooks.json');
    write(file, JSON.stringify({ hooks: { Stop: [] } }));
    const orig = fs.readFileSync(file, 'utf-8');
    const quiet = console.log;
    console.log = () => {};
    try {
      expect(install(file, '/r/hooks/record-placement.sh', false)).toBe('would');
      expect(fs.readFileSync(file, 'utf-8')).toBe(orig);
      expect(install(file, '/r/hooks/record-placement.sh', true)).toBe('written');
      expect(fs.readFileSync(file + '.loom-bak', 'utf-8')).toBe(orig);
      expect(install(file, '/r/hooks/record-placement.sh', true)).toBe('already');
    } finally {
      console.log = quiet;
    }
    const cfg = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Object.keys(cfg.hooks).sort()).toEqual(['SessionStart', 'Stop', 'UserPromptSubmit']);
  });

  it('never names ~/.claude/settings.json', () => {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'scripts', 'install-hook.mjs'), 'utf-8');
    expect(src).not.toMatch(/path\.join\([^)]*'\.claude'[^)]*'settings\.json'/);
    const setup = fs.readFileSync(path.join(import.meta.dirname, '..', 'setup.sh'), 'utf-8');
    expect(setup).not.toContain('pretrustFolder');
    expect(setup).not.toContain("INSERT OR IGNORE INTO settings");
  });
});
