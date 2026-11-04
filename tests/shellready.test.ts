import { describe, expect, it } from 'vitest';
import { waitForShellReady } from '../src/newthread.ts';

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
