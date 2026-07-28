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

// src/em/signals.ts -> repo root.
const LOOM_REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isInside(child: string, parent: string): boolean {
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
