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
//
// Second round, same day: still "two clicks". With Loom's own terminal and
// managed windows (the defaults), a picked thread whose chat was not running was
// resumed into a background window and shown nowhere, so the first press looked
// dead and the second (the chat now running) jumped. The resume also waited for
// the new shell with a blocking sleep on the main process (0.6-8 s with the whole
// app frozen), and a jump into Loom's window was only picked up by the page's 5 s
// poll. A double click ran two hit-tests and could open the thread twice (the
// 'hitting' phase below drops the second). Every press is now traced to
// $LOOM_HOME/pick.log (src/picklog.ts).

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

// idle      nothing up
// starting  pressed; checking trust / showing the overlays
// picking   crosshairs up, waiting for a click
// hitting   a click is being resolved to a message (hit-test in flight)
// opening   a thread was picked and is being opened ("Opening…")
export type PickPhase = 'idle' | 'starting' | 'picking' | 'hitting' | 'opening';

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
 * unless the overlay has only just appeared (or is still being shown). While a
 * picked thread is being resolved or opened it only dismisses the overlay; the
 * open carries on.
 */
export function pressAction(s: PressState): 'open' | 'cancel' | 'ignore' | 'dismiss' {
  if (s.phase === 'idle') return 'open';
  if (s.phase === 'starting') return 'ignore';
  if (s.phase === 'opening' || s.phase === 'hitting') return 'dismiss';
  return s.now - s.shownAt < REPRESS_GRACE_MS ? 'ignore' : 'cancel';
}

/**
 * What a click on the overlay does. Only a click while picking is resolved; any
 * other is dropped, and the reason is what pick.log records. A second click
 * while the first is still being resolved is dropped too: two clicks used to
 * run two hit-tests and could open (or resume) the same thread twice.
 */
export function clickAction(phase: PickPhase): 'hit' | 'drop' {
  return phase === 'picking' ? 'hit' : 'drop';
}

/**
 * The pick's phase and the transitions picker.ts makes, kept pure so every
 * press / click / Esc ordering can be tested without Electron.
 */
export class PickMachine {
  phase: PickPhase = 'idle';
  shownAt = 0;
  press(now: number): ReturnType<typeof pressAction> {
    const a = pressAction({ phase: this.phase, shownAt: this.shownAt, now });
    if (a === 'open') this.phase = 'starting';
    return a;
  }
  /** The overlays are up. False when the pick was ended meanwhile (Esc during the trust check). */
  shown(now: number): boolean {
    if (this.phase !== 'starting') return false;
    this.phase = 'picking';
    this.shownAt = now;
    return true;
  }
  click(): ReturnType<typeof clickAction> {
    const a = clickAction(this.phase);
    if (a === 'hit') this.phase = 'hitting';
    return a;
  }
  /** The click did not resolve to a thread, but the user may click again. */
  retry(): boolean {
    if (this.phase !== 'hitting') return false;
    this.phase = 'picking';
    return true;
  }
  opening(): boolean {
    if (this.phase !== 'hitting') return false;
    this.phase = 'opening';
    return true;
  }
  end(): PickPhase {
    const was = this.phase;
    this.phase = 'idle';
    return was;
  }
}

/** A message rect the hover outline showed, and when. */
export interface HoverHit<T> {
  rect: { x: number; y: number; w: number; h: number };
  at: number;
  hit: T;
}

export const HOVER_FRESH_MS = 2000;

/**
 * The outlined message, when the click landed inside it and the outline is
 * fresh: what the user saw highlighted is what opens. Slack cannot scroll under
 * the overlay (it takes the wheel), so the rect is still where it was drawn.
 */
export function hoverFor<T>(h: HoverHit<T> | null, x: number, y: number, now: number): T | null {
  if (!h || now - h.at > HOVER_FRESH_MS) return null;
  const r = h.rect;
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h ? h.hit : null;
}

/**
 * Whether to ask the helper about Accessibility before showing the overlay. A
 * helper that has already said yes keeps that answer: a revoked grant shows up
 * as 'untrusted' on the click's hit-test, which clears the cache.
 */
export function needsTrustCheck(cachedTrusted: boolean): boolean {
  return !cachedTrusted;
}

// ---- Where a pick may look (2026-11-11) ---------------------------------------
//
// The AX helper decides "is Slack on top at this point" from the window list,
// skipping every window owned by Loom's process so the pick overlay never counts
// as covering Slack. That also skips Loom's MAIN window: wherever Loom covers
// Slack, Slack counted as on top and AX outlined Slack's hidden layout through
// Loom. The helper's code hash is its Accessibility grant, so the fix lives here
// instead of in the Swift: Loom knows its own windows and focus, and asks macOS
// which app is frontmost (lsappinfo, src/frontapp.ts).

export const SLACK_BUNDLE_ID = 'com.tinyspeck.slackmacgap';

export interface PickWhere {
  /** A Loom window other than the overlay is the focused window. */
  loomFocused: boolean;
  /** Slack is the frontmost app: true, false, or null when unknown. */
  slackFrontmost: boolean | null;
  /** Visible, non-minimized Loom windows (not the overlays), in screen points. */
  loomWindows: Rect[];
}

/** Whether a press may arm the overlay. Never over a focused Loom window. */
export function pickMayArm(w: Pick<PickWhere, 'loomFocused' | 'slackFrontmost'>): boolean {
  return !w.loomFocused || w.slackFrontmost === true;
}

const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

/**
 * Whether a point may be hit-tested in Slack. Not while Loom is focused, and not
 * inside a Loom window unless Slack is known to be frontmost (then Slack's own
 * windows are above Loom's, and the helper's window check is right again).
 */
export function pickMayLook(w: PickWhere, x: number, y: number): 'ok' | 'loom-focused' | 'over-loom' {
  if (w.slackFrontmost === true) return 'ok';
  if (w.loomFocused) return 'loom-focused';
  if (w.loomWindows.some((r) => inRect(r, x, y))) return 'over-loom';
  return 'ok';
}
