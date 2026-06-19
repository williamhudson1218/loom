import os from 'node:os';
import path from 'node:path';

export const CLAUDE_HOME = path.join(os.homedir(), '.claude');
export const CLAUDE_PROJECTS_DIR = path.join(CLAUDE_HOME, 'projects');
export const TOOL_DIR = path.join(CLAUDE_HOME, 'tools', 'chat-manager');
export const DB_PATH = path.join(TOOL_DIR, 'manager.db');
export const DASHBOARD_PATH = path.join(TOOL_DIR, 'dashboard.html');
export const LAYOUT_PATH = path.join(TOOL_DIR, 'layout.json');

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
