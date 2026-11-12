// Bounds on the synchronous child processes Loom runs in Electron's main process.
//
// The HTTP server, the tray, the global shortcuts and every background tick share
// that one thread, so a single execFileSync that never returns freezes all of
// Loom, and nothing in-process can notice. tmux (3.6a here) is known to wedge,
// and AppleScript sent to a busy app can block for minutes. So every main-process
// execFileSync carries a timeout; a timed-out call throws like any other failed
// call (error.code 'ETIMEDOUT'), which callers already treat as "tmux down" or
// "pane gone".
//
// SIGKILL, not the default SIGTERM: a wedged child may ignore SIGTERM, and Node
// only returns from execFileSync once the child has exited.

export const SYNC_TIMEOUT_MS = 5_000;

/** The execFileSync options a bounded call adds; anything the caller set wins. */
export function bounded<T extends object>(opts: T, ms: number = SYNC_TIMEOUT_MS): T & { timeout: number; killSignal: NodeJS.Signals | number } {
  const set = opts as { timeout?: number; killSignal?: NodeJS.Signals | number };
  return { ...opts, timeout: set.timeout ?? ms, killSignal: set.killSignal ?? 'SIGKILL' };
}

/** Whether an execFileSync error is its timeout firing. */
export function isTimeout(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: unknown }).code === 'ETIMEDOUT';
}

/**
 * Fail fast after a timeout. One wedged tmux call costs its timeout; a tick that
 * makes ten of them in a row would block the main thread for ten timeouts. Once
 * a call times out, the breaker stays open for `cooldownMs` and every call in
 * that window fails at once; the first call after it probes tmux again.
 */
export class Breaker {
  private openUntil = 0;
  constructor(readonly cooldownMs: number) {}
  /** Open the breaker; returns true when it was closed (so the caller logs once). */
  trip(now: number): boolean {
    const was = this.isOpen(now);
    this.openUntil = now + this.cooldownMs;
    return !was;
  }
  isOpen(now: number): boolean {
    return now < this.openUntil;
  }
  reset(): void {
    this.openUntil = 0;
  }
}

/** The error a call refused by an open breaker throws: shaped like a timeout, so callers treat it the same. */
export function breakerError(what: string): Error {
  const e = new Error(`${what} is not answering (a recent call timed out); skipped`) as Error & { code: string };
  e.code = 'ETIMEDOUT';
  return e;
}
