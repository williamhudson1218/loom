// Remembers the main window's size, position and maximized state between launches.
// Stored in <LOOM_HOME>/window-state.json; any read problem falls back to the defaults.
import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';

export interface Rect { x: number; y: number; width: number; height: number }
export interface WinState { bounds: Rect; maximized: boolean; fullScreen: boolean }

export const DEFAULT_SIZE = { width: 1100, height: 840 };
const MIN = { width: 480, height: 360 };

export function stateFile(dir: string = TOOL_DIR): string {
  return path.join(dir, 'window-state.json');
}

function isRect(r: unknown): r is Rect {
  const o = r as Rect;
  return !!o && [o.x, o.y, o.width, o.height].every((n) => typeof n === 'number' && Number.isFinite(n));
}

export function loadWinState(file: string = stateFile()): WinState | null {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<WinState>;
    if (!isRect(j.bounds)) return null;
    return { bounds: j.bounds, maximized: !!j.maximized, fullScreen: !!j.fullScreen };
  } catch {
    return null;
  }
}

export function saveWinState(s: WinState, file: string = stateFile()): void {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(s));
    fs.renameSync(tmp, file);
  } catch {
    /* best effort: a lost save only means the default size next launch */
  }
}

/**
 * The bounds to open with, given the saved state and the work areas of the
 * displays attached now. A window saved on a display that is gone, or that would
 * open mostly off screen, keeps its size (shrunk to fit) and is centred on the
 * primary display instead. Undefined x/y means "let Electron centre it".
 */
export function restoreBounds(saved: WinState | null, workAreas: Rect[]): Partial<Rect> & { width: number; height: number } {
  const primary = workAreas[0];
  if (!saved) return { ...DEFAULT_SIZE };
  const b = saved.bounds;
  const visible = (a: Rect): number => {
    const w = Math.min(b.x + b.width, a.x + a.width) - Math.max(b.x, a.x);
    const h = Math.min(b.y + b.height, a.y + a.height) - Math.max(b.y, a.y);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const host = workAreas.reduce<Rect | null>((best, a) => (visible(a) > (best ? visible(best) : 0) ? a : best), null);
  const area = host ?? primary;
  const width = Math.max(MIN.width, Math.min(b.width, area ? area.width : b.width));
  const height = Math.max(MIN.height, Math.min(b.height, area ? area.height : b.height));
  // Keep it only if at least a third of the window is on some display.
  if (host && visible(host) >= (b.width * b.height) / 3) {
    const x = Math.min(Math.max(b.x, host.x), host.x + host.width - width);
    const y = Math.min(Math.max(b.y, host.y), host.y + host.height - height);
    return { x, y, width, height };
  }
  return { width, height };
}
