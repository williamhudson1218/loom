import { describe, expect, it } from 'vitest';
import { lineAsker } from '../src/lineasker.ts';

const DOWN = 'DOWN';

/** A fake clock: timers fire only when advanced. */
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 1;
  return {
    set: (fn: () => void, ms: number) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clear: (id: unknown) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    advance(ms: number) {
      now += ms;
      for (const t of timers.filter((t) => t.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

function setup() {
  const c = clock();
  const written: string[] = [];
  let timeouts = 0;
  const a = lineAsker({ write: (l) => void written.push(l), timeoutMs: 2500, down: DOWN, onTimeout: () => timeouts++, setTimer: c.set, clearTimer: c.clear });
  return { a, c, written, timeouts: () => timeouts };
}

describe('lineAsker', () => {
  it('matches replies to requests in order', async () => {
    const { a } = setup();
    const p1 = a.ask('1');
    const p2 = a.ask('2');
    a.onLine('r1');
    a.onLine('r2');
    expect(await p1).toBe('r1');
    expect(await p2).toBe('r2');
    expect(a.pending()).toBe(0);
  });

  it('a request that is not answered resolves down and reports the timeout', async () => {
    const { a, c, timeouts } = setup();
    const p = a.ask('1');
    c.advance(2500);
    expect(await p).toBe(DOWN);
    expect(timeouts()).toBe(1);
  });

  it("a timed-out request's late reply is swallowed, not handed to the next caller", async () => {
    const { a, c } = setup();
    const slow = a.ask('slow');
    c.advance(2500);
    expect(await slow).toBe(DOWN);
    const next = a.ask('next');
    a.onLine('late reply to slow');
    a.onLine('reply to next');
    expect(await next).toBe('reply to next');
    expect(a.pending()).toBe(0);
  });

  it('an answered request clears its timer', async () => {
    const { a, c, timeouts } = setup();
    const p = a.ask('1');
    a.onLine('r1');
    c.advance(10_000);
    expect(await p).toBe('r1');
    expect(timeouts()).toBe(0);
  });

  it('failAll settles everything pending and later asks at once', async () => {
    const { a } = setup();
    const p1 = a.ask('1');
    const p2 = a.ask('2');
    a.failAll();
    expect(await p1).toBe(DOWN);
    expect(await p2).toBe(DOWN);
    expect(await a.ask('3')).toBe(DOWN);
  });

  it('a write that throws gives up its slot', async () => {
    const c = clock();
    let fail = true;
    const a = lineAsker({ write: () => { if (fail) throw new Error('EPIPE'); }, timeoutMs: 2500, down: DOWN, setTimer: c.set, clearTimer: c.clear });
    expect(await a.ask('1')).toBe(DOWN);
    fail = false;
    const p = a.ask('2');
    a.onLine('r2');
    expect(await p).toBe('r2');
  });
});
