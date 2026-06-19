import fs from 'node:fs';
import readline from 'node:readline';
import { execFile } from 'node:child_process';
import type Database from 'better-sqlite3';
import {
  TRANSCRIPT_CHAR_CAP,
  ANALYZE_CAP,
  ANALYZE_CONCURRENCY,
  MIN_MESSAGES_FOR_LLM,
  SUMMARY_PROMPT_PREAMBLE,
  TOOL_DIR,
} from './paths.ts';
import type { Summary, ChatRow, ChatState } from './types.ts';
import { CHAT_STATES } from './types.ts';

export type ClaudeRunner = (prompt: string) => Promise<string>;

export async function transcriptToText(
  jsonlPath: string,
  cap: number = TRANSCRIPT_CHAR_CAP,
): Promise<string> {
  const lines: string[] = [];
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj?.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
      const t = flatten(obj.message.content);
      if (t) lines.push(`USER: ${t}`);
    } else if (obj?.type === 'assistant' && obj.message?.role === 'assistant') {
      const t = flatten(obj.message.content);
      if (t) lines.push(`ASSISTANT: ${t}`);
    }
  }
  const text = lines.join('\n');
  if (text.length <= cap) return text;
  const half = Math.floor(cap / 2);
  return text.slice(0, half) + '\n…[transcript truncated]…\n' + text.slice(-half);
}

function flatten(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content as any[]) {
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text.trim());
      else if (b?.type === 'tool_use' && typeof b.name === 'string') parts.push(`[tool:${b.name}]`);
    }
    return parts.join(' ').trim();
  }
  return '';
}

export function buildPrompt(transcriptText: string): string {
  return [
    SUMMARY_PROMPT_PREAMBLE,
    'Read the transcript and respond with ONLY a JSON object — no prose, no markdown fences.',
    'Schema:',
    '{',
    '  "title": string,        // <= 8 words, specific, never "Claude Code"',
    '  "overview": string,     // one sentence, <= 25 words',
    '  "state": "done" | "waiting_on_user" | "warning" | "error",',
    '  "key_moments": string[] // past-tense bullets of the important steps/decisions/errors',
    '}',
    '',
    'state — judge from how the session ENDS (whose court the ball is in):',
    '  "waiting_on_user" if the last thing is Claude asking a question, offering options, or needing your input/decision.',
    '  "error" if it ended on an unresolved error, failed command, or is blocked and cannot proceed.',
    '  "warning" if work finished but with caveats, unverified results, or unresolved non-blocking issues.',
    '  "done" if it finished cleanly with nothing left for the user to do.',
    '',
    'key_moments — 3 to 7 bullets, MORE for longer/complex sessions, fewer for short ones.',
    '  Capture decisions, fixes, errors, and turning points. The LAST bullet is the current status / where it left off.',
    '',
    'Transcript:',
    '"""',
    transcriptText,
    '"""',
  ].join('\n');
}

export function parseSummary(raw: string): Summary {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('no JSON object found in response');
  }
  let obj: any;
  try {
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    throw new Error(`invalid JSON in response: ${(e as Error).message}`);
  }
  const moments = Array.isArray(obj.key_moments)
    ? obj.key_moments
    : Array.isArray(obj.breakdown)
      ? obj.breakdown
      : null;
  if (typeof obj.title !== 'string' || typeof obj.overview !== 'string' || !moments) {
    throw new Error('JSON missing required fields');
  }
  const state: ChatState = CHAT_STATES.includes(obj.state) ? obj.state : 'done';
  return {
    title: obj.title.trim(),
    overview: obj.overview.trim(),
    state,
    breakdown: moments.map((b: unknown) => String(b)),
  };
}

// Default runner: headless `claude -p`. The prompt is passed on the CLI; the
// model's text reply (expected JSON) is returned from stdout.
//   --safe-mode : disable ALL customizations incl. HOOKS (also skills/MCP/plugins,
//       none needed for summarizing). Critical: this is what stops the user's Stop
//       hook (Purr sound + notification) from firing on every background call.
//       `--setting-sources project` did NOT suppress hooks; `--bare` breaks auth.
//       --safe-mode keeps auth (keychain) intact.
//   --no-session-persistence : don't write these calls' own session transcripts
//       to disk (otherwise chat-manager would index its own summarization prompts).
export const defaultRunner: ClaudeRunner = (prompt: string) =>
  new Promise((resolve, reject) => {
    execFile(
      'claude',
      ['-p', '--safe-mode', '--no-session-persistence', prompt],
      { cwd: TOOL_DIR, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      },
    );
  });

async function pool<T>(items: T[], size: number, worker: (item: T) => Promise<void>): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]);
    }
  });
  await Promise.all(runners);
}

function heuristicTitle(firstMessage: string): string {
  const t = firstMessage.replace(/\s+/g, ' ').trim();
  if (!t) return 'Untitled chat';
  const words = t.split(' ').slice(0, 8).join(' ');
  return words.length > 60 ? words.slice(0, 60) + '…' : words;
}

export async function summarizeDirty(
  db: Database.Database,
  runner: ClaudeRunner,
  opts: { cap?: number; concurrency?: number; now?: number; model?: string } = {},
): Promise<{ attempted: number; succeeded: number; failed: number; heuristic: number }> {
  const cap = opts.cap ?? ANALYZE_CAP;
  const concurrency = opts.concurrency ?? ANALYZE_CONCURRENCY;
  const now = opts.now ?? Date.now();
  const model = opts.model ?? 'claude-code';

  const rows = db
    .prepare(`SELECT * FROM chats WHERE summary_dirty = 1 ORDER BY last_active_at ASC LIMIT ?`)
    .all(cap) as ChatRow[];

  const writeSummary = db.prepare(
    `UPDATE chats SET title=@title, overview=@overview, state=@state, breakdown_json=@breakdown_json,
       summary_dirty=0, summary_model=@summary_model, summary_at=@summary_at
     WHERE session_id=@session_id`,
  );

  let succeeded = 0;
  let failed = 0;
  let heuristic = 0;

  await pool(rows, concurrency, async (row) => {
    // Tiny chats: heuristic title, no LLM call.
    if (row.message_count < MIN_MESSAGES_FOR_LLM) {
      writeSummary.run({
        title: heuristicTitle(row.first_message),
        overview: '',
        state: 'done',
        breakdown_json: '[]',
        summary_model: 'heuristic',
        summary_at: now,
        session_id: row.session_id,
      });
      heuristic++;
      return;
    }
    try {
      const text = await transcriptToText(row.jsonl_path);
      const raw = await runner(buildPrompt(text));
      const summary = parseSummary(raw);
      writeSummary.run({
        title: summary.title,
        overview: summary.overview,
        state: summary.state,
        breakdown_json: JSON.stringify(summary.breakdown),
        summary_model: model,
        summary_at: now,
        session_id: row.session_id,
      });
      succeeded++;
    } catch {
      // Leave dirty for retry next pass.
      failed++;
    }
  });

  return { attempted: rows.length, succeeded, failed, heuristic };
}
