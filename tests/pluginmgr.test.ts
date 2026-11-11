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
import { rememberTools } from '../src/toolpath.ts';
import { clearCapsMemo } from '../src/claudecaps.ts';

const SRC = bundledPluginDir()!;
let tmp: string;
let home: string;
let db: Database.Database;
const cleanups: (() => void)[] = [];

// A stand-in for `claude` that behaves like a given release: it answers --help
// and --version from help captured from that release (tests/fixtures/claude-cli/
// <version>), rejects an option that release does not list ("error: unknown
// option '--json'", as commander does) and a subcommand it lacks, logs every
// other argv, and records an install in list.json, list.txt and the settings
// file. FAKE_FAIL makes a matching command fail.
const CLI_FIXTURES = path.resolve(__dirname, 'fixtures', 'claude-cli');
function fakeClaude(dir: string): string {
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
H="$FAKE_HELP"
case "$*" in
  --version) echo "$FAKE_VERSION (Claude Code)"; exit 0 ;;
  *" --help") f="$H/$(echo "$*" | sed 's/ --help$//' | tr ' ' '-').txt"; cat "$f"; exit 0 ;;
esac
case "$*" in
  "plugin marketplace add"*) f=plugin-marketplace-add ;;
  "plugin marketplace list"*) f=plugin-marketplace-list ;;
  "plugin marketplace remove"*) f=plugin-marketplace-remove ;;
  "plugin install"*) f=plugin-install ;;
  "plugin uninstall"*) f=plugin-uninstall ;;
  "plugin list"*) f=plugin-list ;;
  *) f=plugin ;;
esac
if ! grep -q "^Usage: claude $(echo $f | tr '-' ' ')" "$H/$f.txt"; then echo "error: unknown command '$(echo $f | sed 's/.*-//')'" >&2; exit 1; fi
for a in "$@"; do case "$a" in --*) grep -q -- "$a" "$H/$f.txt" || { echo "error: unknown option '$a'" >&2; exit 1; } ;; esac; done
echo "$*" >> "$FAKE_DIR/argv.log"
if [ -n "$FAKE_FAIL" ] && echo "$*" | grep -q "$FAKE_FAIL"; then echo "boom" >&2; exit 1; fi
case "$*" in
  "plugin list --json") cat "$FAKE_DIR/list.json" ;;
  "plugin list") cat "$FAKE_DIR/list.txt" 2>/dev/null || echo "No plugins installed." ;;
  "plugin marketplace list --json") cat "$FAKE_DIR/mlist.json" ;;
  "plugin marketplace list") cat "$FAKE_DIR/mlist.txt" 2>/dev/null || echo "No marketplaces configured" ;;
  "plugin install"*)
    echo '[{"id":"loom@loom-local","version":"0.1.0","enabled":true}]' > "$FAKE_DIR/list.json"
    printf 'Installed plugins:\n\n  > loom@loom-local\n    Version: 0.1.0\n    Status: enabled\n' > "$FAKE_DIR/list.txt"
    echo '{"enabledPlugins":{"loom@loom-local":true}}' > "$FAKE_DIR/nosettings.json"
    echo "Successfully installed plugin: loom@loom-local" ;;
  *) echo '{"ok":true}' ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(dir, 'list.json'), '[]');
  fs.writeFileSync(path.join(dir, 'mlist.json'), '[]');
  return bin;
}
const asVersion = (v: string) => {
  process.env.FAKE_VERSION = v;
  process.env.FAKE_HELP = path.join(CLI_FIXTURES, v);
  clearCapsMemo();
};
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
  asVersion('2.1.322');
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
      'plugin list --json', // the install is confirmed in Claude's own list
      'plugin list --json', // the status returned with the result
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
    const r = await mgr({ claudeBin: path.join(tmp, 'nope'), home: tmp, env: { PATH: '/nonexistent' }, knownDirs: [] }).install();
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/claude was not found/);
  });

  // 0.1.103 on a fresh Mac: launched from Finder, PATH is /usr/bin:/bin:/usr/sbin:/sbin.
  // The wizard's probe found claude through the login shell; the plugin step then
  // spawned a bare `claude` on the minimal PATH and said it was not found.
  it('installs with a Finder PATH when claude is reachable only through the login shell', async () => {
    const loginBin = path.join(tmp, 'login-only-bin');
    fs.mkdirSync(loginBin);
    fs.renameSync(path.join(tmp, 'claude'), path.join(loginBin, 'claude'));
    // npm-style: claude is a script whose interpreter sits next to it, as node does under nvm.
    fs.writeFileSync(path.join(loginBin, 'fakenode'), '#!/bin/sh\nexec /bin/sh "$@"\n', { mode: 0o755 });
    const script = fs.readFileSync(path.join(loginBin, 'claude'), 'utf8').replace('#!/bin/sh', '#!/usr/bin/env fakenode');
    fs.writeFileSync(path.join(loginBin, 'claude'), script, { mode: 0o755 });
    // What the probe records after its login-shell lookup (src/probe.ts, rememberTools).
    rememberTools({}, [loginBin], home);
    const r = await mgr({ claudeBin: undefined, home: tmp, env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }, knownDirs: [] }).install();
    expect(r.detail).toBeUndefined();
    expect(r.ok).toBe(true);
    expect(r.steps[0].display).toContain(path.join(loginBin, 'claude'));
    expect(argv()).toContain(`plugin install ${PLUGIN_ID} --scope user --json`);
  });

  it('uses the absolute claude the probe remembered, ahead of any PATH', async () => {
    const elsewhere = path.join(tmp, 'remembered');
    fs.mkdirSync(elsewhere);
    fs.copyFileSync(path.join(tmp, 'claude'), path.join(elsewhere, 'claude'));
    fs.chmodSync(path.join(elsewhere, 'claude'), 0o755);
    rememberTools({ claude: path.join(elsewhere, 'claude') }, null, home);
    const r = await mgr({ claudeBin: undefined, home: tmp, env: { ...process.env, PATH: '/usr/bin:/bin' }, knownDirs: [] }).install();
    expect(r.ok).toBe(true);
    expect(r.steps[0].display).toContain(path.join(elsewhere, 'claude'));
  });

  // 0.1.106 on a second Mac: an npm claude under nvm, older than --json on these commands.
  it('an old claude (2.1.2) gets no --json and no marketplace --scope, and the install is confirmed from settings', async () => {
    asVersion('2.1.2');
    const r = await mgr().install();
    expect(r.detail).toBeUndefined();
    expect(r.ok).toBe(true);
    const dir = marketplaceDir(home);
    expect(argv()).toEqual(['plugin marketplace list', `plugin marketplace add ${dir}`, `plugin install ${PLUGIN_ID} --scope user`]);
    expect(r.status.status).toBe('installed');
    expect(r.status.preview.install.map((c) => c.argv.slice(1).join(' '))).toEqual([`plugin marketplace add ${dir}`, `plugin install ${PLUGIN_ID} --scope user`]);
  });

  it('2.0.20 (the first with plugin install) gets no flags at all', async () => {
    asVersion('2.0.20');
    const r = await mgr().install();
    expect(r.ok).toBe(true);
    expect(argv()).toEqual(['plugin marketplace list', `plugin marketplace add ${marketplaceDir(home)}`, `plugin install ${PLUGIN_ID}`]);
  });

  it('the fake really is strict: an old claude given --json fails the way the second Mac did', async () => {
    asVersion('2.1.2');
    const out = require('node:child_process').spawnSync(path.join(tmp, 'claude'), ['plugin', 'marketplace', 'add', '/x', '--scope', 'user', '--json'], { env: process.env, encoding: 'utf8' });
    expect(out.status).toBe(1);
    expect(out.stderr).toContain("error: unknown option '--scope'");
  });

  it('a claude too old for plugins says which version is needed and how to update', async () => {
    fs.mkdirSync(path.join(tmp, 'v1'));
    for (const f of ['plugin', 'plugin-marketplace']) fs.writeFileSync(path.join(tmp, 'v1', f + '.txt'), 'Usage: claude [options] [command] [prompt]\n');
    process.env.FAKE_VERSION = '1.0.128';
    process.env.FAKE_HELP = path.join(tmp, 'v1');
    clearCapsMemo();
    const r = await mgr().install();
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("Claude Code 1.0.128 has no plugin commands. Loom's plugin needs Claude Code 2.0.20 or newer. Update with `claude update`, or reinstall Claude Code.");
    expect(argv()).toEqual([]);
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
