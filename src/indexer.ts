import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  CLAUDE_PROJECTS_DIR,
  ACTIVE_WINDOW_DAYS,
  SUMMARY_PROMPT_PREAMBLE,
  TOOL_DIR,
  encodeProjectDir,
} from './paths.ts';
import { parseJsonlFile } from './parser.ts';
import type { ParsedChat } from './types.ts';

const DAY_MS = 86_400_000;

// chat-manager's own headless `claude -p` sessions are quarantined into this
// projects/ subdir (analyzer pins cwd to TOOL_DIR). Skip it so we never index
// our own summarization prompts as chats.
const SELF_PROJECT_DIR_NAME = encodeProjectDir(TOOL_DIR);

/** True for a chat that is actually one of chat-manager's analyzer sessions. */
export function isAnalyzerSession(parsed: ParsedChat): boolean {
  return (
    parsed.project_dir === TOOL_DIR ||
    parsed.first_message.startsWith(SUMMARY_PROMPT_PREAMBLE)
  );
}

/** Epoch-ms boundary: chats last active before this are out of the window. */
export function windowCutoff(now: number, days: number = ACTIVE_WINDOW_DAYS): number {
  return now - days * DAY_MS;
}

/**
 * Drop rows for chats last active before the cutoff. Returns rows removed.
 * Saved chats are durable bookmarks — exempt from the window prune so they stay
 * on the board until explicitly unsaved (see the Saved section on the dashboard).
 */
export function pruneOld(db: Database.Database, cutoff: number): number {
  return db.prepare(`DELETE FROM chats WHERE last_active_at < ? AND saved = 0`).run(cutoff).changes;
}

export function listProjectJsonls(projectsDir: string): string[] {
  const out: string[] = [];
  let projects: string[];
  try {
    projects = fs.readdirSync(projectsDir);
  } catch {
    return out;
  }
  for (const proj of projects) {
    const projPath = path.join(projectsDir, proj);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(projPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    if (proj === SELF_PROJECT_DIR_NAME) continue; // skip our own analyzer sessions
    let entries: string[];
    try {
      entries = fs.readdirSync(projPath);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.endsWith('.jsonl')) continue; // top-level only; nested dirs ignored
      const full = path.join(projPath, e);
      try {
        if (fs.statSync(full).isFile()) out.push(full);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}

export function upsertChat(
  db: Database.Database,
  parsed: ParsedChat,
  mtime: number,
  now: number,
): 'inserted' | 'updated' | 'unchanged' {
  const existing = db
    .prepare(`SELECT jsonl_mtime FROM chats WHERE session_id = ?`)
    .get(parsed.session_id) as { jsonl_mtime: number } | undefined;

  if (existing && existing.jsonl_mtime === mtime) return 'unchanged';

  const common = {
    project_dir: parsed.project_dir,
    jsonl_path: parsed.jsonl_path,
    started_at: parsed.started_at,
    ended_at: parsed.ended_at,
    last_active_at: parsed.last_active_at,
    message_count: parsed.message_count,
    activity_json: JSON.stringify(parsed.activity),
    files_touched: parsed.files_touched.join('\n'),
    first_message: parsed.first_message,
    claude_auto_title: parsed.claude_auto_title,
    pr_url: parsed.pr_url,
    jsonl_mtime: mtime,
    last_indexed_at: now,
    session_id: parsed.session_id,
  };

  if (!existing) {
    db.prepare(
      `INSERT INTO chats (
        session_id, project_dir, jsonl_path, started_at, ended_at, last_active_at,
        message_count, activity_json, files_touched, first_message, claude_auto_title, pr_url,
        summary_dirty, jsonl_mtime, last_indexed_at
      ) VALUES (
        @session_id, @project_dir, @jsonl_path, @started_at, @ended_at, @last_active_at,
        @message_count, @activity_json, @files_touched, @first_message, @claude_auto_title, @pr_url,
        1, @jsonl_mtime, @last_indexed_at
      )`,
    ).run(common);
    return 'inserted';
  }

  // File changed: refresh raw fields and re-mark dirty (keep prior summary text
  // until the analyzer overwrites it).
  db.prepare(
    `UPDATE chats SET
       project_dir=@project_dir, jsonl_path=@jsonl_path, started_at=@started_at,
       ended_at=@ended_at, last_active_at=@last_active_at, message_count=@message_count,
       activity_json=@activity_json, files_touched=@files_touched,
       first_message=@first_message, claude_auto_title=@claude_auto_title, pr_url=@pr_url,
       summary_dirty=1, jsonl_mtime=@jsonl_mtime, last_indexed_at=@last_indexed_at
     WHERE session_id=@session_id`,
  ).run(common);
  return 'updated';
}

export async function refresh(
  db: Database.Database,
  opts: { projectsDir?: string; now?: number; windowDays?: number } = {},
): Promise<{ scanned: number; changed: number; pruned: number }> {
  const projectsDir = opts.projectsDir ?? CLAUDE_PROJECTS_DIR;
  const now = opts.now ?? Date.now();
  const cutoff = windowCutoff(now, opts.windowDays);
  const files = listProjectJsonls(projectsDir);
  let changed = 0;
  for (const file of files) {
    let mtime: number;
    try {
      mtime = Math.floor(fs.statSync(file).mtimeMs);
    } catch {
      continue;
    }
    // Out-of-window: don't parse or index chats older than the active window.
    if (mtime < cutoff) continue;
    // Cheap skip before parsing: if mtime unchanged, don't read the file.
    const existing = db
      .prepare(`SELECT jsonl_mtime FROM chats WHERE jsonl_path = ?`)
      .get(file) as { jsonl_mtime: number } | undefined;
    if (existing && existing.jsonl_mtime === mtime) continue;

    let parsed: ParsedChat;
    try {
      parsed = await parseJsonlFile(file);
    } catch {
      continue; // one bad file never aborts the pass
    }
    if (!parsed.session_id) continue;
    if (isAnalyzerSession(parsed)) continue; // backstop for sessions created elsewhere
    const result = upsertChat(db, parsed, mtime, now);
    if (result !== 'unchanged') changed++;
  }
  // Remove rows that have aged out of the window (incl. ones indexed earlier).
  const pruned = pruneOld(db, cutoff);
  return { scanned: files.length, changed, pruned };
}
