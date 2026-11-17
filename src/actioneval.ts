import type { ActionItem } from './actions.ts';
import { WAKE_TIMEOUT_MS, type PreSend } from './actionsend.ts';
import type { RedraftMark } from './redraft.ts';
import type { FreshItem } from './outboxfresh.ts';

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
  /** Replies in a slack_reply step's thread since the step became current. Never blocks: 'pending' until the first read lands. */
  replies(s: ActionItem): { items: FreshItem[] } | { error: string } | 'pending' | 'off';
  /** Does this reply answer the step's question? Asked of the cheap model, never awaited. */
  answers(s: ActionItem, item: FreshItem): 'yes' | 'no' | 'pending' | 'unavailable';
}

export type Effect = 'send' | 'send_kept' | 'redraft' | 'wake';

export interface Decision {
  id: string;
  patch: Partial<ActionItem>;
  effect?: Effect;
  /** The new-message ids a send acknowledges (send, send_kept). */
  ack?: string[];
  /** What fired a wake (the trigger's why, or the Run): the leash prompt names it. */
  why?: string;
  log?: string;
}

/** The first step that is neither removed nor done. */
export function currentStep(chain: ActionItem[]): ActionItem | null {
  return chain.find((s) => s.status !== 'removed' && s.status !== 'done') ?? null;
}

export type TriggerState = { fired: true; why: string } | { fired: false; why: string };

export function triggerState(s: ActionItem, facts: ActionFacts, now: number): TriggerState {
  switch (s.trigger_type) {
    case 'now':
      return { fired: true, why: 'now' };
    case 'manual':
      // A `none` step is checked off; one that sends or wakes goes due for Run (evaluateChain).
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
    case 'slack_reply':
      return slackReplyState(s, facts);
    case 'clock': {
      // Late, not skipped: a tick after the time (Loom was asleep or closed) still fires.
      const at = Number(s.trigger_params.at);
      const label = String(s.trigger_params.label ?? '');
      if (!Number.isFinite(at)) return { fired: false, why: 'no time set' };
      return now >= at ? { fired: true, why: `it is ${label}` } : { fired: false, why: `waiting until ${label}` };
    }
    default:
      return { fired: false, why: 'waiting' };
  }
}

/** A reply in the thread, optionally from a named person, optionally one the model judges to answer a question. Anything not a clear yes keeps waiting. */
function slackReplyState(s: ActionItem, facts: ActionFacts): TriggerState {
  const r = facts.replies(s);
  if (r === 'off') return { fired: false, why: "Slack direct mode is off, so replies can't be watched" };
  if (r === 'pending') return { fired: false, why: 'checking the thread for replies' };
  if ('error' in r) return { fired: false, why: `can't read the thread: ${r.error}` };
  const from = String(s.trigger_params.from ?? '').trim().toLowerCase();
  const question = String(s.trigger_params.answers ?? '').trim();
  const mine = r.items.filter((i) => !from || i.author.toLowerCase().includes(from));
  if (!mine.length) return { fired: false, why: from ? `waiting for a reply from ${s.trigger_params.from}` : 'waiting for a reply' };
  if (!question) return { fired: true, why: `${mine[0].author} replied` };
  for (const i of mine) {
    const v = facts.answers(s, i);
    if (v === 'yes') return { fired: true, why: `${i.author} replied` };
    if (v === 'no') continue;
    return { fired: false, why: v === 'unavailable' ? `${i.author} replied; couldn't check it answers the question` : `checking whether ${i.author}'s reply answers the question` };
  }
  return { fired: false, why: 'waiting for a reply that answers the question' };
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
  let s = currentStep(chain);
  if (!s) return out;
  // A waiting step behind the current one is not current yet: clear any stamp (rows from before the stamp
  // moved to becoming current) so its baseline is taken when it really starts.
  for (const x of chain) if (x !== s && x.status === 'waiting' && x.current_at !== 0) out.push({ id: x.id, patch: { current_at: 0 } });
  if (s.action_type === 'send_draft' && s.status !== 'waiting') return sendDraftAfterFire(s, facts, now);
  if (s.action_type === 'wake_chat' && s.status !== 'waiting') return [...out, ...wakeAfterFire(s, now)];
  if (s.status !== 'waiting') return out;
  // The step starts now: stamp it, and judge this tick against that stamp, not the empty one.
  if (s.current_at === 0) {
    out.push({ id: s.id, patch: { current_at: now } });
    s = { ...s, current_at: now };
  }
  // fired_at on a waiting send_draft or wake_chat step means a person clicked Run on it: the trigger and ask_first are passed.
  const approved = (s.action_type === 'send_draft' || s.action_type === 'wake_chat') && s.fired_at > 0;
  // A manual step that sends or wakes fires when the person runs it: it goes due (Run), and Run approves it
  // through the same path as any other due step. Only a `none` step is checked off.
  if (!approved && s.trigger_type === 'manual' && s.action_type !== 'none') {
    out.push({ id: s.id, patch: { status: 'due', fired_at: now, status_why: 'waiting for Run' } });
    return out;
  }
  const t: TriggerState = approved ? { fired: true, why: s.action_type === 'wake_chat' ? 'started with Run' : 'Run' } : triggerState(s, facts, now);
  if (!t.fired) {
    if (t.why !== s.status_why) out.push({ id: s.id, patch: { status_why: t.why } });
    return out;
  }
  if (s.action_type === 'send_draft') return [...out, ...sendDraftFired(s, t.why, approved, facts, now)];
  if (s.action_type === 'wake_chat' && (approved || !s.ask_first)) {
    // The one place a wake starts: the step goes running here, and a running step is never woken again.
    out.push({ id: s.id, patch: { status: 'running', fired_at: now, status_why: `${t.why}; waiting for the chat to report` }, effect: 'wake', why: t.why, log: `${s.title}: ${t.why}; waking the chat` });
    return out;
  }
  // `none` finishes here; anything left (ask_first) waits for Run.
  if (s.action_type === 'none' && !s.ask_first) {
    out.push({ id: s.id, patch: { status: 'done', status_why: '', done_at: now }, log: `${s.title}: ${t.why}; done` });
  } else {
    out.push({ id: s.id, patch: { status: 'due', fired_at: now, status_why: `${t.why}; waiting for Run` } });
  }
  return out;
}

/** A current wake_chat step past its firing: running fails once the chat has been silent too long; due and failed wait for a person. */
function wakeAfterFire(s: ActionItem, now: number): Decision[] {
  if (s.status !== 'running' || now - s.fired_at <= WAKE_TIMEOUT_MS) return [];
  return [{ id: s.id, patch: { status: 'failed', status_why: 'no report from the chat in 2 h' }, log: `${s.title}: no report from the chat in 2 h; failed` }];
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

/**
 * Close when done: may Loom close this chat now? Only with the flag on, not closed
 * since the last step was added, at least one step kept and every kept step done,
 * nothing running, and a chat Loom can see is idle (not at a prompt) with no pending drafts. An
 * unknown chat (null) never closes; the why says what it waits on.
 */
export function closeDecision(
  chain: ActionItem[],
  flags: { close_when_done: boolean; closed_at: number },
  chat: { working: boolean; pendingDrafts: number; atPrompt?: boolean; focused?: boolean } | null,
): { close: boolean; why: string } {
  const no = (why: string) => ({ close: false, why });
  if (!flags.close_when_done) return no('close when done is off');
  if (flags.closed_at !== 0) return no('already closed');
  const kept = chain.filter((s) => s.status !== 'removed');
  if (!kept.length) return no('no steps');
  if (kept.some((s) => s.status === 'running')) return no('waiting: a step is running');
  const open = kept.filter((s) => s.status !== 'done').length;
  if (open) return no(`waiting: ${open} step${open === 1 ? '' : 's'} not done`);
  if (!chat) return no("waiting: the chat's state is unknown");
  if (chat.working) return no('waiting: chat is working');
  if (chat.atPrompt) return no('waiting: the chat is at a prompt or has a tool call open');
  if (chat.focused) return no("waiting: you're in this chat");
  if (chat.pendingDrafts !== 0) return no(`waiting: ${chat.pendingDrafts} draft${chat.pendingDrafts === 1 ? '' : 's'} pending`);
  return { close: true, why: 'every step done' };
}
