import { spawn, execFile, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Connect GitHub: Loom runs `gh auth login --web` for the person, shows the
// one-time code gh prints with a Copy button, opens github.com/login/device in the
// default browser, and waits for gh to exit. gh keeps the token in its own store;
// Loom never sees it. An existing login is never touched: starting a login while
// gh is signed in is refused unless the person asked to sign in again.
//
// When gh is missing and Homebrew is there, Loom can run `brew install gh` and
// stream its output. Otherwise the page links to cli.github.com.

export const DEVICE_URL = 'https://github.com/login/device';
export const GH_LOGIN_ARGS = ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https'] as const;
const JOB_TTL_MS = 15 * 60_000;
const MAX_LOG = 200;

/** The one-time code in gh's output ("First copy your one-time code: ABCD-1234"). */
export function parseDeviceCode(text: string): string {
  const m = /one-time code:?\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(text.replace(/\x1b\[[0-9;]*m/g, ''));
  return m ? m[1].toUpperCase() : '';
}

/** The account in `gh auth status` output, or '' (older and newer wordings). */
export function parseGhLogin(text: string): string {
  const t = text.replace(/\x1b\[[0-9;]*m/g, '');
  const m = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/.exec(t);
  return m ? m[1] : '';
}

/* ------------------------------------------------------------- tool lookup */

const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/** A binary on PATH or in the usual Homebrew folders, else ''. Finder-launched apps have a short PATH. */
export function findBin(name: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = isExec): string {
  const dirs = [...(env.PATH ?? '').split(':').filter(Boolean), ...EXTRA_DIRS];
  for (const d of dirs) {
    const p = path.join(d, name);
    if (exists(p)) return p;
  }
  return '';
}

function isExec(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- status */

export interface GhStatus {
  state: 'ok' | 'unauth' | 'missing' | 'unknown';
  login: string;
}

/** `gh auth status --hostname github.com`: read-only, changes nothing. */
export function ghStatusVia(bin: string, timeoutMs = 8000): Promise<GhStatus> {
  if (!bin) return Promise.resolve({ state: 'missing', login: '' });
  return new Promise((resolve) => {
    try {
      execFile(bin, ['auth', 'status', '--hostname', 'github.com'], { timeout: timeoutMs, env: { ...process.env, NO_COLOR: '1', GH_PROMPT_DISABLED: '1' } }, (err, out, errOut) => {
        const text = String(out ?? '') + '\n' + String(errOut ?? '');
        if (!err) return resolve({ state: 'ok', login: parseGhLogin(text) });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return resolve({ state: 'missing', login: '' });
        if (e.killed) return resolve({ state: 'unknown', login: '' });
        resolve({ state: 'unauth', login: '' });
      });
    } catch {
      resolve({ state: 'unknown', login: '' });
    }
  });
}

/* ----------------------------------------------------------------- jobs */

export type JobKind = 'login' | 'install';
export type JobState = 'running' | 'ok' | 'error' | 'cancelled';
export interface Job {
  id: number;
  kind: JobKind;
  state: JobState;
  /** login: the one-time code once gh printed it. */
  code: string;
  url: string;
  /** The last lines of output (install progress, or why a login failed). No tokens: gh never prints one. */
  log: string[];
  error: string;
  startedAt: number;
  endedAt: number;
}

export type Spawner = (bin: string, args: readonly string[], env: NodeJS.ProcessEnv) => ChildProcess;
const defaultSpawn: Spawner = (bin, args, env) => spawn(bin, [...args], { stdio: ['pipe', 'pipe', 'pipe'], env });

export interface GhConnectDeps {
  spawn?: Spawner;
  /** Opens the device page in the default browser (the Electron main process does it via the page). */
  onCode?: (code: string, url: string) => void;
  /** After a login or install ends: refresh the header's cached gh status. */
  onDone?: (job: Job) => void;
  now?: () => number;
  timeoutMs?: number;
}

/**
 * One job at a time. The page polls job() and shows the code, the log, and the
 * result; cancel() kills the child.
 */
export function makeGhConnect(deps: GhConnectDeps = {}) {
  const sp = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  let job: Job | null = null;
  let child: ChildProcess | null = null;
  let seq = 0;
  let timer: NodeJS.Timeout | null = null;

  const push = (j: Job, chunk: string) => {
    for (const l of chunk.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n|\r/)) {
      const s = l.trimEnd();
      if (s) j.log.push(s.slice(0, 300));
    }
    if (j.log.length > MAX_LOG) j.log.splice(0, j.log.length - MAX_LOG);
  };

  function finish(j: Job, state: JobState, error = ''): void {
    if (j.state !== 'running') return;
    j.state = state;
    j.error = error;
    j.endedAt = now();
    child = null;
    if (timer) clearTimeout(timer);
    timer = null;
    deps.onDone?.(j);
  }

  function run(kind: JobKind, bin: string, args: readonly string[]): Job {
    if (job && job.state === 'running') throw new Error('busy');
    const j: Job = { id: ++seq, kind, state: 'running', code: '', url: kind === 'login' ? DEVICE_URL : '', log: [], error: '', startedAt: now(), endedAt: 0 };
    job = j;
    // gh must not open a browser itself (Loom does, once) and must not colour its output.
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1', GH_BROWSER: 'true', BROWSER: 'true', HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1' };
    let c: ChildProcess;
    try {
      c = sp(bin, args, env);
    } catch (e) {
      finish(j, 'error', (e as Error).message);
      return j;
    }
    child = c;
    // gh can exit (or close stdin) before the newline below is written. The EPIPE
    // then arrives as an async 'error' on the stream, which no try/catch sees; with
    // no listener it is an uncaught exception that takes Loom's main process down.
    c.stdin?.on('error', () => {});
    const onData = (b: Buffer) => {
      const s = String(b);
      push(j, s);
      if (kind === 'login' && !j.code) {
        const code = parseDeviceCode(j.log.join('\n'));
        if (code) {
          j.code = code;
          // An older gh waits for Enter before it polls; a newline is harmless otherwise.
          try {
            c.stdin?.write('\n');
          } catch {
            /* closed */
          }
          deps.onCode?.(code, j.url);
        }
      }
    };
    c.stdout?.on('data', onData);
    c.stderr?.on('data', onData);
    c.on('error', (e: NodeJS.ErrnoException) => finish(j, 'error', e.code === 'ENOENT' ? `${path.basename(bin)} is not installed` : e.message));
    c.on('close', (code, signal) => {
      if (j.state !== 'running') return;
      if (code === 0) return finish(j, 'ok');
      const last = j.log.filter((l) => !/one-time code|Press Enter|Open this URL/i.test(l)).slice(-3).join(' ');
      finish(j, 'error', last || (signal ? `stopped (${signal})` : `exited ${code}`));
    });
    timer = setTimeout(() => {
      if (j.state === 'running') {
        try {
          c.kill('SIGTERM');
        } catch {
          /* gone */
        }
        finish(j, 'error', kind === 'login' ? 'The GitHub sign-in timed out. Start it again.' : 'The install timed out.');
      }
    }, deps.timeoutMs ?? JOB_TTL_MS);
    timer.unref?.();
    return j;
  }

  return {
    login(ghBin: string): Job {
      return run('login', ghBin, GH_LOGIN_ARGS);
    },
    install(brewBin: string): Job {
      return run('install', brewBin, ['install', 'gh']);
    },
    cancel(): boolean {
      if (!job || job.state !== 'running') return false;
      const c = child;
      finish(job, 'cancelled');
      try {
        c?.kill('SIGTERM');
      } catch {
        /* gone */
      }
      return true;
    },
    job(): Job | null {
      if (job && job.state !== 'running' && now() - job.endedAt > JOB_TTL_MS) job = null;
      return job ? { ...job, log: job.log.slice(-40) } : null;
    },
  };
}
