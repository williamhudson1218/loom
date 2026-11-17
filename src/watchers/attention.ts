import type Database from 'better-sqlite3';
import { listWatchers, unreviewedCounts } from './model.ts';
import { standingRefs } from '../standingchats.ts';
import { agentSessionKey } from '../placements.ts';

// When a watcher needs you, for the tray count and the notification (the Watchers
// tab applies the same rule in the page: watcherview.ts wvNeeds). A watcher needs
// you when its standing chat is on your turn, or (while it is on) it has Shadow
// matches to review or its last poll failed. A standing chat on your turn counts
// here, once, as its watcher: the tray leaves standing chats out of the plain
// your-turn count so nothing is counted twice.

export type NeedReason = 'turn' | 'review' | 'error';

export interface WatcherNeed {
  id: string;
  label: string;
  reasons: NeedReason[];
  review: number;
}

export interface NeedFacts {
  enabled: boolean;
  turn: boolean;
  review: number;
  error: boolean;
}

/** The reasons, in the order they are shown: your turn, matches to review, poll error. */
export function needReasons(f: NeedFacts): NeedReason[] {
  const out: NeedReason[] = [];
  if (f.turn) out.push('turn');
  if (f.enabled && f.review > 0) out.push('review');
  if (f.enabled && f.error) out.push('error');
  return out;
}

/** "Work PM: your turn", "Slack #filings: 3 matches to review", "Audit findings: poll error". */
export function needText(n: Pick<WatcherNeed, 'label' | 'reasons' | 'review'>): string {
  const words = n.reasons.map((r) => (r === 'turn' ? 'your turn' : r === 'review' ? `${n.review} ${n.review === 1 ? 'match' : 'matches'} to review` : 'poll error'));
  return `${n.label}: ${words.join(', ')}`;
}

/** Every watcher that needs you now. `isLive` is keyed agent:session_id, like the board's live map. */
export function watcherNeeds(
  db: Database.Database,
  views: { agent: string; session_id: string; state?: string }[],
  isLive: (key: string) => boolean,
): WatcherNeed[] {
  const refs = standingRefs(db);
  const turn = new Set<string>();
  for (const v of views) {
    if (v.agent !== 'claude' || v.state !== 'waiting_on_user') continue;
    const ref = refs.get(v.session_id);
    if (ref && isLive(agentSessionKey(v.agent, v.session_id))) turn.add(ref.watcher_id);
  }
  const counts = unreviewedCounts(db).byWatcher;
  const out: WatcherNeed[] = [];
  for (const w of listWatchers(db)) {
    const review = counts[w.id] ?? 0;
    const reasons = needReasons({ enabled: w.enabled, turn: turn.has(w.id), review, error: !!w.poll.last_error });
    if (reasons.length) out.push({ id: w.id, label: w.label, reasons, review });
  }
  return out;
}

/**
 * The watchers that moved INTO needs-you since the last check. The first check
 * only records what is true (no notification storm when Loom starts), and a
 * watcher that stays in needs-you, even with a new reason, is not reported again.
 */
export function enteringNeeds(prev: Set<string> | null, now: WatcherNeed[]): { entered: WatcherNeed[]; next: Set<string> } {
  const next = new Set(now.map((n) => n.id));
  if (!prev) return { entered: [], next };
  return { entered: now.filter((n) => !prev.has(n.id)), next };
}
