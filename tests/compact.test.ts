import { describe, it, expect } from 'vitest';
import {
  parseLane,
  classifyPane,
  trackIdle,
  planCompaction,
  applySwaps,
  groupsToDissolve,
  pickMoveSlot,
  resolvePaneRef,
  movePane,
  ungroupPane,
  focusedPaneFrom,
  makeCompactor,
  nextOpenPane,
  laneTargets,
  setCompactEnabled,
  HOLE_GRACE_MS,
  MAX_SWAPS_PER_TICK,
  type LanePane,
  type WorldState,
} from '../src/compact.ts';

// A lane pane in `session`, slot `idx`. Agent panes default to a claude command.
const pane = (id: string, session: string, idx: number, opts: Partial<LanePane> = {}): LanePane => ({
  pane_id: id,
  tmux_session: session,
  window_index: '1',
  pane_index: String(idx),
  command: opts.agent ? '2.1.233' : 'zsh',
  name: '',
  group: '',
  agent: false,
  ...opts,
});
const claude = (id: string, session: string, idx: number, opts: Partial<LanePane> = {}) =>
  pane(id, session, idx, { agent: true, ...opts });

const NOW = 1_000_000;
// Every shell pane has been idle long enough to count as a hole.
const longIdle = (panes: LanePane[]) =>
  new Map(panes.filter((p) => !p.agent).map((p) => [p.pane_id, NOW - HOLE_GRACE_MS - 1]));

describe('parseLane', () => {
  it.each([
    ['loom-tp-2', { lane: 'tp', n: 2 }],
    ['loom-tp-forms-8', { lane: 'tp-forms', n: 8 }],
    ['loom-tp-verify-1', { lane: 'tp-verify', n: 1 }],
    ['loom-tp-10', { lane: 'tp', n: 10 }],
  ])('%s is in a lane', (session, want) => {
    expect(parseLane(session)).toEqual(want);
  });

  it.each(['loom-tp-terminals', 'loom-tp-code', 'loom-tp-prs', 'loom-bugs', 'compactprobe-1', 'tp-2'])(
    '%s is in no lane',
    (session) => {
      expect(parseLane(session)).toBeNull();
    },
  );

  it('orders tp-10 after tp-9 (numeric, not lexical)', () => {
    expect(parseLane('loom-tp-10')!.n).toBeGreaterThan(parseLane('loom-tp-9')!.n);
  });
});

describe('classifyPane', () => {
  const idle = new Map([['%1', NOW - HOLE_GRACE_MS]]);

  it('an agent pane is claude', () => {
    expect(classifyPane(claude('%1', 'loom-tp-2', 0), idle, null, NOW)).toBe('claude');
  });

  it('an idle shell past the grace period is a hole', () => {
    expect(classifyPane(pane('%1', 'loom-tp-2', 0), idle, null, NOW)).toBe('hole');
  });

  it('an idle shell inside the grace period is not yet a hole', () => {
    const fresh = new Map([['%1', NOW - HOLE_GRACE_MS + 1]]);
    expect(classifyPane(pane('%1', 'loom-tp-2', 0), fresh, null, NOW)).toBe('pinned');
  });

  it('a shell never observed idle is not a hole', () => {
    expect(classifyPane(pane('%1', 'loom-tp-2', 0), new Map(), null, NOW)).toBe('pinned');
  });

  it('the focused pane is pinned, whether shell or claude', () => {
    expect(classifyPane(pane('%1', 'loom-tp-2', 0), idle, '%1', NOW)).toBe('pinned');
    expect(classifyPane(claude('%1', 'loom-tp-2', 0), idle, '%1', NOW)).toBe('pinned');
  });

  it.each(['nvim', 'node', 'less'])('a non-shell foreground (%s) is pinned', (command) => {
    expect(classifyPane(pane('%1', 'loom-tp-2', 0, { command }), idle, null, NOW)).toBe('pinned');
  });

  it('a grouped pane is pinned even when it runs claude', () => {
    expect(classifyPane(claude('%1', 'loom-tp-2', 0, { group: 'g1' }), idle, null, NOW)).toBe('pinned');
  });

  it('a pane outside any lane is pinned', () => {
    expect(classifyPane(pane('%1', 'loom-tp-terminals', 0), idle, null, NOW)).toBe('pinned');
  });
});

describe('trackIdle', () => {
  it('stamps a shell on first sight, keeps the stamp, and clears it once an agent runs', () => {
    const idle = new Map<string, number>();
    trackIdle([pane('%1', 'loom-tp-2', 0)], idle, 100);
    trackIdle([pane('%1', 'loom-tp-2', 0)], idle, 200);
    expect(idle.get('%1')).toBe(100);
    trackIdle([claude('%1', 'loom-tp-2', 0)], idle, 300);
    expect(idle.has('%1')).toBe(false);
  });

  it('forgets panes that no longer exist', () => {
    const idle = new Map([['%gone', 1]]);
    trackIdle([], idle, 100);
    expect(idle.size).toBe(0);
  });
});

describe('planCompaction', () => {
  it('pulls the latest claude panes into the earliest holes (the tp-2 scenario)', () => {
    const panes = [
      pane('%h1', 'loom-tp-2', 0), claude('%c1', 'loom-tp-2', 1), pane('%h2', 'loom-tp-2', 2), pane('%h3', 'loom-tp-2', 3),
      claude('%c2', 'loom-tp-3', 0), claude('%c3', 'loom-tp-3', 1), claude('%c4', 'loom-tp-3', 2), claude('%c5', 'loom-tp-3', 3),
      claude('%c6', 'loom-tp-4', 0), claude('%c7', 'loom-tp-4', 1), claude('%c8', 'loom-tp-4', 2), claude('%c9', 'loom-tp-4', 3),
      claude('%c10', 'loom-tp-5', 0), pane('%s5', 'loom-tp-5', 1), pane('%s5b', 'loom-tp-5', 2), pane('%s5c', 'loom-tp-5', 3),
      claude('%c11', 'loom-tp-6', 0), pane('%s6', 'loom-tp-6', 1), pane('%s6b', 'loom-tp-6', 2), pane('%s6c', 'loom-tp-6', 3),
      claude('%c12', 'loom-tp-7', 0), pane('%s7', 'loom-tp-7', 1), pane('%s7b', 'loom-tp-7', 2), pane('%s7c', 'loom-tp-7', 3),
    ];
    const swaps = planCompaction(panes, longIdle(panes), null, NOW);
    expect(swaps.map((s) => [s.src, s.dst])).toEqual([
      ['%c12', '%h1'],
      ['%c11', '%h2'],
      ['%c10', '%h3'],
    ]);
    expect(swaps.every((s) => s.lane === 'tp')).toBe(true);
  });

  it('is a no-op when the only holes sit after every claude pane', () => {
    const panes = [claude('%c1', 'loom-tp-2', 0), claude('%c2', 'loom-tp-3', 0), pane('%h1', 'loom-tp-3', 1)];
    expect(planCompaction(panes, longIdle(panes), null, NOW)).toEqual([]);
  });

  it('skips a focused hole and fills the next one', () => {
    const panes = [pane('%h1', 'loom-tp-2', 0), pane('%h2', 'loom-tp-2', 1), claude('%c1', 'loom-tp-3', 0)];
    const swaps = planCompaction(panes, longIdle(panes), '%h1', NOW);
    expect(swaps.map((s) => [s.src, s.dst])).toEqual([['%c1', '%h2']]);
  });

  it('never moves a grouped claude pane', () => {
    const panes = [pane('%h1', 'loom-tp-2', 0), claude('%g1', 'loom-tp-3', 0, { group: 'g' }), claude('%g2', 'loom-tp-3', 1, { group: 'g' })];
    expect(planCompaction(panes, longIdle(panes), null, NOW)).toEqual([]);
  });

  it('fills the holes around a group rather than moving it', () => {
    const panes = [
      claude('%g1', 'loom-tp-2', 0, { group: 'g' }), pane('%h1', 'loom-tp-2', 1),
      claude('%c1', 'loom-tp-3', 0),
    ];
    const swaps = planCompaction(panes, longIdle(panes), null, NOW);
    expect(swaps.map((s) => [s.src, s.dst])).toEqual([['%c1', '%h1']]);
  });

  it('never fills a shell still inside its grace period', () => {
    const panes = [pane('%h1', 'loom-tp-2', 0), claude('%c1', 'loom-tp-3', 0)];
    expect(planCompaction(panes, new Map([['%h1', NOW - 1000]]), null, NOW)).toEqual([]);
  });

  it(`caps a tick at ${MAX_SWAPS_PER_TICK} swaps`, () => {
    const panes: LanePane[] = [];
    for (let i = 0; i < 12; i++) panes.push(pane(`%h${i}`, 'loom-tp-2', i));
    for (let i = 0; i < 12; i++) panes.push(claude(`%c${i}`, 'loom-tp-3', i));
    expect(planCompaction(panes, longIdle(panes), null, NOW)).toHaveLength(MAX_SWAPS_PER_TICK);
  });

  it('orders sessions numerically, so tp-10 is later than tp-9', () => {
    const panes = [pane('%h', 'loom-tp-9', 0), claude('%c', 'loom-tp-10', 0)];
    expect(planCompaction(panes, longIdle(panes), null, NOW).map((s) => s.src)).toEqual(['%c']);
  });

  it('keeps lanes apart', () => {
    const panes = [
      pane('%tpHole', 'loom-tp-2', 0), claude('%tp', 'loom-tp-3', 0),
      pane('%fHole', 'loom-tp-forms-1', 0), claude('%f', 'loom-tp-forms-2', 0),
    ];
    const swaps = planCompaction(panes, longIdle(panes), null, NOW);
    expect(swaps.map((s) => [s.lane, s.src, s.dst]).sort()).toEqual([
      ['tp', '%tp', '%tpHole'],
      ['tp-forms', '%f', '%fHole'],
    ]);
  });

  it('ignores sessions outside any lane', () => {
    const panes = [pane('%h', 'loom-tp-terminals', 0), claude('%c', 'loom-tp-3', 0)];
    expect(planCompaction(panes, longIdle(panes), null, NOW)).toEqual([]);
  });
});

// A fake tmux: records every command and answers from a mutable world.
function fakeWorld(panes: LanePane[], focused: string | null = null) {
  const world: WorldState = { panes: panes.map((p) => ({ ...p })), focused };
  const calls: string[][] = [];
  const slotKeys = ['tmux_session', 'window_index', 'pane_index'] as const;
  const run = (args: string[]) => {
    calls.push(args);
    if (args[0] === 'swap-pane') {
      const a = world.panes.find((p) => p.pane_id === args[args.indexOf('-s') + 1])!;
      const b = world.panes.find((p) => p.pane_id === args[args.indexOf('-t') + 1])!;
      for (const k of slotKeys) [a[k], b[k]] = [b[k], a[k]];
    }
    if (args[0] === 'set-option') {
      const id = args[args.indexOf('-t') + 1];
      const p = world.panes.find((x) => x.pane_id === id)!;
      if (args.includes('-u')) p.group = '';
      else p.group = args[args.length - 1];
    }
    return '';
  };
  return { world, calls, run, read: () => world };
}

describe('applySwaps', () => {
  it('swaps with -d and logs each one', () => {
    const f = fakeWorld([pane('%h', 'loom-tp-2', 0), claude('%c', 'loom-tp-3', 0)]);
    const logged: unknown[] = [];
    const idle = longIdle(f.world.panes);
    const out = applySwaps([{ lane: 'tp', src: '%c', dst: '%h' }], idle, NOW, { run: f.run, read: f.read, log: (e) => logged.push(e) });
    expect(f.calls).toEqual([['swap-pane', '-d', '-s', '%c', '-t', '%h']]);
    expect(out.applied).toBe(1);
    expect(logged).toEqual([expect.objectContaining({ result: 'ok', src: '%c', dst: '%h', lane: 'tp' })]);
    expect(f.world.panes.find((p) => p.pane_id === '%c')!.tmux_session).toBe('loom-tp-2');
  });

  it('skips a swap whose hole started running claude since planning', () => {
    const f = fakeWorld([pane('%h', 'loom-tp-2', 0), claude('%c', 'loom-tp-3', 0)]);
    const idle = longIdle(f.world.panes);
    f.world.panes[0].agent = true; // `claude --resume` landed in the hole
    const logged: { result: string }[] = [];
    const out = applySwaps([{ lane: 'tp', src: '%c', dst: '%h' }], idle, NOW, { run: f.run, read: f.read, log: (e) => logged.push(e) });
    expect(f.calls.some((c) => c[0] === 'swap-pane')).toBe(false);
    expect(out.applied).toBe(0);
    expect(logged[0].result).toMatch(/^skipped/);
  });

  it('skips a swap whose source became focused since planning', () => {
    const f = fakeWorld([pane('%h', 'loom-tp-2', 0), claude('%c', 'loom-tp-3', 0)]);
    const idle = longIdle(f.world.panes);
    f.world.focused = '%c';
    const out = applySwaps([{ lane: 'tp', src: '%c', dst: '%h' }], idle, NOW, { run: f.run, read: f.read, log: () => {} });
    expect(out.applied).toBe(0);
  });

  it('logs a tmux failure and carries on', () => {
    const f = fakeWorld([pane('%h1', 'loom-tp-2', 0), pane('%h2', 'loom-tp-2', 1), claude('%c1', 'loom-tp-3', 0), claude('%c2', 'loom-tp-3', 1)]);
    const idle = longIdle(f.world.panes);
    let first = true;
    const run = (args: string[]) => {
      if (args[0] === 'swap-pane' && first) {
        first = false;
        throw new Error('no such pane');
      }
      return f.run(args);
    };
    const logged: { result: string }[] = [];
    const out = applySwaps(
      [{ lane: 'tp', src: '%c2', dst: '%h1' }, { lane: 'tp', src: '%c1', dst: '%h2' }],
      idle, NOW, { run, read: f.read, log: (e) => logged.push(e) },
    );
    expect(out.applied).toBe(1);
    expect(logged.map((l) => l.result)).toEqual([expect.stringMatching(/^error/), 'ok']);
  });
});

describe('groupsToDissolve', () => {
  it('dissolves a group with one or fewer members running claude', () => {
    const panes = [
      claude('%a', 'loom-tp-2', 0, { group: 'live' }), claude('%b', 'loom-tp-2', 1, { group: 'live' }),
      claude('%c', 'loom-tp-3', 0, { group: 'dead' }), pane('%d', 'loom-tp-3', 1, { group: 'dead' }),
    ];
    expect(groupsToDissolve(panes, longIdle(panes), NOW)).toEqual(new Map([['dead', ['%c', '%d']]]));
  });

  it('holds a group together while a member restarts inside the grace period', () => {
    const panes = [claude('%a', 'loom-tp-2', 0, { group: 'g' }), pane('%b', 'loom-tp-2', 1, { group: 'g' })];
    expect(groupsToDissolve(panes, new Map([['%b', NOW - 1000]]), NOW).size).toBe(0);
  });
});

describe('focusedPaneFrom', () => {
  it('takes the active pane of the most recently active client session', () => {
    const run = (args: string[]) => {
      if (args[0] === 'list-clients') return '100 loom-tp-2\n300 loom-tp-4\n200 loom-bugs\n';
      if (args[0] === 'display-message') return args.includes('loom-tp-4') ? '%44\n' : '%1\n';
      return '';
    };
    expect(focusedPaneFrom(run)).toBe('%44');
  });

  it('is null with no clients attached', () => {
    expect(focusedPaneFrom(() => '')).toBeNull();
  });
});

describe('resolvePaneRef', () => {
  const panes = [claude('%7', 'loom-tp-2', 0, { name: 'blue-vanilla' })];
  it('accepts a %id or an @name', () => {
    expect(resolvePaneRef(panes, '%7')?.pane_id).toBe('%7');
    expect(resolvePaneRef(panes, 'blue-vanilla')?.pane_id).toBe('%7');
    expect(resolvePaneRef(panes, '@blue-vanilla')?.pane_id).toBe('%7');
    expect(resolvePaneRef(panes, 'nope')).toBeNull();
  });
});

describe('pickMoveSlot', () => {
  it('prefers the first idle shell in the target session, with no grace period', () => {
    const panes = [claude('%t', 'loom-tp-2', 0), claude('%x', 'loom-tp-2', 1), pane('%h1', 'loom-tp-2', 2), pane('%h2', 'loom-tp-2', 3)];
    expect(pickMoveSlot(panes, '%t', null)).toEqual({ ok: true, pane_id: '%h1' });
  });

  it('falls back to the last non-pinned claude pane that is not the target', () => {
    const panes = [claude('%x1', 'loom-tp-2', 0), claude('%x2', 'loom-tp-2', 1), claude('%t', 'loom-tp-2', 2), pane('%v', 'loom-tp-2', 3, { command: 'nvim' })];
    expect(pickMoveSlot(panes, '%t', null)).toEqual({ ok: true, pane_id: '%x2' });
  });

  it('skips grouped and focused panes', () => {
    const panes = [claude('%t', 'loom-tp-2', 0, { group: 'g' }), claude('%g', 'loom-tp-2', 1, { group: 'g' }), pane('%f', 'loom-tp-2', 2), claude('%x', 'loom-tp-2', 3)];
    expect(pickMoveSlot(panes, '%t', '%f')).toEqual({ ok: true, pane_id: '%x' });
  });

  it('errors when the session is full', () => {
    const panes = [claude('%t', 'loom-tp-2', 0), pane('%v', 'loom-tp-2', 1, { command: 'nvim' }), pane('%f', 'loom-tp-2', 2)];
    expect(pickMoveSlot(panes, '%t', '%f')).toEqual({ ok: false, detail: 'session full' });
  });
});

describe('movePane', () => {
  it('swaps the pane into the target session and tags both with a new group', () => {
    const f = fakeWorld([claude('%t', 'loom-tp-2', 0, { name: 'red-otter' }), pane('%h', 'loom-tp-2', 1), claude('%m', 'loom-tp-5', 0, { name: 'blue-vanilla' })]);
    const r = movePane('blue-vanilla', 'red-otter', { run: f.run, read: f.read, now: () => NOW });
    expect(r).toEqual(expect.objectContaining({ ok: true, swappedWith: '%h' }));
    expect(f.calls[0]).toEqual(['swap-pane', '-d', '-s', '%m', '-t', '%h']);
    const m = f.world.panes.find((p) => p.pane_id === '%m')!;
    const t = f.world.panes.find((p) => p.pane_id === '%t')!;
    expect(m.tmux_session).toBe('loom-tp-2');
    expect(m.group).toBeTruthy();
    expect(t.group).toBe(m.group);
  });

  it("extends the target's existing group", () => {
    const f = fakeWorld([claude('%t', 'loom-tp-2', 0, { group: 'g-old' }), pane('%h', 'loom-tp-2', 1), claude('%m', 'loom-tp-5', 0)]);
    const r = movePane('%m', '%t', { run: f.run, read: f.read, now: () => NOW });
    expect(r.ok && r.group).toBe('g-old');
    expect(f.world.panes.find((p) => p.pane_id === '%m')!.group).toBe('g-old');
  });

  it('only tags when the pane is already in the target session', () => {
    const f = fakeWorld([claude('%t', 'loom-tp-2', 0), claude('%m', 'loom-tp-2', 1)]);
    const r = movePane('%m', '%t', { run: f.run, read: f.read, now: () => NOW });
    expect(r.ok).toBe(true);
    expect(f.calls.some((c) => c[0] === 'swap-pane')).toBe(false);
  });

  it('refuses a cross-lane move', () => {
    const f = fakeWorld([claude('%t', 'loom-tp-forms-1', 0), pane('%h', 'loom-tp-forms-1', 1), claude('%m', 'loom-tp-5', 0)]);
    const r = movePane('%m', '%t', { run: f.run, read: f.read, now: () => NOW });
    expect(r).toEqual({ ok: false, detail: expect.stringMatching(/lane/) });
    expect(f.calls).toEqual([]);
  });

  it('refuses a pane outside any lane', () => {
    const f = fakeWorld([claude('%t', 'loom-tp-2', 0), claude('%m', 'loom-tp-terminals', 0)]);
    expect(movePane('%m', '%t', { run: f.run, read: f.read, now: () => NOW }).ok).toBe(false);
  });

  it('refuses unknown panes and moving a pane onto itself', () => {
    const f = fakeWorld([claude('%t', 'loom-tp-2', 0)]);
    expect(movePane('%zz', '%t', { run: f.run, read: f.read, now: () => NOW })).toEqual({ ok: false, detail: 'unknown pane: %zz' });
    expect(movePane('%t', '%t', { run: f.run, read: f.read, now: () => NOW }).ok).toBe(false);
  });

  it('errors on a full session without touching tmux', () => {
    const f = fakeWorld([claude('%t', 'loom-tp-2', 0), pane('%v', 'loom-tp-2', 1, { command: 'nvim' }), claude('%m', 'loom-tp-5', 0)]);
    expect(movePane('%m', '%t', { run: f.run, read: f.read, now: () => NOW })).toEqual({ ok: false, detail: 'session full' });
    expect(f.calls).toEqual([]);
  });
});

describe('ungroupPane', () => {
  it('unsets @group on the pane', () => {
    const f = fakeWorld([claude('%a', 'loom-tp-2', 0, { group: 'g' })]);
    expect(ungroupPane('%a', { run: f.run, read: f.read })).toEqual({ ok: true, pane_id: '%a' });
    expect(f.calls).toEqual([['set-option', '-p', '-u', '-t', '%a', '@group']]);
  });

  it('errors on an unknown pane', () => {
    const f = fakeWorld([]);
    expect(ungroupPane('%a', { run: f.run, read: f.read }).ok).toBe(false);
  });
});

describe('makeCompactor', () => {
  it('waits out the grace period, then swaps; does nothing while compact.off exists', () => {
    const f = fakeWorld([pane('%h', 'loom-tp-2', 0), claude('%c', 'loom-tp-3', 0)]);
    const tick = makeCompactor({ run: f.run, read: f.read, log: () => {} });
    expect(tick(NOW).applied).toBe(0); // first sighting of the idle shell
    setCompactEnabled(false);
    try {
      expect(tick(NOW + HOLE_GRACE_MS).applied).toBe(0);
    } finally {
      setCompactEnabled(true);
    }
    expect(tick(NOW + HOLE_GRACE_MS).applied).toBe(1);
    expect(f.world.panes.find((p) => p.pane_id === '%c')!.tmux_session).toBe('loom-tp-2');
  });

  it('dissolves a dead group, which frees its panes to move', () => {
    const f = fakeWorld([
      pane('%h', 'loom-tp-2', 0),
      claude('%a', 'loom-tp-3', 0, { group: 'g' }), pane('%b', 'loom-tp-3', 1, { group: 'g', command: 'nvim' }),
    ]);
    const tick = makeCompactor({ run: f.run, read: f.read, log: () => {} });
    expect(tick(NOW)).toEqual({ applied: 0, dissolved: 1 }); // the hole is still in its grace period
    expect(f.world.panes.every((p) => !p.group)).toBe(true);
    expect(tick(NOW + HOLE_GRACE_MS)).toEqual({ applied: 1, dissolved: 0 });
  });

  it('never dissolves groups when no agent is visible anywhere (a failed ps)', () => {
    const f = fakeWorld([pane('%a', 'loom-tp-2', 0, { group: 'g' }), pane('%b', 'loom-tp-2', 1, { group: 'g' })]);
    const tick = makeCompactor({ run: f.run, read: f.read, log: () => {} });
    tick(NOW);
    expect(tick(NOW + HOLE_GRACE_MS).dissolved).toBe(0);
  });
});

describe('nextOpenPane', () => {
  const world = (panes: LanePane[]): WorldState => ({ panes, focused: null });

  it('takes the earliest idle shell across the lane, in slot order', () => {
    const w = world([
      pane('%late', 'loom-tp-10', 0),
      claude('%c', 'loom-tp-2', 0), pane('%early', 'loom-tp-9', 3), pane('%earliest', 'loom-tp-9', 1),
    ]);
    expect(nextOpenPane('tp', w)?.pane_id).toBe('%earliest');
  });

  it('needs no grace period — a shell idle for no time at all qualifies', () => {
    expect(nextOpenPane('tp', world([pane('%h', 'loom-tp-2', 0)]))?.pane_id).toBe('%h');
  });

  it('skips grouped, non-shell and agent panes', () => {
    const w = world([
      pane('%g', 'loom-tp-2', 0, { group: 'g' }),
      pane('%v', 'loom-tp-2', 1, { command: 'nvim' }),
      claude('%c', 'loom-tp-2', 2),
      pane('%ok', 'loom-tp-3', 0),
    ]);
    expect(nextOpenPane('tp', w)?.pane_id).toBe('%ok');
  });

  it('is null for a lane with no room, and ignores sessions outside the lane', () => {
    const w = world([claude('%c', 'loom-tp-2', 0), pane('%t', 'loom-tp-terminals', 0), pane('%f', 'loom-tp-forms-1', 0)]);
    expect(nextOpenPane('tp', w)).toBeNull();
  });
});

describe('laneTargets', () => {
  it('lists one target per lane with room, lanes sorted by name', () => {
    const w: WorldState = {
      focused: null,
      panes: [
        pane('%v', 'loom-tp-verify-1', 0),
        claude('%c', 'loom-tp-2', 0), pane('%t', 'loom-tp-2', 1, { name: 'blue-vanilla' }),
        claude('%full', 'loom-tp-forms-1', 0),
        pane('%term', 'loom-tp-terminals', 0),
        pane('%bugs', 'loom-bugs', 0),
      ],
    };
    expect(laneTargets(w)).toEqual([
      { lane: 'tp', pane_id: '%t', where: 'loom-tp-2:1.1', name: 'blue-vanilla' },
      { lane: 'tp-verify', pane_id: '%v', where: 'loom-tp-verify-1:1.0', name: '' },
    ]);
  });
});
