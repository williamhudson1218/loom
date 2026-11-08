import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';
import { openDb } from './db.ts';
import { parseSlackThread } from './slackref.ts';
import {
  LEGACY_TOKEN_PATH,
  SlackError,
  authTest,
  conversationLabel,
  conversationsHistory,
  conversationsInfo,
  conversationsReplies,
  dmHandle,
  renderMentions,
  requireToken,
  userLabel,
  usersInfo,
  type SlackMessage,
} from './slackapi.ts';

// Slack threads owned by chats, read from the state the slack-threads hook keeps
// (~/.claude/state/slack-threads.json). Loom only reads it; the hook is the
// writer. Channel labels and root-message previews are slow (network), so they
// come from caches ($LOOM_HOME/slack-cache.json) and misses are filled in the
// background with read-only Web API calls (src/slackapi.ts) — a panel never
// waits on Slack.

// Everything here is OPTIONAL tooling from the owner's setup. On a machine without
// it the files are simply missing and the calls fail quietly: Loom's own
// slack_threads table owns threads, and a label stays the raw channel id.
// Each path can be pointed elsewhere with an env var.
const STATE_DIR = process.env.LOOM_SLACK_STATE_DIR || path.join(os.homedir(), '.claude', 'state');
export const THREADS_PATH = path.join(STATE_DIR, 'slack-threads.json');
export const CHANNELS_PATH = path.join(STATE_DIR, 'slack-channels.json');
const CACHE_PATH = path.join(TOOL_DIR, 'slack-cache.json');

export interface ThreadRec {
  url: string;
  session_id: string;
  cwd?: string;
  claimed_at?: string;
  stage?: string;
  started?: boolean; // the hook's flag: this chat posted the thread's root
  history?: { at?: string }[];
  source?: string; // Loom's slack_threads.source when the row came from the table
}

export interface OwnedThread {
  key: string; // `<channel>/<ts>`
  url: string;
  channel: string;
  ts: string;
  label: string; // #name / @dm, or the raw id until resolved
  stage: string;
  source: string; // 'send' when the chat started the thread; else how it came to own it
  claimedAt: number; // ms, 0 when unknown
  lastAt: number; // ms of the newest recorded activity, 0 when unknown
  preview: string | null; // root message text; null while being fetched
  author: string;
  deeplink: string; // slack:// when the team id is known, else the https url
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

// mtime-cached: the board poll reads this every few seconds.
let threadsMemo: { mtime: number; threads: Record<string, ThreadRec> } | null = null;
export function readThreads(file: string = THREADS_PATH): Record<string, ThreadRec> {
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return {};
  }
  if (file === THREADS_PATH && threadsMemo?.mtime === mtime) return threadsMemo.threads;
  const threads = readJson<{ threads?: Record<string, ThreadRec> }>(file, {}).threads ?? {};
  if (file === THREADS_PATH) threadsMemo = { mtime, threads };
  return threads;
}

/**
 * Every owned thread: the hook's state file plus Loom's own slack_threads table
 * (chats Loom started for a thread, or saw a thread opening a transcript). The
 * table wins a shared key, as it does in slackgoto's lookup. A DB that cannot be
 * read just means the state file alone.
 */
export function readAllThreads(file: string = THREADS_PATH): Record<string, ThreadRec> {
  const state = readThreads(file);
  if (file !== THREADS_PATH) return state;
  try {
    const db = openDb();
    try {
      const rows = db.prepare(`SELECT thread_key, url, session_id, project_dir, source, created_at FROM slack_threads WHERE session_id != ''`).all() as
        { thread_key: string; url: string; session_id: string; project_dir: string; source: string; created_at: number }[];
      if (!rows.length) return state;
      const mine: Record<string, ThreadRec> = {};
      for (const r of rows) mine[r.thread_key] = { url: r.url, session_id: r.session_id, cwd: r.project_dir, claimed_at: new Date(r.created_at).toISOString(), source: r.source };
      return { ...state, ...mine };
    } finally {
      db.close();
    }
  } catch {
    return state;
  }
}

/** Session ids that own at least one thread — the board's Slack glyph. */
export function threadOwners(threads: Record<string, ThreadRec> = readAllThreads()): string[] {
  return [...new Set(Object.values(threads).map((t) => t.session_id).filter(Boolean))];
}

export function slackDeepLink(channel: string, ts: string, teamId: string, url: string): string {
  if (!teamId) return url;
  return `slack://channel?team=${encodeURIComponent(teamId)}&id=${encodeURIComponent(channel)}&message=${encodeURIComponent(ts)}`;
}

/* ------------------------------------------------------------- slow lookups */

export type Runner = (cmd: string, args: string[]) => Promise<string>;
export const defaultRunner: Runner = (cmd, args) =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: 'utf-8', timeout: 30_000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => (err ? reject(err) : resolve(out))),
  );

interface SlackCache {
  teamId?: string;
  roots: Record<string, { text: string; author: string }>;
  /** channel id -> `#name` / `@person`, filled by conversations.info. */
  channels: Record<string, string>;
}

let cacheMemo: SlackCache | null = null;
function cache(): SlackCache {
  if (!cacheMemo) {
    const d = readJson<Partial<SlackCache>>(CACHE_PATH, {});
    cacheMemo = { ...d, roots: d.roots ?? {}, channels: d.channels ?? {} };
  }
  return cacheMemo;
}
function saveCache(): void {
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheMemo, null, 2));
  } catch {
    /* a cache that cannot be written just refetches next time */
  }
}

/**
 * Channel labels: Loom's own cache over the hook's older one, which is only
 * read (an install that had the hook keeps its labels without a refetch).
 */
export function channelLabels(legacyFile: string = CHANNELS_PATH): Record<string, string> {
  return { ...readJson<Record<string, string>>(legacyFile, {}), ...cache().channels };
}

/** The team id from the last auth.test, '' until one has run. */
export function cachedTeamId(): string {
  return cache().teamId ?? '';
}

/** The read-only calls the background fills make. Tests pass fakes. */
export interface SlackLookups {
  authTest: typeof authTest;
  conversationsInfo: typeof conversationsInfo;
  conversationsReplies: typeof conversationsReplies;
  usersInfo: typeof usersInfo;
  /** user id -> display name, from the directory cache. */
  users(): Record<string, string>;
}

const DIRECTORY_FILE = path.join(TOOL_DIR, 'slack-directory.json');
export const defaultLookups: SlackLookups = {
  authTest,
  conversationsInfo,
  conversationsReplies,
  usersInfo,
  users: () => readJson<{ users?: Record<string, string> }>(DIRECTORY_FILE, {}).users ?? {},
};

const inflight = new Set<string>();
function once(key: string, job: () => Promise<void>): void {
  if (inflight.has(key)) return;
  inflight.add(key);
  job().catch(() => {}).finally(() => inflight.delete(key));
}

// A failed lookup is not retried for a while, so a dead token or a deleted
// message cannot turn every panel refresh into a Slack call.
const failedAt = new Map<string, number>();
const RETRY_MS = 5 * 60_000;
function mayTry(key: string): boolean {
  const at = failedAt.get(key);
  return !at || Date.now() - at > RETRY_MS;
}

function fillTeamId(api: SlackLookups): void {
  if (cache().teamId || !mayTry('team')) return;
  once('team', async () => {
    try {
      const { identity } = await api.authTest();
      if (identity.team_id) {
        cache().teamId = identity.team_id;
        saveCache();
      } else failedAt.set('team', Date.now());
    } catch {
      failedAt.set('team', Date.now());
    }
  });
}

async function personLabel(id: string, api: SlackLookups): Promise<string> {
  const known = api.users()[id];
  if (known) return known;
  try {
    return userLabel(await api.usersInfo(id));
  } catch {
    return '';
  }
}

/** A DM's `@handle`: display name, else the account name (never the real name), matching labels the hook wrote. */
async function dmLabel(id: string, api: SlackLookups): Promise<string> {
  try {
    return dmHandle(await api.usersInfo(id));
  } catch {
    return '';
  }
}

/** Resolve labels one id at a time (conversations.info, plus users.info for a DM). */
function fillLabels(ids: string[], api: SlackLookups): void {
  const missing = ids.filter((id) => mayTry('label:' + id));
  if (!missing.length) return;
  once('labels:' + missing.join(','), async () => {
    let changed = false;
    for (const id of missing) {
      try {
        const c = await api.conversationsInfo(id);
        const label = conversationLabel(c, c.is_im && c.user ? await dmLabel(c.user, api) : undefined);
        if (!label) throw new Error('no label');
        cache().channels[id] = label;
        changed = true;
      } catch {
        failedAt.set('label:' + id, Date.now());
      }
    }
    if (changed) saveCache();
  });
}

function fillRoot(key: string, channel: string, ts: string, api: SlackLookups): void {
  if (!mayTry('root:' + key)) return;
  once('root:' + key, async () => {
    try {
      const msgs = await api.conversationsReplies(channel, ts, { limit: 1 });
      const root = msgs.find((m) => m.ts === ts) ?? msgs[0];
      if (!root) throw new Error('no root');
      const users = api.users();
      // The same shape the old CLI wrote: mentions rendered, the author's display name.
      const author = root.user ? (await personLabel(root.user, api)) || root.user : root.username || root.bot_id || '';
      cache().roots[key] = { text: renderMentions(String(root.text ?? ''), users), author };
      saveCache();
    } catch {
      failedAt.set('root:' + key, Date.now());
    }
  });
}

const PREVIEW_CHARS = 280;

/** The threads a session owns, with whatever labels and previews are cached. */
export function threadsFor(sessionId: string, api: SlackLookups = defaultLookups, threads: Record<string, ThreadRec> = readAllThreads()): OwnedThread[] {
  const owned = Object.entries(threads).filter(([, t]) => t.session_id === sessionId);
  if (!owned.length) return [];
  fillTeamId(api);
  const labels = channelLabels();
  const out: OwnedThread[] = [];
  const unlabeled: string[] = [];
  for (const [key, t] of owned) {
    const [channel, ts] = key.split('/');
    if (!labels[channel]) unlabeled.push(channel);
    const root = cache().roots[key];
    if (!root) fillRoot(key, channel, ts, api);
    const text = root ? root.text.replace(/\s+/g, ' ').trim() : null;
    out.push({
      key,
      url: t.url,
      channel,
      ts,
      label: labels[channel] ?? channel,
      stage: t.stage ?? '',
      source: t.source === 'send' || t.started ? 'send' : (t.source ?? 'hook'),
      claimedAt: Date.parse(t.claimed_at ?? '') || 0,
      lastAt: Math.max(Date.parse(t.claimed_at ?? '') || 0, ...(t.history ?? []).map((h) => Date.parse(h.at ?? '') || 0)),
      preview: text === null ? null : text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text,
      author: root?.author ?? '',
      deeplink: slackDeepLink(channel, ts, cache().teamId ?? '', t.url),
    });
  }
  if (unlabeled.length) fillLabels([...new Set(unlabeled)], api);
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

/**
 * Open a thread in the Slack app. `open slack://…` hands it to the app; when
 * there is no app (or no team id yet) the https permalink goes to the browser,
 * which Slack itself redirects into the app when it can.
 */
export async function openThread(key: string, run: Runner = defaultRunner, threads: Record<string, ThreadRec> = readAllThreads(), draftUrl = ''): Promise<{ ok: boolean; detail: string }> {
  let t: { url: string } | undefined = threads[key];
  // A thread no chat owns, reached through a chat's pending draft: only its own permalink is opened.
  if (!t && draftUrl) {
    const ref = parseSlackThread(draftUrl);
    if (ref && ref.key === key) t = { url: ref.url };
  }
  if (!t) return { ok: false, detail: 'unknown thread' };
  const [channel, ts] = key.split('/');
  const deep = slackDeepLink(channel, ts, cache().teamId ?? '', t.url);
  for (const target of deep === t.url ? [t.url] : [deep, t.url]) {
    try {
      await run('open', [target]);
      return { ok: true, detail: target.startsWith('slack:') ? 'opened in Slack' : 'opened permalink' };
    } catch {
      /* try the next target */
    }
  }
  return { ok: false, detail: 'could not open' };
}

/* --------------------------------------------------- channel history (watchers) */

// The Slack watchers poll a channel directly with the user's token (see
// slackapi.ts for where it comes from). Read-only: conversations.history is the
// only method called here, and Loom never posts or reacts on its own.

/** @deprecated the old CLI's token file; slackapi.ts reads it only on a migrated install. */
export const SLACK_TOKEN_PATH = LEGACY_TOKEN_PATH;
export type { SlackMessage };

/** The user token, or a redacted error when none resolves. Never log the result. */
export function slackUserToken(): string {
  return requireToken();
}

export interface HistoryOpts {
  token?: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}

/**
 * Messages in a channel newer than `oldest` (exclusive), oldest first. With no
 * `oldest` only the latest page comes back — that is the baseline read, and
 * nothing older than it can matter once the watermark sits past it.
 */
export async function channelHistory(channel: string, oldest: string, opts: HistoryOpts = {}): Promise<SlackMessage[]> {
  try {
    const msgs = await conversationsHistory(channel, { oldest: oldest || undefined, maxPages: oldest ? (opts.maxPages ?? 5) : 1 }, { token: opts.token, fetchImpl: opts.fetchImpl });
    return msgs.sort((a, b) => compareTs(a.ts, b.ts));
  } catch (e) {
    // Keep the old wording the watcher detail shows: "ratelimited (retry-after Ns)", "slack: <code>".
    if (e instanceof SlackError && e.code === 'ratelimited') throw new Error(`ratelimited (retry-after ${e.retryAfter || '?'}s)`);
    if (e instanceof SlackError) throw new Error('slack: ' + e.code);
    throw e;
  }
}

/** Slack ts strings ("1729800000.123456") in numeric order. */
export function compareTs(a: string, b: string): number {
  const [ai, af = ''] = a.split('.');
  const [bi, bf = ''] = b.split('.');
  return Number(ai) - Number(bi) || af.padEnd(6, '0').localeCompare(bf.padEnd(6, '0'));
}


/* ------------------------------------------------ labels for any thread (read-only) */

/** The cached root text of a thread, or null while it is fetched in the background (conversations.replies). */
export function rootTextFor(key: string, api: SlackLookups = defaultLookups): string | null {
  const root = cache().roots[key];
  if (root) return root.text;
  const [channel, ts] = key.split('/');
  fillRoot(key, channel, ts, api);
  return null;
}

/** #name / DM name for a channel id from the labels cache; the raw id when unresolved (a lookup is started). */
export function channelLabelFor(channel: string, api: SlackLookups = defaultLookups): string {
  const labels = channelLabels();
  if (!labels[channel]) fillLabels([channel], api);
  return labels[channel] ?? channel;
}
