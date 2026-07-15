import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_PROJECTS_DIR, FIND_CHAT_BIN } from './paths.ts';
import { cleanText } from './parser.ts';

// One archive hit, as returned by find-chat's CLI. find-chat hands us
// `jsonl_path` directly, so the transcript panel never has to derive it.
export interface ArchiveHit {
  session_id: string;
  project_dir: string;
  jsonl_path: string;
  started_at: number;
  ended_at: number;
  message_count: number;
  title: string;
  snippet: string;
  score: number;
}

export type ArchiveResult =
  | { ok: true; results: ArchiveHit[] }
  | { ok: false; detail: string };

// Injected so tests can drive searchArchive without spawning a process, mirroring
// analyzer.ts's ClaudeRunner. Resolves with the CLI's raw stdout.
export type FindChatRunner = (args: string[]) => Promise<string>;

// Generous: if find-chat's index.db is missing it backfills the entire archive on
// the first call. Normal runs are an incremental mtime scan and return fast.
const SEARCH_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export const defaultRunner: FindChatRunner = (args) =>
  new Promise((resolve, reject) => {
    // execFile, never a shell — the query is user text and must not be word-split
    // or interpreted. find-chat writes index progress to stderr and the JSON
    // payload to stdout, so only stdout is read.
    execFile(
      FIND_CHAT_BIN,
      args,
      { timeout: SEARCH_TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8' },
      (err, stdout) => (err ? reject(err) : resolve(stdout)),
    );
  });

function isHit(h: unknown): h is ArchiveHit {
  const x = h as ArchiveHit;
  return (
    !!x &&
    typeof x.session_id === 'string' &&
    typeof x.project_dir === 'string' &&
    typeof x.jsonl_path === 'string'
  );
}

/**
 * Search the full chat archive via find-chat.
 *
 * `exclude` is passed through to find-chat's own --exclude flag; Loom passes every
 * session already on the board so the archive section only shows what isn't
 * already visible. Note find-chat applies excludes *after* its LIMIT, so heavy
 * overlap thins the result set rather than backfilling it — which is the intent
 * (those chats are on the board already).
 *
 * Never throws: every failure maps to {ok:false, detail} so a missing or broken
 * find-chat degrades to a note in the UI instead of breaking the dashboard.
 */
export async function searchArchive(
  query: string,
  exclude: string[] = [],
  runner: FindChatRunner = defaultRunner,
): Promise<ArchiveResult> {
  const q = query.trim();
  if (!q) return { ok: true, results: [] };

  const args: string[] = [];
  for (const sid of exclude) args.push('--exclude', sid);
  args.push(q); // one argv element — find-chat joins its non-flag args back into the query

  let stdout: string;
  try {
    stdout = await runner(args);
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { killed?: boolean };
    if (err.code === 'ENOENT') return { ok: false, detail: 'find-chat not installed' };
    if (err.killed) return { ok: false, detail: 'search timed out' };
    return { ok: false, detail: `find-chat failed: ${err.message}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, detail: 'find-chat returned unparseable output' };
  }

  const results = (parsed as { results?: unknown })?.results;
  if (!Array.isArray(results)) {
    return { ok: false, detail: 'find-chat returned an unexpected shape' };
  }
  // Drop hits whose transcript has been deleted: they can't be read or resumed, so
  // they must never render as a card. find-chat prunes such rows on refresh now,
  // but this stays as the guarantee — Loom shouldn't trust an index it doesn't own.
  // Cheap: at most TOP_N stats.
  return {
    ok: true,
    results: results
      .filter(isHit)
      .filter((h) => fs.existsSync(h.jsonl_path))
      .map(cleanHit),
  };
}

// find-chat indexes raw transcript text, so a chat that opened with a slash command
// leads with Claude's <local-command-caveat> boilerplate. Board cards never show it
// (they display an AI-generated title); archive cards have no summary and fall back
// to this text, so it would become the heading. Reuse the same cleaner the parser
// applies to board chats.
function cleanHit(h: ArchiveHit): ArchiveHit {
  return { ...h, title: cleanText(h.title), snippet: cleanText(h.snippet) };
}

// `proj` and `jsonl` reach /resume, /branch and /api/transcript as free-form query
// params, and only for archive chats (which aren't in Loom's DB, so there's no row
// to validate against). The server is bound to localhost but is still reachable by
// any local process, so both are checked before they reach tmux or the filesystem.

/** True for an absolute path that exists and is a directory. */
export function isValidProjectDir(p: string): boolean {
  if (!p || !path.isAbsolute(p)) return false;
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** True for an existing .jsonl file inside ~/.claude/projects (no traversal out). */
export function isValidTranscriptPath(p: string): boolean {
  if (!p || !path.isAbsolute(p)) return false;
  const resolved = path.resolve(p);
  const root = path.resolve(CLAUDE_PROJECTS_DIR);
  if (!resolved.startsWith(root + path.sep)) return false;
  if (!resolved.endsWith('.jsonl')) return false;
  try {
    return fs.statSync(resolved).isFile();
  } catch {
    return false;
  }
}
