import { describe, it, expect } from 'vitest';
import { SIDESORT_JS } from '../src/sidesort.ts';
import { HOME_PURE_JS, HOME_VIEW_JS, HOME_VIEW_HTML } from '../src/homeview.ts';
import { renderDashboard } from '../src/dashboard.ts';

type Row = { key: string; working: boolean; turn: boolean; at: number };
const api = new Function(
  `${SIDESORT_JS};${HOME_PURE_JS}; return {homeClassify,homeOldest,homeAge,homeHeadline,homeShipTotals,homeOrchTotals,homeOrbitLayout};`,
)() as {
  homeClassify: (r: Row[], now: number) => Record<'working' | 'turn' | 'stale' | 'rest', Row[]>;
  homeOldest: (r: Row[]) => Row | null;
  homeAge: (t: number, now: number) => string;
  homeHeadline: (w: number, f: number) => { t: string; accent: boolean }[];
  homeShipTotals: (b: unknown[], nameOf?: (r: string) => string) => { files: number; chats: number; repos: { repo: string; name: string; staged: number; chats: number }[]; lines: { key: string; staged: number }[] };
  homeOrchTotals: (i: unknown[]) => { needs: { id: number }[]; needsN: number; blocked: number };
  homeOrbitLayout: (W: number, H: number, g: Record<string, string[]>) => { rings: { k: string; rx: number; ry: number }[]; planets: { key: string; k: string; x: number; y: number; size: number }[] };
};

// 2026-11-13 14:00 local, so "start of yesterday" is 2026-11-12 00:00 local.
const now = new Date(2026, 10, 13, 14, 0, 0).getTime();
const ago = (ms: number) => now - ms;
const H = 3600_000;

describe('home classify', () => {
  it('splits live chats by the shared stale rule, stale winning over working and your turn', () => {
    const rows: Row[] = [
      { key: 'w', working: true, turn: false, at: ago(1000) },
      { key: 't', turn: true, working: false, at: ago(38 * 60_000) },
      { key: 'old-turn', turn: true, working: false, at: new Date(2026, 10, 11, 23, 0).getTime() },
      { key: 'yday', turn: true, working: false, at: new Date(2026, 10, 12, 9, 0).getTime() }, // yesterday: not stale
      { key: 'r', turn: false, working: false, at: ago(2 * H) },
    ];
    const c = api.homeClassify(rows, now);
    expect(c.working.map((r) => r.key)).toEqual(['w']);
    expect(c.turn.map((r) => r.key)).toEqual(['t', 'yday']);
    expect(c.stale.map((r) => r.key)).toEqual(['old-turn']);
    expect(c.rest.map((r) => r.key)).toEqual(['r']);
  });
  it('a chat with no time is never stale', () => {
    expect(api.homeClassify([{ key: 'x', working: false, turn: true, at: 0 }], now).turn).toHaveLength(1);
  });
  it('finds the oldest waiting chat', () => {
    expect(api.homeOldest([{ key: 'a', at: 5 }, { key: 'b', at: 2 }, { key: 'c', at: 9 }] as Row[])?.key).toBe('b');
    expect(api.homeOldest([])).toBeNull();
  });
});

describe('home headline and ages', () => {
  const text = (w: number, f: number) => api.homeHeadline(w, f).map((p) => p.t).join(' ');
  it('handles zero, one and many', () => {
    expect(text(4, 7)).toBe('4 chats are waiting on you. 7 are in flight.');
    expect(text(1, 1)).toBe('1 chat is waiting on you. 1 is in flight.');
    expect(text(0, 0)).toBe('Nothing is waiting on you. Nothing is in flight.');
  });
  it('accents the in-flight sentence only', () => {
    expect(api.homeHeadline(2, 3).map((p) => p.accent)).toEqual([false, true]);
  });
  it('formats short ages', () => {
    expect(api.homeAge(ago(5_000), now)).toBe('now');
    expect(api.homeAge(ago(38 * 60_000), now)).toBe('38m');
    expect(api.homeAge(ago(3 * H), now)).toBe('3h');
    expect(api.homeAge(ago(50 * H), now)).toBe('2d');
    expect(api.homeAge(0, now)).toBe('');
  });
});

describe('home ship and orchestrator totals', () => {
  const boards = [
    { repo: '/r/a', next: { staged: 5, chats: [{ key: 'c1', staged: 3 }, { key: 'c2', staged: 2 }, { key: 'c3', staged: 0 }] } },
    { repo: '/r/b', next: { staged: 2, chats: [{ key: 'c1', staged: 2 }] } },
    { repo: '/r/c', next: { staged: 0, chats: [] } },
  ];
  it('sums staged files, counts distinct chats and lists repos busiest first', () => {
    const t = api.homeShipTotals(boards, (r) => r.split('/').pop() as string);
    expect(t.files).toBe(7);
    expect(t.chats).toBe(2);
    expect(t.repos.map((r) => [r.name, r.staged])).toEqual([['a', 5], ['b', 2]]);
    expect(t.lines[0]).toEqual({ key: 'c1', staged: 3 });
  });
  it('is empty with no boards', () => expect(api.homeShipTotals([]).files).toBe(0));
  it('counts open needs-you and blocked items, ignoring resolved ones', () => {
    const t = api.homeOrchTotals([
      { id: 1, kind: 'needs_you', resolved_at: 0 },
      { id: 2, kind: 'needs_you', resolved_at: 99 },
      { id: 3, kind: 'blocked', resolved_at: 0 },
      { id: 4, kind: 'moving', resolved_at: 0 },
    ]);
    expect(t.needsN).toBe(1);
    expect(t.blocked).toBe(1);
    expect(t.needs[0].id).toBe(1);
  });
});

describe('orbit layout', () => {
  const lay = api.homeOrbitLayout(900, 500, { turn: ['a', 'b'], working: ['c'], stale: [] });
  it('puts your turn inside working inside stale, rings wider than tall', () => {
    expect(lay.rings.map((r) => r.k)).toEqual(['turn', 'working', 'stale']);
    expect(lay.rings[0].ry).toBeLessThan(lay.rings[1].ry);
    expect(lay.rings[1].ry).toBeLessThan(lay.rings[2].ry);
    lay.rings.forEach((r) => expect(r.rx).toBeGreaterThan(r.ry));
  });
  it('places every planet on its ring, in the box', () => {
    expect(lay.planets.map((p) => p.key)).toEqual(['a', 'b', 'c']);
    for (const p of lay.planets) {
      const r = lay.rings.find((x) => x.k === p.k)!;
      expect(((p.x - 450) / r.rx) ** 2 + ((p.y - 250) / r.ry) ** 2).toBeCloseTo(1, 5);
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(900);
    }
  });
  it('keeps the widest ring inside a narrow box', () => {
    const n = api.homeOrbitLayout(320, 500, { turn: [], working: [], stale: ['z'] });
    expect(n.rings[2].rx).toBeLessThanOrEqual(160 - 48);
  });
});

describe('home view wiring', () => {
  const html = renderDashboard([], Date.now(), {}, 'claude');
  it('has no backtick or dollar-brace, so it embeds cleanly', () => {
    expect(HOME_VIEW_JS).not.toMatch(/`|\$\{/);
    expect(HOME_VIEW_HTML).not.toMatch(/`|\$\{/);
  });
  it('pins Home above the Orchestrator row and mounts the view inside the main area', () => {
    expect(html.indexOf('id="homepin"')).toBeLessThan(html.indexOf('id="orchpin"'));
    expect(html).toContain('id="homeview"');
    expect(html).toContain('function selectHome(');
  });
  it('shows only shortcuts that exist', () => {
    expect(HOME_VIEW_JS).toContain('var HOME_KEYS={"newThread":"⌘N","jump":"⌘K"}');
  });
  it('every other selection leaves Home, and the first render is Home', () => {
    expect(html).toContain('function selectChat(sid,agent,arch){leaveHome();');
    expect(html).toContain('function selectOrch(){leaveHome();');
    expect(html).toContain('function selectTerminal(session,win){if(!TERM_TOKEN)return;leaveHome();');
    expect(html).toContain('var homeSel=true;');
  });
});
