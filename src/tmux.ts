import { execFileSync, type ExecFileSyncOptions } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { toolBin } from './toolpath.ts';
import { TOOL_DIR } from './paths.ts';
import { bounded, Breaker, breakerError, isTimeout, SYNC_TIMEOUT_MS } from './synctimeout.ts';

// The one door every tmux call goes through.
//
// Loom can run on its own tmux server (`tmux -L loom`) so a teammate's own
// tmux sessions and ~/.tmux.conf are never touched, or on the default server,
// which is where Will's `loom-<lane>-<n>` workspace lives. The socket is a
// setting, resolved in this order:
//   1. $LOOM_TMUX_SOCKET
//   2. the `tmux_socket` row in manager.db settings (applied at launch through
//      configureTmuxSocket, see getTmuxSocket in db.ts)
//   3. 'default'
//
// 'default' adds NO flag at all, so every call is byte-identical to the bare
// `tmux …` Loom ran before this file existed. Any other name adds `-L <name>`,
// and a call that may START a server (new-session) also gets `-f <config>` so
// Loom's own tmux.conf is what that server loads — never on the default socket,
// where the user's ~/.tmux.conf stays in charge.

export const DEFAULT_SOCKET = 'default';

// Grouped sessions the embedded terminal attaches (see ptybridge.ts). They
// share every window with the session they were made from, so `list-panes -a`
// and `list-windows -a` report each pane a second time under the view's name.
// Every reader that walks the whole server drops them with isViewSession.
export const VIEW_SESSION_PREFIX = 'loom-view-';
export const isViewSession = (name: string | undefined): boolean => !!name && name.startsWith(VIEW_SESSION_PREFIX);

/**
 * The pane's real session and window, never a view. A pane target alone is
 * ambiguous while a view of its group exists: tmux resolves it to the "best"
 * session holding the window, which is an attached view (Loom's terminal) over
 * the unattached session it was made from. So `select-window -t %42` switched the
 * VIEW to that window, and the terminal of whatever chat that view was showing
 * (or would be shown again from the warm pool) displayed another chat's pane.
 * Target `=<session>:<window_id>` from this instead. null when the pane is gone.
 */
export function paneHome(paneId: string, run: (args: string[]) => string): { session: string; window: string; windowIndex: string } | null {
  let out = '';
  try {
    out = run(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{window_id}\t#{window_index}']);
  } catch {
    return null;
  }
  for (const l of out.split('\n')) {
    const [id, session, window, windowIndex = ''] = l.split('\t');
    if (id === paneId && session && !isViewSession(session)) return { session, window, windowIndex };
  }
  return null;
}

const SOCKET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

let configured: string | null = null;

/** Apply the stored setting. $LOOM_TMUX_SOCKET still wins over it. A malformed name is ignored. */
export function configureTmuxSocket(name: string | null | undefined): void {
  const v = name?.trim();
  configured = v && SOCKET_NAME.test(v) ? v : null;
}

export function tmuxSocket(): string {
  const env = process.env.LOOM_TMUX_SOCKET?.trim();
  if (env && SOCKET_NAME.test(env)) return env;
  return configured ?? DEFAULT_SOCKET;
}

/** Loom's tmux.conf: $LOOM_TMUX_CONFIG, else <LOOM_HOME>/tmux.conf (setup.sh installs it there), if present. */
export function tmuxConfigPath(): string | null {
  const env = process.env.LOOM_TMUX_CONFIG?.trim();
  if (env) return env;
  const p = path.join(TOOL_DIR, 'tmux.conf');
  try {
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export interface TmuxArgOpts {
  socket?: string;
  config?: string | null;
  /** The call may start a server (new-session): pass the config too. */
  startsServer?: boolean;
}

/** The full argv after `tmux`: global flags, then the command. */
export function tmuxArgs(args: string[], opts: TmuxArgOpts = {}): string[] {
  const socket = opts.socket ?? tmuxSocket();
  if (socket === DEFAULT_SOCKET) return args;
  const pre = ['-L', socket];
  if (opts.startsServer) {
    const conf = opts.config === undefined ? tmuxConfigPath() : opts.config;
    if (conf) pre.push('-f', conf);
  }
  return [...pre, ...args];
}

const startsServer = (args: string[]): boolean => args[0] === 'new-session' || args[0] === 'new' || args[0] === 'start-server';

// Every call is bounded (src/synctimeout.ts): these run on Electron's main
// thread, and a wedged tmux server would otherwise freeze all of Loom. A call
// that may start a server gets longer, since a cold start loads the config.
export const TMUX_TIMEOUT_MS = SYNC_TIMEOUT_MS;
export const TMUX_START_TIMEOUT_MS = 15_000;
// After a timeout, tmux calls fail at once for this long instead of each waiting out its own.
export const TMUX_COOLDOWN_MS = 10_000;
export const tmuxBreaker = new Breaker(TMUX_COOLDOWN_MS);

export const tmuxTimeoutFor = (args: string[]): number => (startsServer(args) ? TMUX_START_TIMEOUT_MS : TMUX_TIMEOUT_MS);

function runTmux<T>(args: string[], call: () => T): T {
  const now = Date.now();
  if (tmuxBreaker.isOpen(now)) throw breakerError('tmux');
  try {
    return call();
  } catch (e) {
    if (isTimeout(e) && tmuxBreaker.trip(Date.now())) {
      console.error(`[loom] tmux ${args[0] ?? ''} timed out after ${tmuxTimeoutFor(args)}ms; tmux calls fail fast for ${TMUX_COOLDOWN_MS / 1000}s`);
    }
    throw e;
  }
}

/** execFileSync('tmux', …) with the socket applied and a timeout. Returns stdout as a string. */
export function tmux(args: string[], opts: Omit<ExecFileSyncOptions, 'encoding'> = {}): string {
  return runTmux(args, () => {
    const out = execFileSync(toolBin('tmux'), tmuxArgs(args, { startsServer: startsServer(args) }), { ...bounded(opts, tmuxTimeoutFor(args)), encoding: 'utf-8' });
    return typeof out === 'string' ? out : '';
  });
}

/** Same, swallowing failure (a pane or window vanished between listing it and writing to it, or tmux is not answering). */
export function tmuxQuiet(args: string[]): void {
  try {
    runTmux(args, () => execFileSync(toolBin('tmux'), tmuxArgs(args, { startsServer: startsServer(args) }), bounded({ stdio: 'ignore' as const }, tmuxTimeoutFor(args))));
  } catch {
    /* gone */
  }
}
