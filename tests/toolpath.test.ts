import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readToolStore, rememberTools, resolveTool, toolEnv } from '../src/toolpath.ts';

const has = (set: string[]) => (p: string) => set.includes(p);
const empty = { tools: {}, loginPath: [] };
const FINDER = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

describe('resolveTool', () => {
  it('order: setting, remembered, login PATH, process PATH, known dirs', () => {
    const o = { home: '/h', env: FINDER, knownDirs: ['/h/.claude/local'] };
    const all = ['/opt/x/claude', '/mem/claude', '/login/claude', '/usr/bin/claude', '/h/.claude/local/claude'];
    const store = { tools: { claude: '/mem/claude' }, loginPath: ['/login'] };
    expect(resolveTool('claude', { ...o, setting: '/opt/x/claude', store, isExec: has(all) })).toBe('/opt/x/claude');
    expect(resolveTool('claude', { ...o, store, isExec: has(all) })).toBe('/mem/claude');
    expect(resolveTool('claude', { ...o, store, isExec: has(all.slice(2)) })).toBe('/login/claude');
    expect(resolveTool('claude', { ...o, store, isExec: has(all.slice(3)) })).toBe('/usr/bin/claude');
    expect(resolveTool('claude', { ...o, store, isExec: has(all.slice(4)) })).toBe('/h/.claude/local/claude');
    expect(resolveTool('claude', { ...o, store, isExec: has([]) })).toBeNull();
  });
  it('a setting that is gone falls through; a bare name in the setting is looked up', () => {
    const o = { home: '/h', env: FINDER, knownDirs: ['/opt/homebrew/bin'], store: empty };
    expect(resolveTool('claude', { ...o, setting: '/gone/claude', isExec: has(['/opt/homebrew/bin/claude']) })).toBe('/opt/homebrew/bin/claude');
    expect(resolveTool('claude', { ...o, setting: 'claude-beta', isExec: has(['/opt/homebrew/bin/claude-beta', '/opt/homebrew/bin/claude']) })).toBe('/opt/homebrew/bin/claude-beta');
    expect(resolveTool('claude', { ...o, setting: '~/bin/claude', isExec: has(['/h/bin/claude']) })).toBe('/h/bin/claude');
  });
  it('the known places include ~/.local/bin, ~/.claude/local, Homebrew and nvm', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tp-'));
    fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin'), { recursive: true });
    const nvm22 = path.join(home, '.nvm', 'versions', 'node', 'v22.3.0', 'bin', 'claude');
    const nvm20 = path.join(home, '.nvm', 'versions', 'node', 'v20.1.0', 'bin', 'claude');
    expect(resolveTool('claude', { home, env: FINDER, store: empty, isExec: has([nvm20, nvm22]) })).toBe(nvm22);
    expect(resolveTool('claude', { home, env: FINDER, store: empty, isExec: has([path.join(home, '.claude', 'local', 'claude')]) })).toBe(path.join(home, '.claude', 'local', 'claude'));
  });
});

describe('toolEnv', () => {
  it("puts the tool's own folder first, then the login PATH, and keeps the process PATH", () => {
    const env = toolEnv('/n/v22/bin/claude', { home: '/h', base: FINDER, store: { tools: {}, loginPath: ['/login'] } });
    const parts = env.PATH!.split(':');
    expect(parts[0]).toBe('/n/v22/bin');
    expect(parts).toContain('/login');
    expect(parts).toContain('/usr/sbin');
  });
});

describe('rememberTools', () => {
  it('keeps absolute paths and the login PATH, and drops entries whose file is gone', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tp-'));
    const bin = path.join(dir, 'claude');
    fs.writeFileSync(bin, '#!/bin/sh\n', { mode: 0o755 });
    rememberTools({ claude: bin, gh: undefined, tmux: 'tmux' }, ['/a', '/b'], dir);
    expect(readToolStore(dir)).toMatchObject({ tools: { claude: bin }, loginPath: ['/a', '/b'] });
    rememberTools({}, null, dir); // a failed login lookup keeps the old PATH
    expect(readToolStore(dir).loginPath).toEqual(['/a', '/b']);
    fs.rmSync(bin);
    rememberTools({}, null, dir);
    expect(readToolStore(dir).tools).toEqual({});
  });
});
