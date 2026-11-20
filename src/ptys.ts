import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

// Pseudo-terminals in use on this Mac, against kern.tty.ptmx_max. Every tmux
// pane, every attached tmux client (each Loom terminal view is one) and every
// Ghostty tab holds one; when they run out, tmux fails to create a window with
// "fork failed: Device not configured". A pty is allocated for as long as its
// /dev/ttysNNN node exists, so counting those nodes counts what is in use
// without root (lsof /dev/ptmx only sees our own processes).

export interface PtyUsage {
  used: number;
  max: number;
  /** used / max, 0..1 (0 when max is unknown). */
  ratio: number;
}

/** At or above this share of the limit the header warns. */
export const PTY_WARN_RATIO = 0.8;
/** Refuse a launch with fewer free than this: a fork at the very edge fails half-way. */
export const PTY_MIN_FREE = 2;

const DEFAULT_MAX = 511; // macOS's out-of-the-box kern.tty.ptmx_max

export function countPtys(list: () => string[] = () => fs.readdirSync('/dev')): number {
  try {
    return list().filter((n) => /^ttys\d+$/.test(n)).length;
  } catch {
    return 0;
  }
}

export function readPtyMax(sysctl: () => string = () => execFileSync('sysctl', ['-n', 'kern.tty.ptmx_max'], { encoding: 'utf-8', timeout: 2000 })): number {
  try {
    const n = parseInt(sysctl().trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX;
  } catch {
    return DEFAULT_MAX;
  }
}

let maxMemo: { at: number; v: number } | null = null;
let usageMemo: { at: number; v: PtyUsage } | null = null;

/** Current usage. The count is cached for 2 s and the limit for a minute. Never throws. */
export function ptyUsage(now: number = Date.now()): PtyUsage {
  if (usageMemo && now - usageMemo.at < 2000) return usageMemo.v;
  if (!maxMemo || now - maxMemo.at > 60_000) maxMemo = { at: now, v: readPtyMax() };
  const used = countPtys();
  const max = maxMemo.v;
  const v = { used, max, ratio: max > 0 ? used / max : 0 };
  usageMemo = { at: now, v };
  return v;
}

/** Forget the cached count (after a failed launch, so the message quotes a fresh number). */
export function resetPtyUsageCache(): void {
  usageMemo = null;
}

/** tmux's words for "no pseudo-terminal left": forkpty fails with ENXIO. A bare "fork failed" can be the process limit, so it does not count. */
export function isPtyExhaustion(message: string): boolean {
  return /Device not configured|posix_openpt|out of ptys/i.test(message);
}

/** macOS will not go above this (XNU caps kern.tty.ptmx_max). */
export const PTY_HARD_MAX = 999;

/** What the launch error says when the machine is out of terminals. */
export function outOfTerminalsDetail(u: PtyUsage): string {
  return (
    `Out of terminals (${u.used}/${u.max} in use). ` +
    'Close tmux panes, Ghostty tabs or Loom terminals you no longer need and try again; launches work as soon as some are free.' +
    (u.max < PTY_HARD_MAX ? ` To raise the limit: sudo sysctl -w kern.tty.ptmx_max=${PTY_HARD_MAX}` : '')
  );
}

/** A refusal for a launch about to run out, or null when there is room. */
export function ptyRefusal(u: PtyUsage): string | null {
  return u.max > 0 && u.max - u.used < PTY_MIN_FREE ? outOfTerminalsDetail(u) : null;
}

/** Turn a tmux failure into the out-of-terminals message when that is what it was; else pass it through. */
export function explainTmuxFailure(message: string, usage: () => PtyUsage = () => (resetPtyUsageCache(), ptyUsage())): string {
  return isPtyExhaustion(message) ? outOfTerminalsDetail(usage()) : message;
}
