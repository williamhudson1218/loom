import { describe, it, expect } from 'vitest';
import { detect, THRESHOLDS } from '../../src/em/detectors.ts';
import type { EmSignals } from '../../src/em/signals.ts';

const NOW = 2_000_000_000_000;

function sig(over: Partial<EmSignals> = {}): EmSignals {
  return {
    agent: 'claude', session_id: 's1', project_dir: '/repo', jsonl_path: '/c.jsonl',
    title: 't', first_message: 'do the thing', state: 'done',
    live: true, working: false,
    pane: { agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a', window_index: '0', pane_index: '0', running: true, working: false },
    idleMs: 0, ageMs: 600_000, messageCount: 12, filesWritten: [], context: null, ...over,
  };
}

const kinds = (s: EmSignals[]) => detect(s, NOW).map((f) => f.kind);

describe('BLOCKED', () => {
  it('fires on a live, idle, waiting_on_user session', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 120_000 })])).toEqual(['BLOCKED']);
  });

  it('does not fire before the idle threshold — the user may just be reading', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 30_000 })])).toEqual([]);
  });

  it('does not fire while the session is working', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 120_000, working: true })])).toEqual([]);
  });

  it('does not fire on a dead pane — there is nobody to answer', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 120_000, live: false, pane: null })])).toEqual([]);
  });
});

describe('WRAPPABLE', () => {
  it('fires on a finished session that has been sitting idle', () => {
    expect(kinds([sig({ state: 'done', idleMs: 11 * 60_000 })])).toEqual(['WRAPPABLE']);
  });

  it('waits out the grace period so a just-finished session is not yanked away', () => {
    expect(kinds([sig({ state: 'done', idleMs: 60_000 })])).toEqual([]);
  });

  it('does not fire on a warning or error state — those are not finished', () => {
    expect(kinds([sig({ state: 'warning', idleMs: 11 * 60_000 })])).toEqual([]);
    expect(kinds([sig({ state: 'error', idleMs: 11 * 60_000 })])).toEqual([]);
  });
});

describe('BLOATED', () => {
  const ctx = (fraction: number) => ({ tokens: Math.round(200_000 * fraction), model: 'claude-opus-5', limit: 200_000, fraction });

  it('fires once context passes the threshold fraction', () => {
    expect(kinds([sig({ state: 'warning', context: ctx(0.75) })])).toEqual(['BLOATED']);
  });

  it('does not fire below the threshold', () => {
    expect(kinds([sig({ state: 'warning', context: ctx(0.5) })])).toEqual([]);
  });

  it('never fires without a usage block (Codex)', () => {
    expect(kinds([sig({ state: 'warning', context: null })])).toEqual([]);
  });

  it('fires even while working, because context only ever grows', () => {
    expect(kinds([sig({ state: 'warning', context: ctx(0.9), working: true })])).toEqual(['BLOATED']);
  });
});

describe('detect', () => {
  it('can return several kinds for one session', () => {
    const out = kinds([sig({ state: 'done', idleMs: 11 * 60_000, context: { tokens: 180_000, model: 'claude-opus-5', limit: 200_000, fraction: 0.9 } })]);
    expect(out.sort()).toEqual(['BLOATED', 'WRAPPABLE']);
  });

  it('stamps detected_at and captures the signals that fired it', () => {
    const [f] = detect([sig({ state: 'waiting_on_user', idleMs: 120_000 })], NOW);
    expect(f.detected_at).toBe(NOW);
    expect(f.signals).toMatchObject({ idleMs: 120_000, state: 'waiting_on_user' });
  });

  it('honours overridden thresholds', () => {
    const s = [sig({ state: 'waiting_on_user', idleMs: 30_000 })];
    expect(detect(s, NOW, { ...THRESHOLDS, blockedIdleMs: 10_000 }).map((f) => f.kind)).toEqual(['BLOCKED']);
  });
});
