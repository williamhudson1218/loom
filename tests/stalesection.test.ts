import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SIDESORT_JS } from '../src/sidesort.ts';

type Row = { id: string; started: number; at: number };
const api = new Function(`${SIDESORT_JS}; return {isStaleAge,splitStale,sortComparator,pinOrder};`)() as {
  isStaleAge: (t: number, now: number) => boolean;
  splitStale: (rows: Row[], k: (r: Row) => string, t: (r: Row) => number, prev: Record<string, boolean> | null, hold: boolean, now: number) => { main: Row[]; stale: Row[]; next: Record<string, boolean>; moved: boolean };
  sortComparator: (m: string, f: Record<string, (c: Row) => unknown>) => (a: Row, b: Row) => number;
  pinOrder: (prev: string[], want: string[], pinned: Record<string, boolean>) => string[];
};
const H = 3600000, D = 24 * H;
const now = new Date(2026, 10, 12, 15, 0, 0).getTime();
const startOfYesterday = new Date(2026, 10, 11, 0, 0, 0).getTime();
const k = (r: Row) => r.id;
const t = (r: Row) => r.at;
const rows: Row[] = [
  { id: 'fresh', started: 5, at: now - 10 * 60000 },
  { id: 'today', started: 4, at: now - 5 * H },
  { id: 'yday', started: 3, at: startOfYesterday + H },
  { id: 'old', started: 2, at: startOfYesterday - H },
  { id: 'ancient', started: 1, at: now - 9 * D },
];

describe('stale rule', () => {
  it('stale = last activity before the start of yesterday', () => {
    expect(api.isStaleAge(startOfYesterday - 1, now)).toBe(true);
    expect(api.isStaleAge(startOfYesterday, now)).toBe(false);
    expect(api.isStaleAge(now, now)).toBe(false);
    expect(api.isStaleAge(0, now)).toBe(false);
  });
  it('partitions identically in every sort mode', () => {
    for (const mode of ['new', 'old', 'recent']) {
      const cmp = api.sortComparator(mode, { started: (c) => c.started, stamp: (c) => c.at, key: (c) => c.id });
      const sorted = rows.slice().sort(cmp);
      const sp = api.splitStale(sorted, k, t, null, false, now);
      expect(sp.main.map(k).sort()).toEqual(['fresh', 'today', 'yday']);
      expect(sp.stale.map(k).sort()).toEqual(['ancient', 'old']);
      const want = sorted.filter((r) => sp.stale.includes(r)).map(k);
      expect(sp.stale.map(k)).toEqual(want); // section keeps the sort order
    }
  });
  it('a row un-stales on new activity and returns to the main list', () => {
    const first = api.splitStale(rows, k, t, null, false, now);
    const revived = rows.map((r) => (r.id === 'old' ? { ...r, at: now } : r));
    const next = api.splitStale(revived, k, t, first.next, false, now);
    expect(next.main.map(k)).toContain('old');
    expect(next.stale.map(k)).toEqual(['ancient']);
  });
  it('holds sections while the pointer is over the sidebar, then applies the move', () => {
    const first = api.splitStale(rows, k, t, null, false, now);
    const revived = rows.map((r) => (r.id === 'old' ? { ...r, at: now } : r));
    const held = api.splitStale(revived, k, t, first.next, true, now);
    expect(held.stale.map(k).sort()).toEqual(['ancient', 'old']);
    expect(held.moved).toBe(true);
    const released = api.splitStale(revived, k, t, held.next, false, now);
    expect(released.main.map(k)).toContain('old');
    // a row never seen before is placed by the rule even while held
    const added = api.splitStale([...rows, { id: 'new', started: 9, at: now }], k, t, first.next, true, now);
    expect(added.main.map(k)).toContain('new');
  });
  it('pinned order inside the stale section still holds', () => {
    const pinned = { ancient: true, old: true };
    expect(api.pinOrder(['ancient', 'old'], ['old', 'ancient'], pinned)).toEqual(['ancient', 'old']);
  });
});

describe('dashboard wiring', () => {
  const src = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
  it('the row tint and the section share the one rule', () => {
    expect(src).toMatch(/isStaleAge\(t,now\)\?' age-old'/);
    expect(src).toContain('splitStale(rows,chatKey,fresh,staleSeen');
  });
  it('the Stale header persists collapse in the existing grpCollapsed pref', () => {
    expect(src).toContain("const gk='section:stale',closed=collapsed.indexOf(gk)>=0");
    expect(src).toContain("lsSet('loom.grpCollapsed'");
  });
  it('search results skip the Stale split', () => {
    expect(src).toContain('sidebarRows(rows,true)');
  });
});
