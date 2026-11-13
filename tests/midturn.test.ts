import { describe, it, expect } from 'vitest';
import { batchCaptureArgs, panesMidTurn, splitBatchCapture, textIsMidTurn } from '../src/midturn.ts';

const MARK = '\x1eloom-cap ';

/** A fake tmux that answers batchCaptureArgs the way tmux does, stopping at a missing pane. */
function fakeTmux(screens: Record<string, string>) {
  const calls: string[][] = [];
  const run = (args: string[]): string => {
    calls.push(args);
    let out = '';
    const cmds: string[][] = [[]];
    for (const a of args) (a === ';' ? cmds.push([]) : cmds[cmds.length - 1].push(a));
    for (const c of cmds) {
      if (c[0] === 'display-message') out += c[2] + '\n';
      else if (c[0] === 'capture-pane') {
        const id = c[c.indexOf('-t') + 1];
        if (!(id in screens)) throw Object.assign(new Error(`can't find pane: ${id}`), { stdout: out });
        out += screens[id] + '\n';
      }
    }
    return out;
  };
  return { run, calls };
}

describe('textIsMidTurn', () => {
  it('reads the interrupt hint, a live subagent roster line and the waiting line', () => {
    expect(textIsMidTurn('✶ Thinking… (esc to interrupt)')).toBe(true);
    expect(textIsMidTurn('  ⏺ main\n  ◯ Explore  Looking for it   1m 2s')).toBe(true);
    expect(textIsMidTurn('✻ Waiting for 2 background agents to finish')).toBe(true);
    expect(textIsMidTurn('✻ Worked for 3m 10s\n> ')).toBe(false);
  });
});

describe('batched capture', () => {
  it('captures every pane in one tmux process and splits the output back per pane', () => {
    const { run, calls } = fakeTmux({ '%1': 'idle\n> ', '%22': 'busy (esc to interrupt)', '%3': '  ◯ Explore  x' });
    expect([...panesMidTurn(['%1', '%22', '%3'], run)].sort()).toEqual(['%22', '%3']);
    expect(calls).toHaveLength(1);
  });

  it('never puts a pane id in the marker (display-message runs it through strftime)', () => {
    const args = batchCaptureArgs(['%42']);
    const marker = args[args.indexOf('display-message') + 2];
    expect(marker).not.toContain('%');
    expect(splitBatchCapture(`${marker}\nscreen\n`, ['%42']).get('%42')).toBe('screen\n');
  });

  it('skips a pane that closed since it was listed and batches the rest again', () => {
    const { run, calls } = fakeTmux({ '%1': 'esc to interrupt', '%3': 'esc to interrupt', '%4': 'idle' });
    expect([...panesMidTurn(['%1', '%2', '%3', '%4'], run)].sort()).toEqual(['%1', '%3']);
    expect(calls).toHaveLength(2);
  });

  it('fails closed when tmux does not answer at all', () => {
    let n = 0;
    const run = () => {
      n++;
      throw new Error('tmux: breaker open');
    };
    expect(panesMidTurn(['%1', '%2'], run).size).toBe(0);
    expect(n).toBe(1);
  });

  it('asks nothing for no panes', () => {
    const { run, calls } = fakeTmux({});
    expect(panesMidTurn([], run).size).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('ignores marker text with no pane behind it', () => {
    expect(splitBatchCapture(`${MARK}7\nx\n`, ['%1']).size).toBe(0);
  });
});
