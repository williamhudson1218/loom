import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DIR } from './paths.ts';

// The "Copy details" bundle every error on the page offers, and Settings > About
// > Copy diagnostics. Plain text, redacted so it is safe to paste into a public
// GitHub issue: tokens, emails and the home folder never leave in it.
//
// Loom's own log is $LOOM_HOME/loom.log: installAppLog() tees console output
// into it (the packaged app has no terminal, so nothing else keeps it), capped
// by rotating to loom.log.1.

export const APP_LOG_PATH = path.join(TOOL_DIR, 'loom.log');
const LOG_CAP_BYTES = 2 * 1024 * 1024;
export const LOG_TAIL_LINES = 100;
const MAX_OUTPUT_CHARS = 20_000;

// ---------- redaction ----------

const SECRET_PATTERNS: [RegExp, string][] = [
  // Slack tokens (bot, user, app, config, refresh) and webhook paths.
  [/\bxox[a-z]-[A-Za-z0-9-]{6,}/gi, '[slack-token]'],
  [/\bxapp-[A-Za-z0-9-]{6,}/gi, '[slack-token]'],
  [/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/gi, 'hooks.slack.com/services/[redacted]'],
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ and fine-grained github_pat_.
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, '[github-token]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[github-token]'],
  // Google OAuth access and refresh tokens, Anthropic and OpenAI keys.
  [/\bya29\.[A-Za-z0-9._-]{10,}/g, '[google-token]'],
  [/\b1\/\/[A-Za-z0-9._-]{20,}/g, '[google-token]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[api-key]'],
  // Authorization headers and key=value secrets.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]'],
  [/\b(client_secret|access_token|refresh_token|password|secret|api_key|apikey|x-loom-[a-z-]*token)(["']?\s*[:=]\s*["']?)[^\s"'&,}]+/gi, '$1$2[redacted]'],
  // Email addresses.
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

/** Strip anything secret-shaped and turn the home folder (and any /Users/<name>) into ~. */
export function redact(text: string, home: string = os.homedir()): string {
  let s = String(text ?? '');
  for (const [re, rep] of SECRET_PATTERNS) s = s.replace(re, rep);
  if (home && home !== '/') s = s.split(home).join('~');
  s = s.replace(/\/Users\/[^/\s"']+/g, '~').replace(/\/home\/[^/\s"']+/g, '~');
  return s;
}

// ---------- Loom's own log ----------

let logFile: string | null = null;
let installed = false;

function rotateIfBig(file: string): void {
  try {
    if (fs.statSync(file).size > LOG_CAP_BYTES) fs.renameSync(file, `${file}.1`);
  } catch {
    /* no file yet */
  }
}

/** Append one line to Loom's log. Never throws. */
export function appLog(level: string, msg: string): void {
  if (!logFile) return;
  try {
    rotateIfBig(logFile);
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${level} ${msg.replace(/\n/g, '\n    ')}\n`, { mode: 0o600 });
  } catch {
    /* logging must never break Loom */
  }
}

/** Tee console.log/info/warn/error into the log file. Idempotent. */
export function installAppLog(file: string = APP_LOG_PATH): void {
  logFile = file;
  if (installed) return;
  installed = true;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  } catch {
    /* appLog swallows the failure */
  }
  for (const level of ['log', 'info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      appLog(level === 'log' ? 'info' : level, args.map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : safeJson(a))).join(' '));
    };
  }
  process.on('uncaughtExceptionMonitor', (e) => appLog('fatal', (e as Error)?.stack || String(e)));
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** The last n lines of the log (the rotated file fills in when the live one is short). */
export function tailLog(n: number = LOG_TAIL_LINES, file: string = logFile ?? APP_LOG_PATH): string[] {
  const read = (f: string): string[] => {
    try {
      const st = fs.statSync(f);
      const len = Math.min(st.size, 256 * 1024);
      const fd = fs.openSync(f, 'r');
      try {
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, st.size - len);
        const lines = buf.toString('utf8').split('\n');
        if (len < st.size) lines.shift(); // a partial first line
        return lines.filter((l) => l.length > 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return [];
    }
  };
  let lines = read(file);
  if (lines.length < n) lines = [...read(`${file}.1`), ...lines];
  return lines.slice(-n);
}

// ---------- build + environment ----------

export interface BuildInfo {
  version: string;
  commit: string;
  channel: string;
}

let build: BuildInfo = { version: 'source', commit: '', channel: 'local' };
/** app/main.ts registers the stamped build; a run from source keeps the default. */
export function setBuildInfo(b: BuildInfo): void {
  build = { ...b };
}

let macMemo: string | null = null;
function macosVersion(): string {
  if (macMemo !== null) return macMemo;
  if (process.platform !== 'darwin') return (macMemo = `${os.type()} ${os.release()}`);
  try {
    const name = execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 }).trim();
    const b = execFileSync('sw_vers', ['-buildVersion'], { encoding: 'utf8', timeout: 2000 }).trim();
    macMemo = `macOS ${name} (${b})`;
  } catch {
    macMemo = `Darwin ${os.release()}`;
  }
  return macMemo;
}

// ---------- the bundle ----------

export interface DiagInput {
  /** What failed, in a few words ("Install the Loom plugin"). Empty for Copy diagnostics. */
  what?: string;
  /** The error message shown on the page. */
  message?: string;
  /** Step output, e.g. the claude command's stdout and stderr. */
  output?: string;
}

export interface DiagEnv {
  build: BuildInfo;
  os: string;
  arch: string;
  claudeVersion: string | null;
  log: string[];
  home: string;
  now: Date;
}

export function currentEnv(claudeVersion: string | null): DiagEnv {
  return { build, os: macosVersion(), arch: `${process.arch}${process.platform === 'darwin' ? '' : ' ' + process.platform}`, claudeVersion, log: tailLog(), home: os.homedir(), now: new Date() };
}

const cap = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}\n[... ${s.length - n} more characters cut]` : s);

/** The plain-text bundle, redacted. Pure given env. */
export function diagnosticsText(input: DiagInput, env: DiagEnv): string {
  const out: string[] = [];
  const what = String(input.what ?? '').trim();
  const message = String(input.message ?? '').trim();
  const output = String(input.output ?? '').trim();
  out.push(what ? `Loom error: ${what}` : 'Loom diagnostics');
  out.push(`Copied: ${env.now.toISOString()}`);
  out.push('');
  if (what || message) {
    out.push('## What failed');
    if (what) out.push(what);
    if (message) out.push(`Message: ${message}`);
    out.push('');
  }
  if (output) {
    out.push('## Output');
    out.push(cap(output, MAX_OUTPUT_CHARS));
    out.push('');
  }
  out.push('## Environment');
  out.push(`Loom: ${env.build.version}${env.build.commit ? ` (${env.build.commit.slice(0, 12)})` : ''}, ${env.build.channel}`);
  out.push(`OS: ${env.os}`);
  out.push(`Arch: ${env.arch}`);
  out.push(`Claude Code: ${env.claudeVersion ?? 'unknown'}`);
  out.push('');
  out.push(`## Loom log (last ${env.log.length} lines)`);
  out.push(env.log.length ? env.log.join('\n') : '(empty)');
  return redact(out.join('\n'), env.home) + '\n';
}
