import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { parkChat, type SlackMsg } from '../src/parked.ts';
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
