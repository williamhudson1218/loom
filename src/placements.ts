import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DIR } from './paths.ts';
import type { Agent } from './types.ts';
import { isViewSession, tmux, tmuxAsync } from './tmux.ts';
import { execText, TtlCache } from './asyncexec.ts';

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
//
// The log only grows (44k lines, 10 MB on a long-lived install), and the
// snapshot reads it every time its 1.5 s memo expires, on Electron's main
// thread: a whole-file parse measured 26 ms. So each file keeps its parsed map
// and the byte offset it has read to, and a later call parses only the lines
// appended since. A file that shrank, was replaced (new inode) or changed
// without growing is read again from the start.
//
// The map is handed out as is (read-only), not copied: every caller reads it
// synchronously, and a copy per snapshot was the main cost left.
interface PlacementsCache { ino: number; size: number; mtimeMs: number; offset: number; lines: number; map: Map<string, Placement> }
const placementsCache = new Map<string, PlacementsCache>();

function parsePlacementLines(text: string, map: Map<string, Placement>): number {
  let lines = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    lines++;
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
  return lines;
}

function readBytes(file: string, from: number, to: number): Buffer {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(to - from);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got);
  } finally {
    fs.closeSync(fd);
  }
}

export function readPlacements(file: string = PLACEMENTS_PATH): ReadonlyMap<string, Placement> {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    placementsCache.delete(file);
    return new Map();
  }
  let c = placementsCache.get(file);
  const unchanged = c && c.ino === st.ino && c.size === st.size && c.mtimeMs === st.mtimeMs;
  const grew = c && c.ino === st.ino && st.size > c.size;
  if (!c || (!unchanged && !grew)) c = { ino: st.ino, size: 0, mtimeMs: 0, offset: 0, lines: 0, map: new Map() };
  if (!unchanged) {
    try {
      const buf = readBytes(file, c.offset, st.size);
      // Only whole lines: a line still being appended is read on the next call.
      // A last line with no newline that already parses is whole (a hand-written file).
      let end = buf.lastIndexOf(0x0a) + 1;
      if (end < buf.length) {
        try {
          JSON.parse(buf.subarray(end).toString('utf-8'));
          end = buf.length;
        } catch {
          /* still being written */
        }
      }
      c.lines += parsePlacementLines(buf.subarray(0, end).toString('utf-8'), c.map);
      c.offset += end;
      c.size = st.size;
      c.mtimeMs = st.mtimeMs;
    } catch {
      placementsCache.delete(file);
      return new Map();
    }
    placementsCache.set(file, c);
  }
  return c.map;
}

// Compaction. The log is append-only and only its last row per (agent, session)
// is ever read, so it grows without bound (48k rows, 11 MB, for ~2.7k sessions).
// Once it is big and mostly superseded rows, it is rewritten to the rows
// readPlacements keeps, in the order it keeps them, so reading the compacted
// file gives the identical map.
//
// Writers: the record-placement hook (a shell `>>`) and recordPlacement (an
// appendFileSync), both O_APPEND, both unlocked. The rewrite goes to a temp file
// renamed over the log. A row appended to the old file while that happens is
// not lost: the old file stays open, and anything past what was copied is
// copied into the temp file before the rename and into the new file after it.
export const COMPACT_MIN_BYTES = 2 * 1024 * 1024;
export const COMPACT_MIN_RATIO = 4;

export function compactPlacements(
  file: string = PLACEMENTS_PATH,
  opts: { minBytes?: number; minRatio?: number; beforeRename?: () => void } = {},
): { before: number; after: number } | null {
  const minBytes = opts.minBytes ?? COMPACT_MIN_BYTES;
  const minRatio = opts.minRatio ?? COMPACT_MIN_RATIO;
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch {
    return null;
  }
  const tmp = `${file}.compact-${process.pid}`;
  try {
    const st = fs.fstatSync(fd);
    if (st.size < minBytes) return null;
    // A fresh parse of this exact inode (not the cache: it may lag the file).
    const whole = readFd(fd, 0, st.size);
    const end = whole.lastIndexOf(0x0a) + 1; // a line still being written is carried over below
    const map = new Map<string, Placement>();
    const lines = parsePlacementLines(whole.subarray(0, end).toString('utf-8'), map);
    if (lines < map.size * minRatio) return null;
    let body = '';
    for (const p of map.values()) body += JSON.stringify(p) + '\n';
    fs.writeFileSync(tmp, body, 'utf-8');
    let copied = end;
    const catchUp = (target: string): void => {
      const size = fs.fstatSync(fd).size;
      if (size <= copied) return;
      fs.appendFileSync(target, readFd(fd, copied, size));
      copied = size;
    };
    catchUp(tmp);
    opts.beforeRename?.();
    catchUp(tmp);
    fs.renameSync(tmp, file);
    catchUp(file);
    placementsCache.delete(file);
    return { before: st.size, after: fs.statSync(file).size };
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* never written */
    }
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function readFd(fd: number, from: number, to: number): Buffer {
  const buf = Buffer.alloc(to - from);
  let got = 0;
  while (got < buf.length) {
    const n = fs.readSync(fd, buf, got, buf.length - got, from + got);
    if (!n) break;
    got += n;
  }
  return buf.subarray(0, got);
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

const LIST_PANES_FORMAT = `#{pane_id}${SEP}#{session_name}${SEP}#{window_index}${SEP}#{pane_index}${SEP}#{pane_pid}${SEP}#{pane_current_command}${SEP}#{pane_current_path}${SEP}#{pane_left}${SEP}#{pane_top}${SEP}#{pane_title}`;

export function listTmuxPanes(): TmuxPane[] {
  let out: string;
  try {
    out = tmux(['list-panes', '-a', '-F', LIST_PANES_FORMAT]);
  } catch {
    return []; // tmux not running
  }
  return parseTmuxPanes(out);
}

/** listTmuxPanes off the main thread, for polling paths. */
export async function listTmuxPanesAsync(): Promise<TmuxPane[]> {
  let out: string;
  try {
    out = await tmuxAsync(['list-panes', '-a', '-F', LIST_PANES_FORMAT]);
  } catch {
    return []; // tmux not running
  }
  return parseTmuxPanes(out);
}

export function parseTmuxPanes(out: string): TmuxPane[] {
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
    })
    // An embedded-terminal view repeats every pane of the session it groups with.
    .filter((p) => !isViewSession(p.tmux_session));
}

// Sessions a tmux client is currently attached to — i.e. sessions that already
// own a terminal tab. Everything else needs one, whether it was just recreated
// or survived a crash detached.
export function attachedSessions(): Set<string> {
  try {
    return new Set(
      tmux(['list-clients', '-F', '#{client_session}'])
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s && !isViewSession(s)),
    );
  } catch {
    return new Set(); // tmux not running -> nothing is attached
  }
}

// pane_id -> agent for panes whose process tree contains a supported agent.
// The foreground command can momentarily be a tool subprocess (bash/node/git),
// so its agent remains identifiable as an ancestor. A closed pane has no agent.
// `ps -eo` over the whole machine is the costliest sync call Loom makes (~50 ms)
// and the tray, pane topics, EM scan, board poll and terminals list all want it
// within the same second. One shared copy, kept for PS_TTL_MS; under vitest it is
// never reused so tests that change the process table see the change.
// The async path (psTableAsync) also collapses concurrent callers into ONE `ps`,
// so a burst of ticks landing together never runs it twice.
const PS_TTL_MS = 2000;
const PS_ARGS = ['-eo', 'pid=,ppid=,command='];
const psCache = new TtlCache<string>(PS_TTL_MS);
const reusePs = () => !process.env.VITEST;

/** The whole-machine `ps -eo pid=,ppid=,command=` table, shared for PS_TTL_MS. Blocks: polling paths use psTableAsync. */
export function psTable(): string {
  const hit = reusePs() ? psCache.fresh() : null;
  if (hit !== null) return hit;
  const out = execFileSync('ps', PS_ARGS, { encoding: 'utf-8', maxBuffer: 16 * 1024 * 1024, timeout: 5_000, killSignal: 'SIGKILL' });
  psCache.set(out);
  return out;
}

/** The same table off the main thread: TTL-cached, and one `ps` at a time however many ask. */
export function psTableAsync(run: () => Promise<string> = () => execText('ps', PS_ARGS)): Promise<string> {
  return psCache.get(run, { reuse: reusePs() });
}

/** Test hook: forget the cached table. */
export function resetPsCache(): void {
  psCache.clear();
}

export function agentPaneIds(panes: Pick<TmuxPane, 'pane_id' | 'pane_pid'>[]): Map<string, Agent> {
  let out: string;
  try {
    out = psTable();
  } catch {
    return new Map();
  }
  return agentPaneIdsFrom(out, panes);
}

/** agentPaneIds off the main thread. */
export async function agentPaneIdsAsync(panes: Pick<TmuxPane, 'pane_id' | 'pane_pid'>[]): Promise<Map<string, Agent>> {
  let out: string;
  try {
    out = await psTableAsync();
  } catch {
    return new Map();
  }
  return agentPaneIdsFrom(out, panes);
}

export function agentPaneIdsFrom(out: string, panes: Pick<TmuxPane, 'pane_id' | 'pane_pid'>[]): Map<string, Agent> {
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
  placements: ReadonlyMap<string, Placement>,
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

/** liveSessions with list-panes and ps off the main thread, for polling paths. */
export async function liveSessionsAsync(opts?: {
  titleToSession?: Map<string, string>;
}): Promise<Map<string, LiveInfo>> {
  const panes = await listTmuxPanesAsync();
  return liveSessionsFrom(panes, await agentPaneIdsAsync(panes), readPlacements(), opts?.titleToSession);
}
