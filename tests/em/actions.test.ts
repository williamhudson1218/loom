import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db.ts';
import { recordFinding, paneWritesSince } from '../../src/em/ledger.ts';
import { perform, fileIssue, writeToPane, repoSlug, RATE_LIMIT_PER_HOUR, type ActionCtx } from '../../src/em/actions.ts';
import type { LiveLoc } from '../../src/dashboard.ts';

const NOW = 2_000_000_000_000;

const PANE: LiveLoc = {
  agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a',
  window_index: '0', pane_index: '0', running: true, working: false,
};

function ctx(over: Partial<ActionCtx> = {}): ActionCtx {
  const db = openDb(':memory:');
  return {
    db, mode: 'shadow', now: NOW,
    send: vi.fn(() => ({ ok: true, detail: 'sent' })),
    close: vi.fn(() => ({ ok: true, detail: 'closed' })),
    gh: vi.fn(() => 'https://github.com/o/r/issues/1'),
    ...over,
  };
}

function findingId(c: ActionCtx): number {
  return recordFinding(c.db, { agent: 'claude', session_id: 's1', kind: 'BLOCKED', signals: {}, detected_at: NOW }, 1)!;
}

describe('perform', () => {
  it('records the intended action but does NOT execute it in shadow mode', () => {
    const c = ctx({ mode: 'shadow' });
    const exec = vi.fn(() => 'executed');
    perform(c, findingId(c), 'answer', 'hello', exec);
    expect(exec).not.toHaveBeenCalled();
    const row = c.db.prepare(`SELECT * FROM em_actions`).get() as any;
    expect(row.shadow).toBe(1);
    expect(row.payload).toBe('hello');
    expect(row.result).toBe('shadow');
    c.db.close();
  });

  it('executes and records in live mode', () => {
    const c = ctx({ mode: 'live' });
    const exec = vi.fn(() => 'executed');
    perform(c, findingId(c), 'answer', 'hello', exec);
    expect(exec).toHaveBeenCalledOnce();
    const row = c.db.prepare(`SELECT * FROM em_actions`).get() as any;
    expect(row.shadow).toBe(0);
    expect(row.result).toBe('executed');
    c.db.close();
  });

  it('does nothing at all when mode is off', () => {
    const c = ctx({ mode: 'off' });
    const exec = vi.fn();
    perform(c, findingId(c), 'answer', 'hello', exec);
    expect(exec).not.toHaveBeenCalled();
    expect(c.db.prepare(`SELECT COUNT(*) AS n FROM em_actions`).get()).toEqual({ n: 0 });
    c.db.close();
  });

  it('records the error instead of throwing when execution fails', () => {
    const c = ctx({ mode: 'live' });
    perform(c, findingId(c), 'answer', 'hello', () => { throw new Error('tmux gone'); });
    const row = c.db.prepare(`SELECT result FROM em_actions`).get() as any;
    expect(row.result).toContain('tmux gone');
    c.db.close();
  });
});

describe('writeToPane', () => {
  it('sends in live mode and counts toward the pane-write rate limit', () => {
    const c = ctx({ mode: 'live' });
    writeToPane(c, findingId(c), 'answer', PANE, 'the answer');
    expect(c.send).toHaveBeenCalledWith('%1', 'the answer', 'claude');
    expect(paneWritesSince(c.db, 0)).toBe(1);
    c.db.close();
  });

  it('sends exactly up to the hourly cap, then refuses, bounding a bad detector', () => {
    const c = ctx({ mode: 'live' });
    const id = findingId(c);
    const results = [];
    for (let i = 0; i < 40; i++) results.push(writeToPane(c, id, 'answer', PANE, `m${i}`));
    // Exactly RATE_LIMIT_PER_HOUR sends, not fewer — a cap that silently blocked
    // everything would also satisfy a "<= 30" assertion.
    expect((c.send as any).mock.calls.length).toBe(RATE_LIMIT_PER_HOUR);
    expect(results.filter((r) => r.result === 'rate-limited').length).toBe(40 - RATE_LIMIT_PER_HOUR);
    // The suppressed attempts are still recorded, so the feed shows what was dropped.
    const suppressed = c.db.prepare(`SELECT COUNT(*) AS n FROM em_actions WHERE result LIKE 'suppressed%'`).get() as any;
    expect(suppressed.n).toBe(10);
    c.db.close();
  });

  it('does not consume rate limit in shadow mode', () => {
    const c = ctx({ mode: 'shadow' });
    const id = findingId(c);
    for (let i = 0; i < 40; i++) writeToPane(c, id, 'answer', PANE, `m${i}`);
    expect(c.send).not.toHaveBeenCalled();
    expect(paneWritesSince(c.db, 0)).toBe(0);
    c.db.close();
  });
});

describe('repoSlug', () => {
  it('returns the slug gh reports', () => {
    const gh = vi.fn(() => 'tax-pilot-org/tax-pilot-app\n');
    expect(repoSlug('/repo', gh)).toBe('tax-pilot-org/tax-pilot-app');
  });

  it('returns null for a directory with no GitHub remote', () => {
    const gh = vi.fn(() => { throw new Error('not a gh repo'); });
    expect(repoSlug('/tmp', gh)).toBeNull();
  });
});

describe('fileIssue', () => {
  it('files the issue and returns its url in live mode', () => {
    const c = ctx({ mode: 'live' });
    const r = fileIssue(c, findingId(c), '/repo', { title: 'Add a test', body: 'retry path uncovered' }, 'sess-1');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/o/r/issues/1');
    const args = (c.gh as any).mock.calls.at(-1)[0] as string[];
    expect(args).toContain('--label');
    expect(args).toContain('fast-follow');
    // The issue must point back at the session it came from.
    expect(args.join(' ')).toContain('sess-1');
    c.db.close();
  });

  it('reports failure rather than throwing when gh errors', () => {
    const c = ctx({ mode: 'live', gh: vi.fn(() => { throw new Error('gh: not authenticated'); }) });
    expect(fileIssue(c, findingId(c), '/repo', { title: 't', body: 'b' }, 's').ok).toBe(false);
    c.db.close();
  });
});
