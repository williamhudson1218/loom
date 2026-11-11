import { spawn } from 'node:child_process';
import { toolBin, toolEnv } from './toolpath.ts';

// The GitHub half of an outbox draft: a pull request review (body, verdict and
// inline comments) that posts as the person, through their own `gh` login, when
// they press Send. A draft may carry a review, Slack messages, Slack reactions, or
// any mix; the send posts the review first (one call, every comment at once), then
// the Slack burst, then the reactions. Nothing here posts on its own: the runner is
// injected, and tests pass a stub.

export const REVIEW_EVENTS = ['COMMENT', 'REQUEST_CHANGES', 'APPROVE'] as const;
export type ReviewEvent = (typeof REVIEW_EVENTS)[number];

export interface ReviewComment {
  path: string;
  line: number;
  side?: 'RIGHT' | 'LEFT';
  start_line?: number;
  start_side?: 'RIGHT' | 'LEFT';
  body: string;
}

export interface DraftReview {
  repo: string; // owner/name
  pr: number;
  /** The PR head the review was drafted against. The review always posts against this commit. */
  commit_id: string;
  event: ReviewEvent;
  body: string;
  comments: ReviewComment[];
  /** Shown on the card; filled from `gh` when the draft is recorded. */
  title?: string;
  url?: string;
}

/** A Slack reaction change applied once the messages are out (the review's status signal). */
export interface DraftReaction {
  channel: string;
  ts: string;
  add?: string[];
  remove?: string[];
}

/** The review as posted: recorded on the draft the moment GitHub answers, so a retry never posts it again. */
export interface PostedReview {
  id: number;
  url: string;
  at: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
const EMOJI_RE = /^[a-z0-9_+'-]{1,64}$/;
const SIDES = ['RIGHT', 'LEFT'];
export const MAX_REVIEW_COMMENTS = 200;

const posInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0;

/** A review exactly as it will post, or the reason it is not one. */
export function cleanReview(v: unknown): { ok: true; review: DraftReview } | { ok: false; detail: string } {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, detail: 'review must be an object' };
  const repo = typeof r.repo === 'string' ? r.repo.trim() : '';
  if (!REPO_RE.test(repo)) return { ok: false, detail: 'review.repo must be owner/name' };
  const pr = typeof r.pr === 'string' && /^\d+$/.test(r.pr) ? Number(r.pr) : r.pr;
  if (!posInt(pr)) return { ok: false, detail: 'review.pr must be a PR number' };
  const commit = typeof r.commit_id === 'string' ? r.commit_id.trim() : '';
  if (!SHA_RE.test(commit)) return { ok: false, detail: 'review.commit_id must be the head commit sha' };
  const event = typeof r.event === 'string' ? r.event.trim().toUpperCase() : '';
  if (!(REVIEW_EVENTS as readonly string[]).includes(event)) return { ok: false, detail: 'review.event must be one of ' + REVIEW_EVENTS.join(', ') };
  const body = typeof r.body === 'string' ? r.body.trim() : '';
  const raw = r.comments === undefined || r.comments === null ? [] : r.comments;
  if (!Array.isArray(raw)) return { ok: false, detail: 'review.comments must be an array' };
  if (raw.length > MAX_REVIEW_COMMENTS) return { ok: false, detail: `at most ${MAX_REVIEW_COMMENTS} inline comments` };
  const comments: ReviewComment[] = [];
  for (const [i, x] of raw.entries()) {
    const c = x as Record<string, unknown> | null;
    const n = `review.comments[${i}]`;
    if (!c || typeof c !== 'object') return { ok: false, detail: `${n} must be an object` };
    const p = typeof c.path === 'string' ? c.path.trim() : '';
    if (!p) return { ok: false, detail: `${n} needs a path` };
    if (!posInt(c.line)) return { ok: false, detail: `${n} needs a line (a positive number)` };
    const text = typeof c.body === 'string' ? c.body.trim() : '';
    if (!text) return { ok: false, detail: `${n} needs a body` };
    if (c.side !== undefined && !SIDES.includes(c.side as string)) return { ok: false, detail: `${n}.side must be RIGHT or LEFT` };
    if (c.start_side !== undefined && !SIDES.includes(c.start_side as string)) return { ok: false, detail: `${n}.start_side must be RIGHT or LEFT` };
    if (c.start_line !== undefined && (!posInt(c.start_line) || c.start_line >= c.line)) return { ok: false, detail: `${n}.start_line must be a number below line` };
    comments.push({
      path: p,
      line: c.line,
      ...(c.side ? { side: c.side as 'RIGHT' | 'LEFT' } : {}),
      ...(c.start_line ? { start_line: c.start_line as number } : {}),
      ...(c.start_side ? { start_side: c.start_side as 'RIGHT' | 'LEFT' } : {}),
      body: text,
    });
  }
  // GitHub requires a body for Request changes and Comment (an Approve may be bare).
  if (!body && event !== 'APPROVE') return { ok: false, detail: 'review.body is required for ' + event };
  const title = typeof r.title === 'string' ? r.title.trim().slice(0, 300) : '';
  const url = typeof r.url === 'string' && /^https:\/\/github\.com\//.test(r.url) ? r.url : '';
  return { ok: true, review: { repo, pr, commit_id: commit, event: event as ReviewEvent, body, comments, ...(title ? { title } : {}), ...(url ? { url } : {}) } };
}

/** Reactions to apply after the messages, or the reason they are malformed. */
export function cleanReactions(v: unknown): { ok: true; reactions: DraftReaction[] } | { ok: false; detail: string } {
  if (v === undefined || v === null) return { ok: true, reactions: [] };
  if (!Array.isArray(v)) return { ok: false, detail: 'reactions must be an array' };
  const out: DraftReaction[] = [];
  for (const [i, x] of v.entries()) {
    const r = x as Record<string, unknown> | null;
    const n = `reactions[${i}]`;
    if (!r || typeof r !== 'object') return { ok: false, detail: `${n} must be an object` };
    const channel = typeof r.channel === 'string' ? r.channel.trim() : '';
    const ts = typeof r.ts === 'string' ? r.ts.trim() : '';
    if (!/^[CGD][A-Z0-9]{6,}$/.test(channel)) return { ok: false, detail: `${n} needs a channel id` };
    if (!/^\d{10}\.\d{6}$/.test(ts)) return { ok: false, detail: `${n} needs a message ts` };
    const names = (k: string): string[] | null => {
      const a = r[k] === undefined ? [] : r[k];
      if (!Array.isArray(a)) return null;
      const s = a.map((e) => (typeof e === 'string' ? e.trim().replace(/^:|:$/g, '') : ''));
      return s.every((e) => EMOJI_RE.test(e)) ? s : null;
    };
    const add = names('add');
    const remove = names('remove');
    if (!add || !remove) return { ok: false, detail: `${n}.add and .remove must be emoji names` };
    if (!add.length && !remove.length) return { ok: false, detail: `${n} adds and removes nothing` };
    out.push({ channel, ts, ...(add.length ? { add } : {}), ...(remove.length ? { remove } : {}) });
  }
  return { ok: true, reactions: out };
}

/** What one review post sends to GitHub: everything at once, no spacing. */
export function reviewPayload(r: DraftReview): Record<string, unknown> {
  return {
    commit_id: r.commit_id,
    event: r.event,
    ...(r.body ? { body: r.body } : {}),
    comments: r.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side ?? 'RIGHT',
      ...(c.start_line ? { start_line: c.start_line, start_side: c.start_side ?? c.side ?? 'RIGHT' } : {}),
      body: c.body,
    })),
  };
}

/* ------------------------------------------------------------------ gh */

/** Runs `gh` with args and optional stdin; resolves stdout, rejects with stderr. Tests pass a stub. */
export type GhRun = (args: string[], input?: string) => Promise<string>;

export const ghRun: GhRun = (args, input) =>
  new Promise((resolve, reject) => {
    const p = spawn(toolBin('gh'), args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...toolEnv(toolBin('gh')), GH_PROMPT_DISABLED: '1', NO_COLOR: '1' } });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGTERM'), 60_000);
    p.stdout.on('data', (b: Buffer) => { out += b; });
    p.stderr.on('data', (b: Buffer) => { err += b; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(`gh: ${e.message}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error((err || out).trim().split('\n').slice(-3).join(' ') || `gh exited ${code}`));
    });
    p.stdin.end(input ?? '');
  });

/** The GitHub calls a send makes. */
export interface GithubPoster {
  /** The PR's current head sha, title and url. */
  head(repo: string, pr: number): Promise<{ sha: string; title: string; url: string }>;
  post(r: DraftReview): Promise<{ id: number; url: string }>;
  /** A review of this PR already posted with this body against this commit (an interrupted send that landed), or null. */
  findPosted(r: DraftReview): Promise<{ id: number; url: string } | null>;
}

export function githubPoster(run: GhRun = ghRun): GithubPoster {
  return {
    async head(repo, pr) {
      const j = JSON.parse(await run(['api', `repos/${repo}/pulls/${pr}`])) as { head?: { sha?: string }; title?: string; html_url?: string };
      if (!j.head?.sha) throw new Error('GitHub did not report the PR head');
      return { sha: j.head.sha, title: j.title ?? '', url: j.html_url ?? '' };
    },
    async post(r) {
      const out = await run(['api', '-X', 'POST', `repos/${r.repo}/pulls/${r.pr}/reviews`, '--input', '-'], JSON.stringify(reviewPayload(r)));
      const j = JSON.parse(out) as { id?: number; html_url?: string };
      if (!j.id) throw new Error('GitHub did not return a review id');
      return { id: j.id, url: j.html_url ?? '' };
    },
    async findPosted(r) {
      const list = JSON.parse(await run(['api', `repos/${r.repo}/pulls/${r.pr}/reviews?per_page=100`])) as { id: number; html_url?: string; body?: string; commit_id?: string; state?: string }[];
      const hit = (Array.isArray(list) ? list : []).find((x) => (x.body ?? '').trim() === r.body && x.commit_id === r.commit_id && x.state !== 'PENDING');
      return hit ? { id: hit.id, url: hit.html_url ?? '' } : null;
    },
  };
}

/** Does the PR's head differ from the commit the review was drafted against? Short shas compare by prefix. */
export const headMoved = (draftedAt: string, head: string): boolean => {
  const a = draftedAt.toLowerCase();
  const b = head.toLowerCase();
  return !(a === b || (a.length < 40 && b.startsWith(a)) || (b.length < 40 && a.startsWith(b)));
};

/** One line for a confirm / a dry run: "Approve acme/app#12 with 3 comments". */
export function reviewSummary(r: DraftReview): string {
  const verb = r.event === 'APPROVE' ? 'Approve' : r.event === 'REQUEST_CHANGES' ? 'Request changes on' : 'Comment on';
  const n = r.comments.length;
  return `${verb} ${r.repo}#${r.pr}${n ? ` with ${n} inline comment${n === 1 ? '' : 's'}` : ''}`;
}

/* ------------------------------------------------------------- head cache */

const heads = new Map<string, { at: number; sha: string; title: string; url: string; error?: string }>();
export const HEAD_TTL_MS = 60_000;

/** The PR head for a card, cached a minute per PR so a card re-render never shells out. */
export async function cachedHead(gh: GithubPoster, repo: string, pr: number, now: number = Date.now()): Promise<{ sha: string; title: string; url: string; error?: string }> {
  const k = `${repo}#${pr}`;
  const hit = heads.get(k);
  if (hit && now - hit.at < HEAD_TTL_MS) return hit;
  try {
    const h = await gh.head(repo, pr);
    heads.set(k, { at: now, ...h });
    return h;
  } catch (e) {
    const miss = { at: now, sha: '', title: '', url: '', error: (e as Error).message };
    heads.set(k, miss);
    return miss;
  }
}

export function clearHeadCache(): void {
  heads.clear();
}
