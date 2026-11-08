import { describe, expect, it, vi } from 'vitest';
import { LiveIndexer, provisionalViews, type LiveIndexerDeps } from '../src/liveindex.ts';

const L = (sid: string, extra = {}) => ({ agent: 'claude', session_id: sid, pane_id: '%' + sid, cwd: '/w', ...extra });

function mk(mtimes: Record<string, number>) {
  const index = vi.fn(async () => {});
  const deps: LiveIndexerDeps = {
    locate: (sid) => (sid in mtimes ? `/t/${sid}.jsonl` : null),
    mtimeOf: (f) => mtimes[f.split('/').pop()!.replace('.jsonl', '')] ?? null,
    index,
  };
  return { ix: new LiveIndexer(deps), index };
}

describe('LiveIndexer', () => {
  it('indexes a live session that has no chat row, right away', async () => {
    const { ix, index } = mk({ a: 100 });
    const r = ix.tick([L('a')], new Map(), 1000);
    expect(r?.key).toBe('claude:a');
    await r!.done;
    expect(index).toHaveBeenCalledWith('/t/a.jsonl', 100, 1000);
  });

  it('skips known sessions whose transcript has not moved, and sessions with no transcript', () => {
    const { ix, index } = mk({ a: 100 });
    expect(ix.tick([L('a'), L('ghost')], new Map([['claude:a', 100]]), 1000)).toBeNull();
    expect(index).not.toHaveBeenCalled();
  });

  it('runs one at a time, unknown sessions first', async () => {
    const { ix, index } = mk({ a: 200, b: 100 });
    const known = new Map([['claude:a', 100]]);
    const r1 = ix.tick([L('a'), L('b')], known, 100_000);
    expect(r1?.key).toBe('claude:b');
    expect(ix.tick([L('a')], known, 100_000)).toBeNull(); // busy
    await r1!.done;
    expect(index).toHaveBeenCalledTimes(1);
  });

  it('re-indexes a moved transcript at most once per 30s per chat', async () => {
    const m = { a: 200 };
    const { ix, index } = mk(m);
    const known = new Map([['claude:a', 100]]);
    await ix.tick([L('a')], known, 100_000)!.done;
    expect(ix.tick([L('a')], known, 110_000)).toBeNull();
    expect(ix.tick([L('a')], known, 129_000)).toBeNull();
    await ix.tick([L('a')], known, 131_000)!.done;
    expect(index).toHaveBeenCalledTimes(2);
  });

  it('ignores codex sessions (the full pass handles them)', () => {
    const { ix } = mk({ a: 1 });
    expect(ix.tick([{ ...L('a'), agent: 'codex' }], new Map(), 1000)).toBeNull();
  });
});

describe('provisionalViews', () => {
  const opts = { locate: () => '/t/x.jsonl', firstPrompt: () => 'review PR 12', mtimeOf: () => 500 };
  const live = { 'claude:x': L('x', { name: 'cosmic-acorn' }), 'claude:y': L('y') };

  it('makes a row only for live sessions with no chat row', () => {
    const out = provisionalViews([{ agent: 'claude', session_id: 'y' }], live, [], 1000, opts);
    expect(out.map((v) => v.session_id)).toEqual(['x']);
    expect(out[0]).toMatchObject({ provisional: true, project: 'w', title: 'review PR 12' });
  });

  it('prefers the watcher spawn title, then the pane name when nothing else is known', () => {
    const w = provisionalViews([], { 'claude:x': live['claude:x'] }, [{ pane_id: '%x', title: 'PR #9', spawned_at: 7 }], 1000, opts);
    expect(w[0].title).toBe('PR #9');
    const n = provisionalViews([], { 'claude:x': live['claude:x'] }, [], 1000, { ...opts, firstPrompt: () => '' });
    expect(n[0].title).toBe('cosmic-acorn');
  });
});
