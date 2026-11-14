import type { ActionItem } from './actions.ts';

// The pure half of the action tick: given a chain and what is known right now,
// decide what changes. Only the current step is evaluated, so steps fire one
// per tick, and unknown state (a null fact) never fires anything.

export interface ActionFacts {
  pr(repo: string, n: number): { state: 'open' | 'merged' | 'closed'; deploy: string } | { error: string } | null;
  draft(id: string): { status: string; kind: 'slack' | 'email' | 'review'; revised_at: string } | null;
}

export type Effect = 'send' | 'send_kept' | 'redraft' | 'wake';

export interface Decision {
  id: string;
  patch: Partial<ActionItem>;
  effect?: Effect;
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

export function evaluateChain(chain: ActionItem[], facts: ActionFacts, now: number): Decision[] {
  const s = currentStep(chain);
  if (!s || s.status !== 'waiting') return [];
  const out: Decision[] = [];
  if (s.current_at === 0) out.push({ id: s.id, patch: { current_at: now } });
  const t = triggerState(s, facts, now);
  if (!t.fired) {
    if (t.why !== s.status_why) out.push({ id: s.id, patch: { status_why: t.why } });
    return out;
  }
  // Only `none` executes so far; any other action waits for Run, like ask_first.
  if (s.action_type === 'none' && !s.ask_first) {
    out.push({ id: s.id, patch: { status: 'done', status_why: '', done_at: now }, log: `${s.title}: ${t.why}; done` });
  } else {
    out.push({ id: s.id, patch: { status: 'due', fired_at: now, status_why: `${t.why}; waiting for Run` } });
  }
  return out;
}
