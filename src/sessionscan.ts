import fs from 'node:fs';

// What the detail panel needs out of a transcript, gathered in one incremental
// pass: the files this session edited, its latest todo list, the background
// tasks it started and has not heard back from, and its last assistant message.
//
// Transcripts run to tens of MB, so the scan keeps a byte offset per file and
// only ever reads what was appended since the last selection. The parser is pure
// (`scanLines`) so the rules can be tested against literal JSONL.

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// A background launch answers with one of these; its completion arrives later as
// a <task-notification> naming the launching tool_use id.
const BACKGROUND_ACK = /running in background|Async agent launched|working in the background|Spawned successfully/i;
const NOTIFY_RE = /<task-notification>[\s\S]*?<tool-use-id>([^<\\]+)<\/tool-use-id>/g;
const BG_TTL_MS = 6 * 3_600_000; // a task that never reported back is not still running

export interface Todo {
  content: string;
  status: string;
  activeForm?: string;
}

export interface BackgroundTask {
  id: string; // the launching tool_use id
  kind: 'bash' | 'agent';
  desc: string;
  startedAt: number;
  taskId?: string; // the id TaskStop names, read off the launch acknowledgement
}

export interface ScanState {
  editedFiles: Record<string, number>; // absolute path -> last edit time (ms)
  todos: Todo[];
  launches: Record<string, BackgroundTask>; // candidate launches, not yet acknowledged
  background: Record<string, BackgroundTask>; // acknowledged as backgrounded, not yet finished
  lastAssistant: { text: string; at: number } | null;
  firstAt: number;
}

export function emptyScan(): ScanState {
  return { editedFiles: {}, todos: [], launches: {}, background: {}, lastAssistant: null, firstAt: 0 };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'tool_result' ? contentText(b.content) : ''))
    .join('\n');
}

export function scanLines(lines: string[], s: ScanState): ScanState {
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.isSidechain) continue;
    const at = Date.parse(o?.timestamp ?? '') || 0;
    if (at && !s.firstAt) s.firstAt = at;
    const content = o?.message?.content;
    if (o?.type === 'assistant' && Array.isArray(content)) {
      const text = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('\n').trim();
      if (text) s.lastAssistant = { text, at };
      for (const b of content) {
        if (b?.type !== 'tool_use') continue;
        const input = b.input ?? {};
        if (EDIT_TOOLS.has(b.name)) {
          const fp = input.file_path ?? input.notebook_path;
          if (typeof fp === 'string' && fp) s.editedFiles[fp] = at;
        } else if (b.name === 'TodoWrite' && Array.isArray(input.todos)) {
          s.todos = input.todos
            .filter((t: any) => t && typeof t.content === 'string')
            .map((t: any) => ({ content: t.content, status: String(t.status ?? ''), ...(t.activeForm ? { activeForm: String(t.activeForm) } : {}) }));
        } else if ((b.name === 'Bash' && input.run_in_background) || b.name === 'Agent' || b.name === 'Task') {
          const desc = String(input.description ?? input.command ?? input.prompt ?? '').split('\n')[0].slice(0, 120);
          s.launches[b.id] = { id: b.id, kind: b.name === 'Bash' ? 'bash' : 'agent', desc, startedAt: at };
        } else if (b.name === 'TaskStop' && typeof (input.task_id ?? input.shell_id) === 'string') {
          const stopped = input.task_id ?? input.shell_id;
          for (const t of Object.values(s.background)) if (t.taskId === stopped) delete s.background[t.id];
        }
      }
    } else if (o?.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b?.type !== 'tool_result' || !s.launches[b.tool_use_id]) continue;
          const launch = s.launches[b.tool_use_id];
          delete s.launches[b.tool_use_id];
          // A foreground call is finished the moment its result lands.
          const ack = contentText(b.content);
          if (BACKGROUND_ACK.test(ack)) {
            const tid = ack.match(/\b(?:with ID|agentId):?\s*([\w-]+)/i);
            s.background[launch.id] = tid ? { ...launch, taskId: tid[1] } : launch;
          }
        }
      }
    }
    // The completion notice arrives as a queue operation, an attachment or a user
    // turn depending on timing, so match it on the raw line whatever carries it.
    if (line.includes('<task-notification>')) {
      for (const m of line.matchAll(NOTIFY_RE)) delete s.background[m[1].trim()];
    }
  }
  return s;
}

export function runningBackground(s: ScanState, now: number = Date.now()): BackgroundTask[] {
  return Object.values(s.background)
    .filter((t) => !t.startedAt || now - t.startedAt < BG_TTL_MS)
    .sort((a, b) => a.startedAt - b.startedAt);
}

interface CacheEntry {
  offset: number;
  partial: Buffer; // bytes after the last newline, held until the line completes
  state: ScanState;
}
const cache = new Map<string, CacheEntry>();

// Incremental: reads only the bytes appended since the previous call for this
// file, carrying a split last line over. A file that shrank was rewritten, so
// it starts over.
export function scanTranscript(file: string): ScanState {
  let size: number;
  try {
    size = fs.statSync(file).size;
  } catch {
    return emptyScan();
  }
  let entry = cache.get(file);
  if (!entry || size < entry.offset) {
    entry = { offset: 0, partial: Buffer.alloc(0), state: emptyScan() };
    cache.set(file, entry);
  }
  if (size === entry.offset) return entry.state;
  const fd = fs.openSync(file, 'r');
  try {
    const CHUNK = 8 * 1024 * 1024;
    while (entry.offset < size) {
      const len = Math.min(CHUNK, size - entry.offset);
      const buf = Buffer.alloc(len);
      const n = fs.readSync(fd, buf, 0, len, entry.offset);
      if (n <= 0) break;
      entry.offset += n;
      // Split on the byte, not the decoded string: a chunk edge can fall inside
      // a multi-byte character, and only whole lines are ever decoded.
      const all = Buffer.concat([entry.partial, buf.subarray(0, n)]);
      const cut = all.lastIndexOf(0x0a);
      if (cut < 0) {
        entry.partial = all;
        continue;
      }
      entry.partial = all.subarray(cut + 1);
      scanLines(all.subarray(0, cut).toString('utf-8').split('\n'), entry.state);
    }
  } finally {
    fs.closeSync(fd);
  }
  return entry.state;
}
