import { describe, it, expect } from 'vitest';
import { SIDESORT_JS } from '../src/sidesort.ts';

type Row = { id: string; started: number; stamp: number };
const api = new Function(`${SIDESORT_JS}; return {sortModeOf,sortComparator,makeStamper,pinOrder,SORT_DEFAULT,sortAgeMs,sortAgeTip,isFlatList};`)() as {
  sortModeOf: (v: unknown) => string;
  sortComparator: (m: string, f: Record<string, (c: Row) => unknown>) => (a: Row, b: Row) => number;
  makeStamper: () => (key: string, sig: string, at: number) => number;
  pinOrder: (prev: string[], want: string[], pinned: Record<string, boolean>) => string[];
  SORT_DEFAULT: string;
  sortAgeMs: (m: string, started: number, fresh: number) => number;
  sortAgeTip: (started: number, fresh: number, rel: (n: number) => string) => string;
  isFlatList: (m: string, g: string, tab: string) => boolean;
};
const f = { started: (c: Row) => c.started, stamp: (c: Row) => c.stamp, key: (c: Row) => c.id };
const rows: Row[] = [
  { id: 'a', started: 100, stamp: 500 },
  { id: 'b', started: 300, stamp: 200 },
  { id: 'c', started: 200, stamp: 900 },
];
const order = (m: string) => rows.slice().sort(api.sortComparator(m, f)).map((r) => r.id);

describe('sort comparators', () => {
  it('defaults to started, newest first, and rejects unknown values', () => {
    expect(api.SORT_DEFAULT).toBe('recent');
    expect(api.sortModeOf('active')).toBe('recent');
    expect(api.sortModeOf(null)).toBe('recent');
    expect(api.sortModeOf('old')).toBe('old');
  });
  it('orders by start time, newest or oldest first', () => {
    expect(order('new')).toEqual(['b', 'c', 'a']);
    expect(order('old')).toEqual(['a', 'c', 'b']);
  });
  it('orders recent activity by stamp', () => {
    expect(order('recent')).toEqual(['c', 'a', 'b']);
  });
  it('breaks ties on the key so equal rows never swap', () => {
    const t: Row[] = [{ id: 'z', started: 1, stamp: 1 }, { id: 'y', started: 1, stamp: 1 }];
    expect(t.slice().sort(api.sortComparator('new', f)).map((r) => r.id)).toEqual(['y', 'z']);
    expect(t.slice().reverse().sort(api.sortComparator('recent', f)).map((r) => r.id)).toEqual(['y', 'z']);
  });
});

describe('turn-boundary stamps', () => {
  it('only moves a stamp when the status signature changes', () => {
    const stamp = api.makeStamper();
    expect(stamp('a', 'turn', 100)).toBe(100);
    expect(stamp('a', 'turn', 150)).toBe(100); // streamed output, same status
    expect(stamp('a', 'turn', 190)).toBe(100);
    expect(stamp('a', 'working', 200)).toBe(200); // a new prompt flips it
    expect(stamp('a', 'working', 260)).toBe(200);
    expect(stamp('b', 'turn', 50)).toBe(50);
  });
  it('corrects a stamp down to the real last activity, never up without a status change', () => {
    const stamp = api.makeStamper();
    expect(stamp('old', 'turn', 9_000)).toBe(9_000); // first seen with a transient file-write time
    expect(stamp('old', 'turn', 1_000)).toBe(1_000); // the real last turn is 4 days back: it drops
    expect(stamp('old', 'turn', 1_500)).toBe(1_000); // and does not climb again on its own
  });
});

describe('pinOrder (stable reorder)', () => {
  it('is the wanted order when nothing is pinned', () => {
    expect(api.pinOrder(['a', 'b', 'c'], ['c', 'a', 'b'], {})).toEqual(['c', 'a', 'b']);
  });
  it('keeps a pinned row in its slot and fills the rest in wanted order', () => {
    expect(api.pinOrder(['a', 'b', 'c'], ['c', 'a', 'b'], { b: true })).toEqual(['c', 'b', 'a']);
    expect(api.pinOrder(['a', 'b', 'c', 'd'], ['d', 'c', 'b', 'a'], { a: true })).toEqual(['a', 'd', 'c', 'b']);
  });
  it('freezes the list when every row is pinned, placing a new row in the gap', () => {
    const all = { a: true, b: true, c: true };
    expect(api.pinOrder(['a', 'b', 'c'], ['c', 'b', 'a', 'n'], all)).toEqual(['a', 'b', 'c', 'n']);
  });
  it('drops rows that left and keeps the result a permutation of want', () => {
    const out = api.pinOrder(['a', 'b', 'c'], ['c', 'a'], { b: true, a: true });
    expect(out.slice().sort()).toEqual(['a', 'c']);
    expect(out[0]).toBe('a');
  });
});

describe('row age and flat list', () => {
  it('the age shown is the sort key', () => {
    expect(api.sortAgeMs('new', 100, 900)).toBe(100);
    expect(api.sortAgeMs('old', 100, 900)).toBe(100);
    expect(api.sortAgeMs('recent', 100, 900)).toBe(900);
    expect(api.sortAgeMs('new', 0, 900)).toBe(900);
  });
  it('rows sorted by Started carry ages that read in order', () => {
    const now = 1_000_000;
    const chats = [{ id: 'x', started: now - 5000, fresh: now - 100 }, { id: 'y', started: now - 90000, fresh: now - 200 }, { id: 'z', started: now - 20000, fresh: now - 50 }];
    const ages = chats.slice().sort((a, b) => b.started - a.started).map((c) => now - api.sortAgeMs('new', c.started, c.fresh));
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
  });
  it('tooltip names both times', () => {
    expect(api.sortAgeTip(5, 9, (n) => n + 'x ago')).toBe('Started 5x ago \u00b7 active 9x ago');
    expect(api.sortAgeTip(0, 9, (n) => n + 'x ago')).toBe('active 9x ago');
  });
  it('Recent activity is flat unless grouped by tag or on Saved', () => {
    expect(api.isFlatList('recent', 'status', 'board')).toBe(true);
    expect(api.isFlatList('recent', 'tag', 'board')).toBe(false);
    expect(api.isFlatList('recent', 'status', 'saved')).toBe(false);
    expect(api.isFlatList('new', 'status', 'board')).toBe(false);
    expect(api.isFlatList('old', 'status', 'board')).toBe(false);
  });
});
