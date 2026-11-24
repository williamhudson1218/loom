import type Database from 'better-sqlite3';
import type { ChatView, LiveLoc } from './dashboard.ts';
import { agentSessionKey } from './placements.ts';

// Standing watcher chats. A start_chat watcher with `standing` keeps ONE
// long-lived chat and feeds it batches (src/watchers/engine.ts drainStanding).
// That chat is the watcher's, not one of the user's working chats: it is kept
// off the Board, the chat list and Home, and shown on the Watchers tab instead.
//
// A chat is a standing chat when its session id is a watcher's current
// `standing_sid`, or a session a standing watcher started earlier (recorded on
// the event it was started for, watcher_events.session_id) and replaced since.
// Watcher chats are always Claude chats (the engine starts and relays to 'claude').

export interface StandingRef {
  watcher_id: string;
  label: string;
  /** True for the watcher's current standing_sid, false for a replaced one. */
  current: boolean;
}

export interface StandingChat extends StandingRef {
  chat: ChatView;
}

/** Every session id that is (or was) a standing watcher chat -> its watcher. */
export function standingRefs(db: Database.Database): Map<string, StandingRef> {
  const out = new Map<string, StandingRef>();
  try {
    const past = db
      // Only a standing watcher's sessions: a per-match start_chat records its
      // session on the event too, and that chat is an ordinary chat on the Board.
      .prepare(
        `SELECT DISTINCT e.session_id AS sid, w.id AS id, w.label AS label FROM watcher_events e JOIN watchers w ON w.id = e.watcher_id
         WHERE e.session_id != '' AND w.action_kind = 'start_chat' AND json_extract(w.action_params, '$.standing') = 1`,
      )
      .all() as { sid: string; id: string; label: string }[];
    for (const r of past) out.set(r.sid, { watcher_id: r.id, label: r.label, current: false });
  } catch {
    /* a table without the column yet: the current ones below still count */
  }
  try {
    const cur = db.prepare(`SELECT id, label, standing_sid AS sid FROM watchers WHERE standing_sid != ''`).all() as { sid: string; id: string; label: string }[];
    for (const r of cur) out.set(r.sid, { watcher_id: r.id, label: r.label, current: true });
  } catch {
    /* no watchers table: nothing is a standing chat */
  }
  return out;
}

/** Is this chat (or live session) a standing watcher chat? */
export function isStandingChat(refs: Map<string, StandingRef>, c: { agent: string; session_id: string }): boolean {
  return c.agent === 'claude' && refs.has(c.session_id);
}

/**
 * Split the board's rows: `board` without any standing chat (live or not), and
 * `standing`, the standing chats that are running now, the current one of each
 * watcher before any replaced one that is still alive.
 */
export function splitStanding(views: ChatView[], live: Record<string, LiveLoc>, refs: Map<string, StandingRef>): { board: ChatView[]; standing: StandingChat[] } {
  if (!refs.size) return { board: views, standing: [] };
  const board: ChatView[] = [];
  const standing: StandingChat[] = [];
  for (const v of views) {
    if (!isStandingChat(refs, v)) {
      board.push(v);
      continue;
    }
    if (live[agentSessionKey(v.agent, v.session_id)]) standing.push({ ...refs.get(v.session_id)!, chat: v });
  }
  standing.sort((a, b) => a.watcher_id.localeCompare(b.watcher_id) || Number(b.current) - Number(a.current) || (b.chat.last_active_at || 0) - (a.chat.last_active_at || 0));
  return { board, standing };
}
