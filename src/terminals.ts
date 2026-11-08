import { isValidProjectDir } from './findchat.ts';
import { parseLane, readWorld, type LanePane } from './compact.ts';
import { MANAGED_SESSION } from './managed.ts';
import { isViewSession, tmux as runTmux } from './tmux.ts';

// Terminals: tmux windows on Loom's socket that hold no agent chat — dev
// servers (`loom-tp-terminals`), editors, sessions people made themselves. The
// sidebar lists them and the embedded terminal attaches a whole window
// (ptybridge.ts, `session=` + `window=`), so the work Will did in Ghostty tabs
// happens inside Loom.
//
// Never listed: Loom's own view sessions, the managed chat session, and lane
// sessions (`loom-<lane>-<n>`), which are chat workspaces even when a pane in
// them is an idle shell.

export type Tmux = (args: string[]) => string;

export interface TermWindow {
  index: string;
  name: string;
  panes: number;
  active: boolean;
}

export interface TermSession {
  session: string;
  windows: TermWindow[];
}

export interface WindowRow {
  session: string;
  index: string;
  name: string;
  panes: number;
  active: boolean;
}

const SEP = '~|LOOM|~';

export function isChatSession(session: string): boolean {
  return isViewSession(session) || session === MANAGED_SESSION || parseLane(session) !== null;
}

/**
 * Pure: windows with no agent pane, grouped by session, in tmux's order.
 * `loomWindows` are `session:index` keys holding a pane Loom gave a role (the
 * orchestrator's, @loom_role): never a terminal, even while its agent is down.
 */
export function terminalsFrom(
  windows: WindowRow[],
  panes: Pick<LanePane, 'tmux_session' | 'window_index' | 'agent'>[],
  loomWindows: Set<string> = new Set(),
): TermSession[] {
  const agentWindows = new Set(panes.filter((p) => p.agent).map((p) => `${p.tmux_session}:${p.window_index}`));
  for (const k of loomWindows) agentWindows.add(k);
  const out = new Map<string, TermSession>();
  for (const w of windows) {
    if (isChatSession(w.session) || agentWindows.has(`${w.session}:${w.index}`)) continue;
    const s = out.get(w.session) ?? out.set(w.session, { session: w.session, windows: [] }).get(w.session)!;
    s.windows.push({ index: w.index, name: w.name, panes: w.panes, active: w.active });
  }
  return [...out.values()];
}

export function readWindows(tmux: Tmux): WindowRow[] {
  let out: string;
  try {
    out = tmux(['list-windows', '-a', '-F', ['#{session_name}', '#{window_index}', '#{window_name}', '#{window_panes}', '#{window_active}'].join(SEP)]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [session, index, name = '', panes = '0', active = '0'] = l.split(SEP);
      return { session, index, name, panes: Number(panes) || 0, active: active === '1' };
    });
}

/** session:index of every window holding a pane with a @loom_role (the orchestrator). */
export function roleWindows(tmux: Tmux): Set<string> {
  try {
    return new Set(
      tmux(['list-panes', '-a', '-F', ['#{session_name}', '#{window_index}', '#{@loom_role}'].join(SEP)])
        .split('\n')
        .map((l) => l.split(SEP))
        .filter((p) => p.length === 3 && p[2].trim())
        .map((p) => `${p[0]}:${p[1]}`),
    );
  } catch {
    return new Set();
  }
}

export function listTerminals(tmux: Tmux = (a) => runTmux(a)): TermSession[] {
  return terminalsFrom(readWindows(tmux), readWorld(tmux).panes, roleWindows(tmux));
}

/** Is `session:window` a terminal window right now (exists, holds no chat)? */
export function isTerminalWindow(session: string, window: string, tmux: Tmux = (a) => runTmux(a)): boolean {
  return listTerminals(tmux).some((s) => s.session === session && s.windows.some((w) => w.index === window));
}

/* ------------------------------------------------------------ new session */

/**
 * The name part of `loom-<name>`: lowercase letters, digits, `-` and `_`, at
 * most 40 chars. Never ends in `-<digits>`: `loom-api-2` would read as lane
 * `api`, pane 2 (compact.ts parseLane), and lane compaction would move its
 * panes, so a trailing `-2` becomes `2`.
 */
export function sanitizeTermName(raw: string): string {
  let s = String(raw ?? '').trim().toLowerCase();
  if (s.startsWith('loom-')) s = s.slice(5);
  s = s.replace(/[^a-z0-9_-]+/g, '-').replace(/-+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 40).replace(/[-_]+$/, '');
  s = s.replace(/-(\d+)$/, '$1');
  return s || 'term';
}

/** `loom-<name>`, or `loom-<name>-b`, `-c`, … if taken. Never a lane-shaped name. */
export function uniqueTermSession(name: string, existing: Set<string>): string {
  const base = `loom-${sanitizeTermName(name)}`;
  if (!existing.has(base)) return base;
  for (let c = 98; c <= 122; c++) {
    const n = `${base}-${String.fromCharCode(c)}`;
    if (!existing.has(n)) return n;
  }
  for (let i = 2; ; i++) {
    const n = `${base}-x${i}`;
    if (!existing.has(n)) return n;
  }
}

export type CreateResult = { ok: true; session: string; window: string } | { ok: false; detail: string };

export function createTerminalSession(name: string, dir: string, tmux: Tmux = (a) => runTmux(a), validDir: (d: string) => boolean = isValidProjectDir): CreateResult {
  if (!validDir(dir)) return { ok: false, detail: 'Choose an existing project directory.' };
  let existing: Set<string>;
  try {
    existing = new Set(tmux(['list-sessions', '-F', '#{session_name}']).split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    existing = new Set(); // no server yet: new-session starts it
  }
  const session = uniqueTermSession(name, existing);
  try {
    tmux(['new-session', '-d', '-s', session, '-c', dir]);
    const window = tmux(['display-message', '-p', '-t', `=${session}:`, '#{window_index}']).trim();
    return { ok: true, session, window };
  } catch (e) {
    return { ok: false, detail: 'tmux could not create the session: ' + (e as Error).message };
  }
}
