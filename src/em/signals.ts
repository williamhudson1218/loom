import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatRow, Agent } from '../types.ts';
import type { LiveLoc } from '../dashboard.ts';
import { agentSessionKey } from '../placements.ts';
import { readContextUsage, type ContextUsage } from './context.ts';

export interface EmSignals {
  agent: Agent;
  session_id: string;
  project_dir: string;
  jsonl_path: string;
  title: string;
  first_message: string;
  state: string;
  live: boolean;
  working: boolean;
  pane: LiveLoc | null;
  idleMs: number;
  ageMs: number;
  messageCount: number;
  filesWritten: string[];
  context: ContextUsage | null;
}

// Stamped in at bundle time by app/build.mjs. The packaged app lives in
// /Applications and has no module path pointing back at the source tree.
declare const __LOOM_REPO_DIR__: string | undefined;

// Where Loom's own source lives, so its sessions can be excluded from EM
// management. Resolution order mirrors resolveLoomHome() in paths.ts.
//
// The try/catch is load-bearing, not defensive noise: app/build.mjs defines
// import.meta.url to the sentinel "loom-bundled", and fileURLToPath throws
// "Invalid URL" on it. Unguarded, that throw happens at module load and takes
// the entire Electron app down before it ever binds a port — and no unit test
// catches it, because vitest supplies a real import.meta.url.
function resolveLoomRepoDir(): string {
  const env = process.env.LOOM_REPO_DIR?.trim();
  if (env) return path.resolve(env);
  if (typeof __LOOM_REPO_DIR__ === 'string' && __LOOM_REPO_DIR__) return __LOOM_REPO_DIR__;
  try {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  } catch {
    return '';
  }
}

const LOOM_REPO_DIR = resolveLoomRepoDir();

function isInside(child: string, parent: string): boolean {
  // An unknown repo dir must not turn into "every path is inside it" —
  // path.relative('', '/x') resolves against cwd and would exclude real chats.
  if (!parent) return false;
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function splitList(raw: string): string[] {
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function computeSignals(
  rows: ChatRow[],
  live: Record<string, LiveLoc>,
  now: number,
  opts: { selfDir?: string } = {},
): EmSignals[] {
  const selfDir = opts.selfDir ?? LOOM_REPO_DIR;
  const out: EmSignals[] = [];

  for (const r of rows) {
    // Never manage Loom's own sessions — including worktrees of this repo —
    // or the EM ends up acting on the session that is implementing it.
    if (r.project_dir && isInside(r.project_dir, selfDir)) continue;

    // The DB's last_active_at only refreshes on a summarizer pass (minutes of
    // lag). The transcript's mtime is the true last-activity time.
    let lastActive = r.last_active_at;
    try {
      lastActive = Math.max(lastActive, fs.statSync(r.jsonl_path).mtimeMs);
    } catch {
      /* transcript gone; fall back to the indexed value */
    }

    const loc = live[agentSessionKey(r.agent, r.session_id)] ?? null;

    out.push({
      agent: r.agent,
      session_id: r.session_id,
      project_dir: r.project_dir,
      jsonl_path: r.jsonl_path,
      title: r.title || r.claude_auto_title || '',
      first_message: r.first_message,
      state: r.state,
      live: !!loc,
      working: !!loc?.working,
      pane: loc,
      idleMs: Math.max(0, now - lastActive),
      ageMs: Math.max(0, now - r.started_at),
      messageCount: r.message_count,
      filesWritten: splitList(r.files_written),
      // Codex transcripts carry no usage block, so this is null for them and
      // BLOATED simply never fires — correct, not a gap to work around.
      context: readContextUsage(r.jsonl_path),
    });
  }
  return out;
}
