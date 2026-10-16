import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';

// Slack threads owned by chats, read from the state the slack-threads hook keeps
// (~/.claude/state/slack-threads.json). Loom only reads it; the hook is the
// writer. Channel labels and root-message previews are slow (network), so they
// come from caches and misses are filled in the background — a panel never
// waits on Slack.

const STATE_DIR = path.join(os.homedir(), '.claude', 'state');
export const THREADS_PATH = path.join(STATE_DIR, 'slack-threads.json');
export const CHANNELS_PATH = path.join(STATE_DIR, 'slack-channels.json');
export const SLACK_CLI = path.join(os.homedir(), '.claude', 'tools', 'slack', 'slack.mjs');
export const THREADS_CLI = path.join(os.homedir(), 'dev', 'toolbox', 'bin', 'slack-threads');
const CACHE_PATH = path.join(TOOL_DIR, 'slack-cache.json');

export interface ThreadRec {
  url: string;
  session_id: string;
  cwd?: string;
  claimed_at?: string;
  stage?: string;
}

export interface OwnedThread {
  key: string; // `<channel>/<ts>`
  url: string;
  channel: string;
  ts: string;
  label: string; // #name / @dm, or the raw id until resolved
  stage: string;
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

/** Session ids that own at least one thread — the board's Slack glyph. */
export function threadOwners(threads: Record<string, ThreadRec> = readThreads()): string[] {
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
}

let cacheMemo: SlackCache | null = null;
function cache(): SlackCache {
  if (!cacheMemo) cacheMemo = { roots: {}, ...readJson<Partial<SlackCache>>(CACHE_PATH, {}) } as SlackCache;
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

function fillTeamId(run: Runner): void {
  if (cache().teamId || !mayTry('team')) return;
  once('team', async () => {
    try {
      const me = JSON.parse(await run('node', [SLACK_CLI, 'whoami']));
      if (me.teamId) {
        cache().teamId = me.teamId;
        saveCache();
      } else failedAt.set('team', Date.now());
    } catch {
      failedAt.set('team', Date.now());
    }
  });
}

function fillLabels(ids: string[], run: Runner): void {
  const missing = ids.filter((id) => mayTry('label:' + id));
  if (!missing.length) return;
  once('labels:' + missing.join(','), async () => {
    try {
      await run(THREADS_CLI, ['channel', ...missing]); // writes CHANNELS_PATH as it resolves
    } catch {
      /* fall through: whatever did not land is marked failed below */
    }
    const labels = readJson<Record<string, string>>(CHANNELS_PATH, {});
    for (const id of missing) if (!labels[id]) failedAt.set('label:' + id, Date.now());
  });
}

function fillRoot(key: string, channel: string, ts: string, run: Runner): void {
  if (!mayTry('root:' + key)) return;
  once('root:' + key, async () => {
    try {
      const out = JSON.parse(await run('node', [SLACK_CLI, 'read-thread', '--channel', channel, '--ts', ts]));
      const root = (out.messages ?? []).find((m: any) => m.ts === ts) ?? out.messages?.[0];
      if (!root) throw new Error('no root');
      cache().roots[key] = { text: String(root.text ?? ''), author: String(root.user ?? '') };
      saveCache();
    } catch {
      failedAt.set('root:' + key, Date.now());
    }
  });
}

const PREVIEW_CHARS = 280;

/** The threads a session owns, with whatever labels and previews are cached. */
export function threadsFor(sessionId: string, run: Runner = defaultRunner, threads: Record<string, ThreadRec> = readThreads()): OwnedThread[] {
  const owned = Object.entries(threads).filter(([, t]) => t.session_id === sessionId);
  if (!owned.length) return [];
  fillTeamId(run);
  const labels = readJson<Record<string, string>>(CHANNELS_PATH, {});
  const out: OwnedThread[] = [];
  const unlabeled: string[] = [];
  for (const [key, t] of owned) {
    const [channel, ts] = key.split('/');
    if (!labels[channel]) unlabeled.push(channel);
    const root = cache().roots[key];
    if (!root) fillRoot(key, channel, ts, run);
    const text = root ? root.text.replace(/\s+/g, ' ').trim() : null;
    out.push({
      key,
      url: t.url,
      channel,
      ts,
      label: labels[channel] ?? channel,
      stage: t.stage ?? '',
      preview: text === null ? null : text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + '…' : text,
      author: root?.author ?? '',
      deeplink: slackDeepLink(channel, ts, cache().teamId ?? '', t.url),
    });
  }
  if (unlabeled.length) fillLabels([...new Set(unlabeled)], run);
  return out.sort((a, b) => b.ts.localeCompare(a.ts));
}

/**
 * Open a thread in the Slack app. `open slack://…` hands it to the app; when
 * there is no app (or no team id yet) the https permalink goes to the browser,
 * which Slack itself redirects into the app when it can.
 */
export async function openThread(key: string, run: Runner = defaultRunner, threads: Record<string, ThreadRec> = readThreads()): Promise<{ ok: boolean; detail: string }> {
  const t = threads[key];
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
