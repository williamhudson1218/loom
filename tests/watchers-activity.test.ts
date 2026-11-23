import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { getParked, parkChat, type FollowupInput, type SlackMsg } from '../src/parked.ts';
import { getWatcher, insertWatcher, validateDraft, type WatcherDraft } from '../src/watchers/model.ts';
import { newEngineState, testWatcher, tickWatchers, type ActivityDeps, type EngineDeps, type TestDeps } from '../src/watchers/engine.ts';
import {
  chatForPr,
  githubMatches,
  markThreadChecked,
  prUrlOf,
  slackMatches,
  threadsDue,
  type ActivityCtx,
  type GhNotification,
} from '../src/watchers/sources/activity.ts';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const PR = 'https://github.com/acme/app/pull/12';

let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function chat(sid: string, lastActive: number, prUrl = ''): void {
  db.prepare(
    `INSERT INTO chats (agent, session_id, project_dir, jsonl_path, started_at, ended_at, last_active_at, message_count, jsonl_mtime, last_indexed_at, pr_url)
     VALUES ('claude', ?, '/p', '/p/x.jsonl', ?, ?, ?, 1, ?, ?, ?)`,
  ).run(sid, lastActive, lastActive, lastActive, lastActive, lastActive, prUrl);
}
function startedFor(sid: string, prUrls: string, at = NOW - DAY): void {
  db.prepare(`INSERT INTO watcher_events (watcher_id, event_key, detected_at, decision, result, session_id, vars_json, acted_at) VALUES ('w', ?, ?, 'fired', 'started', ?, ?, ?)`).run(
    `k-${sid}`, at, sid, JSON.stringify({ PR_URLS: prUrls }), at,
  );
}
function thread(sid: string, channel: string, ts: string): void {
  db.prepare(`INSERT INTO slack_threads (thread_key, url, session_id, created_at) VALUES (?, ?, ?, 0)`).run(`${channel}/${ts}`, `https://w.slack.com/archives/${channel}/p${ts.replace('.', '')}`, sid);
}
const ctx = (over: Partial<ActivityCtx> = {}): ActivityCtx => ({
  now: NOW, days: 14, reasons: ['review_requested', 'mention', 'team_mention', 'comment'], isLive: () => false, prFinal: () => false, ...over,
});
const note = (over: Partial<GhNotification> = {}): GhNotification => ({
  id: '501', reason: 'review_requested', updated_at: '2027-01-15T08:00:00Z',
  subject: { type: 'PullRequest', title: 'Fix the thing', url: 'https://api.github.com/repos/acme/app/pulls/12', latest_comment_url: null },
  repository: { full_name: 'acme/app' }, ...over,
});
const detail = (merged = false) => async () => ({ who: 'ana', text: 'take another look', url: PR, merged });

describe('prUrlOf', () => {
  it('maps the API url to the web url, and ignores non-PR subjects', () => {
    expect(prUrlOf(note())).toBe(PR);
    expect(prUrlOf(note({ subject: { type: 'Issue', title: 'x', url: 'https://api.github.com/repos/acme/app/issues/3', latest_comment_url: null } }))).toBeNull();
  });
});

describe('chatForPr', () => {
  it('maps by the watcher event PR_URLS before chats.pr_url, newest first', () => {
    chat('fromEvent', NOW - DAY);
    chat('fromPrUrl', NOW - 1000, PR);
    startedFor('fromEvent', `${PR} https://github.com/acme/app/pull/13`);
    expect(chatForPr(db, PR)).toEqual({ agent: 'claude', session_id: 'fromEvent' });
  });
  it('does not match a longer PR number by prefix', () => {
    chat('s', NOW - DAY);
    startedFor('s', 'https://github.com/acme/app/pull/123');
    expect(chatForPr(db, PR)).toBeNull();
  });
  it('falls back to chats.pr_url', () => {
    chat('s', NOW - DAY, PR);
    expect(chatForPr(db, PR)).toEqual({ agent: 'claude', session_id: 's' });
  });
});

describe('githubMatches', () => {
  beforeEach(() => {
    chat('s', NOW - DAY);
    startedFor('s', PR);
  });
  it('keeps only aimed-at-me reasons', async () => {
    const reasons = ['review_requested', 'mention', 'team_mention', 'comment', 'author', 'state_change', 'ci_activity', 'subscribed'];
    const ms = await githubMatches(db, reasons.map((r, i) => note({ id: String(i), reason: r })), ctx(), detail());
    expect(ms.map((m) => m.vars.KIND)).toEqual(['review_requested', 'mention', 'mention', 'comment']);
  });
  it('builds the match the engine records and the action reads', async () => {
    const [m] = await githubMatches(db, [note()], ctx(), detail());
    expect(m).toEqual({
      key: 'gh:501@2027-01-15T08:00:00Z', subject: 'claude:s', title: 'ana re-requested your review', permalink: PR,
      chat: { agent: 'claude', session_id: 's' },
      vars: { KIND: 'review_requested', WHO: 'ana', TEXT: 'take another look', URL: PR, PR_URL: PR },
    });
  });
  it('drops a PR whose chat is live, parked-waiting, too old, or unmapped', async () => {
    expect(await githubMatches(db, [note()], ctx({ isLive: () => true }), detail())).toEqual([]);
    expect(await githubMatches(db, [note()], ctx({ now: NOW + 20 * DAY }), detail())).toEqual([]);
    expect(await githubMatches(db, [note({ subject: { ...note().subject, url: 'https://api.github.com/repos/acme/app/pulls/99' } })], ctx(), detail())).toEqual([]);
    parkChat(db, { agent: 'claude', sessionId: 's', draftId: 'd', channel: 'C', threadTs: '1.0', threadUrl: '', permalink: '', waitingOn: [], sentTs: '1.0', sentAt: NOW });
    expect(await githubMatches(db, [note()], ctx(), detail())).toEqual([]);
  });
  it('drops a merged or closed PR', async () => {
    expect(await githubMatches(db, [note()], ctx(), detail(true))).toEqual([]);
    expect(await githubMatches(db, [note()], ctx({ prFinal: () => true }), detail())).toEqual([]);
  });
});

describe('the Slack sweep', () => {
  it('threadsDue: owned threads of eligible chats, newest first, capped, with per-thread back-off', () => {
    chat('a', NOW - 2 * 3600_000);
    chat('b', NOW - 3600_000);
    chat('old', NOW - 20 * DAY);
    chat('live', NOW - 3600_000);
    thread('a', 'C1', '100.000001');
    thread('b', 'C1', '200.000001');
    thread('old', 'C1', '300.000001');
    thread('live', 'C1', '400.000001');
    const c = ctx({ isLive: (_a, sid) => sid === 'live' });
    expect(threadsDue(db, c, 40).map((t) => t.session_id)).toEqual(['b', 'a']);
    expect(threadsDue(db, c, 1).map((t) => t.session_id)).toEqual(['b']);
    markThreadChecked(db, 'C1/200.000001', NOW);
    expect(threadsDue(db, c, 40).map((t) => t.session_id)).toEqual(['a']);
    expect(threadsDue(db, ctx({ now: NOW + 5 * 60_000 + 1 }), 40).map((t) => t.session_id)).toContain('b');
  });
  it('threadsDue skips a chat whose PR is final', () => {
    chat('a', NOW - 3600_000, PR);
    thread('a', 'C1', '100.000001');
    expect(threadsDue(db, ctx({ prFinal: (u) => u === PR }), 40)).toEqual([]);
  });
  it('threadsDue carries the chat activity as since_ts', () => {
    chat('a', 1_700_000_000_500);
    thread('a', 'C1', '100.000001');
    expect(threadsDue(db, ctx({ now: 1_700_000_100_000 }), 40)[0]).toMatchObject({ channel: 'C1', thread_ts: '100.000001', since_ts: '1700000000.500000' });
  });
  it('slackMatches: only replies after since_ts, not mine, not bots', () => {
    const t = { agent: 'claude' as const, session_id: 's', channel: 'C1', thread_ts: '100.000001', url: 'https://w.slack.com/archives/C1/p100000001', since_ts: '150.000000' };
    const msgs: SlackMsg[] = [
      { ts: '100.000001', user: 'UX', text: 'root' },
      { ts: '140.000000', user: 'UX', text: 'before close' },
      { ts: '160.000000', user: 'UME', text: 'mine' },
      { ts: '170.000000', bot_id: 'B1', text: 'bot' },
      { ts: '180.000000', user: 'UX', text: 'a real follow-up' },
    ];
    expect(slackMatches(t, msgs, 'UME')).toEqual([{
      key: 'slack:C1/180.000000', subject: 'claude:s', title: 'UX replied', permalink: 'https://w.slack.com/archives/C1/p180000000?thread_ts=100.000001',
      chat: { agent: 'claude', session_id: 's' },
      vars: { KIND: 'thread_reply', WHO: 'UX', TEXT: 'a real follow-up', URL: 'https://w.slack.com/archives/C1/p180000000?thread_ts=100.000001', CHANNEL: 'C1', THREAD_TS: '100.000001' },
    }]);
  });
});

describe('the activity source in the engine', () => {
  const draft = (over: Partial<WatcherDraft> = {}): WatcherDraft => ({
    label: 'Follow-ups', enabled: true, run_mode: 'live',
    source: { kind: 'activity', params: {} }, trigger: { kind: 'aimed_at_me', params: {} }, action: { kind: 'reopen_chat', params: {} },
    max_per_hour: 0, cooldown_min: 0, ...over,
  });
  const add = (over: Partial<WatcherDraft> = {}) => {
    const v = validateDraft(draft(over));
    if (!v.ok) throw new Error(v.detail);
    return insertWatcher(db, v.draft, NOW - DAY);
  };
  type Calls = { since: string[]; reopened: FollowupInput[]; replies: string[] };
  function deps(over: { notes?: () => GhNotification[]; ghFail?: string; slackFail?: string; msgs?: SlackMsg[]; now?: number } = {}): EngineDeps & { calls: Calls } {
    const calls: Calls = { since: [], reopened: [], replies: [] };
    const activity: ActivityDeps = {
      ghNotifications: async (since) => {
        calls.since.push(since);
        if (over.ghFail) throw new Error(over.ghFail);
        return { items: over.notes?.() ?? [], pollAfterMs: 60_000 };
      },
      ghDetail: async () => ({ who: 'ana', text: 'look again', url: PR, merged: false }),
      slackReplies: async (channel, ts) => {
        calls.replies.push(`${channel}/${ts}`);
        if (over.slackFail) throw new Error(over.slackFail);
        return over.msgs ?? [];
      },
      isLive: () => false,
      reopenChat: (f) => { calls.reopened.push(f); return { ok: true, detail: '' }; },
    };
    const none = () => { throw new Error('not in this test'); };
    return {
      now: () => over.now ?? NOW, history: none, slackOn: () => true, slackSelf: () => 'UME', threadOwner: () => null, chats: () => [], prs: () => [], work: none,
      world: () => ({ panes: [], focused: null }), launch: none, acquireManaged: none, launchSettings: none, relay: none,
      notify: () => true, tellOrch: () => true, dryRun: false, briefsDir: '/nonexistent', activity, calls,
    } as unknown as EngineDeps & { calls: Calls };
  }
  beforeEach(() => {
    chat('s', NOW - DAY);
    startedFor('s', PR);
  });

  it('first poll baselines, later polls fire reopen_chat once', async () => {
    const id = add();
    let notes = [note()];
    const d = deps({ notes: () => notes });
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.reopened).toEqual([]);
    expect(getWatcher(db, id)!.poll.baselined).toBe(true);
    db.prepare(`UPDATE watchers SET next_poll_at = 0 WHERE id = ?`).run(id);
    notes = [note(), note({ id: '502', reason: 'comment', updated_at: '2027-01-15T09:00:00Z' })];
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.reopened).toEqual([{ agent: 'claude', sessionId: 's', kind: 'comment', who: 'ana', text: 'look again', url: PR, at: NOW }]);
    expect(db.prepare(`SELECT result FROM watcher_events WHERE watcher_id = ? AND event_key LIKE 'gh:502%'`).get(id)).toEqual({ result: 'reopened' });
  });

  it('watermark is the newest updated_at seen, passed as since next time', async () => {
    const id = add();
    const d = deps({ notes: () => [note(), note({ id: '7', updated_at: '2027-01-16T00:00:00Z' })] });
    await tickWatchers(db, d, newEngineState());
    db.prepare(`UPDATE watchers SET next_poll_at = 0 WHERE id = ?`).run(id);
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.since).toEqual(['', '2027-01-16T00:00:00Z']);
  });

  it('waits for its next poll time', async () => {
    add();
    const d = deps();
    await tickWatchers(db, d, newEngineState());
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.since).toHaveLength(1);
  });

  it('in Shadow records would_fire and reopens nothing', async () => {
    const id = add({ run_mode: 'shadow' });
    let notes: GhNotification[] = [];
    const d = deps({ notes: () => notes });
    await tickWatchers(db, d, newEngineState());
    db.prepare(`UPDATE watchers SET next_poll_at = 0 WHERE id = ?`).run(id);
    notes = [note()];
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.reopened).toEqual([]);
    expect(db.prepare(`SELECT decision FROM watcher_events WHERE watcher_id = ?`).all(id)).toEqual([{ decision: 'would_fire' }]);
  });

  it('a gh failure sets last_error and the Slack half still runs', async () => {
    const id = add();
    chat('t', NOW - 3600_000);
    thread('t', 'C1', '100.000001');
    const d = deps({ ghFail: 'gh: not logged in' });
    await tickWatchers(db, d, newEngineState());
    expect(getWatcher(db, id)!.poll.last_error).toContain('GitHub: gh: not logged in');
    expect(d.calls.replies).toEqual(['C1/100.000001']);
  });

  it('a Slack failure sets last_error and GitHub still runs', async () => {
    const id = add();
    chat('t', NOW - 3600_000);
    thread('t', 'C1', '100.000001');
    const d = deps({ slackFail: 'slack not connected' });
    await tickWatchers(db, d, newEngineState());
    expect(getWatcher(db, id)!.poll.last_error).toBe('Slack: slack not connected');
    expect(d.calls.since).toEqual(['']);
  });

  it('a Slack reply on a closed chat reopens it, only replies after the watcher existed', async () => {
    const id = add();
    chat('t', NOW - 3 * DAY);
    thread('t', 'C1', '100.000001');
    const after = ((NOW - 3600_000) / 1000).toFixed(6);
    const before = ((NOW - 2 * DAY) / 1000).toFixed(6);
    let msgs: SlackMsg[] = [];
    const d = deps({});
    d.activity!.slackReplies = async () => msgs;
    await tickWatchers(db, d, newEngineState());
    db.prepare(`UPDATE watchers SET next_poll_at = 0 WHERE id = ?`).run(id);
    db.prepare(`DELETE FROM followup_threads`).run();
    msgs = [{ ts: before, user: 'UX', text: 'old, before the watcher' }, { ts: after, user: 'UX', text: 'new follow-up' }];
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.reopened.map((f) => [f.kind, f.text, f.channel, f.threadTs])).toEqual([['thread_reply', 'new follow-up', 'C1', '100.000001']]);
  });

  it('validateDraft refuses reopen_chat on a slack source and activity with start_chat', () => {
    expect(validateDraft(draft({ source: { kind: 'slack', params: { channel: '', workspace: '' } }, trigger: { kind: 'mentions-me', params: {} } })).ok).toBe(false);
    expect(validateDraft(draft({ action: { kind: 'start_chat', params: { project_dir: '/p', target: 'managed', brief_template: 'x', perm: 'inherit' } } })).ok).toBe(false);
    expect(validateDraft(draft({ action: { kind: 'notify', params: { template: '' } } })).ok).toBe(true);
  });

  it('Test explains that Shadow is the way to try it', async () => {
    const w = getWatcher(db, add())!;
    expect(await testWatcher(w, {} as TestDeps)).toMatchObject({ ok: false, detail: expect.stringContaining('Shadow') });
  });

  it('reopen goes through reopenForFollowup in a real DB', async () => {
    const { reopenForFollowup } = await import('../src/parked.ts');
    expect(reopenForFollowup(db, { agent: 'claude', sessionId: 's', kind: 'comment', who: 'ana', text: 'x', url: PR, at: NOW })).toEqual({ ok: true, reopened: true });
    expect(getParked(db, 'claude', 's')?.state).toBe('replied');
  });
});
