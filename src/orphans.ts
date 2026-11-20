import { execFileSync } from 'node:child_process';
import { defaultRun, type TmuxRunner } from './compact.ts';

// Shells orphaned by their pane. Now and then a pane's login shell hangs at birth,
// blocked in zsh's init_io opening its own terminal, so it never draws a prompt
// (the "frozen pane": cursor low, no key gets through). When that pane's window
// is closed (by hand, or by the managed reaper, which sees an idle shell),
// tmux closes the pty master but the shell stays blocked holding the slave, so
// the pseudo-terminal is never freed. They piled up to 82 in two weeks and
// helped run the Mac out of ptys ("fork failed: Device not configured").
//
// An orphan here is narrow on purpose: a shell whose parent is the tmux server,
// on a tty that no live pane owns, whose pid is no pane's, and that has been
// alive long enough that it is not a pane mid-creation. Nothing legitimate looks
// like that, so it is SIGKILLed (a hung open ignores the SIGHUP tmux sent) and logged.

const SHELL = /^-?(zsh|bash|fish|sh)$/;
/** Younger than this is left alone: a pane being created can be briefly unlisted. */
export const ORPHAN_MIN_AGE_S = 120;

export interface ProcRow {
  pid: number;
  ppid: number;
  tty: string;
  ageS: number;
  comm: string;
}

export interface Orphan {
  pid: number;
  tty: string;
  ageS: number;
  comm: string;
}

/** ps etime ([[dd-]hh:]mm:ss) in seconds; NaN when unparseable. */
export function parseEtime(s: string): number {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(s.trim());
  if (!m) return NaN;
  return (+(m[1] ?? 0)) * 86400 + (+(m[2] ?? 0)) * 3600 + +m[3] * 60 + +m[4];
}

export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5) continue;
    const [pid, ppid, tty, etime, ...rest] = f;
    rows.push({ pid: +pid, ppid: +ppid, tty, ageS: parseEtime(etime), comm: rest.join(' ') });
  }
  return rows;
}

export function findOrphanShells(
  procs: ProcRow[],
  serverPid: number,
  panes: { tty: string; pid: number }[],
  minAgeS = ORPHAN_MIN_AGE_S,
): Orphan[] {
  if (!serverPid) return [];
  const ttys = new Set(panes.map((p) => p.tty.replace(/^\/dev\//, '')));
  const pids = new Set(panes.map((p) => p.pid));
  return procs
    .filter((p) => p.ppid === serverPid && SHELL.test(p.comm) && p.tty && p.tty !== '??' && !ttys.has(p.tty) && !pids.has(p.pid) && p.ageS >= minAgeS)
    .map(({ pid, tty, ageS, comm }) => ({ pid, tty, ageS, comm }));
}

export interface SweepDeps {
  run?: TmuxRunner;
  ps?: () => string;
  kill?: (pid: number) => void;
  log?: (msg: string) => void;
}

/** One sweep: find orphaned shells and SIGKILL them. Returns what it killed. Never throws. */
export function sweepOrphanShells(deps: SweepDeps = {}): Orphan[] {
  const run = deps.run ?? defaultRun;
  const ps = deps.ps ?? (() => execFileSync('ps', ['-axo', 'pid=,ppid=,tty=,etime=,comm='], { encoding: 'utf-8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 }));
  const kill = deps.kill ?? ((pid: number) => process.kill(pid, 'SIGKILL'));
  const log = deps.log ?? ((m: string) => console.log('[loom] ' + m));
  try {
    const serverPid = parseInt(run(['display-message', '-p', '#{pid}']).trim(), 10);
    // Read the panes AFTER ps, so a pane created between the two reads is listed, never mistaken for an orphan.
    const procs = parsePs(ps());
    const panes = run(['list-panes', '-a', '-F', '#{pane_tty} #{pane_pid}'])
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [tty, pid] = l.split(' ');
        return { tty, pid: +pid };
      });
    if (!panes.length) return []; // no panes read: never treat every shell as orphaned
    const killed: Orphan[] = [];
    for (const o of findOrphanShells(procs, serverPid, panes)) {
      try {
        kill(o.pid);
        killed.push(o);
        log(`orphans: killed ${o.comm} pid ${o.pid} on ${o.tty}, alive ${o.ageS}s with no pane (a shell hung at startup)`);
      } catch {
        /* already gone */
      }
    }
    return killed;
  } catch {
    return [];
  }
}
