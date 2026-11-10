import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';

// An always-on event log for the Slack pick hotkey and the dashboard's Resume,
// at $LOOM_HOME/pick.log. "It sometimes takes two clicks" is not reproducible on
// demand, so every press leaves a trace that can be read after the fact: one line
// per event, `<iso time> <press id> <event> key=value…`.
//
// What it never holds: message text, authors, prompts or context. Only event
// names, phases, reasons, timings, coordinates, pane / session ids and Slack
// channel ids. `clean` enforces that for every caller, so a field named `text`
// passed by mistake is dropped rather than written.

export const PICK_LOG_PATH = path.join(TOOL_DIR, 'pick.log');
export const PICK_LOG_MAX_BYTES = 1024 * 1024;

// Fields that may carry what someone wrote. Never logged, whatever the caller passes.
const BANNED = new Set(['text', 'author', 'context', 'prompt', 'body', 'message', 'snippet', 'title']);

export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

/** A value as one log token: numbers rounded to 0.1, strings without spaces or newlines, capped. */
function token(v: LogValue): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(1);
  if (typeof v === 'boolean') return v ? '1' : '0';
  const s = String(v ?? '').replace(/\s+/g, '_');
  return s.length > 120 ? s.slice(0, 119) + '…' : s;
}

/** A Slack permalink reduced to its channel id; anything else passes through `token`. */
export function channelOnly(url: string): string {
  const m = /\/archives\/([A-Z0-9]+)/.exec(url);
  return m ? m[1] : '';
}

export function formatLine(at: Date, id: string, event: string, fields: LogFields = {}): string {
  const parts = [at.toISOString(), id || '-', token(event)];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || BANNED.has(k.toLowerCase())) continue;
    // A URL may only appear as its channel id.
    const val = typeof v === 'string' && /^https?:\/\//.test(v) ? channelOnly(v) : v;
    parts.push(`${k}=${token(val)}`);
  }
  return parts.join(' ') + '\n';
}

export interface PickLogOpts {
  file?: string;
  maxBytes?: number;
  now?: () => Date;
}

/**
 * Appends to the log, rotating to `<file>.1` once it passes `maxBytes` (one old
 * generation is kept). Never throws: a log that cannot be written must not break
 * the hotkey.
 */
export class PickLog {
  private readonly file: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private size = -1;
  constructor(opts: PickLogOpts = {}) {
    this.file = opts.file ?? PICK_LOG_PATH;
    this.maxBytes = opts.maxBytes ?? PICK_LOG_MAX_BYTES;
    this.now = opts.now ?? (() => new Date());
  }
  write(id: string, event: string, fields: LogFields = {}): void {
    const line = formatLine(this.now(), id, event, fields);
    try {
      if (this.size < 0) {
        try {
          this.size = fs.statSync(this.file).size;
        } catch {
          this.size = 0;
        }
      }
      if (this.size + line.length > this.maxBytes && this.size > 0) {
        fs.renameSync(this.file, this.file + '.1');
        this.size = 0;
      }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, line);
      this.size += Buffer.byteLength(line);
    } catch {
      this.size = -1; // re-stat next time
    }
  }
}

let shared: PickLog | null = null;
/** The process-wide log at PICK_LOG_PATH. */
export function pickLog(): PickLog {
  return (shared ??= new PickLog());
}

let seq = 0;
/** A short id tying one press's lines together: `p<base36 time><n>`. */
export function newPressId(prefix = 'p'): string {
  seq = (seq + 1) % 1296;
  return prefix + Date.now().toString(36).slice(-5) + seq.toString(36).padStart(2, '0');
}
