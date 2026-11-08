import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import {
  TERM_PATH,
  allowedOrigins,
  attachArgs,
  attachTerminalBridge,
  checkUpgrade,
  closeView,
  isLoomHost,
  loadNodePty,
  openView,
  reapViews,
  tokenMatches,
  chooseMode,
  hexKeys,
  paneState,
  snapshotPane,
  startMirror,
  checkTermAuth,
  isTermAction,
  actionAllowed,
  syncZoomMarks,
  openWindowView,
  termCommand,
  noteView,
  noteZoomOpen,
  reassertZoom,
  REASSERT_GRACE_MS,
} from '../src/ptybridge.ts';
import { tmux } from '../src/tmux.ts';
import { listTmuxPanes } from '../src/placements.ts';
import { renderDashboard } from '../src/dashboard.ts';
import { createServer } from '../src/server.ts';
import { termToken } from '../src/ptybridge.ts';

const TOKEN = 'a'.repeat(43);
const PORT = 4317;
const req = (url: string, headers: http.IncomingHttpHeaders = {}) => ({
  url,
  headers: { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, ...headers },
});
const good = `${TERM_PATH}?pane=%25${12}&token=${TOKEN}&cols=90&rows=20`;

describe('terminal upgrade checks', () => {
  it('accepts Loom\'s own page with the launch token and a pane id', () => {
    expect(checkUpgrade(req(good), { port: PORT, token: TOKEN })).toEqual({ ok: true, paneId: '%12', cols: 90, rows: 20 });
    expect(checkUpgrade(req(good, { host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}` }), { port: PORT, token: TOKEN }).ok).toBe(true);
  });

  it('refuses a missing or foreign Origin', () => {
    const r = (origin: string | undefined) => checkUpgrade(req(good, { origin }), { port: PORT, token: TOKEN });
    expect(r(undefined)).toMatchObject({ ok: false, status: 403, reason: 'bad origin' });
    expect(r('https://evil.example')).toMatchObject({ ok: false, status: 403 });
    expect(r(`http://localhost:${PORT + 1}`)).toMatchObject({ ok: false, status: 403 });
    expect(r('null')).toMatchObject({ ok: false, status: 403 });
  });

  it('refuses a rebinding Host even with a matching Origin', () => {
    const r = checkUpgrade(req(good, { host: `evil.example:${PORT}`, origin: `http://evil.example:${PORT}` }), { port: PORT, token: TOKEN });
    expect(r).toMatchObject({ ok: false, status: 403, reason: 'bad host' });
  });

  it('refuses a missing or wrong token', () => {
    expect(checkUpgrade(req(`${TERM_PATH}?pane=%2512`), { port: PORT, token: TOKEN })).toMatchObject({ ok: false, reason: 'bad token' });
    expect(checkUpgrade(req(`${TERM_PATH}?pane=%2512&token=${'b'.repeat(43)}`), { port: PORT, token: TOKEN })).toMatchObject({ ok: false, reason: 'bad token' });
    expect(checkUpgrade(req(`${TERM_PATH}?pane=%2512&token=short`), { port: PORT, token: TOKEN })).toMatchObject({ ok: false, reason: 'bad token' });
    // An unset server token never matches, not even an empty one.
    expect(tokenMatches('', '')).toBe(false);
  });

  it('refuses anything that is not a tmux pane id, and other paths', () => {
    for (const pane of ['', '12', '%12;kill-server', 'loom-a:1.0', '%']) {
      const u = `${TERM_PATH}?pane=${encodeURIComponent(pane)}&token=${TOKEN}`;
      expect(checkUpgrade(req(u), { port: PORT, token: TOKEN })).toMatchObject({ ok: false, status: 400 });
    }
    expect(checkUpgrade(req(`/api/live?token=${TOKEN}`), { port: PORT, token: TOKEN })).toMatchObject({ ok: false, status: 404 });
  });

  it('accepts a whole-window target and refuses malformed or view ones', () => {
    const u = (q: string) => checkUpgrade(req(`${TERM_PATH}?${q}&token=${TOKEN}`), { port: PORT, token: TOKEN });
    expect(u('session=loom-tp-terminals&window=2')).toEqual({ ok: true, paneId: '', cols: 120, rows: 32, window: { session: 'loom-tp-terminals', index: '2' } });
    expect(u('session=loom-a;kill-server&window=1')).toMatchObject({ ok: false, status: 400 });
    expect(u('session=loom-view-abc&window=1')).toMatchObject({ ok: false, status: 400 });
    expect(u('session=loom-a&window=1.0')).toMatchObject({ ok: false, status: 400 });
    expect(checkUpgrade(req(`${TERM_PATH}?session=loom-a&window=1`), { port: PORT, token: TOKEN })).toMatchObject({ ok: false, status: 403 });
  });

  it('the toolbar POST uses the same Host / Origin / token checks', () => {
    const h = (extra: http.IncomingHttpHeaders = {}) => ({ host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, ...extra });
    expect(checkTermAuth(h(), TOKEN, { port: PORT, token: TOKEN })).toEqual({ ok: true });
    expect(checkTermAuth(h(), 'nope', { port: PORT, token: TOKEN })).toMatchObject({ ok: false, status: 403 });
    expect(checkTermAuth(h({ origin: 'https://evil.example' }), TOKEN, { port: PORT, token: TOKEN })).toMatchObject({ ok: false, status: 403 });
    expect(checkTermAuth(h({ origin: undefined }), TOKEN, { port: PORT, token: TOKEN })).toMatchObject({ ok: false, status: 403 });
    expect(checkTermAuth(h({ host: 'evil.example' }), TOKEN, { port: PORT, token: TOKEN })).toMatchObject({ ok: false, status: 403 });
  });

  it('a chat view may only toggle zoom; a terminal window gets every verb', () => {
    expect(actionAllowed('chat', 'zoom')).toBe(true);
    for (const a of ['split-right', 'split-down', 'next-pane', 'close-pane'] as const) {
      expect(actionAllowed('chat', a)).toBe(false);
      expect(actionAllowed('window', a)).toBe(true);
    }
  });

  it('whitelists the toolbar verbs', () => {
    for (const a of ['split-right', 'split-down', 'zoom', 'next-pane', 'close-pane']) expect(isTermAction(a)).toBe(true);
    for (const a of ['kill-server', 'send-keys', 'run-shell', '', null, 3]) expect(isTermAction(a)).toBe(false);
  });

  it('clamps nonsense sizes to defaults', () => {
    const r = checkUpgrade(req(`${TERM_PATH}?pane=%251&token=${TOKEN}&cols=-3&rows=99999`), { port: PORT, token: TOKEN });
    expect(r).toMatchObject({ ok: true, cols: 120, rows: 32 });
  });

  it('knows its own hosts and origins', () => {
    expect(allowedOrigins(PORT)).toEqual([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);
    expect(isLoomHost(`localhost:${PORT}`, PORT)).toBe(true);
    expect(isLoomHost('localhost', PORT)).toBe(false);
    expect(isLoomHost(undefined, PORT)).toBe(false);
  });
});

describe('the token reaches only the live page', () => {
  it('is absent from a dashboard rendered without one (the dashboard.html on disk)', () => {
    expect(renderDashboard([], 0)).toContain('const TERM_TOKEN = "";');
    expect(renderDashboard([], 0, {}, 'claude', [], [], 'sekret-token')).toContain('const TERM_TOKEN = "sekret-token";');
  });
});

/* ------------------------------------------------- against a real tmux server */

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
})();

// A throwaway server: the runner reads $LOOM_TMUX_SOCKET on every call, so all
// of Loom's tmux code in this file talks to it, never to a real workspace.
// tests/fixtures/tmux-test.conf, so ~/.tmux.conf is not loaded and panes run /bin/sh,
// not a login zsh that can hang on a closed pty (see that file). Only this
// server is ever killed.
const SOCKET = `loom-test-${process.pid}-${randomBytes(3).toString('hex')}`;
const t = (args: string[]) => tmux(args);
const sessions = () => t(['list-sessions', '-F', '#{session_name}']).split('\n').filter(Boolean).sort();
const until = async (ok: () => boolean, ms = 4000) => {
  const end = Date.now() + ms;
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  return ok();
};
const current = (s: string) => t(['display-message', '-p', '-t', s, '#{window_index}']).trim();

describe.skipIf(!hasTmux)('grouped view sessions (throwaway tmux server)', () => {
  const saved = { socket: process.env.LOOM_TMUX_SOCKET, config: process.env.LOOM_TMUX_CONFIG };
  let paneA = '';
  let paneB = '';

  beforeAll(() => {
    process.env.LOOM_TMUX_SOCKET = SOCKET;
    process.env.LOOM_TMUX_CONFIG = path.join(__dirname, 'fixtures', 'tmux-test.conf'); // login shells off, see the file
    t(['new-session', '-d', '-s', 'loom-a', '-x', '100', '-y', '30', 'cat']);
    t(['new-window', '-t', 'loom-a', 'cat']);
    t(['select-window', '-t', 'loom-a:0']);
    const panes = t(['list-panes', '-s', '-t', 'loom-a', '-F', '#{pane_id}']).split('\n').filter(Boolean);
    [paneA, paneB] = panes;
  });

  afterAll(() => {
    let socketPath = '';
    try {
      socketPath = t(['display-message', '-p', '#{socket_path}']).trim();
      execFileSync('tmux', ['-L', SOCKET, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* already gone */
    }
    // kill-server leaves the socket file behind.
    if (socketPath.includes(SOCKET)) fs.rmSync(socketPath, { force: true });
    if (saved.socket === undefined) delete process.env.LOOM_TMUX_SOCKET;
    else process.env.LOOM_TMUX_SOCKET = saved.socket;
    if (saved.config === undefined) delete process.env.LOOM_TMUX_CONFIG;
    else process.env.LOOM_TMUX_CONFIG = saved.config;
  });

  it('Loom\'s pane readers do not see a view\'s duplicate panes', () => {
    const v = openView(paneA, listTmuxPanes(), t, 'loom-view-dup');
    try {
      // tmux itself lists every pane twice now…
      expect(t(['list-panes', '-a', '-F', '#{session_name}']).split('\n').filter(Boolean)).toContain('loom-view-dup');
      // …but Loom's reader reports each pane once, under the chat's own session.
      const mine = listTmuxPanes();
      expect(mine.map((p) => p.tmux_session)).toEqual(['loom-a', 'loom-a']);
    } finally {
      closeView(v, t);
    }
  });

  it('two views on one chat session keep their own windows, and leave the chat\'s alone', () => {
    const panes = listTmuxPanes();
    const v1 = openView(paneA, panes, t, 'loom-view-one');
    const v2 = openView(paneB, panes, t, 'loom-view-two');
    expect(current(v1)).toBe('0');
    expect(current(v2)).toBe('1');
    expect(current('loom-a')).toBe('0'); // the chat's own session did not move
    closeView(v1, t);
    expect(current(v2)).toBe('1');
    closeView(v2, t);
    expect(sessions()).toEqual(['loom-a']);
  });

  it('refuses a pane that is not live', () => {
    expect(() => openView('%9999', listTmuxPanes(), t)).toThrow(/no live pane/);
    expect(sessions()).toEqual(['loom-a']);
  });

  it('closeView never kills a non-view session; reapViews kills only unattached views', () => {
    closeView('loom-a', t);
    expect(sessions()).toEqual(['loom-a']);
    openView(paneA, listTmuxPanes(), t, 'loom-view-stale');
    expect(sessions()).toEqual(['loom-a', 'loom-view-stale']);
    expect(reapViews(t)).toBe(1);
    expect(sessions()).toEqual(['loom-a']);
  });

  it('the attach argv targets the view on the configured socket, as a UTF-8 client', () => {
    expect(attachArgs('loom-view-x')).toEqual([
      '-u', '-T', 'hyperlinks', '-L', SOCKET, 'attach-session', '-t', '=loom-view-x', ';', 'set-option', '-t', '=loom-view-x:', 'destroy-unattached', 'on',
    ]);
  });

  describe('zoom bookkeeping', () => {
    let pz = '';
    let other = '';
    const zoomed = () => t(['display-message', '-p', '-t', pz, '#{window_zoomed_flag}']).trim() === '1';
    const mark = () => t(['display-message', '-p', '-t', pz, '#{@loom_zoomed}']).trim();
    beforeAll(() => {
      t(['new-session', '-d', '-s', 'loom-z', '-x', '100', '-y', '30', 'cat']);
      t(['split-window', '-h', '-t', 'loom-z', 'cat']);
      [pz, other] = t(['list-panes', '-t', 'loom-z', '-F', '#{pane_id}']).split('\n').filter(Boolean);
    });
    afterAll(() => {
      t(['kill-session', '-t', 'loom-z']);
    });
    const panesNow = () => listTmuxPanes();

    it('zooms only a window that is not zoomed, and unzooms only its own zoom', () => {
      const v = openView(pz, panesNow(), t, 'loom-view-z1', { zoom: true });
      expect(zoomed()).toBe(true);
      expect(mark()).toBe('loom-view-z1');
      closeView(v, t);
      expect(zoomed()).toBe(false);
      expect(mark()).toBe('');
    });

    it('leaves a zoom it did not make', () => {
      t(['resize-pane', '-Z', '-t', pz]); // the user zoomed it
      const v = openView(pz, panesNow(), t, 'loom-view-z2', { zoom: true });
      expect(mark()).toBe('');
      closeView(v, t);
      expect(zoomed()).toBe(true);
      t(['resize-pane', '-Z', '-t', pz]);
      expect(zoomed()).toBe(false);
    });

    it('does not unzoom when the window is now zoomed on another pane', () => {
      const v = openView(pz, panesNow(), t, 'loom-view-z3', { zoom: true });
      t(['resize-pane', '-Z', '-t', pz]); // user unzooms…
      t(['select-pane', '-t', other]);
      t(['resize-pane', '-Z', '-t', other]); // …and zooms the other pane
      closeView(v, t);
      expect(t(['display-message', '-p', '-t', other, '#{window_zoomed_flag} #{pane_active}']).trim()).toBe('1 1');
      expect(mark()).toBe('');
      t(['resize-pane', '-Z', '-t', other]);
      t(['select-pane', '-t', pz]);
    });

    it('hands its zoom to another view still showing the window', () => {
      const v1 = openView(pz, panesNow(), t, 'loom-view-z4', { zoom: true });
      const v2 = openView(pz, panesNow(), t, 'loom-view-z5', { zoom: true });
      expect(mark()).toBe('loom-view-z4');
      closeView(v1, t);
      expect(zoomed()).toBe(true);
      expect(mark()).toBe('loom-view-z5');
      closeView(v2, t);
      expect(zoomed()).toBe(false);
      expect(mark()).toBe('');
    });

    const state = () => t(['list-panes', '-t', 'loom-z', '-F', '#{pane_id}:#{pane_active}:#{window_zoomed_flag}:#{@loom_zoomed}']).split('\n').filter(Boolean).join(' ');
    it('switching chat A to B in one window shows B alone, then closing A leaves B zoomed', () => {
      const va = openView(pz, panesNow(), t, 'loom-view-s1', { zoom: true });
      const vb = openView(other, panesNow(), t, 'loom-view-s2', { zoom: true });
      expect(t(['display-message', '-p', '-t', other, '#{window_zoomed_flag} #{pane_active}']).trim()).toBe('1 1');
      closeView(va, t);
      syncZoomMarks(t);
      expect(t(['display-message', '-p', '-t', other, '#{window_zoomed_flag} #{pane_active}']).trim()).toBe('1 1');
      expect(t(['display-message', '-p', '-t', pz, '#{@loom_zoomed}']).trim()).toBe('');
      closeView(vb, t);
      expect(t(['display-message', '-p', '-t', other, '#{window_zoomed_flag}']).trim()).toBe('0');
      t(['select-pane', '-t', pz]);
    });
    it('reopening after a view was left behind shows the pane alone and leaves nothing zoomed at the end', () => {
      const va = openView(pz, panesNow(), t, 'loom-view-s3', { zoom: true });
      const vb = openView(other, panesNow(), t, 'loom-view-s4', { zoom: true });
      closeView(vb, t);
      const vc = openView(other, panesNow(), t, 'loom-view-s5', { zoom: true });
      expect(t(['display-message', '-p', '-t', other, '#{window_zoomed_flag} #{pane_active}']).trim()).toBe('1 1');
      closeView(vc, t);
      closeView(va, t);
      expect(t(['display-message', '-p', '-t', other, '#{window_zoomed_flag}']).trim()).toBe('0');
      t(['select-pane', '-t', pz]);
    });
    it('puts the pane back alone when a jump to another pane unzoomed it just after open; never against Show window or a newer view', () => {
      const va = openView(pz, panesNow(), t, 'loom-view-r1', { zoom: true });
      noteZoomOpen(va, pz, t, 1000);
      t(['select-pane', '-t', other]); // something else jumps to the sibling pane: unzooms
      expect(t(['display-message', '-p', '-t', pz, '#{window_zoomed_flag}']).trim()).toBe('0');
      expect(reassertZoom(va, t, 1000 + REASSERT_GRACE_MS + 1)).toBe(false); // past the grace period
      expect(reassertZoom(va, t, 2000)).toBe(true);
      expect(t(['display-message', '-p', '-t', pz, '#{window_zoomed_flag} #{pane_active} #{@loom_zoomed}']).trim()).toBe('1 1 loom-view-r1');
      expect(reassertZoom(va, t, 2100)).toBe(false); // already right: nothing to do
      // a newer view in the same window owns it
      const vb = openView(other, panesNow(), t, 'loom-view-r2', { zoom: true });
      noteZoomOpen(vb, other, t, 3000);
      t(['select-pane', '-t', pz]);
      expect(reassertZoom(va, t, 3100)).toBe(false);
      closeView(vb, t);
      closeView(va, t);
      // Show window is a choice, not damage
      const vc = openView(pz, panesNow(), t, 'loom-view-r3', { zoom: true });
      noteZoomOpen(vc, pz, t, 4000);
      termCommand(vc, 'zoom', t, undefined, 'chat');
      expect(reassertZoom(vc, t, 4100)).toBe(false);
      closeView(vc, t);
      if (t(['display-message', '-p', '-t', pz, '#{window_zoomed_flag}']).trim() === '1') t(['resize-pane', '-Z', '-t', pz]);
    });
    it('startup reaping undoes a zoom left by a view that died', () => {
      openView(pz, panesNow(), t, 'loom-view-z6', { zoom: true });
      t(['kill-session', '-t', 'loom-view-z6']); // Loom died; destroy-unattached removed the view
      expect(zoomed()).toBe(true);
      expect(mark()).toBe('loom-view-z6');
      reapViews(t);
      expect(zoomed()).toBe(false);
      expect(mark()).toBe('');
    });

    it('a chat view refuses split / next / close, and changes nothing', () => {
      const v = openView(pz, panesNow(), t, 'loom-view-z7', { zoom: true });
      const layout = () => t(['display-message', '-p', '-t', pz, '#{window_layout} #{window_zoomed_flag}']).trim();
      const before = layout();
      for (const a of ['split-right', 'split-down', 'next-pane', 'close-pane'] as const) {
        expect(termCommand(v, a, t, () => false, 'chat')).toMatchObject({ ok: false });
      }
      expect(layout()).toBe(before);
      expect(mark()).toBe('loom-view-z7');
      closeView(v, t);
    });

    it('Show window / Show chat: unzoom leaves no mark, re-zoom is Loom\'s to undo', () => {
      const v = openView(pz, panesNow(), t, 'loom-view-z8', { zoom: true });
      expect(termCommand(v, 'zoom', t, () => false, 'chat')).toEqual({ ok: true, zoomed: false }); // Show window
      expect(mark()).toBe('');
      expect(termCommand(v, 'zoom', t, () => false, 'chat')).toEqual({ ok: true, zoomed: true }); // Show chat
      expect(mark()).toBe('loom-view-z8');
      closeView(v, t);
      expect(zoomed()).toBe(false);
      expect(mark()).toBe('');
    });

    it('when the user unzooms (C-a z), the mark is cleared and nothing is re-zoomed', () => {
      const v = openView(pz, panesNow(), t, 'loom-view-z9', { zoom: true });
      t(['resize-pane', '-Z', '-t', pz]); // the user's own C-a z
      expect(syncZoomMarks(t)).toBe(1);
      expect(mark()).toBe('');
      expect(zoomed()).toBe(false);
      t(['resize-pane', '-Z', '-t', pz]); // they zoom it again themselves…
      closeView(v, t);
      expect(zoomed()).toBe(true); // …and that zoom is theirs, so close leaves it
      t(['resize-pane', '-Z', '-t', pz]);
    });

    it('clears a stale mark from a dead view on an unzoomed window, without zooming it', () => {
      t(['set-option', '-p', '-t', pz, '@loom_zoomed', 'loom-view-84c1fa0418']); // what Will's %16 carried
      expect(zoomed()).toBe(false);
      expect(syncZoomMarks(t)).toBe(1);
      expect(mark()).toBe('');
      expect(zoomed()).toBe(false);
      expect(syncZoomMarks(t)).toBe(0);
    });
  });

  describe('window views and toolbar verbs', () => {
    beforeAll(() => {
      t(['new-session', '-d', '-s', 'loom-w', '-x', '100', '-y', '30', 'cat']);
      t(['new-window', '-t', 'loom-w', 'cat']);
    });
    afterAll(() => {
      try {
        t(['kill-session', '-t', 'loom-w']);
      } catch {
        /* closed by a test */
      }
    });
    const panesOf = (s: string) => t(['list-panes', '-t', `=${s}:`, '-F', '#{pane_id}']).split('\n').filter(Boolean);

    it('opens a whole window with the status bar off and nothing zoomed, and refuses a non-terminal', () => {
      const v = openWindowView('loom-w', '1', t, 'loom-view-w1', () => true);
      expect(current(v)).toBe('1');
      expect(t(['show-options', '-v', '-t', v, 'status']).trim()).toBe('off');
      expect(t(['display-message', '-p', '-t', `=${v}:`, '#{window_zoomed_flag}']).trim()).toBe('0');
      closeView(v, t);
      expect(() => openWindowView('loom-w', '1', t, 'loom-view-w2', () => false)).toThrow(/no terminal window/);
      expect(sessions()).not.toContain('loom-view-w2');
    });

    it('splits, zooms, cycles and closes the view\'s current pane, and never kills a chat', () => {
      const v = openWindowView('loom-w', '0', t, 'loom-view-w3', () => true);
      const count = () => panesOf(v).length;
      expect(count()).toBe(1);
      expect(termCommand(v, 'split-right', t)).toMatchObject({ ok: true });
      expect(termCommand(v, 'split-down', t)).toMatchObject({ ok: true });
      expect(count()).toBe(3);
      const active = () => t(['display-message', '-p', '-t', `=${v}:.`, '#{pane_id}']).trim();
      const before = active();
      expect(termCommand(v, 'next-pane', t)).toMatchObject({ ok: true });
      expect(active()).not.toBe(before);
      expect(termCommand(v, 'zoom', t)).toMatchObject({ ok: true });
      expect(t(['display-message', '-p', '-t', `=${v}:`, '#{window_zoomed_flag}']).trim()).toBe('1');
      expect(termCommand(v, 'zoom', t)).toMatchObject({ ok: true });
      expect(termCommand(v, 'close-pane', t, () => true)).toMatchObject({ ok: false, detail: expect.stringMatching(/running a chat/) });
      expect(count()).toBe(3);
      expect(termCommand(v, 'close-pane', t, () => false)).toMatchObject({ ok: true });
      expect(count()).toBe(2);
      expect(termCommand('loom-w', 'zoom', t)).toMatchObject({ ok: false }); // only ever a view
      closeView(v, t);
    });
  });

  const spawn = loadNodePty();

  describe.skipIf(!spawn)('the WebSocket bridge, end to end (node-pty)', () => {
    let server: http.Server;
    let stop: () => void;
    let port = 0;
    const token = randomBytes(32).toString('base64url');
    let laneView: 'zoom' | 'mirror' = 'mirror';

    beforeAll(async () => {
      server = createServer();
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      port = (server.address() as { port: number }).port;
      stop = attachTerminalBridge(server, { port, token, spawn, log: () => {}, laneView: () => laneView });
    });

    afterAll(async () => {
      stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    const connect = (q: string, origin = `http://localhost:${port}`) =>
      new WebSocket(`ws://localhost:${port}${TERM_PATH}?${q}`, { origin });

    const page = (host: string) =>
      new Promise<string>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/', headers: { host } }, (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve(body));
        }).on('error', reject);
      });

    it('writes the launch token only into a page served under Loom\'s own host name', async () => {
      // createServer checks Host against Loom's real port (4317), whatever port
      // this test server is bound to.
      expect(await page('localhost:4317')).toContain(`const TERM_TOKEN = "${termToken()}";`);
      // A rebinding host gets no page at all now: the route gate refuses any
      // request whose Host is not Loom's (src/routes/index.ts).
      expect(await page('evil.example:4317')).toBe('{"ok":false,"detail":"bad host"}');
      expect(await page('evil.example:4317')).not.toContain(termToken());
    });

    const refusedWith = (ws: WebSocket) =>
      new Promise<number>((resolve) => {
        ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
        ws.on('open', () => resolve(101));
      });

    it('refuses an upgrade without the token, or from another origin', async () => {
      expect(await refusedWith(connect(`pane=${encodeURIComponent(paneA)}`))).toBe(403);
      expect(await refusedWith(connect(`pane=${encodeURIComponent(paneA)}&token=${token}`, 'https://evil.example'))).toBe(403);
      expect(await refusedWith(connect(`pane=%25424242&token=${token}`))).toBe(400);
      expect(sessions()).toEqual(['loom-a']); // nothing was created for any of them
    });

    it('streams the chat both ways, and closing leaves the chat running', async () => {
      const ws = connect(`pane=${encodeURIComponent(paneA)}&token=${token}&cols=100&rows=30`);
      let out = '';
      ws.on('message', (d) => {
        out += d.toString();
      });
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => resolve());
        ws.on('error', reject);
      });
      expect(await until(() => sessions().some((s) => s.startsWith('loom-view-')))).toBe(true);
      // A lone pane is attached through a view with its status bar off; the
      // chat's own session keeps its status bar.
      const view = sessions().find((s) => s.startsWith('loom-view-'))!;
      expect(t(['show-options', '-v', '-t', view, 'status']).trim()).toBe('off');
      expect(t(['show-options', '-gv', 'status']).trim()).toBe('on');
      expect(await until(() => out.length > 0)).toBe(true); // tmux drew the screen
      ws.send(JSON.stringify({ t: 'r', c: 80, r: 24 }));
      ws.send(JSON.stringify({ t: 'i', d: 'hello-loom\r' }));
      const pane = () => t(['capture-pane', '-p', '-t', paneA]);
      expect(await until(() => pane().includes('hello-loom'))).toBe(true); // typed into the real pane
      expect(await until(() => out.includes('hello-loom'))).toBe(true); // and its echo came back
      ws.close();
      expect(await until(() => sessions().length === 1)).toBe(true);
      expect(sessions()).toEqual(['loom-a']); // the view is gone, the chat is not
      expect(pane()).toContain('hello-loom');
    });

    const post = (pathName: string, body: unknown, headers: Record<string, string>) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const data = JSON.stringify(body);
        const r = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, (res) => {
          let b = '';
          res.on('data', (c) => (b += c));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(b || '{}') }));
        });
        r.on('error', reject);
        r.end(data);
      });
    // createServer checks Host/Origin against Loom's real port and the real launch token.
    const own = { host: 'localhost:4317', origin: 'http://localhost:4317', 'x-loom-term-token': termToken() };

    it('/api/term/cmd: refuses without auth, unknown verbs and views this launch did not open', async () => {
      noteView('loom-view-cmdtest', true);
      try {
        expect((await post('/api/term/cmd', { view: 'loom-view-cmdtest', action: 'zoom' }, { ...own, 'x-loom-term-token': 'x' })).status).toBe(403);
        expect((await post('/api/term/cmd', { view: 'loom-view-cmdtest', action: 'zoom' }, { ...own, origin: 'https://evil.example' })).status).toBe(403);
        expect((await post('/api/term/cmd', { view: 'loom-view-cmdtest', action: 'kill-server' }, own)).status).toBe(400);
        // noteView defaults to a chat view: only zoom is allowed
        expect((await post('/api/term/cmd', { view: 'loom-view-cmdtest', action: 'split-right' }, own)).status).toBe(403);
        expect((await post('/api/term/cmd', { view: 'loom-view-cmdtest', action: 'close-pane' }, own)).status).toBe(403);
        expect((await post('/api/term/cmd', { view: 'loom-view-other', action: 'zoom' }, own)).status).toBe(404);
        expect((await post('/api/term/cmd', { view: 'loom-a', action: 'zoom' }, own)).status).toBe(404);
      } finally {
        noteView('loom-view-cmdtest', false);
      }
    });

    it('opens a terminal window whole, drives it from the toolbar, and refuses a lane session', async () => {
      t(['new-session', '-d', '-s', 'loom-term-api', '-x', '100', '-y', '30', 'cat']);
      t(['new-session', '-d', '-s', 'loom-lane-1', 'cat']);
      try {
        const idx = t(['display-message', '-p', '-t', '=loom-term-api:', '#{window_index}']).trim();
        expect(await refusedWith(connect(`session=loom-lane-1&window=0&token=${token}`))).toBe(400);
        const ws = connect(`session=loom-term-api&window=${idx}&token=${token}&cols=90&rows=25`);
        const ctl: Array<Record<string, unknown>> = [];
        ws.on('message', (d, binary) => {
          if (!binary) ctl.push(JSON.parse(d.toString()));
        });
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => resolve());
          ws.on('error', reject);
        });
        expect(await until(() => ctl.length > 0)).toBe(true);
        expect(ctl[0]).toMatchObject({ t: 'mode', mode: 'window' });
        const view = String(ctl[0].view);
        expect(view.startsWith('loom-view-')).toBe(true);
        // The real server route drives this bridge's view (same process, same registry)…
        // but this test bridge uses its own token; the route checks the launch token.
        const r = await post('/api/term/cmd', { view, action: 'split-right' }, own);
        expect(r).toMatchObject({ status: 200, body: { ok: true } });
        expect(t(['display-message', '-p', '-t', '=loom-term-api:', '#{window_panes}']).trim()).toBe('2');
        ws.close();
        expect(await until(() => !sessions().includes(view))).toBe(true);
        expect(sessions()).toContain('loom-term-api'); // the terminal itself keeps running
      } finally {
        t(['kill-session', '-t', 'loom-term-api']);
        t(['kill-session', '-t', 'loom-lane-1']);
      }
    });

    describe('a pane that shares its window is mirrored, not attached', () => {
      let paneM = '';
      beforeAll(() => {
        t(['new-session', '-d', '-s', 'loom-b', '-x', '100', '-y', '30', 'cat']);
        t(['split-window', '-h', '-t', 'loom-b', 'cat']);
        paneM = t(['display-message', '-p', '-t', 'loom-b', '#{pane_id}']).trim();
      });
      afterAll(() => {
        t(['kill-session', '-t', 'loom-b']);
      });
      const layout = () => t(['display-message', '-p', '-t', 'loom-b', '#{window_layout} #{window_zoomed_flag}']).trim();

      it('zoom (the default lane_view) attaches a view, zooms the pane, and unzooms on close', async () => {
        laneView = 'zoom';
        try {
          const ws = connect(`pane=${encodeURIComponent(paneM)}&token=${token}&cols=90&rows=25`);
          const ctl: Array<Record<string, unknown>> = [];
          ws.on('message', (d, binary) => {
            if (!binary) ctl.push(JSON.parse(d.toString()));
          });
          await new Promise<void>((resolve, reject) => {
            ws.on('open', () => resolve());
            ws.on('error', reject);
          });
          expect(await until(() => ctl.length > 0)).toBe(true);
          expect(ctl[0]).toMatchObject({ t: 'mode', mode: 'zoom' });
          const view = sessions().find((x) => x.startsWith('loom-view-'))!;
          expect(view).toBeTruthy();
          expect(t(['display-message', '-p', '-t', paneM, '#{window_zoomed_flag}']).trim()).toBe('1');
          expect(t(['display-message', '-p', '-t', paneM, '#{@loom_zoomed}']).trim()).toBe(view);
          ws.close();
          expect(await until(() => t(['display-message', '-p', '-t', paneM, '#{window_zoomed_flag}']).trim() === '0')).toBe(true);
          expect(await until(() => !sessions().some((x) => x.startsWith('loom-view-')))).toBe(true);
          expect(t(['display-message', '-p', '-t', paneM, '#{@loom_zoomed}']).trim()).toBe('');
        } finally {
          laneView = 'mirror';
        }
      });

      it('mirrors at the pane\'s own size, both ways, and changes nothing about the window', async () => {
        const before = layout();
        const [w, h] = t(['display-message', '-p', '-t', paneM, '#{pane_width} #{pane_height}']).trim().split(' ').map(Number);
        const ws = connect(`pane=${encodeURIComponent(paneM)}&token=${token}&cols=200&rows=60`);
        const ctl: Array<Record<string, unknown>> = [];
        let out = '';
        ws.on('message', (d, binary) => {
          if (binary) out += d.toString();
          else ctl.push(JSON.parse(d.toString()));
        });
        await new Promise<void>((resolve, reject) => {
          ws.on('open', () => resolve());
          ws.on('error', reject);
        });
        expect(await until(() => ctl.length > 0)).toBe(true);
        expect(ctl[0]).toEqual({ t: 'mode', mode: 'mirror', cols: w, rows: h });
        expect(sessions()).toEqual(['loom-a', 'loom-b']); // no view session
        expect(t(['display-message', '-p', '-t', paneM, '#{pane_pipe}']).trim()).toBe('1');
        ws.send(JSON.stringify({ t: 'r', c: 40, r: 10 })); // ignored in mirror mode
        ws.send(JSON.stringify({ t: 'i', d: 'mirror-me\r' }));
        expect(await until(() => t(['capture-pane', '-p', '-t', paneM]).includes('mirror-me'))).toBe(true);
        expect(await until(() => out.includes('mirror-me'))).toBe(true); // came back through pipe-pane
        expect(layout()).toBe(before);
        ws.close();
        expect(await until(() => t(['display-message', '-p', '-t', paneM, '#{pane_pipe}']).trim() === '0')).toBe(true);
        expect(layout()).toBe(before);
      });

      it('refuses to mirror a pane that already has a pipe, and leaves that pipe alone', async () => {
        t(['pipe-pane', '-O', '-t', paneM, 'cat > /dev/null']);
        try {
          const ws = connect(`pane=${encodeURIComponent(paneM)}&token=${token}`);
          const msgs: string[] = [];
          ws.on('message', (d) => msgs.push(d.toString()));
          const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
          expect(code).toBe(4409);
          expect(JSON.parse(msgs[0])).toMatchObject({ t: 'error' });
          expect(JSON.parse(msgs[0]).message).toMatch(/already has a pipe-pane/);
          expect(t(['display-message', '-p', '-t', paneM, '#{pane_pipe}']).trim()).toBe('1');
        } finally {
          t(['pipe-pane', '-t', paneM]);
        }
      });

      it('startMirror: snapshot first, re-snapshot on resize, and cleanup on stop', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mirror-test-'));
        const sizes: string[] = [];
        let out = '';
        const m = startMirror(paneM, t, { output: (b) => (out += b.toString()), size: (c, r) => sizes.push(`${c}x${r}`), gone: () => {} }, { dir, pollMs: 50 });
        expect(fs.statSync(m.fifo).isFIFO()).toBe(true);
        expect(out.startsWith('\x1b[0m\x1b[H\x1b[2J')).toBe(true);
        t(['resize-pane', '-t', paneM, '-x', '30']);
        expect(await until(() => sizes.length === 2)).toBe(true);
        expect(sizes[1].startsWith('30x')).toBe(true);
        m.stop();
        expect(fs.existsSync(m.fifo)).toBe(false);
        expect(t(['display-message', '-p', '-t', paneM, '#{pane_pipe}']).trim()).toBe('0');
        fs.rmSync(dir, { recursive: true, force: true });
      });
    });
  });
});

describe('mode selection and input encoding', () => {
  it('attaches a lone pane, mirrors a shared window, refuses a piped shared pane', () => {
    expect(chooseMode({ windowPanes: 1, piped: false })).toEqual({ mode: 'attach' });
    expect(chooseMode({ windowPanes: 1, piped: true })).toEqual({ mode: 'attach' }); // attach does not touch pipes
    expect(chooseMode({ windowPanes: 4, piped: false })).toEqual({ mode: 'zoom' }); // default lane_view
    expect(chooseMode({ windowPanes: 4, piped: true })).toEqual({ mode: 'zoom' }); // zoom does not touch pipes
    expect(chooseMode({ windowPanes: 4, piped: false }, 'mirror')).toEqual({ mode: 'mirror' });
    expect(chooseMode({ windowPanes: 4, piped: true }, 'mirror')).toHaveProperty('refuse');
    expect(chooseMode({ windowPanes: 1, piped: false }, 'mirror')).toEqual({ mode: 'attach' });
  });

  it('reads pane state from tmux', () => {
    const fake = (args: string[]) => (args.includes('#{window_panes} #{pane_pipe}') ? '4 1\n' : '');
    expect(paneState('%3', fake)).toEqual({ windowPanes: 4, piped: true });
  });

  it('hex-encodes raw bytes: control keys, escapes, UTF-8', () => {
    expect(hexKeys('a\r')).toEqual([['61', '0d']]);
    expect(hexKeys('\x1b[A\x03')).toEqual([['1b', '5b', '41', '03']]);
    expect(hexKeys('é')).toEqual([['c3', 'a9']]);
    expect(hexKeys('abcde', 2)).toEqual([['61', '62'], ['63', '64'], ['65']]);
    expect(hexKeys('')).toEqual([]);
  });

  it('a snapshot paints the screen and puts the cursor back', () => {
    const fake = (args: string[]) =>
      args[0] === 'display-message' ? '3 1 80 24 1\n' : 'line one\nline two\n';
    const s = snapshotPane('%1', fake);
    expect(s).toMatchObject({ cols: 80, rows: 24 });
    expect(s.data).toBe('\x1b[0m\x1b[H\x1b[2J\x1b[3Jline one\r\nline two\x1b[0m\x1b[2;4H\x1b[?25h');
  });
});
