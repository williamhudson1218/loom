import { randomUUID } from 'node:crypto';
import { lastUsedProject, touchProject } from './projects.ts';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { parseSlackThread, type ThreadRef } from './slackref.ts';
import type { Agent } from './types.ts';

// Slack thread ownership, kept in Loom's own DB (design §5). One row per thread
// parent. Written when Loom starts a chat for a thread, when the indexer sees a
// chat's opening prompt mention a thread, and from the plugin's claim events
// (src/events.ts). An older install's hook state file is mirrored in as
// source 'legacy' rows (syncLegacyThreads) and still read as a fallback
// (slackgoto.findOwner).

export type OwnerSource = 'start' | 'index' | 'pending' | 'send' | 'claim' | 'legacy';

export interface OwnerRow {
  thread_key: string;
  url: string;
  agent: Agent;
  session_id: string; // '' while a started chat's session id is not known yet
  project_dir: string;
  pane_id: string;
  source: OwnerSource;
  created_at: number;
}

export interface ClaimInput {
  agent: Agent;
  sessionId: string;
  projectDir?: string;
  paneId?: string;
  source: OwnerSource;
  now?: number;
}

/**
 * Claim a thread for a chat. The first claim wins; a later chat that only pastes
 * the link does not take it over. One exception: a 'pending' row (started, but
 * the session id unknown) is completed by the first chat that reports one.
 * Returns true when the table changed.
 */
export function claimThread(db: Database.Database, ref: ThreadRef, c: ClaimInput): boolean {
  const now = c.now ?? Date.now();
  const existing = getOwner(db, ref.key);
  if (existing) {
    if (existing.source === 'pending' && !existing.session_id && c.sessionId && existing.agent === c.agent) {
      db.prepare(`UPDATE slack_threads SET session_id = ?, source = 'start', project_dir = CASE WHEN project_dir = '' THEN ? ELSE project_dir END WHERE thread_key = ?`)
        .run(c.sessionId, c.projectDir ?? '', ref.key);
      return true;
    }
    return false;
  }
  db.prepare(
    `INSERT OR IGNORE INTO slack_threads (thread_key, url, agent, session_id, project_dir, pane_id, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(ref.key, ref.url, c.agent, c.sessionId, c.projectDir ?? '', c.paneId ?? '', c.source, now);
  return true;
}

/** Hand a thread to a different chat (Change project restarts the chat). */
export function reassignThread(db: Database.Database, ref: ThreadRef, c: ClaimInput): void {
  db.prepare(`DELETE FROM slack_threads WHERE thread_key = ?`).run(ref.key);
  claimThread(db, ref, c);
}

export function getOwner(db: Database.Database, key: string): OwnerRow | null {
  return (db.prepare(`SELECT * FROM slack_threads WHERE thread_key = ?`).get(key) as OwnerRow | undefined) ?? null;
}

/** Session ids owning at least one thread: the board's Slack glyph. */
export function ownerSessions(db: Database.Database): string[] {
  return (db.prepare(`SELECT DISTINCT session_id FROM slack_threads WHERE session_id != ''`).all() as { session_id: string }[]).map((r) => r.session_id);
}

/** The indexer's hook: a chat whose first prompt links a thread owns it (unless something already does). */
export function claimFromFirstMessage(
  db: Database.Database,
  chat: { agent: Agent; session_id: string; project_dir: string; first_message: string },
  now?: number,
): ThreadRef | null {
  if (!chat.first_message.includes('.slack.com/archives/')) return null;
  const ref = parseSlackThread(chat.first_message);
  if (!ref) return null;
  claimThread(db, ref, { agent: chat.agent, sessionId: chat.session_id, projectDir: chat.project_dir, source: 'index', now });
  return ref;
}

/* ------------------------------------------------------ claims and stages */

// What the plugin's `loom thread` records beside ownership: the ticket stage
// (looking / blocked / done), whether its reaction is shown, and the in-thread
// ack. One row per thread parent, independent of who owns it.
export const THREAD_STATE_SQL = `
CREATE TABLE IF NOT EXISTS slack_thread_state (
  thread_key  TEXT PRIMARY KEY,
  stage       TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  react       INTEGER,
  stage_at    INTEGER NOT NULL DEFAULT 0,
  ack_text    TEXT NOT NULL DEFAULT '',
  ack_at      INTEGER NOT NULL DEFAULT 0,
  legacy_sig  TEXT NOT NULL DEFAULT ''
);
`;

const ensured = new WeakSet<Database.Database>();
export function ensureThreadState(db: Database.Database): void {
  if (ensured.has(db)) return;
  db.exec(THREAD_STATE_SQL);
  ensured.add(db);
}

export type ClaimMode = 'if_unowned' | 'takeover' | 'force';

/**
 * A chat claims a thread (the plugin's thread.claim event).
 *   if_unowned  only when nothing owns it (a 'pending' row is completed)
 *   takeover    the chat's first prompt pasted it: it moves here
 *   force       `loom thread claim`: it moves here
 * Returns whether ownership changed and who held it before.
 */
export function claimForChat(
  db: Database.Database,
  ref: ThreadRef,
  c: { sessionId: string; cwd?: string; mode: ClaimMode; started?: boolean; now?: number },
): { changed: boolean; prev: string } {
  if (!c.sessionId || (ref.channel.startsWith('D') && c.started)) return { changed: false, prev: '' };
  const existing = getOwner(db, ref.key);
  const prev = existing?.session_id ?? '';
  const input: ClaimInput = { agent: 'claude', sessionId: c.sessionId, projectDir: c.cwd ?? '', source: c.started ? 'send' : 'claim', now: c.now };
  if (c.mode === 'if_unowned' || !existing || !existing.session_id) return { changed: claimThread(db, ref, input), prev };
  if (existing.session_id === c.sessionId) return { changed: false, prev };
  reassignThread(db, ref, input);
  return { changed: true, prev };
}

/** `loom thread release`: nothing owns it any more. The stage row stays (it records what was done). */
export function releaseThread(db: Database.Database, key: string): boolean {
  return db.prepare(`DELETE FROM slack_threads WHERE thread_key = ?`).run(key).changes > 0;
}

export interface ThreadStateRow {
  thread_key: string;
  stage: string;
  note: string;
  react: number | null;
  stage_at: number;
  ack_text: string;
  ack_at: number;
  legacy_sig: string;
}

export function threadState(db: Database.Database, key: string): ThreadStateRow | null {
  ensureThreadState(db);
  return (db.prepare(`SELECT * FROM slack_thread_state WHERE thread_key = ?`).get(key) as ThreadStateRow | undefined) ?? null;
}

const upsertState = (db: Database.Database, key: string) => {
  ensureThreadState(db);
  db.prepare(`INSERT OR IGNORE INTO slack_thread_state (thread_key) VALUES (?)`).run(key);
};

/** Record a stage. `react` is remembered from `looking` only: that is what `done` later follows. */
export function setThreadStage(db: Database.Database, key: string, s: { stage: string; note?: string | null; react?: boolean; now?: number }): void {
  upsertState(db, key);
  db.prepare(`UPDATE slack_thread_state SET stage = ?, note = ?, stage_at = ? WHERE thread_key = ?`).run(s.stage, s.note ?? '', s.now ?? Date.now(), key);
  if (s.stage === 'looking' && typeof s.react === 'boolean') db.prepare(`UPDATE slack_thread_state SET react = ? WHERE thread_key = ?`).run(s.react ? 1 : 0, key);
}

/** The one ack a thread gets. A second is ignored. */
export function recordAck(db: Database.Database, key: string, text: string, now: number = Date.now()): boolean {
  upsertState(db, key);
  return db.prepare(`UPDATE slack_thread_state SET ack_text = ?, ack_at = ? WHERE thread_key = ? AND ack_text = ''`).run(text, now, key).changes > 0;
}

/** The last acks posted anywhere, oldest first, so the CLI does not repeat itself. */
export function recentAcks(db: Database.Database, n = 12): string[] {
  ensureThreadState(db);
  return (db.prepare(`SELECT ack_text FROM slack_thread_state WHERE ack_text != '' ORDER BY ack_at DESC LIMIT ?`).all(n) as { ack_text: string }[]).map((r) => r.ack_text).reverse();
}

/** The shape of one record in an older install's hook state file. */
export interface LegacyThreadRec {
  url?: string;
  session_id?: string;
  cwd?: string;
  claimed_at?: string;
  started?: boolean;
  stage?: string;
  react?: boolean;
  ack?: { text?: string; at?: string } | string;
}

/**
 * Mirror the old hook's state file into the table, idempotently. A key is
 * applied only when its record changed since it was last applied (legacy_sig),
 * so a thread Loom released, or reassigned with its own claim, is not dragged
 * back by an unchanged file. Rows that Loom itself wrote are never overwritten;
 * 'legacy' rows follow the file (its own takeovers still land while that hook
 * is the writer). Returns the number of keys applied.
 */
export function syncLegacyThreads(db: Database.Database, threads: Record<string, LegacyThreadRec>, now: number = Date.now()): number {
  ensureThreadState(db);
  let n = 0;
  const tx = db.transaction(() => {
    for (const [key, rec] of Object.entries(threads)) {
      if (!rec || typeof rec !== 'object' || !/^[A-Z0-9]+\/\d{10}\.\d{6}$/.test(key)) continue;
      const ackText = typeof rec.ack === 'string' ? rec.ack : rec.ack?.text ?? '';
      const sig = JSON.stringify([rec.session_id ?? '', rec.url ?? '', rec.cwd ?? '', rec.claimed_at ?? '', rec.stage ?? '', rec.react ?? null, ackText]);
      const st = threadState(db, key);
      if (st?.legacy_sig === sig) continue;
      const [channel, ts] = key.split('/');
      const url = rec.url || `https://app.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
      const at = Date.parse(rec.claimed_at ?? '') || now;
      if (rec.session_id) {
        const row = getOwner(db, key);
        if (!row) {
          db.prepare(
            `INSERT INTO slack_threads (thread_key, url, agent, session_id, project_dir, pane_id, source, created_at) VALUES (?, ?, 'claude', ?, ?, '', 'legacy', ?)`,
          ).run(key, url, rec.session_id, rec.cwd ?? '', at);
        } else if (row.source === 'legacy' && (row.session_id !== rec.session_id || row.project_dir !== (rec.cwd ?? ''))) {
          db.prepare(`UPDATE slack_threads SET session_id = ?, url = ?, project_dir = ?, created_at = ? WHERE thread_key = ?`).run(rec.session_id, url, rec.cwd ?? '', at, key);
        }
      }
      upsertState(db, key);
      const cur = threadState(db, key)!;
      // A stage Loom recorded itself is newer than anything the old file says.
      if (rec.stage && !cur.stage_at) db.prepare(`UPDATE slack_thread_state SET stage = ? WHERE thread_key = ?`).run(rec.stage, key);
      if (typeof rec.react === 'boolean' && cur.react === null) db.prepare(`UPDATE slack_thread_state SET react = ? WHERE thread_key = ?`).run(rec.react ? 1 : 0, key);
      if (ackText && !cur.ack_text) db.prepare(`UPDATE slack_thread_state SET ack_text = ?, ack_at = ? WHERE thread_key = ?`).run(ackText, Date.parse(typeof rec.ack === 'object' ? rec.ack?.at ?? '' : '') || at, key);
      db.prepare(`UPDATE slack_thread_state SET legacy_sig = ? WHERE thread_key = ?`).run(sig, key);
      n++;
    }
    // The old hook released a thread it had given us: let it go too. (An empty
    // or unreadable file releases nothing.)
    if (Object.keys(threads).length) {
      const gone = (db.prepare(`SELECT thread_key FROM slack_threads WHERE source = 'legacy'`).all() as { thread_key: string }[]).filter((r) => !threads[r.thread_key]?.session_id);
      for (const r of gone) {
        db.prepare(`DELETE FROM slack_threads WHERE thread_key = ? AND source = 'legacy'`).run(r.thread_key);
        n++;
      }
    }
  });
  tx();
  return n;
}

/* ------------------------------------------------------------ settings */

const CHANNEL_MAP_KEY = 'slack_channel_projects';
const LAST_PROJECT_KEY = 'last_project_dir';

function getSetting(db: Database.Database, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
}
function putSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

/** channel id -> project dir. */
export function getChannelProjects(db: Database.Database): Record<string, string> {
  try {
    const v = JSON.parse(getSetting(db, CHANNEL_MAP_KEY) || '{}');
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    return Object.fromEntries(Object.entries(v).filter(([k, d]) => /^[A-Z0-9]+$/.test(k) && typeof d === 'string' && d)) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Map a channel to a project dir; an empty dir removes the mapping. */
export function setChannelProject(db: Database.Database, channel: string, dir: string | null): Record<string, string> {
  const map = getChannelProjects(db);
  if (dir) map[channel] = dir;
  else delete map[channel];
  putSetting(db, CHANNEL_MAP_KEY, JSON.stringify(map));
  return map;
}

export function getLastProject(db: Database.Database): string | null {
  const used = lastUsedProject(db);
  if (used) return used;
  return getSetting(db, LAST_PROJECT_KEY)?.trim() || null;
}

/** Remember where the user last started a chat. Never throws: bookkeeping must not fail a launch. */
export function setLastProject(db: Database.Database, dir: string): void {
  try {
    if (dir) {
      putSetting(db, LAST_PROJECT_KEY, dir);
      touchProject(db, dir);
    }
  } catch {
    /* ignore */
  }
}

/** The project of the most recently active chat: the last-resort default. */
export function mostRecentProject(db: Database.Database): string | null {
  const r = db.prepare(`SELECT project_dir FROM chats WHERE project_dir != '' ORDER BY last_active_at DESC LIMIT 1`).get() as { project_dir: string } | undefined;
  return r?.project_dir || null;
}

/* ------------------------------------------------------------ auto-start */

export type ProjectSource = 'channel' | 'last' | 'recent';

/**
 * Where a chat for an unowned thread starts: the channel's mapped project, else
 * the project the user last started a chat in, else that of the newest chat on
 * the board. A candidate that is not a usable directory is skipped, so a stale
 * mapping falls through instead of failing the start.
 */
export function resolveStartProject(
  channel: string,
  src: { mapping: Record<string, string>; last: string | null; recent: string | null; valid: (dir: string) => boolean },
): { dir: string; source: ProjectSource } | null {
  const tries: [string | null | undefined, ProjectSource][] = [[src.mapping[channel], 'channel'], [src.last, 'last'], [src.recent, 'recent']];
  for (const [dir, source] of tries) if (dir && src.valid(dir)) return { dir, source };
  return null;
}

/** Where autoStartThread would start this thread's chat, without starting anything. */
export function startProjectFor(db: Database.Database, channel: string, valid: (dir: string) => boolean): { dir: string; source: ProjectSource } | null {
  return resolveStartProject(channel, { mapping: getChannelProjects(db), last: getLastProject(db), recent: mostRecentProject(db), valid });
}

/**
 * The first prompt: the permalink, then the message text when Loom could read it,
 * then any context the user typed in the new-thread prompt.
 */
export function buildStartPrompt(ref: ThreadRef, message?: { text?: string; author?: string }, context?: string): string {
  const text = (message?.text ?? '').trim().slice(0, 4000);
  const extra = (context ?? '').trim().slice(0, 4000);
  const lines = [`This chat was started from a Slack thread: ${ref.url}`];
  if (text) {
    lines.push('', `The message${message?.author ? ` from ${message.author}` : ''}:`, ...text.split('\n').map((l) => '> ' + l));
  }
  if (extra) lines.push('', 'Context from the user:', extra);
  lines.push('', 'Read the whole thread if you can, work out what it asks for, and start on it.');
  return lines.join('\n');
}

export interface PickedText {
  text?: string;
  author?: string;
}

type LaunchOut = { ok: true; paneId: string; where: string } | { ok: false; detail: string };

export interface AutoStartDeps {
  db: () => Database.Database;
  validDir: (dir: string) => boolean;
  agent: () => Agent;
  /** Open the chat in a pane. A stub in tests: nothing here may start a real process. */
  launch: (a: { projectDir: string; prompt: string; agent: Agent; sessionId: string; pane?: string }) =>
    LaunchOut | Promise<LaunchOut>;
  newSessionId?: () => string;
  now?: () => number;
}

export interface StartedThread {
  ok: true;
  action: 'started';
  key: string;
  url: string;
  channel: string;
  agent: Agent;
  session_id: string; // '' for an agent that cannot be given a session id up front
  pane_id: string;
  where: string;
  project_dir: string;
  project: string;
  project_source: ProjectSource;
  quote: string;
  author: string;
  at: number;
}
export type AutoStartResult = StartedThread | { ok: false; reason: 'no_project' | 'failed'; detail: string; key: string };

/**
 * No chat owns this thread: start one. Resolves the project, launches with the
 * thread as the first prompt, records ownership, and remembers the project.
 * Claude takes a session id on the command line, so ownership is complete at
 * once; an agent that cannot is recorded 'pending' and completed when the
 * indexer sees its first prompt.
 */
export async function autoStartThread(ref: ThreadRef, picked: PickedText, deps: AutoStartDeps, opts: { pane?: string; projectDir?: string; context?: string } = {}): Promise<AutoStartResult> {
  const db = deps.db();
  try {
    let project: { dir: string; source: ProjectSource } | null;
    if (opts.projectDir && deps.validDir(opts.projectDir)) project = { dir: opts.projectDir, source: 'channel' };
    else
      project = resolveStartProject(ref.channel, {
        mapping: getChannelProjects(db),
        last: getLastProject(db),
        recent: mostRecentProject(db),
        valid: deps.validDir,
      });
    if (!project) return { ok: false, reason: 'no_project', key: ref.key, detail: 'No chat owns this thread, and there is no project to start one in. Start a chat once, or map this channel to a project.' };
    const agent = deps.agent();
    const sessionId = agent === 'claude' ? (deps.newSessionId ?? randomUUID)() : '';
    const prompt = buildStartPrompt(ref, picked, opts.context);
    const r = await deps.launch({ projectDir: project.dir, prompt, agent, sessionId, pane: opts.pane });
    if (!r.ok) return { ok: false, reason: 'failed', key: ref.key, detail: r.detail };
    const now = (deps.now ?? Date.now)();
    const claim: ClaimInput = { agent, sessionId, projectDir: project.dir, paneId: r.paneId, source: sessionId ? 'start' : 'pending', now };
    if (opts.projectDir) reassignThread(db, ref, claim);
    else claimThread(db, ref, claim);
    setLastProject(db, project.dir);
    return {
      ok: true,
      action: 'started',
      key: ref.key,
      url: ref.url,
      channel: ref.channel,
      agent,
      session_id: sessionId,
      pane_id: r.paneId,
      where: r.where,
      project_dir: project.dir,
      project: path.basename(project.dir),
      project_source: project.source,
      quote: (picked.text ?? '').trim().slice(0, 4000),
      author: picked.author ?? '',
      at: now,
    };
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------ banner state */

// Starts the dashboard has not dismissed yet. In memory: the banner is a
// moment, ownership itself lives in the table.
const STARTS_TTL_MS = 6 * 3_600_000;
const starts: StartedThread[] = [];
const dismissed = new Set<string>();

export function noteStart(s: StartedThread): void {
  starts.unshift(s);
  starts.length = Math.min(starts.length, 20);
}

export function recentStarts(now: number = Date.now()): StartedThread[] {
  return starts.filter((s) => now - s.at < STARTS_TTL_MS && !dismissed.has(s.key + '@' + s.at));
}

export function dismissStart(key: string, at: number): void {
  dismissed.add(key + '@' + at);
}

export function replaceStart(oldKey: string, oldAt: number, next: StartedThread): void {
  dismissStart(oldKey, oldAt);
  noteStart(next);
}
