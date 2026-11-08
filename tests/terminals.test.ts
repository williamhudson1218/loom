import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createTerminalSession, isChatSession, sanitizeTermName, terminalsFrom, uniqueTermSession, type WindowRow } from '../src/terminals.ts';
import { laneTargets, parseLane, type LanePane } from '../src/compact.ts';
import { tmux } from '../src/tmux.ts';
import { SESSION_PREFIX } from '../src/paths.ts';

const win = (session: string, index: string, extra: Partial<WindowRow> = {}): WindowRow => ({ session, index, name: 'zsh', panes: 1, active: index === '1', ...extra });
const pane = (tmux_session: string, window_index: string, agent: boolean) => ({ tmux_session, window_index, agent });

describe('terminals list', () => {
  it('keeps windows with no chat and drops views, the managed session, lanes and chat windows', () => {
    const windows = [
      win('loom-tp-terminals', '1', { name: 'client-app', panes: 3 }),
      win('loom-tp-terminals', '2', { name: 'admin-app' }),
      win('work', '1'),
      win('loom-view-1a2b3c', '1'),
      win('loom-managed', '1'),
      win('loom-tp-2', '1'),
      win('loom-bugs', '1'),
      win('loom-bugs', '2'),
    ];
    const panes = [pane('loom-bugs', '1', true), pane('loom-bugs', '2', false), pane('loom-tp-terminals', '1', false)];
    expect(terminalsFrom(windows, panes)).toEqual([
      { session: 'loom-tp-terminals', windows: [{ index: '1', name: 'client-app', panes: 3, active: true }, { index: '2', name: 'admin-app', panes: 1, active: false }] },
      { session: 'work', windows: [{ index: '1', name: 'zsh', panes: 1, active: true }] },
      { session: 'loom-bugs', windows: [{ index: '2', name: 'zsh', panes: 1, active: false }] },
    ]);
  });

  it('drops the orchestrator\'s window (a pane with @loom_role) even while its agent is down', () => {
    const windows = [win('orch-home', '1'), win('orch-home', '2')];
    expect(terminalsFrom(windows, [], new Set(['orch-home:1']))).toEqual([
      { session: 'orch-home', windows: [{ index: '2', name: 'zsh', panes: 1, active: false }] },
    ]);
  });

  it('treats only views, loom-managed and lane sessions as chat sessions', () => {
    expect(isChatSession('loom-view-abc')).toBe(true);
    expect(isChatSession('loom-managed')).toBe(true);
    expect(isChatSession('loom-tp-forms-8')).toBe(true);
    expect(isChatSession('loom-tp-terminals')).toBe(false);
    expect(isChatSession('loom-term-api')).toBe(false);
  });
});

describe('crash recovery covers terminal sessions', () => {
  it('a loom-<name> terminal passes the snapshot prefix gate', () => {
    expect(uniqueTermSession('api', new Set()).startsWith(SESSION_PREFIX)).toBe(true);
  });
});

describe('new terminal session names', () => {
  it('sanitizes to a tmux-safe, lane-safe name', () => {
    expect(sanitizeTermName('API server')).toBe('api-server');
    expect(sanitizeTermName('loom-Web.App:3')).toBe('web-app3');
    expect(sanitizeTermName('  ../../x  ')).toBe('x');
    expect(sanitizeTermName('')).toBe('term');
    expect(sanitizeTermName('!!!')).toBe('term');
    expect(sanitizeTermName('api-2')).toBe('api2');
    expect(sanitizeTermName('a'.repeat(80))).toHaveLength(40);
  });

  it('is unique, and never shaped like a lane', () => {
    expect(uniqueTermSession('api', new Set())).toBe('loom-api');
    expect(uniqueTermSession('api', new Set(['loom-api']))).toBe('loom-api-b');
    expect(uniqueTermSession('api', new Set(['loom-api', 'loom-api-b']))).toBe('loom-api-c');
    const all = new Set(['loom-api', ...'bcdefghijklmnopqrstuvwxyz'.split('').map((c) => `loom-api-${c}`)]);
    expect(uniqueTermSession('api', all)).toBe('loom-api-x2');
    for (const n of ['loom-api', 'loom-api-b', 'loom-api-x2', 'loom-term-api', uniqueTermSession('tp-9', new Set())]) {
      expect(parseLane(n)).toBeNull();
    }
  });

  it('a terminal session is not a lane target for compaction or new chats', () => {
    const p = (id: string, s: string): LanePane => ({ pane_id: id, tmux_session: s, window_index: '1', pane_index: '0', command: 'zsh', name: '', group: '', agent: false });
    expect(laneTargets({ panes: [p('%1', 'loom-term-api'), p('%2', 'loom-api-b')], focused: null })).toEqual([]);
  });
});

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasTmux)('creating a terminal session (throwaway tmux server)', () => {
  const SOCKET = `loom-test-${process.pid}-${randomBytes(3).toString('hex')}`;
  const saved = { socket: process.env.LOOM_TMUX_SOCKET, config: process.env.LOOM_TMUX_CONFIG };
  const t = (a: string[]) => tmux(a);
  let dir = '';
  beforeAll(() => {
    process.env.LOOM_TMUX_SOCKET = SOCKET;
    process.env.LOOM_TMUX_CONFIG = path.join(__dirname, 'fixtures', 'tmux-test.conf'); // login shells off, see the file
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-term-dir-')));
  });
  afterAll(() => {
    let sock = '';
    try {
      sock = t(['display-message', '-p', '#{socket_path}']).trim();
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* gone */
    }
    if (sock.includes(SOCKET)) fs.rmSync(sock, { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
    if (saved.socket === undefined) delete process.env.LOOM_TMUX_SOCKET;
    else process.env.LOOM_TMUX_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.LOOM_TMUX_CONFIG;
    else process.env.LOOM_TMUX_CONFIG = saved.config;
  });

  it('creates loom-<name> in the project dir, then a unique second one', () => {
    const a = createTerminalSession('API', dir, t);
    expect(a).toMatchObject({ ok: true, session: 'loom-api' });
    expect(t(['display-message', '-p', '-t', '=loom-api:', '#{pane_current_path}']).trim()).toBe(dir);
    expect(createTerminalSession('api', dir, t)).toMatchObject({ ok: true, session: 'loom-api-b' });
  });

  it('refuses a directory that does not exist', () => {
    expect(createTerminalSession('x', '/no/such/dir', t)).toMatchObject({ ok: false });
  });
});
