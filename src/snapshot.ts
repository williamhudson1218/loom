import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { LAYOUT_PATH, SESSION_PREFIX } from './paths.ts';
import { listTmuxPanes, claudePaneIds, liveSessions, type TmuxPane } from './placements.ts';

const SEP = '~|LOOM|~';

export type PaneKind = 'claude' | 'nvim' | 'shell' | 'other';

export interface PaneSnap {
  pane_index: string;
  cwd: string;
  command: string; // foreground command (basename, from tmux)
  full_command: string; // best-effort full command line for non-claude/non-nvim
  title: string;
  kind: PaneKind;
  session_id?: string; // for claude panes
}

export interface WindowSnap {
  window_index: string;
  window_layout: string; // tmux geometry string, replayed via select-layout
  panes: PaneSnap[];
}

export interface SessionSnap {
  name: string;
  windows: WindowSnap[];
}

export interface Layout {
  taken_at: number;
  sessions: SessionSnap[];
}

// session:window -> window_layout (exact pane geometry)
function windowLayouts(): Map<string, string> {
  const m = new Map<string, string>();
  let out: string;
  try {
    out = execFileSync('tmux', ['list-windows', '-a', '-F', `#{session_name}${SEP}#{window_index}${SEP}#{window_layout}`], { encoding: 'utf-8' });
  } catch {
    return m;
  }
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split(SEP);
    m.set(`${p[0]}:${p[1]}`, p.slice(2).join(SEP));
  }
  return m;
}

// pane_pid -> full command line of the program running in it (deepest non-shell
// descendant), so dev-server / editor panes can be reconstructed best-effort.
function foregroundCommands(panes: TmuxPane[]): Map<string, string> {
  const m = new Map<string, string>();
  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return m;
  }
  const children = new Map<number, number[]>();
  const cmd = new Map<number, string>();
  for (const line of out.split('\n')) {
    const mt = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!mt) continue;
    const pid = +mt[1], ppid = +mt[2];
    (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
    cmd.set(pid, mt[3]);
  }
  const isShell = (c: string) => /(^|\/)(zsh|bash|fish|sh)( |$)/.test(c);
  for (const pane of panes) {
    const root = Number(pane.pane_pid);
    if (!root) continue;
    // find the first non-shell descendant (the actual program)
    const stack = [root];
    let found = '';
    while (stack.length) {
      const pid = stack.shift()!;
      const c = cmd.get(pid) ?? '';
      if (pid !== root && c && !isShell(c)) { found = c; break; }
      for (const ch of children.get(pid) ?? []) stack.push(ch);
    }
    if (found) m.set(pane.pane_id, found);
  }
  return m;
}

function kindOf(pane: TmuxPane, isClaude: boolean): PaneKind {
  if (isClaude) return 'claude';
  if (/(^|\/)(nvim|vim)( |$)|^n?vim$/.test(pane.command)) return 'nvim';
  if (/^(zsh|bash|fish|sh)$/.test(pane.command)) return 'shell';
  return 'other';
}

export function captureLayout(now: number, prefix: string = SESSION_PREFIX): Layout {
  // Only snapshot the workspace sessions (prefix-matched); scratch sessions are
  // left out so the crash-recovery layout is the curated set restore rebuilds.
  const panes = listTmuxPanes().filter((p) => p.tmux_session.startsWith(prefix));
  const claudeSet = claudePaneIds(panes);
  const layouts = windowLayouts();
  const fg = foregroundCommands(panes);
  const paneToSession = new Map<string, string>();
  for (const [sid, info] of liveSessions({ titleToSession: undefined })) paneToSession.set(info.pane_id, sid);

  const sessions = new Map<string, Map<string, WindowSnap>>();
  for (const p of panes) {
    const isClaude = claudeSet.has(p.pane_id);
    const snap: PaneSnap = {
      pane_index: p.pane_index,
      cwd: p.cwd,
      command: p.command,
      full_command: fg.get(p.pane_id) ?? '',
      title: p.title,
      kind: kindOf(p, isClaude),
      session_id: isClaude ? paneToSession.get(p.pane_id) : undefined,
    };
    const winMap = sessions.get(p.tmux_session) ?? sessions.set(p.tmux_session, new Map()).get(p.tmux_session)!;
    const win = winMap.get(p.window_index) ?? winMap.set(p.window_index, {
      window_index: p.window_index,
      window_layout: layouts.get(`${p.tmux_session}:${p.window_index}`) ?? '',
      panes: [],
    }).get(p.window_index)!;
    win.panes.push(snap);
  }

  const out: SessionSnap[] = [];
  for (const [name, winMap] of sessions) {
    const windows = [...winMap.values()].sort((a, b) => Number(a.window_index) - Number(b.window_index));
    for (const w of windows) w.panes.sort((a, b) => Number(a.pane_index) - Number(b.pane_index));
    out.push({ name, windows });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return { taken_at: now, sessions: out };
}

// Only overwrite the saved snapshot when tmux actually has sessions — never clobber
// a good snapshot with an empty one (e.g. right after a crash before restore).
export function writeLayout(now: number, path: string = LAYOUT_PATH, prefix: string = SESSION_PREFIX): Layout | null {
  const layout = captureLayout(now, prefix);
  if (layout.sessions.length === 0) return null;
  fs.writeFileSync(path, JSON.stringify(layout, null, 2), 'utf-8');
  return layout;
}

export function readLayout(path: string = LAYOUT_PATH): Layout | null {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf-8')) as Layout;
  } catch {
    return null;
  }
}
