import type { DraftEmail, EmailAdapter } from './outboxemail.ts';
import { addressOf, gmailThreadUrl, ownAddresses } from './outboxemail.ts';
import type { DraftReview, GhRun } from './outboxreview.ts';

// The freshness check: before a draft goes out, look at where it is going and
// say whether anything landed there since it was drafted that the person has not
// seen. Every target the draft has is checked: its Slack thread (or, for a
// top-level post, the channel), its email thread, its PR. A message from the
// person themself never counts (Slack: their user id; email: their own address or
// the SENT label; GitHub: their login).
//
// "Since it was drafted" is the draft's `seen`: what was last in each target when
// the draft was recorded (passed by the chat, or fetched by Loom at add time).
// A draft with no `seen` for a target falls back to its created_at.

export interface Seen {
  /** ms: when this was recorded. */
  at: number;
  /** Latest Slack ts in the thread (or the channel, for a top-level post). */
  slack?: string;
  /** Latest message in the email thread. */
  email?: { id: string; at: number };
  /** Latest review / comment on the PR: its ISO time and id. */
  github?: { at: string; id: string };
}

export interface FreshItem {
  /** Stable per item ('slack:<ts>', 'email:<id>', 'gh:<kind>:<id>'): an acknowledgement names these. */
  id: string;
  kind: 'slack' | 'email' | 'github';
  author: string;
  /** ms */
  at: number;
  snippet: string;
  url?: string;
}

export type FreshResult = { ok: true; items: FreshItem[] } | { ok: false; error: string; items: FreshItem[] };

export interface SlackMsgLite {
  ts: string;
  user?: string;
  bot_id?: string;
  subtype?: string;
  text?: string;
}

export interface GhItem {
  id: string;
  kind: 'review' | 'comment' | 'review_comment';
  author: string;
  at: string; // ISO
  body: string;
  url: string;
}

/** The reads a check makes. Every one is read-only. The live set is in server.ts; tests pass stubs. */
export interface FreshDeps {
  slackMe?: () => Promise<string>;
  slackReplies?: (channel: string, threadTs: string) => Promise<SlackMsgLite[]>;
  /** Messages in a channel after `oldest` (a ts): a top-level post's check. */
  slackHistory?: (channel: string, oldest: string) => Promise<SlackMsgLite[]>;
  slackNames?: () => Record<string, string>;
  email?: EmailAdapter | null;
  ghMe?: () => Promise<string>;
  ghActivity?: (repo: string, pr: number) => Promise<GhItem[]>;
}

/** The parts of a draft a check looks at. */
export interface FreshTarget {
  id?: string;
  channel: string;
  thread_ts?: string;
  thread_url?: string;
  created_at: string;
  review?: DraftReview;
  email?: DraftEmail;
  seen?: Seen;
  /** Slack messages already posted by an interrupted send: the person's own, never "new". */
  sent_parts?: { ts: string }[];
}

const IGNORED_SUBTYPES = new Set(['channel_join', 'channel_leave', 'channel_topic', 'channel_purpose', 'channel_name', 'pinned_item', 'bot_add', 'bot_remove']);
const SLACK_ID = /^[CGD][A-Z0-9]{6,}$/;

const createdMs = (t: FreshTarget): number => {
  const ms = Date.parse(t.created_at);
  return isNaN(ms) ? 0 : ms;
};

const clip = (s: string, max = 160): string => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > max ? one.slice(0, max - 1) + '…' : one;
};

/** Does this draft post to Slack (a resolved channel id; a #name or @user cannot be read before it is resolved)? */
const slackTarget = (t: FreshTarget): boolean => !!t.channel && SLACK_ID.test(t.channel);

/** Slack ts to ms. */
const tsMs = (ts: string): number => Math.round(Number(ts) * 1000);

/** Slack: what came after the baseline from someone other than the person. */
async function slackNew(t: FreshTarget, deps: FreshDeps): Promise<FreshItem[]> {
  if (!slackTarget(t) || !deps.slackMe) return [];
  const base = t.seen?.slack ?? (createdMs(t) / 1000).toFixed(6);
  const me = await deps.slackMe();
  if (!me) throw new Error('Slack did not say who you are');
  let msgs: SlackMsgLite[];
  if (t.thread_ts) {
    if (!deps.slackReplies) return [];
    msgs = await deps.slackReplies(t.channel, t.thread_ts);
  } else {
    if (!deps.slackHistory) return [];
    msgs = await deps.slackHistory(t.channel, base);
  }
  const own = new Set((t.sent_parts ?? []).map((p) => p.ts));
  const names = deps.slackNames?.() ?? {};
  const linkBase = (t.thread_url ?? '').split('?')[0].replace(/\/p\d+$/, '');
  return msgs
    .filter((m) => Number(m.ts) > Number(base) && m.user !== me && !own.has(m.ts) && !(m.subtype && IGNORED_SUBTYPES.has(m.subtype)) && (!!m.user || !!m.bot_id))
    .sort((a, b) => Number(a.ts) - Number(b.ts))
    .map((m) => ({
      id: 'slack:' + m.ts,
      kind: 'slack' as const,
      author: (m.user && names[m.user]) || m.user || 'an app',
      at: tsMs(m.ts),
      snippet: clip(m.text ?? ''),
      ...(linkBase ? { url: `${linkBase}/p${m.ts.replace('.', '')}${t.thread_ts ? `?thread_ts=${t.thread_ts}&cid=${t.channel}` : ''}` } : {}),
    }));
}

/** Email: messages in the thread after the baseline, not from the account itself and not unsent drafts. */
async function emailNew(t: FreshTarget, deps: FreshDeps): Promise<FreshItem[]> {
  const e = t.email;
  if (!e?.threadId) return [];
  if (!deps.email) throw new Error('email is not set up, so the thread cannot be read');
  const [msgs, mine] = await Promise.all([deps.email.thread(e.threadId, e.account), ownAddresses(deps.email, e.account)]);
  const me = new Set([...mine, ...(e.from ? [addressOf(e.from)] : [])].filter(Boolean));
  let after = msgs;
  const idx = t.seen?.email ? msgs.findIndex((m) => m.id === t.seen!.email!.id) : -1;
  if (idx >= 0) after = msgs.slice(idx + 1);
  else {
    const base = t.seen?.email?.at ?? createdMs(t);
    after = msgs.filter((m) => m.at > base);
  }
  return after
    .filter((m) => !(m.labels ?? []).includes('DRAFT') && !(m.labels ?? []).includes('SENT') && !me.has(addressOf(m.from)))
    .map((m) => ({ id: 'email:' + m.id, kind: 'email' as const, author: m.from || 'someone', at: m.at, snippet: clip(m.snippet), url: gmailThreadUrl(e.threadId!) }));
}

/** GitHub: reviews and comments on the PR after the baseline, not by the person. */
async function githubNew(t: FreshTarget, deps: FreshDeps): Promise<FreshItem[]> {
  const r = t.review;
  if (!r || !deps.ghActivity || !deps.ghMe) return [];
  const [items, me] = await Promise.all([deps.ghActivity(r.repo, r.pr), deps.ghMe()]);
  if (!me) throw new Error('gh did not say who you are');
  const base = t.seen?.github ? Date.parse(t.seen.github.at) : createdMs(t);
  const seenId = t.seen?.github?.id;
  return items
    .filter((i) => Date.parse(i.at) > base && i.id !== seenId && i.author.toLowerCase() !== me.toLowerCase())
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .map((i) => ({ id: `gh:${i.kind}:${i.id}`, kind: 'github' as const, author: i.author, at: Date.parse(i.at), snippet: clip(i.body) || (i.kind === 'review' ? '(review with no body)' : ''), url: i.url }));
}

/**
 * Everything new in the draft's targets. A target that cannot be read makes the
 * whole check fail (with whatever the others found), so a send never goes out
 * on a check that did not happen.
 */
export async function checkFresh(t: FreshTarget, deps: FreshDeps): Promise<FreshResult> {
  const parts = await Promise.allSettled([slackNew(t, deps), emailNew(t, deps), githubNew(t, deps)]);
  const items = parts.flatMap((p) => (p.status === 'fulfilled' ? p.value : [])).sort((a, b) => a.at - b.at);
  const errs = parts.flatMap((p, i) => (p.status === 'rejected' ? [`${['Slack', 'email', 'GitHub'][i]}: ${(p.reason as Error)?.message ?? p.reason}`] : []));
  return errs.length ? { ok: false, error: errs.join('; '), items } : { ok: true, items };
}

/** Items the person has not acknowledged. `ack` true acknowledges everything; a list acknowledges those ids. */
export const unacked = (items: FreshItem[], ack: boolean | string[] | undefined): FreshItem[] =>
  ack === true ? [] : Array.isArray(ack) ? items.filter((i) => !ack.includes(i.id)) : items;

/**
 * What is in each target right now, for `seen` at add time. A target that cannot
 * be read is left out (the check then falls back to created_at for it).
 */
export async function currentSeen(t: FreshTarget, deps: FreshDeps, now: number = Date.now()): Promise<Seen> {
  const seen: Seen = { at: now };
  const jobs: Promise<void>[] = [];
  if (slackTarget(t)) {
    jobs.push((async () => {
      const msgs = t.thread_ts
        ? deps.slackReplies ? await deps.slackReplies(t.channel, t.thread_ts) : []
        : deps.slackHistory ? await deps.slackHistory(t.channel, ((createdMs(t) - 3_600_000) / 1000).toFixed(6)) : [];
      const last = msgs.map((m) => m.ts).sort((a, b) => Number(a) - Number(b)).pop();
      if (last) seen.slack = last;
      else if (t.thread_ts) seen.slack = t.thread_ts;
    })());
  }
  if (t.email?.threadId && deps.email) {
    const e = t.email;
    jobs.push((async () => {
      const msgs = await deps.email!.thread(e.threadId!, e.account);
      const last = msgs[msgs.length - 1];
      if (last) seen.email = { id: last.id, at: last.at };
    })());
  }
  if (t.review && deps.ghActivity) {
    const r = t.review;
    jobs.push((async () => {
      const items = await deps.ghActivity!(r.repo, r.pr);
      const last = items.slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).pop();
      if (last) seen.github = { at: last.at, id: `${last.id}` };
      else seen.github = { at: new Date(now).toISOString(), id: '' };
    })());
  }
  await Promise.allSettled(jobs);
  return seen;
}

/** A `seen` from the chat (`loom outbox add --seen`): only the well-formed parts survive. */
export function cleanSeen(v: unknown, now: number = Date.now()): Seen | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
  const out: Seen = { at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : now };
  if (typeof r.slack === 'string' && /^\d{10}\.\d{6}$/.test(r.slack)) out.slack = r.slack;
  const e = r.email as Record<string, unknown> | undefined;
  if (typeof e === 'string' && /^[0-9a-f]{6,32}$/i.test(e)) out.email = { id: e, at: 0 };
  else if (e && typeof e === 'object' && typeof e.id === 'string' && /^[0-9a-f]{6,32}$/i.test(e.id)) out.email = { id: e.id, at: Number(e.at) || 0 };
  const g = r.github as Record<string, unknown> | undefined;
  if (g && typeof g === 'object' && typeof g.at === 'string' && !isNaN(Date.parse(g.at))) out.github = { at: g.at, id: typeof g.id === 'string' || typeof g.id === 'number' ? String(g.id) : '' };
  return out.slack || out.email || out.github ? out : null;
}

/* ------------------------------------------------------------------- GitHub */

/** The PR's reviews, conversation comments and inline comments, through the person's own gh. */
export function ghActivityVia(run: GhRun): (repo: string, pr: number) => Promise<GhItem[]> {
  type U = { login?: string } | null;
  const get = async <T>(p: string): Promise<T[]> => {
    const j = JSON.parse(await run(['api', p])) as unknown;
    return Array.isArray(j) ? (j as T[]) : [];
  };
  return async (repo, pr) => {
    const [reviews, comments, inline] = await Promise.all([
      get<{ id: number; user?: U; submitted_at?: string; body?: string; html_url?: string; state?: string }>(`repos/${repo}/pulls/${pr}/reviews?per_page=100`),
      get<{ id: number; user?: U; created_at?: string; body?: string; html_url?: string }>(`repos/${repo}/issues/${pr}/comments?per_page=100`),
      get<{ id: number; user?: U; created_at?: string; body?: string; html_url?: string }>(`repos/${repo}/pulls/${pr}/comments?per_page=100`),
    ]);
    return [
      ...reviews.filter((x) => x.state !== 'PENDING' && x.submitted_at).map((x) => ({ id: String(x.id), kind: 'review' as const, author: x.user?.login ?? '', at: x.submitted_at!, body: x.body ?? '', url: x.html_url ?? '' })),
      ...comments.filter((x) => x.created_at).map((x) => ({ id: String(x.id), kind: 'comment' as const, author: x.user?.login ?? '', at: x.created_at!, body: x.body ?? '', url: x.html_url ?? '' })),
      ...inline.filter((x) => x.created_at).map((x) => ({ id: String(x.id), kind: 'review_comment' as const, author: x.user?.login ?? '', at: x.created_at!, body: x.body ?? '', url: x.html_url ?? '' })),
    ];
  };
}

let ghLogin: { at: number; login: string } | null = null;
/** The person's GitHub login, through `gh api user`, cached an hour. */
export function ghMeVia(run: GhRun): () => Promise<string> {
  return async () => {
    if (ghLogin && Date.now() - ghLogin.at < 3_600_000) return ghLogin.login;
    const j = JSON.parse(await run(['api', 'user'])) as { login?: string };
    const login = j.login ?? '';
    if (login) ghLogin = { at: Date.now(), login };
    return login;
  };
}

/* ------------------------------------------------------------- card cache */

const cache = new Map<string, { at: number; r: FreshResult }>();
export const FRESH_TTL_MS = 60_000;

/** The card's passive check, cached a minute per draft so a re-render never re-reads. */
export async function cachedFresh(key: string, t: FreshTarget, deps: FreshDeps, now: number = Date.now()): Promise<FreshResult> {
  const hit = cache.get(key);
  if (hit && now - hit.at < FRESH_TTL_MS) return hit.r;
  let r: FreshResult;
  try {
    r = await checkFresh(t, deps);
  } catch (e) {
    r = { ok: false, error: (e as Error).message, items: [] };
  }
  cache.set(key, { at: now, r });
  return r;
}

export function clearFreshCache(key?: string): void {
  if (key) cache.delete(key);
  else cache.clear();
}
