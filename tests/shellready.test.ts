import { describe, expect, it } from 'vitest';
import { pendingYesNo, waitForShellReady, waitForShellReadyAsync } from '../src/newthread.ts';

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

// 0.1.113: a new shell stopped on oh-my-zsh's update question, the screen held still,
// so it read as ready; the question then ate the "c" of "cd" and the chat started elsewhere.
describe('a one-key question on a new shell', () => {
  const OMZ = '[oh-my-zsh] Would you like to update? [Y/n]';
  it('is recognised, and a shell prompt is not', () => {
    expect(pendingYesNo('Found .nvmrc\n' + OMZ + ' ')).toBe(true);
    expect(pendingYesNo('Overwrite? [y/N]')).toBe(true);
    expect(pendingYesNo('❯ ')).toBe(false);
    expect(pendingYesNo(OMZ + ' n\n[oh-my-zsh] You can update manually by running `omz update`\n❯ ')).toBe(false);
  });
  function omzShell() {
    let answered = false;
    const sent: string[][] = [];
    const run = (args: string[]) => {
      if (args[0] === 'send-keys') {
        sent.push(args);
        answered = true;
        return '';
      }
      return answered ? '[oh-my-zsh] You can update manually\n❯ ' : OMZ + ' ';
    };
    return { run, sent };
  }
  it('is answered with a space before the shell counts as ready (blocking)', () => {
    const { run, sent } = omzShell();
    expect(waitForShellReady('%1', run, { sleep: noSleep, maxMs: 5000 })).toBe(true);
    expect(sent).toEqual([['send-keys', '-t', '%1', '-l', ' ']]);
  });
  it('is answered with a space before the shell counts as ready (async)', async () => {
    const { run, sent } = omzShell();
    expect(await waitForShellReadyAsync('%1', run, { sleep: async () => {}, maxMs: 5000 })).toBe(true);
    expect(sent).toEqual([['send-keys', '-t', '%1', '-l', ' ']]);
  });
  it('a question that keeps coming back is answered at most twice', () => {
    const sent: string[][] = [];
    const run = (args: string[]) => (args[0] === 'send-keys' ? (sent.push(args), '') : OMZ);
    expect(waitForShellReady('%1', run, { sleep: noSleep, maxMs: 8000 })).toBe(true);
    expect(sent).toHaveLength(2);
  });
});
