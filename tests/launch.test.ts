import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { buildLaunchCommand } from '../src/goto.ts';
import { launchCommand } from '../src/watchers.ts';
import {
  ORCH_PROMPT,
  ORCH_PROMPT_OVERRIDE,
  buildOrchestratorCommand,
  ensureOrchFiles,
  superviseOrchestrator,
  type OrchFiles,
  type SuperviseDeps,
} from '../src/orchsession.ts';
import { orchSettings } from '../src/orchestrator.ts';
import { setSetting } from '../src/settingsSchema.ts';
import {
  LEGACY_LAUNCH_SETTINGS,
  SAFE_LAUNCH_SETTINGS,
  claudeCommand,
  currentLaunchSettings,
  readLaunchSettings,
  setLaunchSettingsSource,
} from '../src/launch.ts';

// Every string below was captured from the code BEFORE the launch builder existed
// (scratchpad t8-before.json), so these are today's command lines, byte for byte.
const RESUME_ENV = 'CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=99999999 CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999';
const SEED =
  "'Heads up from Loom: this is a forked branch of a previous Claude Code session. You carry that session'\\''s full context, but this is now an independent branch with a new session id — nothing you do here affects the original session, and there is no need to redo prior work. Briefly acknowledge that you understand this is a fork, then wait for my next instruction.'";
const KICK_NEW = "$'Loom started you as the orchestrator. Call list_items and list_chats, make the items match what you find, reply with one line, then wait for [Loom events] or the user.'";
const KICK_RESTART = "$'Loom restarted you (the session had exited). Re-read list_items and list_chats, fix any item that is stale, reply with one line, then wait.'";

const base = { projectDir: '/p q', sourceAgent: 'claude', selectedAgent: 'claude' } as const;
const files: OrchFiles = { dir: '/Users/x/.loom/orchestrator', mcpConfig: '/m.json', promptFile: '/p.md', tokenFile: '/t' };

function legacyDb() {
  return openDb(':memory:'); // no settings_schema row: an install from before the registry
}
function migratedDb() {
  const db = openDb(':memory:');
  // What the migration writes for an existing install: explicit rows, schema 2.
  for (const [k, v] of [['perm_chats', 'skip'], ['perm_watchers', 'skip'], ['perm_orchestrator', 'skip'], ['rc_watchers', true], ['orchestrator_enabled', '1'], ['settings_schema', '2']] as const) {
    const r = setSetting(db, k as never, v as never);
    if (!r.ok && k !== 'settings_schema') throw new Error(r.detail);
  }
  db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('settings_schema', '2')`).run();
  return db;
}
function newUserDb() {
  const db = openDb(':memory:');
  db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('settings_schema', '2')`).run();
  return db;
}

describe('command lines under migrated settings are today’s, byte for byte', () => {
  const S = LEGACY_LAUNCH_SETTINGS;
  it('fresh chat', () => {
    expect(buildLaunchCommand({ ...base, sessionId: 'abc-123', fresh: true, prompt: 'say hi\nand stop' }, S))
      .toBe("cd '/p q' && claude --dangerously-skip-permissions --session-id 'abc-123' $'say hi\\nand stop'");
    expect(buildLaunchCommand({ ...base, sessionId: '', fresh: true }, S)).toBe("cd '/p q' && claude --dangerously-skip-permissions");
    expect(buildLaunchCommand({ ...base, sessionId: '', fresh: true, prompt: "it's go" }, S)).toBe("cd '/p q' && claude --dangerously-skip-permissions $'it\\'s go'");
  });
  it('resume and branch', () => {
    expect(buildLaunchCommand({ ...base, sessionId: 's' }, S)).toBe(`cd '/p q' && ${RESUME_ENV} claude --resume 's' --dangerously-skip-permissions`);
    expect(buildLaunchCommand({ ...base, sessionId: 's', prompt: 'Jemelee replied\nok' }, S))
      .toBe(`cd '/p q' && ${RESUME_ENV} claude --resume 's' --dangerously-skip-permissions $'Jemelee replied\\nok'`);
    expect(buildLaunchCommand({ ...base, sessionId: 's', fork: true }, S))
      .toBe(`cd '/p q' && ${RESUME_ENV} claude --resume 's' --fork-session --dangerously-skip-permissions ${SEED}`);
  });
  it('watcher worker', () => {
    expect(launchCommand("/a/b's", '/x/brief.md', 'blue-vanilla', S))
      .toBe(`cd '/a/b'\\''s' && claude --dangerously-skip-permissions --remote-control 'blue-vanilla' "$(cat '/x/brief.md')"`);
  });
  it('orchestrator, new and restarted', () => {
    expect(buildOrchestratorCommand({ files, sessionId: 'abc', resume: false }, S)).toBe(
      `cd '/Users/x/.loom/orchestrator' && claude --session-id 'abc' --dangerously-skip-permissions --remote-control 'Loom orchestrator' --name 'Loom orchestrator' --mcp-config '/m.json' --append-system-prompt "$(cat '/p.md')" ${KICK_NEW}`,
    );
    expect(buildOrchestratorCommand({ files, sessionId: 'abc', resume: true }, S)).toBe(
      `cd '/Users/x/.loom/orchestrator' && ${RESUME_ENV} claude --resume 'abc' --dangerously-skip-permissions --remote-control 'Loom orchestrator' --name 'Loom orchestrator' --mcp-config '/m.json' --append-system-prompt "$(cat '/p.md')" ${KICK_RESTART}`,
    );
  });
});

describe('settings resolve to those same flags', () => {
  it('a migrated database reads as the legacy settings', () => {
    expect(readLaunchSettings(migratedDb())).toEqual(LEGACY_LAUNCH_SETTINGS);
  });
  it('an unmigrated database reads as the legacy settings', () => {
    expect(readLaunchSettings(legacyDb())).toEqual(LEGACY_LAUNCH_SETTINGS);
  });
  it('a new install reads as safe: normal permissions, no Remote Control', () => {
    expect(readLaunchSettings(newUserDb())).toEqual(SAFE_LAUNCH_SETTINGS);
  });
});

describe('a new user’s commands carry no skip-permissions, and Remote Control only on the orchestrator', () => {
  const S = readLaunchSettings(newUserDb());
  const all = [
    buildLaunchCommand({ ...base, sessionId: 'abc', fresh: true, prompt: 'hi' }, S),
    buildLaunchCommand({ ...base, sessionId: 's' }, S),
    buildLaunchCommand({ ...base, sessionId: 's', fork: true }, S),
    launchCommand('/p', '/b.md', 'name', S),
    buildOrchestratorCommand({ files, sessionId: 'abc', resume: false }, S),
    buildOrchestratorCommand({ files, sessionId: 'abc', resume: true }, S),
  ];
  it('never skips permissions; only the orchestrator has Remote Control', () => {
    all.forEach((c, i) => {
      expect(c).not.toContain('--dangerously-skip-permissions');
      if (i >= 4) expect(c).toContain("--remote-control 'Loom orchestrator'");
      else expect(c).not.toContain('--remote-control');
    });
  });
  it('keeps everything else', () => {
    expect(all[0]).toBe("cd '/p q' && claude --session-id 'abc' $'hi'");
    expect(all[1]).toBe(`cd '/p q' && ${RESUME_ENV} claude --resume 's'`);
    expect(all[2]).toBe(`cd '/p q' && ${RESUME_ENV} claude --resume 's' --fork-session ${SEED}`);
    expect(all[3]).toBe(`cd '/p' && claude "$(cat '/b.md')"`);
    expect(all[4]).toBe(`cd '/Users/x/.loom/orchestrator' && claude --session-id 'abc' --remote-control 'Loom orchestrator' --name 'Loom orchestrator' --mcp-config '/m.json' --append-system-prompt "$(cat '/p.md')" ${KICK_NEW}`);
  });
});

describe('each kind follows its own setting', () => {
  it('perm_chats does not touch watchers or the orchestrator, and the reverse', () => {
    const chatsOnly = { ...SAFE_LAUNCH_SETTINGS, skipChats: true };
    expect(claudeCommand({ kind: 'chat', dir: '/p' }, chatsOnly)).toContain('--dangerously-skip-permissions');
    expect(claudeCommand({ kind: 'watcher', dir: '/p', promptFile: '/b', name: 'n' }, chatsOnly)).not.toContain('--dangerously-skip-permissions');
    expect(claudeCommand({ kind: 'orch', dir: '/p', sid: 's', name: 'n' }, chatsOnly)).not.toContain('--dangerously-skip-permissions');
    const watchers = { ...SAFE_LAUNCH_SETTINGS, skipWatchers: true, rcWatchers: true };
    expect(claudeCommand({ kind: 'watcher', dir: '/p', promptFile: '/b', name: 'n' }, watchers)).toBe(`cd '/p' && claude --dangerously-skip-permissions --remote-control 'n' "$(cat '/b')"`);
    expect(claudeCommand({ kind: 'chat', dir: '/p' }, watchers)).not.toContain('--dangerously-skip-permissions');
    const orch = { ...SAFE_LAUNCH_SETTINGS };
    expect(claudeCommand({ kind: 'orch', dir: '/p', sid: 's', name: 'n' }, orch)).toContain("--remote-control 'n' --name 'n'");
    expect(claudeCommand({ kind: 'orch', dir: '/p', sid: 's', name: 'n' }, orch)).not.toContain('--dangerously-skip-permissions');
  });
  it('uses claude_bin, quoting it only when needed', () => {
    expect(claudeCommand({ kind: 'chat', dir: '/p' }, { ...SAFE_LAUNCH_SETTINGS, claudeBin: '/opt/homebrew/bin/claude' })).toBe("cd '/p' && /opt/homebrew/bin/claude");
    expect(claudeCommand({ kind: 'resume', dir: '/p', sid: 's' }, { ...SAFE_LAUNCH_SETTINGS, claudeBin: '/My Tools/claude' })).toContain(" '/My Tools/claude' --resume 's'");
    const db = newUserDb();
    setSetting(db, 'claude_bin', '/usr/local/bin/claude');
    expect(readLaunchSettings(db).claudeBin).toBe('/usr/local/bin/claude');
  });
});

describe('the settings source', () => {
  it('under test the default is safe, never skip', () => {
    expect(currentLaunchSettings()).toEqual(SAFE_LAUNCH_SETTINGS);
  });
  it('can be overridden and restored', () => {
    setLaunchSettingsSource(() => LEGACY_LAUNCH_SETTINGS);
    try {
      expect(buildLaunchCommand({ ...base, sessionId: '', fresh: true })).toBe("cd '/p q' && claude --dangerously-skip-permissions");
    } finally {
      setLaunchSettingsSource(null);
    }
    expect(buildLaunchCommand({ ...base, sessionId: '', fresh: true })).toBe("cd '/p q' && claude");
  });
});

describe('orchestrator opt-in', () => {
  const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-launch-'));
  function rig(db: ReturnType<typeof openDb>) {
    const dir = tmpDir();
    const f = ensureOrchFiles(dir, { command: 'node', args: ['mcp.js'] });
    const calls: string[][] = [];
    let acquired = 0;
    let trusted = 0;
    const deps: SuperviseDeps = {
      run: (args) => { calls.push(args); return ''; },
      world: () => ({ panes: [], focused: null }),
      acquire: () => { acquired++; return { ok: true, paneId: '%41', name: 'n', where: 'w' }; },
      now: () => 1_700_000_000_000,
      exists: () => false,
      uuid: () => '11111111-2222-3333-4444-555555555555',
      pretrust: () => { trusted++; },
    };
    return { db, f, deps, calls, acquired: () => acquired, trusted: () => trusted };
  }

  it('does not start on a fresh database', () => {
    const r = rig(newUserDb());
    expect(orchSettings.enabled(r.db, {})).toBe(false);
    expect(superviseOrchestrator(r.db, r.f, r.deps, { launches: [] })).toMatchObject({ action: 'disabled' });
    expect(r.acquired()).toBe(0);
    expect(r.calls.filter((c) => c[0] === 'send-keys')).toHaveLength(0);
    expect(r.trusted()).toBe(0);
  });
  it('still runs on an unmigrated or migrated install', () => {
    expect(orchSettings.enabled(legacyDb(), {})).toBe(true);
    expect(orchSettings.enabled(migratedDb(), {})).toBe(true);
  });
  it('starts once it is turned on, and $LOOM_ORCHESTRATOR=0 still wins', () => {
    const db = newUserDb();
    setSetting(db, 'orchestrator_enabled', '1');
    expect(orchSettings.enabled(db, {})).toBe(true);
    expect(orchSettings.enabled(db, { LOOM_ORCHESTRATOR: '0' })).toBe(false);
    expect(orchSettings.enabled(newUserDb(), { LOOM_ORCHESTRATOR: '1' })).toBe(true);
  });
  it('trusts the folder only with consent', () => {
    const noConsent = rig(newUserDb());
    setSetting(noConsent.db, 'orchestrator_enabled', '1');
    expect(superviseOrchestrator(noConsent.db, noConsent.f, noConsent.deps, { launches: [] })).toMatchObject({ action: 'started' });
    expect(noConsent.trusted()).toBe(0);
    // ...and with no skip/RC flags in the line it typed.
    const sent = noConsent.calls.find((c) => c[0] === 'send-keys' && c[3] === '-l')![4];
    expect(sent).not.toContain('--dangerously-skip-permissions');
    expect(sent).toContain('--remote-control'); // the orchestrator always has Remote Control

    const consent = rig(newUserDb());
    setSetting(consent.db, 'orchestrator_enabled', '1');
    setSetting(consent.db, 'orchestrator_trust', true);
    superviseOrchestrator(consent.db, consent.f, consent.deps, { launches: [] });
    expect(consent.trusted()).toBe(1);
  });
});

describe('orchestrator prompt', () => {
  it('has no personal tone or phone assumption', () => {
    expect(ORCH_PROMPT).not.toMatch(/Will|Remote Control|phone/);
  });
  it('is the default until prompt.override.md has text, and the override is re-read on every start', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prompt-'));
    const f = ensureOrchFiles(dir, { command: 'node', args: [] });
    expect(fs.readFileSync(f.promptFile, 'utf-8')).toBe(ORCH_PROMPT + '\n');
    fs.writeFileSync(path.join(dir, ORCH_PROMPT_OVERRIDE), 'Be a pirate.\n');
    ensureOrchFiles(dir, { command: 'node', args: [] });
    expect(fs.readFileSync(f.promptFile, 'utf-8')).toBe('Be a pirate.\n');
    fs.writeFileSync(path.join(dir, ORCH_PROMPT_OVERRIDE), '  \n');
    ensureOrchFiles(dir, { command: 'node', args: [] });
    expect(fs.readFileSync(f.promptFile, 'utf-8')).toBe(ORCH_PROMPT + '\n');

    // A supervised start picks up an edit made while Loom was running.
    const db = openDb(':memory:');
    fs.writeFileSync(path.join(dir, ORCH_PROMPT_OVERRIDE), 'Second edit.');
    superviseOrchestrator(db, f, {
      run: () => '', world: () => ({ panes: [], focused: null }), acquire: () => ({ ok: true, paneId: '%1', name: 'n', where: 'w' }),
      now: () => 1, exists: () => false, uuid: () => 'u', pretrust: () => {},
    }, { launches: [] });
    expect(fs.readFileSync(f.promptFile, 'utf-8')).toBe('Second edit.\n');
  });
});

describe('long prompts ride in a file, not the command line', () => {
  const tricky = 'line one\nit\'s "quoted" $HOME `date` $(id) \\n \\\\ \ttab é中😀\n';
  const big = (tricky.repeat(Math.ceil(50_000 / tricky.length))).trimEnd();
  const settings = SAFE_LAUNCH_SETTINGS;

  for (const kind of ['chat', 'resume', 'branch', 'orch'] as const) {
    it(`${kind}: a ${big.length}-char prompt keeps the command short and the file exact`, async () => {
      const { promptsDir } = await import('../src/launch.ts');
      const cmd = claudeCommand({ kind, dir: '/tmp/x', sid: 's1', name: 'n', prompt: big }, settings);
      expect(cmd.length).toBeLessThan(2000);
      const m = /"\$\(cat '([^']+)'\)"/.exec(cmd);
      expect(m).toBeTruthy();
      expect(path.dirname(m![1])).toBe(promptsDir());
      expect(fs.readFileSync(m![1], 'utf8')).toBe(big);
      expect(fs.statSync(m![1]).mode & 0o777).toBe(0o600);
    });
  }

  it('a short prompt stays inline', () => {
    expect(claudeCommand({ kind: 'chat', dir: '/tmp/x', prompt: 'hi' }, settings)).not.toContain('$(cat');
  });

  it('removes prompt files older than a week on the next long launch', async () => {
    const { promptsDir } = await import('../src/launch.ts');
    fs.mkdirSync(promptsDir(), { recursive: true });
    const old = path.join(promptsDir(), 'old.txt');
    fs.writeFileSync(old, 'x');
    const t = Date.now() / 1000 - 8 * 86400;
    fs.utimesSync(old, t, t);
    claudeCommand({ kind: 'chat', dir: '/tmp/x', prompt: big }, settings);
    expect(fs.existsSync(old)).toBe(false);
  });
});
