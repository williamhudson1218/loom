import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { LEGACY_LAUNCH_SETTINGS, SAFE_LAUNCH_SETTINGS } from '../src/launch.ts';
import type { LanePane, WorldState } from '../src/compact.ts';
import type { SlackMessage } from '../src/slack.ts';
import type { LiveLoc } from '../src/dashboard.ts';
import { acquireManagedPane } from '../src/managed.ts';
import {
  getWatcher, insertWatcher, listWatchers, markReviewed, recentFires, setWatcherEnabled, shadowUnreviewed, unreviewedCounts, validateDraft,
  inQuietHours, deleteWatcher, attentionCount, replaceWatcher, toDraft, type Watcher, type WatcherDraft,
} from '../src/watchers/model.ts';
import { SLACK_RULES, ingest, backoffMs, slackMatch } from '../src/watchers/sources/slack.ts';
import { evaluateChats, newTurnMemo } from '../src/watchers/sources/chats.ts';
import { evaluatePrs, type PrState } from '../src/watchers/sources/prs.ts';
import { computeSignals, readPendingTool, type ChatSignal } from '../src/watchers/chatSignals.ts';
import { decide, drainQueue, newEngineState, pruneBriefs, testWatcher, tickWatchers, GLOBAL_START_CAP, type EngineDeps } from '../src/watchers/engine.ts';
import { launchCommand, pickPane, relayFromWatcher, renderBrief, tmuxLaunch, watcherPrefix } from '../src/watchers/actions.ts';
import { TEMPLATES, createFromTemplate, templateList } from '../src/watchers/templates.ts';

const NOW = 1_800_000_000_000;
const CH = 'C0TESTCHAN';

const botPost = (ts: string, n = 101): SlackMessage => ({ ts, bot_id: 'BBOT', text: `New engineering ticket: <https://tickets.example/t/${n}|#${n} Payroll export broken>` });
const chatter = (ts: string): SlackMessage => ({ ts, user: 'U123', text: 'New engineering ticket? not from the bot' });

const pane = (id: string, session: string, pi: number, command = 'zsh', extra: Partial<LanePane> = {}): LanePane => ({
  pane_id: id, tmux_session: session, window_index: '1', pane_index: String(pi), command, name: 'name-' + id.slice(1), group: '', agent: false, ...extra,
});

const slackDraft = (over: Partial<WatcherDraft> = {}): WatcherDraft => ({
  label: 'Tickets',
  enabled: true,
  run_mode: 'live',
  source: { kind: 'slack', params: { channel: CH, workspace: 'acme' } },
  trigger: { kind: 'bot-post-contains', params: { bot_ids: ['BBOT'], user_ids: [], needle: 'New engineering ticket' } },
  action: { kind: 'start_chat', params: { project_dir: '/work/app', target: 'lane:tp', brief_template: 'Look at {{TITLE}}\n{{URL}}\nDo NOT react.', perm: 'inherit' } },
  max_per_hour: 0,
  cooldown_min: 0,
  ...over,
});

function add(db: Database.Database, d: WatcherDraft, id?: string): Watcher {
  const v = validateDraft(d);
  if (!v.ok) throw new Error(v.detail);
  return getWatcher(db, insertWatcher(db, v.draft, NOW, id))!;
}

let tmp: string;
let db: Database.Database;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-watch-'));
  db = new Database(':memory:');
  applySchema(db);
});

type TestDepsOut = EngineDeps & { launches: [string, string][]; relays: unknown[][]; notes: string[]; told: string[] };
function deps(over: Partial<EngineDeps> & { panes?: LanePane[]; msgs?: SlackMessage[]; signals?: ChatSignal[]; prList?: PrState[] } = {}): TestDepsOut {
  const launches: [string, string][] = [];
  const relays: unknown[][] = [];
  const notes: string[] = [];
  const told: string[] = [];
  const d: TestDepsOut = {
    now: () => NOW,
    history: async () => over.msgs ?? [],
    slackOn: () => true,
    slackSelf: () => 'USELF',
    threadOwner: () => null,
    chats: () => over.signals ?? [],
    prs: () => over.prList ?? [],
    world: (): WorldState => ({ panes: over.panes ?? [], focused: null }),
    launch: async (p, c) => { launches.push([p, c]); },
    acquireManaged: () => ({ ok: false, detail: 'not in this test' }),
    launchSettings: () => SAFE_LAUNCH_SETTINGS,
    relay: (...a) => { relays.push(a); return { status: 'sent', detail: 'sent' }; },
    notify: (t, b) => { notes.push(`${t}: ${b}`); return true; },
    tellOrch: (_k, text) => { told.push(text); return true; },
    dryRun: false,
    briefsDir: path.join(tmp, 'briefs'),
    launches, relays, notes, told,
    ...over,
  };
  return d;
}

const sig = (over: Partial<ChatSignal> = {}): ChatSignal => ({
  agent: 'claude', session_id: 's1', key: 'claude:s1', project_dir: '/work/app', project: 'app', jsonl_path: '/nope', title: 'Fix the export',
  tags: [], state: 'waiting_on_user', live: true, working: false, pane: null, lastActive: NOW - 120_000, idleMs: 120_000, ageMs: 3_600_000,
  messageCount: 10, context: null, pendingToolSince: 0, ...over,
});

/* ------------------------------------------------------------ Slack rules */

describe('Slack trigger: bot-post-contains', () => {
  const rule = SLACK_RULES['bot-post-contains'];
  const params = { bot_ids: ['BBOT'], user_ids: ['UBOTUSER'], needle: 'New engineering ticket' };
  const ctx = { selfUserId: 'USELF', ignoreSelf: true };
  it('matches the bot by bot_id or user, with the phrase, and pulls the item title', () => {
    expect(rule(botPost('1.0'), params, ctx)).toEqual({ title: '#101 Payroll export broken' });
    expect(rule({ ts: '1', user: 'UBOTUSER', text: 'New engineering ticket created' }, params, ctx)?.title).toBe('New engineering ticket created');
  });
  it('finds the phrase in blocks when text lacks it', () => {
    expect(rule({ ts: '1', bot_id: 'BBOT', text: '', blocks: [{ type: 'section', text: { text: 'New engineering ticket' } }] }, params, ctx)).not.toBeNull();
  });
  it('rejects other authors and bot posts without the phrase', () => {
    expect(rule(chatter('1'), params, ctx)).toBeNull();
    expect(rule({ ts: '1', bot_id: 'BBOT', text: 'Ticket closed' }, params, ctx)).toBeNull();
    expect(rule(botPost('1'), { ...params, needle: '' }, ctx)).toBeNull();
  });
});

describe('Slack trigger: pr-link-post', () => {
  const pr = SLACK_RULES['pr-link-post'];
  const prParams = { repos: ['acme/app'], exclude_user_ids: ['UOWNER'] };
  const ctx = { selfUserId: '', ignoreSelf: true };
  const url = (n: number, repo = 'acme/app') => `https://github.com/${repo}/pull/${n}`;
  it("titles a bare link with the poster's words", () => {
    const m = { ts: '1', user: 'UMIKE', text: `<${url(3650)}|github.com/acme/app/pull/3650> - not able to change a role` };
    expect(pr(m, prParams, ctx)).toEqual({ title: '#3650 not able to change a role' });
  });
  it('prefers a link label that is a title, and lists every distinct PR once', () => {
    const m = { ts: '1', user: 'UCED', text: `<${url(3446)}|Probe bulk totals>\nsee also <${url(3438)}> and <${url(3446)}#discussion_r1|again>` };
    expect(pr(m, prParams, ctx)).toEqual({ title: '#3446, #3438 Probe bulk totals' });
  });
  it('skips excluded users, bots, system posts, replies and other repos', () => {
    const text = `<${url(1)}>`;
    expect(pr({ ts: '1', user: 'UOWNER', text }, prParams, ctx)).toBeNull();
    expect(pr({ ts: '1', user: 'UX', bot_id: 'B1', text }, prParams, ctx)).toBeNull();
    expect(pr({ ts: '1', user: 'UX', subtype: 'channel_join', text }, prParams, ctx)).toBeNull();
    expect(pr({ ts: '2', thread_ts: '1', user: 'UX', text }, prParams, ctx)).toBeNull();
    expect(pr({ ts: '1', user: 'UX', text: `<${url(1, 'acme/other')}>` }, prParams, ctx)).toBeNull();
    expect(pr({ ts: '1', user: 'UX', text: 'no link here' }, prParams, ctx)).toBeNull();
    expect(pr({ ts: '1', user: 'UX', text }, { repos: [] }, ctx)).toBeNull();
  });
  it('ignore-self skips your own posts', () => {
    const m = { ts: '1', user: 'USELF', text: `<${url(9)}>` };
    expect(pr(m, prParams, { selfUserId: 'USELF', ignoreSelf: true })).toBeNull();
    expect(pr(m, prParams, { selfUserId: 'USELF', ignoreSelf: false })).not.toBeNull();
  });
});

describe('Slack triggers: mentions-me and phrase', () => {
  const ctx = { selfUserId: 'USELF', ignoreSelf: true };
  it('mentions-me needs a <@self> mention by someone else', () => {
    expect(SLACK_RULES['mentions-me']({ ts: '1', user: 'UX', text: 'hey <@USELF> look' }, {}, ctx)?.title).toBe('hey @USELF look');
    expect(SLACK_RULES['mentions-me']({ ts: '1', user: 'USELF', text: 'note to <@USELF>' }, {}, ctx)).toBeNull();
    expect(SLACK_RULES['mentions-me']({ ts: '1', user: 'UX', text: 'nothing' }, {}, ctx)).toBeNull();
    expect(SLACK_RULES['mentions-me']({ ts: '1', user: 'UX', text: '<@USELF>' }, {}, { ...ctx, selfUserId: '' })).toBeNull();
  });
  it('phrase is case-insensitive and people-only unless any_author', () => {
    const p = { needle: 'Outage', any_author: false };
    expect(SLACK_RULES.phrase({ ts: '1', user: 'UX', text: 'big OUTAGE now' }, p, ctx)).not.toBeNull();
    expect(SLACK_RULES.phrase({ ts: '1', bot_id: 'B1', text: 'outage' }, p, ctx)).toBeNull();
    expect(SLACK_RULES.phrase({ ts: '1', bot_id: 'B1', text: 'outage' }, { ...p, any_author: true }, ctx)).not.toBeNull();
    expect(SLACK_RULES.phrase({ ts: '1', user: 'UX', text: 'all fine' }, p, ctx)).toBeNull();
  });
});

/* ------------------------------------------------------------ ingest + decide */

describe('Slack ingest', () => {
  const ctx = { selfUserId: '', ignoreSelf: true };
  const run = (w: Watcher, msgs: SlackMessage[], now: number) => {
    const out: string[] = [];
    const r = ingest(db, w, msgs, now, ctx, (m) => { decide(db, w, m, { now }); out.push(m.key); });
    return { ...r, keys: out };
  };
  it('baselines on the first poll: existing matches are seen, nothing is decided', () => {
    const w = add(db, slackDraft());
    const r = run(w, [botPost('1700000002.000200', 2), chatter('1700000003.000000'), botPost('1700000001.000100', 1)], 1000);
    expect(r).toMatchObject({ baseline: true, matched: 2, considered: 0 });
    const after = getWatcher(db, w.id)!;
    expect(after.poll).toMatchObject({ baselined: true, watermark: '1700000003.000000' });
    expect(db.prepare(`SELECT COUNT(*) n FROM watcher_seen`).get()).toEqual({ n: 2 });
    expect(db.prepare(`SELECT COUNT(*) n FROM watcher_events`).get()).toEqual({ n: 0 });
  });
  it('baselines an empty channel at now', () => {
    const w = add(db, slackDraft());
    run(w, [], 1_700_000_000_500);
    expect(getWatcher(db, w.id)!.poll.watermark).toBe('1700000000.500000');
  });
  it('queues new matches after the baseline and dedupes repeats', () => {
    const w0 = add(db, slackDraft());
    run(w0, [botPost('1700000001.000100', 1)], 1000);
    expect(run(getWatcher(db, w0.id)!, [botPost('1700000001.000100', 1), botPost('1700000005.000500', 5)], 2000).considered).toBe(1);
    expect(run(getWatcher(db, w0.id)!, [botPost('1700000005.000500', 5)], 3000).considered).toBe(0);
    expect(db.prepare(`SELECT event_key, title, permalink, decision, result, subject FROM watcher_events`).all()).toEqual([{
      event_key: '1700000005.000500', title: '#5 Payroll export broken', decision: 'fired', result: 'queued', subject: `slack:${CH}/1700000005.000500`,
      permalink: `https://acme.slack.com/archives/${CH}/p1700000005000500`,
    }]);
  });
  it('re-enabling re-baselines, so posts made while off are not acted on', () => {
    const w = add(db, slackDraft());
    run(w, [], 1000);
    setWatcherEnabled(db, w.id, false);
    setWatcherEnabled(db, w.id, true);
    expect(run(getWatcher(db, w.id)!, [botPost('1700000009.000000', 9)], 2000)).toMatchObject({ baseline: true, considered: 0 });
  });
  it('editing the channel or trigger re-baselines too', () => {
    const w = add(db, slackDraft());
    run(w, [], 1000);
    const v = validateDraft({ ...toDraft(getWatcher(db, w.id)!), source: { kind: 'slack', params: { channel: 'C0OTHER', workspace: 'acme' } } });
    if (!v.ok) throw new Error(v.detail);
    replaceWatcher(db, w.id, v.draft, 2000);
    expect(getWatcher(db, w.id)!.poll.baselined).toBe(false);
  });
});

describe('decide: Shadow vs Live and the safety limits', () => {
  const m = (key: string, subject = 'chat:claude:s1') => ({ key, subject, title: 't', permalink: '', vars: {} });
  it('Shadow records would_fire and acts on nothing', async () => {
    const w = add(db, slackDraft({ run_mode: 'shadow', action: { kind: 'notify', params: { template: 'x' } } }));
    expect(decide(db, w, m('a'), { now: NOW })?.decision).toBe('would_fire');
    expect(db.prepare(`SELECT mode, decision, result FROM watcher_events`).get()).toEqual({ mode: 'shadow', decision: 'would_fire', result: '' });
  });
  it('the same key is decided once', () => {
    const w = add(db, slackDraft());
    expect(decide(db, w, m('a'), { now: NOW })).not.toBeNull();
    expect(decide(db, w, m('a'), { now: NOW + 1 })).toBeNull();
  });
  it('holds past max_per_hour, and frees up an hour later', () => {
    const w = add(db, slackDraft({ max_per_hour: 2, action: { kind: 'notify', params: { template: '' } } }));
    expect(decide(db, w, m('1', 's1'), { now: NOW })?.decision).toBe('fired');
    expect(decide(db, w, m('2', 's2'), { now: NOW })?.decision).toBe('fired');
    expect(decide(db, w, m('3', 's3'), { now: NOW })?.decision).toBe('held_cap');
    expect(decide(db, w, m('4', 's4'), { now: NOW + 3_600_001 })?.decision).toBe('fired');
  });
  it('holds a second fire for the same subject inside the cooldown', () => {
    const w = add(db, slackDraft({ cooldown_min: 60, action: { kind: 'notify', params: { template: '' } } }));
    expect(decide(db, w, m('1', 'chat:claude:s1'), { now: NOW })?.decision).toBe('fired');
    expect(decide(db, w, m('2', 'chat:claude:s1'), { now: NOW + 59 * 60_000 })?.decision).toBe('held_cooldown');
    expect(decide(db, w, m('3', 'chat:claude:s2'), { now: NOW + 60_000 })?.decision).toBe('fired');
    expect(decide(db, w, m('4', 'chat:claude:s1'), { now: NOW + 61 * 60_000 })?.decision).toBe('fired');
  });
  it('quiet hours across midnight hold (and are not replayed later)', () => {
    expect(inQuietHours('22:00', '07:00', new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(inQuietHours('22:00', '07:00', new Date(2026, 0, 1, 6, 59))).toBe(true);
    expect(inQuietHours('22:00', '07:00', new Date(2026, 0, 1, 7, 0))).toBe(false);
    expect(inQuietHours('09:00', '17:00', new Date(2026, 0, 1, 12, 0))).toBe(true);
    expect(inQuietHours('09:00', '17:00', new Date(2026, 0, 1, 18, 0))).toBe(false);
    expect(inQuietHours('', '', new Date())).toBe(false);
    const w = add(db, slackDraft({ quiet_start: '22:00', quiet_end: '07:00', action: { kind: 'notify', params: { template: '' } } }));
    expect(decide(db, w, m('a'), { now: NOW, date: new Date(2026, 0, 1, 23, 0) })?.decision).toBe('held_quiet');
    expect(decide(db, w, m('a'), { now: NOW, date: new Date(2026, 0, 1, 12, 0) })).toBeNull();
  });
});

/* ------------------------------------------------------------ chats + prs triggers */

describe('chats triggers (pure, signal fixtures)', () => {
  const w = (kind: string, params: Record<string, unknown> = {}, src: Record<string, unknown> = {}): Watcher =>
    add(db, { label: kind, run_mode: 'live', source: { kind: 'chats', params: src }, trigger: { kind, params }, action: { kind: 'notify', params: { template: '' } } });
  const keys = (ww: Watcher, s: ChatSignal[], memo = newTurnMemo()) => evaluateChats(ww, s, NOW, memo).map((x) => x.key);

  it('waiting_on_user: idle in the window, live, not working', () => {
    const ww = w('waiting_on_user', { min_sec: 90, max_h: 24 });
    expect(keys(ww, [sig()])).toEqual([`claude:s1@wait${NOW - 120_000}`]);
    expect(keys(ww, [sig({ idleMs: 60_000 })])).toEqual([]);
    expect(keys(ww, [sig({ idleMs: 25 * 3_600_000 })])).toEqual([]);
    expect(keys(ww, [sig({ working: true })])).toEqual([]);
    expect(keys(ww, [sig({ live: false })])).toEqual([]);
    expect(keys(ww, [sig({ state: 'done' })])).toEqual([]);
  });
  it('done_idle after the grace period', () => {
    const ww = w('done_idle', { min: 10 });
    expect(keys(ww, [sig({ state: 'done', idleMs: 11 * 60_000 })])).toHaveLength(1);
    expect(keys(ww, [sig({ state: 'done', idleMs: 9 * 60_000 })])).toEqual([]);
  });
  it('context_over at the fraction, even while working, once per session', () => {
    const ww = w('context_over', { fraction: 0.85 });
    const ctx = (f: number) => ({ tokens: f * 200_000, limit: 200_000, model: 'm', fraction: f });
    const hit = evaluateChats(ww, [sig({ working: true, context: ctx(0.9) })], NOW, newTurnMemo());
    expect(hit.map((x) => [x.key, x.vars.PERCENT])).toEqual([['claude:s1@ctx', '90']]);
    expect(keys(ww, [sig({ context: ctx(0.8) })])).toEqual([]);
  });
  it('blocked_on_tool: a tool call without a result for min minutes', () => {
    const ww = w('blocked_on_tool', { min: 5 });
    expect(keys(ww, [sig({ working: true, pendingToolSince: NOW - 6 * 60_000 })])).toEqual([`claude:s1@tool${NOW - 6 * 60_000}`]);
    expect(keys(ww, [sig({ working: true, pendingToolSince: NOW - 4 * 60_000 })])).toEqual([]);
    expect(keys(ww, [sig({ working: true, pendingToolSince: 0 })])).toEqual([]);
  });
  it('silent_mid_turn: working but nothing written for min minutes', () => {
    const ww = w('silent_mid_turn', { min: 10 });
    expect(keys(ww, [sig({ working: true, idleMs: 11 * 60_000 })])).toHaveLength(1);
    expect(keys(ww, [sig({ working: false, idleMs: 11 * 60_000 })])).toEqual([]);
  });
  it('became_your_turn fires on the working -> idle edge only, never on first sight', () => {
    const ww = w('became_your_turn');
    const memo = newTurnMemo();
    expect(keys(ww, [sig({ working: false })], memo)).toEqual([]); // first sighting
    expect(keys(ww, [sig({ working: true })], memo)).toEqual([]);
    expect(keys(ww, [sig({ working: false })], memo)).toHaveLength(1);
    expect(keys(ww, [sig({ working: false })], memo)).toEqual([]); // still idle: no new edge
  });
  it('scopes by project and tag', () => {
    const ww = w('waiting_on_user', {}, { projects: ['app'], tags: ['urgent'] });
    expect(keys(ww, [sig({ tags: ['urgent'] })])).toHaveLength(1);
    expect(keys(ww, [sig({ tags: [] })])).toEqual([]);
    expect(keys(ww, [sig({ project: 'other', project_dir: '/x/other', tags: ['urgent'] })])).toEqual([]);
  });
});

describe('chat signals', () => {
  const live = (over: Partial<LiveLoc> = {}): LiveLoc => ({ agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a', window_index: '1', pane_index: '0', running: true, working: false, ...over });
  const chat = { agent: 'claude' as const, session_id: 's1', project_dir: '/work/app', jsonl_path: '/nope.jsonl', title: 't', claude_auto_title: '', first_message: 'x', state: 'done', started_at: NOW - 1000, last_active_at: NOW - 500, message_count: 3 };
  it('only live chats by default, never Loom’s own repo', () => {
    expect(computeSignals([chat], {}, NOW)).toEqual([]);
    expect(computeSignals([chat], { 'claude:s1': live() }, NOW)).toHaveLength(1);
    expect(computeSignals([chat], { 'claude:s1': live() }, NOW, { selfDir: '/work' })).toEqual([]);
  });
  it('reads a tool call still waiting on its result', () => {
    const f = path.join(tmp, 't.jsonl');
    const at = '2026-11-06T10:00:00.000Z';
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'assistant', timestamp: '2026-11-06T09:00:00.000Z', message: { content: [{ type: 'tool_use', id: 'a' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } }),
      JSON.stringify({ type: 'assistant', timestamp: at, message: { content: [{ type: 'tool_use', id: 'b' }] } }),
    ].join('\n'));
    expect(readPendingTool(f)).toBe(Date.parse(at));
    fs.appendFileSync(f, '\n' + JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b' }] } }));
    expect(readPendingTool(f)).toBe(0);
  });
});

describe('prs triggers', () => {
  const pr = (over: Partial<PrState> = {}): PrState => ({
    repo: 'acme/app', number: 7, title: 'Fix it', url: 'https://github.com/acme/app/pull/7', checks: 'pass', checksDetail: '', checksSig: '100',
    review: 'waiting', reviewDetail: '', reviewSig: '', final: false, chat: { agent: 'claude', session_id: 's1' }, ...over,
  });
  const w = (kind: string, src: Record<string, unknown> = {}) => add(db, { label: kind, source: { kind: 'prs', params: src }, trigger: { kind, params: {} }, action: { kind: 'message_chat', params: { template: 'x' } } });
  it('checks_red keys on the run, so a new push is a new event', () => {
    const ww = w('checks_red');
    expect(evaluatePrs(ww, [pr({ checks: 'fail', checksDetail: '1 failed: lint' })]).map((x) => [x.key, x.vars.CHECK, x.subject])).toEqual([['acme/app#7@100:checks_red', '1 failed: lint', 'pr:acme/app#7']]);
    expect(evaluatePrs(ww, [pr({ checks: 'fail', checksSig: '200' })])[0].key).toBe('acme/app#7@200:checks_red');
    expect(evaluatePrs(ww, [pr()])).toEqual([]);
  });
  it('changes_requested and approved_green', () => {
    expect(evaluatePrs(w('changes_requested'), [pr({ review: 'fail', reviewSig: '5' })])).toHaveLength(1);
    expect(evaluatePrs(w('approved_green'), [pr({ review: 'pass', reviewSig: '5' })])).toHaveLength(1);
    expect(evaluatePrs(w('approved_green'), [pr({ review: 'pass', checks: 'running' })])).toEqual([]);
  });
  it('mine_only needs an owning chat; repos filter; final PRs are skipped', () => {
    expect(evaluatePrs(w('checks_red'), [pr({ checks: 'fail', chat: null })])).toEqual([]);
    expect(evaluatePrs(w('checks_red', { mine_only: false, repos: [] }), [pr({ checks: 'fail', chat: null })])).toHaveLength(1);
    expect(evaluatePrs(w('checks_red', { repos: ['acme/other'] }), [pr({ checks: 'fail' })])).toEqual([]);
    expect(evaluatePrs(w('checks_red'), [pr({ checks: 'fail', final: true })])).toEqual([]);
  });
});

/* ------------------------------------------------------------ the loop */

describe('pickPane', () => {
  const panes = [
    pane('%1', 'loom-tp-forms-1', 0), // other lane
    pane('%2', 'loom-tp-terminals', 0), // no lane
    pane('%3', 'loom-tp-2', 0, '2.1.233', { agent: true }), // claude
    pane('%4', 'loom-tp-2', 1, 'nvim'),
    pane('%5', 'loom-tp-2', 2, 'zsh', { group: 'g1' }),
    pane('%6', 'loom-tp-3', 0, 'node'),
    pane('%7', 'loom-tp-3', 1), // focused
    pane('%8', 'loom-tp-10', 0),
    pane('%9', 'loom-tp-4', 3),
    pane('%10', 'loom-bugs', 0),
    pane('%11', 'loom-tp-4', 0, 'zsh', { agent: true }),
  ];
  it('takes the first idle shell in loom-<lane>-N order, skipping every pane it must not touch', () => {
    expect(pickPane(panes, { focused: '%7' })?.pane_id).toBe('%9');
    expect(pickPane(panes, { lane: 'bugs' })).toBeNull(); // loom-bugs has no number
  });
  it('honours exclusions and orders sessions numerically', () => {
    expect(pickPane(panes, { focused: '%7', exclude: ['%9'] })?.pane_id).toBe('%8');
    expect(pickPane(panes, { exclude: ['%8', '%9'] })?.pane_id).toBe('%7');
    expect(pickPane(panes, { focused: '%7', exclude: ['%8', '%9'] })).toBeNull();
  });
});

describe('start_chat drain', () => {
  const queue = async (w: Watcher, ...ts: string[]) => {
    await tickWatchers(db, deps({ msgs: [] }), newEngineState()); // baseline
    for (const t of ts) decide(db, getWatcher(db, w.id)!, { key: t, subject: `slack:${CH}/${t}`, title: '#5 Payroll export broken', permalink: `https://acme.slack.com/archives/${CH}/p${t.replace('.', '')}`, vars: {} }, { now: NOW });
  };
  it('stays queued with no free lane pane, then starts once one appears, with the previous brief name and vars', async () => {
    const w = add(db, slackDraft());
    await queue(w, '1700000005.000500');
    const busy = deps({ panes: [pane('%3', 'loom-tp-2', 0, '2.1.233', { agent: true })] });
    expect(await drainQueue(db, getWatcher(db, w.id)!, busy)).toEqual({ started: 0, waiting: 1 });
    expect(db.prepare(`SELECT result, detail FROM watcher_events`).get()).toEqual({ result: 'queued', detail: 'waiting for a free loom-tp pane' });

    const free = deps({ panes: [pane('%12', 'loom-tp-3', 1)], launchSettings: () => LEGACY_LAUNCH_SETTINGS });
    expect(await drainQueue(db, getWatcher(db, w.id)!, free)).toEqual({ started: 1, waiting: 0 });
    const row = db.prepare(`SELECT decision, result, pane_id, pane_name, pane_where, brief_path FROM watcher_events`).get() as Record<string, string>;
    expect(row).toMatchObject({ decision: 'fired', result: 'started', pane_id: '%12', pane_name: 'name-12', pane_where: 'loom-tp-3:1.1' });
    expect(row.brief_path).toBe(path.join(tmp, 'briefs', `${w.id}-1700000005-000500.md`));
    expect(fs.readFileSync(row.brief_path, 'utf-8')).toBe(`Look at #5 Payroll export broken\nhttps://acme.slack.com/archives/${CH}/p1700000005000500\nDo NOT react.`);
    expect(free.launches[0]).toEqual(['%12', launchCommand('/work/app', row.brief_path, 'name-12', LEGACY_LAUNCH_SETTINGS)]);

    // A just-launched pane is not reused on the next drain, even if it still looks idle.
    decide(db, getWatcher(db, w.id)!, { key: '1700000006.000000', subject: 's', title: 't', permalink: '', vars: {} }, { now: NOW });
    expect(await drainQueue(db, getWatcher(db, w.id)!, deps({ panes: [pane('%12', 'loom-tp-3', 1)] }))).toEqual({ started: 0, waiting: 1 });
  });
  it('perm overrides the watcher permission setting for this watcher only', async () => {
    const w = add(db, slackDraft({ action: { kind: 'start_chat', params: { project_dir: '/p', target: 'lane:tp', brief_template: 'b', perm: 'normal' } } }));
    await queue(w, '1.000001');
    const d = deps({ panes: [pane('%20', 'loom-tp-2', 0)], launchSettings: () => LEGACY_LAUNCH_SETTINGS });
    await drainQueue(db, getWatcher(db, w.id)!, d);
    expect(d.launches[0][1]).not.toContain('--dangerously-skip-permissions');
  });
  it('two matches in one pass land in two different panes', async () => {
    const w = add(db, slackDraft());
    await queue(w, '1700000005.000000', '1700000006.000000');
    const d = deps({ panes: [pane('%20', 'loom-tp-2', 0), pane('%21', 'loom-tp-2', 1)] });
    await drainQueue(db, getWatcher(db, w.id)!, d);
    expect(d.launches.map((l) => l[0])).toEqual(['%20', '%21']);
  });
  it('dry run picks a pane and writes the brief but types nothing (recorded as Shadow, reviewed)', async () => {
    const w = add(db, slackDraft());
    await queue(w, '1700000005.000500');
    const d = deps({ panes: [pane('%12', 'loom-tp-3', 1)], dryRun: true });
    await drainQueue(db, getWatcher(db, w.id)!, d);
    expect(d.launches).toEqual([]);
    expect(db.prepare(`SELECT mode, decision, pane_id FROM watcher_events`).get()).toEqual({ mode: 'shadow', decision: 'would_fire', pane_id: '%12' });
    expect(unreviewedCounts(db).total).toBe(0);
  });
  it('managed target: a capacity refusal holds the event (held_capacity), then it starts', async () => {
    const w = add(db, slackDraft({ action: { kind: 'start_chat', params: { project_dir: '/p', target: 'managed', brief_template: 'b {{TITLE}}', perm: 'inherit' } } }));
    await queue(w, '1.000001');
    await drainQueue(db, getWatcher(db, w.id)!, deps({ acquireManaged: () => ({ ok: false, detail: 'only 200 MB free' }) }));
    expect(db.prepare(`SELECT decision, result, detail FROM watcher_events`).get()).toEqual({ decision: 'held_capacity', result: 'queued', detail: 'waiting: only 200 MB free' });
    const d = deps({ acquireManaged: () => ({ ok: true, paneId: '%40', name: 'cozy-donut', where: 'loom-managed · cozy-donut' }) });
    expect(await drainQueue(db, getWatcher(db, w.id)!, d)).toEqual({ started: 1, waiting: 0 });
    expect(d.launches[0][0]).toBe('%40');
    expect(db.prepare(`SELECT decision, result, pane_name FROM watcher_events`).get()).toEqual({ decision: 'fired', result: 'started', pane_name: 'cozy-donut' });
  });
  it(`a global cap of ${GLOBAL_START_CAP} starts per 10 min across watchers defers the rest (capped watchers only)`, async () => {
    const capped = add(db, slackDraft({ max_per_hour: 10, action: { kind: 'start_chat', params: { project_dir: '/p', target: 'managed', brief_template: 'b', perm: 'inherit' } } }));
    await queue(capped, '1.1', '1.2', '1.3', '1.4');
    let n = 0;
    const d = deps({ acquireManaged: () => ({ ok: true, paneId: `%${50 + n++}`, name: '', where: '' }) });
    expect(await drainQueue(db, getWatcher(db, capped.id)!, d)).toEqual({ started: 3, waiting: 1 });
    expect((db.prepare(`SELECT decision FROM watcher_events WHERE event_key = '1.4'`).get() as { decision: string }).decision).toBe('held_cap');
    // A watcher whose cap is 0 (no cap, as migrated Slack watchers are) is not held by it.
    const open = add(db, slackDraft({ max_per_hour: 0, action: { kind: 'start_chat', params: { project_dir: '/p', target: 'managed', brief_template: 'b', perm: 'inherit' } } }));
    await queue(open, '2.1');
    expect(await drainQueue(db, getWatcher(db, open.id)!, d)).toEqual({ started: 1, waiting: 0 });
  });
});

describe('message_chat, notify, tell_orch', () => {
  it('message_chat goes to the chat the subject belongs to (chats source)', async () => {
    add(db, { label: 'Ctx', enabled: true, run_mode: 'live', source: { kind: 'chats', params: {} }, trigger: { kind: 'context_over', params: { fraction: 0.7 } }, action: { kind: 'message_chat', params: { template: 'context {{PERCENT}}%' } } });
    const d = deps({ signals: [sig({ session_id: 's9', key: 'claude:s9', context: { tokens: 1, limit: 1, model: '', fraction: 0.75 } })] });
    await tickWatchers(db, deps(), newEngineState()); // baseline: no chats yet
    await tickWatchers(db, d, newEngineState());
    expect(d.relays).toEqual([['Ctx', 'claude', 's9', 'context 75%']]);
    expect(db.prepare(`SELECT decision, result FROM watcher_events`).get()).toEqual({ decision: 'fired', result: 'sent' });
  });
  it('message_chat from Slack goes to the thread owner, and fails cleanly with none', async () => {
    const w = add(db, slackDraft({ action: { kind: 'message_chat', params: { template: 'new post {{TITLE}}' } } }));
    const owner = deps({ msgs: [], threadOwner: (k) => (k === `${CH}/1700000009.000000` ? { agent: 'claude', session_id: 'owner' } : null) });
    await tickWatchers(db, owner, newEngineState()); // baseline
    await tickWatchers(db, { ...owner, now: () => NOW + 61_000, history: async () => [botPost('1700000009.000000', 9), botPost('1700000010.000000', 10)] }, newEngineState());
    expect(owner.relays).toEqual([[w.label, 'claude', 'owner', 'new post #9 Payroll export broken']]);
    expect(db.prepare(`SELECT event_key, result, detail FROM watcher_events ORDER BY id`).all()).toEqual([
      { event_key: '1700000009.000000', result: 'sent', detail: 'sent' },
      { event_key: '1700000010.000000', result: 'failed', detail: 'no chat owns this' },
    ]);
  });
  it('looks thread owners up outside the poll transaction (the real lookup opens its own connection)', async () => {
    const w = add(db, slackDraft({ action: { kind: 'message_chat', params: { template: 'new post {{TITLE}}' } } }));
    const strict = deps({
      msgs: [],
      threadOwner: () => {
        if (db.inTransaction) throw new Error('database is locked');
        return { agent: 'claude', session_id: 'owner' };
      },
    });
    await tickWatchers(db, strict, newEngineState()); // baseline
    await tickWatchers(db, { ...strict, now: () => NOW + 61_000, history: async () => [botPost('1700000009.000000', 9)] }, newEngineState());
    expect(strict.relays).toEqual([[w.label, 'claude', 'owner', 'new post #9 Payroll export broken']]);
    expect(getWatcher(db, w.id)!.poll.error_count).toBe(0);
  });
  it('message_chat from a PR goes to the chat that owns the PR', async () => {
    add(db, { label: 'Red', enabled: true, run_mode: 'live', source: { kind: 'prs', params: {} }, trigger: { kind: 'checks_red', params: {} }, action: { kind: 'message_chat', params: { template: 'red {{PR}}' } } });
    const d = deps({ prList: [{ repo: 'a/b', number: 3, title: 't', url: 'u', checks: 'fail', checksDetail: '', checksSig: '1', review: '', reviewDetail: '', reviewSig: '', final: false, chat: { agent: 'codex', session_id: 'c1' } }] });
    await tickWatchers(db, deps(), newEngineState()); // baseline: no PRs yet
    await tickWatchers(db, d, newEngineState());
    expect(d.relays).toEqual([['Red', 'codex', 'c1', 'red a/b#3']]);
  });
  it('relayFromWatcher queues instead of typing into the focused pane', () => {
    const sent: string[] = [];
    const r = relayFromWatcher(db, { focused: () => '%1', resolve: () => ({ agent: 'claude', session_id: 's', pane_id: '%1', label: 'p' }), send: (_p, t) => { sent.push(t); return { ok: true, detail: '' }; }, now: () => NOW }, 'W', 'claude', 's', 'hello');
    expect(r.status).toBe('queued');
    expect(sent).toEqual([]);
    expect(db.prepare(`SELECT text, status FROM orchestrator_outbox`).get()).toEqual({ text: `${watcherPrefix('W')} hello`, status: 'queued' });
    const r2 = relayFromWatcher(db, { focused: () => '%2', resolve: () => ({ agent: 'claude', session_id: 's', pane_id: '%1', label: 'p' }), send: (_p, t) => { sent.push(t); return { ok: true, detail: '' }; }, now: () => NOW }, 'W', 'claude', 's', 'again');
    expect(r2.status).toBe('sent');
    expect(sent).toEqual([`${watcherPrefix('W')} again`]);
  });
  it('notify and tell_orch record their results; tell_orch fails when the orchestrator is off', async () => {
    add(db, { label: 'N', enabled: true, run_mode: 'live', source: { kind: 'chats', params: {} }, trigger: { kind: 'done_idle', params: { min: 1 } }, action: { kind: 'notify', params: { template: '{{CHAT_TITLE}} done' } } });
    add(db, { label: 'O', enabled: true, run_mode: 'live', source: { kind: 'chats', params: {} }, trigger: { kind: 'done_idle', params: { min: 1 } }, action: { kind: 'tell_orch', params: { template: 'tell {{CHAT_TITLE}}' } } });
    const d = deps({ signals: [sig({ state: 'done' })], tellOrch: () => false });
    await tickWatchers(db, deps(), newEngineState()); // baseline
    await tickWatchers(db, d, newEngineState());
    expect(d.notes).toEqual(['N: Fix the export done']);
    expect(db.prepare(`SELECT w.label, e.result, e.detail FROM watcher_events e JOIN watchers w ON w.id = e.watcher_id ORDER BY w.label`).all()).toEqual([
      { label: 'N', result: 'notified', detail: '' },
      { label: 'O', result: 'failed', detail: 'the orchestrator is off' },
    ]);
  });
});

describe('notify targets', () => {
  it('a watcher notify carries the chat it is about: the chat itself, or the Slack thread owner', async () => {
    add(db, { label: 'N', enabled: true, run_mode: 'live', source: { kind: 'chats', params: {} }, trigger: { kind: 'done_idle', params: { min: 1 } }, action: { kind: 'notify', params: { template: 'x' } } });
    const targets: unknown[] = [];
    const notify = (_t: string, _b: string, tg?: unknown) => { targets.push(tg); return true; };
    await tickWatchers(db, deps(), newEngineState()); // baseline
    await tickWatchers(db, deps({ signals: [sig({ state: 'done' })], notify }), newEngineState());
    expect(targets).toEqual([{ agent: 'claude', sid: expect.any(String) }]);

    const w = add(db, slackDraft({ action: { kind: 'notify', params: { template: 'y' } } }));
    // A Slack match opens the chat that owns the thread.
    const m = { key: 'k', subject: 'slack:1.2', title: 't', permalink: '', vars: {}, chat: { agent: 'claude' as const, session_id: 's9' } };
    const d = deps({ notify });
    targets.length = 0;
    const { act } = await import('../src/watchers/engine.ts');
    const eid = (db.prepare(`INSERT INTO watcher_events (watcher_id, event_key, subject, title, permalink, detected_at, decision) VALUES (?, 'k', 'slack:1.2', 't', '', 1, 'fired')`).run(w.id).lastInsertRowid) as number;
    act(db, getWatcher(db, w.id)!, eid, m, d);
    expect(targets).toEqual([{ agent: 'claude', sid: 's9' }]);
  });
});

describe('tickWatchers', () => {
  it('backs off and records the error on a Slack failure, without throwing', async () => {
    const w = add(db, slackDraft());
    const d = deps({ history: async () => { throw new Error('slack: invalid_auth'); } });
    await tickWatchers(db, d, newEngineState());
    const after = getWatcher(db, w.id)!;
    expect(after.poll).toMatchObject({ last_error: 'slack: invalid_auth', error_count: 1, baselined: false, next_poll_at: NOW + backoffMs(1) });
    await tickWatchers(db, d, newEngineState()); // not due yet: no second poll
    expect(getWatcher(db, w.id)!.poll.error_count).toBe(1);
    expect(backoffMs(50)).toBe(30 * 60_000);
  });
  it('a disabled watcher is never polled, nor any Slack watcher while Slack is not Direct, nor anything with the master switch off', async () => {
    const w = add(db, slackDraft());
    let polled = 0;
    const counting = deps({ history: async () => { polled++; return []; } });
    await tickWatchers(db, { ...counting, slackOn: () => false }, newEngineState());
    db.prepare(`INSERT INTO settings(key, value) VALUES ('watchers_enabled', 'off')`).run();
    await tickWatchers(db, counting, newEngineState());
    db.prepare(`DELETE FROM settings WHERE key = 'watchers_enabled'`).run();
    setWatcherEnabled(db, w.id, false);
    await tickWatchers(db, counting, newEngineState());
    expect(polled).toBe(0);
  });
  it('polls from the watermark after the baseline', async () => {
    add(db, slackDraft());
    const oldest: string[] = [];
    const d = deps({ history: async (_c, o) => { oldest.push(o); return [botPost('1700000001.000000', 1)]; } });
    await tickWatchers(db, d, newEngineState());
    await tickWatchers(db, { ...d, now: () => NOW + 61_000 }, newEngineState());
    expect(oldest).toEqual(['', '1700000001.000000']);
  });
  it('Shadow chat watchers fill the badge; Mark reviewed empties it', async () => {
    const w = add(db, { label: 'S', enabled: true, run_mode: 'shadow', source: { kind: 'chats', params: {} }, trigger: { kind: 'waiting_on_user', params: {} }, action: { kind: 'notify', params: { template: '' } } });
    const d = deps({ signals: [sig(), sig({ session_id: 's2', key: 'claude:s2' })] });
    await tickWatchers(db, deps(), newEngineState()); // baseline
    await tickWatchers(db, d, newEngineState());
    await tickWatchers(db, d, newEngineState()); // same episodes: no new rows
    expect(d.notes).toEqual([]);
    expect(unreviewedCounts(db)).toEqual({ total: 2, byWatcher: { [w.id]: 2 } });
    expect(shadowUnreviewed(db, w.id)).toHaveLength(2);
    expect(markReviewed(db, { watcherId: w.id }, NOW)).toBe(2);
    expect(unreviewedCounts(db).total).toBe(0);
    expect(recentFires(db, w.id)).toEqual([]); // shadow rows are not fires
  });
});

describe('chats and PRs watchers baseline on their first tick', () => {
  const waiting = [sig(), sig({ session_id: 's2', key: 'claude:s2' }), sig({ session_id: 's3', key: 'claude:s3' })];
  const eventCount = () => (db.prepare(`SELECT COUNT(*) n FROM watcher_events`).get() as { n: number }).n;
  const chatWatcher = (run_mode: 'shadow' | 'live' = 'shadow') =>
    add(db, { label: 'Wait', enabled: true, run_mode, source: { kind: 'chats', params: {} }, trigger: { kind: 'waiting_on_user', params: {} }, action: { kind: 'notify', params: { template: '' } } });

  it('a new chat watcher records what is already true as seen and fires nothing; a later transition still fires', async () => {
    const w = chatWatcher();
    const st = newEngineState();
    await tickWatchers(db, deps({ signals: waiting }), st);
    expect(eventCount()).toBe(0);
    expect(getWatcher(db, w.id)!.poll.baselined).toBe(true);
    await tickWatchers(db, deps({ signals: waiting }), st); // nothing changed
    expect(eventCount()).toBe(0);
    // s2 got an answer, worked, and is waiting again: a new episode.
    const later = [waiting[0], sig({ session_id: 's2', key: 'claude:s2', lastActive: NOW - 100_000, idleMs: 100_000 }), waiting[2], sig({ session_id: 's4', key: 'claude:s4' })];
    await tickWatchers(db, deps({ signals: later }), st);
    expect(db.prepare(`SELECT subject FROM watcher_events ORDER BY subject`).all()).toEqual([{ subject: 'chat:claude:s2' }, { subject: 'chat:claude:s4' }]);
    expect(unreviewedCounts(db).total).toBe(2);
  });
  it('the migrated EM watchers baseline too (no backfill of every chat already waiting)', async () => {
    const { convertEm } = await import('../src/migrations/watchers.ts');
    db.exec(`CREATE TABLE em_findings (id INTEGER PRIMARY KEY)`);
    db.prepare(`INSERT INTO settings(key, value) VALUES ('em_mode', 'shadow')`).run();
    convertEm({ db, now: NOW, log: () => {} });
    await tickWatchers(db, deps({ signals: [...waiting.map((s) => ({ ...s, state: 'waiting_on_user' })), sig({ session_id: 's5', key: 'claude:s5', state: 'done', idleMs: 20 * 60_000 })] }), newEngineState());
    expect(eventCount()).toBe(0);
    expect(listWatchers(db).filter((w) => w.id.startsWith('em-')).every((w) => w.poll.baselined)).toBe(true);
  });
  it('a watcher created from a template baselines on its first tick', async () => {
    const r = createFromTemplate(db, 'chat-done', { enabled: true }, NOW);
    expect(r.ok).toBe(true);
    const st = newEngineState();
    const done = [sig({ state: 'done', idleMs: 20 * 60_000 })];
    await tickWatchers(db, deps({ signals: done }), st);
    expect(eventCount()).toBe(0);
    await tickWatchers(db, deps({ signals: [...done, sig({ session_id: 's7', key: 'claude:s7', state: 'done', idleMs: 20 * 60_000 })] }), st);
    expect(db.prepare(`SELECT subject FROM watcher_events`).all()).toEqual([{ subject: 'chat:claude:s7' }]);
  });
  it('re-enabling re-baselines: what became true while it was off does not fire', async () => {
    const w = chatWatcher('live');
    const d = deps({ signals: [] });
    await tickWatchers(db, d, newEngineState());
    setWatcherEnabled(db, w.id, false);
    setWatcherEnabled(db, w.id, true);
    const n = deps({ signals: waiting });
    await tickWatchers(db, n, newEngineState());
    expect(eventCount()).toBe(0);
    expect(n.notes).toEqual([]);
    await tickWatchers(db, deps({ signals: [...waiting, sig({ session_id: 's8', key: 'claude:s8' })] }), newEngineState());
    expect(db.prepare(`SELECT subject, decision FROM watcher_events`).all()).toEqual([{ subject: 'chat:claude:s8', decision: 'fired' }]);
  });
  it('a PRs watcher baselines the same way', async () => {
    add(db, { label: 'Red', enabled: true, run_mode: 'live', source: { kind: 'prs', params: {} }, trigger: { kind: 'checks_red', params: {} }, action: { kind: 'notify', params: { template: '' } } });
    const pr = (n: number, sigv = '1'): PrState => ({ repo: 'a/b', number: n, title: 't', url: 'u', checks: 'fail', checksDetail: '', checksSig: sigv, review: '', reviewDetail: '', reviewSig: '', final: false, chat: { agent: 'claude', session_id: 's' } });
    await tickWatchers(db, deps({ prList: [pr(1)] }), newEngineState());
    expect(eventCount()).toBe(0);
    await tickWatchers(db, deps({ prList: [pr(1), pr(1, '2'), pr(2)].slice(1) }), newEngineState()); // #1 pushed and red again, #2 new
    expect(db.prepare(`SELECT event_key FROM watcher_events ORDER BY event_key`).all()).toEqual([{ event_key: 'a/b#1@2:checks_red' }, { event_key: 'a/b#2@1:checks_red' }]);
  });
});

describe('tick bookkeeping and the badge', () => {
  const chatW = (label: string, extra: Partial<WatcherDraft> = {}) =>
    add(db, { label, enabled: true, run_mode: 'shadow', source: { kind: 'chats', params: {} }, trigger: { kind: 'waiting_on_user', params: {} }, action: { kind: 'notify', params: { template: '' } }, ...extra });

  it('chats and PRs watchers record last poll / last ok on every tick, not only the first', async () => {
    const c = chatW('C');
    const p = add(db, { label: 'P', enabled: true, source: { kind: 'prs', params: {} }, trigger: { kind: 'checks_red', params: {} }, action: { kind: 'notify', params: { template: '' } } });
    const st = newEngineState();
    for (const t of [NOW, NOW + 15_000, NOW + 30_000]) await tickWatchers(db, deps({ now: () => t }), st);
    for (const id of [c.id, p.id]) expect(getWatcher(db, id)!.poll).toMatchObject({ last_poll_at: NOW + 30_000, last_ok_at: NOW + 30_000, last_error: '' });
  });
  it('a chats tick that throws records the error (it counts on the badge) and the next good tick clears it', async () => {
    const c = chatW('C');
    const st = newEngineState();
    await tickWatchers(db, deps(), st); // baseline
    await tickWatchers(db, deps({ now: () => NOW + 1, chats: () => { throw new Error('snapshot failed'); } }), st);
    expect(getWatcher(db, c.id)!.poll).toMatchObject({ last_error: 'snapshot failed', last_ok_at: NOW });
    expect(attentionCount(db)).toBe(1);
    await tickWatchers(db, deps({ now: () => NOW + 2 }), st);
    expect(getWatcher(db, c.id)!.poll).toMatchObject({ last_error: '', last_ok_at: NOW + 2 });
    expect(attentionCount(db)).toBe(0);
  });
  it('the badge counts watchers that need attention, not events', async () => {
    const a = chatW('A');
    chatW('B');
    const off = chatW('Off');
    const st = newEngineState();
    await tickWatchers(db, deps(), st); // baseline, nothing waiting
    const many = Array.from({ length: 12 }, (_, i) => sig({ session_id: 's' + i, key: 'claude:s' + i }));
    await tickWatchers(db, deps({ signals: many }), st);
    expect(unreviewedCounts(db).total).toBe(36); // 36 events, from 3 watchers
    setWatcherEnabled(db, off.id, false);
    expect(attentionCount(db)).toBe(2); // A and B; a disabled watcher is never counted
    markReviewed(db, { watcherId: a.id }, NOW);
    expect(attentionCount(db)).toBe(1);
    // A Slack watcher whose last poll errored counts too.
    const s = add(db, slackDraft());
    db.prepare(`UPDATE watchers SET last_error = 'slack: invalid_auth' WHERE id = ?`).run(s.id);
    expect(attentionCount(db)).toBe(2);
  });
});

describe('Test (POST /api/watchers/test) writes nothing', () => {
  it('slack, chats and prs drafts return would-fire rows and leave every table as it was', async () => {
    const w = add(db, slackDraft());
    const count = () => db.prepare(`SELECT (SELECT COUNT(*) FROM watcher_seen) + (SELECT COUNT(*) FROM watcher_events) + (SELECT COUNT(*) FROM orchestrator_outbox) AS n`).get();
    const before = count();
    const pollBefore = getWatcher(db, w.id)!.poll;
    const td = { recent: async () => [botPost('1.5', 5), chatter('1.6')], slackOn: () => true, slackSelf: () => '', chats: () => [sig({ working: false })], prs: () => [], now: () => NOW };
    expect(await testWatcher(w, td)).toMatchObject({ ok: true, scanned: 2, rows: [{ key: '1.5', title: '#5 Payroll export broken' }] });
    const chatW = add(db, { label: 'T', source: { kind: 'chats', params: {} }, trigger: { kind: 'became_your_turn', params: {} }, action: { kind: 'notify', params: { template: '' } } });
    expect(await testWatcher(chatW, td)).toMatchObject({ ok: true, rows: [{ subject: 'chat:claude:s1' }] });
    expect(await testWatcher(w, { ...td, slackOn: () => false })).toMatchObject({ ok: false });
    expect(count()).toEqual(before);
    expect(getWatcher(db, w.id)!.poll).toEqual(pollBefore);
  });
});

describe('templates', () => {
  it('there are 11, all generic: no person, workspace, repo, channel or house skill', () => {
    expect(TEMPLATES).toHaveLength(11);
    expect(templateList().map((t) => t.group)).toEqual(['Slack', 'Slack', 'Slack', 'Chats', 'Chats', 'Chats', 'Chats', 'Chats', 'Pull requests', 'Pull requests', 'Pull requests']);
    const text = JSON.stringify(TEMPLATES);
    for (const bad of ['Will', 'tax-pilot', 'Tax Pilot', 'will-voice', 'review-pr', 'query-prod-db', 'handling-slack-threads', 'slack-threads.py', 'loom-tp', '~/dev', 'C0B']) expect(text).not.toContain(bad);
    expect(text).toContain('{{REVIEW_SKILL}}');
  });
  it('create from a template: saved Disabled and in Shadow, and enabling needs the required fields', () => {
    for (const t of TEMPLATES) {
      const r = createFromTemplate(db, t.id, {}, NOW);
      expect(r.ok).toBe(true);
      const w = getWatcher(db, (r as { id: string }).id)!;
      expect([w.enabled, w.run_mode, w.template_id]).toEqual([false, 'shadow', t.id]);
    }
    expect(createFromTemplate(db, 'slack-pr-posts', { enabled: true }).ok).toBe(false);
    const ok = createFromTemplate(db, 'slack-pr-posts', { enabled: true, source_params: { channel: 'C0ABCDEF' }, trigger_params: { repos: ['acme/app'] }, action_params: { project_dir: '/work/app' } });
    expect(ok.ok).toBe(true);
    expect(createFromTemplate(db, 'nope').ok).toBe(false);
  });
  it('a fresh DB has zero watchers (no built-in seeding)', () => {
    expect(listWatchers(db)).toEqual([]);
  });
  it('the review brief renders the configured skill', () => {
    expect(renderBrief(TEMPLATES[0].draft.action.params!.brief_template as string, { REVIEW_SKILL: 'loom:review' })).toContain('Load the loom:review skill');
  });
});

describe('validation', () => {
  it('rejects bad drafts with a reason', () => {
    expect(validateDraft({ ...slackDraft(), trigger: { kind: 'done_idle' } })).toMatchObject({ ok: false });
    expect(validateDraft({ ...slackDraft(), action: { kind: 'start_chat', params: { project_dir: 'relative', target: 'managed', brief_template: 'x', perm: 'inherit' } } })).toMatchObject({ ok: false });
    expect(validateDraft({ ...slackDraft(), action: { kind: 'start_chat', params: { project_dir: '/p', target: 'lane:Bad Lane', brief_template: 'x', perm: 'inherit' } } })).toMatchObject({ ok: false });
    expect(validateDraft({ ...slackDraft(), quiet_start: '22:00' })).toMatchObject({ ok: false });
    expect(validateDraft({ ...slackDraft(), max_per_hour: -1 })).toMatchObject({ ok: false });
    expect(validateDraft(slackDraft())).toMatchObject({ ok: true });
  });
  it('delete removes the watcher, its seen set and its events', () => {
    const w = add(db, slackDraft());
    decide(db, w, { key: 'k', subject: 's', title: 't', permalink: '', vars: {} }, { now: NOW });
    expect(deleteWatcher(db, w.id)).toBe(true);
    expect(db.prepare(`SELECT COUNT(*) n FROM watcher_events`).get()).toEqual({ n: 0 });
  });
});

describe('launch plumbing and prune', () => {
  it('types the command literally, then Enter as a separate send-keys', async () => {
    const calls: string[][] = [];
    await tmuxLaunch('%5', 'cd x && claude', (a) => { calls.push(a); return ''; }, 0);
    expect(calls).toEqual([['send-keys', '-t', '%5', '-l', 'cd x && claude'], ['send-keys', '-t', '%5', 'Enter']]);
  });
  it('builds the claude command around the brief file (unchanged from the previous build)', () => {
    expect(launchCommand("/a/b's", '/x/brief.md', 'blue-vanilla', LEGACY_LAUNCH_SETTINGS)).toBe(`cd '/a/b'\\''s' && claude --dangerously-skip-permissions --remote-control 'blue-vanilla' "$(cat '/x/brief.md')"`);
  });
  it('prunes brief copies older than the setting; 0 keeps them', () => {
    const dir = path.join(tmp, 'b');
    fs.mkdirSync(dir);
    const old = path.join(dir, 'old.md');
    fs.writeFileSync(old, 'x');
    fs.writeFileSync(path.join(dir, 'new.md'), 'x');
    const now = Date.now();
    const t = (now - 20 * 86_400_000) / 1000;
    fs.utimesSync(old, t, t);
    expect(pruneBriefs(dir, 0, now)).toBe(0);
    expect(pruneBriefs(dir, 14, now)).toBe(1);
    expect(fs.readdirSync(dir)).toEqual(['new.md']);
  });
  it('slackMatch fills the previous build’s brief vars (TITLE, URL, CHANNEL, TS)', () => {
    const w = add(db, slackDraft());
    expect(slackMatch(w, botPost('1700000005.000500', 5), { selfUserId: '', ignoreSelf: true })?.vars).toMatchObject({ TITLE: '#5 Payroll export broken', URL: `https://acme.slack.com/archives/${CH}/p1700000005000500`, CHANNEL: CH, TS: '1700000005.000500' });
  });
});

// A real tmux server on a throwaway socket. Only that server is ever killed.
const SOCK = `loom-test-${randomBytes(4).toString('hex')}`;
const tmuxRun = (args: string[]): string => execFileSync('tmux', ['-L', SOCK, '-f', `${__dirname}/fixtures/tmux-test.conf`, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('managed-target spawn on a throwaway tmux socket', () => {
  let hasTmux = true;
  let socketPath = '';
  beforeAll(() => {
    try {
      execFileSync('tmux', ['-V']);
    } catch {
      hasTmux = false;
    }
  });
  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* never started */
    }
    if (socketPath) fs.rmSync(socketPath, { force: true });
  });
  it('a Live Slack match with target managed opens a managed window and types the launch line into it', async () => {
    if (!hasTmux) return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-proj-'));
    const w = add(db, slackDraft({ action: { kind: 'start_chat', params: { project_dir: dir, target: 'managed', brief_template: 'hello {{TITLE}}', perm: 'inherit' } } }));
    const roomy = () => ({ freeMem: 8 * 1024 ** 3, totalMem: 16 * 1024 ** 3, load1: 0, cpus: 8 });
    const d = deps({
      acquireManaged: (pd) => acquireManagedPane(pd, { run: tmuxRun, resources: roomy }),
      launch: (p, c) => tmuxLaunch(p, c, tmuxRun, 50),
      // Never a real claude: a stand-in binary that prints the brief it was given.
      launchSettings: () => ({ ...SAFE_LAUNCH_SETTINGS, claudeBin: '/bin/echo' }),
    });
    await tickWatchers(db, d, newEngineState()); // baseline
    await tickWatchers(db, { ...d, now: () => NOW + 61_000, history: async () => [botPost('1700000007.000000', 7)] }, newEngineState());
    socketPath = tmuxRun(['display-message', '-p', '#{socket_path}']).trim();
    const ev = db.prepare(`SELECT decision, result, pane_id, pane_where, brief_path FROM watcher_events`).get() as Record<string, string>;
    expect(ev).toMatchObject({ decision: 'fired', result: 'started' });
    expect(ev.pane_id).toMatch(/^%\d+$/);
    expect(ev.pane_where.startsWith('loom-managed')).toBe(true);
    expect(tmuxRun(['list-panes', '-a', '-F', '#{session_name} #{pane_id} #{pane_current_path}'])).toContain(`loom-managed ${ev.pane_id}`);
    // The launch line ran in the pane: the stand-in echoes the rendered brief.
    let screen = '';
    for (let i = 0; i < 40 && !screen.includes('hello #7'); i++) {
      await new Promise((r) => setTimeout(r, 50));
      screen = tmuxRun(['capture-pane', '-p', '-J', '-t', ev.pane_id]);
    }
    expect(screen).toContain('/bin/echo');
    expect(screen).toContain('hello #7 Payroll export broken');
    expect(fs.readFileSync(ev.brief_path, 'utf-8')).toBe('hello #7 Payroll export broken');
  });
});
