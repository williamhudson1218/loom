import { describe, expect, it } from 'vitest';
import { COLUMN_ZERO_QUIET_MS, pendingYesNo, waitForShellReady, waitForShellReadyAsync } from '../src/newthread.ts';

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
    expect(calls.filter((c) => c[0] === 'capture-pane').length).toBe(10);
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
    const run = (args: string[]) => (args[0] === 'capture-pane' ? frames[Math.min(i++, frames.length - 1)] : '');
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

// 2026-11-12: after the update question, oh-my-zsh printed one line and nvm then
// loaded silently for ~1 s with the cursor at column 0. The still screen read as
// ready, the launch was typed into a shell that had not drawn its prompt, and it
// was lost: 4 of 9 Slack-started chats never ran.
describe('a still screen with no prompt drawn yet', () => {
  // capture-pane shows the same screen throughout; the cursor sits at column 0
  // until poll `promptAt`, then moves past the drawn prompt.
  function shell(promptAt: number) {
    let polls = 0;
    const run = (args: string[]) => {
      if (args[0] === 'capture-pane') {
        polls++;
        return polls < promptAt ? '[oh-my-zsh] You can update manually' : '[oh-my-zsh] You can update manually\n❯ ';
      }
      if (args[0] === 'display-message') return polls < promptAt ? '0' : '2';
      return '';
    };
    return { run, polls: () => polls };
  }
  it('is not ready until the cursor leaves column 0 (blocking)', () => {
    const s = shell(15);
    expect(waitForShellReady('%1', s.run, { sleep: noSleep, stepMs: 100, quietMs: 500 })).toBe(true);
    // The first screen held still for 1.3 s; the prompt then has to hold for 500 ms.
    expect(s.polls()).toBe(20);
  });
  it('is not ready until the cursor leaves column 0 (async)', async () => {
    const s = shell(15);
    expect(await waitForShellReadyAsync('%1', s.run, { sleep: async () => {}, stepMs: 100, quietMs: 500 })).toBe(true);
    expect(s.polls()).toBe(20);
  });
  it('types anyway once column 0 has held for COLUMN_ZERO_QUIET_MS (a prompt ending in a newline)', () => {
    const s = shell(Infinity);
    expect(waitForShellReady('%1', s.run, { sleep: noSleep, stepMs: 100, quietMs: 500, maxMs: 8000 })).toBe(true);
    expect(s.polls()).toBe(1 + COLUMN_ZERO_QUIET_MS / 100);
  });
});
