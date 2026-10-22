import { describe, it, expect } from 'vitest';
import { carryTabMap, placeable, GHOSTTY_TABS_TTL_MS, type Layout } from '../src/snapshot.ts';
import type { SavedGhosttyWindow } from '../src/ghostty.ts';

const TP = ['loom-tp-terminals', 'loom-tp-2', 'loom-tp-3', 'loom-tp-code'];
const FORMS = ['loom-tp-forms-1', 'loom-tp-forms-2', 'loom-tp-forms-3'];
const SHELL = 'willhudson@Wills-MacBook-Pro:~/dev/tax-pilot-app';

const layoutOf = (names: string[], taken_at = 2_000_000): Layout => ({
  taken_at,
  sessions: names.map((name) => ({ name, windows: [] })),
});

const win = (tabs: string[]): SavedGhosttyWindow => ({ tabs, bounds: { x: 0, y: 33, w: 1728, h: 1012 } });

// The snapshot as it stood before the tmux server died: two windows, every tab
// titled by its session.
const saved = (): Layout => ({
  ...layoutOf([...TP, ...FORMS], 1_000_000),
  ghostty_tabs: [...TP, ...FORMS],
  ghostty_windows: [win(TP), win(FORMS)],
  ghostty_tabs_at: 1_000_000,
});

describe('placeable', () => {
  it('counts the sessions a tab map can put in a window', () => {
    expect(placeable([win(TP), win(FORMS)], layoutOf([...TP, ...FORMS]))).toBe(7);
    expect(placeable([win([SHELL, SHELL])], layoutOf(TP))).toBe(0);
    expect(placeable([], layoutOf(TP))).toBe(0);
  });

  it('matches a title that ends with the session name, like gotoPane does', () => {
    expect(placeable([win(['~ ACH Prenote Retry · loom-tp-2'])], layoutOf(['loom-tp-2']))).toBe(1);
  });
});

describe('carryTabMap', () => {
  it('takes the first read that names the sessions', () => {
    const layout = layoutOf([...TP, ...FORMS]);
    carryTabMap(layout, null, [win(TP), win(FORMS)], 2_000_000);
    expect(layout.ghostty_windows).toEqual([win(TP), win(FORMS)]);
    expect(layout.ghostty_tabs).toEqual([...TP, ...FORMS]);
    expect(layout.ghostty_tabs_at).toBe(2_000_000);
  });

  it('keeps the saved map when every tab has reverted to its shell prompt', () => {
    // 2026-10-20: the tmux server died, the TTL had long expired, and the first
    // snapshot after restore recreated the sessions read a tab bar of bare
    // shells. Accepting it replaced the two-window map with one that placed
    // nothing, and `loom restore` then piled all 19 sessions into one window.
    const prev = saved();
    const layout = layoutOf([...TP, ...FORMS]);
    carryTabMap(layout, prev, [win(Array(4).fill(SHELL)), win(Array(3).fill(SHELL))], 2_000_000);
    expect(layout.ghostty_windows).toEqual(prev.ghostty_windows);
    expect(layout.ghostty_tabs).toEqual(prev.ghostty_tabs);
  });

  it('does not retry an uninformative read every tick', () => {
    const layout = layoutOf(TP);
    carryTabMap(layout, saved(), [win(Array(4).fill(SHELL))], 2_000_000);
    expect(layout.ghostty_tabs_at).toBe(2_000_000);
    expect(2_000_000 + 15_000 - layout.ghostty_tabs_at!).toBeLessThan(GHOSTTY_TABS_TTL_MS);
  });

  it('keeps the saved map while a restore has only retitled some tabs', () => {
    const prev = saved();
    const layout = layoutOf([...TP, ...FORMS]);
    const midAttach = [win([TP[0], TP[1], SHELL, SHELL]), win(Array(3).fill(SHELL))];
    carryTabMap(layout, prev, midAttach, 2_000_000);
    expect(layout.ghostty_windows).toEqual(prev.ghostty_windows);
  });

  it('takes a read that places every session once the restore has finished', () => {
    const layout = layoutOf([...TP, ...FORMS]);
    const rebuilt = [win([...TP, 'loom-tp-new']), win(FORMS)];
    carryTabMap(layout, saved(), rebuilt, 2_000_000);
    expect(layout.ghostty_windows).toEqual(rebuilt);
    expect(layout.ghostty_tabs_at).toBe(2_000_000);
  });

  it('is not pinned by sessions that have since been closed', () => {
    // The saved map names seven sessions; three forms sessions were closed and
    // their tabs are gone. The read places all four that are left, which is
    // everything the saved map could place for them too.
    const layout = layoutOf(TP);
    carryTabMap(layout, saved(), [win(TP)], 2_000_000);
    expect(layout.ghostty_windows).toEqual([win(TP)]);
  });

  it('takes a read that moves tabs between windows', () => {
    const layout = layoutOf([...TP, ...FORMS]);
    const moved = [win([...TP, FORMS[0]]), win(FORMS.slice(1))];
    carryTabMap(layout, saved(), moved, 2_000_000);
    expect(layout.ghostty_windows).toEqual(moved);
  });

  it('keeps the saved map and its read time on an empty read', () => {
    // Ghostty closed or accessibility denied: nothing to learn, try again next tick.
    const prev = saved();
    const layout = layoutOf([...TP, ...FORMS]);
    carryTabMap(layout, prev, [], 2_000_000);
    expect(layout.ghostty_windows).toEqual(prev.ghostty_windows);
    expect(layout.ghostty_tabs_at).toBe(1_000_000);
  });

  it('carries the saved map forward when the tab bar was not read', () => {
    const prev = saved();
    const layout = layoutOf([...TP, ...FORMS]);
    carryTabMap(layout, prev, null, 2_000_000);
    expect(layout.ghostty_windows).toEqual(prev.ghostty_windows);
    expect(layout.ghostty_tabs).toEqual(prev.ghostty_tabs);
    expect(layout.ghostty_tabs_at).toBe(1_000_000);
  });

  it('reads a legacy snapshot with only the flat tab list as one window', () => {
    const prev: Layout = { ...layoutOf(TP, 1_000_000), ghostty_tabs: TP, ghostty_tabs_at: 1_000_000 };
    const layout = layoutOf(TP);
    carryTabMap(layout, prev, [win(Array(4).fill(SHELL))], 2_000_000);
    expect(layout.ghostty_tabs).toEqual(TP);
    expect(layout.ghostty_windows).toBeUndefined();
  });

  it('leaves a snapshot with no map and no usable read without one', () => {
    const layout = layoutOf(TP);
    carryTabMap(layout, null, [win(Array(4).fill(SHELL))], 2_000_000);
    expect(layout.ghostty_tabs).toBeUndefined();
    expect(layout.ghostty_windows).toBeUndefined();
  });
});
