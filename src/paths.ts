import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const CLAUDE_HOME = path.join(os.homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');

// Legacy data dir from the original single-machine install, where the repo *was*
// the data dir. Kept only as a back-compat fallback so existing installs don't
// lose their DB/layout/placements on upgrade.
const LEGACY_TOOL_DIR = path.join(CLAUDE_HOME, 'tools', 'chat-manager');

// Loom's runtime/data dir: holds manager.db, dashboard.html, layout.json, and
// placements.jsonl, and is the cwd for the headless `claude -p` summary calls.
// This is deliberately decoupled from where the repo is cloned, so the code can
// live anywhere. Resolution (identical in the CLI, the Electron app, and the
// bash placement hook, so all three agree with no env propagation between them):
//   1. $LOOM_HOME              — explicit override / shared or relocated dir
//   2. ~/.claude/tools/chat-manager, if it already exists — legacy installs
//   3. ~/.loom                 — default for fresh installs
function resolveLoomHome(): string {
  const env = process.env.LOOM_HOME?.trim();
  if (env) return path.resolve(env);
  try {
    if (fs.existsSync(LEGACY_TOOL_DIR)) return LEGACY_TOOL_DIR;
  } catch {
    /* fall through to default */
  }
  return path.join(os.homedir(), '.loom');
}

export const TOOL_DIR = resolveLoomHome();
export const DB_PATH = path.join(TOOL_DIR, 'manager.db');
export const DASHBOARD_PATH = path.join(TOOL_DIR, 'dashboard.html');
export const LAYOUT_PATH = path.join(TOOL_DIR, 'layout.json');

// Only tmux sessions whose name starts with this prefix are part of the saved
// "workspace" — snapshotted for crash recovery and rebuilt by restore. Scratch
// sessions without the prefix are ignored. Override with $LOOM_SESSION_PREFIX;
// set it to an empty string to include every session.
export const SESSION_PREFIX = process.env.LOOM_SESSION_PREFIX?.trim() ?? 'loom-';

export const ANALYZE_CAP = 25;
export const ANALYZE_CONCURRENCY = 3;
export const MIN_MESSAGES_FOR_LLM = 3;
export const TRANSCRIPT_CHAR_CAP = 60_000;

// Only chats active within this many days are indexed, summarized, and shown.
// Older sessions are pruned from the DB (deep archive search lives in find-chat).
export const ACTIVE_WINDOW_DAYS = 7;

// First line of the analyzer prompt. Used both to build the prompt AND to detect
// (and exclude) chat-manager's own headless `claude -p` summarization sessions,
// which would otherwise be indexed as junk cards and recursively re-summarized.
export const SUMMARY_PROMPT_PREAMBLE =
  'You are summarizing a past Claude Code coding session so the user can find it later.';

// Claude encodes a session's cwd into its projects/ subdir name by replacing every
// non-alphanumeric char with '-'. This yields the projects subdir for a given path.
export function encodeProjectDir(absPath: string): string {
  return absPath.replace(/[^a-zA-Z0-9]/g, '-');
}
