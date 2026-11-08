import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { TOOL_DIR } from '../paths.ts';
import { openDb } from '../db.ts';
import { getSetting } from '../settingsSchema.ts';
import type { LaunchSettings } from '../launch.ts';
import type { WorldState } from '../compact.ts';
import type { ManagedPaneResult } from '../managed.ts';
import type { SlackMessage } from '../slack.ts';
import type { Agent } from '../types.ts';
import {
  firedSince, getWatcher, inQuietHours, lastFiredFor, listWatchers, panesUsedSince, queuedEvents, recordEvent, startsSince, updateEvent,
  type Decision, type EventResult, type Match, type Watcher,
} from './model.ts';
import { ingest, recordPollError, slackChannel, slackMatch, type SlackCtx } from './sources/slack.ts';
import { evaluateChats, newTurnMemo, type TurnMemo } from './sources/chats.ts';
import { evaluatePrs, type PrState } from './sources/prs.ts';
import type { ChatSignal } from './chatSignals.ts';
import { launchCommand, paneWhere, pickPane, renderBrief, renderPrompt, settingsForPerm, type RelayOutcome } from './actions.ts';
import { hasInvocable, readInvoke, type InvocableKind } from './invocables.ts';

// The watcher loop (§9). One pass every 15 s over every enabled watcher:
//   slack  poll the channel when due (60 s, backing off on errors), run the
//          trigger over new messages (first poll = baseline, nothing acts)
//   chats  evaluate the trigger over the live chats' signals
//   prs    evaluate it over the cached PR pipelines
// Each match is DECIDED (Shadow: would_fire; Live: held for quiet hours, the
// hourly cap or the per-subject cooldown, else fired) and recorded as one
// watcher_events row, deduped by (watcher, event key). A fired start_chat is
// queued on that row and drained while panes (or capacity) allow; the other
// actions run at once.
//
// Loom never posts or reacts in Slack. LOOM_WATCHERS_OFF=1 and the
// watchers_enabled setting both stop the loop.

export const WATCHERS_DIR = path.join(TOOL_DIR, 'watchers');
export const BRIEFS_DIR = path.join(WATCHERS_DIR, 'briefs');
export const TICK_MS = 15_000;
// A pane just launched into may not show its claude process yet; don't reuse it.
const RESERVE_MS = 3 * 60_000;
const HOUR = 3_600_000;
/** At most this many live start_chat per 10 minutes, across every watcher that has a cap. */
export const GLOBAL_START_CAP = 3;
export const GLOBAL_START_WINDOW_MS = 10 * 60_000;

export interface EngineDeps {
  now(): number;
  /** Slack history since `oldest` ('' = the latest page). */
  history(channel: string, oldest: string): Promise<SlackMessage[]>;
  /** Slack Direct is connected (the watchers feature, §5.4). Slack watchers skip their poll otherwise. */
  slackOn(): boolean;
  slackSelf(): string;
  /** The chat that owns a Slack thread (`<channel>/<ts>`), for message_chat. */
  threadOwner(key: string): { agent: Agent; session_id: string } | null;
  /** Live chats' signals. Called at most once per tick, only when a chats watcher is on. */
  chats(needs: { context: boolean; pendingTool: boolean }): ChatSignal[];
  prs(): PrState[];
  world(): WorldState;
  launch(paneId: string, command: string): Promise<void>;
  /** A fresh managed window (capacity-checked). */
  acquireManaged(projectDir: string): ManagedPaneResult;
  launchSettings(): LaunchSettings;
  /** `bare` types the text without the watcher prefix (a slash command must be first). */
  relay(label: string, agent: Agent, sessionId: string, text: string, opts?: { bare?: boolean }): RelayOutcome;
  /** Whether a skill or command still exists for a chat in projectDir. Defaults to reading the disk. */
  invocable?(kind: InvocableKind, name: string, projectDir: string): boolean;
  notify(title: string, body: string, target?: { agent: string; sid: string }): boolean;
  /** Hand an event to the orchestrator; false when it is off. */
  tellOrch(key: string, text: string, label: string): boolean;
  dryRun: boolean;
  briefsDir: string;
  selfPane?: string;
}

/** Engine state that outlives one tick (the your-turn edge memo). */
export interface EngineState {
  turns: TurnMemo;
  lastPrune: number;
}
export const newEngineState = (): EngineState => ({ turns: newTurnMemo(), lastPrune: 0 });

/* ------------------------------------------------------------ deciding */

export interface DecideCtx {
  now: number;
  /** Local time, for quiet hours (injectable for tests). */
  date?: Date;
}

/**
 * Decide one match and record it. Returns the event id and decision, or null
 * when this watcher already recorded the key. A fired start_chat comes back
 * with result 'queued' (drained later); other fired actions with result ''
 * until act() runs them.
 */
export function decide(db: Database.Database, w: Watcher, m: Match, ctx: DecideCtx): { id: number; decision: Decision } | null {
  const base = { watcher_id: w.id, event_key: m.key, subject: m.subject, title: m.title, permalink: m.permalink, detected_at: ctx.now };
  let decision: Decision;
  let detail = '';
  if (w.run_mode === 'shadow') {
    decision = 'would_fire';
  } else if (inQuietHours(w.quiet_start, w.quiet_end, ctx.date ?? new Date(ctx.now))) {
    decision = 'held_quiet';
    detail = `quiet hours ${w.quiet_start}-${w.quiet_end}`;
  } else if (w.max_per_hour > 0 && firedSince(db, w.id, ctx.now - HOUR) >= w.max_per_hour) {
    decision = 'held_cap';
    detail = `${w.max_per_hour} fires in the last hour`;
  } else if (w.cooldown_min > 0 && ctx.now - lastFiredFor(db, w.id, m.subject) < w.cooldown_min * 60_000) {
    decision = 'held_cooldown';
    detail = `fired for this within ${w.cooldown_min} min`;
  } else {
    decision = 'fired';
  }
  const result: EventResult = decision === 'fired' && w.action.kind === 'start_chat' ? 'queued' : '';
  const id = recordEvent(db, { ...base, mode: w.run_mode, decision, result, detail });
  return id === null ? null : { id, decision };
}

/* ------------------------------------------------------------ acting */

function vars(db: Database.Database, w: Watcher, m: Match): Record<string, string> {
  const voice = safeSetting(db, 'voice_skill', '');
  return {
    WATCHER: w.label,
    SELF_NAME: selfName(db),
    REVIEW_SKILL: safeSetting(db, 'review_skill', 'loom:review') || 'loom:review',
    VOICE_SKILL: voice,
    VOICE_HINT: voice ? ` (load the ${voice} skill first)` : '',
    ...m.vars,
  };
}

function safeSetting(db: Database.Database, key: string, fallback: string): string {
  try {
    return String(getSetting(db, key as never) ?? fallback);
  } catch {
    return fallback;
  }
}

function selfName(db: Database.Database): string {
  try {
    const id = JSON.parse(String((db.prepare(`SELECT value FROM settings WHERE key = 'slack_identity'`).get() as { value: string } | undefined)?.value ?? '{}'));
    return typeof id.user === 'string' ? id.user : '';
  } catch {
    return '';
  }
}

/** Run a fired message_chat / notify / tell_orch and record its result. */
export function act(db: Database.Database, w: Watcher, eventId: number, m: Match, deps: EngineDeps): EventResult {
  const inv = w.action.kind === 'message_chat' ? readInvoke(w.action.params) : null;
  const text = (inv ? renderPrompt(w.action.params, 'template', vars(db, w, m), true) : renderBrief(String(w.action.params.template ?? ''), vars(db, w, m))).trim();
  let result: EventResult = 'failed';
  let detail = '';
  if (w.action.kind === 'message_chat') {
    const chat = m.chat ?? null;
    if (!chat) detail = 'no chat owns this';
    else if (inv && chat.agent === 'codex') detail = `${inv.kind}s run in Claude chats only; this chat is Codex`;
    else if (inv && !(deps.invocable ?? hasInvocable)(inv.kind, inv.name, '')) detail = `${inv.kind} ${inv.name} not found`;
    else if (!text) detail = 'empty message';
    else {
      const r = inv ? deps.relay(w.label, chat.agent, chat.session_id, text, { bare: true }) : deps.relay(w.label, chat.agent, chat.session_id, text);
      result = r.status === 'failed' ? 'failed' : r.status;
      detail = r.detail;
    }
  } else if (w.action.kind === 'notify') {
    const target = m.subject.startsWith('chat:') && m.chat ? { agent: m.chat.agent, sid: m.chat.session_id } : undefined;
    result = deps.notify(w.label, text || m.title, target) ? 'notified' : 'failed';
    if (result === 'failed') detail = 'notifications are not available';
  } else if (w.action.kind === 'tell_orch') {
    const ok = deps.tellOrch(`watcher:${w.id}:${m.subject}`, text || m.title, w.label);
    result = ok ? 'told' : 'failed';
    if (!ok) detail = 'the orchestrator is off';
  }
  updateEvent(db, eventId, { result, detail, acted_at: deps.now() });
  return result;
}

/** Launch a chat for each queued start_chat event while panes (and the caps) last; the rest stay queued. */
export async function drainQueue(db: Database.Database, w: Watcher, deps: EngineDeps): Promise<{ started: number; waiting: number }> {
  const queued = queuedEvents(db, w.id);
  if (!queued.length) return { started: 0, waiting: 0 };
  const p = w.action.params;
  const target = String(p.target ?? 'managed');
  const projectDir = String(p.project_dir ?? '');
  const template = String(p.brief_template ?? '');
  const inv = readInvoke(p);
  const now = deps.now();
  const reserved = panesUsedSince(db, now - RESERVE_MS);
  if (deps.selfPane) reserved.add(deps.selfPane);
  if (!projectDir || (!inv && !template.trim())) {
    for (const q of queued) updateEvent(db, q.id, { detail: !projectDir ? 'no project folder set' : 'the brief is empty' });
    return { started: 0, waiting: queued.length };
  }
  // A skill or command that is gone fails the event rather than starting a chat that cannot run it.
  // start_chat always launches Claude (Codex commands are not built), so there is no Codex case here.
  if (inv && !(deps.invocable ?? hasInvocable)(inv.kind, inv.name, projectDir)) {
    for (const q of queued) updateEvent(db, q.id, { result: 'failed', detail: `${inv.kind} ${inv.name} not found`, acted_at: now });
    return { started: 0, waiting: 0 };
  }
  const settings = settingsForPerm(deps.launchSettings(), p.perm);
  const world = target.startsWith('lane:') ? deps.world() : null;
  let started = 0;
  for (let i = 0; i < queued.length; i++) {
    const q = queued[i];
    // The global cap is a safety net for capped watchers. One whose max_per_hour is 0
    // asked for no cap (migrated Slack watchers are, so they keep firing as they did).
    if (!deps.dryRun && w.max_per_hour > 0 && startsSince(db, deps.now() - GLOBAL_START_WINDOW_MS) >= GLOBAL_START_CAP) {
      for (const r of queued.slice(i)) updateEvent(db, r.id, { decision: 'held_cap', detail: `waiting: ${GLOBAL_START_CAP} chats were started by watchers in the last 10 min` });
      return { started, waiting: queued.length - i };
    }
    let pane: { id: string; name: string; where: string };
    if (world) {
      const lane = target.slice('lane:'.length);
      const lp = pickPane(world.panes, { lane, exclude: reserved, focused: world.focused });
      if (!lp) {
        for (const r of queued.slice(i)) updateEvent(db, r.id, { detail: `waiting for a free loom-${lane} pane` });
        return { started, waiting: queued.length - i };
      }
      pane = { id: lp.pane_id, name: lp.name, where: paneWhere(lp) };
    } else if (deps.dryRun) {
      pane = { id: '', name: '', where: 'managed (dry run)' };
    } else {
      const mp = deps.acquireManaged(projectDir);
      if (!mp.ok) {
        for (const r of queued.slice(i)) updateEvent(db, r.id, { decision: 'held_capacity', detail: 'waiting: ' + mp.detail });
        return { started, waiting: queued.length - i };
      }
      pane = { id: mp.paneId, name: mp.name, where: mp.where };
    }
    const m: Match = { key: q.event_key, subject: q.subject, title: q.title, permalink: q.permalink, vars: matchVarsFromEvent(w, q) };
    const brief = inv ? renderPrompt(p, 'brief_template', vars(db, w, m)) : renderBrief(template, vars(db, w, m));
    const briefPath = path.join(deps.briefsDir, `${w.id}-${safeName(q.event_key)}.md`);
    const command = launchCommand(projectDir, briefPath, pane.name || pane.id, settings);
    try {
      fs.mkdirSync(deps.briefsDir, { recursive: true });
      fs.writeFileSync(briefPath, brief);
      if (!deps.dryRun) await deps.launch(pane.id, command);
    } catch (e) {
      updateEvent(db, q.id, { detail: 'launch failed: ' + (e as Error).message });
      if (pane.id) reserved.add(pane.id); // try a different pane next time round
      continue;
    }
    if (pane.id) reserved.add(pane.id);
    updateEvent(
      db,
      q.id,
      deps.dryRun
        ? { decision: 'would_fire', mode: 'shadow', result: '', pane_id: pane.id, pane_name: pane.name, pane_where: pane.where, brief_path: briefPath, acted_at: deps.now(), reviewed_at: deps.now(), detail: 'dry run: nothing was typed' }
        : { decision: 'fired', result: 'started', pane_id: pane.id, pane_name: pane.name, pane_where: pane.where, brief_path: briefPath, acted_at: deps.now(), detail: '' },
    );
    started++;
  }
  return { started, waiting: 0 };
}

/** A Slack ts keeps the previous build's brief file name (<id>-<sec>-<frac>.md). */
const safeName = (key: string): string => key.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'event';

/**
 * The template variables for a queued event. A Slack event's are rebuilt from
 * its row (TITLE, URL, CHANNEL, TS: what the previous build's briefs used);
 * others carry title and link.
 */
function matchVarsFromEvent(w: Watcher, q: { event_key: string; title: string; permalink: string; subject: string }): Record<string, string> {
  const v: Record<string, string> = { TITLE: q.title, URL: q.permalink, PERMALINK: q.permalink };
  if (w.source.kind === 'slack') Object.assign(v, { CHANNEL: slackChannel(w), TS: q.event_key });
  if (w.source.kind === 'prs') Object.assign(v, { PR: q.subject.replace(/^pr:/, '') });
  return v;
}

/* ------------------------------------------------------------ the tick */

function watchersOn(db: Database.Database): boolean {
  try {
    return getSetting(db, 'watchers_enabled') !== false;
  } catch {
    return true;
  }
}

/** One pass over every enabled watcher. Never throws for one watcher's failure. */
export async function tickWatchers(db: Database.Database, deps: EngineDeps, state: EngineState = sharedState): Promise<void> {
  if (!watchersOn(db)) return;
  const all = listWatchers(db).filter((w) => w.enabled);
  const chatWatchers = all.filter((w) => w.source.kind === 'chats');
  let signals: ChatSignal[] | null = null;
  const getSignals = () =>
    (signals ??= deps.chats({
      context: chatWatchers.some((w) => w.trigger.kind === 'context_over'),
      pendingTool: chatWatchers.some((w) => w.trigger.kind === 'blocked_on_tool'),
    }));
  let prs: PrState[] | null = null;
  const slackCtx = (): SlackCtx => ({ selfUserId: deps.slackSelf(), ignoreSelf: safeBool(db, 'watchers_ignore_self', true) });

  for (const w0 of all) {
    try {
      const immediate: { id: number; m: Match }[] = [];
      const consider = (w: Watcher) => (m: Match) => {
        const d = decide(db, w, m, { now: deps.now() });
        if (d?.decision === 'fired' && w.action.kind !== 'start_chat') immediate.push({ id: d.id, m });
      };
      if (w0.source.kind === 'slack') {
        if (!deps.slackOn() || !slackChannel(w0)) continue;
        if (deps.now() >= w0.poll.next_poll_at) {
          try {
            const msgs = await deps.history(slackChannel(w0), w0.poll.baselined ? w0.poll.watermark : '');
            // Thread owners are looked up BEFORE ingest opens its write transaction:
            // threadOwner opens its own connection (schema + migration writes), and
            // doing that inside the transaction deadlocks on our own lock, rolls the
            // poll back and leaves the watcher stuck on the same message forever.
            const ctx = slackCtx();
            const owners = new Map<string, ReturnType<EngineDeps['threadOwner']>>();
            for (const msg of msgs) {
              const hit = slackMatch(w0, msg, ctx);
              if (hit && hit.chat === undefined) {
                const key = hit.subject.replace(/^slack:/, '');
                if (!owners.has(key)) owners.set(key, deps.threadOwner(key));
              }
            }
            ingest(db, w0, msgs, deps.now(), ctx, (m) => {
              if (m.chat === undefined) m.chat = owners.get(m.subject.replace(/^slack:/, '')) ?? null;
              consider(w0)(m);
            });
          } catch (e) {
            recordPollError(db, w0, (e as Error).message, deps.now());
          }
        }
      } else {
        const matches = w0.source.kind === 'chats' ? evaluateChats(w0, getSignals(), deps.now(), state.turns) : evaluatePrs(w0, (prs ??= deps.prs()));
        if (!w0.poll.baselined) {
          // First tick after create, migrate or re-enable: what is already true is
          // recorded as seen, not acted on. Only what changes after this fires.
          baselineMatches(db, w0, matches, deps.now());
          continue;
        }
        for (const m of matches) if (!wasBaselined(db, w0.id, m.key)) consider(w0)(m);
        // A chats/PRs watcher "polls" on every tick: its state was just read.
        markTicked(db, w0.id, deps.now());
      }
      const w = getWatcher(db, w0.id);
      if (!w?.enabled) continue;
      for (const { id, m } of immediate) act(db, w, id, m, deps);
      if (w.action.kind === 'start_chat' && (w.source.kind !== 'slack' || w.poll.baselined)) await drainQueue(db, w, deps);
    } catch (e) {
      console.error(`[loom] watcher ${w0.id} failed:`, (e as Error).message);
      // Slack poll errors are recorded (with backoff) by recordPollError; anything
      // else that failed this tick is recorded here, so the watcher shows it.
      if (w0.source.kind !== 'slack') {
        try {
          db.prepare(`UPDATE watchers SET last_poll_at = ?, last_error = ?, error_count = error_count + 1 WHERE id = ?`).run(deps.now(), (e as Error).message.slice(0, 500), w0.id);
        } catch {
          /* the DB itself is the problem */
        }
      }
    }
  }
  if (deps.now() - state.lastPrune >= HOUR) {
    state.lastPrune = deps.now();
    pruneBriefs(deps.briefsDir, Number(safeSetting(db, 'watcher_brief_prune_days', '0')), deps.now());
  }
}

/**
 * The baseline for a chats or PRs watcher (the Slack source's first poll, for
 * state instead of messages): every current match's key goes into watcher_seen
 * and the watcher is marked baselined, in one transaction. Episode keys are
 * stable (a chat still waiting from before keeps its key), so those never fire.
 */
export function baselineMatches(db: Database.Database, w: Watcher, matches: Match[], now: number): void {
  const seen = db.prepare(`INSERT OR IGNORE INTO watcher_seen (watcher_id, ts, seen_at, baseline) VALUES (?, ?, ?, 1)`);
  db.transaction(() => {
    for (const m of matches) seen.run(w.id, m.key, now);
    db.prepare(`UPDATE watchers SET baselined = 1, last_poll_at = ?, last_ok_at = ?, last_error = '', error_count = 0 WHERE id = ?`).run(now, now, w.id);
  })();
}

/** A successful chats/PRs tick: last poll and last ok are now, and any earlier error is cleared. */
function markTicked(db: Database.Database, id: string, now: number): void {
  db.prepare(`UPDATE watchers SET last_poll_at = ?, last_ok_at = ?, last_error = '', error_count = 0 WHERE id = ?`).run(now, now, id);
}

function wasBaselined(db: Database.Database, watcherId: string, key: string): boolean {
  return !!db.prepare(`SELECT 1 FROM watcher_seen WHERE watcher_id = ? AND ts = ? AND baseline = 1`).get(watcherId, key);
}

function safeBool(db: Database.Database, key: string, fallback: boolean): boolean {
  try {
    const v = getSetting(db, key as never);
    return typeof v === 'boolean' ? v : fallback;
  } catch {
    return fallback;
  }
}

/** Delete per-match brief copies older than `days` (0 = keep forever). Returns how many went. */
export function pruneBriefs(dir: string, days: number, now: number): number {
  if (!(days > 0)) return 0;
  let n = 0;
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = now - days * 86_400_000;
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const f = path.join(dir, name);
    try {
      if (fs.statSync(f).mtimeMs < cutoff) {
        fs.rmSync(f);
        n++;
      }
    } catch {
      /* raced with another delete */
    }
  }
  return n;
}

/* ------------------------------------------------------------ Test */

export interface TestDeps {
  /** The last ~200 channel messages. */
  recent(channel: string): Promise<SlackMessage[]>;
  slackOn(): boolean;
  slackSelf(): string;
  chats(): ChatSignal[];
  prs(): PrState[];
  now(): number;
}

export interface TestRow {
  key: string;
  subject: string;
  title: string;
  permalink: string;
}

/**
 * Evaluate a draft's trigger against recent items. Writes nothing and acts on
 * nothing: no watcher_seen, no events, no edge memo.
 */
export async function testWatcher(w: Watcher, deps: TestDeps, ignoreSelf = true): Promise<{ ok: true; rows: TestRow[]; scanned: number } | { ok: false; detail: string }> {
  let matches: Match[] = [];
  let scanned = 0;
  if (w.source.kind === 'slack') {
    if (!deps.slackOn()) return { ok: false, detail: 'Slack is not connected (Direct), so Slack watchers cannot be tested' };
    const channel = slackChannel(w);
    if (!channel) return { ok: false, detail: 'choose a Slack channel first' };
    const msgs = await deps.recent(channel);
    scanned = msgs.length;
    const ctx = { selfUserId: deps.slackSelf(), ignoreSelf };
    matches = msgs.map((m) => slackMatch(w, m, ctx)).filter((m): m is Match => !!m);
  } else if (w.source.kind === 'chats') {
    const sigs = deps.chats();
    scanned = sigs.length;
    matches = evaluateChats(w, sigs, deps.now(), newTurnMemo(), { test: true });
  } else {
    const prs = deps.prs();
    scanned = prs.length;
    matches = evaluatePrs(w, prs);
  }
  return { ok: true, scanned, rows: matches.slice(-200).reverse().map(({ key, subject, title, permalink }) => ({ key, subject, title, permalink })) };
}

/* ------------------------------------------------------------ runtime */

const sharedState = newEngineState();

let depsFactory: (() => EngineDeps) | null = null;
let testDepsFactory: (() => TestDeps) | null = null;

/** server.ts registers the real providers (the board snapshot, pipelines, tmux, Slack). */
export function configureWatcherRuntime(f: { engine: () => EngineDeps; test: () => TestDeps }): void {
  depsFactory = f.engine;
  testDepsFactory = f.test;
}

export function runtimeTestDeps(): TestDeps | null {
  return testDepsFactory ? testDepsFactory() : null;
}

export const isDryRun = (): boolean => process.env.LOOM_WATCHERS_DRYRUN === '1';

/**
 * Start the watcher tick. Called from the Electron main process (the real
 * daemon) and from server.ts when run directly. LOOM_WATCHERS_OFF=1 skips it,
 * for a second server started only to look at the UI.
 */
export function startWatcherTicks(deps: (() => EngineDeps) | null = null): void {
  if (process.env.LOOM_WATCHERS_OFF === '1') return;
  let busy = false;
  const tick = () => {
    const make = deps ?? depsFactory;
    if (busy || !make) return;
    busy = true;
    let db: Database.Database | null = null;
    try {
      db = openDb();
    } catch (e) {
      busy = false;
      console.error('[loom] watchers: db open failed:', (e as Error).message);
      return;
    }
    const d = db;
    tickWatchers(d, make())
      .catch((e) => console.error('[loom] watcher tick failed:', (e as Error).message))
      .finally(() => {
        d.close();
        busy = false;
      });
  };
  setTimeout(tick, 5_000);
  setInterval(tick, TICK_MS);
}
