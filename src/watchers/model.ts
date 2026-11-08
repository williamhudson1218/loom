import { randomBytes } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';

// The watcher model (§9.1): Source -> Trigger -> Action, with a run mode
// (Shadow records what it would do, Live does it) and safety limits. A row in
// `watchers`; everything a watcher noticed is a row in `watcher_events`.
//
// This file is the data layer only: types, the trigger/param catalogue used to
// validate a draft, and the SQL. Evaluating a trigger lives in sources/*, doing
// an action in actions.ts, and the loop in engine.ts.

export type RunMode = 'shadow' | 'live';
export type SourceKind = 'slack' | 'chats' | 'prs';
export type ActionKind = 'start_chat' | 'message_chat' | 'notify' | 'tell_orch';
export type Decision = 'fired' | 'would_fire' | 'held_quiet' | 'held_cap' | 'held_cooldown' | 'held_capacity';
export type EventResult = 'queued' | 'started' | 'sent' | 'notified' | 'told' | 'failed' | '';
export type Params = Record<string, unknown>;

export const RUN_MODES: readonly RunMode[] = ['shadow', 'live'];
export const SOURCE_KINDS: readonly SourceKind[] = ['slack', 'chats', 'prs'];
export const ACTION_KINDS: readonly ActionKind[] = ['start_chat', 'message_chat', 'notify', 'tell_orch'];

/** Every trigger, per source, with its default params. A draft's params are merged over these. */
export const TRIGGERS: Record<SourceKind, Record<string, { label: string; defaults: Params }>> = {
  slack: {
    'bot-post-contains': { label: 'Bot post containing a phrase', defaults: { bot_ids: [], user_ids: [], needle: '' } },
    'pr-link-post': { label: 'Post linking a pull request', defaults: { repos: [], exclude_user_ids: [] } },
    'mentions-me': { label: 'Post that mentions me', defaults: {} },
    phrase: { label: 'Post containing a phrase', defaults: { needle: '', any_author: false } },
  },
  chats: {
    blocked_on_tool: { label: 'Stuck waiting on a tool', defaults: { min: 5 } },
    waiting_on_user: { label: 'Waiting on you', defaults: { min_sec: 90, max_h: 24 } },
    done_idle: { label: 'Finished, ready to wrap up', defaults: { min: 10 } },
    context_over: { label: 'Context nearly full', defaults: { fraction: 0.85 } },
    silent_mid_turn: { label: 'Silent mid-task', defaults: { min: 10 } },
    became_your_turn: { label: 'Flipped to Your turn', defaults: {} },
  },
  prs: {
    checks_red: { label: 'Checks went red', defaults: {} },
    changes_requested: { label: 'Review requested changes', defaults: {} },
    approved_green: { label: 'Approved and green', defaults: {} },
  },
};

export const SOURCE_DEFAULTS: Record<SourceKind, Params> = {
  slack: { channel: '', workspace: '' },
  chats: { projects: [], tags: [] },
  prs: { repos: [], mine_only: true },
};

export const ACTION_DEFAULTS: Record<ActionKind, Params> = {
  start_chat: { project_dir: '', target: 'managed', brief_template: '', perm: 'inherit' },
  message_chat: { template: '' },
  notify: { template: '' },
  tell_orch: { template: '' },
};

/** The stored row, as better-sqlite3 returns it. */
export interface WatcherRow {
  id: string;
  label: string;
  enabled: number;
  run_mode: string;
  source_kind: string;
  source_params: string;
  trigger_kind: string;
  trigger_params: string;
  action_kind: string;
  action_params: string;
  max_per_hour: number;
  cooldown_min: number;
  quiet_start: string;
  quiet_end: string;
  template_id: string;
  created_at: number;
  updated_at: number;
  // Slack poll state.
  baselined: number;
  watermark: string;
  last_poll_at: number;
  last_ok_at: number;
  last_error: string;
  error_count: number;
  next_poll_at: number;
  // Legacy (read by the previous build only).
  channel: string;
  rule_kind: string;
  rule_params: string;
  brief_path: string;
  project_dir: string;
  workspace: string;
}

/** A watcher with its JSON columns parsed. */
export interface Watcher {
  id: string;
  label: string;
  enabled: boolean;
  run_mode: RunMode;
  source: { kind: SourceKind; params: Params };
  trigger: { kind: string; params: Params };
  action: { kind: ActionKind; params: Params };
  max_per_hour: number;
  cooldown_min: number;
  quiet_start: string;
  quiet_end: string;
  template_id: string;
  created_at: number;
  updated_at: number;
  poll: { baselined: boolean; watermark: string; last_poll_at: number; last_ok_at: number; last_error: string; error_count: number; next_poll_at: number };
}

/** What a caller supplies to create or replace a watcher. */
export interface WatcherDraft {
  label: string;
  enabled?: boolean;
  run_mode?: RunMode;
  source: { kind: SourceKind; params?: Params };
  trigger: { kind: string; params?: Params };
  action: { kind: ActionKind; params?: Params };
  max_per_hour?: number;
  cooldown_min?: number;
  quiet_start?: string;
  quiet_end?: string;
  template_id?: string;
}

const parse = (s: string): Params => {
  try {
    const v: unknown = JSON.parse(s || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Params) : {};
  } catch {
    return {};
  }
};

export function fromRow(r: WatcherRow): Watcher {
  const source = (SOURCE_KINDS as readonly string[]).includes(r.source_kind) ? (r.source_kind as SourceKind) : 'slack';
  const action = (ACTION_KINDS as readonly string[]).includes(r.action_kind) ? (r.action_kind as ActionKind) : 'notify';
  return {
    id: r.id,
    label: r.label,
    enabled: !!r.enabled,
    run_mode: r.run_mode === 'live' ? 'live' : 'shadow',
    source: { kind: source, params: { ...SOURCE_DEFAULTS[source], ...parse(r.source_params) } },
    trigger: { kind: r.trigger_kind, params: { ...(TRIGGERS[source][r.trigger_kind]?.defaults ?? {}), ...parse(r.trigger_params) } },
    action: { kind: action, params: { ...ACTION_DEFAULTS[action], ...parse(r.action_params) } },
    max_per_hour: r.max_per_hour,
    cooldown_min: r.cooldown_min,
    quiet_start: r.quiet_start,
    quiet_end: r.quiet_end,
    template_id: r.template_id,
    created_at: r.created_at,
    updated_at: r.updated_at,
    poll: {
      baselined: !!r.baselined,
      watermark: r.watermark,
      last_poll_at: r.last_poll_at,
      last_ok_at: r.last_ok_at,
      last_error: r.last_error,
      error_count: r.error_count,
      next_poll_at: r.next_poll_at,
    },
  };
}

/* ------------------------------------------------------------ validation */

const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const LANE = /^lane:[a-z0-9][a-z0-9-]*$/;
const MAX_TEMPLATE = 20_000;

export type Validated = { ok: true; draft: Required<WatcherDraft> & { source: { kind: SourceKind; params: Params }; trigger: { kind: string; params: Params }; action: { kind: ActionKind; params: Params } } } | { ok: false; detail: string };

/**
 * Check a draft and fill its defaults. `forEnable` adds the checks that only
 * matter once it runs (a Slack channel, a project folder, a brief), so an
 * incomplete watcher made from a template can be saved disabled.
 */
export function validateDraft(
  input: unknown,
  opts: {
    forEnable?: boolean;
    /** Whether a skill or command exists for a chat in projectDir. The save routes pass it; without it only the shape is checked. */
    invocable?: (kind: 'skill' | 'command', name: string, projectDir: string) => boolean;
  } = {},
): Validated {
  if (!input || typeof input !== 'object') return { ok: false, detail: 'watcher is required' };
  const d = input as Partial<WatcherDraft> & Record<string, unknown>;
  const label = typeof d.label === 'string' ? d.label.trim() : '';
  if (!label || label.length > 120) return { ok: false, detail: 'label is required (at most 120 characters)' };
  const sk = d.source?.kind;
  if (!sk || !(SOURCE_KINDS as readonly string[]).includes(sk)) return { ok: false, detail: 'source.kind must be slack, chats or prs' };
  const tk = d.trigger?.kind ?? '';
  const spec = TRIGGERS[sk][tk];
  if (!spec) return { ok: false, detail: `trigger ${tk || '(none)'} does not exist for source ${sk}` };
  const ak = d.action?.kind;
  if (!ak || !(ACTION_KINDS as readonly string[]).includes(ak)) return { ok: false, detail: 'action.kind must be start_chat, message_chat, notify or tell_orch' };
  const runMode = d.run_mode ?? 'shadow';
  if (!(RUN_MODES as readonly string[]).includes(runMode)) return { ok: false, detail: 'run_mode must be shadow or live' };
  const sp: Params = { ...SOURCE_DEFAULTS[sk], ...(obj(d.source?.params) ?? {}) };
  const tp: Params = { ...spec.defaults, ...(obj(d.trigger?.params) ?? {}) };
  const ap: Params = { ...ACTION_DEFAULTS[ak], ...(obj(d.action?.params) ?? {}) };

  // Source
  if (sk === 'slack') {
    if (typeof sp.channel !== 'string' || (sp.channel && !/^[A-Z0-9]{5,20}$/.test(sp.channel))) return { ok: false, detail: 'source.params.channel must be a Slack channel id (C…)' };
    if (typeof sp.workspace !== 'string' || !/^[a-z0-9-]*$/.test(sp.workspace)) return { ok: false, detail: 'source.params.workspace must be a workspace slug' };
    if (opts.forEnable && !sp.channel) return { ok: false, detail: 'choose a Slack channel first' };
  } else if (sk === 'chats') {
    if (!isStrList(sp.projects) || !isStrList(sp.tags)) return { ok: false, detail: 'source.params.projects and tags must be lists of strings' };
  } else {
    if (!isStrList(sp.repos) || sp.repos.some((r) => !/^[\w.-]+\/[\w.-]+$/.test(r))) return { ok: false, detail: 'source.params.repos must be owner/name strings' };
    if (typeof sp.mine_only !== 'boolean') return { ok: false, detail: 'source.params.mine_only must be true or false' };
  }

  // Trigger
  for (const [k, def] of Object.entries(spec.defaults)) {
    const v = tp[k];
    if (Array.isArray(def) && !isStrList(v)) return { ok: false, detail: `trigger.params.${k} must be a list of strings` };
    if (typeof def === 'string' && typeof v !== 'string') return { ok: false, detail: `trigger.params.${k} must be text` };
    if (typeof def === 'boolean' && typeof v !== 'boolean') return { ok: false, detail: `trigger.params.${k} must be true or false` };
    if (typeof def === 'number' && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) return { ok: false, detail: `trigger.params.${k} must be a number >= 0` };
  }
  if (tk === 'context_over' && !((tp.fraction as number) > 0 && (tp.fraction as number) <= 1)) return { ok: false, detail: 'trigger.params.fraction must be between 0 and 1' };
  if ((tk === 'bot-post-contains' || tk === 'phrase') && opts.forEnable && !String(tp.needle).trim()) return { ok: false, detail: 'the phrase to look for is empty' };
  if (tk === 'bot-post-contains' && opts.forEnable && !(tp.bot_ids as string[]).length && !(tp.user_ids as string[]).length) return { ok: false, detail: 'name at least one bot or user to watch' };
  if (tk === 'pr-link-post' && opts.forEnable && !(tp.repos as string[]).length) return { ok: false, detail: 'name at least one repo (owner/name)' };

  // Action
  if (ak === 'start_chat') {
    if (typeof ap.project_dir !== 'string' || (ap.project_dir && !path.isAbsolute(ap.project_dir))) return { ok: false, detail: 'action.params.project_dir must be an absolute folder' };
    if (typeof ap.target !== 'string' || !(ap.target === 'managed' || LANE.test(ap.target))) return { ok: false, detail: "action.params.target must be 'managed' or 'lane:<name>'" };
    if (!['inherit', 'normal', 'skip'].includes(String(ap.perm))) return { ok: false, detail: 'action.params.perm must be inherit, normal or skip' };
    if (typeof ap.brief_template !== 'string' || ap.brief_template.length > MAX_TEMPLATE) return { ok: false, detail: 'action.params.brief_template must be text (at most 20000 characters)' };
    if (opts.forEnable && !ap.project_dir) return { ok: false, detail: 'choose the project the chat starts in' };
    if (opts.forEnable && !ap.brief_template.trim() && !ap.invoke) return { ok: false, detail: 'the brief is empty' };
  } else {
    if (typeof ap.template !== 'string' || ap.template.length > MAX_TEMPLATE) return { ok: false, detail: 'action.params.template must be text (at most 20000 characters)' };
    if (opts.forEnable && ak !== 'notify' && !ap.template.trim() && !(ak === 'message_chat' && ap.invoke)) return { ok: false, detail: 'the message is empty' };
  }
  // A skill or command instead of the free-text brief (start_chat and message_chat only).
  if (ap.invoke === null) delete ap.invoke;
  if (ap.invoke !== undefined || ap.notes !== undefined) {
    if (ak !== 'start_chat' && ak !== 'message_chat') return { ok: false, detail: 'only start_chat and message_chat can run a skill or command' };
    if (ap.notes !== undefined && (typeof ap.notes !== 'string' || ap.notes.length > MAX_TEMPLATE)) return { ok: false, detail: 'action.params.notes must be text (at most 20000 characters)' };
    const inv = ap.invoke as { kind?: unknown; name?: unknown; args?: unknown } | undefined;
    if (inv !== undefined) {
      if (typeof inv !== 'object' || (inv.kind !== 'skill' && inv.kind !== 'command')) return { ok: false, detail: 'action.params.invoke.kind must be skill or command' };
      if (typeof inv.name !== 'string' || !/^[A-Za-z0-9][\w.:-]{0,100}$/.test(inv.name)) return { ok: false, detail: `choose the ${inv.kind} to run` };
      if (typeof inv.args !== 'string' || inv.args.length > MAX_TEMPLATE) return { ok: false, detail: 'action.params.invoke.args must be text (at most 20000 characters)' };
      if (opts.invocable && !opts.invocable(inv.kind, inv.name, ak === 'start_chat' ? String(ap.project_dir) : '')) {
        return { ok: false, detail: `${inv.kind} ${inv.name} was not found${ak === 'start_chat' && ap.project_dir ? ` for ${ap.project_dir}` : ''}; choose one from the list` };
      }
    }
  }

  // Safety
  const mph = d.max_per_hour ?? 6;
  const cd = d.cooldown_min ?? 60;
  if (!Number.isInteger(mph) || mph < 0 || mph > 1000) return { ok: false, detail: 'max_per_hour must be a whole number from 0 (no cap) to 1000' };
  if (!Number.isInteger(cd) || cd < 0 || cd > 10_080) return { ok: false, detail: 'cooldown_min must be a whole number of minutes from 0 to 10080' };
  const qs = d.quiet_start ?? '';
  const qe = d.quiet_end ?? '';
  if ((qs && !HHMM.test(qs)) || (qe && !HHMM.test(qe)) || !!qs !== !!qe) return { ok: false, detail: 'quiet hours are two HH:MM times, or both empty' };
  if (d.enabled !== undefined && typeof d.enabled !== 'boolean') return { ok: false, detail: 'enabled must be true or false' };
  const tmpl = typeof d.template_id === 'string' ? d.template_id : '';

  return {
    ok: true,
    draft: {
      label,
      enabled: d.enabled ?? false,
      run_mode: runMode as RunMode,
      source: { kind: sk, params: sp },
      trigger: { kind: tk, params: tp },
      action: { kind: ak, params: ap },
      max_per_hour: mph,
      cooldown_min: cd,
      quiet_start: qs,
      quiet_end: qe,
      template_id: tmpl,
    },
  };
}

function obj(v: unknown): Params | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Params) : null;
}

/** Quiet hours in local time. start > end spans midnight (22:00-07:00). Equal = never quiet. */
export function inQuietHours(start: string, end: string, at: Date): boolean {
  if (!start || !end || start === end) return false;
  const mins = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const now = at.getHours() * 60 + at.getMinutes();
  const a = mins(start);
  const b = mins(end);
  return a < b ? now >= a && now < b : now >= a || now < b;
}

/* ------------------------------------------------------------ watcher rows */

export function listWatchers(db: Database.Database): Watcher[] {
  return (db.prepare(`SELECT * FROM watchers ORDER BY created_at, id`).all() as WatcherRow[]).map(fromRow);
}

export function getWatcher(db: Database.Database, id: string): Watcher | null {
  const r = db.prepare(`SELECT * FROM watchers WHERE id = ?`).get(id) as WatcherRow | undefined;
  return r ? fromRow(r) : null;
}

export function newWatcherId(label: string, rand: () => string = () => randomBytes(3).toString('hex')): string {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'watcher';
  return `${slug}-${rand()}`;
}

type Clean = Extract<Validated, { ok: true }>['draft'];

function columns(d: Clean, now: number): Record<string, string | number> {
  return {
    label: d.label,
    enabled: d.enabled ? 1 : 0,
    run_mode: d.run_mode,
    source_kind: d.source.kind,
    source_params: JSON.stringify(d.source.params),
    trigger_kind: d.trigger.kind,
    trigger_params: JSON.stringify(d.trigger.params),
    action_kind: d.action.kind,
    action_params: JSON.stringify(d.action.params),
    max_per_hour: d.max_per_hour,
    cooldown_min: d.cooldown_min,
    quiet_start: d.quiet_start,
    quiet_end: d.quiet_end,
    template_id: d.template_id,
    updated_at: now,
  };
}

/** Insert a validated draft. Legacy NOT NULL columns get '' (an old table has no defaults on them). */
export function insertWatcher(db: Database.Database, d: Clean, now: number, id: string = newWatcherId(d.label)): string {
  const c = { id, ...columns(d, now), created_at: now, channel: '', rule_kind: '', rule_params: '{}', brief_path: '', project_dir: '', workspace: '' };
  const keys = Object.keys(c);
  db.prepare(`INSERT INTO watchers (${keys.join(', ')}) VALUES (${keys.map((k) => '@' + k).join(', ')})`).run(c);
  return id;
}

/**
 * Replace a watcher's definition. A Slack watcher whose channel or trigger
 * changed is re-baselined, so editing it never replays the channel's history.
 */
export function replaceWatcher(db: Database.Database, id: string, d: Clean, now: number): boolean {
  const before = getWatcher(db, id);
  if (!before) return false;
  const c = columns(d, now);
  const sets = Object.keys(c).map((k) => `${k} = @${k}`).join(', ');
  db.transaction(() => {
    db.prepare(`UPDATE watchers SET ${sets} WHERE id = @id`).run({ ...c, id });
    const moved =
      d.source.kind !== before.source.kind ||
      (d.source.kind === 'slack' && d.source.params.channel !== before.source.params.channel) ||
      d.trigger.kind !== before.trigger.kind ||
      JSON.stringify(d.trigger.params) !== JSON.stringify(before.trigger.params);
    if (moved || (d.enabled && !before.enabled)) rebaseline(db, id);
  })();
  return true;
}

function rebaseline(db: Database.Database, id: string): void {
  db.prepare(`UPDATE watchers SET baselined = 0, watermark = '', last_error = '', error_count = 0, next_poll_at = 0 WHERE id = ?`).run(id);
}

/**
 * Turn a watcher on or off. Turning it ON always re-baselines: whatever was
 * posted while it was off is marked seen, not acted on, so a watcher left off
 * for a week cannot come back and fan out a week of workers.
 */
export function setWatcherEnabled(db: Database.Database, id: string, enabled: boolean, now: number = Date.now()): boolean {
  const r = enabled
    ? db.prepare(`UPDATE watchers SET enabled = 1, baselined = 0, watermark = '', last_error = '', error_count = 0, next_poll_at = 0, updated_at = ? WHERE id = ?`).run(now, id)
    : db.prepare(`UPDATE watchers SET enabled = 0, updated_at = ? WHERE id = ?`).run(now, id);
  return r.changes > 0;
}

export function setRunMode(db: Database.Database, id: string, mode: RunMode, now: number = Date.now()): boolean {
  return db.prepare(`UPDATE watchers SET run_mode = ?, updated_at = ? WHERE id = ?`).run(mode, now, id).changes > 0;
}

/** Delete a watcher with its dedupe set and its events. */
export function deleteWatcher(db: Database.Database, id: string): boolean {
  return db.transaction(() => {
    db.prepare(`DELETE FROM watcher_seen WHERE watcher_id = ?`).run(id);
    db.prepare(`DELETE FROM watcher_events WHERE watcher_id = ?`).run(id);
    return db.prepare(`DELETE FROM watchers WHERE id = ?`).run(id).changes > 0;
  })();
}

/** A watcher as a draft (for Duplicate and the editor). */
export function toDraft(w: Watcher): Clean {
  return {
    label: w.label,
    enabled: w.enabled,
    run_mode: w.run_mode,
    source: { kind: w.source.kind, params: w.source.params },
    trigger: { kind: w.trigger.kind, params: w.trigger.params },
    action: { kind: w.action.kind, params: w.action.params },
    max_per_hour: w.max_per_hour,
    cooldown_min: w.cooldown_min,
    quiet_start: w.quiet_start,
    quiet_end: w.quiet_end,
    template_id: w.template_id,
  };
}

/* ------------------------------------------------------------ events */

export interface EventRow {
  id: number;
  watcher_id: string;
  event_key: string;
  subject: string;
  title: string;
  permalink: string;
  detected_at: number;
  mode: RunMode;
  decision: Decision;
  result: EventResult;
  detail: string;
  pane_id: string;
  pane_name: string;
  pane_where: string;
  brief_path: string;
  acted_at: number;
  reviewed_at: number;
}

export interface EventInput {
  watcher_id: string;
  event_key: string;
  subject: string;
  title: string;
  permalink: string;
  detected_at: number;
  mode: RunMode;
  decision: Decision;
  result?: EventResult;
  detail?: string;
}

/** Record an event. Returns its id, or null when this watcher already has one for the key (dedupe). */
export function recordEvent(db: Database.Database, e: EventInput): number | null {
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO watcher_events (watcher_id, event_key, subject, title, permalink, detected_at, mode, decision, result, detail)
       VALUES (@watcher_id, @event_key, @subject, @title, @permalink, @detected_at, @mode, @decision, @result, @detail)`,
    )
    .run({ result: '', ...e, title: e.title.slice(0, 300), detail: (e.detail ?? '').slice(0, 500) });
  return info.changes ? Number(info.lastInsertRowid) : null;
}

export type EventPatch = Partial<Pick<EventRow, 'decision' | 'result' | 'detail' | 'pane_id' | 'pane_name' | 'pane_where' | 'brief_path' | 'acted_at' | 'mode' | 'reviewed_at'>>;

export function updateEvent(db: Database.Database, id: number, patch: EventPatch): void {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  const p: Record<string, unknown> = { ...patch, id };
  if (typeof p.detail === 'string') p.detail = p.detail.slice(0, 500);
  db.prepare(`UPDATE watcher_events SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run(p);
}

export function getEvent(db: Database.Database, id: number): EventRow | null {
  return (db.prepare(`SELECT * FROM watcher_events WHERE id = ?`).get(id) as EventRow | undefined) ?? null;
}

export function queuedEvents(db: Database.Database, watcherId: string): EventRow[] {
  return db.prepare(`SELECT * FROM watcher_events WHERE watcher_id = ? AND result = 'queued' ORDER BY detected_at, id`).all(watcherId) as EventRow[];
}

/** Recent fires (§9.1): what actually acted or was held. Newest first. */
export function recentFires(db: Database.Database, watcherId?: string, limit = 50): EventRow[] {
  const where = `decision IN ('fired', 'held_quiet', 'held_cap', 'held_cooldown', 'held_capacity')` + (watcherId ? ` AND watcher_id = ?` : '');
  const args: unknown[] = watcherId ? [watcherId, limit] : [limit];
  return db.prepare(`SELECT * FROM watcher_events WHERE ${where} ORDER BY detected_at DESC, id DESC LIMIT ?`).all(...args) as EventRow[];
}

/** Every recent event, newest first (fires, holds and shadow rows alike). */
export function recentEvents(db: Database.Database, watcherId?: string, limit = 50): EventRow[] {
  const args: unknown[] = watcherId ? [watcherId, limit] : [limit];
  return db.prepare(`SELECT * FROM watcher_events${watcherId ? ' WHERE watcher_id = ?' : ''} ORDER BY detected_at DESC, id DESC LIMIT ?`).all(...args) as EventRow[];
}

/** "Would have fired (Shadow)" rows nobody has reviewed yet. */
export function shadowUnreviewed(db: Database.Database, watcherId?: string, limit = 50): EventRow[] {
  const args: unknown[] = watcherId ? [watcherId, limit] : [limit];
  return db
    .prepare(`SELECT * FROM watcher_events WHERE mode = 'shadow' AND decision = 'would_fire' AND reviewed_at = 0${watcherId ? ' AND watcher_id = ?' : ''} ORDER BY detected_at DESC, id DESC LIMIT ?`)
    .all(...args) as EventRow[];
}

/** The Watchers badge: Shadow would_fire rows not yet reviewed. Per watcher, and in total. */
export function unreviewedCounts(db: Database.Database): { total: number; byWatcher: Record<string, number> } {
  const rows = db
    .prepare(`SELECT watcher_id, COUNT(*) AS n FROM watcher_events WHERE mode = 'shadow' AND decision = 'would_fire' AND reviewed_at = 0 GROUP BY watcher_id`)
    .all() as { watcher_id: string; n: number }[];
  const byWatcher: Record<string, number> = {};
  let total = 0;
  for (const r of rows) {
    byWatcher[r.watcher_id] = r.n;
    total += r.n;
  }
  return { total, byWatcher };
}

/**
 * The Watchers badge: how many enabled watchers need attention, meaning at
 * least one unreviewed Shadow result, or an error on the last tick. A count of
 * watchers, not events, so it stays a handful however chatty a watcher is.
 * Per-watcher event counts are unreviewedCounts().
 */
export function attentionCount(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM watchers w WHERE w.enabled = 1 AND (w.last_error != ''
           OR EXISTS (SELECT 1 FROM watcher_events e WHERE e.watcher_id = w.id AND e.mode = 'shadow' AND e.decision = 'would_fire' AND e.reviewed_at = 0))`,
      )
      .get() as { n: number }
  ).n;
}

/** Mark Shadow rows reviewed: given ids, or every unreviewed row of a watcher. Returns how many changed. */
export function markReviewed(db: Database.Database, sel: { watcherId?: string; ids?: number[] }, now: number): number {
  if (sel.ids?.length) {
    const st = db.prepare(`UPDATE watcher_events SET reviewed_at = ? WHERE id = ? AND reviewed_at = 0`);
    return db.transaction(() => sel.ids!.reduce((n, id) => n + st.run(now, id).changes, 0))();
  }
  if (sel.watcherId) return db.prepare(`UPDATE watcher_events SET reviewed_at = ? WHERE watcher_id = ? AND mode = 'shadow' AND decision = 'would_fire' AND reviewed_at = 0`).run(now, sel.watcherId).changes;
  return 0;
}

/** Live fires of one watcher since `since` (the per-watcher hourly cap). */
export function firedSince(db: Database.Database, watcherId: string, since: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM watcher_events WHERE watcher_id = ? AND decision = 'fired' AND detected_at >= ?`).get(watcherId, since) as { n: number }).n;
}

/** The last time this watcher fired for this subject (the cooldown), or 0. */
export function lastFiredFor(db: Database.Database, watcherId: string, subject: string): number {
  return (db.prepare(`SELECT MAX(detected_at) AS t FROM watcher_events WHERE watcher_id = ? AND subject = ? AND decision = 'fired'`).get(watcherId, subject) as { t: number | null }).t ?? 0;
}

/** Chats started by any watcher since `since` (the global start cap). */
export function startsSince(db: Database.Database, since: number): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM watcher_events WHERE result = 'started' AND acted_at >= ?`).get(since) as { n: number }).n;
}

/** Panes a watcher typed into since `since`: a pane just launched into may not show its claude process yet. */
export function panesUsedSince(db: Database.Database, since: number): Set<string> {
  return new Set((db.prepare(`SELECT pane_id FROM watcher_events WHERE acted_at > ? AND pane_id != ''`).all(since) as { pane_id: string }[]).map((r) => r.pane_id));
}

/* ------------------------------------------------------------ matches */

/** One thing a source's trigger matched. `key` dedupes within the watcher; `subject` is what the cooldown is per. */
export interface Match {
  key: string;
  subject: string;
  title: string;
  permalink: string;
  /** Template variables ({{TITLE}} etc.) for the brief or message. */
  vars: Record<string, string>;
  /** The chat this is about or that owns it (message_chat's target). */
  chat?: { agent: 'claude' | 'codex'; session_id: string } | null;
}
