import type { ActionItem } from './actions.ts';
import type { PreSend } from './actionsend.ts';
import type { RedraftMark } from './redraft.ts';

// The pure half of the action tick: given a chain and what is known right now,
// decide what changes. Only the current step is evaluated, so steps fire one
// per tick, and unknown state (a null fact) never fires anything.

export interface ActionFacts {
  pr(repo: string, n: number): { state: 'open' | 'merged' | 'closed'; deploy: string } | { error: string } | null;
  draft(id: string): { status: string; kind: 'slack' | 'email' | 'review'; revised_at: string } | null;
  /** The pre-send check of a pending draft (src/actionsend.ts). Never blocks. */
  preSend(draftId: string): PreSend;
  /** The outbox's Redraft mark on a draft, if any. */
  redraftMark(draftId: string): RedraftMark | undefined;
  /** Is this process posting the step's draft right now? */
  sendInFlight(stepId: string): boolean;
  /** Why Loom cannot post to Slack right now ('' when it can). */
  slackOff(): string;
}

export type Effect = 'send' | 'send_kept' | 'redraft' | 'wake';

export interface Decision {
  id: string;
  patch: Partial<ActionItem>;
  effect?: Effect;
  /** The new-message ids a send acknowledges (send, send_kept). */
  ack?: string[];
  log?: string;
}

/** The first step that is neither removed nor done. */
export function currentStep(chain: ActionItem[]): ActionItem | null {
  return chain.find((s) => s.status !== 'removed' && s.status !== 'done') ?? null;
}

export type TriggerState = { fired: true; why: string } | { fired: false; why: string };

export function triggerState(s: ActionItem, facts: ActionFacts, _now: number): TriggerState {
  switch (s.trigger_type) {
    case 'now':
      return { fired: true, why: 'now' };
    case 'manual':
      return { fired: false, why: 'check it off when done' };
    case 'pr_merged':
    case 'pr_shipped': {
      const n = Number(s.trigger_params.number);
      const fact = facts.pr(String(s.trigger_params.repo), n);
      if (!fact) return { fired: false, why: `waiting for PR #${n}'s status` };
      if ('error' in fact) return { fired: false, why: `can't read PR #${n}: ${fact.error}` };
      if (fact.state === 'closed') return { fired: false, why: `PR #${n} was closed without merging` };
      if (fact.state !== 'merged') return { fired: false, why: `waiting for PR #${n} to merge` };
      if (s.trigger_type === 'pr_merged') return { fired: true, why: `PR #${n} merged` };
      if (fact.deploy === 'pass' || fact.deploy === 'skipped') return { fired: true, why: `PR #${n} shipped` };
      return { fired: false, why: `waiting for PR #${n} to deploy` };
    }
    case 'draft_sent': {
      const id = String(s.trigger_params.draft_id);
      const d = facts.draft(id);
      if (!d) return { fired: false, why: `draft ${id} not found` };
      if (d.status === 'sent') return { fired: true, why: `draft ${id} sent` };
      if (d.status === 'discarded' || d.status === 'superseded') return { fired: false, why: `draft ${id} was discarded` };
      return { fired: false, why: `waiting for draft ${id} to be sent` };
    }
    default:
      // slack_reply arrives with a later task; until then it never fires.
      return { fired: false, why: 'waiting' };
  }
}

const draftIdOf = (s: ActionItem): string => String(s.action_params.draft_id ?? '');

/**
 * A send_draft step whose draft is settled, wherever it is in the chain: sent
 * (by the step or by hand) is done, discarded or superseded is removed. Null
 * when the draft is still pending or unknown.
 */
function settled(s: ActionItem, facts: ActionFacts, now: number): Decision | null {
  if (s.action_type !== 'send_draft' || s.status === 'done' || s.status === 'removed') return null;
  const d = facts.draft(draftIdOf(s));
  if (!d) return null;
  if (d.status === 'sent') return { id: s.id, patch: { status: 'done', status_why: 'sent', done_at: now }, log: `${s.title}: draft sent; done` };
  if (d.status === 'discarded' || d.status === 'superseded') {
    return { id: s.id, patch: { status: 'removed', status_why: 'draft discarded', removed_from: s.status }, log: `${s.title}: draft discarded; step removed` };
  }
  return null;
}

/** A current send_draft step that is not waiting: held, running. Due and failed wait for a person. */
function sendDraftAfterFire(s: ActionItem, facts: ActionFacts, now: number): Decision[] {
  const id = draftIdOf(s);
  const d = facts.draft(id);
  if (!d || d.status !== 'pending') return [];
  if (s.status === 'running') {
    if (facts.sendInFlight(s.id)) return [];
    return [{ id: s.id, patch: { status: 'failed', status_why: 'Loom restarted mid-send; Retry checks Slack first' }, log: `${s.title}: Loom restarted mid-send; failed` }];
  }
  if (s.status === 'held') {
    // The chat replaced the draft: check the new text from the top (a Run click does not carry over to it).
    if (d.revised_at !== s.held_rev) {
      return [{ id: s.id, patch: { status: 'waiting', status_why: 'the draft was replaced; checking again', held_rev: '', held_at: 0, fired_at: 0, approved_rev: '' }, log: `${s.title}: draft replaced; checking again` }];
    }
    // Only the answer to the redraft this hold asked for sends: a mark kept after the hold, for this revision.
    // A hold that asked for none (Slack off, a refused send) has held_at 0 and never sends on a mark.
    const m = facts.redraftMark(id);
    if (s.held_at > 0 && m && m.state === 'kept' && m.at > s.held_at && m.revised_at === d.revised_at && !(d.kind !== 'email' && facts.slackOff())) {
      return [{ id: s.id, patch: { status: 'running', status_why: 'sending (the chat kept the draft)' }, effect: 'send_kept', ack: [...m.ids], log: `${s.title}: the chat kept the draft; sending` }];
    }
  }
  return [];
}

export function evaluateChain(chain: ActionItem[], facts: ActionFacts, now: number): Decision[] {
  const out: Decision[] = [];
  for (const x of chain) {
    const d = settled(x, facts, now);
    if (d) out.push(d);
  }
  if (out.length) return out; // the chain moved; the next step is evaluated next tick
  const s = currentStep(chain);
  if (!s) return out;
  if (s.action_type === 'send_draft' && s.status !== 'waiting') return sendDraftAfterFire(s, facts, now);
  if (s.status !== 'waiting') return out;
  if (s.current_at === 0) out.push({ id: s.id, patch: { current_at: now } });
  // fired_at on a waiting send_draft step means a person clicked Run on it: the trigger and ask_first are passed.
  const approved = s.action_type === 'send_draft' && s.fired_at > 0;
  const t: TriggerState = approved ? { fired: true, why: 'Run' } : triggerState(s, facts, now);
  if (!t.fired) {
    if (t.why !== s.status_why) out.push({ id: s.id, patch: { status_why: t.why } });
    return out;
  }
  if (s.action_type === 'send_draft') return [...out, ...sendDraftFired(s, t.why, approved, facts, now)];
  // Only `none` executes so far; any other action waits for Run, like ask_first.
  if (s.action_type === 'none' && !s.ask_first) {
    out.push({ id: s.id, patch: { status: 'done', status_why: '', done_at: now }, log: `${s.title}: ${t.why}; done` });
  } else {
    out.push({ id: s.id, patch: { status: 'due', fired_at: now, status_why: `${t.why}; waiting for Run` } });
  }
  return out;
}

/** A waiting send_draft step whose trigger fired (or that a person Ran). Every path that is not a clear yes holds or waits. */
function sendDraftFired(s: ActionItem, why: string, approved: boolean, facts: ActionFacts, now: number): Decision[] {
  const id = draftIdOf(s);
  const d = facts.draft(id);
  const stay = (w: string): Decision[] => (w === s.status_why ? [] : [{ id: s.id, patch: { status_why: w } }]);
  if (!d) return stay(`draft ${id} not found`);
  if (d.status !== 'pending') return stay(`draft ${id} is ${d.status}`);
  // A Run approves the text it was clicked on; a draft revised since goes back to due for another Run.
  if (approved && d.revised_at !== s.approved_rev) {
    return [{ id: s.id, patch: { status: 'due', fired_at: now, approved_rev: '', status_why: 'the draft changed after Run; Run again to send the new text' }, log: `${s.title}: draft changed after Run; due again` }];
  }
  if (!approved) {
    if (d.kind !== 'slack') return [{ id: s.id, patch: { status: 'due', fired_at: now, status_why: `${why}; emails and reviews wait for Run` } }];
    if (s.ask_first) return [{ id: s.id, patch: { status: 'due', fired_at: now, status_why: `${why}; waiting for Run` } }];
  }
  const off = d.kind !== 'email' ? facts.slackOff() : '';
  if (off) return [{ id: s.id, patch: { status: 'held', status_why: off, held_rev: d.revised_at, held_at: 0 }, log: `${s.title}: held: ${off}` }];
  const p = facts.preSend(id);
  if (p.decision === 'pending') return stay('checking the thread before sending');
  if (p.decision === 'hold') {
    return [{ id: s.id, patch: { status: 'held', status_why: `held: ${p.why}`, held_rev: d.revised_at, held_at: now }, effect: 'redraft', log: `${s.title}: held: ${p.why}` }];
  }
  return [{ id: s.id, patch: { status: 'running', status_why: 'sending', fired_at: now }, effect: 'send', ack: [...p.ack], log: `${s.title}: ${why}; sending` }];
}
