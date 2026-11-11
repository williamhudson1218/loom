import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent } from '../types.ts';
import type { LiveLoc } from '../dashboard.ts';
import { agentSessionKey } from '../placements.ts';
import { readContextUsage, type ContextUsage } from './context.ts';
import { resolveLoomRepoDir as resolveCheckout } from '../repodir.ts';

// Per-chat signals for the chats source (moved from the EM's signals.ts). Pure
// apart from a stat and bounded tail reads of each LIVE chat's transcript; the
// tail reads only happen when an enabled watcher needs them.

/** The fields a signal needs. Both ChatView (the board) and ChatRow (the DB) have them. */
export interface ChatLike {
  agent: Agent;
  session_id: string;
  project_dir: string;
  jsonl_path: string;
  title: string;
  claude_auto_title: string;
  first_message: string;
  state: string;
  started_at: number;
  last_active_at: number;
  message_count: number;
  project?: string;
  tags?: string[];
}

export interface ChatSignal {
  agent: Agent;
  session_id: string;
  key: string; // agent:session_id
  project_dir: string;
  project: string;
  jsonl_path: string;
  title: string;
  tags: string[];
  state: string;
  live: boolean;
  working: boolean;
  pane: LiveLoc | null;
  /** Transcript mtime (or the indexed last activity when the file is gone). */
  lastActive: number;
  idleMs: number;
  ageMs: number;
  messageCount: number;
  context: ContextUsage | null;
  /** When the newest tool call still without a result was made, or 0. */
  pendingToolSince: number;
}

// Stamped in at bundle time by app/build.mjs ('' in a release build). The packaged
// app lives in /Applications and has no module path pointing back at the source tree.
declare const __LOOM_REPO_DIR__: string | undefined;

// Where Loom's own source lives, so its sessions are never watched (a watcher
// acting on the session that is building it). Mirrors resolveLoomHome().
//
// The try/catch is load-bearing, not defensive noise: app/build.mjs defines
// import.meta.url to the sentinel "loom-bundled", and fileURLToPath throws
// "Invalid URL" on it. Unguarded, that throw happens at module load and takes
// the entire Electron app down before it ever binds a port, and no unit test
// catches it, because vitest supplies a real import.meta.url.
function resolveLoomRepoDir(): string {
  const env = process.env.LOOM_REPO_DIR?.trim();
  if (env) return path.resolve(env);
  if (typeof __LOOM_REPO_DIR__ === 'string' && __LOOM_REPO_DIR__) return __LOOM_REPO_DIR__;
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  } catch {
    // The bundle, and a release bundle stamps '': look for a checkout instead.
    return resolveCheckout();
  }
}

export const LOOM_REPO_DIR = resolveLoomRepoDir();

export function isInside(child: string, parent: string): boolean {
  // An unknown repo dir must not turn into "every path is inside it":
  // path.relative('', '/x') resolves against cwd and would exclude real chats.
  if (!parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The newest tool call in the transcript tail that has no result yet. A
 * session sitting on one for minutes is waiting on a permission prompt or a
 * hung command. Claude transcripts only; Codex has no such pairing.
 */
export function readPendingTool(jsonlPath: string, opts: { bytes?: number } = {}): number {
  const bytes = opts.bytes ?? 64_000;
  let text: string;
  try {
    const st = fs.statSync(jsonlPath);
    const start = Math.max(0, st.size - bytes);
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf-8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return 0;
  }
  const done = new Set<string>();
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('tool_')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = Array.isArray(o?.message?.content) ? o.message.content : [];
    for (const c of content) if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') done.add(c.tool_use_id);
    if (o?.type !== 'assistant') continue;
    const open = content.find((c: any) => c?.type === 'tool_use' && typeof c.id === 'string' && !done.has(c.id));
    if (open) {
      const t = Date.parse(String(o.timestamp ?? ''));
      return Number.isFinite(t) ? t : 0;
    }
    // The newest assistant turn's calls all have results: nothing pending.
    if (content.some((c: any) => c?.type === 'tool_use')) return 0;
  }
  return 0;
}

export interface SignalOpts {
  selfDir?: string;
  /** Read context usage (only when a context_over watcher is on). */
  context?: boolean;
  /** Read the pending tool call (only when a blocked_on_tool watcher is on). */
  pendingTool?: boolean;
  /** Only live chats. Every chats trigger needs a live pane; Test passes false. */
  liveOnly?: boolean;
}

export function computeSignals(rows: ChatLike[], live: Record<string, LiveLoc>, now: number, opts: SignalOpts = {}): ChatSignal[] {
  const selfDir = opts.selfDir ?? LOOM_REPO_DIR;
  const liveOnly = opts.liveOnly ?? true;
  const out: ChatSignal[] = [];
  for (const r of rows) {
    // Never watch Loom's own sessions, worktrees of this repo included.
    if (r.project_dir && isInside(r.project_dir, selfDir)) continue;
    const key = agentSessionKey(r.agent, r.session_id);
    const loc = live[key] ?? null;
    if (liveOnly && !loc) continue;
    // The DB's last_active_at only refreshes on a summarizer pass (minutes of
    // lag). The transcript's mtime is the true last-activity time.
    let lastActive = r.last_active_at;
    try {
      lastActive = Math.max(lastActive, fs.statSync(r.jsonl_path).mtimeMs);
    } catch {
      /* transcript gone; fall back to the indexed value */
    }
    out.push({
      agent: r.agent,
      session_id: r.session_id,
      key,
      project_dir: r.project_dir,
      project: r.project ?? path.basename(r.project_dir || ''),
      jsonl_path: r.jsonl_path,
      title: r.title || r.claude_auto_title || r.first_message.slice(0, 80) || '',
      tags: r.tags ?? [],
      state: r.state,
      live: !!loc,
      working: !!loc?.working,
      pane: loc,
      lastActive: Math.floor(lastActive),
      idleMs: Math.max(0, now - lastActive),
      ageMs: Math.max(0, now - r.started_at),
      messageCount: r.message_count,
      // Codex transcripts carry no usage block, so this is null for them and
      // context_over never fires: correct, not a gap to work around.
      context: opts.context && loc ? readContextUsage(r.jsonl_path) : null,
      pendingToolSince: opts.pendingTool && loc && r.agent === 'claude' ? readPendingTool(r.jsonl_path) : 0,
    });
  }
  return out;
}
