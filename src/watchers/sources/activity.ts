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
  /** True when the notification's latest activity is a comment (who/text/at are its). */
  comment: boolean;
  /** The comment's time (ms), 0 without one. */
  at: number;
  /** The comment came from a bot account, or from the user. */
  bot: boolean;
  self: boolean;
  /** The user is in the PR's requested reviewers right now. */
  requested: boolean;
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

// `author` is a comment on the user's own PR. The reason says why the user follows the thread, not
// what just happened, so githubMatches decides from the detail (a human comment, or a live review request).
const REASON_KIND: Record<string, FollowupKind> = { review_requested: 'review_requested', mention: 'mention', team_mention: 'mention', comment: 'comment', author: 'comment' };

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
/** A Remove-from-board mark (not Send & close): the board hides the chat, so reopening it would show nothing. */
function removedFromBoard(db: Database.Database, c: ChatRef): boolean {
  return !!db.prepare(`SELECT 1 FROM chat_hidden WHERE agent = ? AND session_id = ? AND via <> 'close'`).get(c.agent, c.session_id);
}

/** Off the board, not Park's, not removed, and recent enough to watch. Returns the chat's last activity, or null. */
function eligible(db: Database.Database, c: ChatRef, ctx: ActivityCtx): number | null {
  if (ctx.isLive(c.agent, c.session_id)) return null;
  if (getParked(db, c.agent, c.session_id)?.state === 'waiting') return null;
  if (removedFromBoard(db, c)) return null;
  const r = db.prepare(`SELECT last_active_at FROM chats WHERE agent = ? AND session_id = ?`).get(c.agent, c.session_id) as { last_active_at: number } | undefined;
  return r && r.last_active_at >= ctx.now - ctx.days * 86_400_000 ? r.last_active_at : null;
}

/**
 * GitHub notifications that should reopen a closed chat. `detail` is only called for ones
 * that map to an eligible chat. A notification counts when its latest activity is a
 * comment by a person other than the user, made after the chat last did anything; or,
 * with no comment, when it is a review request and the user is requested right now
 * (a push re-notifies the thread too, and must not count). A failed detail call skips
 * that one item and is reported, so the caller can retry it.
 */
export async function githubMatches(
  db: Database.Database,
  notes: GhNotification[],
  ctx: ActivityCtx,
  detail: (n: GhNotification) => Promise<GhDetail>,
): Promise<{ matches: Match[]; errors: string[] }> {
  const out: Match[] = [];
  const errors: string[] = [];
  for (const n of notes) {
    let kind = REASON_KIND[n.reason];
    if (!kind || !ctx.reasons.includes(n.reason)) continue;
    const pr = prUrlOf(n);
    if (!pr || ctx.prFinal(pr) === true) continue;
    const chat = chatForPr(db, pr);
    const lastActive = chat ? eligible(db, chat, ctx) : null;
    if (!chat || lastActive === null) continue;
    let d: GhDetail;
    try {
      d = await detail(n);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    if (d.merged) continue;
    if (d.comment) {
      if (d.bot || d.self || (d.at && d.at <= lastActive)) continue;
      if (kind === 'review_requested') kind = 'comment';
    } else if (!(kind === 'review_requested' && d.requested)) continue;
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
  return { matches: out, errors };
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
         AND NOT EXISTS (SELECT 1 FROM chat_hidden h WHERE h.agent = c.agent AND h.session_id = c.session_id AND h.via <> 'close')
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
 * The notifications feed since `since` (ISO; '' for everything unread), every page.
 * Read-only: nothing is marked read.
 */
export async function ghNotificationsVia(run: GhRunner, since: string): Promise<{ items: GhNotification[]; pollAfterMs: number }> {
  const q = 'notifications?all=false&per_page=50' + (since ? `&since=${encodeURIComponent(since)}` : '');
  const raw = (await run(['api', '--paginate', '--slurp', q])).trim();
  const pages = raw ? (JSON.parse(raw) as unknown) : [];
  const items = (Array.isArray(pages) ? pages : []).flatMap((p) => (Array.isArray(p) ? p : [p])) as GhNotification[];
  return { items, pollAfterMs: 0 };
}

type GhUser = { login?: string; type?: string };

/**
 * What a notification's PR says now: its latest comment (author, text, link, time, bot
 * or the user's own) when there is one, else the PR's author and link; whether the PR
 * is merged or closed (that ends the watch); and whether `me` is a requested reviewer.
 */
export async function ghDetailVia(run: GhRunner, me: string, n: GhNotification): Promise<GhDetail> {
  const pr = JSON.parse(await run(['api', n.subject.url])) as { merged?: boolean; state?: string; user?: GhUser; html_url?: string; requested_reviewers?: GhUser[] };
  const merged = pr.merged === true || pr.state === 'closed';
  const requested = !!me && (pr.requested_reviewers ?? []).some((u) => (u.login ?? '').toLowerCase() === me.toLowerCase());
  const c = n.subject.latest_comment_url && n.subject.latest_comment_url !== n.subject.url
    ? (JSON.parse(await run(['api', n.subject.latest_comment_url])) as { user?: GhUser; body?: string; html_url?: string; created_at?: string; submitted_at?: string })
    : null;
  if (c) {
    const login = c.user?.login ?? '';
    return {
      who: login,
      text: String(c.body ?? '').slice(0, 500),
      url: c.html_url ?? pr.html_url ?? '',
      merged,
      comment: true,
      at: Date.parse(c.created_at ?? c.submitted_at ?? '') || 0,
      bot: c.user?.type === 'Bot' || login.endsWith('[bot]'),
      self: !!me && login.toLowerCase() === me.toLowerCase(),
      requested,
    };
  }
  return { who: pr.user?.login ?? '', text: '', url: pr.html_url ?? '', merged, comment: false, at: 0, bot: false, self: false, requested };
}
