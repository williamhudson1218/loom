import fs from 'node:fs';
import readline from 'node:readline';
import { githubRemotesOf, pickPrUrl, prUrlsIn } from './prpick.ts';
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
    return lastTurnIn(buf, start > 0);
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

/** lastTurnAtFromTail with the read off the main thread. */
export async function lastTurnAtFromTailAsync(jsonlPath: string, bytes: number = TAIL_TURN_BYTES): Promise<number> {
  let fh: fs.promises.FileHandle;
  try {
    fh = await fs.promises.open(jsonlPath, 'r');
  } catch {
    return 0;
  }
  try {
    const size = (await fh.stat()).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return lastTurnIn(buf, start > 0);
  } catch {
    return 0;
  } finally {
    await fh.close();
  }
}

function lastTurnIn(buf: Buffer, partialFirst: boolean): number {
  const lines = buf.toString('utf-8').split('\n');
  if (partialFirst) lines.shift(); // a partial first line
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
}
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);

// The fold a transcript parse is: every field of ParsedChat is a running
// aggregate over the lines in file order, so the same accumulator serves a whole
// file (parseJsonlFile) and a file read a tail at a time (TranscriptCache).
export interface ChatAcc {
  session_id: string;
  project_dir: string;
  started_at: number;
  ended_at: number;
  last_turn_at: number;
  message_count: number;
  first_message: string;
  claude_auto_title: string;
  prUrls: Map<string, true>; // insertion order = last seen
  activity: Record<string, number>;
  files: Set<string>;
  written: Set<string>;
}

export function newChatAcc(): ChatAcc {
  return { session_id: '', project_dir: '', started_at: 0, ended_at: 0, last_turn_at: 0, message_count: 0, first_message: '', claude_auto_title: '', prUrls: new Map(), activity: {}, files: new Set(), written: new Set() };
}

function cloneChatAcc(a: ChatAcc): ChatAcc {
  return { ...a, prUrls: new Map(a.prUrls), activity: { ...a.activity }, files: new Set(a.files), written: new Set(a.written) };
}

/** Fold one transcript line into the accumulator. */
export function feedChatLine(acc: ChatAcc, line: string): void {
  if (!line.trim()) return;
  // Cheap scan of the raw line for GitHub PR URLs (anywhere: prose, gh output,
  // tool results), last-seen order. The pick at the end keeps only the chat's
  // own repo's PRs (src/prpick.ts), so a quoted example URL is never its PR.
  for (const u of prUrlsIn(line)) {
    acc.prUrls.delete(u);
    acc.prUrls.set(u, true);
  }
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return; // skip malformed line
  }

  if (typeof obj?.sessionId === 'string' && !acc.session_id) acc.session_id = obj.sessionId;
  if (typeof obj?.cwd === 'string' && !acc.project_dir) acc.project_dir = obj.cwd;

  let ts = 0;
  if (typeof obj?.timestamp === 'string') {
    const parsed = Date.parse(obj.timestamp);
    if (!Number.isNaN(parsed)) {
      ts = parsed;
      if (!acc.started_at || ts < acc.started_at) acc.started_at = ts;
      if (ts > acc.ended_at) acc.ended_at = ts;
      if (ts > acc.last_turn_at && isTurnRecord(obj)) acc.last_turn_at = ts;
    }
  }

  // Auto-titles: prefer an explicit custom-title, else the ai-title.
  if (obj?.type === 'custom-title' && typeof obj.customTitle === 'string') {
    acc.claude_auto_title = obj.customTitle;
  } else if (obj?.type === 'ai-title' && typeof obj.aiTitle === 'string' && !acc.claude_auto_title) {
    acc.claude_auto_title = obj.aiTitle;
  }

  if (obj?.type === 'user' && obj.message?.role === 'user' && !obj.isMeta) {
    acc.message_count++;
    const text = extractUserText(obj.message.content);
    if (text && !acc.first_message) acc.first_message = text;
    if (ts) acc.activity[localDay(ts)] = (acc.activity[localDay(ts)] ?? 0) + 1;
    return;
  }

  if (obj?.type === 'assistant' && obj.message?.role === 'assistant') {
    acc.message_count++;
    const content = obj.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type !== 'tool_use') continue;
        if (!FILE_TOOLS.has(block.name)) continue;
        const fp = block.input?.file_path;
        if (typeof fp !== 'string') continue;
        acc.files.add(fp);
        if (WRITE_TOOLS.has(block.name)) acc.written.add(fp);
      }
    }
  }
}

/** The ParsedChat an accumulator stands for. */
export function chatFromAcc(acc: ChatAcc, jsonlPath: string): ParsedChat {
  return {
    agent: 'claude',
    session_id: acc.session_id,
    project_dir: acc.project_dir,
    jsonl_path: jsonlPath,
    started_at: acc.started_at,
    ended_at: acc.ended_at,
    last_active_at: acc.ended_at,
    last_turn_at: acc.last_turn_at,
    message_count: acc.message_count,
    activity: { ...acc.activity },
    files_touched: Array.from(acc.files),
    files_written: Array.from(acc.written),
    first_message: acc.first_message,
    claude_auto_title: acc.claude_auto_title,
    pr_url: pickPrUrl([...acc.prUrls.keys()], acc.prUrls.size ? githubRemotesOf(acc.project_dir) : null),
  };
}

export async function parseJsonlFile(jsonlPath: string): Promise<ParsedChat> {
  const acc = newChatAcc();
  const stream = fs.createReadStream(jsonlPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) feedChatLine(acc, line);
  return chatFromAcc(acc, jsonlPath);
}

// ---- incremental parsing ------------------------------------------------------
//
// A live transcript only ever grows by appended lines, yet every change used to
// re-read and re-parse the whole file (278 ms for a 90 MB transcript, on
// Electron's main thread). TranscriptCache keeps, per file, the accumulator plus
// the byte offset it has read to, and parses only what was appended since.
//
//   - Only whole lines are folded in. A trailing line still being written is
//     carried over as bytes (it may end mid UTF-8 sequence) and re-read with
//     the next chunk; for the result it is folded into a throwaway copy, so the
//     answer matches a whole-file parse of the file as it stands right now.
//   - A file that was replaced (new inode), shrank, or whose bytes just before
//     the offset no longer match what was read is parsed again from the start.
//   - Reads are async and in bounded chunks, so neither the first parse of a
//     huge transcript nor a big append holds the file in memory or the thread.
//   - At most `max` files are kept (least recently used dropped); an entry is
//     the aggregates only (ids, counts, file and URL sets), never the text.

const CHUNK_BYTES = 1024 * 1024;
const GUARD_BYTES = 64;

interface TranscriptEntry {
  ino: number;
  offset: number; // bytes folded in, plus the carried partial line
  guard: Buffer; // the last bytes before `offset`, to notice an in-place rewrite
  carry: Buffer; // a trailing line with no newline yet
  acc: ChatAcc;
}

export class TranscriptCache {
  private entries = new Map<string, TranscriptEntry>();
  private inflight = new Map<string, Promise<ParsedChat>>();
  private readonly max: number;
  private readonly chunkBytes: number;
  constructor(opts: { max?: number; chunkBytes?: number } = {}) {
    this.max = opts.max ?? 64;
    this.chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  }

  get size(): number {
    return this.entries.size;
  }

  /** The parse of `jsonlPath` as it is now; reads only what was appended since the last call. */
  parse(jsonlPath: string): Promise<ParsedChat> {
    // Two callers asking at once share one read: interleaved reads would fold the same bytes twice.
    const hit = this.inflight.get(jsonlPath);
    if (hit) return hit;
    const p = this.read(jsonlPath).finally(() => {
      if (this.inflight.get(jsonlPath) === p) this.inflight.delete(jsonlPath);
    });
    this.inflight.set(jsonlPath, p);
    return p;
  }

  forget(jsonlPath: string): void {
    this.entries.delete(jsonlPath);
  }

  private async read(jsonlPath: string): Promise<ParsedChat> {
    const fh = await fs.promises.open(jsonlPath, 'r');
    try {
      const st = await fh.stat();
      let e = this.entries.get(jsonlPath);
      this.entries.delete(jsonlPath); // re-inserted below: most recently used last
      if (e && (e.ino !== st.ino || st.size < e.offset || !(await guardHolds(fh, e)))) e = undefined;
      if (!e) e = { ino: st.ino, offset: 0, guard: Buffer.alloc(0), carry: Buffer.alloc(0), acc: newChatAcc() };
      // A throw leaves the entry out of the map: a half-folded chunk is never kept.
      await foldFrom(fh, e, st.size, this.chunkBytes);
      this.entries.set(jsonlPath, e);
      while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
      // A trailing line with no newline: count it as a whole-file parse would, on a copy.
      if (e.carry.length && e.carry.toString('utf-8').trim()) {
        const acc = cloneChatAcc(e.acc);
        feedChatLine(acc, stripCr(e.carry.toString('utf-8')));
        return chatFromAcc(acc, jsonlPath);
      }
      return chatFromAcc(e.acc, jsonlPath);
    } finally {
      await fh.close();
    }
  }
}

async function guardHolds(fh: fs.promises.FileHandle, e: TranscriptEntry): Promise<boolean> {
  if (!e.guard.length) return true;
  const buf = Buffer.alloc(e.guard.length);
  const { bytesRead } = await fh.read(buf, 0, buf.length, e.offset - e.guard.length);
  return bytesRead === buf.length && buf.equals(e.guard);
}

const stripCr = (line: string): string => (line.endsWith('\r') ? line.slice(0, -1) : line);

/** Fold whole lines from e.offset up to `size` into e.acc; keep a trailing partial line in e.carry. */
async function foldFrom(fh: fs.promises.FileHandle, e: TranscriptEntry, size: number, chunkBytes: number): Promise<void> {
  let pos = e.offset;
  while (pos < size) {
    const want = Math.min(chunkBytes, size - pos);
    const chunk = Buffer.alloc(want);
    const { bytesRead } = await fh.read(chunk, 0, want, pos);
    if (!bytesRead) break;
    pos += bytesRead;
    const data = e.carry.length ? Buffer.concat([e.carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
    const end = data.lastIndexOf(0x0a) + 1; // a newline byte never sits inside a UTF-8 sequence
    if (end > 0) {
      for (const line of data.toString('utf-8', 0, end - 1).split('\n')) feedChatLine(e.acc, stripCr(line));
    }
    e.carry = Buffer.from(data.subarray(end)); // a copy: never pin the chunk
    e.offset = pos;
    const tail = Buffer.concat([e.guard, data.subarray(Math.max(0, data.length - GUARD_BYTES))]);
    e.guard = Buffer.from(tail.subarray(Math.max(0, tail.length - GUARD_BYTES)));
  }
}

/** The cache the live and full index passes share. */
export const transcriptCache = new TranscriptCache();

/** parseJsonlFile through the shared incremental cache. */
export function parseJsonlFileCached(jsonlPath: string): Promise<ParsedChat> {
  return transcriptCache.parse(jsonlPath);
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
