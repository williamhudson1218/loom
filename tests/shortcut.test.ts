import { describe, it, expect } from 'vitest';
import { parseAccelerator, normalizeAccelerator, acceleratorFromEvent, classifyAccelerator, checkShortcut, setShortcutHost, Practice, PRACTICE_TIMEOUT_MS, routes } from '../src/routes/shortcut.ts';
import { composePath, resolveTmuxTmpdir, parseLoginEnv, builtinPath } from '../src/appenv.ts';

describe('accelerator parsing', () => {
  it('normalizes aliases, order and case', () => {
    expect(normalizeAccelerator('cmd+shift+l')).toBe('Command+Shift+L');
    expect(normalizeAccelerator('Shift+Option+Command+k')).toBe('Command+Alt+Shift+K');
    expect(normalizeAccelerator('CommandOrControl+,')).toBe('Command+,');
    expect(parseAccelerator('Ctrl+Esc')).toEqual({ mods: ['Control'], key: 'Escape' });
  });
  it('rejects non-accelerators', () => {
    expect(normalizeAccelerator('')).toBeNull();
    expect(normalizeAccelerator('Command+')).toBeNull();
    expect(normalizeAccelerator('Command+Shift')).toBeNull();
    expect(normalizeAccelerator('Banana+L')).toBeNull();
  });
});

describe('recorder', () => {
  it('builds an accelerator from a keydown', () => {
    expect(acceleratorFromEvent({ key: 'L', code: 'KeyL', metaKey: true, shiftKey: true })).toBe('Command+Shift+L');
    expect(acceleratorFromEvent({ key: '¬', code: 'KeyL', metaKey: true, altKey: true })).toBe('Command+Alt+L');
    expect(acceleratorFromEvent({ key: 'ArrowUp', metaKey: true, altKey: true })).toBe('Command+Alt+Up');
    expect(acceleratorFromEvent({ key: ' ', metaKey: true })).toBe('Command+Space');
    expect(acceleratorFromEvent({ key: 'F5' })).toBe('F5');
  });
  it('waits for a real key and a modifier', () => {
    expect(acceleratorFromEvent({ key: 'Meta', metaKey: true })).toBeNull();
    expect(acceleratorFromEvent({ key: 'Shift', shiftKey: true })).toBeNull();
    expect(acceleratorFromEvent({ key: 'l', code: 'KeyL' })).toBeNull();
  });
});

describe('conflict table', () => {
  it('refuses macOS reserved shortcuts', () => {
    for (const a of ['Command+Space', 'Command+Tab', 'Command+Q']) expect(classifyAccelerator(a)).toMatchObject({ level: 'refuse', code: 'macos_reserved' });
  });
  it('warns, but allows, Slack desktop shortcuts', () => {
    for (const a of ['Command+K', 'Command+Shift+K', 'Command+Shift+A', 'Command+Shift+M', 'Command+Shift+T', 'Command+Shift+U']) {
      expect(classifyAccelerator(a)).toMatchObject({ level: 'warn', code: 'slack_desktop' });
    }
  });
  it('passes the default and refuses a bare key', () => {
    expect(classifyAccelerator('Command+Shift+L')).toMatchObject({ level: 'ok' });
    expect(classifyAccelerator('L')).toMatchObject({ level: 'refuse', code: 'no_modifier' });
    expect(classifyAccelerator('nope')).toMatchObject({ level: 'refuse', code: 'invalid' });
  });
  it('a failed register means taken; the static refusals win first', () => {
    setShortcutHost({ tryRegister: (a) => a !== 'Command+Shift+J' });
    expect(checkShortcut('Command+Shift+J')).toMatchObject({ level: 'refuse', code: 'taken' });
    expect(checkShortcut('Command+Shift+L')).toMatchObject({ level: 'ok' });
    expect(checkShortcut('Command+Space')).toMatchObject({ code: 'macos_reserved' });
    setShortcutHost(null);
  });
});

describe('practice mode', () => {
  it('arms, captures one press, then disarms', () => {
    let t = 1000;
    const p = new Practice(() => t);
    expect(p.get().state).toBe('idle');
    expect(p.complete({ ok: true })).toBe(false);
    p.arm();
    expect(p.armed()).toBe(true);
    expect(p.complete({ ok: true, wouldDo: 'jump', channel: 'C1' })).toBe(true);
    expect(p.armed()).toBe(false);
    expect(p.get()).toEqual({ state: 'done', result: { ok: true, wouldDo: 'jump', channel: 'C1' } });
    expect(p.complete({ ok: true })).toBe(false);
  });
  it('times out after 60 s', () => {
    let t = 0;
    const p = new Practice(() => t);
    p.arm();
    t = PRACTICE_TIMEOUT_MS - 1;
    expect(p.armed()).toBe(true);
    t = PRACTICE_TIMEOUT_MS + 1;
    expect(p.armed()).toBe(false);
    expect(p.get().state).toBe('timeout');
  });
  it('cancel returns to idle', () => {
    const p = new Practice(() => 0);
    p.arm();
    p.cancel();
    expect(p.get().state).toBe('idle');
  });
});

describe('shortcut routes', () => {
  it('every route is a browser write or a read GET', () => {
    for (const r of routes) {
      if (r.method === 'GET') expect(r.kind).toBe('read');
      else expect(r.kind).toBe('browser');
    }
    expect(routes.length).toBeGreaterThan(0);
  });
});

describe('PATH composition', () => {
  it('orders extra_path, built-ins, login PATH, current; dedupes', () => {
    const p = composePath({ home: '/h', extra: ['/opt/mine', '/usr/bin'], loginPath: '/nix/bin:/usr/bin:/bin', current: '/usr/bin:/cur' }).split(':');
    expect(p.slice(0, 2)).toEqual(['/opt/mine', '/usr/bin']);
    expect(p.indexOf('/h/.local/bin')).toBeGreaterThan(1);
    expect(p.indexOf('/nix/bin')).toBeGreaterThan(p.indexOf('/sbin'));
    expect(p[p.length - 1]).toBe('/cur');
    expect(new Set(p).size).toBe(p.length);
  });
  it('works with nothing configured', () => {
    expect(composePath({ home: '/h' })).toBe(builtinPath('/h').join(':'));
  });
});

describe('tmux tmpdir', () => {
  it('a concrete setting wins; auto falls back login, then process, then /tmp', () => {
    expect(resolveTmuxTmpdir('/var/t', '/login', '/cur')).toBe('/var/t');
    expect(resolveTmuxTmpdir('auto', '/login', '/cur')).toBe('/login');
    expect(resolveTmuxTmpdir('auto', '', '/cur')).toBe('/cur');
    expect(resolveTmuxTmpdir('auto', undefined, '')).toBe('/tmp');
  });
  it('parses the login shell answer', () => {
    expect(parseLoginEnv('/a:/b\n/tmp/x')).toEqual({ path: '/a:/b', tmuxTmpdir: '/tmp/x' });
    expect(parseLoginEnv('/a:/b\n')).toEqual({ path: '/a:/b', tmuxTmpdir: '' });
  });
});

import { shouldAutostartOrchestrator } from '../src/appenv.ts';
describe('orchestrator autostart', () => {
  it('needs the orchestrator on and autostart true', () => {
    expect(shouldAutostartOrchestrator(true, true)).toBe(true);
    expect(shouldAutostartOrchestrator(true, false)).toBe(false);
    expect(shouldAutostartOrchestrator(false, true)).toBe(false);
    expect(shouldAutostartOrchestrator(false, false)).toBe(false);
  });
});
