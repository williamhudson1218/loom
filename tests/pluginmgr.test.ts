import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { getSetting, setSetting } from '../src/settingsSchema.ts';
import {
  PluginManager,
  PLUGIN_ID,
  bundledPluginDir,
  compareVersions,
  installFiles,
  marketplaceDir,
  scanLegacyHooks,
  startPluginStateSync,
  writePluginStateFile,
} from '../src/pluginmgr.ts';

const SRC = bundledPluginDir()!;
let tmp: string;
let home: string;
let db: Database.Database;
const cleanups: (() => void)[] = [];

// A stand-in for `claude`: logs argv, answers list commands from files, and can be made to fail.
function fakeClaude(dir: string): string {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "$FAKE_DIR/argv.log"
if [ -n "$FAKE_FAIL" ] && echo "$*" | grep -q "$FAKE_FAIL"; then echo "boom" >&2; exit 1; fi
case "$*" in
  "plugin list --json") cat "$FAKE_DIR/list.json" ;;
  "plugin marketplace list --json") cat "$FAKE_DIR/mlist.json" ;;
  *) echo '{"ok":true}' ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, 'list.json'), '[]');
  fs.writeFileSync(path.join(dir, 'mlist.json'), '[]');
  return bin;
}
const argv = () => (fs.existsSync(path.join(tmp, 'argv.log')) ? fs.readFileSync(path.join(tmp, 'argv.log'), 'utf8').trim().split('\n') : []);
const mgr = (extra: Record<string, unknown> = {}) =>
  new PluginManager({ db, loomHome: home, bundledDir: SRC, claudeBin: path.join(tmp, 'claude'), claudeSettingsPath: path.join(tmp, 'nosettings.json'), rotateToken: () => {}, ...extra });

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pluginmgr-'));
  home = path.join(tmp, 'home');
  fs.mkdirSync(home);
  fakeClaude(tmp);
  process.env.FAKE_DIR = tmp;
  delete process.env.FAKE_FAIL;
  db = openDb(':memory:');
});
afterEach(() => {
  db.close();
  delete process.env.FAKE_DIR;
  delete process.env.FAKE_FAIL;
  while (cleanups.length) cleanups.pop()!();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('copy and atomic swap', () => {
  it('leaves tests out, stamps the version, sets modes', () => {
    const dir = installFiles(SRC, home, '9.9.9');
    expect(dir).toBe(marketplaceDir(home));
    expect(fs.existsSync(path.join(dir, '.claude-plugin', 'marketplace.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'tests'))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'loom', '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe('9.9.9');
    expect(fs.statSync(path.join(dir, 'loom', 'bin', 'loom')).mode & 0o777).toBe(0o755);
    expect(fs.statSync(path.join(dir, 'loom', 'README.md')).mode & 0o777).toBe(0o644);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o755);
  });

  it('replaces an existing tree in one rename and leaves no .new/.old behind', () => {
    const dir = installFiles(SRC, home, '1.0.0');
    fs.writeFileSync(path.join(dir, 'stale.txt'), 'x');
    const inode = fs.statSync(dir).ino;
    installFiles(SRC, home, '1.0.1');
    expect(fs.existsSync(path.join(dir, 'stale.txt'))).toBe(false);
    expect(fs.statSync(dir).ino).not.toBe(inode);
    expect(fs.existsSync(`${dir}.new`)).toBe(false);
    expect(fs.existsSync(`${dir}.old`)).toBe(false);
  });

  it('keeps the old tree when the source is unusable', () => {
    const dir = installFiles(SRC, home, '1.0.0');
    expect(() => installFiles(path.join(tmp, 'missing'), home, '2.0.0')).toThrow();
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'loom', '.claude-plugin', 'plugin.json'), 'utf8')).version).toBe('1.0.0');
    expect(fs.existsSync(`${dir}.old`)).toBe(false);
  });
});

describe('claude argv', () => {
  it('install adds the marketplace then installs, and records state + plugin-state.json', async () => {
    setSetting(db, 'slack_mode', 'mcp');
    const r = await mgr().install();
    expect(r.ok).toBe(true);
    const dir = marketplaceDir(home);
    expect(argv()).toEqual([
      'plugin marketplace list --json',
      `plugin marketplace add ${dir} --scope user --json`,
      `plugin install ${PLUGIN_ID} --scope user --json`,
      'plugin list --json',
    ]);
    expect((getSetting(db, 'plugin_state') as any).installed_version).toBeTruthy();
    expect(JSON.parse(fs.readFileSync(path.join(home, 'plugin-state.json'), 'utf8')).plugin_version).toBe((getSetting(db, 'plugin_state') as any).installed_version);
    expect(JSON.parse(fs.readFileSync(path.join(home, 'plugin-state.json'), 'utf8')).slack_mode).toBe('mcp');
  });

  it('skips marketplace add when Claude already has loom-local at this directory', async () => {
    fs.writeFileSync(path.join(tmp, 'mlist.json'), JSON.stringify([{ name: 'loom-local', installLocation: marketplaceDir(home) }]));
    await mgr().install();
    expect(argv().some((l) => l.startsWith('plugin marketplace add'))).toBe(false);
    expect(argv()).toContain(`plugin install ${PLUGIN_ID} --scope user --json`);
  });

  it('reports a failed step and does not record state', async () => {
    process.env.FAKE_FAIL = 'plugin install';
    const r = await mgr().install();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('boom');
    expect(getSetting(db, 'plugin_state')).toEqual({});
    expect(fs.existsSync(path.join(home, 'plugin-state.json'))).toBe(false);
  });

  it('missing claude is a clear failure', async () => {
    const r = await mgr({ claudeBin: path.join(tmp, 'nope') }).install();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/claude was not found/);
  });

  it('remove uninstalls, drops the marketplace, deletes the dir, rotates the token, clears state', async () => {
    let rotated = '';
    const m = mgr({ rotateToken: (d: string) => void (rotated = d) });
    await m.install();
    fs.writeFileSync(path.join(tmp, 'argv.log'), '');
    const r = await m.remove();
    expect(r.ok).toBe(true);
    expect(argv().slice(0, 2)).toEqual([`plugin uninstall ${PLUGIN_ID} --json`, 'plugin marketplace remove loom-local']);
    expect(fs.existsSync(marketplaceDir(home))).toBe(false);
    expect(fs.existsSync(path.join(home, 'plugin-state.json'))).toBe(false);
    expect(rotated).toBe(home);
    expect(getSetting(db, 'plugin_state')).toEqual({});
  });
});

describe('status', () => {
  const listed = (e: object) => fs.writeFileSync(path.join(tmp, 'list.json'), JSON.stringify([e]));

  it('not installed when claude does not list it', async () => {
    expect((await mgr().status()).status).toBe('not_installed');
  });
  it('installed, then update_available when the bundle is newer, then installed again after update', async () => {
    await mgr({ appVersion: '0.0.1' }).install();
    listed({ id: PLUGIN_ID, version: '0.0.1', enabled: true });
    expect((await mgr({ appVersion: '0.0.1' }).status()).status).toBe('installed');
    const s = await mgr().status(); // bundle is 0.1.0
    expect(s.status).toBe('update_available');
    expect(s.installedVersion).toBe('0.0.1');
    const u = await mgr().update();
    expect(u.ok).toBe(true);
    expect(u.status.status).toBe('installed');
    expect(u.steps).toEqual([]);
  });
  it('disabled when Claude lists it disabled', async () => {
    listed({ id: PLUGIN_ID, version: '0.1.0', enabled: false });
    expect((await mgr().status()).status).toBe('disabled');
  });
  it('error when claude list fails', async () => {
    process.env.FAKE_FAIL = 'plugin list';
    const s = await mgr().status();
    expect(s.status).toBe('error');
    expect(s.error).toContain('boom');
  });
  it('update refuses when not installed', async () => {
    const r = await mgr().update();
    expect(r.ok).toBe(false);
  });
  it('carries the command preview with the real directory', async () => {
    const s = await mgr().status();
    expect(s.preview.install.map((c) => c.display)).toEqual([
      `${path.join(tmp, 'claude')} plugin marketplace add ${marketplaceDir(home)} --scope user --json`,
      `${path.join(tmp, 'claude')} plugin install loom@loom-local --scope user --json`,
    ]);
    expect(s.preview.note).toMatch(/settings\.json/);
  });
  it('flags a build without plugin files', async () => {
    const s = await mgr({ bundledDir: null }).status();
    expect(s.sourceMissing).toBe(true);
    expect((await mgr({ bundledDir: null }).install()).ok).toBe(false);
  });
});

describe('legacy scan', () => {
  it('finds the four legacy patterns, with line and event, and never writes', () => {
    const f = path.join(tmp, 'settings.json');
    const body = JSON.stringify(
      {
        hooks: {
          SessionStart: [{ hooks: [{ type: 'command', command: '~/dev/loom/hooks/record-placement.sh' }] }],
          UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/slack-threads.py' }] }],
          Stop: [
            { hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/require-slack-outbox.py' }] },
            { hooks: [{ type: 'command', command: 'python3 ~/.claude/hooks/require-ship-label.py' }, { type: 'command', command: 'afplay x' }] },
          ],
        },
      },
      null,
      2,
    );
    fs.writeFileSync(f, body);
    const found = scanLegacyHooks(f);
    expect(found.map((e) => e.pattern)).toEqual(['loom/hooks/record-placement.sh', 'slack-threads.py', 'require-slack-outbox.py', 'require-ship-label.py']);
    expect(found.map((e) => e.event)).toEqual(['SessionStart', 'UserPromptSubmit', 'Stop', 'Stop']);
    for (const e of found) expect(body.split('\n')[e.line - 1].trim()).toBe(e.text);
    expect(fs.readFileSync(f, 'utf8')).toBe(body);
    expect(found).toHaveLength(4);
  });
  it('missing or unparseable file is quiet', () => {
    expect(scanLegacyHooks(path.join(tmp, 'none.json'))).toEqual([]);
    const f = path.join(tmp, 'bad.json');
    fs.writeFileSync(f, '{ "x": "slack-threads.py" ');
    expect(scanLegacyHooks(f)).toHaveLength(1);
  });
  it('ships in status', async () => {
    const f = path.join(tmp, 's.json');
    fs.writeFileSync(f, '{"hooks":{"Stop":[{"hooks":[{"command":"python3 require-ship-label.py"}]}]}}');
    expect((await mgr({ claudeSettingsPath: f }).status()).legacy).toHaveLength(1);
  });
});

describe('plugin-state.json', () => {
  it('carries slack_mode, outbox_chat_drafts and ship repos', () => {
    setSetting(db, 'slack_mode', 'direct');
    setSetting(db, 'outbox_chat_drafts', true);
    const add = db.prepare(`INSERT INTO ship_projects(project_dir, label_required, enabled) VALUES (?, ?, ?)`);
    add.run('/r/one', 1, 1);
    add.run('/r/two', 0, 1);
    add.run('/r/off', 1, 0);
    db.prepare(`UPDATE ship_projects SET ship_lock = 0, base_branch = 'trunk' WHERE project_dir = '/r/two'`).run();
    const file = writePluginStateFile(db, home);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).plugin_version).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ slack_mode: 'direct', outbox_chat_drafts: true, ship: { repos: ['/r/one', '/r/two'], label_required: ['/r/one'], lock: ['/r/one'], base: { '/r/one': 'main', '/r/two': 'trunk' } } });
    expect(fs.readdirSync(home).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
  it('is rewritten on setting changes once installed, and not before', async () => {
    const file = path.join(tmp, 'sync.db');
    const fdb = openDb(file);
    fdb.close();
    // a handle each time, like the server's per-request openDb
    cleanups.push(startPluginStateSync(() => openDb(file), home));
    db.close();
    db = openDb(file);
    setSetting(db, 'slack_mode', 'mcp');
    expect(fs.existsSync(path.join(home, 'plugin-state.json'))).toBe(false);
    await mgr().install();
    setSetting(db, 'slack_mode', 'off');
    expect(JSON.parse(fs.readFileSync(path.join(home, 'plugin-state.json'), 'utf8')).slack_mode).toBe('off');
  });
});

describe('plugin-state.json at startup', () => {
  it('is written when a repo is on Ship, plugin installed or not', () => {
    const file = path.join(tmp, 'boot.db');
    const d = openDb(file);
    d.prepare(`INSERT INTO ship_projects(project_dir) VALUES ('/r/one')`).run();
    d.close();
    cleanups.push(startPluginStateSync(() => openDb(file), home));
    expect(JSON.parse(fs.readFileSync(path.join(home, 'plugin-state.json'), 'utf8')).ship).toMatchObject({ repos: ['/r/one'], lock: ['/r/one'] });
  });
  it('is not written with no ship repos and no plugin', () => {
    const file = path.join(tmp, 'empty.db');
    openDb(file).close();
    cleanups.push(startPluginStateSync(() => openDb(file), home));
    expect(fs.existsSync(path.join(home, 'plugin-state.json'))).toBe(false);
  });
});

describe('compareVersions', () => {
  it('orders dotted versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('1.0', '1.0.1')).toBeLessThan(0);
  });
});
