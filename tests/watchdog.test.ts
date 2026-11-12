import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  WATCH,
  clearPidFile,
  initialState,
  killAndRelaunch,
  mayRestart,
  noteRestart,
  noticeText,
  readPidFile,
  readRestarts,
  step,
  takeNotice,
  writeNotice,
  writePidFile,
  type ActDeps,
  type WatchState,
} from '../src/watchdog.ts';

/** Run a sequence of ping results, one per interval, from t0. */
function run(results: boolean[], t0 = 1_000_000, every = WATCH.intervalMs) {
  let s: WatchState = initialState(t0);
  const verdicts: string[] = [];
  let t = t0;
  for (const ok of results) {
    t += every;
    const r = step(s, t, ok);
    s = r.state;
    verdicts.push(r.verdict);
  }
  return { s, verdicts };
}

describe('watchdog miss counter', () => {
  it('stays ok while health answers', () => {
    expect(run(Array(20).fill(true)).verdicts.every((v) => v === 'ok')).toBe(true);
  });

  it('calls a freeze only after freezeMs of consecutive misses', () => {
    const { verdicts } = run(Array(12).fill(false));
    const first = verdicts.indexOf('frozen');
    // 3 s ticks: 25 s is crossed on the 9th miss (27 s).
    expect(first).toBe(8);
    expect(verdicts.slice(0, first).every((v) => v === 'miss')).toBe(true);
  });

  it('one answer resets the count', () => {
    const { verdicts } = run([...Array(7).fill(false), true, ...Array(7).fill(false)]);
    expect(verdicts).not.toContain('frozen');
  });

  it('a sleep-sized gap between ticks starts over instead of firing', () => {
    let s = initialState(0);
    for (let t = 3_000; t <= 15_000; t += 3_000) s = step(s, t, false).state; // 5 misses, 15 s
    const woke = step(s, 15_000 + 60 * 60_000, false); // an hour asleep
    expect(woke.verdict).toBe('slept');
    expect(woke.state.misses).toBe(0);
    // And the clock restarts from the wake, not from before the sleep.
    let t = 15_000 + 60 * 60_000;
    let w = woke.state;
    const after: string[] = [];
    for (let i = 0; i < 5; i++) {
      t += 3_000;
      const r = step(w, t, false);
      w = r.state;
      after.push(r.verdict);
    }
    expect(after).not.toContain('frozen');
  });

  it('needs minMisses even when wall time alone would qualify', () => {
    // Slow pings (each tick ~14 s apart, under the sleep gap): 2 misses span 28 s.
    let s = initialState(0);
    const a = step(s, 14_000, false);
    s = a.state;
    const b = step(s, 28_000, false);
    expect(b.frozenMs).toBeGreaterThanOrEqual(WATCH.freezeMs);
    expect(b.verdict).toBe('miss');
  });
});

describe('restart cap', () => {
  it('allows restartCap restarts per window', () => {
    const now = 10 * 60 * 60_000;
    expect(mayRestart([], now)).toBe(true);
    expect(mayRestart([now - 1000, now - 2000], now)).toBe(true);
    expect(mayRestart([now - 1000, now - 2000, now - 3000], now)).toBe(false);
    expect(mayRestart([now - WATCH.restartWindowMs - 1, now - 2000, now - 3000], now)).toBe(true);
  });
});

describe('watchdog files', () => {
  const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wd-'));

  it('pid file: a newer watchdog owns it, and an older one cannot clear it', () => {
    const h = home();
    writePidFile(h, { pid: 11, loomPid: 5 });
    writePidFile(h, { pid: 12, loomPid: 5 });
    clearPidFile(h, 11);
    expect(readPidFile(h)).toEqual({ pid: 12, loomPid: 5 });
    clearPidFile(h, 12);
    expect(readPidFile(h)).toBeNull();
  });

  it('a notice is announced once', () => {
    const h = home();
    writeNotice(h, { at: 1, frozenMs: 31_400, report: path.join(h, 'hangs', 'x.txt'), by: 'watchdog' });
    const n = takeNotice(h);
    expect(n && noticeText(n, (p) => p.replace(h, '~'))).toBe('Loom was frozen for 31s and was restarted. Main-thread sample: ~/hangs/x.txt');
    expect(takeNotice(h)).toBeNull();
  });

  it('restart history keeps only the window', () => {
    const h = home();
    noteRestart(h, 1_000);
    noteRestart(h, 1_000 + WATCH.restartWindowMs + 5);
    expect(readRestarts(h)).toEqual([1_000 + WATCH.restartWindowMs + 5]);
  });
});

describe('killAndRelaunch', () => {
  const fake = (aliveFor: number) => {
    const calls: string[] = [];
    let checks = 0;
    const deps: ActDeps = {
      run: async (cmd, args) => {
        calls.push([cmd, ...args].join(' '));
        return { ok: true, detail: '' };
      },
      alive: () => checks++ < aliveFor,
      kill: (pid, sig) => void calls.push(`kill ${sig} ${pid}`),
      sleep: async () => {},
      now: () => 0,
    };
    return { deps, calls };
  };

  it('SIGKILLs, waits for the exit, then opens the bundle', async () => {
    const { deps, calls } = fake(3);
    expect(await killAndRelaunch(42, '/Applications/Loom.app', deps)).toEqual({ ok: true, detail: 'relaunched' });
    expect(calls).toEqual(['kill SIGKILL 42', '/usr/bin/open /Applications/Loom.app']);
  });

  it('never opens a second Loom while the first is still alive', async () => {
    const { deps, calls } = fake(Infinity);
    const r = await killAndRelaunch(42, null, deps);
    expect(r.ok).toBe(false);
    expect(calls).toEqual(['kill SIGKILL 42']);
  });
});
