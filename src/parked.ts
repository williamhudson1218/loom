import type Database from 'better-sqlite3';
import { parseSlackThread } from './slackref.ts';
import type { Draft, SendResult } from './outbox.ts';

// Send & park. Will sends a message that puts the ball in someone else's court and
// does not want the chat on his plate until that person answers. The chat's pane is
// closed the way Save for later closes it, the chat is marked parked with what it
// waits on, and a read-only poller watches the thread (conversations.replies) for a
// post by anyone but Will. A reply moves the chat to Your turn with a "replied"
// badge. Slack thread ownership never changes: the chat keeps the thread.

export const PARKED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS parked_chats (
  agent         TEXT NOT NULL DEFAULT 'claude',
  session_id    TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'waiting',   -- waiting | replied
  draft_id      TEXT NOT NULL DEFAULT '',
  channel       TEXT NOT NULL,
  thread_ts     TEXT NOT NULL,
  thread_url    TEXT NOT NULL DEFAULT '',
  permalink     TEXT NOT NULL DEFAULT '',
  waiting_on    TEXT NOT NULL DEFAULT '[]',        -- JSON array of display names
  sent_ts       TEXT NOT NULL,                     -- Slack ts of what Will posted: replies must be later
  sent_at       INTEGER NOT NULL,
  parked_at     INTEGER NOT NULL,
  last_check_at INTEGER NOT NULL DEFAULT 0,
  replied_at    INTEGER NOT NULL DEFAULT 0,
  reply_user    TEXT NOT NULL DEFAULT '',
  reply_ts      TEXT NOT NULL DEFAULT '',
  reply_text    TEXT NOT NULL DEFAULT '',
  reply_count   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent, session_id)
);
`;

export interface ParkedRow {
  agent: string;
  session_id: string;
  state: 'waiting' | 'replied';
  draft_id: string;
  channel: string;
  thread_ts: string;
  thread_url: string;
  permalink: string;
  waiting_on: string[];
  sent_ts: string;
  sent_at: number;
  parked_at: number;
  last_check_at: number;
  replied_at: number;
  reply_user: string;
  reply_ts: string;
  reply_text: string;
  reply_count: number;
}

interface RawRow extends Omit<ParkedRow, 'waiting_on'> {
  waiting_on: string;
}

const hydrate = (r: RawRow): ParkedRow => {
  let w: string[] = [];
  try {
    w = JSON.parse(r.waiting_on);
  } catch {
    /* an empty list reads as "someone" */
  }
  return { ...r, waiting_on: Array.isArray(w) ? w : [] };
};

export function listParked(db: Database.Database): ParkedRow[] {
  return (db.prepare(`SELECT * FROM parked_chats ORDER BY sent_at DESC`).all() as RawRow[]).map(hydrate);
}

export function getParked(db: Database.Database, agent: string, sid: string): ParkedRow | undefined {
  const r = db.prepare(`SELECT * FROM parked_chats WHERE agent = ? AND session_id = ?`).get(agent, sid) as RawRow | undefined;
  return r ? hydrate(r) : undefined;
}

export interface ParkInput {
  agent: string;
  sessionId: string;
  draftId: string;
  channel: string;
  threadTs: string;
  threadUrl: string;
  permalink: string;
  waitingOn: string[];
  sentTs: string;
  sentAt: number;
}

export function parkChat(db: Database.Database, p: ParkInput, now: number = Date.now()): void {
  db.prepare(
    `INSERT OR REPLACE INTO parked_chats (agent, session_id, state, draft_id, channel, thread_ts, thread_url, permalink, waiting_on, sent_ts, sent_at, parked_at)
     VALUES (?, ?, 'waiting', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(p.agent, p.sessionId, p.draftId, p.channel, p.threadTs, p.threadUrl, p.permalink, JSON.stringify(p.waitingOn), p.sentTs, p.sentAt, now);
}

/** Remove the parked mark (manual unpark, or after a resume). True when a row was removed. */
export function unparkChat(db: Database.Database, agent: string, sid: string): boolean {
  return db.prepare(`DELETE FROM parked_chats WHERE agent = ? AND session_id = ?`).run(agent, sid).changes > 0;
}

/* ------------------------------------------------------------------ replies */

export interface SlackMsg {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
}

const NOT_A_REPLY = new Set(['bot_message', 'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'pinned_item']);

/**
 * Replies to a parked thread: messages later than what Will posted, from a human
 * other than Will. Will's own posts, bots/apps and join/leave notices do not count,
 * and neither does anything at or before sent_ts.
 */
export function repliesAfter(msgs: SlackMsg[], opts: { me: string; sentTs: string }): SlackMsg[] {
  const sent = Number(opts.sentTs);
  return msgs
    .filter((m) => Number(m.ts) > sent && !!m.user && m.user !== opts.me && !m.bot_id && !(m.subtype && NOT_A_REPLY.has(m.subtype)))
    .sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** First non-empty line of a Slack message, mentions flattened, trimmed for a row. */
export function firstLine(text: string, names: Record<string, string> = {}, max = 120): string {
  const line =
    String(text ?? '')
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? '';
  const flat = line
    .replace(/<@([A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, nm) => '@' + (names[id] || nm || 'someone'))
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<([^<>|]+)\|([^<>]*)>/g, '$2')
    .replace(/<([^<>]+)>/g, '$1')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat;
}

/** How long to wait before looking at a parked thread again: every 2 minutes at first, then backing off. */
export function checkDelayMs(sinceSentMs: number): number {
  const h = 3600_000;
  if (sinceSentMs < h) return 2 * 60_000;
  if (sinceSentMs < 6 * h) return 5 * 60_000;
  if (sinceSentMs < 24 * h) return 15 * 60_000;
  if (sinceSentMs < 72 * h) return 30 * 60_000;
  return 60 * 60_000;
}

export const isDue = (r: Pick<ParkedRow, 'sent_at' | 'last_check_at'>, now: number): boolean =>
  now - r.last_check_at >= checkDelayMs(now - r.sent_at);

/** "waiting on Jemelee · 2h" */
export function waitingLabel(r: Pick<ParkedRow, 'waiting_on' | 'sent_at'>, now: number): string {
  const who = r.waiting_on.length ? r.waiting_on.join(', ') : 'a reply';
  const m = Math.max(0, Math.round((now - r.sent_at) / 60_000));
  const ago = m < 60 ? `${m}m` : m < 60 * 24 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
  return `waiting on ${who} · ${ago}`;
}

/** The first prompt of a resumed chat: the new reply and where it lives. */
export function resumePrompt(r: ParkedRow): string {
  const who = r.reply_user || 'Someone';
  const link = r.reply_ts ? replyPermalink(r) : r.thread_url;
  return (
    `Loom: ${who} replied in the Slack thread you were waiting on. You sent a message there and this chat was parked until they answered.\n\n` +
    `Thread: ${link}\n\n` +
    `Their reply:\n${r.reply_text.split('\n').map((l) => '> ' + l).join('\n')}\n\n` +
    `Read the whole thread for anything after it (read-only), then carry on with what you were doing. Draft any answer for my approval as usual.`
  );
}

export function replyPermalink(r: Pick<ParkedRow, 'thread_url' | 'reply_ts' | 'thread_ts' | 'channel'>): string {
  if (!r.thread_url || !r.reply_ts) return r.thread_url;
  const base = r.thread_url.split('?')[0].replace(/\/p\d+$/, '');
  return `${base}/p${r.reply_ts.replace('.', '')}?thread_ts=${r.thread_ts}&cid=${r.channel}`;
}

/* --------------------------------------------------------------------- poll */

export interface PollDeps {
  me: string;
  replies: (channel: string, threadTs: string) => Promise<SlackMsg[]>;
  names?: Record<string, string>;
  notify: (title: string, body: string, target?: { agent: string; sid: string }) => void;
  /** Auto-resume setting on: reopen the chat in a managed pane. */
  autoResume?: boolean;
  resume?: (r: ParkedRow) => Promise<{ ok: boolean; detail: string }>;
  now?: number;
}

/** Look at every due parked thread once. Returns the chats that just got a reply. */
export async function pollParked(db: Database.Database, deps: PollDeps): Promise<ParkedRow[]> {
  const now = deps.now ?? Date.now();
  const hit: ParkedRow[] = [];
  for (const r of listParked(db).filter((x) => x.state === 'waiting')) {
    if (!isDue(r, now)) continue;
    db.prepare(`UPDATE parked_chats SET last_check_at = ? WHERE agent = ? AND session_id = ?`).run(now, r.agent, r.session_id);
    let msgs: SlackMsg[];
    try {
      msgs = await deps.replies(r.channel, r.thread_ts);
    } catch {
      continue; // read-only best effort; the next due tick retries
    }
    const rep = repliesAfter(msgs, { me: deps.me, sentTs: r.sent_ts });
    if (!rep.length) continue;
    const first = rep[0];
    const who = deps.names?.[first.user ?? ''] || first.user || 'Someone';
    db.prepare(
      `UPDATE parked_chats SET state = 'replied', replied_at = ?, reply_user = ?, reply_ts = ?, reply_text = ?, reply_count = ? WHERE agent = ? AND session_id = ?`,
    ).run(now, who, first.ts, String(first.text ?? '').trim(), rep.length, r.agent, r.session_id);
    const updated = getParked(db, r.agent, r.session_id)!;
    hit.push(updated);
    deps.notify(`${who} replied`, firstLine(first.text ?? '', deps.names), { agent: r.agent, sid: r.session_id });
    if (deps.autoResume && deps.resume) {
      try {
        const out = await deps.resume(updated);
        if (out.ok) unparkChat(db, r.agent, r.session_id);
      } catch {
        /* stays in Your turn with the Resume button */
      }
    }
  }
  return hit;
}

/* --------------------------------------------------------------- send & park */

export interface ParkSendDeps {
  readDraft: (id: string) => Draft | undefined;
  send: (id: string, messages: string[]) => Promise<SendResult>;
  /** Closing a chat's pane the way Save for later does. Absent pane = nothing to close. */
  closePane: (agent: string, sid: string) => { found: boolean; ok: boolean };
  names?: Record<string, string>;
  now?: number;
  agent?: string;
}

export interface ParkSendResult extends SendResult {
  parked?: boolean;
  closed?: boolean;
  waiting_on?: string[];
}

/** Who the message is addressed to: its <@U…> mentions, else the DM's other party. */
export function addresseesOf(messages: string[], channel: string, names: Record<string, string>): string[] {
  const ids: string[] = [];
  for (const m of messages) for (const x of m.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) if (!ids.includes(x[1])) ids.push(x[1]);
  const out = ids.map((id) => names[id] || id);
  if (!out.length && channel.startsWith('D') && names[channel]) out.push(names[channel]);
  return out;
}

/**
 * Post the draft through the normal send path, then park its chat. The post comes
 * first and is never undone: a failure to park or to close the pane reports itself
 * and leaves the message sent. A dry run posts nothing and parks nothing.
 */
export async function sendAndPark(db: Database.Database, id: string, messages: string[], deps: ParkSendDeps): Promise<ParkSendResult> {
  const d = deps.readDraft(id);
  if (!d) return { ok: false, detail: 'no such draft' };
  const r = await deps.send(id, messages);
  if (!r.ok || r.dry) return r;
  const agent = deps.agent ?? 'claude';
  const now = deps.now ?? Date.now();
  // The thread to watch: the one the draft replied into, else the thread the new post started.
  let channel = d.channel;
  let threadTs = d.thread_ts ?? '';
  let threadUrl = d.thread_url ?? '';
  let sentTs = '';
  const link = r.permalink ? parseSlackThread(r.permalink) : null;
  if (link) {
    sentTs = link.linkTs;
    if (!threadTs) {
      channel = link.channel;
      threadTs = link.ts;
      threadUrl = link.url;
    }
  }
  if (!threadTs) {
    return { ...r, parked: false, detail: r.detail + '; not parked: no thread to watch (record replies with --thread)' };
  }
  // No permalink to read the post's ts from: anything after "now" (minus clock slack) is a reply.
  if (!sentTs) sentTs = ((now - 5_000) / 1000).toFixed(6);
  parkChat(
    db,
    {
      agent,
      sessionId: d.session_id,
      draftId: id,
      channel,
      threadTs,
      threadUrl,
      permalink: r.permalink ?? '',
      waitingOn: addresseesOf(messages, d.channel, deps.names ?? {}),
      sentTs,
      sentAt: now,
    },
    now,
  );
  const c = deps.closePane(agent, d.session_id);
  return { ...r, parked: true, closed: c.found && c.ok, waiting_on: addresseesOf(messages, d.channel, deps.names ?? {}) };
}

/* ---------------------------------------------------------------- send & close */

/** What happens to the chat once the post has landed. */
export type AfterSend = 'none' | 'park' | 'close';

/** Grace added to a close mark so the pane's last transcript write does not count as new activity. */
export const CLOSE_GRACE_MS = 60_000;

/**
 * Take a chat off the board without losing it: the chat_hidden mark with via='close'.
 * History, search and Resume still see the chat (it comes back on its own once it
 * is active again); the board and the sidebar groups do not. Reversed by restoreChat.
 */
export function markChatDone(db: Database.Database, agent: string, sid: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO chat_hidden (agent, session_id, hidden_at, via) VALUES (?, ?, ?, 'close')
     ON CONFLICT(agent, session_id) DO UPDATE SET hidden_at = excluded.hidden_at, via = 'close'`,
  ).run(agent, sid, now + CLOSE_GRACE_MS);
}

/** Restore to board: drop a Send & close mark. A plain Remove-from-board mark is left alone. */
export function restoreChat(db: Database.Database, agent: string, sid: string): boolean {
  return db.prepare(`DELETE FROM chat_hidden WHERE agent = ? AND session_id = ? AND via = 'close'`).run(agent, sid).changes > 0;
}

/**
 * Post the draft, then end the chat: close its pane the Save-for-later way, mark it
 * done, and drop any reply watching. Slack thread ownership is untouched (slack_threads
 * keeps the chat), so the Slack hotkey still finds it. Post first, never undone; a
 * failed or dry post changes nothing.
 */
export async function sendAndClose(db: Database.Database, id: string, messages: string[], deps: ParkSendDeps): Promise<ParkSendResult & { done?: boolean }> {
  const d = deps.readDraft(id);
  if (!d) return { ok: false, detail: 'no such draft' };
  const r = await deps.send(id, messages);
  if (!r.ok || r.dry) return r;
  const agent = deps.agent ?? 'claude';
  unparkChat(db, agent, d.session_id);
  const c = deps.closePane(agent, d.session_id);
  markChatDone(db, agent, d.session_id, deps.now ?? Date.now());
  return { ...r, done: true, closed: c.found && c.ok };
}

/** One entry point for the three outcomes of the confirm step. */
export function sendThen(db: Database.Database, after: AfterSend, id: string, messages: string[], deps: ParkSendDeps): Promise<ParkSendResult & { done?: boolean }> {
  if (after === 'park') return sendAndPark(db, id, messages, deps);
  if (after === 'close') return sendAndClose(db, id, messages, deps);
  return deps.send(id, messages);
}
