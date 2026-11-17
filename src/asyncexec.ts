// Async counterparts of the bounded execFileSync calls in src/synctimeout.ts, and
// the two small guards every polling path shares.
//
// The HTTP server, the terminal bridge and every background tick run on Electron's
// main thread, so a recurring execFileSync (a whole-machine `ps` is ~50 ms on a
// fast Mac and several times that on a slow one) is a stall the user feels as
// typing and scrolling lag in the embedded terminals. Polling paths use these
// instead; one-off user actions may stay synchronous.

import { execFile, type ExecFileOptions } from 'node:child_process';
import { SYNC_TIMEOUT_MS } from './synctimeout.ts';

export interface ExecTextOpts extends Omit<ExecFileOptions, 'encoding'> {
  timeout?: number;
}

/**
 * execFile with the same bounds as `bounded()` (timeout, SIGKILL) that resolves to
 * stdout. A timeout rejects with code 'ETIMEDOUT', like execFileSync's, so callers
 * and breakers treat both the same. The error carries `stdout` for partial output.
 */
export function execText(bin: string, args: string[], opts: ExecTextOpts = {}): Promise<string> {
  const timeout = opts.timeout ?? SYNC_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 16 * 1024 * 1024, killSignal: 'SIGKILL', ...opts, timeout, encoding: 'utf-8' }, (err, stdout) => {
      if (!err) return resolve(typeof stdout === 'string' ? stdout : String(stdout ?? ''));
      const e = err as NodeJS.ErrnoException & { killed?: boolean; stdout?: unknown };
      // execFile reports its own timeout as a killed child with no exit code.
      if (e.killed && (e.code === null || e.code === undefined)) e.code = 'ETIMEDOUT';
      e.stdout = stdout;
      reject(e);
    });
  });
}

/**
 * One in-flight call per key: a second caller asking while the first is still
 * running gets the same promise instead of a second child process. Settled
 * entries are dropped, so the next call after that runs fresh.
 */
export class SingleFlight<T> {
  private inflight = new Map<string, Promise<T>>();
  run(key: string, fn: () => Promise<T>): Promise<T> {
    const hit = this.inflight.get(key);
    if (hit) return hit;
    const p = (async () => fn())().finally(() => {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    });
    this.inflight.set(key, p);
    return p;
  }
  get size(): number {
    return this.inflight.size;
  }
}

/**
 * A value refreshed asynchronously at most once per `ttlMs`, with concurrent
 * refreshes collapsed into one. `peek()` returns the last value however old (or
 * null), for synchronous readers that would rather reuse than block.
 */
export class TtlCache<T> {
  private value: { at: number; v: T } | null = null;
  private pending: Promise<T> | null = null;
  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}
  fresh(): T | null {
    return this.value && this.now() - this.value.at < this.ttlMs ? this.value.v : null;
  }
  peek(): { at: number; v: T } | null {
    return this.value;
  }
  set(v: T, at: number = this.now()): void {
    this.value = { at, v };
  }
  clear(): void {
    this.value = null;
  }
  get(load: () => Promise<T>, opts: { reuse?: boolean } = {}): Promise<T> {
    const hit = opts.reuse === false ? null : this.fresh();
    if (hit !== null) return Promise.resolve(hit);
    if (this.pending) return this.pending;
    const p = (async () => load())().then(
      (v) => {
        this.set(v);
        return v;
      },
    ).finally(() => {
      if (this.pending === p) this.pending = null;
    });
    this.pending = p;
    return p;
  }
}

/**
 * Wrap a recurring async tick so a run still going when the timer fires again is
 * not joined by a second one: the later firing is skipped. Errors go to `onError`
 * (default: logged) and never escape into the timer.
 */
export function guardTick(fn: () => Promise<unknown> | unknown, onError: (e: unknown) => void = (e) => console.error('[loom] tick failed:', (e as Error)?.message ?? e)): (() => Promise<void>) & { running: () => boolean } {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      onError(e);
    } finally {
      running = false;
    }
  };
  return Object.assign(tick, { running: () => running });
}
