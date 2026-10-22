import fs from 'node:fs';
import readline from 'node:readline';
import type { ParsedChat } from './types.ts';

export function localDay(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit']);

// A record that is someone actually saying something: a user prompt (not a
// tool_result handed back to the model, not an injected system reminder) or an
// assistant message. Claude Code writes plenty else to a transcript — `system`,
// `ai-title`, `attachment`, `queue-operation`, `file-history-snapshot`, request
// blobs — often long after the conversation stopped, so "last record" is not
// "last activity"; a title rewrite at midnight would float a dead chat to the
// top of the board.
export function isTurnRecord(obj: any): boolean {
  const role = obj?.message?.role;
  if (obj?.type === 'assistant' && role === 'assistant') return true;
  if (obj?.type !== 'user' || role !== 'user' || obj.isMeta) return false;
  const c = obj.message.content;
  if (typeof c === 'string') return true;
  return Array.isArray(c) && c.some((b: any) => b?.type === 'text');
}

export const TAIL_TURN_BYTES = 256 * 1024;

// The last turn's timestamp from the end of a transcript, without reading the
// whole file: for a live chat the DB is up to an index pass stale, and the
// board poll needs the fresh value every few seconds. 0 when no turn is inside
// the tail (a huge tool result can push it out) or the file is unreadable — the
// caller keeps the value it has.
export function lastTurnAtFromTail(jsonlPath: string, bytes: number = TAIL_TURN_BYTES): number {
  let fd: number;
  try {
    fd = fs.openSync(jsonlPath, 'r');
  } catch {
    return 0;
  }
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines.shift(); // a partial first line
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(lines[i]);
      } catch {
        continue;
      }
      if (!isTurnRecord(obj)) continue;
      const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      if (!Number.isNaN(ts)) return ts;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

export async function parseJsonlFile(jsonlPath: string): Promise<ParsedChat> {
  let session_id = '';
  let project_dir = '';
  let started_at = 0;
  let ended_at = 0;
  let last_turn_at = 0;
  let message_count = 0;
  let first_message = '';
  let claude_auto_title = '';
  let pr_url = '';
  const activity: Record<string, number> = {};
  const files = new Set<string>();
  const written = new Set<string>();

  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    // Cheap scan of the raw line for GitHub PR URLs (anywhere: prose, gh output,
    // tool results). Last one in the transcript wins — usually the relevant PR.
    if (line.includes('/pull/')) {
      const m = line.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
      if (m) pr_url = m[m.length - 1];
    }
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue; // skip malformed line
    }

    if (typeof obj?.sessionId === 'string' && !session_id) session_id = obj.sessionId;
    if (typeof obj?.cwd === 'string' && !project_dir) project_dir = obj.cwd;

    let ts = 0;
    if (typeof obj?.timestamp === 'string') {
      const parsed = Date.parse(obj.timestamp);
      if (!Number.isNaN(parsed)) {
        ts = parsed;
        if (!started_at || ts < started_at) started_at = ts;
        if (ts > ended_at) ended_at = ts;
        if (ts > last_turn_at && isTurnRecord(obj)) last_turn_at = ts;
      }
    }

    // Auto-titles: prefer an explicit custom-title, else the ai-title.
    if (obj?.type === 'custom-title' && typeof obj.customTitle === 'string') {
      claude_auto_title = obj.customTitle;
    } else if (obj?.type === 'ai-title' && typeof obj.aiTitle === 'string' && !claude_auto_title) {
      claude_auto_title = obj.aiTitle;
    }

    if (obj?.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
      message_count++;
      const content = obj.message.content;
      const text = extractUserText(content);
      if (text && !first_message) first_message = text;
      if (ts) activity[localDay(ts)] = (activity[localDay(ts)] ?? 0) + 1;
      continue;
    }

    if (obj?.type === 'assistant' && obj.message?.role === 'assistant') {
      message_count++;
      const content = obj.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type !== 'tool_use') continue;
          if (!FILE_TOOLS.has(block.name)) continue;
          const fp = block.input?.file_path;
          if (typeof fp !== 'string') continue;
          files.add(fp);
          if (WRITE_TOOLS.has(block.name)) written.add(fp);
        }
      }
    }
  }

  return {
    agent: 'claude',
    session_id,
    project_dir,
    jsonl_path: jsonlPath,
    started_at,
    ended_at,
    last_active_at: ended_at,
    last_turn_at,
    message_count,
    activity,
    files_touched: Array.from(files),
    files_written: Array.from(written),
    first_message,
    claude_auto_title,
    pr_url,
  };
}

function extractUserText(content: unknown): string {
  if (typeof content === 'string') return cleanText(content);
  if (Array.isArray(content)) {
    for (const block of content as any[]) {
      if (block?.type === 'text' && typeof block.text === 'string') return cleanText(block.text);
    }
  }
  return '';
}

// Slash-command turns arrive wrapped in <command-name>/foo</command-name>
// <command-message>…</command-message> <command-args>…</command-args>. Unwrap the
// command name, drop the noise tags, so a "/clear" chat reads "/clear" not tag soup.
export function cleanText(raw: string): string {
  return raw
    // Boilerplate Claude prepends to slash-command turns. Drop the whole block —
    // unlike the stray-tag strip below, its *content* is noise too, and it would
    // otherwise become the visible heading of an archive card. The `|$` arm catches
    // a block cut short by truncation (an FTS snippet window can end mid-tag), which
    // would otherwise lose only the tag and leave the disclaimer prose behind.
    .replace(/<local-command-caveat>[\s\S]*?(?:<\/local-command-caveat>|$)/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // strip any other stray tags
    .replace(/\s+/g, ' ')
    .trim();
}
