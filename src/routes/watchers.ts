import type Database from 'better-sqlite3';
import { openDb } from '../db.ts';
import { getSetting } from '../settingsSchema.ts';
import { slackFeatureOn } from '../slackmode.ts';
import { orchSettings } from '../orchestrator.ts';
import { parseSlackThread } from '../slackref.ts';
import { conversationsReplies } from '../slackapi.ts';
import {
  TRIGGERS, deleteWatcher, fromRow, getWatcher, insertWatcher, listWatchers, markReviewed, recentEvents, recentFires, replaceWatcher,
  setRunMode, shadowUnreviewed, attentionCount, toDraft, unreviewedCounts, validateDraft, type EventRow, type Watcher, type WatcherRow,
} from '../watchers/model.ts';
import { createFromTemplate, templateList } from '../watchers/templates.ts';
import { discoverInvocables, hasInvocable } from '../watchers/invocables.ts';
import { isDryRun, runtimeTestDeps, testWatcher } from '../watchers/engine.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Watchers (§9): list, templates, create / edit / duplicate / delete, run mode,
// Test, Shadow review, events, and the "Watch posts like this" prefill.
// On/off (/api/watchers/toggle) and the jump to a started chat
// (/api/watchers/goto) are still answered inline by server.ts.
// Every entry is gated by requireWrite(kind) in src/routes/index.ts before its
// handler runs; tests/auth.test.ts sweeps this list, so a route cannot skip it.

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One watcher for the page. Carries the previous build's fields too, so the current Watchers tab keeps working. */
export function watcherView(db: Database.Database, w: Watcher, extra: { seen?: number; unreviewed?: number } = {}) {
  return {
    id: w.id,
    label: w.label,
    enabled: w.enabled,
    run_mode: w.run_mode,
    source: w.source,
    trigger: { ...w.trigger, label: TRIGGERS[w.source.kind][w.trigger.kind]?.label ?? w.trigger.kind },
    action: w.action,
    max_per_hour: w.max_per_hour,
    cooldown_min: w.cooldown_min,
    quiet_start: w.quiet_start,
    quiet_end: w.quiet_end,
    template_id: w.template_id,
    created_at: w.created_at,
    updated_at: w.updated_at,
    shadow_unreviewed: extra.unreviewed ?? 0,
    /** Counts toward the badge: enabled, and an unreviewed Shadow result or a failed last tick. */
    needs_attention: w.enabled && ((extra.unreviewed ?? 0) > 0 || !!w.poll.last_error),
    /** The red "Skip permissions" chip (§13). */
    skip_permissions: w.action.kind === 'start_chat' && (w.action.params.perm === 'skip' || (w.action.params.perm === 'inherit' && permWatchersSkip(db))),
    // The previous build's flat fields.
    channel: w.source.kind === 'slack' ? str(w.source.params.channel) : '',
    rule_kind: w.trigger.kind,
    rule_label: TRIGGERS[w.source.kind][w.trigger.kind]?.label ?? w.trigger.kind,
    baselined: w.poll.baselined,
    last_poll_at: w.poll.last_poll_at,
    last_ok_at: w.poll.last_ok_at,
    last_error: w.poll.last_error,
    error_count: w.poll.error_count,
    next_poll_at: w.poll.next_poll_at,
    brief_path: '',
    seen: extra.seen ?? 0,
  };
}

function permWatchersSkip(db: Database.Database): boolean {
  try {
    return getSetting(db, 'perm_watchers') === 'skip';
  } catch {
    return false;
  }
}

/** An event in the previous build's spawn shape (the current tab's "started" list), plus the v2 fields. */
export function spawnView(e: EventRow) {
  const status = e.result === 'started' ? 'spawned' : e.result === 'queued' ? 'queued' : e.mode === 'shadow' ? 'dry_run' : e.result || e.decision;
  return { ...e, ts: e.event_key, status, queued_at: e.detected_at, spawned_at: e.acted_at };
}

export function listHandler({ json }: RouteCtx): void {
  const body = withDb((db) => {
    const seen = new Map((db.prepare(`SELECT watcher_id, COUNT(*) AS n FROM watcher_seen GROUP BY watcher_id`).all() as { watcher_id: string; n: number }[]).map((r) => [r.watcher_id, r.n]));
    const counts = unreviewedCounts(db);
    const watchers = listWatchers(db).map((w) => watcherView(db, w, { seen: seen.get(w.id) ?? 0, unreviewed: counts.byWatcher[w.id] ?? 0 }));
    return {
      ok: true,
      dryRun: isDryRun(),
      enabled: safe(() => getSetting(db, 'watchers_enabled') !== false, true),
      // The tab badge: watchers needing attention (same number as /api/data.watchersUnreviewed).
      unreviewed: attentionCount(db),
      // Unreviewed Shadow events in total; per watcher in watchers[].shadow_unreviewed.
      unreviewed_events: counts.total,
      watchers,
      // The current tab's "started" list: chats a watcher started, queued or dry-ran (not every Shadow row).
      spawns: (db.prepare(`SELECT * FROM watcher_events WHERE result IN ('started', 'queued') OR brief_path != '' ORDER BY detected_at DESC, id DESC LIMIT 50`).all() as EventRow[]).map(spawnView),
    };
  });
  json(200, body);
}

function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** The 11 templates, with what this install has of what they need. */
export function templatesHandler({ json }: RouteCtx): void {
  const have = withDb((db) => ({ slack_direct: safe(() => slackFeatureOn('watchers', db), false), orchestrator: safe(() => orchSettings.enabled(db), false) }));
  json(200, { ok: true, templates: templateList(), have });
}

/**
 * The skills and commands a chat could be told to run. `project` is the start_chat
 * project folder; without it only user and plugin ones are listed (message_chat).
 */
export function invocablesHandler({ json, url }: RouteCtx): void {
  const project = url.searchParams.get('project') ?? '';
  json(200, { ok: true, invocables: discoverInvocables(project) });
}

export async function fromTemplateHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || typeof b.template_id !== 'string') return json(400, { ok: false, detail: 'template_id is required' });
  const o = (k: string) => (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k]) ? (b[k] as Record<string, unknown>) : undefined);
  if (o('action_params')?.perm === 'skip' && b.confirm_skip !== true) return json(400, { ok: false, detail: 'skip permissions needs confirm_skip' });
  const r = withDb((db) => {
    const made = createFromTemplate(db, b.template_id as string, {
      label: typeof b.label === 'string' ? b.label : undefined,
      enabled: typeof b.enabled === 'boolean' ? b.enabled : undefined,
      run_mode: b.run_mode === 'live' || b.run_mode === 'shadow' ? b.run_mode : undefined,
      source_params: o('source_params'),
      trigger_params: o('trigger_params'),
      action_params: o('action_params'),
    });
    return made.ok ? { ok: true as const, watcher: watcherView(db, getWatcher(db, made.id)!) } : made;
  });
  json(r.ok ? 200 : 400, r);
}

const needsSkipConfirm = (draft: unknown, before: Watcher | null): boolean => {
  const perm = (draft as { action?: { kind?: string; params?: { perm?: unknown } } })?.action;
  return perm?.kind === 'start_chat' && perm.params?.perm === 'skip' && before?.action.params.perm !== 'skip';
};

export async function createHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b) return json(400, { ok: false, detail: 'bad body' });
  if (needsSkipConfirm(b.watcher, null) && b.confirm_skip !== true) return json(400, { ok: false, detail: 'skip permissions needs confirm_skip' });
  const v = validateDraft(b.watcher, { forEnable: (b.watcher as { enabled?: unknown })?.enabled === true, invocable: hasInvocable });
  if (!v.ok) return json(400, v);
  json(200, withDb((db) => ({ ok: true, watcher: watcherView(db, getWatcher(db, insertWatcher(db, v.draft, Date.now()))!) })));
}

export async function updateHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || typeof b.id !== 'string') return json(400, { ok: false, detail: 'id is required' });
  const r = withDb((db) => {
    const before = getWatcher(db, b.id as string);
    if (!before) return { status: 404, body: { ok: false, detail: 'unknown watcher' } };
    if (needsSkipConfirm(b.watcher, before) && b.confirm_skip !== true) return { status: 400, body: { ok: false, detail: 'skip permissions needs confirm_skip' } };
    const v = validateDraft(b.watcher, { forEnable: (b.watcher as { enabled?: unknown })?.enabled === true, invocable: hasInvocable });
    if (!v.ok) return { status: 400, body: v };
    replaceWatcher(db, before.id, v.draft, Date.now());
    return { status: 200, body: { ok: true, watcher: watcherView(db, getWatcher(db, before.id)!) } };
  });
  json(r.status, r.body);
}

export async function deleteHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || typeof b.id !== 'string') return json(400, { ok: false, detail: 'id is required' });
  const ok = withDb((db) => deleteWatcher(db, b.id as string));
  json(ok ? 200 : 404, ok ? { ok } : { ok, detail: 'unknown watcher' });
}

/** A copy, Disabled and in Shadow, so it never doubles the original's actions. */
export async function duplicateHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || typeof b.id !== 'string') return json(400, { ok: false, detail: 'id is required' });
  const r = withDb((db) => {
    const w = getWatcher(db, b.id as string);
    if (!w) return null;
    const v = validateDraft({ ...toDraft(w), label: `${w.label} copy`.slice(0, 120), enabled: false, run_mode: 'shadow' });
    if (!v.ok) return null;
    return watcherView(db, getWatcher(db, insertWatcher(db, v.draft, Date.now()))!);
  });
  json(r ? 200 : 404, r ? { ok: true, watcher: r } : { ok: false, detail: 'unknown watcher' });
}

export async function runModeHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || typeof b.id !== 'string' || (b.mode !== 'shadow' && b.mode !== 'live')) return json(400, { ok: false, detail: 'id and mode (shadow|live) are required' });
  const ok = withDb((db) => setRunMode(db, b.id as string, b.mode as 'shadow' | 'live'));
  json(ok ? 200 : 404, ok ? { ok, mode: b.mode } : { ok, detail: 'unknown watcher' });
}

/** Evaluate a draft against recent items. Writes nothing, acts on nothing. */
export async function testHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  const v = validateDraft(b?.watcher);
  if (!v.ok) return json(400, v);
  const deps = runtimeTestDeps();
  if (!deps) return json(503, { ok: false, detail: 'the watcher runtime is not running in this process' });
  const d = v.draft;
  const row = {
    id: str((b?.watcher as { id?: unknown })?.id) || 'draft', label: d.label, enabled: d.enabled ? 1 : 0, run_mode: d.run_mode,
    source_kind: d.source.kind, source_params: JSON.stringify(d.source.params), trigger_kind: d.trigger.kind, trigger_params: JSON.stringify(d.trigger.params),
    action_kind: d.action.kind, action_params: JSON.stringify(d.action.params), max_per_hour: d.max_per_hour, cooldown_min: d.cooldown_min,
    quiet_start: d.quiet_start, quiet_end: d.quiet_end, template_id: d.template_id, created_at: 0, updated_at: 0,
    baselined: 0, watermark: '', last_poll_at: 0, last_ok_at: 0, last_error: '', error_count: 0, next_poll_at: 0,
    channel: '', rule_kind: '', rule_params: '{}', brief_path: '', project_dir: '', workspace: '',
  } satisfies WatcherRow;
  const ignoreSelf = withDb((db) => safe(() => getSetting(db, 'watchers_ignore_self') !== false, true));
  try {
    json(200, await testWatcher(fromRow(row), deps, ignoreSelf));
  } catch (e) {
    json(200, { ok: false, detail: (e as Error).message });
  }
}

/** Mark Shadow rows reviewed: `event_ids`, or every unreviewed row of watcher `id`. */
export async function reviewHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  const ids = Array.isArray(b?.event_ids) ? (b!.event_ids as unknown[]).filter((x): x is number => Number.isInteger(x)) : [];
  const id = str(b?.id);
  if (!ids.length && !id) return json(400, { ok: false, detail: 'id or event_ids is required' });
  const r = withDb((db) => ({ changed: markReviewed(db, ids.length ? { ids } : { watcherId: id }, Date.now()), unreviewed: attentionCount(db), unreviewed_events: unreviewedCounts(db).total }));
  json(200, { ok: true, ...r });
}

/** ?id=<watcher> (optional) &kind=fires|shadow|all (default fires) &limit=<= 200 */
export function eventsHandler({ json, url }: RouteCtx): void {
  const id = url.searchParams.get('id') || undefined;
  const kind = url.searchParams.get('kind') || 'fires';
  const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  const events = withDb((db) => (kind === 'shadow' ? shadowUnreviewed(db, id, limit) : kind === 'all' ? recentEvents(db, id, limit) : recentFires(db, id, limit)));
  json(200, { ok: true, events });
}

/**
 * "Watch posts like this": a Slack permalink -> a draft prefilled with its
 * channel, author and opening words. Reads one message; writes nothing.
 */
export async function fromPermalinkHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  const ref = parseSlackThread(str(b?.url));
  if (!ref) return json(400, { ok: false, detail: 'not a Slack message link' });
  const on = withDb((db) => safe(() => slackFeatureOn('watchers', db), false));
  if (!on) return json(409, { ok: false, detail: 'slack_off' });
  let msgs;
  try {
    msgs = await conversationsReplies(ref.channel, ref.linkTs, { limit: 1, maxPages: 1 });
  } catch (e) {
    return json(502, { ok: false, detail: (e as Error).message });
  }
  const m = msgs.find((x) => x.ts === ref.linkTs) ?? msgs[0];
  if (!m) return json(404, { ok: false, detail: 'message not found' });
  const workspace = (/^https:\/\/([\w-]+)\.slack\.com\//.exec(str(b?.url)) ?? [])[1] ?? '';
  const words = (m.text ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ');
  const trigger = m.bot_id
    ? { kind: 'bot-post-contains', params: { bot_ids: [m.bot_id], user_ids: [], needle: words } }
    : { kind: 'phrase', params: { needle: words, any_author: false } };
  json(200, {
    ok: true,
    draft: {
      label: `Posts like this in ${ref.channel}`,
      enabled: false,
      run_mode: 'shadow',
      source: { kind: 'slack', params: { channel: ref.channel, workspace } },
      trigger,
      action: { kind: 'notify', params: { template: '{{TITLE}}' } },
    },
    author: m.user ?? m.bot_id ?? '',
  });
}

const b = (path: string, handler: RouteDef['handler']): RouteDef => ({ method: 'POST', path, kind: 'browser', handler });
const r = (path: string, handler: RouteDef['handler']): RouteDef => ({ method: 'GET', path, kind: 'read', handler });

export const routes: RouteDef[] = [
  r('/api/watchers', listHandler),
  r('/api/watchers/templates', templatesHandler),
  r('/api/watchers/events', eventsHandler),
  r('/api/watchers/invocables', invocablesHandler),
  b('/api/watchers/from-template', fromTemplateHandler),
  b('/api/watchers/create', createHandler),
  b('/api/watchers/update', updateHandler),
  b('/api/watchers/delete', deleteHandler),
  b('/api/watchers/duplicate', duplicateHandler),
  b('/api/watchers/run-mode', runModeHandler),
  b('/api/watchers/test', testHandler),
  b('/api/watchers/review', reviewHandler),
  b('/api/watchers/from-permalink', fromPermalinkHandler),
];
