import { describe, it, expect } from 'vitest';
import { TERMWARM_JS } from '../src/termwarm.ts';
import { checkSnapAuth, parseSnapshotOut, snapshotArgs, snapshotData, snapshotScreen } from '../src/ptybridge.ts';

const w = new Function(`${TERMWARM_JS}; return { createHandoff, snapPaint, livePaint, fitSnap, WarmPool, SnapCache };`)() as any;

describe('snapshot -> live handoff', () => {
  it('paints the snapshot, then resets once on the first live byte only', () => {
    const h = w.createHandoff();
    expect(w.snapPaint(h, 'SCREEN')).toBe('SCREEN');
    expect(w.livePaint(h).reset).toBe(true);
    expect(w.livePaint(h).reset).toBe(false);
  });
  it('does not reset when no snapshot ever arrived', () => {
    const h = w.createHandoff();
    expect(w.livePaint(h).reset).toBe(false);
  });
  it('drops a snapshot that lands after live bytes', () => {
    const h = w.createHandoff();
    w.livePaint(h);
    expect(w.snapPaint(h, 'LATE')).toBeNull();
  });
  it('a fresher second snapshot resets first; empty text paints nothing', () => {
    const h = w.createHandoff();
    expect(w.snapPaint(h, 'A')).toBe('A');
    expect(w.snapPaint(h, 'B')).toBe('\x1bcB');
    expect(w.snapPaint(h, '')).toBeNull();
  });
});

describe('fitSnap', () => {
  const r = { screen: 'a\nb\nc\nd\n', cx: 2, cy: 3, flag: 1 };
  it('keeps every row when the panel is tall enough', () => {
    expect(w.fitSnap(r, 10)).toBe('\x1b[0m\x1b[H\x1b[2J\x1b[3Ja\r\nb\r\nc\r\nd\x1b[0m\x1b[4;3H\x1b[?25h');
  });
  it('keeps the bottom rows and moves the cursor with them', () => {
    expect(w.fitSnap(r, 2)).toBe('\x1b[0m\x1b[H\x1b[2J\x1b[3Jc\r\nd\x1b[0m\x1b[2;3H\x1b[?25h');
  });
  it('hides the cursor when tmux does; tolerates junk', () => {
    expect(w.fitSnap({ ...r, flag: 0 }, 10)).toContain('\x1b[?25l');
    expect(w.fitSnap(null, 10)).toBe('');
  });
  it('matches the server-side snapshotData for a panel that fits', () => {
    expect(w.fitSnap(r, 10)).toBe(snapshotData(r.screen, r.cx, r.cy, r.flag));
  });
});

describe('WarmPool', () => {
  it('evicts the least recently parked, oldest first', () => {
    const p = new w.WarmPool(2);
    expect(p.park('a', 1)).toEqual([]);
    expect(p.park('b', 2)).toEqual([]);
    expect(p.park('c', 3)).toEqual([{ k: 'a', v: 1 }]);
    expect(p.keys()).toEqual(['b', 'c']);
  });
  it('take removes and refreshes recency when re-parked', () => {
    const p = new w.WarmPool(2);
    p.park('a', 1); p.park('b', 2);
    expect(p.take('a')).toBe(1);
    expect(p.has('a')).toBe(false);
    p.park('a', 1);
    expect(p.park('c', 3)).toEqual([{ k: 'b', v: 2 }]);
  });
  it('re-parking a key with a new value hands back the old one', () => {
    const p = new w.WarmPool(4);
    p.park('a', 1);
    expect(p.park('a', 2)).toEqual([{ k: 'a', v: 1 }]);
    expect(p.take('a')).toBe(2);
    expect(p.take('zzz')).toBeNull();
  });
});

describe('SnapCache', () => {
  it('shares one fetch inside the ttl, refetches after, never caches a miss', async () => {
    let n = 0;
    let reply: any = { ok: 1 };
    const c = new w.SnapCache(async () => { n++; return reply; }, 1000);
    await c.get('%1', 0); await c.get('%1', 500);
    expect(n).toBe(1);
    await c.get('%1', 1500);
    expect(n).toBe(2);
    reply = null;
    await c.get('%2', 0); await Promise.resolve();
    await c.get('%2', 1);
    expect(n).toBe(4);
  });
});

describe('server snapshot', () => {
  it('chains the header and capture into one tmux invocation', () => {
    const a = snapshotArgs('%7');
    expect(a.filter((x) => x === ';')).toHaveLength(1);
    expect(a).toContain('capture-pane');
  });
  it('parses header + screen; rejects junk', () => {
    expect(parseSnapshotOut('4 2 80 24 1\nhello\nworld\n')).toEqual({ cx: 4, cy: 2, cols: 80, rows: 24, flag: 1, screen: 'hello\nworld\n' });
    expect(parseSnapshotOut('nope')).toBeNull();
    expect(parseSnapshotOut('x y z\nabc')).toBeNull();
  });
  it('dedupes captures inside the ttl per pane', async () => {
    let n = 0;
    const run = async () => { n++; return '0 0 80 24 1\nscreen\n'; };
    const a = await snapshotScreen('%dedupe', run, 1000);
    await snapshotScreen('%dedupe', run, 1400);
    expect(a?.screen).toBe('screen\n');
    expect(n).toBe(1);
    await snapshotScreen('%dedupe', run, 2000);
    expect(n).toBe(2);
  });
  it('null when tmux fails', async () => {
    expect(await snapshotScreen('%gone', async () => { throw new Error('x'); }, 5000)).toBeNull();
  });
  it('auth: host and token required, origin only if present', () => {
    const o = { port: 4317, token: 'tok' };
    const h = { host: 'localhost:4317' };
    expect(checkSnapAuth(h, 'tok', o).ok).toBe(true);
    expect(checkSnapAuth(h, 'bad', o).ok).toBe(false);
    expect(checkSnapAuth({ host: 'evil.com' }, 'tok', o).ok).toBe(false);
    expect(checkSnapAuth({ ...h, origin: 'http://evil.com' }, 'tok', o).ok).toBe(false);
    expect(checkSnapAuth({ ...h, origin: 'http://localhost:4317' }, 'tok', o).ok).toBe(true);
  });
});
