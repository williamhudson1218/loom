import { describe, expect, it } from 'vitest';
import { SCROLLFOLLOW_JS } from '../src/mobile/scrollfollow.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const lib = new Function(`${SCROLLFOLLOW_JS}; return { nearBottom, scrollBusy, ownScroll, followAfterScroll, afterPaint, firstChange, dockTake, FOLLOW_IDLE_MS };`)() as any;

describe('phone chat scroll follow', () => {
  it('follows only near the bottom', () => {
    expect(lib.followAfterScroll(1000, 590, 400)).toBe(true);
    expect(lib.followAfterScroll(1000, 560, 400)).toBe(false);
    expect(lib.nearBottom(1000, 600, 400)).toBe(true);
  });

  it('never scrolls while a finger is down or the list is still coasting', () => {
    expect(lib.scrollBusy(true, 0, 10_000)).toBe(true);
    expect(lib.scrollBusy(false, 10_000 - 100, 10_000)).toBe(true);
    expect(lib.scrollBusy(false, 10_000 - lib.FOLLOW_IDLE_MS, 10_000)).toBe(false);
  });

  it('tells its own scroll from the reader', () => {
    expect(lib.ownScroll(500, 501)).toBe(true);
    expect(lib.ownScroll(500, 480)).toBe(false);
    expect(lib.ownScroll(null, 0)).toBe(false);
  });

  it('anchors a prepend, follows the bottom, else keeps the view', () => {
    expect(lib.afterPaint(false, true, true)).toBe('anchor');
    expect(lib.afterPaint(true, false, false)).toBe('bottom');
    expect(lib.afterPaint(false, true, false)).toBe('bottom');
    expect(lib.afterPaint(false, false, false)).toBe('keep');
  });

  it('finds the first changed message, so a poll appends instead of rebuilding', () => {
    expect(lib.firstChange(['a', 'b'], ['a', 'b'])).toBe(-1);
    expect(lib.firstChange(['a', 'b'], ['a', 'b', 'c'])).toBe(2);
    expect(lib.firstChange(['a', 'b'], ['a', 'x', 'c'])).toBe(1);
    expect(lib.firstChange(['a', 'b', 'c'], ['a', 'b'])).toBe(2);
    expect(lib.firstChange([], [])).toBe(-1);
  });
});

describe('dockTake', () => {
  it('never opens the dock for a new draft, only flags it fresh', () => {
    const r = lib.dockTake({ open: false, seen: ['a'] }, ['a', 'b']);
    expect(r.fresh).toBe(true);
    expect(r.mem).toEqual({ open: false, seen: ['a', 'b'] });
  });
  it('keeps the open flag the reader chose', () => {
    expect(lib.dockTake({ open: true, seen: ['a'] }, ['a']).mem.open).toBe(true);
    expect(lib.dockTake({ open: true, seen: ['a'] }, ['a']).changed).toBe(false);
  });
  it('records a shrink without flagging fresh', () => {
    const r = lib.dockTake({ open: false, seen: ['a', 'b'] }, ['a']);
    expect(r.fresh).toBe(false);
    expect(r.changed).toBe(true);
  });
});
