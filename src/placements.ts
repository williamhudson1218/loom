import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DIR } from './paths.ts';

export const PLACEMENTS_PATH = path.join(TOOL_DIR, 'placements.jsonl');

export interface Placement {
  session_id: string;
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  cwd: string;
  ts: number;
}

// Read the append-only placements log; last line per session_id wins.
export function readPlacements(file: string = PLACEMENTS_PATH): Map<string, Placement> {
  const map = new Map<string, Placement>();
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf-8');
  } catch {
    return map;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const p = JSON.parse(line) as Placement;
      if (p.session_id && p.pane_id) map.set(p.session_id, p);
    } catch {
      /* skip malformed */
    }
  }
  return map;
}

export interface TmuxPane {
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  pane_pid: string;
  command: string;
  cwd: string;
  left: number;
  top: number;
  title: string;
}

// Content-safe field delimiter (a tab separator gets lost through the exec/tmux
// layers). This literal string won't appear in a session/command/pane title.
const SEP = '~|LOOM|~';

export function listTmuxPanes(): TmuxPane[] {
  let out: string;
  try {
    out = execFileSync(
      'tmux',
      ['list-panes', '-a', '-F',
        `#{pane_id}${SEP}#{session_name}${SEP}#{window_index}${SEP}#{pane_index}${SEP}#{pane_pid}${SEP}#{pane_current_command}${SEP}#{pane_current_path}${SEP}#{pane_left}${SEP}#{pane_top}${SEP}#{pane_title}`],
      { encoding: 'utf-8' },
    );
  } catch {
    return []; // tmux not running
  }
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const parts = l.split(SEP);
      return {
        pane_id: parts[0],
        tmux_session: parts[1],
        window_index: parts[2],
        pane_index: parts[3],
        pane_pid: parts[4] ?? '',
        command: parts[5] ?? '',
        cwd: parts[6] ?? '',
        left: Number(parts[7] ?? 0),
        top: Number(parts[8] ?? 0),
        title: parts.slice(9).join(SEP),
      };
    });
}

// pane_ids whose process tree contains a running Claude process. Robust to the
// momentary foreground command being a tool subprocess (bash/node/git): Claude is
// still an ancestor. A closed pane (reverted to a shell) has no Claude -> excluded.
export function claudePaneIds(panes: TmuxPane[]): Set<string> {
  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return new Set();
  }
  const children = new Map<number, number[]>();
  const claudePids = new Set<number>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], cmd = m[3];
    (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
    if (/(^|\/)claude( |$)/.test(cmd)) claudePids.add(pid);
  }
  const result = new Set<string>();
  for (const pane of panes) {
    const root = Number(pane.pane_pid);
    if (!root) continue;
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      if (claudePids.has(pid)) { result.add(pane.pane_id); break; }
      const ch = children.get(pid);
      if (ch) for (const c of ch) stack.push(c);
    }
  }
  return result;
}

// Reading-order position (1-based) within each tmux window: top-to-bottom,
// left-to-right. Returns a map pane_id -> position.
export function readingOrder(panes: TmuxPane[]): Map<string, number> {
  const pos = new Map<string, number>();
  const byWindow = new Map<string, TmuxPane[]>();
  for (const p of panes) {
    const key = `${p.tmux_session}:${p.window_index}`;
    (byWindow.get(key) ?? byWindow.set(key, []).get(key)!).push(p);
  }
  for (const group of byWindow.values()) {
    group.sort((a, b) => (a.top - b.top) || (a.left - b.left));
    group.forEach((p, i) => pos.set(p.pane_id, i + 1));
  }
  return pos;
}

// Panes sitting at a shell (no Claude running) — candidates to resume a chat into.
export interface IdlePane {
  pane_id: string;
  tmux_session: string;
  window_index: string;
  position: number; // reading-order within its window
  cwd: string;
  label: string;
}

export function idlePanes(): IdlePane[] {
  const panes = listTmuxPanes();
  const claudeSet = claudePaneIds(panes);
  const pos = readingOrder(panes);
  return panes
    .filter((p) => /^(zsh|bash|fish|sh)$/.test(p.command) && !claudeSet.has(p.pane_id))
    .map((p) => ({
      pane_id: p.pane_id,
      tmux_session: p.tmux_session,
      window_index: p.window_index,
      position: pos.get(p.pane_id) ?? 0,
      cwd: p.cwd,
      label: `${p.tmux_session} · win ${p.window_index} · pane ${pos.get(p.pane_id) ?? '?'}`,
    }))
    .sort((a, b) => a.tmux_session.localeCompare(b.tmux_session) || a.position - b.position);
}

export interface LiveInfo {
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  running: boolean; // pane exists AND Claude is the foreground command
}

// Strip leading spinner/status glyphs Claude prepends to the pane title.
export function cleanPaneTitle(t: string): string {
  return t.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// session_id -> live location. Primary source: recorded placements joined to the
// live pane set. Secondary (bootstrap before the hook has recorded anything):
// match a running Claude pane's title to a known chat title.
export function liveSessions(opts?: {
  titleToSession?: Map<string, string>;
}): Map<string, LiveInfo> {
  const panes = listTmuxPanes();
  const claudeSet = claudePaneIds(panes);
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  const live = new Map<string, LiveInfo>();
  const claimedPanes = new Set<string>();
  const set = (sid: string, pane: TmuxPane) => {
    claimedPanes.add(pane.pane_id);
    live.set(sid, {
      pane_id: pane.pane_id,
      tmux_session: pane.tmux_session,
      window_index: pane.window_index,
      pane_index: pane.pane_index,
      running: true, // only claude-running panes are marked live
    });
  };

  // 1. Exact: recorded placements joined to panes that are ACTUALLY running Claude
  // (one chat per pane). Newest placement wins a reused pane. A closed session's
  // pane is now a shell (not in claudeSet) -> excluded -> the chat reads as stale.
  const placements = [...readPlacements().values()].sort((a, b) => b.ts - a.ts);
  for (const pl of placements) {
    const pane = byId.get(pl.pane_id);
    if (pane && claudeSet.has(pane.pane_id) && !claimedPanes.has(pane.pane_id)) set(pl.session_id, pane);
  }

  const claudePanes = panes.filter((p) => claudeSet.has(p.pane_id));

  // 2. Title bootstrap: pane title === a chat's auto-title (exact, per pane).
  const t2s = opts?.titleToSession;
  if (t2s) {
    for (const pane of claudePanes) {
      if (claimedPanes.has(pane.pane_id)) continue;
      const sid = t2s.get(cleanPaneTitle(pane.title));
      if (sid && !live.has(sid)) set(sid, pane);
    }
  }

  // No recency guessing: an unclaimed Claude pane whose session we can't identify
  // (no placement, no title match) is left out rather than mis-attributed to a
  // recently-active chat — the placement hook fills it in on the next prompt.
  return live;
}
