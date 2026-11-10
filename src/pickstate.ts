// Pure decisions behind the Slack pick overlay (app/picker.ts), kept free of
// Electron so they can be tested.
//
// Why they exist (measured 2026-11-10): the AX helper answers a trust check in
// ~0.1 ms warm (~12 ms cold) and a hit-test in 4-18 ms, so it was never the lag.
// The overlay was: a new transparent BrowserWindow per display on every press,
// visible only on `ready-to-show` (60-95 ms on an idle machine, one display, and
// a new renderer process each time, so far more under load). A click in that
// window landed on Slack instead of the overlay, and a second press while it was
// still building toggled it off: "needs more than one click". After the click,
// the lookup ran find-chat over the archive (170-700 ms for a thread Loom does not
// know) with the overlay already gone, so nothing showed it was working.

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Whether the pre-built overlays still match the displays (same rects, any order). */
export function overlaysMatch(current: Rect[], displays: Rect[]): boolean {
  if (current.length !== displays.length) return false;
  const key = (r: Rect) => `${r.x},${r.y},${r.width},${r.height}`;
  const have = current.map(key).sort();
  const want = displays.map(key).sort();
  return have.every((k, i) => k === want[i]);
}

export type PickPhase = 'idle' | 'picking' | 'opening';

export interface PressState {
  phase: PickPhase;
  shownAt: number; // when the overlay was shown, ms
  now: number;
}

// A second press this soon after showing is the same intent (impatience, or the
// first press seemed not to land), not a cancel.
export const REPRESS_GRACE_MS = 400;

/**
 * What a hotkey press does. Idle opens. While picking it cancels, like Esc,
 * unless the overlay has only just appeared. While a picked thread is opening
 * it only dismisses the overlay; the open carries on.
 */
export function pressAction(s: PressState): 'open' | 'cancel' | 'ignore' | 'dismiss' {
  if (s.phase === 'idle') return 'open';
  if (s.phase === 'opening') return 'dismiss';
  return s.now - s.shownAt < REPRESS_GRACE_MS ? 'ignore' : 'cancel';
}

/**
 * Whether to ask the helper about Accessibility before showing the overlay. A
 * helper that has already said yes keeps that answer: a revoked grant shows up
 * as 'untrusted' on the click's hit-test, which clears the cache.
 */
export function needsTrustCheck(cachedTrusted: boolean): boolean {
  return !cachedTrusted;
}

/** Timestamps for one press, logged when LOOM_PICK_TIMING is set. */
export class PickTimer {
  private t0 = 0;
  private marks: [string, number][] = [];
  constructor(private readonly on: boolean, private readonly clock: () => number = () => performance.now()) {}
  start(): void {
    this.t0 = this.clock();
    this.marks = [];
  }
  mark(label: string): void {
    if (this.on && this.t0) this.marks.push([label, this.clock() - this.t0]);
  }
  line(): string {
    return this.marks.map(([l, ms]) => `${l}=${ms.toFixed(1)}ms`).join(' ');
  }
}
