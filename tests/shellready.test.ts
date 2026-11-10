import { describe, expect, it } from 'vitest';
import { waitForShellReady, waitForShellReadyAsync } from '../src/newthread.ts';

// A runner whose capture-pane returns the next screen in the list each call,
// then keeps returning the last one.
function screens(...frames: string[]) {
  let i = 0;
  const calls: string[][] = [];
  const run = (args: string[]) => {
    calls.push(args);
    return frames[Math.min(i++, frames.length - 1)];
  };
  return { run, calls };
}
const noSleep = () => {};

describe('waitForShellReady', () => {
  it('waits through shell startup until the screen settles', () => {
    const { run, calls } = screens('', '', 'Found .nvmrc', 'Now using node v22', '❯ ', '❯ ', '❯ ', '❯ ', '❯ ', '❯ ');
    expect(waitForShellReady('%1', run, { sleep: noSleep, stepMs: 100, quietMs: 500 })).toBe(true);
    // 4 frames of startup, then the prompt has to hold for 500ms (5 more polls).
    expect(calls.length).toBe(10);
  });

  it('does not treat a blank screen as ready', () => {
    const { run } = screens('');
    expect(waitForShellReady('%1', run, { sleep: noSleep, maxMs: 2000 })).toBe(false);
  });

  it('gives up when capture-pane fails', () => {
    const run = () => {
      throw new Error('no pane');
    };
    expect(waitForShellReady('%1', run, { sleep: noSleep })).toBe(false);
  });
});

describe('waitForShellReadyAsync', () => {
  it('settles like the blocking version, but yields between polls', async () => {
    let i = 0;
    const frames = ['', 'Now using node v22', '❯ ', '❯ ', '❯ ', '❯ ', '❯ ', '❯ '];
    const run = () => frames[Math.min(i++, frames.length - 1)];
    const waits: number[] = [];
    const ok = await waitForShellReadyAsync('%1', run, { stepMs: 100, quietMs: 500, sleep: async (ms) => void waits.push(ms) });
    expect(ok).toBe(true);
    expect(waits.length).toBe(i);
    expect(waits.every((w) => w === 100)).toBe(true);
  });
  it('does not block the event loop while it waits', async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await waitForShellReadyAsync('%1', () => '❯ ', { stepMs: 20, quietMs: 60 });
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(3);
  });
  it('gives up when capture-pane fails', async () => {
    expect(await waitForShellReadyAsync('%1', () => { throw new Error('no pane'); }, { sleep: async () => {} })).toBe(false);
  });
});
