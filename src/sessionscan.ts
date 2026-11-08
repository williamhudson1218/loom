import fs from 'node:fs';
import path from 'node:path';

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
const SHIP_CMD = /<command-name>\/?ship<\/command-name>/;
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
  editedFirst: Record<string, number>; // absolute path -> first edit time (ms)
  shipCmds: number[]; // when this session ran /ship
  todos: Todo[];
  launches: Record<string, BackgroundTask>; // candidate launches, not yet acknowledged
  background: Record<string, BackgroundTask>; // acknowledged as backgrounded, not yet finished
  lastAssistant: { text: string; at: number } | null;
  firstAt: number;
  cwd?: string; // the session's working directory, for Bash paths given relative
}

export function emptyScan(): ScanState {
  return { editedFiles: {}, editedFirst: {}, shipCmds: [], todos: [], launches: {}, background: {}, lastAssistant: null, firstAt: 0 };
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : b?.type === 'tool_result' ? contentText(b.content) : ''))
    .join('\n');
}

/**
 * Files a Bash command writes or stages, as absolute paths. Agents often edit with
 * a shell (python heredocs, sed -i, cat > f) instead of Edit/Write, and finish with
 * `git add <paths>`; both say this chat owns those files. Best effort: a path is
 * only taken from a recognised write or `git add`, never from a mere read.
 */
export function bashWrittenFiles(cmd: string, cwd: string): string[] {
  const out = new Set<string>();
  const home = process.env.HOME ?? '~';
  const clean = (t: string) => t.replace(/^['"]|['"]$/g, '').replace(/^~(?=\/)/, home);
  const usable = (t: string) => !!t && !t.startsWith('-') && !/[$`*?{}<>|;&()=]/.test(t) && t !== '.' && t !== '/dev/null' && /[/.]/.test(t);
  // Heredoc bodies are data (python, file contents), not shell: lift them out so a `>`
  // in code is never read as a redirect, and scan them for python writes on their own.
  const bodies: string[] = [];
  const shell = cmd.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n([\s\S]*?)\n\s*\2\s*(?=\n|$)/g, (_m, _q, _tag, rest: string, body: string) => {
    bodies.push(body);
    return `<<__BODY${bodies.length - 1}__${rest}`;
  });
  let base = cwd;
  const add = (t: string) => {
    const v = clean(t);
    if (usable(v)) out.add(path.resolve(base, v));
  };
  const pyWrites = (code: string) => {
    const vars = new Map<string, string>();
    for (const m of code.matchAll(/\b([A-Za-z_]\w*)\s*=\s*(['"])([^'"\n]+)\2/g)) vars.set(m[1], m[3]);
    const lit = (t: string) => (/^['"]/.test(t) ? t.slice(1, -1) : vars.get(t));
    for (const m of code.matchAll(/\bopen\(\s*('[^']+'|"[^"]+"|[A-Za-z_]\w*)\s*,\s*['"][wa]b?\+?['"]/g)) {
      const v = lit(m[1]);
      if (v) add(v);
    }
    for (const m of code.matchAll(/\bPath\(\s*('[^']+'|"[^"]+"|[A-Za-z_]\w*)\s*\)\.write_(?:text|bytes)\(/g)) {
      const v = lit(m[1]);
      if (v) add(v);
    }
  };
  // Walk the command step by step so each `cd` moves the base for what follows it.
  for (const seg of shell.split(/&&|\|\||;|\n/)) {
    const cd = seg.match(/^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*$/);
    if (cd) {
      base = path.resolve(base, clean(cd[1]));
      continue;
    }
    // git add <paths>. -A / -u / . stage everything: no owner signal.
    const ga = seg.match(/\bgit\s+(?:-C\s+\S+\s+)?add\s+(.+)$/);
    if (ga) for (const t of ga[1].trim().split(/\s+/)) if (t !== '--') add(t);
    // sed -i / perl -pi: the file arguments after the script.
    const sd = seg.match(/\b(?:sed\s+-i(?:\s*''|\s*""|\.\w+)?|perl\s+-p?i\S*)\s+(.+)$/);
    if (sd) for (const t of (sd[1].match(/'[^']*'|"[^"]*"|\S+/g) ?? []).slice(1)) if (!t.startsWith('-')) add(t);
    // Redirects and tee: > f, >> f, tee [-a] f. Skips fd redirects (2>, &>).
    for (const m of seg.matchAll(/(?:^|[^0-9&>])>>?\s*("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) add(m[1]);
    for (const m of seg.matchAll(/\btee\s+(?:-a\s+)?("[^"]+"|'[^']+'|[^\s;&|<>]+)/g)) add(m[1]);
    // python -c "..." inline, and any heredoc fed to this step.
    if (/\bpython3?\b/.test(seg)) pyWrites(seg);
    for (const m of seg.matchAll(/__BODY(\d+)__/g)) if (/\bpython3?\b|\bnode\b/.test(seg)) pyWrites(bodies[Number(m[1])]);
  }
  return [...out];
}

export interface ScanOpts {
  /** A subagent's own transcript: every line is a sidechain, and its edits are what we want. */
  sidechain?: boolean;
}

export function scanLines(lines: string[], s: ScanState, opts: ScanOpts = {}): ScanState {
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.isSidechain && !opts.sidechain) continue;
    const at = Date.parse(o?.timestamp ?? '') || 0;
    if (typeof o?.cwd === 'string' && o.cwd) s.cwd = o.cwd;
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
          if (typeof fp === 'string' && fp) {
            s.editedFiles[fp] = at;
            if (!(fp in s.editedFirst)) s.editedFirst[fp] = at;
          }
        } else if (b.name === 'Bash' && typeof input.command === 'string' && s.cwd) {
          for (const fp of bashWrittenFiles(input.command, s.cwd)) {
            s.editedFiles[fp] = at;
            if (!(fp in s.editedFirst)) s.editedFirst[fp] = at;
          }
          if (input.run_in_background) {
            const desc = String(input.description ?? input.command ?? '').split('\n')[0].slice(0, 120);
            s.launches[b.id] = { id: b.id, kind: 'bash', desc, startedAt: at };
          }
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
      // A slash command arrives as the user turn's text; /ship is what makes a ship's runner.
      if (at && SHIP_CMD.test(typeof content === 'string' ? content : contentText(content))) s.shipCmds.push(at);
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
export function scanTranscript(file: string, opts: ScanOpts = {}): ScanState {
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
      scanLines(all.subarray(0, cut).toString('utf-8').split('\n'), entry.state, opts);
    }
  } finally {
    fs.closeSync(fd);
  }
  return entry.state;
}

/**
 * The files a chat edited, its subagents included: Claude Code keeps each
 * subagent's transcript under `<session>/subagents/*.jsonl`, and work a chat
 * delegates is still that chat's work. Absolute path -> { first, last } edit time.
 */
export function chatEditedFiles(jsonlPath: string): { last: Record<string, number>; first: Record<string, number> } {
  const main = scanTranscript(jsonlPath);
  const last = { ...main.editedFiles };
  const first = { ...main.editedFirst };
  const dir = path.join(jsonlPath.replace(/\.jsonl$/, ''), 'subagents');
  let subs: string[] = [];
  try {
    subs = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    /* no subagents */
  }
  for (const f of subs) {
    const s = scanTranscript(path.join(dir, f), { sidechain: true });
    for (const [fp, at] of Object.entries(s.editedFiles)) last[fp] = Math.max(last[fp] ?? 0, at);
    for (const [fp, at] of Object.entries(s.editedFirst)) first[fp] = fp in first ? Math.min(first[fp], at) : at;
  }
  return { last, first };
}
