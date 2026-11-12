// One request, one reply line, matched by queue position: the protocol of the
// loom-ax helper (app/picker.ts). It answers in request order, one line each, so
// the Nth line read belongs to the Nth request written.
//
// That makes a timeout delicate. A request that gives up must still own its
// slot: if it were simply removed, its late reply would be handed to the NEXT
// request, and every caller after it would get the answer to the one before.
// So a timed-out request stays queued as a tombstone that swallows its own late
// line, and the asker's onTimeout (the picker restarts the helper) runs, after
// which failAll() settles whatever is still waiting.

export interface LineAsker {
  /** Write one request line; resolves with its reply line, or `down` on timeout or failure. */
  ask(line: string): Promise<string>;
  /** A reply line from the process. */
  onLine(line: string): void;
  /** The process is gone: settle every pending request with `down`. */
  failAll(): void;
  /** Requests written and not yet answered (tombstones included). */
  pending(): number;
}

interface Waiter {
  done: boolean;
  settle: (line: string) => void;
}

export interface LineAskerOpts {
  write: (line: string) => void;
  timeoutMs: number;
  /** The reply a timed-out or failed request resolves with. */
  down: string;
  /** Called once per request that timed out, after it has resolved. */
  onTimeout?: () => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export function lineAsker(opts: LineAskerOpts): LineAsker {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as NodeJS.Timeout));
  const queue: Waiter[] = [];
  let dead = false;
  return {
    ask(line) {
      return new Promise<string>((resolve) => {
        if (dead) return resolve(opts.down);
        let timer: unknown = null;
        const w: Waiter = {
          done: false,
          settle: (reply) => {
            if (w.done) return;
            w.done = true;
            if (timer !== null) clearTimer(timer);
            resolve(reply);
          },
        };
        queue.push(w);
        timer = setTimer(() => {
          if (w.done) return;
          w.settle(opts.down);
          opts.onTimeout?.();
        }, opts.timeoutMs);
        try {
          opts.write(line);
        } catch {
          // Never written, so no reply will come for it: drop its slot.
          const i = queue.indexOf(w);
          if (i >= 0) queue.splice(i, 1);
          w.settle(opts.down);
        }
      });
    },
    onLine(line) {
      // A tombstone (timed out) takes its own late reply and drops it.
      queue.shift()?.settle(line);
    },
    failAll() {
      dead = true;
      for (const w of queue.splice(0)) w.settle(opts.down);
    },
    pending: () => queue.length,
  };
}
