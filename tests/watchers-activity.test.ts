import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { getParked, parkChat, type FollowupInput, type SlackMsg } from '../src/parked.ts';
import { getWatcher, insertWatcher, validateDraft, type WatcherDraft } from '../src/watchers/model.ts';
import { newEngineState, testWatcher, tickWatchers, type ActivityDeps, type EngineDeps, type TestDeps } from '../src/watchers/engine.ts';
import {
  chatForPr,
  ghDetailVia,
  ghNotificationsVia,
  githubMatches,
  markThreadChecked,
  prUrlOf,
  slackMatches,
  threadsDue,
  type ActivityCtx,
  type GhDetail,
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
const detail = (merged = false, over: Partial<GhDetail> = {}) => async (): Promise<GhDetail> => ({ who: 'ana', text: 'take another look', url: PR, merged, comment: true, at: NOW, bot: false, self: false, requested: false, ...over });
const gm = async (...a: Parameters<typeof githubMatches>) => (await githubMatches(...a)).matches;

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
    const ms = await gm(db, reasons.map((r, i) => note({ id: String(i), reason: r })), ctx({ reasons: [...ctx().reasons, 'author'] }), detail());
    expect(ms.map((m) => m.vars.KIND)).toEqual(['comment', 'mention', 'mention', 'comment', 'comment']);
  });
  it('builds the match the engine records and the action reads', async () => {
    const [m] = await gm(db, [note()], ctx(), detail(false, { comment: false, requested: true, text: '' }));
    expect(m).toEqual({
      key: 'gh:501@2027-01-15T08:00:00Z', subject: 'claude:s', title: 'ana re-requested your review', permalink: PR,
      chat: { agent: 'claude', session_id: 's' },
      vars: { KIND: 'review_requested', WHO: 'ana', TEXT: '', URL: PR, PR_URL: PR },
    });
    // A human comment on a review-request thread reads as a comment.
    const [c] = await gm(db, [note()], ctx(), detail());
    expect([c.title, c.vars.KIND]).toEqual(['ana commented', 'comment']);
  });
  it('drops a PR whose chat is live, parked-waiting, too old, or unmapped', async () => {
    expect(await gm(db, [note()], ctx({ isLive: () => true }), detail())).toEqual([]);
    expect(await gm(db, [note()], ctx({ now: NOW + 20 * DAY }), detail())).toEqual([]);
    expect(await gm(db, [note({ subject: { ...note().subject, url: 'https://api.github.com/repos/acme/app/pulls/99' } })], ctx(), detail())).toEqual([]);
    parkChat(db, { agent: 'claude', sessionId: 's', draftId: 'd', channel: 'C', threadTs: '1.0', threadUrl: '', permalink: '', waitingOn: [], sentTs: '1.0', sentAt: NOW });
    expect(await gm(db, [note()], ctx(), detail())).toEqual([]);
  });
  it('a comment by a bot or by me, or older than the chat, does not count', async () => {
    expect(await gm(db, [note({ reason: 'comment' })], ctx(), detail(false, { bot: true }))).toEqual([]);
    expect(await gm(db, [note({ reason: 'comment' })], ctx(), detail(false, { self: true }))).toEqual([]);
    expect(await gm(db, [note({ reason: 'comment' })], ctx(), detail(false, { at: NOW - 2 * DAY }))).toEqual([]);
  });
  it('with no comment, only a live review request on me counts (a push does not)', async () => {
    expect(await gm(db, [note()], ctx(), detail(false, { comment: false, requested: false }))).toEqual([]);
    expect(await gm(db, [note({ reason: 'comment' })], ctx(), detail(false, { comment: false, requested: true }))).toEqual([]);
    const [m] = await gm(db, [note()], ctx(), detail(false, { comment: false, requested: true, text: '' }));
    expect(m.vars.KIND).toBe('review_requested');
  });
  it('one failed detail call skips that item and reports it; the rest still match', async () => {
    let n = 0;
    const r = await githubMatches(db, [note({ id: '1' }), note({ id: '2' })], ctx(), async () => { if (++n === 1) throw new Error('rate limited'); return detail()(); });
    expect(r.matches.map((m) => m.key)).toEqual(['gh:2@2027-01-15T08:00:00Z']);
    expect(r.errors).toEqual(['rate limited']);
  });
  it('a chat removed from the board (not Send & close) is not reopened', async () => {
    db.prepare(`INSERT INTO chat_hidden (agent, session_id, hidden_at, via) VALUES ('claude', 's', ?, '')`).run(NOW);
    expect(await gm(db, [note()], ctx(), detail())).toEqual([]);
  });
  it('drops a merged or closed PR', async () => {
    expect(await gm(db, [note()], ctx(), detail(true))).toEqual([]);
    expect(await gm(db, [note()], ctx({ prFinal: () => true }), detail())).toEqual([]);
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
        return { items: over.notes?.() ?? [], pollAfterMs: 0 };
      },
      ghDetail: async () => ({ who: 'ana', text: 'look again', url: PR, merged: false, comment: true, at: NOW, bot: false, self: false, requested: false }),
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

  it('a GitHub failure on the first poll leaves it unbaselined, so nothing old fires once gh works', async () => {
    const id = add();
    let fail = true;
    const d = deps({ notes: () => [note()] });
    const gh = d.activity!.ghNotifications;
    d.activity!.ghNotifications = async (since) => { if (fail) throw new Error('gh: not logged in'); return gh(since); };
    await tickWatchers(db, d, newEngineState());
    expect(getWatcher(db, id)!.poll.baselined).toBe(false);
    fail = false;
    db.prepare(`UPDATE watchers SET next_poll_at = 0 WHERE id = ?`).run(id);
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.reopened).toEqual([]);
    expect(getWatcher(db, id)!.poll.baselined).toBe(true);
  });

  it('an empty first poll still sets a watermark', async () => {
    const id = add();
    await tickWatchers(db, deps(), newEngineState());
    expect(getWatcher(db, id)!.poll.watermark).toBe(new Date(NOW).toISOString());
  });

  it('a failed detail call keeps the watermark, so the item is retried next poll', async () => {
    const id = add();
    let notes: GhNotification[] = [];
    const d = deps({ notes: () => notes });
    await tickWatchers(db, d, newEngineState());
    const before = getWatcher(db, id)!.poll.watermark;
    notes = [note({ updated_at: '2099-01-01T00:00:00Z' })];
    d.activity!.ghDetail = async () => { throw new Error('rate limited'); };
    db.prepare(`UPDATE watchers SET next_poll_at = 0 WHERE id = ?`).run(id);
    await tickWatchers(db, d, newEngineState());
    expect(getWatcher(db, id)!.poll.watermark).toBe(before);
    expect(getWatcher(db, id)!.poll.last_error).toContain('rate limited');
  });

  it('with no Slack id for me, the Slack half is an error, not a guess', async () => {
    const id = add();
    chat('t', NOW - 3600_000);
    thread('t', 'C1', '100.000001');
    const d = deps();
    d.slackSelf = () => '';
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.replies).toEqual([]);
    expect(getWatcher(db, id)!.poll.last_error).toContain('Slack');
  });

  it('watermark is the newest updated_at seen, passed as since next time', async () => {
    const id = add();
    const d = deps({ notes: () => [note(), note({ id: '7', updated_at: '2027-01-16T00:00:00Z' })] });
    await tickWatchers(db, d, newEngineState());
    db.prepare(`UPDATE watchers SET next_poll_at = 0 WHERE id = ?`).run(id);
    await tickWatchers(db, d, newEngineState());
    expect(d.calls.since).toEqual(['', '2027-01-16T00:00:00Z']);
    expect(d.calls.since[0]).toBe('');
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

describe('gh adapters', () => {
  it('ghNotificationsVia reads every page, and passes since only when set', async () => {
    const calls: string[][] = [];
    const run = async (args: string[]) => {
      calls.push(args);
      return JSON.stringify([[note({ id: '1' })], [note({ id: '2' })]]);
    };
    expect((await ghNotificationsVia(run, '')).items.map((n) => n.id)).toEqual(['1', '2']);
    await ghNotificationsVia(run, '2027-01-15T08:00:00Z');
    expect(calls[0]).toEqual(['api', '--paginate', '--slurp', 'notifications?all=false&per_page=50']);
    expect(calls[1]).toEqual(['api', '--paginate', '--slurp', 'notifications?all=false&per_page=50&since=2027-01-15T08%3A00%3A00Z']);
  });
  it('ghDetailVia: a comment gives its author, body, link, time, and whether a bot or I wrote it', async () => {
    const run = async (args: string[]) => {
      const u = args[1];
      if (u.endsWith('/pulls/12')) return JSON.stringify({ merged: false, state: 'open', user: { login: 'author' }, html_url: PR, requested_reviewers: [{ login: 'me' }] });
      if (u.endsWith('/comments/9')) return JSON.stringify({ user: { login: 'ana', type: 'User' }, body: 'x'.repeat(600), html_url: PR + '#discussion_r9', created_at: '2027-01-15T08:00:00Z' });
      if (u.endsWith('/comments/10')) return JSON.stringify({ user: { login: 'claude[bot]', type: 'Bot' }, body: 'b', html_url: PR, created_at: '2027-01-15T08:00:00Z' });
      if (u.endsWith('/comments/11')) return JSON.stringify({ user: { login: 'ME', type: 'User' }, body: 'mine', html_url: PR, created_at: '2027-01-15T08:00:00Z' });
      throw new Error('unexpected ' + u);
    };
    const at = (c: string) => note({ reason: 'comment', subject: { ...note().subject, latest_comment_url: `https://api.github.com/repos/acme/app/pulls/comments/${c}` } });
    expect(await ghDetailVia(run, 'me', at('9'))).toEqual({ who: 'ana', text: 'x'.repeat(500), url: PR + '#discussion_r9', merged: false, comment: true, at: Date.parse('2027-01-15T08:00:00Z'), bot: false, self: false, requested: true });
    expect(await ghDetailVia(run, 'me', at('10'))).toMatchObject({ bot: true });
    expect(await ghDetailVia(run, 'me', at('11'))).toMatchObject({ self: true });
  });
  it('ghDetailVia: no comment names the PR author; closed counts as merged; requested reflects me', async () => {
    const run = async () => JSON.stringify({ merged: false, state: 'closed', user: { login: 'author' }, html_url: PR, requested_reviewers: [] });
    expect(await ghDetailVia(run, 'me', note())).toEqual({ who: 'author', text: '', url: PR, merged: true, comment: false, at: 0, bot: false, self: false, requested: false });
  });
});
