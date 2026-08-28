import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { formatWatchLine, makeTmuxWatcher, noteTmuxState, tmuxServerState } from '../src/tmuxwatch.ts';

function tmpLog(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-watch-')), name);
}

describe('formatWatchLine', () => {
  it('records the server identity so a replacement is visible', () => {
    const line = formatWatchLine(0, 'loom-quit', { pid: '4242', sessions: 9 });
    expect(line).toBe('1970-01-01T00:00:00.000Z loom-quit server=4242 sessions=9\n');
  });

  it('says so plainly when there is no server at all', () => {
    expect(formatWatchLine(0, 'loom-start', { pid: '', sessions: 0 })).toContain('server=none');
  });
});

describe('tmuxServerState', () => {
  it('never throws, whether or not tmux is running', () => {
    const s = tmuxServerState();
    expect(typeof s.pid).toBe('string');
    expect(s.sessions).toBeGreaterThanOrEqual(0);
  });
});

describe('noteTmuxState', () => {
  it('appends one line per event', () => {
    const file = tmpLog('watch.log');
    noteTmuxState(0, 'loom-start', '', file);
    noteTmuxState(1, 'loom-quit', '', file);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('loom-start');
    expect(lines[1]).toContain('loom-quit');
  });

  it('swallows an unwritable log rather than taking the app down', () => {
    expect(() => noteTmuxState(0, 'loom-start', '', '/nope/nope/watch.log')).not.toThrow();
  });
});

describe('makeTmuxWatcher', () => {
  it('logs the first observation, then only transitions', () => {
    const file = tmpLog('watch.log');
    const watch = makeTmuxWatcher(file);
    watch(0);
    watch(1);
    watch(2);
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('watch-start');
    expect(lines[0]).toContain('(first observation)');
  });
});
