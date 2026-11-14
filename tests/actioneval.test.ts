import { describe, it, expect } from 'vitest';
import type { ActionItem } from '../src/actions.ts';
import { currentStep, evaluateChain, triggerState, type ActionFacts } from '../src/actioneval.ts';

const NOW = 5_000;
let n = 0;
const step = (over: Partial<ActionItem> = {}): ActionItem => ({
  id: `a${String(++n).padStart(12, '0')}`, session_id: 's1', position: n, title: 'T', trigger_type: 'now', trigger_params: {},
  action_type: 'none', action_params: {}, ask_first: false, status: 'waiting', status_why: '', created_by: 'chat',
  created_at: 1, current_at: 1, fired_at: 0, done_at: 0, attempts: 0, held_rev: '', removed_from: '', ...over,
});
const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({ pr: () => null, draft: () => null, ...over });
const pr = { repo: 'acme/app', number: 123 };

describe('currentStep', () => {
  it('skips removed and done steps', () => {
    const a = step(), b = step();
    expect(currentStep([step({ status: 'done' }), step({ status: 'removed' }), a, b])).toBe(a);
    expect(currentStep([step({ status: 'done' })])).toBeNull();
  });
});

describe('evaluateChain', () => {
  it('finishes a now/none step, and leaves the next step for a later tick', () => {
    const a = step(), b = step();
    const d = evaluateChain([a, b], facts(), NOW);
    expect(d).toHaveLength(1);
    expect(d[0].id).toBe(a.id);
    expect(d[0].patch).toMatchObject({ status: 'done', done_at: NOW });
    expect(d[0].log).toBeTruthy();
  });

  it('stamps current_at when the step has none, and keeps evaluating', () => {
    const a = step({ current_at: 0 });
    const d = evaluateChain([a], facts(), NOW);
    expect(d).toHaveLength(2);
    expect(d[0].patch).toEqual({ current_at: NOW });
    expect(d[1].patch.status).toBe('done');
  });

  it('does not write when a null PR fact leaves the why unchanged', () => {
    const a = step({ trigger_type: 'pr_merged', trigger_params: pr });
    const d = evaluateChain([a], facts(), NOW);
    expect(d).toEqual([{ id: a.id, patch: { status_why: "waiting for PR #123's status" } }]);
    expect(evaluateChain([{ ...a, status_why: "waiting for PR #123's status" }], facts(), NOW)).toEqual([]);
  });

  it('reports a PR read error and stays waiting', () => {
    const a = step({ trigger_type: 'pr_merged', trigger_params: pr });
    const d = evaluateChain([a], facts({ pr: () => ({ error: 'gh: not logged in' }) }), NOW);
    expect(d).toEqual([{ id: a.id, patch: { status_why: "can't read PR #123: gh: not logged in" } }]);
  });

  it('pr_shipped waits on a running deploy and fires on skipped', () => {
    const a = step({ trigger_type: 'pr_shipped', trigger_params: pr });
    const running = evaluateChain([a], facts({ pr: () => ({ state: 'merged', deploy: 'running' }) }), NOW);
    expect(running[0].patch.status).toBeUndefined();
    const skipped = evaluateChain([a], facts({ pr: () => ({ state: 'merged', deploy: 'skipped' }) }), NOW);
    expect(skipped[0].patch.status).toBe('done');
  });

  it('ask_first goes due, never done', () => {
    const a = step({ ask_first: true });
    const d = evaluateChain([a], facts(), NOW);
    expect(d[0].patch).toEqual({ status: 'due', fired_at: NOW, status_why: 'now; waiting for Run' });
  });

  it('a fired send_draft step is due, waiting for Run', () => {
    const a = step({ action_type: 'send_draft', action_params: { draft_id: 'd0123456789ab' } });
    const d = evaluateChain([a], facts(), NOW);
    expect(d[0].patch).toMatchObject({ status: 'due', status_why: 'now; waiting for Run' });
    expect(d[0].effect).toBeUndefined();
  });

  it('does nothing for due, held, failed and running steps', () => {
    for (const status of ['due', 'held', 'failed', 'running'] as const) {
      expect(evaluateChain([step({ status })], facts(), NOW)).toEqual([]);
    }
  });

  it('removing a step makes the next current; undoing it makes it current again without touching a done successor', () => {
    const a = step({ trigger_type: 'manual' }), b = step({ trigger_type: 'manual', status: 'done' });
    expect(currentStep([{ ...a, status: 'removed', removed_from: 'waiting' }, step({ id: 'bbb' })])?.id).toBe('bbb');
    const restored = { ...a, status: 'waiting' as const };
    expect(currentStep([restored, b])).toBe(restored);
    expect(evaluateChain([restored, b], facts(), NOW).every((d) => d.id === a.id)).toBe(true);
  });
});

describe('triggerState', () => {
  const t = (type: ActionItem['trigger_type'], params: Record<string, unknown>, f: Partial<ActionFacts>) =>
    triggerState(step({ trigger_type: type, trigger_params: params }), facts(f), NOW);

  it('manual never fires', () => {
    expect(t('manual', {}, {})).toEqual({ fired: false, why: 'check it off when done' });
  });
  it('pr_merged fires on merged and not on closed', () => {
    expect(t('pr_merged', pr, { pr: () => ({ state: 'merged', deploy: '' }) })).toEqual({ fired: true, why: 'PR #123 merged' });
    expect(t('pr_merged', pr, { pr: () => ({ state: 'closed', deploy: '' }) })).toEqual({ fired: false, why: 'PR #123 was closed without merging' });
    expect(t('pr_merged', pr, { pr: () => ({ state: 'open', deploy: '' }) }).fired).toBe(false);
  });
  it('pr_shipped fires on pass', () => {
    expect(t('pr_shipped', pr, { pr: () => ({ state: 'merged', deploy: 'pass' }) })).toEqual({ fired: true, why: 'PR #123 shipped' });
  });
  it('draft_sent', () => {
    const p = { draft_id: 'd0123456789ab' };
    const d = (status: string) => () => ({ status, kind: 'slack' as const, revised_at: '' });
    expect(t('draft_sent', p, { draft: d('sent') }).fired).toBe(true);
    expect(t('draft_sent', p, { draft: d('pending') }).fired).toBe(false);
    expect(t('draft_sent', p, { draft: d('discarded') })).toEqual({ fired: false, why: 'draft d0123456789ab was discarded' });
    expect(t('draft_sent', p, { draft: d('superseded') }).why).toBe('draft d0123456789ab was discarded');
    expect(t('draft_sent', p, {})).toEqual({ fired: false, why: 'draft d0123456789ab not found' });
  });
});
