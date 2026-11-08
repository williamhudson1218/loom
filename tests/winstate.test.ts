import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadWinState, saveWinState, restoreBounds, DEFAULT_SIZE } from '../src/winstate.ts';

const main = { x: 0, y: 25, width: 1512, height: 920 };
const ext = { x: 1512, y: 0, width: 2560, height: 1415 };

describe('window state', () => {
  it('round-trips through the file and ignores junk', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loomwin-'));
    const f = path.join(dir, 'window-state.json');
    expect(loadWinState(f)).toBeNull();
    saveWinState({ bounds: { x: 10, y: 40, width: 1300, height: 900 }, maximized: true, fullScreen: false }, f);
    expect(loadWinState(f)).toEqual({ bounds: { x: 10, y: 40, width: 1300, height: 900 }, maximized: true, fullScreen: false });
    fs.writeFileSync(f, '{"bounds":{"x":"a"}}');
    expect(loadWinState(f)).toBeNull();
    fs.writeFileSync(f, 'not json');
    expect(loadWinState(f)).toBeNull();
  });

  it('opens at the default size with nothing saved', () => {
    expect(restoreBounds(null, [main])).toEqual(DEFAULT_SIZE);
  });

  it('reopens exactly where it was when that spot is on screen', () => {
    const s = { bounds: { x: 1700, y: 100, width: 1400, height: 1000 }, maximized: false, fullScreen: false };
    expect(restoreBounds(s, [main, ext])).toEqual(s.bounds);
  });

  it('keeps the size but recentres when the display it was on is gone', () => {
    const s = { bounds: { x: 1700, y: 100, width: 1400, height: 1000 }, maximized: false, fullScreen: false };
    expect(restoreBounds(s, [main])).toEqual({ width: 1400, height: 920 });
  });

  it('pulls a window hanging off the edge back on screen and never below the minimum', () => {
    const s = { bounds: { x: 900, y: 25, width: 800, height: 200 }, maximized: false, fullScreen: false };
    expect(restoreBounds(s, [main])).toEqual({ x: 712, y: 25, width: 800, height: 360 });
  });
});
