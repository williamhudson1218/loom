import type Database from 'better-sqlite3';
import type { Agent } from './types.ts';
import { getSetting as resolveSetting } from './settingsSchema.ts';

// The orchestrator's data (design §8): the status items its rail renders, the log
// of what Loom did for it, relays to other chats (held while the user is looking at
// the target), and the events Loom pushes into its session. Everything here is
// either pure or takes its db / tmux effects as arguments, so the tests run
// against an in-memory db and fakes. The session itself is src/orchsession.ts.

/* ------------------------------------------------------------ settings */

export type NotifyMode = 'needs_you' | 'off';

function getSetting(db: Database.Database, key: string): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? '';
}

function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export const orchSettings = {
  sessionId: (db: Database.Database) => getSetting(db, 'orchestrator_session_id'),
  setSessionId: (db: Database.Database, id: string) => setSetting(db, 'orchestrator_session_id', id),
  paneId: (db: Database.Database) => getSetting(db, 'orchestrator_pane_id'),
  setPaneId: (db: Database.Database, id: string) => setSetting(db, 'orchestrator_pane_id', id),
  /**
   * On when `orchestrator_enabled` is '1'. Unset reads '1' on an install from before
   * settings schema 2 (it always ran) and '0' on a new one (opt-in). $LOOM_ORCHESTRATOR
   * overrides either way.
   */
  enabled: (db: Database.Database, env: NodeJS.ProcessEnv = process.env) =>
    resolveSetting(db, 'orchestrator_enabled', { env }) === '1',
  notify: (db: Database.Database): NotifyMode => (getSetting(db, 'orchestrator_notify') === 'off' ? 'off' : 'needs_you'),
  setNotify: (db: Database.Database, m: NotifyMode) => setSetting(db, 'orchestrator_notify', m),
};

/* ------------------------------------------------------------ items */

export const ITEM_KINDS = ['needs_you', 'blocked', 'moving', 'done'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];
export const REF_TYPES = ['chat', 'pr', 'slack', ''] as const;
export type RefType = (typeof REF_TYPES)[number];

export interface OrchItem {
  id: number;
  kind: ItemKind;
  ref_type: RefType;
  ref_id: string;
  title: string;
  why: string;
  who: string; // blocked: who it waits on; moving: the agent's pane name
  opened_at: number;
  updated_at: number;
  resolved_at: number;
  resolved_why: string; // '' when Will or the orchestrator closed it; Loom's reason when the sweep did
}

export interface ItemInput {
  id?: number;
  kind: ItemKind;
  ref_type?: RefType;
  ref_id?: string;
  title: string;
  why?: string;
  who?: string;
}

export const isItemKind = (v: unknown): v is ItemKind => typeof v === 'string' && (ITEM_KINDS as readonly string[]).includes(v);
export const isRefType = (v: unknown): v is RefType => typeof v === 'string' && (REF_TYPES as readonly string[]).includes(v);

const clip = (s: string | undefined, n: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * Insert or update one item. An id updates that row. Otherwise an OPEN item with
 * the same ref is updated in place (one open item per chat / PR / thread), and
 * anything else is a new row. Marking an item 'done' also resolves it, so the
 * rail's Done today list is "resolved today, kind done".
 * `becameNeedsYou` is true when this write is what put the item into needs_you:
 * the trigger for a notification.
 */
export function upsertItem(db: Database.Database, input: ItemInput, now: number): { item: OrchItem; created: boolean; becameNeedsYou: boolean } {
  const refType = input.ref_type ?? '';
  const refId = clip(input.ref_id, 500);
  const fields = { kind: input.kind, title: clip(input.title, 200), why: clip(input.why, 600), who: clip(input.who, 80) };
  const resolvedAt = input.kind === 'done' ? now : 0;
  let prev: OrchItem | undefined;
  if (input.id) prev = db.prepare(`SELECT * FROM orchestrator_items WHERE id = ?`).get(input.id) as OrchItem | undefined;
  else if (refType && refId) {
    prev = db
      .prepare(`SELECT * FROM orchestrator_items WHERE ref_type = ? AND ref_id = ? AND resolved_at = 0 ORDER BY id DESC LIMIT 1`)
      .get(refType, refId) as OrchItem | undefined;
  }
  if (input.id && !prev) throw new Error(`no item ${input.id}`);
  if (prev) {
    db.prepare(
      `UPDATE orchestrator_items SET kind = ?, ref_type = ?, ref_id = ?, title = ?, why = ?, who = ?, updated_at = ?, resolved_at = ?, resolved_why = '' WHERE id = ?`,
    ).run(fields.kind, input.ref_type ?? prev.ref_type, input.ref_id !== undefined ? refId : prev.ref_id, fields.title || prev.title, fields.why, fields.who, now, resolvedAt, prev.id);
    const item = db.prepare(`SELECT * FROM orchestrator_items WHERE id = ?`).get(prev.id) as OrchItem;
    return { item, created: false, becameNeedsYou: item.kind === 'needs_you' && (prev.kind !== 'needs_you' || prev.resolved_at !== 0) };
  }
  const id = Number(
    db
      .prepare(`INSERT INTO orchestrator_items (kind, ref_type, ref_id, title, why, who, opened_at, updated_at, resolved_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(fields.kind, refType, refId, fields.title, fields.why, fields.who, now, now, resolvedAt).lastInsertRowid,
  );
  const item = db.prepare(`SELECT * FROM orchestrator_items WHERE id = ?`).get(id) as OrchItem;
  return { item, created: true, becameNeedsYou: item.kind === 'needs_you' };
}

/** Close an item. Resolving never changes its kind: a resolved needs_you item just leaves the rail. */
export function resolveItem(db: Database.Database, id: number, now: number, why = ''): OrchItem | null {
  const changed = db
    .prepare(`UPDATE orchestrator_items SET resolved_at = ?, updated_at = ?, resolved_why = ? WHERE id = ? AND resolved_at = 0`)
    .run(now, now, why.slice(0, 200), id).changes;
  if (!changed) return null;
  return db.prepare(`SELECT * FROM orchestrator_items WHERE id = ?`).get(id) as OrchItem;
}

/** Open items, plus anything resolved since `resolvedSince` (0 = open only). */
export function listItems(db: Database.Database, resolvedSince = 0): OrchItem[] {
  return db
    .prepare(
      `SELECT * FROM orchestrator_items WHERE resolved_at = 0 OR (? > 0 AND resolved_at >= ?) ORDER BY resolved_at != 0, opened_at DESC`,
    )
    .all(resolvedSince, resolvedSince) as OrchItem[];
}

export function needsYouCount(db: Database.Database): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM orchestrator_items WHERE kind = 'needs_you' AND resolved_at = 0`).get() as { n: number }).n;
}

/** The start of "today" in local time, for the Done today list. */
export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ------------------------------------------------------------ log */

export type LogKind = 'relay' | 'queued' | 'delivered' | 'failed' | 'events' | 'ask' | 'started' | 'cleared';

export interface LogRow {
  id: number;
  at: number;
  kind: LogKind;
  target: string;
  text: string;
}

export function logOrch(db: Database.Database, kind: LogKind, target: string, text: string, now: number): void {
  db.prepare(`INSERT INTO orchestrator_log (at, kind, target, text) VALUES (?, ?, ?, ?)`).run(now, kind, target, text.slice(0, 2000));
  // A rolling window: the log is an echo for the UI, not an archive.
  db.prepare(`DELETE FROM orchestrator_log WHERE id <= (SELECT MAX(id) FROM orchestrator_log) - 500`).run();
}

export function recentLog(db: Database.Database, since: number): LogRow[] {
  return db.prepare(`SELECT * FROM orchestrator_log WHERE at >= ? ORDER BY id`).all(since) as LogRow[];
}

/* ------------------------------------------------------------ notifications */

// A new needs_you item is the only thing that notifies. The real phone path is
// Remote Control (the user sees the orchestrator's own message there); Loom adds a
// macOS notification on the Mac. The Electron app swaps in a clickable one.
export type Notifier = (item: OrchItem) => void;
let notifier: Notifier = () => {};
export function setOrchNotifier(fn: Notifier): void {
  notifier = fn;
}
export function notifyNeedsYou(db: Database.Database, item: OrchItem): boolean {
  if (orchSettings.notify(db) === 'off') return false;
  try {
    notifier(item);
  } catch {
    /* a notification must never fail the write */
  }
  return true;
}

/* ------------------------------------------------------------ relays */

export interface ChatTarget {
  agent: Agent;
  session_id: string;
  pane_id: string;
  label: string; // pane name or title, for the log
}

export interface RelayDeps {
  /** The pane the user is looking at right now (compact.focusedPaneFrom). */
  focused: () => string | null;
  /** The chat's live pane, resolved at send time: compaction can move a chat. */
  resolve: (agent: Agent, sessionId: string) => ChatTarget | null;
  send: (paneId: string, text: string, agent: Agent) => { ok: boolean; detail: string };
  now: () => number;
}

export type RelayResult =
  | { status: 'sent'; detail: string }
  | { status: 'queued'; detail: string; id: number }
  | { status: 'failed'; detail: string };

export const RELAY_PREFIX = '[from the Loom orchestrator]';

/**
 * Relay a message into another chat. Never types into the pane the user is focused
 * on: that message is queued and goes out once he leaves it (deliverQueued). Both
 * outcomes are logged, so the orchestrator view echoes every relay.
 */
export function relayToChat(db: Database.Database, deps: RelayDeps, agent: Agent, sessionId: string, text: string): RelayResult {
  const body = text.replace(/\s+/g, ' ').trim();
  if (!body) return { status: 'failed', detail: 'empty message' };
  const t = deps.resolve(agent, sessionId);
  const now = deps.now();
  if (!t) {
    logOrch(db, 'failed', `${agent}:${sessionId}`, body, now);
    return { status: 'failed', detail: 'that chat is not running; it has no pane to type into' };
  }
  const msg = `${RELAY_PREFIX} ${body}`;
  if (deps.focused() === t.pane_id) {
    const id = Number(
      db
        .prepare(`INSERT INTO orchestrator_outbox (agent, session_id, label, text, queued_at) VALUES (?, ?, ?, ?, ?)`)
        .run(agent, sessionId, t.label, msg, now).lastInsertRowid,
    );
    logOrch(db, 'queued', t.label, body, now);
    return { status: 'queued', id, detail: `${t.label} is the pane the user is looking at; queued, it goes out when they leave it` };
  }
  const r = deps.send(t.pane_id, msg, agent);
  logOrch(db, r.ok ? 'relay' : 'failed', t.label, body, now);
  return r.ok ? { status: 'sent', detail: `sent to ${t.label}` } : { status: 'failed', detail: r.detail };
}

export interface OutboxRow {
  id: number;
  agent: Agent;
  session_id: string;
  label: string;
  text: string;
  queued_at: number;
}

export function queuedRelays(db: Database.Database): OutboxRow[] {
  return db.prepare(`SELECT * FROM orchestrator_outbox WHERE status = 'queued' ORDER BY id`).all() as OutboxRow[];
}

// A relay queued this long ago is stale: the situation it was about has moved on.
export const OUTBOX_TTL_MS = 6 * 3_600_000;

/** Deliver every queued relay whose pane the user is no longer focused on. Returns how many went out. */
export function deliverQueued(db: Database.Database, deps: RelayDeps): number {
  const rows = queuedRelays(db);
  if (!rows.length) return 0;
  const focused = deps.focused();
  const now = deps.now();
  let sent = 0;
  const mark = db.prepare(`UPDATE orchestrator_outbox SET status = ?, delivered_at = ?, detail = ? WHERE id = ?`);
  for (const r of rows) {
    if (now - r.queued_at > OUTBOX_TTL_MS) {
      mark.run('expired', now, 'queued too long', r.id);
      logOrch(db, 'failed', r.label, 'expired before delivery: ' + r.text, now);
      continue;
    }
    const t = deps.resolve(r.agent, r.session_id);
    if (!t) {
      mark.run('failed', now, 'chat no longer running', r.id);
      logOrch(db, 'failed', r.label, 'chat stopped before delivery: ' + r.text, now);
      continue;
    }
    if (t.pane_id === focused) continue; // still looking at it
    const res = deps.send(t.pane_id, r.text, r.agent);
    mark.run(res.ok ? 'delivered' : 'failed', now, res.detail, r.id);
    logOrch(db, res.ok ? 'delivered' : 'failed', t.label, r.text.replace(RELAY_PREFIX, '').trim(), now);
    if (res.ok) sent++;
  }
  return sent;
}

/* ------------------------------------------------------------ event detection */

export const SILENT_MS = 15 * 60_000;

export interface ChatObs {
  key: string; // agent:session_id
  title: string;
  name: string; // pane name, '' when unnamed
  project: string;
  live: boolean;
  working: boolean;
  lastWriteAt: number; // transcript mtime
  pr?: { ref: string; checks: string; review: string }; // pipeline step states ('' when unknown)
}

export type OrchEventKind = 'your_turn' | 'silent' | 'pr_checks' | 'pr_review';

export interface OrchEvent {
  key: string; // dedupe key: one pending event per key
  kind: OrchEventKind;
  chat: string;
  text: string;
  at: number;
}

interface ChatMemo {
  working: boolean;
  silentFired: boolean;
}

export interface ObsState {
  chats: Map<string, ChatMemo>;
  prs: Map<string, { checks: string; review: string }>;
}

export const newObsState = (): ObsState => ({ chats: new Map(), prs: new Map() });

const label = (o: ChatObs) => `"${o.title || 'untitled'}"${o.name ? ' · ' + o.name : ''}${o.project ? ' · ' + o.project : ''} (${o.key})`;

/**
 * One tick's transitions. Pure apart from updating `state`. The first sighting of
 * a chat or PR only records it: an event is a CHANGE Loom saw, never a state it
 * found on startup. Returns the events to batch, and the keys whose pending
 * your-turn event should be cancelled (the chat went back to work before the
 * batch went out, so the turn ended was a pause between tool calls).
 */
export function detectEvents(state: ObsState, obs: ChatObs[], now: number, silentMs = SILENT_MS): { events: OrchEvent[]; cancel: string[] } {
  const events: OrchEvent[] = [];
  const cancel: string[] = [];
  const seen = new Set<string>();
  for (const o of obs) {
    seen.add(o.key);
    const prev = state.chats.get(o.key);
    const cur: ChatMemo = { working: o.live && o.working, silentFired: prev?.silentFired ?? false };
    if (prev) {
      if (prev.working && o.live && !o.working) {
        events.push({ key: `your_turn:${o.key}`, kind: 'your_turn', chat: o.key, at: now, text: `your turn: ${label(o)} finished its turn and is waiting` });
      }
      if (!prev.working && cur.working) cancel.push(`your_turn:${o.key}`);
    }
    const quiet = now - o.lastWriteAt;
    if (cur.working && quiet >= silentMs) {
      if (!cur.silentFired) {
        cur.silentFired = true;
        events.push({ key: `silent:${o.key}`, kind: 'silent', chat: o.key, at: now, text: `silent: ${label(o)} is mid-turn but has written nothing for ${Math.round(quiet / 60_000)} min` });
      }
    } else {
      cur.silentFired = false;
    }
    state.chats.set(o.key, cur);
    if (o.pr) {
      const p = state.prs.get(o.pr.ref);
      if (p) {
        if (o.pr.checks !== p.checks && (o.pr.checks === 'fail' || o.pr.checks === 'pass')) {
          events.push({ key: `pr_checks:${o.pr.ref}`, kind: 'pr_checks', chat: o.key, at: now, text: `PR ${o.pr.ref} checks ${o.pr.checks === 'fail' ? 'went red' : 'went green'} (chat ${label(o)})` });
        }
        if (o.pr.review !== p.review && (o.pr.review === 'pass' || o.pr.review === 'fail')) {
          events.push({ key: `pr_review:${o.pr.ref}`, kind: 'pr_review', chat: o.key, at: now, text: `PR ${o.pr.ref} review landed: ${o.pr.review === 'pass' ? 'approved' : 'changes requested'} (chat ${label(o)})` });
        }
      }
      state.prs.set(o.pr.ref, { checks: o.pr.checks, review: o.pr.review });
    }
  }
  for (const k of [...state.chats.keys()]) if (!seen.has(k)) state.chats.delete(k);
  return { events, cancel };
}

/* ------------------------------------------------------------ batching */

export interface BatchOpts {
  quietMs: number; // flush once nothing new arrived for this long
  maxWaitMs: number; // ...or once the oldest pending event is this old
  maxPending: number;
}

export const DEFAULT_BATCH: BatchOpts = { quietMs: 20_000, maxWaitMs: 90_000, maxPending: 40 };

/**
 * Debounces events into one message. One pending event per key (the newest
 * wins), so a chat that flips twice inside a window is one line, not two.
 */
export class EventBatcher {
  private pending = new Map<string, OrchEvent>();
  private firstAt = 0;
  private lastAt = 0;
  constructor(private opts: BatchOpts = DEFAULT_BATCH) {}

  add(ev: OrchEvent, now: number): void {
    if (!this.pending.size) this.firstAt = now;
    this.pending.delete(ev.key); // re-insert so order follows the latest sighting
    this.pending.set(ev.key, ev);
    this.lastAt = now;
    while (this.pending.size > this.opts.maxPending) this.pending.delete(this.pending.keys().next().value as string);
  }

  cancel(key: string): void {
    this.pending.delete(key);
  }

  size(): number {
    return this.pending.size;
  }

  due(now: number): boolean {
    if (!this.pending.size) return false;
    return now - this.lastAt >= this.opts.quietMs || now - this.firstAt >= this.opts.maxWaitMs;
  }

  take(): OrchEvent[] {
    const out = [...this.pending.values()];
    this.pending.clear();
    return out;
  }
}

export const EVENTS_PREFIX = '[Loom events]';

/** The message Loom types into the orchestrator. One line: sendToPane flattens newlines anyway. */
export function formatEventBatch(events: OrchEvent[], now: number): string {
  const t = new Date(now);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  const lines = events.map((e, i) => `(${i + 1}) ${e.text}`).join(' ');
  return `${EVENTS_PREFIX} ${hhmm}, ${events.length} change${events.length === 1 ? '' : 's'}: ${lines} -- Update the items to match (chat_tail for detail). Message the user only if something now needs them.`;
}
