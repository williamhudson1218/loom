import type { OrchItem } from './orchestrator.ts';

// The rail's self-cleaning (design: "the list must not just grow"). Items are
// written by the orchestrator session, but most of them get settled somewhere it
// never hears about: Will answers in the chat, sends the draft from the outbox,
// merges the PR on GitHub, closes or archives the chat. Loom's events only report
// changes in LIVE chats, so an item on a chat that ended is never revisited.
// So on a slow cadence Loom re-checks every open item against the thing it points
// at and clears the ones whose condition no longer holds. Everything here is pure:
// the facts come in through SweepFacts, the caller writes the results.

/** What Loom knows about a chat right now. */
export interface ChatFact {
  onBoard: boolean; // false: hidden or archived off the board
  closed: boolean; // ended with Send & close
  live: boolean; // has a pane
  working: boolean; // mid-turn
  lastTurnAt: number; // last prompt or reply, 0 when not indexed yet
  lastActiveAt: number; // last write of any kind
}

export interface PrFact {
  state: 'open' | 'merged' | 'closed';
  deploy: string; // the pipeline's deploy step state ('' when unknown)
}

/** Lookups answer null when Loom has no data yet: no data never clears anything. */
export interface SweepFacts {
  chat: (ref: string) => ChatFact | null;
  pr: (url: string) => PrFact | null;
  /** An outbox draft's status ('pending' | 'sent' | 'discarded' | 'superseded'), null when unknown. */
  draft: (id: string) => string | null;
  /** A Slack thread's recorded stage ('done' once handled), null when unknown. */
  slack: (url: string) => string | null;
}

export const SWEEP = {
  /** A chat with no pane for this long has ended: its needs-you / moving items go. */
  endedMs: 2 * 3_600_000,
  /** A needs-you item clears once its chat starts working again this long after the item. */
  resumeGraceMs: 5 * 60_000,
  /**
   * The backstop. 72 h without an update covers a weekend (Friday evening to Monday
   * morning is ~64 h), so a Friday ask is still there on Monday; past that, an item
   * nothing can confirm is almost always settled already. Blocked items wait on
   * other people, who are slower, so they get a week. Moving means an agent is at it
   * right now; a day without an update is not moving.
   */
  needsYouMaxMs: 72 * 3_600_000,
  blockedMaxMs: 7 * 24 * 3_600_000,
  movingMaxMs: 24 * 3_600_000,
};

export type SweepOpts = typeof SWEEP;

/** Outbox draft ids quoted in an item ("press Send on d0a0b0c0d0e0f0"). */
export function draftIdsIn(text: string): string[] {
  return [...new Set(text.match(/\bd[0-9a-f]{11,13}\b/g) ?? [])];
}

const H = 3_600_000;
const ago = (ms: number) => (ms >= 48 * H ? `${Math.round(ms / (24 * H))} days` : `${Math.max(1, Math.round(ms / H))} h`);

/**
 * Why this open item no longer holds, or '' to keep it. First the item's own ref,
 * then the outbox drafts it quotes, then the age cap, which only fires when
 * nothing still vouches for the item.
 */
export function staleWhy(item: OrchItem, facts: SweepFacts, now: number, opts: SweepOpts = SWEEP): string {
  if (item.resolved_at || item.kind === 'done') return '';
  // A draft it quotes still waiting in the outbox keeps it: Will can send that without the chat.
  const drafts = draftIdsIn(`${item.title} ${item.why}`)
    .map((id) => facts.draft(id))
    .filter((s): s is string => s !== null);
  const draftPending = drafts.includes('pending');
  let vouched = draftPending; // something verifiable says the item is still true

  if (item.ref_type === 'chat' && item.ref_id) {
    const c = facts.chat(item.ref_id);
    if (c) {
      if (!c.onBoard) return 'chat archived';
      if (c.closed) return 'chat closed';
      const gone = !c.live && now - c.lastActiveAt >= opts.endedMs;
      if (gone && item.kind !== 'blocked' && !draftPending) return 'chat ended';
      if (item.kind === 'needs_you' && c.live && c.working && c.lastTurnAt > item.updated_at + opts.resumeGraceMs) return 'chat picked back up';
      // Still sitting at its prompt (needs you) or still mid-turn (moving).
      if ((item.kind === 'needs_you' && c.live && !c.working) || (item.kind === 'moving' && c.live && c.working)) vouched = true;
    }
  }

  if (item.ref_type === 'pr' && item.ref_id) {
    const p = facts.pr(item.ref_id);
    if (p?.state === 'closed') return 'PR closed';
    if (p?.state === 'merged') {
      const landed = p.deploy === 'pass' || p.deploy === 'skipped';
      // A red or running deploy after the merge is still the item's business.
      if (landed || (item.kind === 'needs_you' && p.deploy !== 'fail' && p.deploy !== 'running')) return 'PR merged';
    }
  }

  if (item.ref_type === 'slack' && item.ref_id && facts.slack(item.ref_id) === 'done') return 'Slack thread done';

  if (drafts.length && !draftPending && item.kind === 'needs_you') {
    return drafts.every((s) => s === 'discarded' || s === 'superseded') ? 'draft discarded' : 'draft sent';
  }


  const max = item.kind === 'needs_you' ? opts.needsYouMaxMs : item.kind === 'blocked' ? opts.blockedMaxMs : opts.movingMaxMs;
  const idle = now - item.updated_at;
  if (!vouched && idle >= max) return `no update in ${ago(idle)}`;
  return '';
}

const titleKey = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);

/**
 * Open items that say the same thing as a newer one: the same ref (upsertItem keeps
 * one per ref, but an update by id can move an item onto another's ref), or the
 * same title. The most recently updated one stays.
 */
export function duplicates(items: OrchItem[]): Map<number, number> {
  const out = new Map<number, number>(); // dropped id -> kept id
  const open = items.filter((i) => !i.resolved_at && i.kind !== 'done').sort((a, b) => b.updated_at - a.updated_at || b.id - a.id);
  const byRef = new Map<string, number>();
  const byTitle = new Map<string, number>();
  for (const i of open) {
    const rk = i.ref_type && i.ref_id ? `${i.ref_type}|${i.ref_id}` : '';
    const tk = titleKey(i.title);
    const kept = (rk && byRef.get(rk)) || (tk && byTitle.get(tk));
    if (kept) {
      out.set(i.id, kept);
      continue;
    }
    if (rk) byRef.set(rk, i.id);
    if (tk) byTitle.set(tk, i.id);
  }
  return out;
}

/** Every open item to clear this pass, with the reason it shows under. */
export function sweepItems(items: OrchItem[], facts: SweepFacts, now: number, opts: SweepOpts = SWEEP): { id: number; title: string; why: string }[] {
  const dupes = duplicates(items);
  const out: { id: number; title: string; why: string }[] = [];
  for (const i of items) {
    if (i.resolved_at || i.kind === 'done') continue;
    const kept = dupes.get(i.id);
    const why = kept ? `duplicate of #${kept}` : staleWhy(i, facts, now, opts);
    if (why) out.push({ id: i.id, title: i.title, why });
  }
  return out;
}
