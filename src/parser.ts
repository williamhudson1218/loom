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

export async function parseJsonlFile(jsonlPath: string): Promise<ParsedChat> {
  let session_id = '';
  let project_dir = '';
  let started_at = 0;
  let ended_at = 0;
  let message_count = 0;
  let first_message = '';
  let claude_auto_title = '';
  let pr_url = '';
  const activity: Record<string, number> = {};
  const files = new Set<string>();

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
          if (FILE_TOOLS.has(block.name)) {
            const fp = block.input?.file_path;
            if (typeof fp === 'string') files.add(fp);
          }
        }
      }
    }
  }

  return {
    session_id,
    project_dir,
    jsonl_path: jsonlPath,
    started_at,
    ended_at,
    last_active_at: ended_at,
    message_count,
    activity,
    files_touched: Array.from(files),
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
    // otherwise become the visible heading of an archive card.
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .replace(/<command-args>[\s\S]*?<\/command-args>/g, '')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<\/?[a-zA-Z][^>]*>/g, '') // strip any other stray tags
    .replace(/\s+/g, ' ')
    .trim();
}
