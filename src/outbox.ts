import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';
import { channelLabels } from './slack.ts';
import { parseSlackThread, type ThreadRef } from './slackref.ts';
import { cleanReactions, cleanReview, githubPoster, headMoved, reviewSummary, type DraftReaction, type DraftReview, type GithubPoster, type PostedReview } from './outboxreview.ts';
import {
  authTest,
  chatGetPermalink,
  chatPostMessage,
  conversationsHistory,
  filesCompleteUploadExternal,
  filesGetUploadURLExternal,
  filesInfo,
  conversationsList,
  conversationsOpen,
  conversationsReplies,
  reactionsAdd,
  reactionsRemove,
  usersList,
  type CallOpts,
  type SlackUser,
} from './slackapi.ts';

// Slack drafts awaiting the person's okay. Loom owns the file
// ($LOOM_HOME/outbox.json): chats add and revise drafts through `loom outbox`
// (event files, src/events.ts), and every status change is made here, in
// Loom's one process, with a synchronous read-modify-write. So a chat and Loom
// can never both "send" one draft: the status is re-read at send time, a send
// in flight is held in memory AND on the draft (send_started_at), and a draft
// that is no longer pending is refused.
//
// Older installs kept drafts in ~/.claude/state/slack-outbox.json, written by
// their own CLI. Its drafts are imported here by id (ids preserved) whenever it
// changes, and a status it moved out of pending carries over. While that file is
// still in use (a migrated install), Loom writes its own closes back to it
// (legacyWriteBack): only the close fields, only on the matching pending id,
// under the old CLI's own lock, so a chat or hook reading the old file never
// sees a draft Loom already sent as pending.

export const OUTBOX_PATH = path.join(TOOL_DIR, 'outbox.json');

/** The legacy state dir, or '' when there is none to read (always '' under vitest unless a test points at one). */
export function legacyStateDir(): string {
  const env = process.env.LOOM_SLACK_STATE_DIR?.trim();
  if (env) return env;
  if (process.env.VITEST) return '';
  return path.join(os.homedir(), '.claude', 'state');
}
export const LEGACY_OUTBOX_PATH = legacyStateDir() ? path.join(legacyStateDir(), 'slack-outbox.json') : '';

export type DraftStatus = 'pending' | 'sent' | 'discarded' | 'superseded';

export interface Draft {
  id: string;
  session_id: string;
  channel: string;
  thread_ts?: string;
  thread_url?: string;
  messages: string[];
  /** Files attached to each message, parallel to `messages` (absolute paths). A message with no text and files is an images-only post. */
  files?: string[][];
  status: string; // DraftStatus
  created_at: string; // local 'YYYY-MM-DDTHH:MM:SS', the legacy CLI's format, so string order is time order
  revised_at?: string;
  closed_at?: string;
  sent_at?: string;
  sent_by?: string; // loom | chat
  permalink?: string;
  /** ms: Loom started posting this draft and has not finished. Guards against a second send. */
  send_started_at?: number;
  /** Messages of a burst that went out before a send failed; `messages` then holds only the rest. */
  sent_parts?: { ts: string; text: string }[];
  /** A GitHub PR review that posts first, all comments in one call (src/outboxreview.ts). A review-only draft has no messages and channel ''. */
  review?: DraftReview;
  /** Set the moment GitHub accepted the review: a retry (after a Slack failure) never posts it again. */
  review_posted?: PostedReview;
  /** Slack reactions applied after the messages (the review's status signal on the request). */
  reactions?: DraftReaction[];
  origin?: string; // 'legacy' for a draft imported from the old file
  label?: string; // the channel's #name / @dm, added on read
  stale?: boolean; // added on read: see staleReason
  stale_reason?: string;
}

/** A send interrupted (Loom quit mid-post) holds its draft this long; after that the claim is stale. */
export const SEND_LOCK_MS = 10 * 60_000;

/** Is Loom posting this draft right now (a claim on disk younger than SEND_LOCK_MS)? */
export const inSend = (d: Pick<Draft, 'send_started_at'>, now: number = Date.now()): boolean =>
  !!d.send_started_at && now - d.send_started_at < SEND_LOCK_MS;

/** Local time in the legacy CLI's format. */
export function stamp(ms: number = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* ------------------------------------------------------------------ the file */

function readFile(file: string): Record<string, Draft> {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as { drafts?: Record<string, Draft> };
    return d && typeof d.drafts === 'object' && d.drafts ? d.drafts : {};
  } catch {
    return {};
  }
}

function writeFile(file: string, drafts: Record<string, Draft>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ drafts }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const isDraft = (d: unknown): d is Draft => {
  const x = d as Draft;
  return !!x && typeof x.id === 'string' && !!x.id && typeof x.session_id === 'string' && typeof x.channel === 'string' && !!x.channel
    && Array.isArray(x.messages) && typeof x.status === 'string' && typeof x.created_at === 'string';
};

/** Where a draft goes: its PR when it carries a review (one pending review per PR), else its Slack destination. */
const destKey = (d: Pick<Draft, 'channel' | 'thread_ts' | 'review'>): string =>
  d.review ? `gh:${d.review.repo}#${d.review.pr}` : `${d.channel}|${d.thread_ts ?? ''}`;
const sameDest = (a: Draft, b: Pick<Draft, 'session_id' | 'channel' | 'thread_ts' | 'review'>) =>
  a.session_id === b.session_id && destKey(a) === destKey(b);

/**
 * One pending draft per chat and destination: the newest. Older pending kin
 * become superseded (a re-shown draft replaces the one before it). Returns true
 * when anything changed.
 */
function settleKin(drafts: Record<string, Draft>, d: Draft, now: number): boolean {
  const kin = Object.values(drafts).filter((x) => x.status === 'pending' && sameDest(x, d)).sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  let changed = false;
  for (const x of kin.slice(0, -1)) {
    if (inSend(x, now)) continue; // being posted right now: never retire it underneath the send
    x.status = 'superseded';
    x.closed_at = stamp(now);
    changed = true;
  }
  return changed;
}

/**
 * Fold the legacy file into Loom's drafts. Pure apart from `now`. By id:
 *   - a draft Loom has never seen is imported as is (id preserved)
 *   - a status the old CLI moved out of pending wins over Loom's pending (sent,
 *     discarded and superseded are final, so this can only ever close a draft)
 *   - while both are pending, a later revision of the text carries over
 * Returns true when `own` changed.
 */
export function mergeLegacy(own: Record<string, Draft>, legacy: Record<string, Draft>, now: number = Date.now()): boolean {
  let changed = false;
  for (const d of Object.values(legacy)) {
    if (!isDraft(d)) continue;
    const mine = own[d.id];
    if (!mine) {
      own[d.id] = { ...d, origin: 'legacy' };
      if (d.status === 'pending') settleKin(own, own[d.id], now);
      changed = true;
      continue;
    }
    if (mine.status === 'pending' && d.status !== 'pending') {
      if (inSend(mine, now)) continue; // Loom is posting it; its own outcome decides
      Object.assign(mine, { status: d.status, closed_at: d.closed_at, ...(d.sent_at ? { sent_at: d.sent_at } : {}), ...(d.sent_by ? { sent_by: d.sent_by } : {}), ...(d.permalink ? { permalink: d.permalink } : {}) });
      changed = true;
      continue;
    }
    if (mine.status === 'pending' && d.status === 'pending' && (d.revised_at ?? '') > (mine.revised_at ?? '') && !inSend(mine, now)) {
      if (JSON.stringify(d.messages) !== JSON.stringify(mine.messages)) {
        mine.messages = d.messages;
        delete mine.files; // the legacy file knows nothing of attachments, and its messages no longer line up with them
        mine.revised_at = d.revised_at;
        changed = true;
      }
    }
  }
  return changed;
}

const legacySeen = new Map<string, string>(); // `${file}|${legacy}` -> legacy size:mtime last merged

function syncLegacy(file: string, legacy: string): void {
  if (!legacy) return;
  let sig = '';
  try {
    const st = fs.statSync(legacy);
    sig = `${st.size}:${st.mtimeMs}`;
  } catch {
    return;
  }
  const k = `${file}|${legacy}`;
  if (legacySeen.get(k) === sig) return;
  const own = readFile(file);
  if (mergeLegacy(own, readFile(legacy))) writeFile(file, own);
  legacySeen.set(k, sig);
}

export interface StoreOpts {
  file?: string;
  /** The legacy file to fold in. Defaults to the real one only for the real outbox file. */
  legacy?: string;
  /** Write Loom's closes back to the legacy file. Defaults (real outbox file only) to setLegacyWriteBack's answer. */
  writeBack?: boolean;
}

// Whether the legacy file is still in use. server.ts sets it (setup_origin is
// 'migrated' and the file exists); off by default, so nothing writes it unasked.
let writeBackOn: () => boolean = () => false;
export function setLegacyWriteBack(fn: () => boolean): void {
  writeBackOn = fn;
}

const store = (o: StoreOpts | string | undefined): { file: string; legacy: string; writeBack: boolean } => {
  const opts: StoreOpts = typeof o === 'string' ? { file: o } : (o ?? {});
  const file = opts.file ?? OUTBOX_PATH;
  const legacy = opts.legacy ?? (file === OUTBOX_PATH ? LEGACY_OUTBOX_PATH : '');
  let writeBack = opts.writeBack ?? false;
  if (opts.writeBack === undefined && file === OUTBOX_PATH && legacy) {
    try {
      writeBack = writeBackOn();
    } catch {
      writeBack = false;
    }
  }
  return { file, legacy, writeBack: writeBack && !!legacy };
};

/** The fields a close sets, exactly as the old CLI's `outbox sent|discard|supersede` set them. */
export const CLOSE_FIELDS = ['status', 'closed_at', 'sent_at', 'sent_by', 'permalink'] as const;
export type LegacyClose = { id: string } & Partial<Record<(typeof CLOSE_FIELDS)[number], string>>;

// The old CLI's write, reproduced: flock(LOCK_EX) on `<file>.lock`, read, change,
// json.dump(indent=2, sort_keys=True) to `<file>.tmp`, os.replace. Node has no
// flock, so the same Python does it; a draft that is not pending there (or not
// there at all) is left alone, and no other draft's content changes.
const WRITE_BACK_PY = `
import fcntl, json, os, sys
path = sys.argv[1]
changes = json.load(sys.stdin)
with open(path + ".lock", "w") as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        with open(path) as f:
            data = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        sys.exit(0)
    drafts = data.get("drafts") or {}
    done = []
    for c in changes:
        d = drafts.get(c["id"])
        if not isinstance(d, dict) or d.get("status") != "pending":
            continue
        for k, v in c.items():
            if k != "id" and v:
                d[k] = v
        done.append(c["id"])
    if done:
        tmp = path + ".tmp"
        with open(tmp, "w") as f:
            json.dump(data, f, indent=2, sort_keys=True)
        os.replace(tmp, path)
    print(json.dumps(done))
`;

/** Write closes back to the legacy file. Returns the ids changed there. Never throws. */
export function legacyWriteBack(legacy: string, changes: LegacyClose[]): string[] {
  if (!legacy || !changes.length || !fs.existsSync(legacy)) return [];
  try {
    const out = execFileSync('python3', ['-c', WRITE_BACK_PY, legacy], { input: JSON.stringify(changes), encoding: 'utf-8', timeout: 10_000 });
    return JSON.parse(out.trim() || '[]') as string[];
  } catch (e) {
    console.error('[loom] outbox: writing back to the legacy file failed:', (e as Error).message);
    return [];
  }
}

/** Every draft, any status. */
export function readOutbox(o?: StoreOpts | string): Record<string, Draft> {
  const s = store(o);
  try {
    syncLegacy(s.file, s.legacy);
  } catch (e) {
    console.error('[loom] outbox: legacy import failed:', (e as Error).message);
  }
  return readFile(s.file);
}

export type Mutation<T> = (drafts: Record<string, Draft>) => { write: boolean; result: T };

/** Read, change, write: synchronous, so nothing else in Loom's process can interleave. */
export function mutateOutbox<T>(o: StoreOpts | string | undefined, fn: Mutation<T>): T {
  const s = store(o);
  const drafts = readOutbox(s);
  const before = new Map(Object.values(drafts).map((d) => [d.id, d.status]));
  const { write, result } = fn(drafts);
  if (write) {
    writeFile(s.file, drafts);
    if (s.writeBack) {
      // Every draft this change moved out of pending (a close, or a supersede by a newer draft).
      const closes: LegacyClose[] = Object.values(drafts)
        .filter((d) => before.get(d.id) === 'pending' && d.status !== 'pending')
        .map((d) => ({ id: d.id, status: d.status, closed_at: d.closed_at, sent_at: d.sent_at, sent_by: d.sent_by, permalink: d.permalink }));
      if (closes.length) legacyWriteBack(s.legacy, closes);
    }
  }
  return result;
}

export interface Outcome {
  ok: boolean;
  detail: string;
}

/** Per-message attachments: absolute paths only, at most MAX_FILES a message. Null when malformed; [] / all-empty when there are none. */
export const MAX_FILES = 10;
const cleanFiles = (files: unknown, n: number): string[][] | null => {
  if (files === undefined || files === null) return Array.from({ length: n }, () => []);
  if (!Array.isArray(files) || files.length > n) return null;
  const out: string[][] = [];
  for (let i = 0; i < n; i++) {
    const f = files[i] ?? [];
    if (!Array.isArray(f) || f.length > MAX_FILES || !f.every((x) => typeof x === 'string' && path.isAbsolute(x))) return null;
    out.push(f as string[]);
  }
  return out;
};
const hasFiles = (files: string[][] | undefined): boolean => !!files?.some((f) => f.length);
/** Every message needs text, unless it carries files (an images-only post). */
const cleanMessages = (messages: unknown, files?: string[][]): string[] | null => {
  if (!Array.isArray(messages) || !messages.length) return null;
  const out = messages.map((m) => (typeof m === 'string' ? m.trim() : ''));
  return out.every((m, i) => m || files?.[i]?.length) ? out : null;
};

export interface AddInput {
  id: string;
  session_id: string;
  channel: string;
  thread_ts?: string;
  thread_url?: string;
  messages: string[];
  files?: string[][];
  review?: unknown;
  reactions?: unknown;
  at?: number;
}

/**
 * Record a draft (`loom outbox add`). An id Loom already holds is left alone,
 * so ingesting the same event twice changes nothing. A newer draft for the same
 * chat and destination supersedes the pending one.
 */
export function addDraft(input: AddInput, o?: StoreOpts | string): Outcome {
  const rv = input.review === undefined || input.review === null ? null : cleanReview(input.review);
  if (rv && !rv.ok) return { ok: false, detail: rv.detail };
  const rx = cleanReactions(input.reactions);
  if (!rx.ok) return { ok: false, detail: rx.detail };
  const review = rv?.ok ? rv.review : undefined;
  // A review-only draft (with or without reactions) has no Slack messages and no channel.
  const noSlack = !!review && (!Array.isArray(input.messages) || !input.messages.length);
  const files = noSlack ? [] : cleanFiles(input.files, Array.isArray(input.messages) ? input.messages.length : 0);
  if (!files) return { ok: false, detail: 'files must be absolute paths, up to ' + MAX_FILES + ' per message' };
  const messages = noSlack ? [] : cleanMessages(input.messages, files);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(input.id || '')) return { ok: false, detail: 'bad id' };
  if (!input.session_id) return { ok: false, detail: 'session is required' };
  if (!noSlack && (!input.channel || input.channel.length > 200)) return { ok: false, detail: 'channel is required' };
  if (!messages) return { ok: false, detail: 'every message needs text' };
  const now = input.at ?? Date.now();
  return mutateOutbox<Outcome>(o, (drafts) => {
    if (drafts[input.id]) return { write: false, result: { ok: true, detail: 'already recorded' } };
    const d: Draft = {
      id: input.id,
      session_id: input.session_id,
      channel: noSlack ? (input.channel || '').slice(0, 200) : input.channel,
      ...(input.thread_ts ? { thread_ts: input.thread_ts } : {}),
      ...(input.thread_url ? { thread_url: input.thread_url } : {}),
      messages,
      ...(hasFiles(files) ? { files } : {}),
      ...(review ? { review } : {}),
      ...(rx.reactions.length ? { reactions: rx.reactions } : {}),
      status: 'pending',
      created_at: stamp(now),
    };
    drafts[d.id] = d;
    settleKin(drafts, d, now);
    return { write: true, result: { ok: true, detail: 'recorded' } };
  });
}

/**
 * Replace a pending draft's text in place (`loom outbox update`): same id, a revision.
 * `extra.review` / `extra.reactions` replace those parts (null drops them). With
 * `messages` null the Slack text is kept, so a review can be revised by itself.
 */
export function updateDraft(
  id: string,
  messages: string[] | null,
  o?: StoreOpts | string,
  at: number = Date.now(),
  files?: string[][],
  extra: { review?: unknown; reactions?: unknown } = {},
): Outcome {
  const rv = extra.review === undefined || extra.review === null ? null : cleanReview(extra.review);
  if (rv && !rv.ok) return { ok: false, detail: rv.detail };
  const rx = extra.reactions === undefined ? null : cleanReactions(extra.reactions);
  if (rx && !rx.ok) return { ok: false, detail: rx.detail };
  return mutateOutbox<Outcome>(o, (drafts) => {
    const d = drafts[id];
    if (!d) return { write: false, result: { ok: false, detail: 'no such draft' } };
    if (d.status !== 'pending') return { write: false, result: { ok: false, detail: `already ${d.status}` } };
    if (inSend(d, at)) return { write: false, result: { ok: false, detail: 'being sent' } };
    const before = JSON.stringify([d.review ?? null, d.reactions ?? null]);
    if (extra.review !== undefined) {
      if (d.review_posted) return { write: false, result: { ok: false, detail: 'the review is already posted' } };
      if (rv?.ok) d.review = rv.review;
      else delete d.review;
    }
    if (rx?.ok) {
      if (rx.reactions.length) d.reactions = rx.reactions;
      else delete d.reactions;
    }
    const partsChanged = JSON.stringify([d.review ?? null, d.reactions ?? null]) !== before;
    if (!d.review && !d.messages.length && messages === null) return { write: false, result: { ok: false, detail: 'a draft needs messages or a review' } };
    if (messages === null || (d.review && Array.isArray(messages) && !messages.length && !d.messages.length)) {
      if (!partsChanged) return { write: false, result: { ok: true, detail: 'unchanged' } };
      d.revised_at = stamp(at);
      return { write: true, result: { ok: true, detail: 'updated' } };
    }
    // `files` omitted keeps the draft's attachments when the message count is unchanged; given, it replaces them.
    const given = files !== undefined;
    const newFiles = given ? cleanFiles(files, Array.isArray(messages) ? messages.length : 0) : undefined;
    if (given && !newFiles) return { write: false, result: { ok: false, detail: 'files must be absolute paths, up to ' + MAX_FILES + ' per message' } };
    const nf = given ? newFiles! : Array.isArray(messages) && messages.length === d.messages.length ? (d.files ?? cleanFiles(undefined, messages.length)!) : cleanFiles(undefined, Array.isArray(messages) ? messages.length : 0)!;
    const next = cleanMessages(messages, nf);
    if (!next) return { write: false, result: { ok: false, detail: 'every message needs text' } };
    if (!d.channel) return { write: false, result: { ok: false, detail: 'this draft has no Slack destination; record a new one with --thread or --channel' } };
    if (!partsChanged && JSON.stringify(d.messages) === JSON.stringify(next) && JSON.stringify(d.files ?? []) === JSON.stringify(hasFiles(nf) ? nf : [])) return { write: false, result: { ok: true, detail: 'unchanged' } };
    d.messages = next;
    if (hasFiles(nf)) d.files = nf;
    else delete d.files;
    d.revised_at = stamp(at);
    return { write: true, result: { ok: true, detail: 'updated' } };
  });
}

/** Move a pending draft to a final status. Refuses one that is not pending, or that Loom is posting (unless `bySend`). */
export function closeDraft(
  id: string,
  status: 'sent' | 'discarded' | 'superseded',
  extra: { by?: string; permalink?: string; bySend?: boolean; at?: number } = {},
  o?: StoreOpts | string,
): Outcome {
  const now = extra.at ?? Date.now();
  return mutateOutbox<Outcome>(o, (drafts) => {
    const d = drafts[id];
    if (!d) return { write: false, result: { ok: false, detail: 'no such draft' } };
    if (d.status !== 'pending') return { write: false, result: { ok: false, detail: `already ${d.status}` } };
    if (inSend(d, now) && !extra.bySend) return { write: false, result: { ok: false, detail: 'being sent' } };
    d.status = status;
    d.closed_at = stamp(now);
    delete d.send_started_at;
    if (status === 'sent') {
      d.sent_at = d.closed_at;
      d.sent_by = extra.by ?? 'chat';
      if (extra.permalink) d.permalink = extra.permalink;
    }
    return { write: true, result: { ok: true, detail: status } };
  });
}

/* ------------------------------------------------------------- stale marks */

/** Pending drafts that Loom has found a newer post by the person beside. */
export const STALE_PATH = path.join(TOOL_DIR, 'outbox-stale.json');
export const STALE_AFTER_MS = 48 * 3600_000;

export function readStaleMarks(file: string = STALE_PATH): Record<string, number> {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, number>;
  } catch {
    return {};
  }
}

export function writeStaleMarks(marks: Record<string, number>, file: string = STALE_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(marks));
}

/**
 * Why a pending draft is probably dead, or '' when it is live. A stale draft is
 * shown dimmed with the reason, never dropped: only the person (or the chat) closes it.
 *   - its chat has ended (no pane): nothing will ever follow up on it
 *   - it is over 48h old and the person has since posted in its thread
 */
export function staleReason(d: Pick<Draft, 'created_at'>, opts: { chatLive: boolean; willPostedAfter: boolean; now?: number }): string {
  if (!opts.chatLive) return 'chat ended';
  const t = Date.parse(d.created_at);
  if (opts.willPostedAfter && !isNaN(t) && (opts.now ?? Date.now()) - t > STALE_AFTER_MS) return 'you posted in this thread since';
  return '';
}

export function pendingDrafts(
  file?: string,
  labelsFile?: string,
  opts: { liveSessions?: Set<string>; marks?: Record<string, number>; now?: number; legacy?: string } = {},
): Draft[] {
  let labels: Record<string, string> = {};
  try {
    labels = labelsFile ? JSON.parse(fs.readFileSync(labelsFile, 'utf-8')) : channelLabels();
  } catch {
    /* unlabeled: the raw destination shows instead */
  }
  return Object.values(readOutbox({ file, legacy: opts.legacy }))
    .filter((d) => d.status === 'pending' && Array.isArray(d.messages) && (d.messages.length || d.review))
    .map((d) => {
      const reason = opts.liveSessions
        ? staleReason(d, { chatLive: opts.liveSessions.has(d.session_id), willPostedAfter: !!opts.marks?.[d.id], now: opts.now })
        : '';
      return { ...d, label: labels[d.channel] ?? d.channel, ...(reason ? { stale: true, stale_reason: reason } : {}) };
    })
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** Every draft for the CLI's list: pending only, or (all) everything closed within `keepDays`. Oldest first. */
export function listDrafts(o: StoreOpts | string | undefined, all: boolean, keepDays = 14, now: number = Date.now()): Draft[] {
  const cutoff = stamp(now - keepDays * 86_400_000);
  return Object.values(readOutbox(o))
    .filter((d) => d.status === 'pending' || (all && (d.closed_at ?? d.created_at) >= cutoff))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/* ------------------------------------------------------------------ sending */

/**
 * Slack speaks mrkdwn, not markdown: the conversion the old CLI applied on send,
 * kept byte for byte so a draft reads the same whichever path posts it. Fenced
 * blocks and inline code are left alone.
 */
export function toMrkdwn(text: string): string {
  const segments = text.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return segments
    .map((seg, i) => {
      if (i % 2 === 1) return seg;
      return seg
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<$2|$1>')
        .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
        .replace(/__([^_\n]+)__/g, '_$1_')
        .replace(/~~([^~\n]+)~~/g, '~$1~')
        .replace(/^#{1,6}[ \t]+(.+)$/gm, '*$1*')
        .replace(/^([ \t]*)\*[ \t]+/gm, '$1• ');
    })
    .join('');
}

/** What one send posts: the destination and the messages, in order. */
export function sendPayload(d: Pick<Draft, 'channel' | 'thread_ts'>, messages: string[]): Record<string, unknown> {
  return {
    channel: d.channel,
    ...(messages.length === 1 ? { text: messages[0] } : { messages }),
    ...(d.thread_ts ? { thread_ts: d.thread_ts } : {}),
  };
}

/** The pause before the next message of a burst: how long it would take to type it (~3 s, +1 s per 30 chars, max 15 s). */
export const burstGapMs = (text: string): number => Math.min(15_000, 3_000 + Math.round((text.length / 30) * 1000));

/** The Slack calls a send makes. The real one is slackPoster(); tests pass a fetch stub through it. */
export interface SlackPoster {
  resolveChannel(target: string): Promise<string>;
  post(p: { channel: string; text: string; thread_ts?: string }): Promise<{ channel: string; ts: string }>;
  /** Upload local files into a channel/thread as ONE message, `comment` as its text. Returns where it landed (ts '' when Slack did not say). */
  upload(p: { channel: string; thread_ts?: string; paths: string[]; comment?: string }): Promise<{ channel: string; ts: string }>;
  permalink(channel: string, ts: string): Promise<string>;
  /** Add or remove one reaction. Already there / already gone count as done. */
  react?(p: { channel: string; ts: string; name: string; remove?: boolean }): Promise<void>;
  sleep(ms: number): Promise<void>;
}

const userFields = (u: SlackUser & { real_name?: string; profile?: { display_name?: string; real_name?: string; email?: string } }) =>
  [u.name, u.real_name, u.profile?.display_name, u.profile?.real_name, u.profile?.email].filter(Boolean).map((s) => String(s).toLowerCase());

/** The Web API behind a send (src/slackapi.ts). `opts` carries a fetch stub in tests. */
export function slackPoster(opts: CallOpts = {}): SlackPoster {
  const byName = async (name: string): Promise<string> => {
    const needle = name.replace(/^#/, '').toLowerCase();
    const all = await conversationsList({}, opts);
    const exact = all.find((c) => c.name === needle);
    if (exact) return exact.id;
    const hits = all.filter((c) => c.name?.includes(needle));
    if (hits.length !== 1) throw new Error(hits.length ? `"${name}" matches ${hits.length} channels` : `no channel matching "${name}"`);
    return hits[0].id;
  };
  const user = async (q: string): Promise<string> => {
    const bare = q.replace(/^@/, '');
    if (/^U[A-Z0-9]{6,}$/i.test(bare)) return bare.toUpperCase();
    const needle = bare.toLowerCase();
    const active = (await usersList({}, opts)).filter((u: any) => !u.deleted && !u.is_bot && u.id !== 'USLACKBOT');
    const exact = active.filter((u) => userFields(u as any).includes(needle));
    const hits = exact.length ? exact : active.filter((u) => userFields(u as any).some((f) => f.includes(needle)));
    if (hits.length !== 1) throw new Error(hits.length ? `"${q}" matches ${hits.length} people` : `no person matching "${q}"`);
    return hits[0].id;
  };
  return {
    async resolveChannel(target) {
      if (/^[CGD][A-Z0-9]{6,}$/.test(target)) return target;
      if (target.startsWith('#')) return byName(target);
      if (target.startsWith('@') || /^U[A-Z0-9]{6,}$/i.test(target)) return conversationsOpen(await user(target), opts);
      return byName(target);
    },
    post: (p) => chatPostMessage({ ...p, unfurl_links: true, unfurl_media: true }, opts),
    async upload(p) {
      const doFetch = opts.fetchImpl ?? fetch;
      const up: { id: string; title: string }[] = [];
      for (const file of p.paths) {
        const bytes = fs.readFileSync(file);
        const title = path.basename(file);
        const slot = await filesGetUploadURLExternal(title, bytes.length, opts);
        const r = await doFetch(slot.upload_url, { method: 'POST', body: new Uint8Array(bytes), signal: AbortSignal.timeout(60_000) });
        if (!r.ok) throw new Error(`upload of ${title} failed: HTTP ${r.status}`);
        up.push({ id: slot.file_id, title });
      }
      const done = await filesCompleteUploadExternal({
        files: up,
        channel_id: p.channel,
        ...(p.thread_ts ? { thread_ts: p.thread_ts } : {}),
        ...(p.comment ? { initial_comment: p.comment } : {}),
      }, opts);
      // The share lands asynchronously, so the message ts is not in the response: poll the file's shares for it.
      const id = (done.files as { id?: string }[] | undefined)?.[0]?.id ?? up[0].id;
      for (let i = 0; i < 8; i++) {
        try {
          const info = (await filesInfo(id, opts)) as { shares?: Record<string, Record<string, { ts?: string }[]>> };
          const hit = (info.shares?.public?.[p.channel] ?? info.shares?.private?.[p.channel] ?? [])[0];
          if (hit?.ts) return { channel: p.channel, ts: hit.ts };
        } catch {
          /* files:read may be missing: the post is out either way */
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      return { channel: p.channel, ts: '' };
    },
    permalink: (channel, ts) => chatGetPermalink(channel, ts, opts),
    async react(p) {
      try {
        await (p.remove ? reactionsRemove : reactionsAdd)(p.channel, p.ts, p.name, opts);
      } catch (e) {
        if (!/already_reacted|no_reaction/.test((e as Error).message)) throw e;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

export interface SendResult {
  ok: boolean;
  detail: string;
  dry?: boolean;
  permalink?: string;
  rendered?: string;
  /** Messages that went out before a burst failed. The draft keeps the rest, still pending. */
  partial?: number;
  /** The PR has moved past the commit the review was drafted against: send again with ackStale to post anyway. */
  stale_head?: string;
  /** The review's url, once GitHub has it. */
  review_url?: string;
}

const sendingNow = new Set<string>();

/** Is Loom posting this draft right now (in this process)? */
export const isSending = (id: string): boolean => sendingNow.has(id);

/** Where a send is: messages posted so far, and when the next one goes out (null while one is posting). In memory only. */
export interface SendProgress {
  total: number;
  sent: number;
  next_at: number | null;
  started_at: number;
  /** What is going out now: the GitHub review, the Slack messages, or the reactions. */
  phase?: 'review' | 'slack' | 'reactions';
}
const progress = new Map<string, { p: SendProgress; skip: (() => void) | null }>();

/** Progress of every draft being posted right now, by draft id. */
export function sendProgress(): Record<string, SendProgress> {
  const out: Record<string, SendProgress> = {};
  for (const [id, e] of progress) out[id] = { ...e.p };
  return out;
}

/** Cut the current typing gap short so the next message posts now. One message per call; false when no gap is running. */
export function sendNow(id: string): boolean {
  const e = progress.get(id);
  if (!e?.skip) return false;
  const skip = e.skip;
  e.skip = null;
  skip();
  return true;
}

export interface SendOpts extends StoreOpts {
  dry?: boolean;
  slack?: SlackPoster;
  now?: () => number;
  /** A top-level post started a thread: the chat that wrote the draft owns it. */
  onStarted?: (ref: ThreadRef, sessionId: string) => void;
  /** An earlier send of this draft was interrupted: did it land? Returns true when it did (and marks it). */
  checkPosted?: (id: string) => Promise<boolean>;
  /** The GitHub side of a review draft. Defaults to the person's own `gh`. */
  github?: GithubPoster;
  /** The person saw "PR has new commits" and sends anyway (still against the stored commit). */
  ackStale?: boolean;
}

/**
 * Post a draft as the person, exactly as the confirm dialog showed it, then mark
 * it sent. `dry` renders what would be posted and touches nothing.
 *
 * Never sent twice: one send per draft at a time (in memory), the draft carries
 * send_started_at while it is posted (so a restart mid-send does not resend
 * blind), and the status is re-checked first. A burst that fails part-way keeps
 * the unsent messages as the pending draft, so a retry posts only those.
 *
 * A draft with a review sends in this order: the GitHub review (one call, all
 * inline comments), then the Slack burst, then the reactions. A review that fails
 * stops the send before Slack. The posted review is recorded on the draft at once
 * (review_posted), so a retry after a Slack failure posts only the Slack part. A
 * PR whose head moved past review.commit_id is refused with stale_head until the
 * send is repeated with ackStale; it still posts against the stored commit.
 */
export async function sendDraft(id: string, messages: string[], opts: SendOpts = {}): Promise<SendResult> {
  const now = opts.now ?? Date.now;
  let d = readOutbox(opts)[id];
  if (!d) return { ok: false, detail: 'no such draft' };
  if (d.status !== 'pending') return { ok: false, detail: `already ${d.status}` };
  if (!Array.isArray(messages)) return { ok: false, detail: 'every message needs text' };
  // No Slack text: only a review draft (with or without reactions) may go out without messages.
  const noSlack = messages.length === 0;
  if (noSlack && (d.messages?.length || !d.review)) return { ok: false, detail: 'every message needs text' };
  const files = noSlack ? [] : cleanFiles(d.files, messages.length);
  const clean = noSlack ? [] : files ? cleanMessages(messages, files) : null;
  if (!clean || !files || clean.length !== messages.length) return { ok: false, detail: 'every message needs text' };
  const reactions = d.reactions ?? [];
  const reactLine = reactions.length ? reactions.map((r) => `[react ${r.channel}/${r.ts}: ${[...(r.add ?? []).map((e) => '+' + e), ...(r.remove ?? []).map((e) => '-' + e)].join(' ')}]`).join('\n') : '';
  const attached = (i: number) => (files[i]?.length ? `\n[+ ${files[i].length} file${files[i].length === 1 ? '' : 's'}: ${files[i].map((f) => path.basename(f)).join(', ')}]` : '');
  if (opts.dry) {
    const parts = [
      ...(d.review && !d.review_posted ? [`[GitHub] ${reviewSummary(d.review)} (commit ${d.review.commit_id.slice(0, 7)})`] : d.review_posted ? [`[GitHub] review already posted: ${d.review_posted.url}`] : []),
      ...clean.map((t, i) => (t ? toMrkdwn(t) : '(no text)') + attached(i)),
      ...(reactLine ? [reactLine] : []),
    ];
    return { ok: true, dry: true, detail: 'dry run: nothing posted', rendered: parts.join('\n---\n') };
  }
  // Every attachment must be readable before anything is posted: a missing file is not found halfway through a burst.
  const missing = files.flat().find((f) => !fs.existsSync(f));
  if (missing) return { ok: false, detail: `file not found: ${missing}` };
  if (sendingNow.has(id)) return { ok: false, detail: 'already sending' };
  sendingNow.add(id);
  const gh = opts.github ?? githubPoster();
  try {
    if (d.send_started_at) {
      if (inSend(d, now())) return { ok: false, detail: 'an earlier send of this draft was interrupted; check Slack, then try again in a few minutes' };
      // The review goes first, so an interrupted send may have posted it without recording it: look on GitHub.
      if (d.review && !d.review_posted) {
        try {
          const hit = await gh.findPosted(d.review);
          if (hit) d = recordReview(id, hit, now(), opts) ?? d;
        } catch (e) {
          return { ok: false, detail: 'an earlier send was interrupted and GitHub could not be checked for the review: ' + (e as Error).message };
        }
      }
      if (clean.length) {
        try {
          if (await (opts.checkPosted ?? (async () => false))(id)) return { ok: false, detail: 'already sent (found in Slack)' };
        } catch (e) {
          return { ok: false, detail: 'an earlier send was interrupted and Slack could not be checked: ' + (e as Error).message };
        }
      }
    }
    const review = d.review && !d.review_posted ? d.review : null;
    // The PR moved on since the review was drafted: say so, and post only on a second, deliberate send.
    if (review && !opts.ackStale) {
      let sha = '';
      try {
        sha = (await gh.head(review.repo, review.pr)).sha;
      } catch (e) {
        return { ok: false, detail: 'could not check the PR head before posting the review: ' + (e as Error).message };
      }
      if (headMoved(review.commit_id, sha)) return { ok: false, stale_head: sha, detail: 'PR has new commits since this review was drafted' };
    }
    // Claim the draft on disk before anything is posted.
    const claimed = mutateOutbox(opts, (all) => {
      const x = all[id];
      if (!x || x.status !== 'pending') return { write: false, result: x ? `already ${x.status}` : 'no such draft' };
      if (review && x.review_posted) return { write: false, result: 'the review was posted by another send' };
      x.send_started_at = now();
      return { write: true, result: '' };
    });
    if (claimed) return { ok: false, detail: claimed };
    const slack = opts.slack ?? slackPoster();
    const sent: { ts: string; text: string }[] = [];
    let channel = '';
    const entry = { p: { total: clean.length, sent: 0, next_at: null as number | null, started_at: now(), phase: (review ? 'review' : 'slack') as SendProgress['phase'] }, skip: null as (() => void) | null };
    progress.set(id, entry);
    // (a)+(b) The review: one call, every inline comment at once, no spacing. A failure stops the send before Slack.
    let reviewUrl = d.review_posted?.url ?? '';
    if (review) {
      let posted: { id: number; url: string };
      try {
        posted = await gh.post(review);
      } catch (e) {
        releaseClaim(id, opts);
        return { ok: false, detail: 'GitHub review failed: ' + (e as Error).message + '. Nothing was posted to Slack.' };
      }
      reviewUrl = posted.url;
      recordReview(id, posted, now(), opts);
    }
    const reviewNote = review ? 'review posted; ' : d.review_posted ? 'review was already posted; ' : '';
    entry.p.phase = 'slack';
    // (c) The Slack burst, spaced as before. No gap before the first message: the review is not a message.
    try {
      if (clean.length) channel = await slack.resolveChannel(d.channel);
      for (const [i, text] of clean.entries()) {
        if (i > 0) {
          const gap = burstGapMs(text);
          entry.p.next_at = now() + gap;
          // Send now resolves this race; the sleep itself is left to run out, and nothing posts from it.
          await Promise.race([slack.sleep(gap), new Promise<void>((r) => { entry.skip = r; })]);
          entry.skip = null;
          entry.p.next_at = null;
        }
        // A top-level draft's images-only message is the thread reply under message 1; text messages stay where they are today.
        let thread = d.thread_ts;
        if (!thread && !text && files[i].length && (i > 0 || d.sent_parts?.length)) {
          thread = d.sent_parts?.[0]?.ts || sent[0]?.ts;
          if (!thread) throw new Error('message 1 went out but Slack did not report its timestamp, so the images cannot be threaded under it');
        }
        const dest = { channel, ...(thread ? { thread_ts: thread } : {}) };
        // Text and images are ONE Slack message (the text rides on the upload), so a retry never re-uploads what is out.
        const r = files[i].length
          ? await slack.upload({ ...dest, paths: files[i], ...(text ? { comment: toMrkdwn(text) } : {}) })
          : await slack.post({ ...dest, text: toMrkdwn(text) });
        sent.push({ ts: r.ts, text });
        entry.p.sent = sent.length;
        channel = r.channel || channel;
      }
    } catch (e) {
      const why = (e as Error).message;
      if (!sent.length) {
        releaseClaim(id, opts);
        return { ok: false, ...(reviewUrl ? { review_url: reviewUrl } : {}), detail: reviewNote + 'send failed: ' + why + (reviewNote ? '. Send again posts only the Slack part.' : '') };
      }
      // Part of a burst is out. Never resend it: the draft keeps only the rest.
      mutateOutbox(opts, (all) => {
        const x = all[id];
        if (!x) return { write: false, result: null };
        x.sent_parts = [...(x.sent_parts ?? []), ...sent];
        x.messages = clean.slice(sent.length);
        const rest = files.slice(sent.length);
        if (hasFiles(rest)) x.files = rest;
        else delete x.files;
        x.revised_at = stamp(now());
        delete x.send_started_at;
        return { write: true, result: null };
      });
      return { ok: false, partial: sent.length, ...(reviewUrl ? { review_url: reviewUrl } : {}), detail: `${reviewNote}posted ${sent.length} of ${clean.length} messages, then: ${why}. The rest are still in the draft.` };
    }
    // (d) The reactions. The messages are out, so a reaction that fails is reported, never a reason to resend.
    entry.p.phase = 'reactions';
    const reactFailed: string[] = [];
    for (const r of reactions) {
      for (const [name, remove] of [...(r.add ?? []).map((n) => [n, false] as const), ...(r.remove ?? []).map((n) => [n, true] as const)]) {
        try {
          if (!slack.react) throw new Error('reactions are not supported');
          await slack.react({ channel: r.channel, ts: r.ts, name, remove });
        } catch (e) {
          reactFailed.push(`${remove ? '-' : '+'}${name} (${(e as Error).message})`);
        }
      }
    }
    let permalink = '';
    try {
      if (sent[0]?.ts) permalink = await slack.permalink(channel, sent[0].ts);
    } catch {
      /* posted; the permalink is a nicety */
    }
    const marked = closeDraft(id, 'sent', { by: 'loom', permalink: permalink || reviewUrl, bySend: true, at: now() }, opts);
    if (!d.thread_ts && opts.onStarted && sent[0]?.ts) {
      const ref = parseSlackThread(permalink) ?? { key: `${channel}/${sent[0].ts}`, url: '', channel, ts: sent[0].ts, linkTs: sent[0].ts };
      if (ref.ts === ref.linkTs && !ref.channel.startsWith('D')) {
        try {
          opts.onStarted(ref, d.session_id);
        } catch {
          /* ownership is a convenience; the post went out */
        }
      }
    }
    const extra = { ...(permalink ? { permalink } : {}), ...(reviewUrl ? { review_url: reviewUrl } : {}) };
    // The message IS out. A failed mark says so loudly rather than inviting a resend.
    if (!marked.ok) return { ok: true, ...extra, detail: 'posted, but marking it sent failed: ' + marked.detail };
    if (reactFailed.length) return { ok: true, ...extra, detail: 'posted, but reactions failed: ' + reactFailed.join(', ') };
    return { ok: true, ...extra, detail: 'posted' };
  } finally {
    progress.delete(id);
    sendingNow.delete(id);
  }
}

/** Record the posted review on the draft (keeping the send claim). Returns the draft as written. */
function recordReview(id: string, posted: { id: number; url: string }, at: number, o: StoreOpts): Draft | null {
  return mutateOutbox<Draft | null>(o, (all) => {
    const x = all[id];
    if (!x) return { write: false, result: null };
    x.review_posted = { id: posted.id, url: posted.url, at: stamp(at) };
    return { write: true, result: x };
  });
}

function releaseClaim(id: string, o: StoreOpts): void {
  mutateOutbox(o, (all) => {
    const x = all[id];
    if (!x?.send_started_at) return { write: false, result: null };
    delete x.send_started_at;
    return { write: true, result: null };
  });
}

export async function discardDraft(id: string, o?: StoreOpts | string): Promise<SendResult> {
  if (sendingNow.has(id)) return { ok: false, detail: 'being sent' };
  const r = closeDraft(id, 'discarded', {}, o);
  return r.ok ? { ok: true, detail: 'discarded' } : { ok: false, detail: r.detail === 'no such draft' ? r.detail : r.detail.startsWith('already') ? r.detail : 'discard failed: ' + r.detail };
}

/* ------------------------------------------------------------ reconciliation */

// A draft can be posted outside Loom (pasted into Slack by hand, or sent by the
// chat through its own Slack tool), and none of those marks the draft. So a
// pending draft is checked read-only against its thread (or, unthreaded, its
// channel's history): a message from the person, posted after the draft was made,
// whose opening text matches one of the draft's messages (or of a superseded
// revision from the same chat) means it went out.

/** Text as Slack stores it vs as the draft holds it: entities, link wrappers and marks removed. */
export function normalizeForMatch(t: string): string {
  return String(t ?? '')
    .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
    .replace(/<([^<>|]+)\|([^<>]*)>/g, '$2 $1').replace(/<([^<>]+)>/g, '$1')
    .replace(/[*_~`]/g, '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
}

const MATCH_LEN = 50;

export function draftSentIn(candidates: string[], posted: string[]): boolean {
  const heads = candidates.map((c) => normalizeForMatch(c).slice(0, MATCH_LEN)).filter((h) => h.length >= 12);
  const texts = posted.map(normalizeForMatch);
  return heads.some((h) => texts.some((t) => t.startsWith(h)));
}

export interface ReconcileDeps {
  me: string; // the person's Slack user id
  replies: (channel: string, threadTs: string) => Promise<{ ts: string; user?: string; text?: string }[]>;
  mark: (id: string, permalink: string) => Promise<void>;
  file?: string;
  legacy?: string;
  /** Only look at these drafts (a draft that is being sent right now). */
  only?: string[];
  /** Recent messages in a channel after `oldest` (epoch seconds): lets an unthreaded draft be found. */
  history?: (channel: string, oldest: string) => Promise<{ ts: string; user?: string; text?: string }[]>;
  /** Called with the ids of pending drafts whose thread has a later post by the person (that is not the draft). */
  willPosted?: (ids: string[]) => void;
}

/** Marks pending drafts that already appear in Slack. Returns the ids marked. */
export async function reconcileDrafts(deps: ReconcileDeps): Promise<string[]> {
  const all = Object.values(readOutbox({ file: deps.file, legacy: deps.legacy }));
  const done: string[] = [];
  const posted: string[] = [];
  for (const d of all) {
    if (d.status !== 'pending' || !/^[A-Z0-9]+$/.test(d.channel) || !d.messages?.length) continue;
    // A review not yet posted: Slack alone cannot say the draft went out, and marking it would drop the review.
    if (d.review && !d.review_posted) continue;
    // Loom is posting this one itself: its own outcome marks it. (Asked about by
    // id, as the check before retrying an interrupted send does, it is looked at.)
    if ((inSend(d) || sendingNow.has(d.id)) && !deps.only?.includes(d.id)) continue;
    if (!d.thread_ts && !deps.history) continue;
    if (deps.only && !deps.only.includes(d.id)) continue;
    const created = Date.parse(d.created_at);
    const kin = all.filter((x) => x.session_id === d.session_id && x.channel === d.channel && x.thread_ts === d.thread_ts && x.status !== 'discarded');
    const candidates = kin.flatMap((x) => x.messages ?? []);
    let msgs: { ts: string; user?: string; text?: string }[];
    try {
      // An unthreaded draft (a DM or a top-level post) has no thread to read: its
      // channel's history since the draft was made is the only place it can show up.
      msgs = d.thread_ts ? await deps.replies(d.channel, d.thread_ts) : await deps.history!(d.channel, isNaN(created) ? '0' : String(Math.floor(created / 1000) - 60));
    } catch {
      continue; // read-only best effort: try again next tick
    }
    const mine = msgs.filter((m) => m.user === deps.me && (isNaN(created) || Number(m.ts) * 1000 >= created - 60_000));
    if (d.thread_ts && mine.some((m) => m.ts !== d.thread_ts && !draftSentIn(candidates, [m.text ?? '']))) posted.push(d.id);
    if (!draftSentIn(candidates, mine.map((m) => m.text ?? ''))) continue;
    const hit = mine.find((m) => draftSentIn(candidates, [m.text ?? '']));
    const permalink = hit && d.thread_url && d.thread_ts ? `${d.thread_url.split('?')[0].replace(/\/p\d+$/, '')}/p${hit.ts.replace('.', '')}?thread_ts=${d.thread_ts}&cid=${d.channel}` : '';
    try {
      await deps.mark(d.id, permalink);
      done.push(d.id);
    } catch {
      /* the next tick retries */
    }
  }
  deps.willPosted?.(posted);
  return done;
}

/** The live reconcile: read-only Web API calls, marks made here. `api` carries a fetch stub in tests. */
export async function reconcileLive(o: StoreOpts = {}, only?: string[], api: CallOpts = {}): Promise<string[]> {
  const pend = Object.values(readOutbox(o)).some((d) => d.status === 'pending' && /^[A-Z0-9]+$/.test(d.channel) && (!only || only.includes(d.id)));
  if (!pend) return [];
  const me = (await authTest(api)).identity.user_id;
  if (!me) return [];
  const s = store(o);
  return reconcileDrafts({
    me,
    file: s.file,
    legacy: s.legacy,
    only,
    willPosted: (ids) => {
      if (only) return; // a partial pass must not rewrite everyone's marks
      const marks: Record<string, number> = {};
      const prev = readStaleMarks();
      for (const id of ids) marks[id] = prev[id] ?? Date.now();
      if (JSON.stringify(Object.keys(marks).sort()) !== JSON.stringify(Object.keys(prev).sort())) writeStaleMarks(marks);
    },
    history: (channel, oldest) => conversationsHistory(channel, { oldest, limit: 100 }, api),
    replies: (channel, ts) => conversationsReplies(channel, ts, { limit: 200 }, api),
    mark: async (id, permalink) => {
      const r = closeDraft(id, 'sent', { by: 'chat', permalink }, s);
      if (!r.ok && !r.detail.startsWith('already')) throw new Error(r.detail);
    },
  });
}

/* ------------------------------------------------------------- card thumbnails */

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/**
 * The bytes of one image attached to a pending draft, for the card's thumbnail.
 * Only a file recorded on that draft (message `m`, file `f`) is ever read: the
 * request names an index, never a path. Non-images are not served.
 */
export function draftImage(id: string, m: number, f: number, o?: StoreOpts | string): { type: string; bytes: Buffer } | null {
  const file = readOutbox(o)[id]?.files?.[m]?.[f];
  const type = file ? IMAGE_TYPES[path.extname(file).toLowerCase()] : undefined;
  if (!file || !type) return null;
  try {
    return { type, bytes: fs.readFileSync(file) };
  } catch {
    return null;
  }
}
