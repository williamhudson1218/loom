import type Database from 'better-sqlite3';
import type { Agent } from '../../types.ts';
import type { Match } from '../model.ts';
import { checkDelayMs, followupLabel, getParked, repliesAfter, type FollowupKind, type SlackMsg } from '../../parked.ts';

// The activity source, for the Follow-ups watcher: things aimed at the user that land on
// a chat they have closed. Two feeds, both read-only:
//   - GitHub: the notifications feed (one call per poll), PullRequest subjects only,
//     mapped to the chat that reviewed or linked the PR.
//   - Slack: the threads owned by recently closed chats, swept in one batch per poll
//     with Park's per-thread back-off (Slack has no public "activity" feed to read instead).
// Everything here is pure over the DB and the fetched data; the engine does the I/O.

export interface GhNotification {
  id: string;
  reason: string;
  updated_at: string;
  subject: { type: string; title: string; url: string; latest_comment_url: string | null };
  repository: { full_name: string };
}

export interface ActivityCtx {
  now: number;
  /** Chats last active longer ago than this are not watched. */
  days: number;
  /** GitHub notification reasons that count as aimed at the user. */
  reasons: string[];
  isLive(agent: string, sid: string): boolean;
  /** True when the PR is merged or closed (null: not known). */
  prFinal(prUrl: string): boolean | null;
}

export interface GhDetail {
  who: string;
  text: string;
  url: string;
  merged: boolean;
}

export interface ThreadDue {
  agent: Agent;
  session_id: string;
  channel: string;
  thread_ts: string;
  url: string;
  /** Replies after this Slack ts count: the chat's last activity. */
  since_ts: string;
}

type ChatRef = { agent: Agent; session_id: string };

const REASON_KIND: Record<string, FollowupKind> = { review_requested: 'review_requested', mention: 'mention', team_mention: 'mention', comment: 'comment' };

/** `https://api.github.com/repos/o/r/pulls/12` -> `https://github.com/o/r/pull/12`; null for anything but a PR. */
export function prUrlOf(n: GhNotification): string | null {
  if (n.subject.type !== 'PullRequest') return null;
  const m = n.subject.url.match(/\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)$/);
  return m ? `https://github.com/${m[1]}/pull/${m[2]}` : null;
}

/** The chat a PR belongs to: the newest chat a watcher started for it, else the newest chat whose pr_url it is. */
export function chatForPr(db: Database.Database, prUrl: string): ChatRef | null {
  const rows = db
    .prepare(`SELECT session_id, vars_json FROM watcher_events WHERE session_id != '' AND vars_json LIKE ? ORDER BY acted_at DESC, id DESC`)
    .all(`%${prUrl}%`) as { session_id: string; vars_json: string }[];
  for (const r of rows) {
    try {
      const urls = String((JSON.parse(r.vars_json) as Record<string, unknown>).PR_URLS ?? '').split(' ');
      if (urls.includes(prUrl)) return { agent: 'claude', session_id: r.session_id };
    } catch {
      /* a malformed row is skipped */
    }
  }
  const c = db.prepare(`SELECT agent, session_id FROM chats WHERE pr_url = ? ORDER BY last_active_at DESC LIMIT 1`).get(prUrl) as ChatRef | undefined;
  return c ?? null;
}

/** Off the board, not Park's, and recent enough to watch. */
function eligible(db: Database.Database, c: ChatRef, ctx: ActivityCtx): boolean {
  if (ctx.isLive(c.agent, c.session_id)) return false;
  if (getParked(db, c.agent, c.session_id)?.state === 'waiting') return false;
  const r = db.prepare(`SELECT last_active_at FROM chats WHERE agent = ? AND session_id = ?`).get(c.agent, c.session_id) as { last_active_at: number } | undefined;
  return !!r && r.last_active_at >= ctx.now - ctx.days * 86_400_000;
}

/** GitHub notifications that should reopen a closed chat. `detail` is only called for ones that map to an eligible chat. */
export async function githubMatches(db: Database.Database, notes: GhNotification[], ctx: ActivityCtx, detail: (n: GhNotification) => Promise<GhDetail>): Promise<Match[]> {
  const out: Match[] = [];
  for (const n of notes) {
    const kind = REASON_KIND[n.reason];
    if (!kind || !ctx.reasons.includes(n.reason)) continue;
    const pr = prUrlOf(n);
    if (!pr || ctx.prFinal(pr) === true) continue;
    const chat = chatForPr(db, pr);
    if (!chat || !eligible(db, chat, ctx)) continue;
    const d = await detail(n);
    if (d.merged) continue;
    const title = followupLabel(kind, d.who);
    out.push({
      key: `gh:${n.id}@${n.updated_at}`,
      subject: `${chat.agent}:${chat.session_id}`,
      title,
      permalink: d.url,
      chat,
      vars: { KIND: kind, WHO: d.who, TEXT: d.text, URL: d.url, PR_URL: pr },
    });
  }
  return out;
}

const tsOf = (ms: number): string => (ms / 1000).toFixed(6);

/** Owned Slack threads of eligible chats whose check is due, newest chat first, at most `max`. */
export function threadsDue(db: Database.Database, ctx: ActivityCtx, max: number): ThreadDue[] {
  const rows = db
    .prepare(
      `SELECT s.thread_key, s.url, c.agent, c.session_id, c.last_active_at, c.pr_url, COALESCE(f.last_check_at, 0) AS last_check_at
       FROM slack_threads s
       JOIN chats c ON c.agent = s.agent AND c.session_id = s.session_id
       LEFT JOIN followup_threads f ON f.thread_key = s.thread_key
       WHERE s.session_id != '' AND c.last_active_at >= ?
       ORDER BY c.last_active_at DESC`,
    )
    .all(ctx.now - ctx.days * 86_400_000) as { thread_key: string; url: string; agent: Agent; session_id: string; last_active_at: number; pr_url: string; last_check_at: number }[];
  const out: ThreadDue[] = [];
  for (const r of rows) {
    if (out.length >= max) break;
    if (ctx.isLive(r.agent, r.session_id)) continue;
    if (getParked(db, r.agent, r.session_id)?.state === 'waiting') continue;
    if (r.pr_url && ctx.prFinal(r.pr_url) === true) continue;
    if (ctx.now - r.last_check_at < checkDelayMs(ctx.now - r.last_active_at)) continue;
    const slash = r.thread_key.indexOf('/');
    if (slash < 0) continue;
    out.push({ agent: r.agent, session_id: r.session_id, channel: r.thread_key.slice(0, slash), thread_ts: r.thread_key.slice(slash + 1), url: r.url, since_ts: tsOf(r.last_active_at) });
  }
  return out;
}

export function markThreadChecked(db: Database.Database, threadKey: string, now: number): void {
  db.prepare(`INSERT INTO followup_threads (thread_key, last_check_at) VALUES (?, ?) ON CONFLICT(thread_key) DO UPDATE SET last_check_at = excluded.last_check_at`).run(threadKey, now);
}

/** A reply's own link: the thread URL's host, the reply ts, and the thread it sits in. */
function replyLink(t: ThreadDue, ts: string): string {
  const base = t.url.replace(/\/archives\/.*$/, '');
  return `${base}/archives/${t.channel}/p${ts.replace('.', '')}?thread_ts=${t.thread_ts}`;
}

/** Replies in one swept thread that should reopen its chat: after the chat's last activity, from a person other than the user. */
export function slackMatches(t: ThreadDue, msgs: SlackMsg[], me: string): Match[] {
  return repliesAfter(msgs, { me, sentTs: t.since_ts }).map((r) => {
    const url = replyLink(t, r.ts);
    const who = r.user ?? '';
    return {
      key: `slack:${t.channel}/${r.ts}`,
      subject: `${t.agent}:${t.session_id}`,
      title: followupLabel('thread_reply', who),
      permalink: url,
      chat: { agent: t.agent, session_id: t.session_id },
      vars: { KIND: 'thread_reply', WHO: who, TEXT: r.text ?? '', URL: url, CHANNEL: t.channel, THREAD_TS: t.thread_ts },
    };
  });
}

/* ------------------------------------------------------------ gh adapters */

/** Runs `gh` with args and resolves stdout (outboxreview.ts's ghRun in production, a stub in tests). */
export type GhRunner = (args: string[]) => Promise<string>;

/**
 * The notifications feed since `since` (ISO; '' for everything unread), read with
 * `gh api -i` so GitHub's X-Poll-Interval header comes back too. Read-only: nothing
 * is marked read.
 */
export async function ghNotificationsVia(run: GhRunner, since: string): Promise<{ items: GhNotification[]; pollAfterMs: number }> {
  const q = 'notifications?all=false&per_page=50' + (since ? `&since=${encodeURIComponent(since)}` : '');
  const raw = await run(['api', '-i', q]);
  const cut = raw.search(/\r?\n\r?\n/);
  const head = cut < 0 ? raw : raw.slice(0, cut);
  const body = cut < 0 ? '' : raw.slice(cut).trim();
  const poll = Number(head.match(/^x-poll-interval:\s*(\d+)/im)?.[1] ?? 0) * 1000;
  if (/^HTTP\/[\d.]+ 304/.test(head) || !body) return { items: [], pollAfterMs: poll };
  const items = JSON.parse(body) as unknown;
  return { items: Array.isArray(items) ? (items as GhNotification[]) : [], pollAfterMs: poll };
}

/**
 * Who did what on a notification's PR: the latest comment's author, text and link
 * when there is one, else the PR's author and link (a review request). `merged` is
 * true for a merged or closed PR, which ends the watch.
 */
export async function ghDetailVia(run: GhRunner, n: GhNotification): Promise<GhDetail> {
  const pr = JSON.parse(await run(['api', n.subject.url])) as { merged?: boolean; state?: string; user?: { login?: string }; html_url?: string };
  const merged = pr.merged === true || pr.state === 'closed';
  const c = n.subject.latest_comment_url && n.subject.latest_comment_url !== n.subject.url
    ? (JSON.parse(await run(['api', n.subject.latest_comment_url])) as { user?: { login?: string }; body?: string; html_url?: string })
    : null;
  if (c) return { who: c.user?.login ?? '', text: String(c.body ?? '').slice(0, 500), url: c.html_url ?? pr.html_url ?? '', merged };
  return { who: pr.user?.login ?? '', text: '', url: pr.html_url ?? '', merged };
}
