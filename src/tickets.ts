import os from 'node:os';
import { defaultGh, type GhRunner } from './detail.ts';
import { defaultGitAsync, type AsyncGitRunner } from './git.ts';
import { slugFromRemote } from './ships.ts';
import type { Pipeline, StepState } from './pipeline.ts';

// The Tickets tab: every GitHub issue Loom can say something about, placed in a
// stage column by what the board already knows — the chats working it, their
// PRs and pipelines, and the ship groups — plus two cheap `gh` listings per
// repo (issues, PRs) refreshed by a background tick, never on a request.
// Everything here is pure except the store at the bottom.

export type Stage = 'proposed' | 'ready' | 'progress' | 'review' | 'shipping' | 'done';
export const STAGES: readonly Stage[] = ['proposed', 'ready', 'progress', 'review', 'shipping', 'done'];
// The column a card sits in. A ticket that is waiting (on Will, or on someone
// else) leaves its stage column for one of the two waiting columns, so the
// board answers "what is stuck on me, and what is stuck on others" at a glance.
// The stage still rides on the card. Proposed and Done stay rails.
export type Column = 'needsYou' | 'blocked' | Stage;
export const COLUMNS: readonly Column[] = ['proposed', 'needsYou', 'blocked', 'ready', 'progress', 'review', 'shipping', 'done'];
export type ChatState = 'working' | 'your_turn' | 'idle' | 'ended';
export type Tone = 'failing' | 'needsYou' | 'working' | 'stale' | 'none';

export interface IssueRow {
  repo: string; // nameWithOwner
  number: number;
  title: string;
  url: string;
  labels: string[];
  state: 'open' | 'closed';
  author?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
}

export interface PrRow {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  body: string;
  headRefName: string;
  createdAt?: number;
  updatedAt?: number;
  mergedAt?: number;
  closedAt?: number;
  reviewRequests?: string[]; // logins (or team names) asked to review and not yet answered
}

/** A board chat as the server sees it, already resolved to its repo. */
export interface ChatInput {
  key: string; // agent:session_id
  repo: string;
  name?: string;
  loc?: string; // session:window.pane
  title: string;
  firstMessage: string;
  state: ChatState;
  since?: number;
  lastActive: number;
  prKey?: string; // repo#N, from the board's chat → PR mapping
  shipPrs?: PrRow[]; // ship/ PRs this chat rode (newest first)
  shipNext?: 'staged' | 'unstaged' | 'both'; // still has changes on main waiting for a ship
  shipping?: boolean; // in the ship in flight (lock holder, or staged into its batch)
  shipAt?: number;
  waitingOnOthers?: boolean; // the pane's classifier says the chat is parked on someone other than Will
}

export interface TicketChat {
  key: string;
  name?: string;
  loc?: string;
  state: ChatState;
  since?: number;
  lastActive: number;
  title?: string;
  otto: boolean;
  shipNext?: ChatInput['shipNext'];
  shipping?: boolean;
  shipAt?: number;
  waitingOnOthers?: boolean;
}

export interface TicketPr {
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrRow['state'];
  isDraft: boolean;
  createdAt?: number;
  mergedAt?: number;
  closedAt?: number;
  reviewRequests?: string[];
  pipeline: Pipeline | null;
}

export interface HistoryStep {
  stage: Stage;
  at?: number;
  detail: string;
  done: boolean;
  now: boolean;
}

export interface Ticket {
  repo: string;
  number: number;
  title: string;
  url: string;
  labels: string[];
  state: 'open' | 'closed';
  author?: string;
  createdAt: number;
  updatedAt: number;
  closedAt?: number;
  stage: Stage;
  column: Column;
  stageSince: number;
  needsYou: boolean;
  blocked: boolean;
  blockedOn?: string; // who or what, in a few words: 'review from mike · label question'
  working: boolean;
  failing: boolean;
  stale: boolean;
  otto: boolean;
  tone: Tone;
  chats: TicketChat[];
  prs: TicketPr[];
  history: HistoryStep[];
}

export const DONE_WINDOW_MS = 7 * 86_400_000;
const STALE_MS = 72 * 3_600_000;

const ms = (s: unknown): number | undefined => {
  const n = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/* ------------------------------------------------------------------ gh rows */

export function toIssueRow(repo: string, raw: any): IssueRow | null {
  if (!raw || typeof raw.number !== 'number') return null;
  const created = ms(raw.createdAt) ?? 0;
  return {
    repo,
    number: raw.number,
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    labels: (Array.isArray(raw.labels) ? raw.labels : []).map((l: any) => String(l?.name ?? '')).filter(Boolean),
    state: String(raw.state ?? '').toUpperCase() === 'CLOSED' ? 'closed' : 'open',
    author: String(raw.author?.login ?? '') || undefined,
    createdAt: created,
    updatedAt: ms(raw.updatedAt) ?? created,
    closedAt: ms(raw.closedAt),
  };
}

export function toPrRow(repo: string, raw: any): PrRow | null {
  if (!raw || typeof raw.number !== 'number') return null;
  const state = String(raw.state ?? '').toUpperCase();
  return {
    repo,
    number: raw.number,
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    state: state === 'MERGED' ? 'merged' : state === 'CLOSED' ? 'closed' : 'open',
    isDraft: !!raw.isDraft,
    body: String(raw.body ?? ''),
    headRefName: String(raw.headRefName ?? ''),
    createdAt: ms(raw.createdAt),
    updatedAt: ms(raw.updatedAt),
    mergedAt: ms(raw.mergedAt),
    closedAt: ms(raw.closedAt),
    ...(reviewers(raw).length ? { reviewRequests: reviewers(raw) } : {}),
  };
}

// gh lists a requested user as {login} and a requested team as {name} / {slug}.
function reviewers(raw: any): string[] {
  return (Array.isArray(raw?.reviewRequests) ? raw.reviewRequests : [])
    .map((r: any) => String(r?.login ?? r?.slug ?? r?.name ?? ''))
    .filter(Boolean);
}

/* ------------------------------------------------------------------ linking */

// GitHub's own closing vocabulary, with the `#N`, `owner/repo#N` and issue-URL forms.
const CLOSES_RE = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*:?\s*(?:https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/|(?:[\w.-]+\/[\w.-]+)?#)(\d+)/gi;
const HASH_RE = /#(\d+)\b/g;
const BRANCH_RE = /(?:^|[-/])(\d+)(?=-|$)/g;
const ISSUE_URL_RE = /github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)/gi;

const numbers = (re: RegExp, text: string, group = 1): number[] => [...text.matchAll(re)].map((m) => Number(m[group]));
const uniq = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b);

/**
 * The issues a PR is about: closing keywords in the body, `#N` in the title,
 * and a number segment of the branch name — the last only when N is an issue
 * we know, since branch numbers are also dates and PR numbers. A ship/ branch
 * bundles many chats' work and never names one issue.
 */
export function prIssueRefs(pr: Pick<PrRow, 'title' | 'body' | 'headRefName'>, known: Set<number>): number[] {
  const refs = [...numbers(CLOSES_RE, pr.body), ...numbers(HASH_RE, pr.title)];
  if (!pr.headRefName.startsWith('ship/')) refs.push(...numbers(BRANCH_RE, pr.headRefName).filter((n) => known.has(n)));
  return uniq(refs);
}

/** `#N` or an issue URL in a chat's title / first message, scoped to the chat's repo. */
export function chatIssueRefs(text: string, repo: string): number[] {
  const urls = [...text.matchAll(ISSUE_URL_RE)].filter((m) => m[1].toLowerCase() === repo.toLowerCase()).map((m) => Number(m[2]));
  return uniq([...numbers(HASH_RE, text), ...urls]);
}

const OTTO_RE = /\/orchestrate\b/i;

function toTicketChat(c: ChatInput): TicketChat {
  return {
    key: c.key,
    ...(c.name ? { name: c.name } : {}),
    ...(c.loc ? { loc: c.loc } : {}),
    state: c.state,
    ...(c.since ? { since: c.since } : {}),
    lastActive: c.lastActive,
    ...(c.title ? { title: c.title } : {}),
    otto: OTTO_RE.test(c.title + ' ' + c.firstMessage) || /^loom-otto/.test(c.loc ?? ''),
    ...(c.shipNext ? { shipNext: c.shipNext } : {}),
    ...(c.shipping ? { shipping: true, ...(c.shipAt ? { shipAt: c.shipAt } : {}) } : {}),
    ...(c.waitingOnOthers ? { waitingOnOthers: true } : {}),
  };
}

/** The pipeline without per-check children: the card wants dots, the panel wants the four rows. */
function slim(p: Pipeline | null): Pipeline | null {
  return p ? { ...p, steps: p.steps.map(({ children: _c, ...s }) => s) } : null;
}

const step = (p: TicketPr, key: string): StepState | undefined => p.pipeline?.steps.find((s) => s.key === key)?.state;
const live = (c: TicketChat) => c.state !== 'ended';
const recent = (p: Pick<PrRow, 'mergedAt' | 'closedAt'>, now: number) => now - (p.mergedAt ?? p.closedAt ?? 0) <= DONE_WINDOW_MS;
const min = (ns: (number | undefined)[]): number | undefined => {
  const xs = ns.filter((n): n is number => !!n);
  return xs.length ? Math.min(...xs) : undefined;
};

/* -------------------------------------------------------------- derivation */

interface Facts {
  issue: IssueRow;
  chats: TicketChat[];
  prs: TicketPr[];
  now: number;
  me?: string; // the gh login the board runs as; a review requested of anyone else is someone else's move
}

// A merged PR counts as deployed once its pipeline is final and the deploy did
// not fail; a failed deploy keeps the ticket in Shipping, red.
const deployed = (p: TicketPr) => p.state === 'merged' && !!p.pipeline?.final && step(p, 'deploy') !== 'fail';

/** Ordered, first match wins. */
export function deriveStage({ issue, chats, prs }: Facts): Stage {
  const has = (l: string) => issue.labels.includes(l);
  if (issue.state === 'closed') return 'done';
  if (prs.some(deployed)) return 'done';
  if (prs.some((p) => p.state === 'merged') || chats.some((c) => c.shipping)) return 'shipping';
  if (prs.some((p) => p.state === 'open')) return 'review';
  if (has('agent:claimed') || chats.some(live)) return 'progress';
  if (has('agent:ready') || (!issue.labels.some((l) => l.startsWith('agent:')) && (chats.length > 0 || prs.length > 0))) return 'ready';
  if (has('agent:proposed')) return 'proposed';
  return 'ready';
}

// Labels that say someone outside the board owes the next move. agent:blocked is
// not one: Otto files it when it needs a decision from Will, so it is Needs you.
const BLOCKED_LABEL_RE = /^(?:question|blocked|on[- ]hold|waiting(?:[- :].*)?)$|(?:^|[:/-])blocked(?:[:/-]|$)/i;
export const blockedLabels = (labels: string[]): string[] => labels.filter((l) => l !== 'agent:blocked' && BLOCKED_LABEL_RE.test(l));
const isBot = (login: string) => /\[bot\]$|^(?:copilot|claude)$/i.test(login);
const same = (a: string, b: string | undefined) => !!b && a.toLowerCase() === b.toLowerCase();

/** Whose move it is when it is not the agent's: Will's (needsYou) or someone else's (blocked). */
export function waitingFor({ issue, chats, prs, me }: Facts): Pick<Ticket, 'needsYou' | 'blocked' | 'blockedOn'> {
  const open = prs.filter((p) => p.state === 'open');
  // A PR's requested reviewers are an either-of (merge-policy asks both
  // maintainers), so a request that includes Will is his move; only a PR that
  // asks someone else alone (his own PR, which he cannot approve) is blocked.
  const humans = (p: TicketPr) => (p.reviewRequests ?? []).filter((r) => !isBot(r));
  const askedMe = open.some((p) => humans(p).some((r) => same(r, me)));
  const othersOnly = open.filter((p) => humans(p).length && !humans(p).some((r) => same(r, me)));
  const others = [...new Set(othersOnly.flatMap(humans))];
  const needsYou =
    chats.some((c) => c.state === 'your_turn' && !c.waitingOnOthers) ||
    open.some((p) => step(p, 'review') === 'pass' && step(p, 'merged') === 'waiting' && !othersOnly.includes(p)) ||
    issue.labels.includes('agent:blocked') ||
    askedMe;
  const labels = blockedLabels(issue.labels);
  const parked = chats.filter((c) => c.state !== 'ended' && c.state !== 'working' && c.waitingOnOthers);
  const on = [
    others.length ? `review from ${others.join(', ')}` : '',
    labels.length ? `label ${labels.join(', ')}` : '',
    parked.length ? `${parked.map((c) => c.name || 'a chat').join(', ')} waiting on someone` : '',
  ].filter(Boolean);
  return { needsYou, blocked: on.length > 0, ...(on.length ? { blockedOn: on.join(' · ') } : {}) };
}

/** Waiting beats stage, and Will beats others; the rails keep their own. */
export function columnFor(stage: Stage, w: Pick<Ticket, 'needsYou' | 'blocked'>): Column {
  if (stage === 'proposed' || stage === 'done') return stage;
  return w.needsYou ? 'needsYou' : w.blocked ? 'blocked' : stage;
}

export function flagsFor(facts: Facts): Pick<Ticket, 'needsYou' | 'blocked' | 'blockedOn' | 'working' | 'failing' | 'stale' | 'otto' | 'tone'> {
  const { issue, chats, prs, now } = facts;
  const has = (l: string) => issue.labels.includes(l);
  const open = prs.filter((p) => p.state === 'open');
  const { needsYou, blocked, blockedOn } = waitingFor(facts);
  const working = chats.some((c) => c.state === 'working') || prs.some((p) => p.state !== 'closed' && !!p.pipeline?.inFlight);
  const failing =
    open.some((p) => p.pipeline?.steps.some((s) => s.state === 'fail')) ||
    prs.some((p) => p.state === 'merged' && step(p, 'deploy') === 'fail') ||
    has('agent:needs-rerun');
  const moved = Math.max(
    issue.updatedAt,
    ...prs.flatMap((p) => [p.createdAt ?? 0, p.mergedAt ?? 0, p.closedAt ?? 0, ...(p.pipeline?.events.map((e) => e.at) ?? [])]),
    ...chats.map((c) => c.lastActive),
  );
  // Nothing can move a closed ticket, so the Done rail is never "stale".
  const stale = !working && issue.state === 'open' && now - moved > STALE_MS;
  const otto = has('agent:claimed') || has('agent:in-review') || chats.some((c) => c.otto);
  const tone: Tone = failing ? 'failing' : needsYou ? 'needsYou' : working ? 'working' : stale ? 'stale' : 'none';
  return { needsYou, blocked, ...(blockedOn ? { blockedOn } : {}), working, failing, stale, otto, tone };
}

/**
 * When the ticket entered its stage, from what the listings carry. Label
 * timestamps are not fetched (that is one events call per issue), so Ready and
 * Proposed fall back to the issue's updatedAt.
 */
export function stageSinceFor({ issue, chats, prs }: Facts, stage: Stage): number {
  const merged = prs.filter((p) => p.state === 'merged');
  switch (stage) {
    case 'done':
      return issue.closedAt
        ?? min(prs.filter(deployed).map((p) => p.pipeline!.steps.find((s) => s.key === 'done')?.completedAt ?? p.pipeline!.steps.find((s) => s.key === 'deploy')?.completedAt))
        ?? min(merged.map((p) => p.mergedAt))
        ?? issue.updatedAt;
    case 'shipping':
      return min(merged.map((p) => p.mergedAt)) ?? min(chats.filter((c) => c.shipping).map((c) => c.shipAt)) ?? issue.updatedAt;
    case 'review':
      return min(prs.filter((p) => p.state === 'open').map((p) => p.createdAt)) ?? issue.updatedAt;
    case 'progress':
      return min(chats.filter(live).map((c) => c.since)) ?? min(chats.map((c) => c.since)) ?? issue.updatedAt;
    default:
      return issue.updatedAt;
  }
}

export function historyFor({ issue, chats, prs }: Facts, stage: Stage, stageSince: number): HistoryStep[] {
  const idx = STAGES.indexOf(stage);
  const has = (l: string) => issue.labels.includes(l);
  const named = [...chats].sort((a, b) => (a.since ?? 0) - (b.since ?? 0));
  const prName = (p: TicketPr) => `#${p.number}`;
  const open = prs.filter((p) => p.state === 'open');
  const merged = prs.filter((p) => p.state === 'merged');
  const reviewed = open.length ? open : merged; // past the review stage, the merged PRs are the ones that were reviewed
  const lock = chats.find((c) => c.shipping);
  const at = (i: number, when: number | undefined) => (i <= idx ? when : undefined);
  const detail: Record<Stage, [number | undefined, string]> = {
    proposed: [issue.createdAt, issue.author ? `opened by ${issue.author}` : 'opened'],
    ready: [at(1, idx === 1 ? stageSince : undefined), has('agent:ready') ? 'agent:ready' : ''],
    progress: [
      at(2, min(named.map((c) => c.since))),
      named.length ? named.map((c) => c.name || c.key.slice(c.key.indexOf(':') + 1, c.key.indexOf(':') + 9)).join(', then ') : has('agent:claimed') ? 'agent:claimed' : idx < 2 ? 'a chat picks it up' : '',
    ],
    review: [at(3, min(reviewed.map((p) => p.createdAt))), reviewed.length ? `PR ${reviewed.map(prName).join(', ')}${reviewed.length === 1 && reviewed[0].isDraft ? ' (draft)' : ''}` : idx < 3 ? 'a PR opens' : ''],
    shipping: [at(4, min(merged.map((p) => p.mergedAt)) ?? lock?.shipAt), merged.length ? `PR ${merged.map(prName).join(', ')} merged` : lock ? 'ship in flight' : 'merge + deploy'],
    done: [idx === 5 ? stageSince : undefined, issue.state === 'closed' ? 'closed' : idx === 5 ? (prs.some((p) => deployed(p) && step(p, 'deploy') === 'skipped') ? 'merged, no deploy needed' : 'deployed') : 'deployed to prod'],
  };
  return STAGES.map((s, i) => {
    const [when, text] = detail[s];
    return { stage: s, ...(when ? { at: when } : {}), detail: text, done: i < idx, now: i === idx };
  });
}

/* -------------------------------------------------------------- the board */

export interface BuildInput {
  issues: IssueRow[];
  prs: PrRow[];
  chats: ChatInput[];
  pipeline: (pr: PrRow) => Pipeline | null;
  now: number;
  me?: string;
}

const key = (repo: string, n: number) => `${repo}#${n}`;

/**
 * Join issues, PRs and chats into tickets. Only issues Loom can say something
 * about become cards: an agent:* label, a linked chat, a linked PR that is open
 * or closed this week, or closed this week themselves. The rest of the open
 * issues are counted as backlog per repo.
 */
export function buildTickets({ issues, prs, chats, pipeline, now, me }: BuildInput): { tickets: Ticket[]; backlog: Record<string, number> } {
  const known = new Map<string, Set<number>>();
  for (const i of issues) (known.get(i.repo) ?? known.set(i.repo, new Set()).get(i.repo)!).add(i.number);

  const prIssues = new Map<string, number[]>(); // repo#pr -> issue numbers
  const issuePrs = new Map<string, Map<number, PrRow>>(); // repo#issue -> prs by number
  const addPr = (issueKey: string, p: PrRow) => (issuePrs.get(issueKey) ?? issuePrs.set(issueKey, new Map()).get(issueKey)!).set(p.number, p);
  for (const p of prs) {
    const have = known.get(p.repo);
    if (!have) continue;
    const refs = prIssueRefs(p, have).filter((n) => have.has(n));
    prIssues.set(key(p.repo, p.number), refs);
    for (const n of refs) addPr(key(p.repo, n), p);
  }

  const issueChats = new Map<string, TicketChat[]>();
  for (const c of chats) {
    const have = known.get(c.repo);
    if (!have) continue;
    const refs = new Set(chatIssueRefs(c.title + '\n' + c.firstMessage, c.repo).filter((n) => have.has(n)));
    for (const n of c.prKey ? prIssues.get(c.prKey) ?? [] : []) refs.add(n);
    if (!refs.size) continue;
    const tc = toTicketChat(c);
    for (const n of refs) {
      const k = key(c.repo, n);
      (issueChats.get(k) ?? issueChats.set(k, []).get(k)!).push(tc);
      // A ship the chat rode carries its work — unless the chat still has
      // unshipped changes on main, in which case the ship was a partial.
      if (!c.shipNext) for (const sp of c.shipPrs ?? []) addPr(k, sp);
    }
  }

  const tickets: Ticket[] = [];
  const backlog: Record<string, number> = {};
  for (const issue of issues) {
    backlog[issue.repo] ??= 0;
    const k = key(issue.repo, issue.number);
    const linkedPrs = [...(issuePrs.get(k)?.values() ?? [])];
    const chatsHere = issueChats.get(k) ?? [];
    const inScope =
      issue.state === 'closed'
        ? !!issue.closedAt && now - issue.closedAt <= DONE_WINDOW_MS
        : issue.labels.some((l) => l.startsWith('agent:')) || chatsHere.length > 0 || linkedPrs.some((p) => p.state === 'open' || recent(p, now));
    if (!inScope) {
      if (issue.state === 'open') backlog[issue.repo]++;
      continue;
    }
    const ticketPrs: TicketPr[] = linkedPrs.map((p) => ({
      repo: p.repo, number: p.number, title: p.title, url: p.url, state: p.state, isDraft: p.isDraft,
      ...(p.createdAt ? { createdAt: p.createdAt } : {}), ...(p.mergedAt ? { mergedAt: p.mergedAt } : {}), ...(p.closedAt ? { closedAt: p.closedAt } : {}),
      ...(p.reviewRequests?.length ? { reviewRequests: p.reviewRequests } : {}),
      pipeline: slim(pipeline(p)),
    }));
    const facts: Facts = { issue, chats: chatsHere, prs: ticketPrs, now, ...(me ? { me } : {}) };
    const stage = deriveStage(facts);
    const stageSince = stageSinceFor(facts, stage);
    const flags = flagsFor(facts);
    tickets.push({
      repo: issue.repo, number: issue.number, title: issue.title, url: issue.url, labels: issue.labels, state: issue.state,
      ...(issue.author ? { author: issue.author } : {}),
      createdAt: issue.createdAt, updatedAt: issue.updatedAt, ...(issue.closedAt ? { closedAt: issue.closedAt } : {}),
      stage, column: columnFor(stage, flags), stageSince, ...flags, chats: chatsHere, prs: ticketPrs, history: historyFor(facts, stage, stageSince),
    });
  }
  return { tickets: orderTickets(tickets), backlog };
}

const rank = (t: Ticket) => (t.needsYou ? 0 : t.failing ? 1 : t.working ? 2 : 3);
const isRail = (s: Stage) => s === 'proposed' || s === 'done';

/** By column; within a column needs-you, failing, working, the rest, longest in stage first. The rails read newest first. */
export function orderTickets(tickets: Ticket[]): Ticket[] {
  return [...tickets].sort((a, b) =>
    COLUMNS.indexOf(a.column) - COLUMNS.indexOf(b.column)
    || (isRail(a.stage) ? b.stageSince - a.stageSince : rank(a) - rank(b) || a.stageSince - b.stageSince)
    || a.number - b.number);
}

/* ------------------------------------------------------------------ store */

const ISSUE_FIELDS = 'number,title,url,labels,state,author,createdAt,updatedAt';
const PR_FIELDS = 'number,title,url,state,isDraft,body,headRefName,createdAt,updatedAt,mergedAt,closedAt,reviewRequests';
const LOOKING_MS = 10 * 60_000; // the tab was requested this recently: someone is looking
const FAST_MS = 60_000;
const SLOW_MS = 10 * 60_000;

interface RepoEntry {
  issues: IssueRow[];
  prs: PrRow[];
  fetchedAt: number;
}

const byRepo = new Map<string, RepoEntry>();
const slugCache = new Map<string, string>(); // project dir -> owner/name ('' when none)
let requestedAt = 0;
let fetchedAt = 0;
let nextAt = 0; // due at boot: the tab opens populated instead of syncing in front of you
let error = '';
let inflight: Promise<void> | null = null;
let me = ''; // gh's own login, read once per server life

const looking = (now: number) => requestedAt > 0 && now - requestedAt <= LOOKING_MS;

/** The tab asked. The first look after boot, or after a quiet spell, pulls the next fetch forward. */
export function markTicketsRequested(now: number = Date.now()): void {
  if (!looking(now)) nextAt = Math.min(nextAt, now);
  requestedAt = now;
}

export function ticketsDue(now: number = Date.now()): boolean {
  return !inflight && now >= nextAt;
}

export function ticketsSnapshot(now: number = Date.now()): { byRepo: Map<string, RepoEntry>; fetchedAt: number; refreshing: boolean; error: string; me: string } {
  return { byRepo, fetchedAt, refreshing: !!inflight || (fetchedAt === 0 && now >= nextAt), error, me };
}

async function fetchRepo(repo: string, gh: GhRunner, now: number): Promise<Omit<RepoEntry, 'fetchedAt'>> {
  const home = os.homedir();
  const since = new Date(now - DONE_WINDOW_MS).toISOString().slice(0, 10);
  // Issue bodies are not asked for: nothing reads them, and 300 of them would
  // push the listing toward execFile's 1MB buffer. PR bodies carry `closes #N`.
  const [open, closed, prs] = await Promise.all([
    gh(['issue', 'list', '--repo', repo, '--state', 'open', '--limit', '300', '--json', ISSUE_FIELDS], home),
    gh(['issue', 'list', '--repo', repo, '--state', 'closed', '--search', `closed:>=${since}`, '--limit', '200', '--json', ISSUE_FIELDS + ',closedAt'], home),
    gh(['pr', 'list', '--repo', repo, '--state', 'all', '--limit', '150', '--json', PR_FIELDS], home),
  ]);
  return {
    issues: [...(JSON.parse(open) as any[]), ...(JSON.parse(closed) as any[])].map((r) => toIssueRow(repo, r)).filter((r): r is IssueRow => !!r),
    prs: (JSON.parse(prs) as any[]).map((r) => toPrRow(repo, r)).filter((r): r is PrRow => !!r),
  };
}

/**
 * One background pass over every repo on the board. A repo whose listing fails
 * keeps its last good one and is named in `error`; overlapping calls collapse
 * into the one running. The next pass is a minute away while someone is
 * looking at the tab, ten otherwise.
 */
export async function refreshTickets(repos: string[], gh: GhRunner = defaultGh, now: number = Date.now()): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const failed: string[] = [];
    if (!me) me = (await gh(['api', 'user', '--jq', '.login'], os.homedir()).catch(() => '')).trim();
    for (const repo of repos) {
      try {
        byRepo.set(repo, { ...(await fetchRepo(repo, gh, now)), fetchedAt: now });
      } catch {
        failed.push(repo);
      }
    }
    for (const k of [...byRepo.keys()]) if (!repos.includes(k)) byRepo.delete(k);
    if (failed.length < repos.length || !repos.length) fetchedAt = now;
    error = failed.length ? `gh listing failed for ${failed.join(', ')}` : '';
    nextAt = now + (looking(now) ? FAST_MS : SLOW_MS);
  })().finally(() => { inflight = null; });
  return inflight;
}

/** A project directory's GitHub repo, from its origin remote; cached for the server's life. */
export async function repoSlug(dir: string, git: AsyncGitRunner = defaultGitAsync): Promise<string> {
  const hit = slugCache.get(dir);
  if (hit !== undefined) return hit;
  let slug = '';
  try {
    slug = slugFromRemote(await git(['remote', 'get-url', 'origin'], dir));
  } catch {
    /* not a checkout, or no origin */
  }
  slugCache.set(dir, slug);
  return slug;
}

export function _resetTicketStore(): void {
  byRepo.clear();
  slugCache.clear();
  requestedAt = fetchedAt = 0;
  nextAt = 0;
  error = '';
  inflight = null;
  me = '';
}
