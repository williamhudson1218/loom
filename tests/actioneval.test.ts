import { describe, it, expect } from 'vitest';
import type { ActionItem } from '../src/actions.ts';
import { closeDecision, currentStep, evaluateChain, triggerState, type ActionFacts } from '../src/actioneval.ts';

const NOW = 5_000;
let n = 0;
const step = (over: Partial<ActionItem> = {}): ActionItem => ({
  id: `a${String(++n).padStart(12, '0')}`, session_id: 's1', position: n, title: 'T', trigger_type: 'now', trigger_params: {},
  action_type: 'none', action_params: {}, ask_first: false, status: 'waiting', status_why: '', created_by: 'chat',
  created_at: 1, current_at: 1, fired_at: 0, done_at: 0, attempts: 0, held_rev: '', held_at: 0, approved_rev: '', removed_from: '', ...over,
});
const facts = (over: Partial<ActionFacts> = {}): ActionFacts => ({
  pr: () => null, draft: () => null, preSend: () => ({ decision: 'pending' }), redraftMark: () => undefined, sendInFlight: () => false, slackOff: () => '', replies: () => 'pending', answers: () => 'pending', ...over,
});
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
    const a = step(), b = step({ current_at: 0 });
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

  it('a fired send_draft step whose draft is unknown stays waiting and never sends', () => {
    const a = step({ action_type: 'send_draft', action_params: { draft_id: 'd0123456789ab' } });
    const d = evaluateChain([a], facts(), NOW);
    expect(d).toEqual([{ id: a.id, patch: { status_why: 'draft d0123456789ab not found' } }]);
  });

  it('does nothing for due, held, failed and running none steps', () => {
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
  it('clock fires once now reaches the stored time, late rather than skipped', () => {
    const p = { at: 1_000_000, label: '7:00am Tue Nov 17' };
    expect(triggerState(step({ trigger_type: 'clock', trigger_params: p }), facts(), 999_999)).toEqual({ fired: false, why: 'waiting until 7:00am Tue Nov 17' });
    expect(triggerState(step({ trigger_type: 'clock', trigger_params: p }), facts(), 1_000_000)).toEqual({ fired: true, why: 'it is 7:00am Tue Nov 17' });
    expect(triggerState(step({ trigger_type: 'clock', trigger_params: p }), facts(), 9_000_000).fired).toBe(true);
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

describe('send_draft steps', () => {
  const DID = 'd0123456789ab';
  const sd = (over: Partial<ActionItem> = {}) => step({ action_type: 'send_draft', action_params: { draft_id: DID }, ...over });
  const dr = (status: string, over: Partial<{ kind: 'slack' | 'email' | 'review'; revised_at: string }> = {}) =>
    () => ({ status, kind: 'slack' as const, revised_at: '', ...over });
  const pending = dr('pending');
  const only = (d: ReturnType<typeof evaluateChain>) => d.filter((x) => x.patch.status !== undefined || x.effect);

  it('a sent draft marks the step done in every non-final state, whoever sent it', () => {
    for (const status of ['waiting', 'due', 'running', 'held', 'failed'] as const) {
      const a = sd({ status });
      const d = only(evaluateChain([a], facts({ draft: dr('sent') }), NOW));
      expect(d).toHaveLength(1);
      expect(d[0].patch).toMatchObject({ status: 'done', status_why: 'sent', done_at: NOW });
      expect(d[0].effect).toBeUndefined();
    }
  });

  it('a sent draft marks a later step done too (Send now on a scheduled card), without firing anything', () => {
    const first = step({ trigger_type: 'manual' });
    const later = sd({ trigger_type: 'pr_merged', trigger_params: pr });
    const d = evaluateChain([first, later], facts({ draft: dr('sent') }), NOW);
    expect(d.find((x) => x.id === later.id)?.patch).toMatchObject({ status: 'done', status_why: 'sent' });
    expect(d.some((x) => x.effect)).toBe(false);
  });

  it('a discarded or superseded draft removes the step', () => {
    for (const ds of ['discarded', 'superseded']) {
      for (const status of ['waiting', 'due', 'held', 'failed'] as const) {
        const d = only(evaluateChain([sd({ status })], facts({ draft: dr(ds) }), NOW));
        expect(d[0].patch).toMatchObject({ status: 'removed', status_why: 'draft discarded', removed_from: status });
        expect(d[0].effect).toBeUndefined();
      }
    }
  });

  it('email and review drafts go due and wait for Run', () => {
    for (const kind of ['email', 'review'] as const) {
      const d = only(evaluateChain([sd()], facts({ draft: dr('pending', { kind }), preSend: () => ({ decision: 'send', ack: [] }) }), NOW));
      expect(d).toEqual([{ id: d[0].id, patch: { status: 'due', fired_at: NOW, status_why: 'now; emails and reviews wait for Run' } }]);
    }
  });

  it('ask_first on a Slack draft goes due, never sends', () => {
    const d = only(evaluateChain([sd({ ask_first: true })], facts({ draft: pending, preSend: () => ({ decision: 'send', ack: [] }) }), NOW));
    expect(d[0].patch).toEqual({ status: 'due', fired_at: NOW, status_why: 'now; waiting for Run' });
    expect(d[0].effect).toBeUndefined();
  });

  it('Slack send off holds with the slack-off detail', () => {
    const d = only(evaluateChain([sd()], facts({ draft: pending, slackOff: () => 'Slack direct mode is off', preSend: () => ({ decision: 'send', ack: [] }) }), NOW));
    expect(d[0].patch).toMatchObject({ status: 'held', status_why: 'Slack direct mode is off' });
    expect(d[0].effect).toBeUndefined();
  });

  it('pre-send pending: stays waiting, checking the thread', () => {
    const d = evaluateChain([sd()], facts({ draft: pending }), NOW);
    expect(d).toEqual([{ id: d[0].id, patch: { status_why: 'checking the thread before sending' } }]);
  });

  it('pre-send send: running with the send effect and its ack', () => {
    const d = only(evaluateChain([sd()], facts({ draft: pending, preSend: () => ({ decision: 'send', ack: ['slack:1.2'] }) }), NOW));
    expect(d).toHaveLength(1);
    expect(d[0].patch).toMatchObject({ status: 'running', fired_at: NOW });
    expect(d[0].effect).toBe('send');
    expect(d[0].ack).toEqual(['slack:1.2']);
  });

  it('a trigger that has not fired never sends, even with a send verdict', () => {
    const a = sd({ trigger_type: 'pr_merged', trigger_params: pr });
    const d = evaluateChain([a], facts({ draft: pending, pr: () => ({ state: 'open', deploy: '' }), preSend: () => ({ decision: 'send', ack: [] }) }), NOW);
    expect(d.some((x) => x.effect || x.patch.status)).toBe(false);
  });

  it('pre-send hold: held with the reason, held_rev pinned, and a redraft', () => {
    const d = only(evaluateChain([sd()], facts({ draft: dr('pending', { revised_at: 'R1' }), preSend: () => ({ decision: 'hold', why: 'the reviewer asked to wait for #130' }) }), NOW));
    expect(d[0].patch).toMatchObject({ status: 'held', status_why: 'held: the reviewer asked to wait for #130', held_rev: 'R1', held_at: NOW });
    expect(d[0].effect).toBe('redraft');
  });

  it('held: the chat replacing the draft sends the step back to waiting, and an unchanged draft stays held', () => {
    const replaced = only(evaluateChain([sd({ status: 'held', held_rev: 'R1', fired_at: 9 })], facts({ draft: dr('pending', { revised_at: 'R2' }) }), NOW));
    expect(replaced[0].patch).toMatchObject({ status: 'waiting', held_rev: '', fired_at: 0 });
    expect(replaced[0].effect).toBeUndefined();
    expect(only(evaluateChain([sd({ status: 'held', held_rev: 'R1' })], facts({ draft: dr('pending', { revised_at: 'R1' }) }), NOW))).toEqual([]);
  });

  it('held: the chat keeping the draft after the hold sends it, acking the messages the redraft carried', () => {
    const held = sd({ status: 'held', held_rev: 'R1', held_at: 100 });
    const mark = { at: 200, n: 1, revised_at: 'R1', ids: ['slack:1.2'], state: 'kept' as const };
    const f = (m: object | undefined, over: Partial<ActionFacts> = {}) => facts({ draft: dr('pending', { revised_at: 'R1' }), redraftMark: () => m as never, ...over });
    const d = only(evaluateChain([held], f(mark), NOW));
    expect(d[0].patch).toMatchObject({ status: 'running' });
    expect(d[0].effect).toBe('send_kept');
    expect(d[0].ack).toEqual(['slack:1.2']);
    // Not yet kept, kept for an older revision: nothing.
    expect(only(evaluateChain([held], f({ ...mark, state: undefined }), NOW))).toEqual([]);
    expect(only(evaluateChain([held], f({ ...mark, revised_at: 'R0' }), NOW))).toEqual([]);
  });

  it('held: a kept mark from before the hold is stale and sends nothing', () => {
    const mark = { at: 50, n: 1, revised_at: 'R1', ids: [], state: 'kept' as const };
    const d = evaluateChain([sd({ status: 'held', held_rev: 'R1', held_at: 100 })], facts({ draft: dr('pending', { revised_at: 'R1' }), redraftMark: () => mark }), NOW);
    expect(d.some((x) => x.effect || x.patch.status)).toBe(false);
  });

  it('a Slack-off hold never sends on a kept mark, even once Slack is back', () => {
    const off = only(evaluateChain([sd()], facts({ draft: dr('pending', { revised_at: 'R1' }), slackOff: () => 'off' }), NOW));
    expect(off[0].patch).toMatchObject({ status: 'held', held_at: 0 });
    const mark = { at: NOW + 10, n: 1, revised_at: 'R1', ids: [], state: 'kept' as const };
    const d = evaluateChain([sd({ status: 'held', held_rev: 'R1', held_at: 0 })], facts({ draft: dr('pending', { revised_at: 'R1' }), redraftMark: () => mark }), NOW + 20);
    expect(d.some((x) => x.effect || x.patch.status)).toBe(false);
  });

  it('held with Slack send off never sends a kept draft', () => {
    const mark = { at: 200, n: 1, revised_at: 'R1', ids: [], state: 'kept' as const };
    const d = evaluateChain([sd({ status: 'held', held_rev: 'R1', held_at: 100 })], facts({ draft: dr('pending', { revised_at: 'R1' }), redraftMark: () => mark, slackOff: () => 'off' }), NOW);
    expect(d.some((x) => x.effect)).toBe(false);
  });

  it('running with no send in flight and the draft still pending: failed, Retry checks Slack first', () => {
    const d = only(evaluateChain([sd({ status: 'running' })], facts({ draft: pending, sendInFlight: () => false }), NOW));
    expect(d[0].patch).toMatchObject({ status: 'failed', status_why: 'Loom restarted mid-send; Retry checks Slack first' });
    expect(d[0].effect).toBeUndefined();
  });

  it('running with a send in flight, or an unknown draft, is left alone', () => {
    expect(evaluateChain([sd({ status: 'running' })], facts({ draft: pending, sendInFlight: () => true }), NOW)).toEqual([]);
    expect(evaluateChain([sd({ status: 'running' })], facts({ sendInFlight: () => false }), NOW)).toEqual([]);
  });

  it('due and failed steps never send on their own', () => {
    for (const status of ['due', 'failed'] as const) {
      const d = evaluateChain([sd({ status, fired_at: 9 })], facts({ draft: pending, preSend: () => ({ decision: 'send', ack: [] }) }), NOW);
      expect(d.some((x) => x.effect || x.patch.status)).toBe(false);
    }
  });

  it('a Run on a draft revised since the click goes back to due and never sends', () => {
    const a = sd({ ask_first: true, fired_at: 9, approved_rev: 'R1' });
    const d = only(evaluateChain([a], facts({ draft: dr('pending', { revised_at: 'R2' }), preSend: () => ({ decision: 'send', ack: [] }) }), NOW));
    expect(d).toHaveLength(1);
    expect(d[0].patch).toMatchObject({ status: 'due', approved_rev: '' });
    expect(d[0].effect).toBeUndefined();
  });

  it('a step Run from the panel (waiting, fired_at set) skips the trigger and ask_first and runs the pre-send check', () => {
    const a = sd({ ask_first: true, fired_at: 9, trigger_type: 'manual' });
    const d = only(evaluateChain([a], facts({ draft: dr('pending', { kind: 'email' }), preSend: () => ({ decision: 'send', ack: [] }) }), NOW));
    expect(d[0].effect).toBe('send');
    expect(d[0].patch.status).toBe('running');
  });

  it('a manual send_draft step goes due for Run, and never sends on its own', () => {
    const a = sd({ trigger_type: 'manual' });
    const d = evaluateChain([a], facts({ draft: pending, preSend: () => ({ decision: 'send', ack: [] }) }), NOW);
    expect(d).toEqual([{ id: a.id, patch: { status: 'due', fired_at: NOW, status_why: 'waiting for Run' } }]);
    // Due waits for a person; the Run (waiting with fired_at and the revision) then sends through the pre-send check.
    expect(evaluateChain([{ ...a, status: 'due', fired_at: NOW }], facts({ draft: pending, preSend: () => ({ decision: 'send', ack: [] }) }), NOW)).toEqual([]);
    const run = only(evaluateChain([{ ...a, fired_at: NOW, approved_rev: '' }], facts({ draft: pending, preSend: () => ({ decision: 'send', ack: [] }) }), NOW));
    expect(run[0]).toMatchObject({ effect: 'send', patch: { status: 'running' } });
  });

  it('the Run path still holds on a hold verdict', () => {
    const d = only(evaluateChain([sd({ ask_first: true, fired_at: 9 })], facts({ draft: pending, preSend: () => ({ decision: 'hold', why: 'wait' }) }), NOW));
    expect(d[0].patch.status).toBe('held');
    expect(d[0].effect).toBe('redraft');
  });
});

describe('triggerState: slack_reply', () => {
  const TH = { thread_url: 'https://acme.slack.com/archives/C0123456789/p1700000000000100', channel: 'C0123456789', thread_ts: '1700000000.000100' };
  const sr = (params: Record<string, unknown> = {}) => step({ trigger_type: 'slack_reply', trigger_params: { ...TH, ...params } });
  const it1 = (n: number, author = 'the reviewer') => ({ id: `slack:1700000001.00000${n}`, kind: 'slack' as const, author, at: 1_700_000_001_000 + n, snippet: `m${n}` });
  const ok = (...items: ReturnType<typeof it1>[]) => ({ items });

  it('off: stays waiting and says why', () => {
    expect(triggerState(sr(), facts({ replies: () => 'off' }), NOW)).toEqual({ fired: false, why: "Slack direct mode is off, so replies can't be watched" });
  });
  it('error: stays waiting and says why', () => {
    expect(triggerState(sr(), facts({ replies: () => ({ error: 'HTTP 500' }) }), NOW)).toEqual({ fired: false, why: "can't read the thread: HTTP 500" });
  });
  it('pending and an empty thread never fire', () => {
    expect(triggerState(sr(), facts({ replies: () => 'pending' }), NOW).fired).toBe(false);
    expect(triggerState(sr(), facts({ replies: () => ok() }), NOW).fired).toBe(false);
  });
  it('fires on the first reply with no answers, naming the author', () => {
    expect(triggerState(sr(), facts({ replies: () => ok(it1(1, 'Pat'), it1(2)) }), NOW)).toEqual({ fired: true, why: 'Pat replied' });
  });
  it('from: only that person counts, case-insensitively and by substring', () => {
    const f = facts({ replies: () => ok(it1(1, 'Someone Else')) });
    expect(triggerState(sr({ from: 'pat' }), f, NOW).fired).toBe(false);
    const g = facts({ replies: () => ok(it1(1, 'Someone Else'), it1(2, 'Pat Reviewer')) });
    expect(triggerState(sr({ from: 'pat' }), g, NOW)).toEqual({ fired: true, why: 'Pat Reviewer replied' });
  });
  it('answers: no moves on to the next item, yes fires with that author', () => {
    const asked: string[] = [];
    const f = facts({
      replies: () => ok(it1(1, 'Pat'), it1(2, 'Sam')),
      answers: (_s, i) => (asked.push(i.id), i.author === 'Sam' ? 'yes' : 'no'),
    });
    expect(triggerState(sr({ answers: 'is it approved?' }), f, NOW)).toEqual({ fired: true, why: 'Sam replied' });
    expect(asked).toHaveLength(2);
  });
  it('answers: pending or unavailable keeps waiting and does not look past it', () => {
    const asked: string[] = [];
    const base = { replies: () => ok(it1(1, 'Pat'), it1(2, 'Sam')) };
    const p = triggerState(sr({ answers: 'q' }), facts({ ...base, answers: (_s, i) => (asked.push(i.id), 'pending') }), NOW);
    expect(p.fired).toBe(false);
    expect(asked).toHaveLength(1);
    expect(triggerState(sr({ answers: 'q' }), facts({ ...base, answers: () => 'unavailable' }), NOW)).toEqual({ fired: false, why: "Pat replied; couldn't check it answers the question" });
  });
  it('a step with a deleted reader never fires on a throwing fact', () => {
    expect(() => triggerState(sr(), facts({ replies: () => { throw new Error('x'); } }), NOW)).toThrow();
  });
});

describe('closeDecision', () => {
  const on = { close_when_done: true, closed_at: 0 };
  const idle = { working: false, pendingDrafts: 0 };
  const done = () => step({ status: 'done' });

  it('closes when the flag is on, every kept step is done and the chat is idle with no drafts', () => {
    expect(closeDecision([done(), step({ status: 'removed' }), done()], on, idle)).toEqual({ close: true, why: 'every step done' });
  });
  it('waits while the chat is working', () => {
    expect(closeDecision([done()], on, { working: true, pendingDrafts: 0 })).toEqual({ close: false, why: 'waiting: chat is working' });
    expect(closeDecision([done()], on, { working: false, pendingDrafts: 0, atPrompt: true })).toEqual({ close: false, why: 'waiting: the chat is at a prompt or has a tool call open' });
    expect(closeDecision([done()], on, { working: false, pendingDrafts: 0, focused: true })).toEqual({ close: false, why: "waiting: you're in this chat" });
  });
  it('waits on a pending draft', () => {
    expect(closeDecision([done()], on, { working: false, pendingDrafts: 1 })).toEqual({ close: false, why: 'waiting: 1 draft pending' });
    expect(closeDecision([done()], on, { working: false, pendingDrafts: 2 }).why).toBe('waiting: 2 drafts pending');
  });
  it('waits while a step is running', () => {
    expect(closeDecision([done(), step({ status: 'running' })], on, idle)).toEqual({ close: false, why: 'waiting: a step is running' });
  });
  it('waits on steps that are not done', () => {
    expect(closeDecision([done(), step({ status: 'held' })], on, idle)).toEqual({ close: false, why: 'waiting: 1 step not done' });
  });
  it('never closes on an unknown chat fact', () => {
    expect(closeDecision([done()], on, null)).toEqual({ close: false, why: "waiting: the chat's state is unknown" });
  });
  it('does nothing with the flag off, once closed, or with no steps', () => {
    expect(closeDecision([done()], { close_when_done: false, closed_at: 0 }, idle).close).toBe(false);
    expect(closeDecision([done()], { close_when_done: true, closed_at: 9 }, idle)).toEqual({ close: false, why: 'already closed' });
    expect(closeDecision([], on, idle)).toEqual({ close: false, why: 'no steps' });
    expect(closeDecision([step({ status: 'removed' })], on, idle)).toEqual({ close: false, why: 'no steps' });
  });
});

describe('evaluateChain: wake_chat', () => {
  const wake = (over: Partial<ActionItem> = {}) => step({ action_type: 'wake_chat', action_params: { instruction: 'merge it' }, ...over });

  it('a fired trigger with ask_first off goes running with fired_at and the wake effect', () => {
    const s = wake({ trigger_type: 'pr_merged', trigger_params: pr });
    const d = evaluateChain([s], facts({ pr: () => ({ state: 'merged', deploy: '' }) }), NOW);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ id: s.id, effect: 'wake', why: 'PR #123 merged', patch: { status: 'running', fired_at: NOW } });
  });

  it('ask_first still goes due, with no effect', () => {
    const d = evaluateChain([wake({ ask_first: true })], facts(), NOW);
    expect(d[0].patch).toMatchObject({ status: 'due', fired_at: NOW });
    expect(d[0].effect).toBeUndefined();
  });

  it('a Run (waiting with fired_at) wakes without asking the trigger again', () => {
    const d = evaluateChain([wake({ trigger_type: 'manual', ask_first: true, fired_at: 4_000 })], facts(), NOW);
    expect(d[0]).toMatchObject({ effect: 'wake', why: 'started with Run', patch: { status: 'running', fired_at: NOW } });
  });

  it('a manual wake step goes due for Run, never wakes on its own', () => {
    const s = wake({ trigger_type: 'manual' });
    const d = evaluateChain([s], facts(), NOW);
    expect(d).toEqual([{ id: s.id, patch: { status: 'due', fired_at: NOW, status_why: 'waiting for Run' } }]);
    expect(d.some((x) => x.effect)).toBe(false);
    expect(evaluateChain([{ ...s, status: 'due', fired_at: NOW }], facts(), NOW)).toEqual([]);
  });

  it('a manual none step still only waits to be checked off', () => {
    const s = step({ trigger_type: 'manual' });
    expect(evaluateChain([s], facts(), NOW)).toEqual([{ id: s.id, patch: { status_why: 'check it off when done' } }]);
  });

  it('an unfired or unknown trigger never wakes', () => {
    expect(evaluateChain([wake({ trigger_type: 'pr_merged', trigger_params: pr })], facts(), NOW).some((d) => d.effect)).toBe(false);
  });

  it('a running wake never wakes again; past the timeout it fails', () => {
    const s = wake({ status: 'running', fired_at: NOW - 1000 });
    expect(evaluateChain([s], facts(), NOW)).toEqual([]);
    expect(evaluateChain([s], facts(), NOW - 1000 + 2 * 3_600_000)).toEqual([]);
    const d = evaluateChain([s], facts(), NOW - 1000 + 2 * 3_600_000 + 1);
    expect(d).toHaveLength(1);
    expect(d[0].patch).toEqual({ status: 'failed', status_why: 'no report from the chat in 2 h' });
    expect(d[0].effect).toBeUndefined();
  });

  it('due and failed wake steps wait for a person', () => {
    expect(evaluateChain([wake({ status: 'due', fired_at: 1 })], facts(), NOW)).toEqual([]);
    expect(evaluateChain([wake({ status: 'failed' })], facts(), NOW)).toEqual([]);
  });

  it('a wake the chat reported done lets the next step go', () => {
    const b = step();
    const d = evaluateChain([wake({ status: 'done' }), b], facts(), NOW);
    expect(d[0]).toMatchObject({ id: b.id, patch: { status: 'done' } });
  });
});
