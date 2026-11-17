import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Applied } from './events.ts';
import { parsePrRef } from './prref.ts';
import { parseSlackThread } from './slackref.ts';

// Action items: a per-chat chain of steps, each a trigger and an action. This
// file is storage and grammar only; the evaluator that fires steps lives apart.

export type TriggerType = 'now' | 'manual' | 'pr_merged' | 'pr_shipped' | 'slack_reply' | 'draft_sent' | 'clock';
export type ActionType = 'none' | 'send_draft' | 'wake_chat';
export type StepStatus = 'waiting' | 'due' | 'running' | 'held' | 'done' | 'failed' | 'removed';

export interface ActionItem {
  id: string;
  session_id: string;
  position: number;
  title: string;
  trigger_type: TriggerType;
  trigger_params: Record<string, unknown>;
  action_type: ActionType;
  action_params: Record<string, unknown>;
  ask_first: boolean;
  status: StepStatus;
  status_why: string;
  created_by: 'chat' | 'user';
  created_at: number;
  current_at: number;
  fired_at: number;
  done_at: number;
  attempts: number;
  held_rev: string;
  /** ms: when a hold asked the chat to redraft (0 for any other hold). Only a redraft kept after this sends. */
  held_at: number;
  /** The draft revision a person clicked Run on. The approval covers only that text. */
  approved_rev: string;
  removed_from: StepStatus | '';
}

export const ACTIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS action_items (
  id             TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL,
  position       INTEGER NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  trigger_type   TEXT NOT NULL DEFAULT 'manual',
  trigger_params TEXT NOT NULL DEFAULT '{}',
  action_type    TEXT NOT NULL DEFAULT 'none',
  action_params  TEXT NOT NULL DEFAULT '{}',
  ask_first      INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'waiting',
  status_why     TEXT NOT NULL DEFAULT '',
  created_by     TEXT NOT NULL DEFAULT 'chat',
  created_at     INTEGER NOT NULL DEFAULT 0,
  current_at     INTEGER NOT NULL DEFAULT 0,
  fired_at       INTEGER NOT NULL DEFAULT 0,
  done_at        INTEGER NOT NULL DEFAULT 0,
  attempts       INTEGER NOT NULL DEFAULT 0,
  held_rev       TEXT NOT NULL DEFAULT '',
  removed_from   TEXT NOT NULL DEFAULT '',
  held_at        INTEGER NOT NULL DEFAULT 0,
  approved_rev   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS action_items_session_idx ON action_items(session_id, position);

CREATE TABLE IF NOT EXISTS action_chats (
  session_id      TEXT PRIMARY KEY,
  close_when_done INTEGER NOT NULL DEFAULT 0,
  closed_at       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS action_verdicts (
  key    TEXT PRIMARY KEY,
  state  TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  at     INTEGER NOT NULL
);
`;

/** Columns added after action_items first shipped. */
export function ensureActionColumns(db: Database.Database): void {
  const have = new Set((db.prepare(`PRAGMA table_info(action_items)`).all() as { name: string }[]).map((c) => c.name));
  if (!have.has('held_at')) db.exec(`ALTER TABLE action_items ADD COLUMN held_at INTEGER NOT NULL DEFAULT 0`);
  if (!have.has('approved_rev')) db.exec(`ALTER TABLE action_items ADD COLUMN approved_rev TEXT NOT NULL DEFAULT ''`);
}

export function newStepId(): string {
  return 'a' + crypto.randomBytes(6).toString('hex');
}

const DRAFT_ID_RE = /^d[0-9a-f]{11,13}$/;
const REF_RE = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/;

type Parsed<T> = { type: T; params: Record<string, unknown> } | { error: string };

function prParams(ref: string): Record<string, unknown> | null {
  const m = REF_RE.exec(ref);
  if (m) return { repo: m[1], number: Number(m[2]) };
  if (/^https?:\/\//.test(ref)) return parsePrRef(ref);
  return null;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "7:00am Tue Nov 17", in this machine's timezone. Stored on the step so every surface shows the same time. */
export function clockLabel(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(d.getMinutes()).padStart(2, '0')}${h < 12 ? 'am' : 'pm'} ${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

/**
 * `at:` resolves to one instant at add time, in this machine's timezone: a time of day (07:00, 7am, 7:30pm)
 * is its next occurrence after `now`; a local date-time (2026-11-17T07:00) or an ISO instant with Z or an
 * offset is taken as written and must be in the future.
 */
export function parseClock(rest: string, now: number): { at: number; label: string } | { error: string } {
  const r = rest.trim().toLowerCase();
  const tod = /^(\d{1,2}):(\d{2})$/.exec(r) ?? /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/.exec(r);
  if (tod) {
    let h = Number(tod[1]);
    const m = Number(tod[2] ?? 0);
    const ap = tod[3];
    if (ap) {
      if (h < 1 || h > 12) return { error: `at: ${rest} is not a time` };
      h = (h % 12) + (ap === 'pm' ? 12 : 0);
    }
    if (h > 23 || m > 59) return { error: `at: ${rest} is not a time` };
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= now) d.setDate(d.getDate() + 1); // setDate keeps the wall time across a DST change
    return { at: d.getTime(), label: clockLabel(d.getTime()) };
  }
  const local = /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(r);
  let at = NaN;
  if (local) {
    const [y, mo, da, h, mi, se] = local.slice(1).map((x) => Number(x ?? 0));
    const d = new Date(y, mo - 1, da, h, mi, se || 0, 0);
    if (d.getMonth() === mo - 1 && d.getDate() === da && d.getHours() === h && d.getMinutes() === mi) at = d.getTime();
  } else if (/^\d{4}-\d{2}-\d{2}t\d{2}:\d{2}(:\d{2}(\.\d+)?)?(z|[+-]\d{2}:?\d{2})$/.test(r)) {
    at = Date.parse(rest.trim());
  }
  if (!Number.isFinite(at)) return { error: 'at: needs a time like 07:00 or 7am, or a date-time like 2026-11-17T07:00' };
  if (at <= now) return { error: `at: ${rest.trim()} is in the past` };
  return { at, label: clockLabel(at) };
}

/** The `--when` grammar. TypeScript is the authority; the plugin only checks the prefix. `now` resolves `at:`. */
export function parseWhen(s: string, now: number = Date.now()): Parsed<TriggerType> {
  const spec = (s ?? '').trim();
  if (spec === 'now' || spec === 'manual') return { type: spec, params: {} };
  const colon = spec.indexOf(':');
  const head = colon < 0 ? spec : spec.slice(0, colon);
  const rest = colon < 0 ? '' : spec.slice(colon + 1).trim();
  if (head === 'pr-merged' || head === 'pr-shipped') {
    const params = prParams(rest);
    if (!params) return { error: `${head} needs owner/repo#number or a GitHub pull request URL` };
    return { type: head === 'pr-merged' ? 'pr_merged' : 'pr_shipped', params };
  }
  if (head === 'slack-reply') {
    const comma = rest.indexOf(',');
    const url = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    const ref = parseSlackThread(url);
    if (!ref) return { error: 'slack-reply needs a Slack thread URL' };
    const params: Record<string, unknown> = { thread_url: ref.url, channel: ref.channel, thread_ts: ref.ts };
    let tail = comma < 0 ? '' : rest.slice(comma + 1);
    // answers= runs to the end of the string, commas included, so it comes last.
    const ai = tail.startsWith('answers=') ? 0 : tail.indexOf(',answers=');
    if (ai >= 0) {
      const from = ai === 0 ? '' : tail.slice(0, ai);
      const answers = tail.slice(ai === 0 ? 8 : ai + 9).trim();
      tail = from;
      if (answers) params.answers = answers;
    }
    if (tail.trim()) {
      if (!tail.startsWith('from=')) return { error: `slack-reply: unknown option ${JSON.stringify(tail.split('=')[0])} (use from= and answers=)` };
      const from = tail.slice(5).trim();
      if (from) params.from = from;
    }
    return { type: 'slack_reply', params };
  }
  if (head === 'draft-sent') {
    if (!DRAFT_ID_RE.test(rest)) return { error: 'draft-sent needs a draft id like d0123456789ab' };
    return { type: 'draft_sent', params: { draft_id: rest } };
  }
  if (head === 'at') {
    const c = parseClock(rest, now);
    if ('error' in c) return c;
    return { type: 'clock', params: c };
  }
  return { error: 'expected now, manual, at:, pr-merged:, pr-shipped:, slack-reply: or draft-sent:' };
}

/** The `--then` grammar. */
export function parseThen(s: string): Parsed<ActionType> {
  const spec = (s ?? '').trim();
  if (spec === 'none') return { type: 'none', params: {} };
  const colon = spec.indexOf(':');
  const head = colon < 0 ? spec : spec.slice(0, colon);
  const rest = colon < 0 ? '' : spec.slice(colon + 1).trim();
  if (head === 'send-draft') {
    if (!DRAFT_ID_RE.test(rest)) return { error: 'send-draft needs a draft id like d0123456789ab' };
    return { type: 'send_draft', params: { draft_id: rest } };
  }
  if (head === 'wake') {
    const q = /^"([\s\S]*)"$/.exec(rest);
    const instruction = (q ? q[1] : rest).trim();
    if (!instruction) return { error: 'wake needs an instruction' };
    return { type: 'wake_chat', params: { instruction } };
  }
  return { error: 'expected send-draft:<id>, wake:"<instruction>" or none' };
}

interface Row extends Omit<ActionItem, 'trigger_params' | 'action_params' | 'ask_first'> {
  trigger_params: string;
  action_params: string;
  ask_first: number;
}

function json(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toItem(r: Row): ActionItem {
  return { ...r, trigger_params: json(r.trigger_params), action_params: json(r.action_params), ask_first: !!r.ask_first };
}

export function addStep(
  db: Database.Database,
  input: { id: string; session_id: string; title: string; when: string; then: string; ask_first: boolean; created_by: 'chat' | 'user'; at: number },
): Applied {
  if (!input.id || !input.session_id) return { ok: false, detail: 'id and session are required' };
  if (db.prepare(`SELECT 1 FROM action_items WHERE id = ?`).get(input.id)) return { ok: true, detail: 'exists' };
  const w = parseWhen(input.when, input.at);
  const t = parseThen(input.then);
  const why: string[] = [];
  if ('error' in w) why.push(`couldn't read --when '${input.when}': ${w.error}`);
  if ('error' in t) why.push(`couldn't read --then '${input.then}': ${t.error}`);
  const when = 'error' in w ? { type: 'manual' as TriggerType, params: {} } : w;
  const then = 'error' in t ? { type: 'none' as ActionType, params: {} } : t;
  const pos = (db.prepare(`SELECT COALESCE(MAX(position), 0) AS p FROM action_items WHERE session_id = ?`).get(input.session_id) as { p: number }).p + 1;
  db.prepare(
    `INSERT INTO action_items (id, session_id, position, title, trigger_type, trigger_params, action_type, action_params, ask_first,
       status, status_why, created_by, created_at, current_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id, input.session_id, pos, input.title, when.type, JSON.stringify(when.params), then.type, JSON.stringify(then.params),
    input.ask_first ? 1 : 0, why.length ? 'failed' : 'waiting', why.join('; '), input.created_by, input.at, 0,
  );
  // A new step reopens the chain: close-when-done may close the chat again once it is done too.
  db.prepare(`UPDATE action_chats SET closed_at = 0 WHERE session_id = ?`).run(input.session_id);
  return { ok: true, detail: 'added' };
}

export function listSteps(db: Database.Database, sessionId: string, opts: { all?: boolean } = {}): ActionItem[] {
  const rows = db
    .prepare(`SELECT * FROM action_items WHERE session_id = ? ${opts.all ? '' : `AND status != 'removed'`} ORDER BY position`)
    .all(sessionId) as Row[];
  return rows.map(toItem);
}

export function getStep(db: Database.Database, id: string): ActionItem | null {
  const r = db.prepare(`SELECT * FROM action_items WHERE id = ?`).get(id) as Row | undefined;
  return r ? toItem(r) : null;
}

const PATCHABLE = ['status', 'status_why', 'current_at', 'fired_at', 'done_at', 'attempts', 'held_rev', 'held_at', 'approved_rev', 'ask_first', 'removed_from'] as const;

export function setStep(
  db: Database.Database,
  id: string,
  patch: Partial<Pick<ActionItem, (typeof PATCHABLE)[number]>>,
): boolean {
  const keys = PATCHABLE.filter((k) => patch[k] !== undefined);
  if (!keys.length) return false;
  const vals = keys.map((k) => (k === 'ask_first' ? (patch[k] ? 1 : 0) : patch[k]));
  const r = db.prepare(`UPDATE action_items SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...(vals as (string | number)[]), id);
  return r.changes > 0;
}

/** Every session with at least one step that is neither done nor removed. */
export function openChains(db: Database.Database): Map<string, ActionItem[]> {
  const rows = db
    .prepare(
      `SELECT * FROM action_items WHERE status != 'removed' AND session_id IN
         (SELECT session_id FROM action_items WHERE status NOT IN ('done', 'removed'))
       ORDER BY session_id, position`,
    )
    .all() as Row[];
  const out = new Map<string, ActionItem[]>();
  for (const r of rows) {
    const list = out.get(r.session_id) ?? [];
    list.push(toItem(r));
    out.set(r.session_id, list);
  }
  return out;
}

export function setCloseWhenDone(db: Database.Database, sessionId: string, on: boolean, _now: number): void {
  db.prepare(
    `INSERT INTO action_chats (session_id, close_when_done, closed_at) VALUES (?, ?, 0)
     ON CONFLICT(session_id) DO UPDATE SET close_when_done = excluded.close_when_done ${on ? ', closed_at = 0' : ''}`,
  ).run(sessionId, on ? 1 : 0);
}

export function chatFlags(db: Database.Database, sessionId: string): { close_when_done: boolean; closed_at: number } {
  const r = db.prepare(`SELECT close_when_done, closed_at FROM action_chats WHERE session_id = ?`).get(sessionId) as
    | { close_when_done: number; closed_at: number }
    | undefined;
  return { close_when_done: !!r?.close_when_done, closed_at: r?.closed_at ?? 0 };
}

const ACTION_PHRASE: Record<ActionType, string> = { none: 'none', send_draft: 'send draft', wake_chat: 'wake the chat' };

/** The panel's trigger → action line. */
export function stepSummary(s: ActionItem): string {
  const p = s.trigger_params;
  let when: string;
  switch (s.trigger_type) {
    case 'now':
      when = 'Now';
      break;
    case 'manual':
      when = 'To do';
      break;
    case 'pr_merged':
      when = `When PR #${p.number} merges`;
      break;
    case 'pr_shipped':
      when = `When ${p.repo}#${p.number} ships`;
      break;
    case 'slack_reply':
      when = `When ${p.from ? String(p.from) : 'someone'} replies`;
      break;
    case 'draft_sent':
      when = `When draft ${p.draft_id} is sent`;
      break;
    case 'clock':
      when = `At ${p.label}`;
      break;
  }
  const bare = (s.trigger_type === 'now' || s.trigger_type === 'manual') && s.action_type === 'none';
  return bare ? when : `${when} → ${ACTION_PHRASE[s.action_type]}`;
}
