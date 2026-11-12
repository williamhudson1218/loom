import type http from 'node:http';
import type { Duplex } from 'node:stream';
import fs from 'node:fs';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { VIEW_SESSION_PREFIX, isViewSession, tmux as runTmux, tmuxArgs } from './tmux.ts';
import { pickLog } from './picklog.ts';
import { agentPaneIds, listTmuxPanes } from './placements.ts';
import { isTerminalWindow } from './terminals.ts';
import { toolBin } from './toolpath.ts';
import { getLaneView, openDb, type LaneView } from './db.ts';

// The embedded terminal: a WebSocket on Loom's own :4317 server that streams a
// real `tmux attach` running in a pty, so the dashboard can show the chat's
// actual TUI and type into it.
//
// THIS IS SHELL ACCESS. Anything that can open this socket can type into every
// chat, and every chat can run commands. So an upgrade is refused unless ALL of:
//   - the Host header is Loom's own (localhost / 127.0.0.1 on its port), which
//     shuts out DNS rebinding — a hostile page re-pointing its own name at
//     127.0.0.1 still sends its own name as Host;
//   - the Origin is the Loom page's own origin. Browsers always send Origin on a
//     WebSocket handshake and a page cannot forge it, so no other website can
//     connect even though the server is on localhost;
//   - it carries this launch's random token, which the server writes into the
//     dashboard HTML it serves and nowhere else (no JSON endpoint returns it,
//     and dashboard.html on disk never has it). Another local web origin that
//     somehow passed the first two checks still cannot guess it;
//   - the pane is one tmux reports as live right now.
//
// Each terminal is its own GROUPED session (`new-session -t <chat's session>`),
// which shares the chat's windows but keeps its own current window, so two
// views, or Loom plus an external terminal, never fight over which window is
// showing. Closing the terminal kills only that view session; the chat keeps
// running. The view also sets destroy-unattached once attached, so a Loom that
// dies without cleaning up still leaves nothing behind.

export const TERM_PATH = '/api/term';
const PANE_ID = /^%\d+$/;
const MAX_DIM = 1000;

// One per launch. Never logged, never in a JSON response.
const LAUNCH_TOKEN = randomBytes(32).toString('base64url');
export const termToken = (): string => LAUNCH_TOKEN;

/** Loom's own origins: the page is served from (and Electron loads) localhost:<port>. */
export function allowedOrigins(port: number): string[] {
  return [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
}

/** Is this Host header Loom's own? Anything else (a rebinding hostname, a LAN name) is not. */
export function isLoomHost(host: string | undefined, port: number): boolean {
  return !!host && (host === `localhost:${port}` || host === `127.0.0.1:${port}`);
}

export function tokenMatches(given: string | null | undefined, expected: string): boolean {
  if (!given || !expected) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export type UpgradeCheck =
  // A chat pane (`pane=%N`), or a whole terminal window (`session=` + `window=`, paneId '').
  | { ok: true; paneId: string; cols: number; rows: number; window?: { session: string; index: string } }
  | { ok: false; status: number; reason: string };

const dim = (v: string | null, fallback: number): number => {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n <= MAX_DIM ? n : fallback;
};

const SESSION_NAME = /^[A-Za-z0-9_-]{1,80}$/;

/** Host + Origin + token: the same three checks for the WebSocket and the toolbar's POST. Pure. */
export function checkTermAuth(
  headers: http.IncomingHttpHeaders,
  given: string | null | undefined,
  opts: { port: number; token: string },
): { ok: true } | { ok: false; status: number; reason: string } {
  if (!isLoomHost(headers.host, opts.port)) return { ok: false, status: 403, reason: 'bad host' };
  const origin = headers.origin;
  if (!origin || !allowedOrigins(opts.port).includes(origin)) return { ok: false, status: 403, reason: 'bad origin' };
  if (!tokenMatches(given, opts.token)) return { ok: false, status: 403, reason: 'bad token' };
  return { ok: true };
}

/** Every check an upgrade must pass, before anything touches tmux. Pure. */
export function checkUpgrade(
  req: { url?: string; headers: http.IncomingHttpHeaders },
  opts: { port: number; token: string },
): UpgradeCheck {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== TERM_PATH) return { ok: false, status: 404, reason: 'not found' };
  const auth = checkTermAuth(req.headers, url.searchParams.get('token'), opts);
  if (!auth.ok) return auth;
  const cols = dim(url.searchParams.get('cols'), 120);
  const rows = dim(url.searchParams.get('rows'), 32);
  const session = url.searchParams.get('session');
  if (session !== null) {
    const index = url.searchParams.get('window') || '';
    if (!SESSION_NAME.test(session) || isViewSession(session)) return { ok: false, status: 400, reason: 'bad session' };
    if (!/^\d{1,4}$/.test(index)) return { ok: false, status: 400, reason: 'bad window' };
    return { ok: true, paneId: '', cols, rows, window: { session, index } };
  }
  const paneId = url.searchParams.get('pane') || '';
  if (!PANE_ID.test(paneId)) return { ok: false, status: 400, reason: 'bad pane' };
  return { ok: true, paneId, cols, rows };
}

/* ------------------------------------------------------------ view sessions */

export type Tmux = (args: string[]) => string;

export interface LivePane {
  pane_id: string;
  tmux_session: string;
  window_index: string;
}

export const newViewName = (): string => VIEW_SESSION_PREFIX + randomBytes(5).toString('hex');

// Zoom bookkeeping. When the pane shares its window, the view zooms it so Loom
// shows exactly that pane at Loom's size. Zoom is WINDOW state (every client of
// the window sees it), so Loom only ever undoes a zoom it made: the pane option
// @loom_zoomed holds the name of the view that zoomed it. It lives in tmux, so
// it survives a Loom crash and startup reaping can undo a zoom left behind.
export const ZOOM_MARK = '@loom_zoomed';
const ZSEP = '~|LOOM|~';

interface ZoomRow {
  pane: string;
  mark: string;
  zoomed: boolean;
  active: boolean;
  window: string;
}

function zoomRows(tmux: Tmux): ZoomRow[] {
  let out: string;
  try {
    out = tmux(['list-panes', '-a', '-F', ['#{pane_id}', `#{${ZOOM_MARK}}`, '#{window_zoomed_flag}', '#{pane_active}', '#{window_id}'].join(ZSEP)]);
  } catch {
    return [];
  }
  const seen = new Map<string, ZoomRow>();
  for (const l of out.split('\n')) {
    if (!l.trim()) continue;
    const [pane, mark = '', z = '', a = '', window = ''] = l.split(ZSEP);
    if (!seen.has(pane)) seen.set(pane, { pane, mark: mark.trim(), zoomed: z === '1', active: a === '1', window });
  }
  return [...seen.values()];
}

/** view session -> its current window id. */
function viewWindows(tmux: Tmux): Map<string, string> {
  const m = new Map<string, string>();
  try {
    for (const l of tmux(['list-sessions', '-F', `#{session_name}${ZSEP}#{window_id}`]).split('\n')) {
      const [s, w = ''] = l.trim().split(ZSEP);
      if (isViewSession(s)) m.set(s, w);
    }
  } catch {
    /* no server */
  }
  return m;
}

/** Undo the zoom on `row` if it is still zoomed on that pane, and clear the mark. */
function unzoom(row: ZoomRow, tmux: Tmux): void {
  try {
    if (row.zoomed && row.active) tmux(['resize-pane', '-Z', '-t', row.pane]); // -Z toggles: this unzooms
    tmux(['set-option', '-pu', '-t', row.pane, ZOOM_MARK]);
  } catch {
    /* pane gone */
  }
}

/**
 * Release the zooms view `name` made. If another view is still showing that
 * window, the zoom is handed to it instead of undone.
 */
export function releaseZoom(name: string, tmux: Tmux): void {
  const rows = zoomRows(tmux).filter((r) => r.mark === name);
  if (!rows.length) return;
  const views = viewWindows(tmux);
  for (const r of rows) {
    const heir = [...views].find(([v, w]) => v !== name && w === r.window)?.[0];
    if (heir) {
      try {
        tmux(['set-option', '-p', '-t', r.pane, ZOOM_MARK, heir]);
      } catch {
        /* pane gone */
      }
    } else unzoom(r, tmux);
  }
}

/**
 * Keep the zoom marks honest. A mark means "Loom zoomed this window on this
 * pane and will undo it". Once the window is no longer zoomed on that pane —
 * the user pressed C-a z, a split unzoomed it, another pane got zoomed — there
 * is nothing of ours to undo, so the mark is cleared (never re-zoomed). A mark
 * whose view is gone is undone as at startup. Runs on a timer while Loom runs.
 * Returns how many marks it cleared.
 */
export function syncZoomMarks(tmux: Tmux): number {
  const views = viewWindows(tmux);
  let n = 0;
  for (const r of zoomRows(tmux)) {
    if (!r.mark) continue;
    if (!views.has(r.mark)) {
      unzoom(r, tmux);
      n++;
    } else if (!(r.zoomed && r.active)) {
      try {
        tmux(['set-option', '-pu', '-t', r.pane, ZOOM_MARK]);
      } catch {
        /* pane gone */
      }
      n++;
    }
  }
  return n;
}

/** Undo zooms whose view no longer exists (a Loom that died with a view open). Returns how many. */
export function reapZooms(tmux: Tmux): number {
  const views = viewWindows(tmux);
  let n = 0;
  for (const r of zoomRows(tmux)) {
    if (!r.mark || views.has(r.mark)) continue;
    unzoom(r, tmux);
    n++;
  }
  return n;
}

/**
 * Make the grouped session a terminal attaches to, showing the pane's window
 * with the pane selected (and, with `zoom`, zoomed if the window isn't zoomed
 * already). Throws if the pane isn't live. Returns the view name.
 */
export function openView(paneId: string, panes: LivePane[], tmux: Tmux, name: string = newViewName(), opts: { zoom?: boolean } = {}): string {
  const pane = panes.find((p) => p.pane_id === paneId && !isViewSession(p.tmux_session));
  if (!pane) throw new Error(`no live pane ${paneId}`);
  tmux(['new-session', '-d', '-t', pane.tmux_session, '-s', name]);
  try {
    tmux(['select-window', '-t', `${name}:${pane.window_index}`]);
    // Window state, so every client of this window sees the selection — the
    // accepted cost of showing a multi-pane window whole (design §2).
    tmux(['select-pane', '-t', paneId]);
    // A session option, so only this view loses the status bar; the chat's own
    // session (and any terminal attached to it) keeps its own.
    tmux(['set-option', '-t', name, 'status', 'off']);
    if (opts.zoom) {
      // Checked after select-pane, which drops a zoom on some other pane.
      const zoomed = tmux(['display-message', '-p', '-t', paneId, '#{window_zoomed_flag}']).trim() === '1';
      if (!zoomed) {
        tmux(['resize-pane', '-Z', '-t', paneId]);
        tmux(['set-option', '-p', '-t', paneId, ZOOM_MARK, name]);
      }
    }
  } catch (e) {
    closeView(name, tmux);
    throw e;
  }
  return name;
}

// Views that opened a shared window zoomed, newest last. Something else in the window
// (a jump to another pane, a second view opening) can undo the zoom just after we made
// it, leaving the viewer looking at the whole 2x2. For a short grace period after open,
// the NEWEST chat view of a window puts its own pane back; older views never do, so two
// views cannot fight, and a deliberate "Show window" is never undone.
export const REASSERT_GRACE_MS = 15_000;
const zoomOpen = new Map<string, { pane: string; at: number; window: string; showWindow: boolean }>();

export function noteZoomOpen(view: string, pane: string, tmux: Tmux, at: number = Date.now()): void {
  let window = '';
  try {
    window = tmux(['display-message', '-p', '-t', pane, '#{window_id}']).trim();
  } catch {
    /* pane gone */
  }
  zoomOpen.set(view, { pane, at, window, showWindow: false });
}
export function forgetZoomOpen(view: string): void {
  zoomOpen.delete(view);
}

/** Put `view`'s pane back alone if the window lost its zoom (or zoomed another pane) soon after open. Returns true if it acted. */
export function reassertZoom(view: string, tmux: Tmux, now: number = Date.now()): boolean {
  const v = zoomOpen.get(view);
  if (!v || v.showWindow || now - v.at > REASSERT_GRACE_MS) return false;
  for (const [name, o] of zoomOpen) if (name !== view && o.window === v.window && o.at > v.at && !o.showWindow) return false; // a newer view owns the window
  try {
    const [z, active] = tmux(['display-message', '-p', '-t', v.pane, '#{window_zoomed_flag} #{pane_active}']).trim().split(' ');
    if (z === '1' && active === '1') return false;
    tmux(['select-pane', '-t', v.pane]);
    if (tmux(['display-message', '-p', '-t', v.pane, '#{window_zoomed_flag}']).trim() !== '1') tmux(['resize-pane', '-Z', '-t', v.pane]);
    tmux(['set-option', '-p', '-t', v.pane, ZOOM_MARK, view]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep a chat view on its own pane's window. A view is a grouped session, so its
 * current window can be moved by anything that targets the group loosely: a
 * window closing under it, or a jump that addressed a bare pane id and landed on
 * this view (paneHome). The terminal then showed another chat's pane under the
 * selected chat's header. Returns what it did; `moved` false when it was right.
 */
export function realignView(view: string, paneId: string, tmux: Tmux): { moved: boolean; from?: string; to?: string; error?: string } {
  if (!isViewSession(view)) return { moved: false };
  try {
    const want = tmux(['display-message', '-p', '-t', paneId, '#{window_id}']).trim();
    const have = tmux(['display-message', '-p', '-t', `=${view}:`, '#{window_id}']).trim();
    if (!want || want === have) return { moved: false };
    tmux(['select-window', '-t', `=${view}:${want}`]);
    return { moved: true, from: have, to: want };
  } catch (e) {
    return { moved: false, error: (e as Error).message };
  }
}

/**
 * A view of a whole terminal window: grouped session, that window selected,
 * status bar off, nothing zoomed. Throws if it isn't a terminal window.
 */
export function openWindowView(session: string, index: string, tmux: Tmux, name: string = newViewName(), isTerminal: (s: string, w: string) => boolean = (s, w) => isTerminalWindow(s, w, tmux)): string {
  if (!isTerminal(session, index)) throw new Error(`no terminal window ${session}:${index}`);
  tmux(['new-session', '-d', '-t', `=${session}`, '-s', name]);
  try {
    tmux(['select-window', '-t', `=${name}:${index}`]);
    tmux(['set-option', '-t', `=${name}:`, 'status', 'off']);
  } catch (e) {
    closeView(name, tmux);
    throw e;
  }
  return name;
}

/* --------------------------------------------------------- toolbar actions */

// The terminal toolbar's only verbs. Each acts on the VIEW session's current
// pane; nothing else a request says reaches tmux.
export const TERM_ACTIONS = ['split-right', 'split-down', 'zoom', 'next-pane', 'close-pane'] as const;
export type TermAction = (typeof TERM_ACTIONS)[number];
export const isTermAction = (v: unknown): v is TermAction => typeof v === 'string' && (TERM_ACTIONS as readonly string[]).includes(v);

// A view is a CHAT view (opened for a chat pane: attach or zoom) or a WINDOW
// view (a whole terminal window, no chat in it). A chat view's window is the
// user's own workspace — a lane window holds other chats — so its toolbar only
// toggles the chat's zoom ("Show window" / "Show chat"). Splitting, cycling or
// closing panes there would rearrange the real lane window. Enforced here, not
// just hidden in the page.
export type ViewKind = 'chat' | 'window';
export const ACTIONS_FOR: Record<ViewKind, readonly TermAction[]> = {
  chat: ['zoom'],
  window: TERM_ACTIONS,
};
export const actionAllowed = (kind: ViewKind, action: TermAction): boolean => ACTIONS_FOR[kind].includes(action);

// Views this launch opened and still has open. The toolbar may only drive these.
const liveViews = new Map<string, ViewKind>();
export const isLiveView = (name: unknown): name is string => typeof name === 'string' && liveViews.has(name);
export const viewKind = (name: unknown): ViewKind | null => (typeof name === 'string' ? liveViews.get(name) ?? null : null);
export const noteView = (name: string, open: boolean, kind: ViewKind = 'chat'): void => {
  if (open) liveViews.set(name, kind);
  else liveViews.delete(name);
};

/** Is the view's window zoomed? */
export function viewZoomed(view: string, tmux: Tmux): boolean {
  try {
    return tmux(['display-message', '-p', '-t', `=${view}:.`, '#{window_zoomed_flag}']).trim() === '1';
  } catch {
    return false;
  }
}

export function termCommand(
  view: string,
  action: TermAction,
  tmux: Tmux,
  isAgentPane: (paneId: string, pid: string) => boolean = (id, pid) => agentPaneIds([{ pane_id: id, pane_pid: pid }]).has(id),
  kind: ViewKind = 'window',
): { ok: true; zoomed: boolean } | { ok: false; detail: string } {
  if (!isViewSession(view)) return { ok: false, detail: 'not a view' };
  if (!actionAllowed(kind, action)) return { ok: false, detail: 'Not available in a chat view: it would change the chat\'s own tmux window.' };
  const cur = `=${view}:.`;
  try {
    switch (action) {
      case 'split-right':
        tmux(['split-window', '-h', '-t', cur, '-c', '#{pane_current_path}']);
        break;
      case 'split-down':
        tmux(['split-window', '-v', '-t', cur, '-c', '#{pane_current_path}']);
        break;
      case 'zoom': {
        tmux(['resize-pane', '-Z', '-t', cur]);
        { const zo = zoomOpen.get(view); if (zo) zo.showWindow = !viewZoomed(view, tmux); }
        if (kind === 'chat') {
          // "Show chat" re-zooms on Loom's behalf, so it is Loom's to undo on
          // close; "Show window" leaves nothing of ours behind.
          const id = tmux(['display-message', '-p', '-t', cur, '#{pane_id}']).trim();
          if (viewZoomed(view, tmux)) tmux(['set-option', '-p', '-t', id, ZOOM_MARK, view]);
          else syncZoomMarks(tmux);
        }
        break;
      }
      case 'next-pane':
        tmux(['select-pane', '-Z', '-t', `=${view}:.+`]); // -Z keeps a zoomed window zoomed
        break;
      case 'close-pane': {
        const [id, pid = ''] = tmux(['display-message', '-p', '-t', cur, '#{pane_id} #{pane_pid}']).trim().split(' ');
        // Closing a chat is the chat's own action (it saves and quits cleanly);
        // the toolbar never kills an agent out from under its session.
        if (isAgentPane(id, pid)) return { ok: false, detail: 'This pane is running a chat. Close the chat instead.' };
        tmux(['kill-pane', '-t', id]);
        break;
      }
    }
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  return { ok: true, zoomed: viewZoomed(view, tmux) };
}

/** Kill one view session. Only ever a view: the chat's own session is never touched. */
export function closeView(name: string, tmux: Tmux): void {
  if (!isViewSession(name)) return;
  zoomOpen.delete(name);
  releaseZoom(name, tmux);
  try {
    tmux(['kill-session', '-t', `=${name}`]);
  } catch {
    /* already gone (destroy-unattached got there first) */
  }
}

/** Kill view sessions nothing is attached to: leftovers from a Loom that died. Returns how many. */
export function reapViews(tmux: Tmux): number {
  let out: string;
  try {
    out = tmux(['list-sessions', '-F', '#{session_name} #{session_attached}']);
  } catch {
    return 0; // no server
  }
  let n = 0;
  for (const line of out.split('\n')) {
    const [name, attached] = line.trim().split(' ');
    if (isViewSession(name) && attached === '0') {
      closeView(name, tmux);
      n++;
    }
  }
  reapZooms(tmux);
  return n;
}

/** The argv (after `tmux`) a view's pty runs: attach, then make the view self-destruct once unattached. */
export function attachArgs(name: string): string[] {
  // destroy-unattached must be set AFTER the client attaches: set on a detached
  // session it destroys the session on the spot.
  // -u: always a UTF-8 client. Launched from the Dock, Loom can inherit a locale
  // macOS doesn't have (LANG=C.UTF-8); tmux then draws every non-ASCII glyph
  // (Claude Code's prompt arrow, bullets) as '_'.
  // -T hyperlinks: pass OSC 8 links (Claude Code's clickable markdown links)
  // through; tmux strips them for an xterm-256color client otherwise.
  return ['-u', '-T', 'hyperlinks', ...tmuxArgs(['attach-session', '-t', `=${name}`, ';', 'set-option', '-t', `=${name}:`, 'destroy-unattached', 'on'])];
}

/* ---------------------------------------------------------------------- pty */

export interface PtyLike {
  onData(cb: (data: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export type SpawnPty = (
  file: string,
  args: string[],
  opts: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
) => PtyLike;

// node-pty is native and lives in app/node_modules (Electron) and as a root
// devDependency (tests, standalone server). Loaded lazily so a checkout without
// it still serves the board; the terminal endpoint then answers 503.
const loader = typeof require === 'function' ? require : createRequire(import.meta.url.startsWith('file:') ? import.meta.url : path.join(process.cwd(), 'x.js'));

export function loadNodePty(): SpawnPty | null {
  try {
    const mod = loader('node-pty') as { spawn: SpawnPty };
    ensureSpawnHelper(path.dirname(loader.resolve('node-pty/package.json')));
    return mod.spawn;
  } catch {
    return null;
  }
}

// yarn 1 unpacks node-pty's prebuilt spawn-helper without its exec bit, and
// every spawn then dies with "posix_spawnp failed". postinstall fixes it; this
// is the backstop for an install that skipped scripts.
function ensureSpawnHelper(dir: string): void {
  for (const sub of [path.join('build', 'Release'), path.join('prebuilds', `${process.platform}-${process.arch}`)]) {
    const helper = path.join(dir, sub, 'spawn-helper').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    try {
      if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
    } catch {
      /* read-only install: postinstall is the fix */
    }
  }
}

/* ------------------------------------------------------------------- bridge */

export interface BridgeDeps {
  port: number;
  token?: string;
  spawn?: SpawnPty | null;
  tmux?: Tmux;
  panes?: () => LivePane[];
  log?: (msg: string) => void;
  /** The lane_view setting, read per terminal. Default: the stored setting. */
  laneView?: () => LaneView;
  /** Is session:window a terminal window (no chat)? Default: terminals.ts. */
  isTerminal?: (session: string, window: string) => boolean;
}

// Client -> server frames are JSON text: {t:'i', d:'<keys>'} input, {t:'r', c, r}
// resize (attach mode only), {t:'s'} re-snapshot (mirror mode only).
// Server -> client: BINARY frames are terminal output bytes; TEXT frames are
// JSON control: {t:'mode', mode:'attach'|'mirror', cols, rows} first, then
// {t:'size', cols, rows} when a mirrored pane resizes, {t:'error', message}.
// {t:'s'} asks a mirror for a fresh snapshot. {t:'a'}: the page is showing this
// chat view (selected, rendered, or taken from the warm pool): put it back on its pane.
type ClientFrame = { t: 'i'; d: string } | { t: 'r'; c: number; r: number } | { t: 's' } | { t: 'a' };

function parseFrame(raw: string): ClientFrame | null {
  try {
    const f = JSON.parse(raw) as Record<string, unknown>;
    if (f.t === 'i' && typeof f.d === 'string') return { t: 'i', d: f.d };
    if (f.t === 's') return { t: 's' };
    if (f.t === 'a') return { t: 'a' };
    if (f.t === 'r' && Number.isInteger(f.c) && Number.isInteger(f.r)) {
      const c = f.c as number;
      const r = f.r as number;
      if (c > 0 && r > 0 && c <= MAX_DIM && r <= MAX_DIM) return { t: 'r', c, r };
    }
  } catch {
    /* not a frame */
  }
  return null;
}

function refuse(socket: Duplex, status: number, reason: string): void {
  const text = { 400: 'Bad Request', 403: 'Forbidden', 404: 'Not Found', 503: 'Service Unavailable' }[status] ?? 'Error';
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`);
  socket.destroy();
}

/** The env a view's tmux client runs with. $TMUX unset: Loom may itself run inside tmux, and tmux refuses a nested attach. */
function clientEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'TMUX' && k !== 'TMUX_PANE') env[k] = v;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  return env;
}

function storedLaneView(): LaneView {
  try {
    const db = openDb();
    try {
      return getLaneView(db);
    } finally {
      db.close();
    }
  } catch {
    return 'zoom';
  }
}

/* ------------------------------------------------------------------- modes */

// Which way a terminal shows its pane.
//   attach — the pane is alone in its window (Loom-managed chats): a grouped
//            view session with its status bar off, through a real pty.
//   mirror — the window has other panes (Will's lanes). Attaching would show
//            the whole window, and zoom / resize / break-pane / window-size all
//            change what his Ghostty client shows of the same window. So the
//            pane is MIRRORED instead: a snapshot, then its live output through
//            pipe-pane, and input through send-keys. Nothing about the window
//            changes; the client renders at the pane's real size and scales.
//   zoom   — the default for a shared window since Loom owns the work: attach
//            as above and zoom the pane (only if the window isn't zoomed, and
//            undone on close only if we zoomed it). The window follows Loom's
//            size like attach. lane_view=mirror picks mirror instead.
//   window — a whole terminal window (no chat in it), unzoomed.
export type TermMode = 'attach' | 'zoom' | 'mirror' | 'window';

export interface PaneState {
  windowPanes: number;
  piped: boolean; // something already pipe-panes this pane
}

export function paneState(paneId: string, tmux: Tmux): PaneState {
  const [n, pipe] = tmux(['display-message', '-p', '-t', paneId, '#{window_panes} #{pane_pipe}']).trim().split(' ');
  return { windowPanes: Number(n) || 0, piped: pipe === '1' };
}

export function chooseMode(s: PaneState, laneView: LaneView = 'zoom'): { mode: TermMode } | { refuse: string } {
  if (s.windowPanes === 1) return { mode: 'attach' };
  if (laneView === 'zoom') return { mode: 'zoom' };
  if (s.piped) return { refuse: 'This pane already has a pipe-pane running, so Loom cannot mirror it without replacing it. Stop that pipe (tmux pipe-pane with no command) or open the chat in your terminal.' };
  return { mode: 'mirror' };
}

/** send-keys -H argv chunks for raw input bytes: control keys, escapes and UTF-8 all go through as bytes. */
export function hexKeys(data: string, chunk = 256): string[][] {
  const hex = [...Buffer.from(data, 'utf8')].map((b) => b.toString(16).padStart(2, '0'));
  const out: string[][] = [];
  for (let i = 0; i < hex.length; i += chunk) out.push(hex.slice(i, i + chunk));
  return out;
}

export interface Snapshot {
  data: string; // bytes that paint the pane's current screen into a blank terminal
  cols: number;
  rows: number;
}

/** Escape-sequence bytes that paint `screen` and park the cursor, for a freshly reset terminal. Pure. */
export function snapshotData(screen: string, cx: number, cy: number, flag: number): string {
  return (
    '\x1b[0m\x1b[H\x1b[2J\x1b[3J' +
    screen.replace(/\n$/, '').split('\n').join('\r\n') +
    `\x1b[0m\x1b[${(cy || 0) + 1};${(cx || 0) + 1}H` +
    (flag === 0 ? '\x1b[?25l' : '\x1b[?25h')
  );
}

/** The pane's visible screen with colours, then the cursor where tmux has it. */
export function snapshotPane(paneId: string, tmux: Tmux): Snapshot {
  const [cx, cy, w, h, flag] = tmux(['display-message', '-p', '-t', paneId,
    '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{cursor_flag}']).trim().split(' ').map(Number);
  // -e keeps colours, -J rejoins wrapped lines (the terminal re-wraps them at
  // the same width) and keeps trailing spaces.
  const screen = tmux(['capture-pane', '-p', '-e', '-J', '-t', paneId]);
  return { data: snapshotData(screen, cx, cy, flag), cols: w || 80, rows: h || 24 };
}

/** tmux argv for one-process snapshot: a header line (cursor, size), then the screen. */
export const snapshotArgs = (paneId: string): string[] => [
  'display-message', '-p', '-t', paneId, '#{cursor_x} #{cursor_y} #{pane_width} #{pane_height} #{cursor_flag}',
  ';', 'capture-pane', '-p', '-e', '-J', '-t', paneId,
];

export interface SnapshotReply { cols: number; rows: number; cx: number; cy: number; flag: number; screen: string }

/** Split snapshotArgs' output. Null if it isn't shaped like one. Pure. */
export function parseSnapshotOut(out: string): SnapshotReply | null {
  const nl = out.indexOf('\n');
  if (nl < 0) return null;
  const [cx, cy, cols, rows, flag] = out.slice(0, nl).trim().split(' ').map(Number);
  if (![cx, cy, cols, rows].every(Number.isFinite) || !cols || !rows) return null;
  return { cols, rows, cx, cy, flag: Number.isFinite(flag) ? flag : 1, screen: out.slice(nl + 1) };
}

/** Run argv through tmux without blocking the event loop. */
export function runTmuxAsync(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(toolBin('tmux'), tmuxArgs(args), { encoding: 'utf-8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });
}

export const isPaneId = (v: unknown): v is string => typeof v === 'string' && PANE_ID.test(v);

const SNAP_TTL_MS = 800;
const snapCache = new Map<string, { at: number; p: Promise<SnapshotReply | null> }>();

/**
 * Screen of a pane for the page's instant first paint. One tmux process, async.
 * A hover prefetch and the click that follows share one capture (800ms).
 */
export function snapshotScreen(paneId: string, run: (args: string[]) => Promise<string> = runTmuxAsync, now: number = Date.now()): Promise<SnapshotReply | null> {
  const hit = snapCache.get(paneId);
  if (hit && now - hit.at < SNAP_TTL_MS) return hit.p;
  const p = run(snapshotArgs(paneId)).then(parseSnapshotOut, () => null);
  snapCache.set(paneId, { at: now, p });
  if (snapCache.size > 64) for (const k of snapCache.keys()) { snapCache.delete(k); break; }
  return p;
}

/** Host + token for the snapshot GET. A same-origin GET carries no Origin, so one is checked only if present. Pure. */
export function checkSnapAuth(headers: http.IncomingHttpHeaders, given: string | null | undefined, opts: { port: number; token: string }): { ok: true } | { ok: false; status: number; reason: string } {
  if (!isLoomHost(headers.host, opts.port)) return { ok: false, status: 403, reason: 'bad host' };
  if (headers.origin && !allowedOrigins(opts.port).includes(headers.origin)) return { ok: false, status: 403, reason: 'bad origin' };
  if (!tokenMatches(given, opts.token)) return { ok: false, status: 403, reason: 'bad token' };
  return { ok: true };
}

export const MIRROR_DIR = path.join(os.tmpdir(), 'loom-mirror');
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

export interface Mirror {
  input(data: string): void;
  refresh(): void;
  stop(): void;
  readonly fifo: string;
}

export interface MirrorHooks {
  output(bytes: Buffer): void;
  size(cols: number, rows: number): void;
  gone(): void;
}

/**
 * Mirror one pane: snapshot, then its output via `pipe-pane -O 'cat >> fifo'`.
 * The fifo is opened read-write so the open never blocks and never sees EOF
 * before tmux's cat arrives. stop() turns the pipe off and removes the fifo.
 */
export function startMirror(paneId: string, tmux: Tmux, hooks: MirrorHooks, opts: { dir?: string; pollMs?: number } = {}): Mirror {
  const dir = opts.dir ?? MIRROR_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fifo = path.join(dir, `${process.pid}-${randomBytes(6).toString('hex')}`);
  if (!SAFE_PATH.test(fifo)) throw new Error(`unsafe mirror path ${fifo}`);
  execFileSync('mkfifo', ['-m', '600', fifo], { timeout: 5_000 });
  let sock: net.Socket | null = null;
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let piped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (piped) {
      try {
        tmux(['pipe-pane', '-t', paneId]); // no command: stop the pipe
      } catch {
        /* pane gone */
      }
    }
    sock?.destroy();
    fs.rmSync(fifo, { force: true });
  };

  try {
    const fd = fs.openSync(fifo, 'r+');
    sock = new net.Socket({ fd, readable: true, writable: false });
    sock.on('data', (b: Buffer) => hooks.output(b));
    sock.on('error', () => {});
    let snap = snapshotPane(paneId, tmux);
    hooks.size(snap.cols, snap.rows);
    hooks.output(Buffer.from(snap.data));
    tmux(['pipe-pane', '-O', '-t', paneId, `cat >> '${fifo}'`]);
    piped = true;
    let dims = `${snap.cols}x${snap.rows}`;
    timer = setInterval(() => {
      let now: string;
      try {
        now = tmux(['display-message', '-p', '-t', paneId, '#{pane_width}x#{pane_height}']).trim();
      } catch {
        stop();
        hooks.gone();
        return;
      }
      if (now && now !== dims) {
        snap = snapshotPane(paneId, tmux);
        dims = `${snap.cols}x${snap.rows}`;
        hooks.size(snap.cols, snap.rows);
        hooks.output(Buffer.from(snap.data));
      }
    }, opts.pollMs ?? 1000);
    timer.unref?.();
  } catch (e) {
    stop();
    throw e;
  }

  return {
    fifo,
    input(data) {
      if (stopped) return;
      for (const keys of hexKeys(data)) tmux(['send-keys', '-t', paneId, '-H', ...keys]);
    },
    refresh() {
      if (stopped) return;
      const snap = snapshotPane(paneId, tmux);
      hooks.output(Buffer.from(snap.data));
    },
    stop,
  };
}

/* ------------------------------------------------------------------- bridge */

/**
 * Serve the terminal WebSocket on `server`. Returns a stop function that closes
 * every open terminal (views are killed, mirrors unpiped; the chats keep running).
 */
export function attachTerminalBridge(server: http.Server, deps: BridgeDeps): () => void {
  const token = deps.token ?? termToken();
  const tmux = deps.tmux ?? ((args: string[]) => runTmux(args));
  const panes = deps.panes ?? listTmuxPanes;
  const spawn = deps.spawn === undefined ? loadNodePty() : deps.spawn;
  const log = deps.log ?? ((m: string) => console.log('[loom] term: ' + m));
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const open = new Set<() => void>();

  const laneView = deps.laneView ?? storedLaneView;
  const reaped = reapViews(tmux);
  if (reaped) log(`reaped ${reaped} stale view session(s)`);
  const sweep = setInterval(() => {
    try {
      syncZoomMarks(tmux);
    } catch {
      /* no server */
    }
  }, 5000);
  sweep.unref?.();

  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const check = checkUpgrade(req, { port: deps.port, token });
    if (!check.ok) {
      if (check.status === 403) log(`refused upgrade: ${check.reason} (origin=${req.headers.origin ?? '-'})`);
      return refuse(socket, check.status, check.reason);
    }
    if (check.window) {
      if (!spawn) return refuse(socket, 503, 'terminal unavailable: node-pty not installed');
      let wview: string;
      try {
        wview = openWindowView(check.window.session, check.window.index, tmux, newViewName(), deps.isTerminal);
      } catch (e) {
        return refuse(socket, 400, (e as Error).message);
      }
      return wss.handleUpgrade(req, socket, head, (ws) => runAttach(ws, wview, check.cols, check.rows, 'window'));
    }
    const live = panes().find((p) => p.pane_id === check.paneId && !isViewSession(p.tmux_session));
    if (!live) return refuse(socket, 400, `no live pane ${check.paneId}`);
    let state: PaneState;
    try {
      state = paneState(check.paneId, tmux);
    } catch (e) {
      return refuse(socket, 400, (e as Error).message);
    }
    const choice = chooseMode(state, laneView());
    if ('refuse' in choice) {
      // Accepted only to deliver the reason: a browser cannot read an HTTP refusal.
      return wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(JSON.stringify({ t: 'error', message: choice.refuse }));
        ws.close(4409, 'pane already piped');
      });
    }
    if (choice.mode === 'mirror') {
      return wss.handleUpgrade(req, socket, head, (ws) => runMirror(ws, check.paneId));
    }
    if (!spawn) return refuse(socket, 503, 'terminal unavailable: node-pty not installed');
    let view: string;
    try {
      view = openView(check.paneId, [live], tmux, newViewName(), { zoom: choice.mode === 'zoom' });
    } catch (e) {
      return refuse(socket, 400, (e as Error).message);
    }
    wss.handleUpgrade(req, socket, head, (ws) => runAttach(ws, view, check.cols, check.rows, choice.mode, check.paneId));
  });

  const sendOut = (ws: WebSocket, b: Buffer | string) => {
    if (ws.readyState === ws.OPEN) ws.send(typeof b === 'string' ? Buffer.from(b) : b, { binary: true });
  };
  const sendCtl = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };
  const frames = (ws: WebSocket, on: (f: ClientFrame) => void) =>
    ws.on('message', (raw, isBinary) => {
      if (isBinary) return;
      const f = parseFrame(raw.toString());
      if (f) on(f);
    });

  function runMirror(ws: WebSocket, paneId: string): void {
    let mirror: Mirror;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      open.delete(finish);
      mirror?.stop();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    };
    let sized = false;
    try {
      mirror = startMirror(paneId, tmux, {
        output: (b) => sendOut(ws, b),
        size: (cols, rows) => {
          sendCtl(ws, sized ? { t: 'size', cols, rows } : { t: 'mode', mode: 'mirror', cols, rows });
          sized = true;
        },
        gone: finish,
      });
    } catch (e) {
      log(`mirror failed: ${(e as Error).message}`);
      sendCtl(ws, { t: 'error', message: 'Could not mirror this pane: ' + (e as Error).message });
      ws.close(1011, 'mirror failed');
      return;
    }
    open.add(finish);
    frames(ws, (f) => {
      try {
        if (f.t === 'i') mirror.input(f.d);
        else if (f.t === 's') mirror.refresh();
        // resize frames are ignored: a mirror never resizes the real pane
      } catch {
        finish();
      }
    });
    ws.on('close', finish);
    ws.on('error', finish);
  }

  function runAttach(ws: WebSocket, view: string, cols: number, rows: number, mode: TermMode, paneId = ''): void {
    let pty: PtyLike;
    try {
      pty = spawn!(toolBin('tmux'), attachArgs(view), { name: 'xterm-256color', cols, rows, cwd: os.homedir(), env: clientEnv() });
    } catch (e) {
      closeView(view, tmux);
      ws.close(1011, 'spawn failed');
      log(`spawn failed: ${(e as Error).message}`);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      open.delete(finish);
      try {
        pty.kill();
      } catch {
        /* already exited */
      }
      noteView(view, false);
      forgetZoomOpen(view);
      closeView(view, tmux);
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
    };
    open.add(finish);
    const kind: ViewKind = mode === 'window' ? 'window' : 'chat';
    noteView(view, true, kind);
    // `view` lets the page's toolbar address this terminal (POST /api/term/cmd);
    // `kind` says which verbs it has. A chat view's toolbar labels its one
    // button from `zoomed`, re-sent whenever it changes (C-a z included).
    let zoomed = viewZoomed(view, tmux);
    sendCtl(ws, { t: 'mode', mode, cols, rows, view, kind, zoomed });
    if (mode === 'zoom' && paneId) noteZoomOpen(view, paneId, tmux);
    const align = (why: string) => {
      if (kind !== 'chat' || !paneId) return;
      const r = realignView(view, paneId, tmux);
      if (r.moved || r.error) pickLog().write('-', 'view-realigned', { why, view, pane: paneId, from: r.from, to: r.to, error: r.error });
    };
    if (kind === 'chat') {
      const poll = setInterval(() => {
        align('poll');
        if (mode === 'zoom') reassertZoom(view, tmux);
        const z = viewZoomed(view, tmux);
        if (z !== zoomed) {
          zoomed = z;
          sendCtl(ws, { t: 'zoom', zoomed });
        }
      }, 2000);
      poll.unref?.();
      ws.on('close', () => clearInterval(poll));
    }
    pty.onData((d) => sendOut(ws, d));
    pty.onExit(() => finish());
    frames(ws, (f) => {
      if (f.t === 'i') pty.write(f.d);
      else if (f.t === 'a') align('shown');
      else if (f.t === 'r') {
        try {
          pty.resize(f.c, f.r);
        } catch {
          /* exited mid-resize */
        }
      }
    });
    ws.on('close', finish);
    ws.on('error', finish);
  }

  return () => {
    clearInterval(sweep);
    for (const f of [...open]) f();
    wss.close();
  };
}
