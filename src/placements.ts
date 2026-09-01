import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DIR } from './paths.ts';
import type { Agent } from './types.ts';

export const PLACEMENTS_PATH = path.join(TOOL_DIR, 'placements.jsonl');

export function agentSessionKey(agent: Agent, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

export interface Placement {
  // null on rows written by the pre-multi-agent hook, which recorded a session id
  // with no agent. Such a row is genuinely ambiguous on its own — it is resolved
  // against the agent actually running in its pane rather than assumed to be Claude
  // (the hook fired for Codex sessions too, so assuming Claude silently lost them).
  agent: Agent | null;
  session_id: string;
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  cwd: string;
  ts: number;
}

// Key for an agent-less legacy row: distinct from either agent's key so a legacy
// and a current row for the same session id both survive and compete by recency.
function placementKey(agent: Agent | null, sessionId: string): string {
  return agent ? agentSessionKey(agent, sessionId) : `?:${sessionId}`;
}

// Read the append-only placements log; last line per (agent, session_id) wins.
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
      const p = JSON.parse(line) as Partial<Placement>;
      if (p.session_id && p.pane_id) {
        const agent: Agent | null = p.agent === 'codex' || p.agent === 'claude' ? p.agent : null;
        const placement = { ...p, agent } as Placement;
        map.set(placementKey(agent, placement.session_id), placement);
      }
    } catch {
      /* skip malformed */
    }
  }
  return map;
}

export function recordPlacement(placement: Placement, file: string = PLACEMENTS_PATH): void {
  fs.appendFileSync(file, JSON.stringify(placement) + '\n', 'utf-8');
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

// Sessions a tmux client is currently attached to — i.e. sessions that already
// own a terminal tab. Everything else needs one, whether it was just recreated
// or survived a crash detached.
export function attachedSessions(): Set<string> {
  try {
    return new Set(
      execFileSync('tmux', ['list-clients', '-F', '#{client_session}'], { encoding: 'utf-8' })
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  } catch {
    return new Set(); // tmux not running -> nothing is attached
  }
}

// pane_id -> agent for panes whose process tree contains a supported agent.
// The foreground command can momentarily be a tool subprocess (bash/node/git),
// so its agent remains identifiable as an ancestor. A closed pane has no agent.
export function agentPaneIds(panes: TmuxPane[]): Map<string, Agent> {
  let out: string;
  try {
    out = execFileSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return new Map();
  }
  const children = new Map<number, number[]>();
  const agentPids = new Map<number, Agent>();
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = +m[1], ppid = +m[2], cmd = m[3];
    (children.get(ppid) ?? children.set(ppid, []).get(ppid)!).push(pid);
    const executable = cmd.match(/(^|\/)(claude|codex)(?=\s|$)/)?.[2];
    if (executable === 'claude' || executable === 'codex') agentPids.set(pid, executable);
  }
  const result = new Map<string, Agent>();
  for (const pane of panes) {
    const root = Number(pane.pane_pid);
    if (!root) continue;
    const stack = [root];
    while (stack.length) {
      const pid = stack.pop()!;
      const agent = agentPids.get(pid);
      if (agent) { result.set(pane.pane_id, agent); break; }
      const ch = children.get(pid);
      if (ch) for (const c of ch) stack.push(c);
    }
  }
  return result;
}

// Backward-compatible helper for callers that only care about Claude panes.
export function claudePaneIds(panes: TmuxPane[]): Set<string> {
  return new Set([...agentPaneIds(panes)].filter(([, agent]) => agent === 'claude').map(([paneId]) => paneId));
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

// Panes sitting at a shell (no agent running) — candidates to resume a chat into.
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
  const agentPanes = agentPaneIds(panes);
  const pos = readingOrder(panes);
  return panes
    .filter((p) => /^(zsh|bash|fish|sh)$/.test(p.command) && !agentPanes.has(p.pane_id))
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
  agent: Agent;
  session_id: string;
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  running: boolean; // pane exists AND an agent is running
  // The pane's CURRENT directory, which is not chats.project_dir: project_dir is
  // where the session was launched, so a session that moved into a worktree
  // still reports the repo root. The Trees tab needs where the pane actually is.
  cwd: string;
}

// Strip leading spinner/status glyphs Claude prepends to the pane title.
export function cleanPaneTitle(t: string): string {
  return t.replace(/^[^\p{L}\p{N}]+/u, '').trim();
}

// session_id -> live location. Primary source: recorded placements joined to the
// live agent-pane set. Secondary (bootstrap before the hook has recorded anything):
// match a running agent pane's title to a known chat title.
export function liveSessionsFrom(
  panes: TmuxPane[],
  agentPanes: Map<string, Agent>,
  placements: Map<string, Placement>,
  titleToSession?: Map<string, string>,
): Map<string, LiveInfo> {
  const byId = new Map(panes.map((p) => [p.pane_id, p]));
  const live = new Map<string, LiveInfo>();
  const claimedPanes = new Set<string>();
  const set = (sid: string, pane: TmuxPane, agent: Agent) => {
    claimedPanes.add(pane.pane_id);
    live.set(agentSessionKey(agent, sid), {
      agent,
      session_id: sid,
      pane_id: pane.pane_id,
      tmux_session: pane.tmux_session,
      window_index: pane.window_index,
      pane_index: pane.pane_index,
      running: true,
      cwd: pane.cwd,
    });
  };

  // 1. Exact: recorded placements joined to panes that are ACTUALLY running an agent
  // (one chat per pane). Newest placement wins a reused pane. A closed session's
  // pane is now a shell (not in claudeSet) -> excluded -> the chat reads as stale.
  // A legacy row (agent === null) takes the pane's running agent: the pane is the
  // authority on which agent is there, and the row's own id came from that agent.
  const latestPlacements = [...placements.values()].sort((a, b) => b.ts - a.ts);
  for (const pl of latestPlacements) {
    const pane = byId.get(pl.pane_id);
    const agent = pane && agentPanes.get(pane.pane_id);
    if (!pane || !agent || claimedPanes.has(pane.pane_id)) continue;
    if (pl.agent === null || pl.agent === agent) set(pl.session_id, pane, agent);
  }

  const activeAgentPanes = panes.filter((p) => agentPanes.has(p.pane_id));

  // 2. Title bootstrap: pane title === a chat's auto-title (exact, per pane).
  if (titleToSession) {
    for (const pane of activeAgentPanes) {
      if (claimedPanes.has(pane.pane_id)) continue;
      const agent = agentPanes.get(pane.pane_id);
      if (!agent) continue;
      const sid = titleToSession.get(`${agent}:${cleanPaneTitle(pane.title)}`);
      if (sid && !live.has(agentSessionKey(agent, sid))) set(sid, pane, agent);
    }
  }

  // No recency guessing: an unclaimed agent pane whose session we can't identify
  // (no placement, no title match) is left out rather than mis-attributed to a
  // recently-active chat — the placement hook fills it in on the next prompt.
  return live;
}

export function liveSessions(opts?: {
  titleToSession?: Map<string, string>;
}): Map<string, LiveInfo> {
  const panes = listTmuxPanes();
  return liveSessionsFrom(panes, agentPaneIds(panes), readPlacements(), opts?.titleToSession);
}
