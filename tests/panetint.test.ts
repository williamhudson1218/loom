import { describe, it, expect } from 'vitest';
import { PaneTints, TINT_BG, TINT_STYLE, desiredTints, staleness, type TintTmux } from '../src/panetint.ts';
import { agentSessionKey, type LiveInfo } from '../src/placements.ts';

const BASE = [0x1e, 0x1e, 0x2e]; // Ghostty / Catppuccin Mocha background
const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const drift = (hex: string) => channels(hex).map((c, i) => c - BASE[i]);

// ENVELOPE is the widest channel in the APPROVED palette (R+28 on older's
// #3a1d1f; yesterday's B−25 is next), not a perceptual limit and not a round
// number. It exists so a later edit reaching for a hotter colour than the ones
// Will actually signed off on fails here.
const ENVELOPE = 28;

// The one place the hexes are written down twice on purpose, so a fat-fingered
// palette edit fails here rather than showing up as a wrong colour on 24 panes.
describe('palette', () => {
  it('has one colour per stale tier, and none for fresh', () => {
    expect(TINT_BG).toEqual({
      today: '#26241c',
      yesterday: '#332a15',
      older: '#3a1d1f',
    });
    // The active tier is a reset, not a colour. If a hex ever appears here for
    // it, live sessions start getting painted again.
    expect(Object.keys(TINT_BG)).not.toContain('fresh');
  });

  it('derives the tmux style from the palette, so the two cannot drift', () => {
    for (const [bucket, hex] of Object.entries(TINT_BG)) {
      expect(TINT_STYLE[bucket as keyof typeof TINT_BG]).toBe(`bg=${hex}`);
    }
  });

  it('keeps every channel within the approved envelope of the base background', () => {
    for (const [bucket, hex] of Object.entries(TINT_BG)) {
      const worst = Math.max(...drift(hex).map(Math.abs));
      expect(worst, `${bucket} drifts too far from base`).toBeLessThanOrEqual(ENVELOPE);
    }
    // And the envelope is actually the palette's own, not slack left lying around.
    const widest = Math.max(...Object.values(TINT_BG).flatMap((h) => drift(h).map(Math.abs)));
    expect(widest).toBe(ENVELOPE);
  });

  const ORDER = ['today', 'yesterday', 'older'] as const;

  // The ramp IS the feature: the tiers are one ordered dimension, not three hues.
  // Red is the channel that carries it — 38 -> 51 -> 58 — so it must keep rising
  // with staleness. Note that total distance from base and luminance do NOT rise
  // monotonically (yesterday's amber is the brightest of the three); red is the
  // real axis, so it is the one worth pinning.
  it('raises the red channel monotonically with staleness', () => {
    const red = ORDER.map((b) => channels(TINT_BG[b])[0]);
    expect(red).toEqual([...red].sort((a, b) => a - b));
    expect(new Set(red).size).toBe(ORDER.length); // strictly rising, no ties
  });

  // today is the deliberately quiet one: closest to base, and it has to stay that
  // way. A chat touched three hours ago is not urgent, and making it shout drowns
  // out the genuinely dead ones.
  it('keeps today the least departed from base', () => {
    const departure = (b: (typeof ORDER)[number]) =>
      drift(TINT_BG[b]).reduce((s, d) => s + Math.abs(d), 0);
    expect(departure('today')).toBeLessThan(departure('yesterday'));
    expect(departure('today')).toBeLessThan(departure('older'));
  });

  // Three tiers nobody can tell apart is the same as one tier.
  it('keeps the tiers distinguishable from each other and from the base', () => {
    for (const b of ORDER) {
      expect(Math.max(...drift(TINT_BG[b]).map(Math.abs)), `${b} vs base`).toBeGreaterThanOrEqual(8);
    }
    for (const [a, b] of [['today', 'yesterday'], ['yesterday', 'older'], ['today', 'older']] as const) {
      const gap = Math.max(
        ...channels(TINT_BG[a]).map((c, i) => Math.abs(c - channels(TINT_BG[b])[i])),
      );
      expect(gap, `${a} vs ${b}`).toBeGreaterThanOrEqual(10);
    }
  });
});

// Local wall-clock times, because the buckets are wall-clock day boundaries.
const at = (y: number, m: number, d: number, h: number, min = 0, s = 0, ms = 0) =>
  new Date(y, m - 1, d, h, min, s, ms).getTime();

describe('staleness', () => {
  const now = at(2026, 9, 9, 14, 0);

  it('buckets by wall-clock day, not by rolling 24h windows', () => {
    expect(staleness(at(2026, 9, 9, 13, 30), now)).toBe('fresh');
    expect(staleness(at(2026, 9, 9, 9, 0), now)).toBe('today');
    expect(staleness(at(2026, 9, 8, 23, 0), now)).toBe('yesterday');
    expect(staleness(at(2026, 9, 7, 23, 59), now)).toBe('older');
    expect(staleness(at(2020, 1, 1, 12, 0), now)).toBe('older');
  });

  it('puts each midnight on the right side of its boundary', () => {
    expect(staleness(at(2026, 9, 9, 0, 0), now)).toBe('today');
    expect(staleness(at(2026, 9, 8, 23, 59, 59, 999), now)).toBe('yesterday');
    expect(staleness(at(2026, 9, 8, 0, 0), now)).toBe('yesterday');
    expect(staleness(at(2026, 9, 7, 23, 59, 59, 999), now)).toBe('older');
  });

  // The <1h test deliberately wins over the day boundary: a session touched just
  // before midnight is still warm at 00:10, and jumping it straight to yesterday's
  // colour would flag the single most recently-active pane as stale.
  it('keeps a chat fresh across midnight', () => {
    expect(staleness(at(2026, 9, 8, 23, 55), at(2026, 9, 9, 0, 10))).toBe('fresh');
  });

  it('treats a future mtime (clock skew) as fresh rather than older', () => {
    expect(staleness(now + 60_000, now)).toBe('fresh');
  });
});

function liveInfo(sid: string, paneId: string, tmuxSession: string): LiveInfo {
  return {
    agent: 'claude',
    session_id: sid,
    pane_id: paneId,
    tmux_session: tmuxSession,
    window_index: '1',
    pane_index: '0',
    running: true,
    cwd: '/x',
  };
}

const KEY = (sid: string) => agentSessionKey('claude', sid);

describe('desiredTints', () => {
  const now = at(2026, 9, 9, 14, 0);

  it('tints in-prefix panes by bucket and leaves everything else out', () => {
    const live = new Map([
      [KEY('a'), liveInfo('a', '%1', 'loom-tp-2')],
      [KEY('b'), liveInfo('b', '%2', 'loom-tp-3')],
      [KEY('c'), liveInfo('c', '%3', 'scratch')], // outside the workspace prefix
      [KEY('d'), liveInfo('d', '%4', 'loom-tp-4')], // resolves, but has no transcript
      [KEY('e'), liveInfo('e', '%5', 'loom-tp-5')], // active within the hour
    ]);
    const lastActive = new Map([
      [KEY('a'), at(2026, 9, 9, 9, 0)],
      [KEY('b'), at(2026, 9, 7, 10, 0)],
      [KEY('c'), at(2026, 9, 7, 10, 0)],
      [KEY('e'), at(2026, 9, 9, 13, 45)],
    ]);

    const desired = desiredTints(live, lastActive, now, 'loom-');

    expect(desired.get('%1')).toBe(TINT_STYLE.today);
    expect(desired.get('%2')).toBe(TINT_STYLE.older);
    // Painting outside the prefix would leave a tint the prefix-scoped clear
    // can never reach.
    expect(desired.has('%3')).toBe(false);
    // No transcript means no date. Never guess a bucket.
    expect(desired.has('%4')).toBe(false);
    // A live chat is untinted by design, so it must never reach the paint set.
    expect(desired.has('%5')).toBe(false);
  });

  // No fourth colour reachable by accident: sweeping every age from "just now" to
  // years old must produce exactly the three palette styles and nothing else.
  it('never produces a style outside the palette', () => {
    const hours = [0, 0.5, 0.99, 2, 8, 13.9, 20, 30, 37.9, 100, 5000, 50000];
    const styles = new Set<string>();
    for (const h of hours) {
      const live = new Map([[KEY('a'), liveInfo('a', '%1', 'loom-tp-2')]]);
      const lastActive = new Map([[KEY('a'), now - h * 3_600_000]]);
      for (const s of desiredTints(live, lastActive, now, 'loom-').values()) styles.add(s);
    }
    expect([...styles].sort()).toEqual(
      [TINT_STYLE.today, TINT_STYLE.yesterday, TINT_STYLE.older].sort(),
    );
  });
});

function fakeTmux() {
  const calls: string[] = [];
  const tmux: TintTmux = {
    paint: (paneId, style) => void calls.push(`paint ${paneId} ${style}`),
    reset: (paneId) => void calls.push(`reset ${paneId}`),
    clearWindows: (prefix) => (calls.push(`clear ${prefix}`), 3),
  };
  return { calls, tmux };
}

describe('PaneTints.apply', () => {
  const livePanes = new Set(['%1', '%2']);

  it('makes zero tmux calls when nothing changed', () => {
    const { calls, tmux } = fakeTmux();
    const tints = new PaneTints(tmux);
    const desired = new Map([['%1', TINT_STYLE.today]]);

    expect(tints.apply(desired, livePanes)).toEqual({ painted: 1, reset: 0 });
    calls.length = 0;

    // Same desired state, three more ticks: the whole point of tracking our own
    // writes is that a settled workspace costs nothing at 4s intervals.
    tints.apply(desired, livePanes);
    tints.apply(desired, livePanes);
    tints.apply(desired, livePanes);
    expect(calls).toEqual([]);
  });

  it('repaints only the pane whose bucket changed', () => {
    const { calls, tmux } = fakeTmux();
    const tints = new PaneTints(tmux);
    tints.apply(new Map([['%1', TINT_STYLE.today], ['%2', TINT_STYLE.older]]), livePanes);
    calls.length = 0;

    // %1 goes today -> stale overnight; %2 was already stale and must not move.
    tints.apply(new Map([['%1', TINT_STYLE.older], ['%2', TINT_STYLE.older]]), livePanes);

    expect(calls).toEqual([`paint %1 ${TINT_STYLE.older}`]);
  });

  // The direction that matters most now that fresh is untinted: a chat goes cold,
  // gets picked up again, and must lose its colour. Without this the pane Will is
  // actively working in is the one wearing the "this is dead" tint.
  it('clears the tint when a stale chat becomes active again', () => {
    const { calls, tmux } = fakeTmux();
    const tints = new PaneTints(tmux);

    // Went cold overnight.
    tints.apply(new Map([['%1', TINT_STYLE.older]]), livePanes);
    expect(calls).toEqual([`paint %1 ${TINT_STYLE.older}`]);
    calls.length = 0;

    // Will types into it: staleness() now says 'fresh', so desiredTints drops it
    // and the pane has to travel red -> unset.
    expect(tints.apply(new Map(), livePanes)).toEqual({ painted: 0, reset: 1 });
    expect(calls).toEqual(['reset %1']);
    calls.length = 0;

    // ...and it stays unset while it keeps being used, at no tmux cost.
    tints.apply(new Map(), livePanes);
    tints.apply(new Map(), livePanes);
    expect(calls).toEqual([]);

    // Then goes cold again the next day and repaints.
    tints.apply(new Map([['%1', TINT_STYLE.today]]), livePanes);
    expect(calls).toEqual([`paint %1 ${TINT_STYLE.today}`]);
  });

  // The transition nothing reports: Will types /quit, the pane stops resolving to
  // a chat, and without this the dead session keeps the colour it had while alive.
  it('resets a pane that stops resolving to a chat', () => {
    const { calls, tmux } = fakeTmux();
    const tints = new PaneTints(tmux);
    tints.apply(new Map([['%1', TINT_STYLE.today]]), livePanes);
    calls.length = 0;

    expect(tints.apply(new Map(), livePanes)).toEqual({ painted: 0, reset: 1 });
    expect(calls).toEqual(['reset %1']);

    // ...and having reset it, it stops calling tmux about it forever after.
    calls.length = 0;
    tints.apply(new Map(), livePanes);
    expect(calls).toEqual([]);
  });

  it('drops a vanished pane without calling tmux about a dead id', () => {
    const { calls, tmux } = fakeTmux();
    const tints = new PaneTints(tmux);
    tints.apply(new Map([['%1', TINT_STYLE.today]]), livePanes);
    calls.length = 0;

    // Pane closed: its options died with it, so a reset would fail every tick.
    expect(tints.apply(new Map(), new Set(['%2']))).toEqual({ painted: 0, reset: 0 });
    expect(calls).toEqual([]);
  });

  it('repaints from scratch after a clear', () => {
    const { calls, tmux } = fakeTmux();
    const tints = new PaneTints(tmux);
    const desired = new Map([['%1', TINT_STYLE.today]]);
    tints.apply(desired, livePanes);

    expect(tints.clearAll('loom-')).toBe(3);
    calls.length = 0;

    // The clear wiped tmux's state, so our record of it has to be wiped too or
    // the next tick would think %1 is already painted and skip it.
    tints.apply(desired, livePanes);
    expect(calls).toEqual([`paint %1 ${TINT_STYLE.today}`]);
  });
});
