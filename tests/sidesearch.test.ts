import { describe, it, expect } from 'vitest';
import { SIDESEARCH_JS } from '../src/sidesearch.ts';
import { renderDashboard } from '../src/dashboard.ts';

type C = { session_id: string; last_active_at: number; live?: boolean; done?: boolean };
type H = { session_id: string; ended_at: number };
const api = new Function(`${SIDESEARCH_JS}; return {splitMatches,archiveWanted};`)() as {
  splitMatches: (m: C[], o: (c: C) => boolean, h: H[], ids: string[]) => { open: C[]; archivedBoard: C[]; archiveHits: H[]; archivedCount: number };
  archiveWanted: (q: string) => boolean;
};
const chats: C[] = [
  { session_id: 'a', last_active_at: 10, live: true },
  { session_id: 'b', last_active_at: 50 },
  { session_id: 'c', last_active_at: 30, done: true },
];
const isOpen = (c: C) => !!c.live;

describe('sidebar search sections', () => {
  it('puts open matches first and every other board match in Archived, newest first', () => {
    const r = api.splitMatches(chats, isOpen, [], []);
    expect(r.open.map((c) => c.session_id)).toEqual(['a']);
    expect(r.archivedBoard.map((c) => c.session_id)).toEqual(['b', 'c']);
  });
  it('does not depend on the Live/All toggle: the caller passes the same full match set either way', () => {
    // The split only sees matches and isOpen, never liveOnly, so both toggle states agree.
    expect(api.splitMatches(chats, isOpen, [], [])).toEqual(api.splitMatches(chats.slice(), isOpen, [], []));
  });
  it('dedupes archive hits against board chats and each other, newest first', () => {
    const hits: H[] = [
      { session_id: 'b', ended_at: 99 },
      { session_id: 'x', ended_at: 5 },
      { session_id: 'y', ended_at: 7 },
      { session_id: 'y', ended_at: 7 },
      { session_id: 'saved1', ended_at: 8 },
    ];
    const r = api.splitMatches(chats, isOpen, hits, ['saved1']);
    expect(r.archiveHits.map((h) => h.session_id)).toEqual(['y', 'x']);
    expect(r.archivedCount).toBe(4);
  });
  it('only auto-searches the archive for 2+ characters', () => {
    expect(api.archiveWanted('a')).toBe(false);
    expect(api.archiveWanted(' a ')).toBe(false);
    expect(api.archiveWanted('ab')).toBe(true);
  });
  it('wires the page: debounce, placeholder, sections, and no separate link', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('Search open and archived chats');
    expect(html).not.toContain('id="deep"');
    expect(html).toContain('setTimeout(runArchive,400)');
    expect(html).toContain('>Open · ');
    expect(html).toContain('>Archived · ');
    // Cleared query: renderArchive empties the box and render() uses scoped() (toggle respected).
    expect(html).toContain("if(!SPLIT||!searchActive()){box.innerHTML='';return;}");
  });
});
