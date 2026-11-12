import fs from 'node:fs';
import path from 'node:path';

// Loom's out-of-process watchdog: the pure parts. The loop that runs them is
// src/watchdog-main.ts, a detached process Loom starts once its server is up.
//
// Why out of process: the HTTP server, tray, shortcuts and every tick run on
// Electron's main thread. When something synchronous blocks it (a wedged tmux or
// AppleScript call), nothing in Loom can notice, because the code that would
// notice is what is blocked. So a separate process pings GET /api/health, which
// answers straight from the event loop; when it has gone unanswered for
// FREEZE_MS, the watchdog samples the main thread's stack into
// $LOOM_HOME/hangs/<time>.txt (the culprit), kills Loom and opens it again, and
// the new Loom posts a notification saying so.
//
// It never restarts a Loom that quit: Loom stops the watchdog in before-quit,
// and the watchdog exits on its own the moment Loom's pid is gone, whatever the
// reason. A gap between two ticks far longer than the interval means the Mac
// slept (the watchdog was suspended too), and the miss count starts over.

export const WATCH = {
  intervalMs: 3_000,
  pingTimeoutMs: 2_000,
  /** Unanswered for this long (and at least minMisses pings) = frozen. */
  freezeMs: 25_000,
  minMisses: 5,
  /** A tick this late means the machine slept: start counting again. */
  sleepGapMs: 15_000,
  /** Automatic restarts allowed per restartWindowMs; past that it samples and leaves Loom alone. */
  restartCap: 3,
  restartWindowMs: 15 * 60_000,
};
export type WatchConfig = typeof WATCH;

export interface WatchState {
  /** When /api/health last answered (or the watch started, or the Mac woke). */
  lastOk: number;
  /** When the previous tick ran. */
  lastTick: number;
  misses: number;
}

export type Verdict = 'ok' | 'miss' | 'slept' | 'frozen';

export const initialState = (now: number): WatchState => ({ lastOk: now, lastTick: now, misses: 0 });

/** One tick: fold a ping result into the state. `frozenMs` is how long Loom has not answered. */
export function step(s: WatchState, now: number, ok: boolean, cfg: WatchConfig = WATCH): { state: WatchState; verdict: Verdict; frozenMs: number } {
  if (now - s.lastTick > cfg.sleepGapMs) {
    // Slept (or the watchdog itself was starved): what was missed before says nothing about now.
    return { state: { lastOk: now, lastTick: now, misses: 0 }, verdict: 'slept', frozenMs: 0 };
  }
  if (ok) return { state: { lastOk: now, lastTick: now, misses: 0 }, verdict: 'ok', frozenMs: 0 };
  const misses = s.misses + 1;
  const frozenMs = now - s.lastOk;
  const state = { lastOk: s.lastOk, lastTick: now, misses };
  return { state, verdict: misses >= cfg.minMisses && frozenMs >= cfg.freezeMs ? 'frozen' : 'miss', frozenMs };
}

/** Whether another automatic restart is allowed, given the times of earlier ones. */
export function mayRestart(history: number[], now: number, cfg: WatchConfig = WATCH): boolean {
  return history.filter((t) => now - t < cfg.restartWindowMs).length < cfg.restartCap;
}

/* ---------------------------------------------------------------- files */

export const HANGS_DIR = 'hangs';
/** Which watchdog is current: a newer one replaces it, and the older one exits on its next tick. */
export const WATCHDOG_PID_FILE = 'watchdog.pid';
/** Left by a restart (the watchdog's or `chat-manager restart`) for the next Loom to announce. */
export const RESTART_NOTICE_FILE = 'restart-notice.json';
const RESTART_HISTORY_FILE = 'restarts.json';

export interface RestartNotice {
  at: number;
  /** How long Loom had not answered; 0 for a manual restart of a Loom that was answering. */
  frozenMs: number;
  report: string;
  by: 'watchdog' | 'manual';
}

export const hangsDir = (home: string): string => path.join(home, HANGS_DIR);

/** hangs/<UTC time>[-suffix].txt, filesystem-safe. */
export function reportPath(home: string, now: number, suffix = ''): string {
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
  return path.join(hangsDir(home), stamp + (suffix ? '-' + suffix : '') + '.txt');
}

export interface PidFile {
  pid: number;
  loomPid: number;
}

export function readPidFile(home: string): PidFile | null {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, WATCHDOG_PID_FILE), 'utf-8')) as Partial<PidFile>;
    return typeof j.pid === 'number' && typeof j.loomPid === 'number' ? { pid: j.pid, loomPid: j.loomPid } : null;
  } catch {
    return null;
  }
}

export function writePidFile(home: string, p: PidFile): void {
  const f = path.join(home, WATCHDOG_PID_FILE);
  fs.writeFileSync(f + '.tmp', JSON.stringify(p));
  fs.renameSync(f + '.tmp', f);
}

/** Remove the pid file only if it still names `pid` (a newer watchdog's file is left alone). */
export function clearPidFile(home: string, pid: number): void {
  if (readPidFile(home)?.pid !== pid) return;
  try {
    fs.rmSync(path.join(home, WATCHDOG_PID_FILE), { force: true });
  } catch {
    /* gone */
  }
}

export function writeNotice(home: string, n: RestartNotice): void {
  fs.mkdirSync(hangsDir(home), { recursive: true });
  fs.writeFileSync(path.join(hangsDir(home), RESTART_NOTICE_FILE), JSON.stringify(n));
}

/** Read and remove the notice, so it is announced once. */
export function takeNotice(home: string): RestartNotice | null {
  const f = path.join(hangsDir(home), RESTART_NOTICE_FILE);
  try {
    const n = JSON.parse(fs.readFileSync(f, 'utf-8')) as RestartNotice;
    fs.rmSync(f, { force: true });
    return typeof n.at === 'number' ? n : null;
  } catch {
    return null;
  }
}

/** The line the new Loom shows. */
export function noticeText(n: RestartNotice, displayPath: (p: string) => string = (p) => p): string {
  const report = displayPath(n.report);
  if (n.by === 'manual') return `Loom was restarted by chat-manager restart. Main-thread sample: ${report}`;
  return `Loom was frozen for ${Math.round(n.frozenMs / 1000)}s and was restarted. Main-thread sample: ${report}`;
}

export function readRestarts(home: string): number[] {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(hangsDir(home), RESTART_HISTORY_FILE), 'utf-8')) as unknown;
    return Array.isArray(j) ? j.filter((t): t is number => typeof t === 'number') : [];
  } catch {
    return [];
  }
}

export function noteRestart(home: string, now: number, cfg: WatchConfig = WATCH): void {
  const keep = readRestarts(home).filter((t) => now - t < cfg.restartWindowMs);
  fs.mkdirSync(hangsDir(home), { recursive: true });
  fs.writeFileSync(path.join(hangsDir(home), RESTART_HISTORY_FILE), JSON.stringify([...keep, now]));
}

/** Append one line to Loom's own log ($LOOM_HOME/loom.log), in installAppLog's format. */
export function appendLog(home: string, level: 'info' | 'error', msg: string, now: number = Date.now()): void {
  try {
    fs.appendFileSync(path.join(home, 'loom.log'), `${new Date(now).toISOString()} ${level} ${msg}\n`);
  } catch {
    /* no log */
  }
}

/* ---------------------------------------------------------------- acts */

export const LOOM_BUNDLE_ID = 'com.loom.app';

export interface ActDeps {
  run: (cmd: string, args: string[], timeoutMs: number) => Promise<{ ok: boolean; detail: string }>;
  alive: (pid: number) => boolean;
  kill: (pid: number, sig: NodeJS.Signals) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export function realActDeps(): ActDeps {
  return {
    run: async (cmd, args, timeoutMs) => {
      const { execFile } = await import('node:child_process');
      return new Promise((resolve) => {
        execFile(cmd, args, { timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'utf-8' }, (err, _out, stderr) =>
          resolve(err ? { ok: false, detail: String(stderr || err.message).trim() } : { ok: true, detail: '' }),
        );
      });
    },
    alive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid, sig) => {
      try {
        process.kill(pid, sig);
      } catch {
        /* gone */
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}

/** `sample <pid> 3` into `file`: the main thread's stack while it is stuck. */
export async function sampleInto(pid: number, file: string, deps: ActDeps): Promise<{ ok: boolean; detail: string }> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const r = await deps.run('/usr/bin/sample', [String(pid), '3', '-file', file], 30_000);
  if (!r.ok) {
    try {
      fs.appendFileSync(file, `sample of pid ${pid} failed: ${r.detail}\n`);
    } catch {
      /* nothing to write into */
    }
  }
  return r;
}

/**
 * Kill Loom outright and open it again. SIGKILL, not SIGTERM: a frozen main
 * thread cannot run a graceful quit, and a graceful quit would also run
 * before-quit's update install. Loom's startup sweep clears the pane tints a
 * killed Loom leaves behind.
 */
export async function killAndRelaunch(pid: number, app: string | null, deps: ActDeps): Promise<{ ok: boolean; detail: string }> {
  deps.kill(pid, 'SIGKILL');
  for (let i = 0; i < 50 && deps.alive(pid); i++) await deps.sleep(200);
  if (deps.alive(pid)) return { ok: false, detail: `pid ${pid} did not exit after SIGKILL` };
  await deps.sleep(500); // let macOS register the exit before open asks for the app
  const r = await deps.run('/usr/bin/open', app ? [app] : ['-b', LOOM_BUNDLE_ID], 20_000);
  return r.ok ? { ok: true, detail: 'relaunched' } : { ok: false, detail: 'open failed: ' + r.detail };
}
