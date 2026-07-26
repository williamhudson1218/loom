import fs from 'node:fs';
import readline from 'node:readline';
import { cleanText, localDay } from './parser.ts';
import type { ParsedChat } from './types.ts';

export async function parseCodexJsonlFile(jsonlPath: string): Promise<ParsedChat> {
  let session_id = '';
  let project_dir = '';
  let started_at = 0;
  let ended_at = 0;
  let message_count = 0;
  let first_message = '';
  let pr_url = '';
  const activity: Record<string, number> = {};

  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  for await (const line of rl) {
    if (!line.trim()) continue;
    if (line.includes('/pull/')) {
      const m = line.match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g);
      if (m) pr_url = m[m.length - 1];
    }
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj?.type === 'session_meta') {
      session_id ||= obj.payload?.session_id ?? obj.payload?.id ?? '';
      project_dir ||= obj.payload?.cwd ?? '';
    }

    let ts = 0;
    if (typeof obj?.timestamp === 'string') {
      const parsed = Date.parse(obj.timestamp);
      if (!Number.isNaN(parsed)) {
        ts = parsed;
        if (!started_at || ts < started_at) started_at = ts;
        if (ts > ended_at) ended_at = ts;
      }
    }

    if (obj?.type !== 'event_msg') continue;
    const payload = obj.payload;
    if (payload?.type === 'user_message') {
      message_count++;
      const text = typeof payload.message === 'string' ? cleanText(payload.message) : '';
      if (text && !first_message) first_message = text;
      if (ts) activity[localDay(ts)] = (activity[localDay(ts)] ?? 0) + 1;
    } else if (payload?.type === 'agent_message') {
      message_count++;
    }
  }

  return {
    agent: 'codex',
    session_id,
    project_dir,
    jsonl_path: jsonlPath,
    started_at,
    ended_at,
    last_active_at: ended_at,
    message_count,
    activity,
    files_touched: [],
    first_message,
    claude_auto_title: '',
    pr_url,
  };
}
