import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { readThreads, type ThreadRec } from './slack.ts';
import { searchArchive, isValidProjectDir, type ArchiveResult } from './findchat.ts';
import { gotoPane, launchInPane, type GotoResult } from './goto.ts';
import { acquirePane } from './newthread.ts';
import { parseLane } from './compact.ts';
import type { LiveLoc } from './dashboard.ts';

// "Open the chat for this Slack thread": the global hotkey (app/main.ts) opens
// a pick overlay, the clicked Slack message resolves to its thread parent
// (pickedThread), and that permalink is POSTed to /api/slack/thread-goto, which
// lands here. A pasted or curl'd link takes the same path. A
// Slack permalink resolves to the chat that owns the thread, and that chat is
// jumped to if it is running in a pane, or resumed into one if not. Nothing is
// ever created for a thread no chat has touched.

/* ------------------------------------------------------------ the link */

// Mirrors URL_RE and thread_keys() in ~/.claude/hooks/slack-threads.py exactly,
// because the hook's keys are what the state file is keyed by: a link that
// normalises differently here would never find its owner.
const URL_RE = /https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(\?[^\s>)\]|]*)?/;

export interface ThreadRef {
  key: string; // `<channel>/<root ts>`, the state file's key
  url: string; // the root's own permalink
  channel: string;
  ts: string; // the thread root
  linkTs: string; // the message the link pointed at: a reply's own ts, or the root
}

/**
 * The thread a Slack permalink belongs to, or null if the text holds none. A
 * reply link carries its root in `?thread_ts=`, and the thread is that root,
 * not the reply. Only the first link in the text counts.
 */
export function parseSlackThread(text: string): ThreadRef | null {
  const m = URL_RE.exec(text || '');
  if (!m) return null;
  const [whole, channel, sec, frac, query] = m;
  const linkTs = `${sec}.${frac}`;
  let ts = linkTs;
  if (query) {
    // parse_qs drops blank values and takes the first; URLSearchParams.get is the
    // same first value, and the shape check rejects the blank.
    const root = new URLSearchParams(query.slice(1)).get('thread_ts');
    if (root && /^\d{10}\.\d{6}$/.test(root)) ts = root;
  }
  const base = whole.split('/archives/')[0];
  return { key: `${channel}/${ts}`, url: `${base}/archives/${channel}/p${ts.replace('.', '')}`, channel, ts, linkTs };
}

/** What the pick overlay's AX helper reports for the clicked message. */
export interface PickedMessage {
  url: string; // the message's own permalink (a reply's carries ?thread_ts= when Slack adds it)
  inThread: boolean; // clicked inside the open thread pane
  rootUrl?: string | null; // that pane's root permalink, when the helper found it
}

/**
 * The thread parent of a picked message, as its permalink. thread_ts wins; a
 * thread-pane reply without one belongs to the pane's root; anything else (a
 * channel message, or the root itself) is its own parent.
 */
export function pickedThread(m: PickedMessage): ThreadRef | null {
  const ref = parseSlackThread(m.url);
  if (!ref) return null;
  if (ref.ts !== ref.linkTs || !m.inThread || !m.rootUrl) return ref;
  return parseSlackThread(m.rootUrl) ?? ref;
}

/* ------------------------------------------------------------ the owner */

export interface Owner {
  session_id: string;
  cwd: string; // where the chat was started; '' when unknown
  source: 'state' | 'search';
}

export interface LookupDeps {
  threads: () => Record<string, ThreadRec>;
  search: (q: string) => Promise<ArchiveResult>;
  // Does this transcript really mention the link? Guards the full-text match.
  mentions: (jsonlPath: string, needles: string[]) => boolean;
}

/**
 * Who owns a thread. The slack-threads state is the authority; a thread it does
 * not know falls back to the transcripts that mention the parent's permalink,
 * and the most recently active of those wins.
 */
export async function findOwner(ref: ThreadRef, deps: LookupDeps): Promise<Owner | null> {
  const rec = deps.threads()[ref.key];
  if (rec?.session_id) return { session_id: rec.session_id, cwd: rec.cwd ?? '', source: 'state' };
  // Parent only: a reply's own ts is not the thread, and a chat that only ever
  // saw a reply link to it is found by the hook's key, not by this search.
  const tok = 'p' + ref.ts.replace('.', '');
  const r = await deps.search(tok);
  const hits = r.ok ? r.results.filter((h) => deps.mentions(h.jsonl_path, [`${ref.channel}/${tok}`])) : [];
  const best = hits.sort((a, b) => b.ended_at - a.ended_at)[0];
  return best ? { session_id: best.session_id, cwd: best.project_dir, source: 'search' } : null;
}

export function transcriptMentions(jsonlPath: string, needles: string[]): boolean {
  try {
    const text = fs.readFileSync(jsonlPath, 'utf-8');
    return needles.some((n) => text.includes(n));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ superset */

// A chat can also be running in a Superset terminal, which is not a tmux pane
// Loom can see or jump to. Resuming it anyway would put a second process on the
// same transcript, so it is refused. Same query as live_terminal() in the hook.
export function supersetLive(sessionId: string, home: string = process.env.SUPERSET_HOME_DIR || path.join(os.homedir(), '.superset')): boolean {
  let file = '';
  try {
    const hostDir = path.join(home, 'host');
    const id = fs.readdirSync(hostDir).find((d) => fs.existsSync(path.join(hostDir, d, 'host.db')));
    if (!id) return false;
    file = path.join(hostDir, id, 'host.db');
  } catch {
    return false;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true, timeout: 2000 });
    const row = db.prepare(
      `SELECT 1 FROM terminal_agent_bindings b JOIN terminal_sessions t ON t.id = b.terminal_id
       WHERE b.agent_session_id = ? AND b.ended_at IS NULL AND t.status = 'active' LIMIT 1`,
    ).get(sessionId);
    return !!row;
  } catch {
    return false; // schema drift or a locked db: fall through to tmux, as before
  } finally {
    db?.close();
  }
}

/* ------------------------------------------------------------ the jump */

export interface ThreadGotoResult extends GotoResult {
  action?: 'jumped' | 'resumed';
  reason?: 'not_slack' | 'no_owner' | 'elsewhere' | 'no_dir' | 'no_pane' | 'failed';
  key?: string;
  session_id?: string;
  source?: Owner['source'];
  pane_id?: string;
}

export interface GotoDeps extends LookupDeps {
  live: () => Record<string, LiveLoc>;
  projectDirOf: (sessionId: string) => string | null; // the board's record, when it has one
  elsewhere: (sessionId: string) => boolean;
  goto: (paneId: string, tmuxSession: string) => GotoResult;
  acquire: (projectDir: string, lane: string) => { ok: true; paneId: string } | { ok: false; detail: string };
  resume: (paneId: string, projectDir: string, sessionId: string) => GotoResult;
}

/**
 * The lane a resumed chat should land in: the one already running the most
 * chats in the same project, so a tax-pilot chat comes back among tax-pilot
 * chats. It is a hard choice (an open pane there, else a split there) rather
 * than a preference, since a preference falls through to any lane with an open
 * pane first. '' lets chooseTarget take any lane with room.
 */
export function preferredLane(projectDir: string, live: Record<string, LiveLoc>): string {
  const counts = new Map<string, number>();
  for (const l of Object.values(live)) {
    const lane = parseLane(l.tmux_session)?.lane;
    const cwd = l.cwd ?? '';
    if (!lane || !cwd || !(cwd === projectDir || cwd.startsWith(projectDir + '/'))) continue;
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? '';
}

export async function threadGoto(text: string, deps: GotoDeps, opts: { pane?: string } = {}): Promise<ThreadGotoResult> {
  const ref = parseSlackThread(text);
  if (!ref) return { ok: false, reason: 'not_slack', detail: 'Not a Slack message link' };
  const owner = await findOwner(ref, deps);
  if (!owner) return { ok: false, reason: 'no_owner', key: ref.key, detail: 'No chat owns this thread' };
  const base = { key: ref.key, session_id: owner.session_id, source: owner.source };

  const live = deps.live();
  const here = live[`claude:${owner.session_id}`];
  if (here?.running && here.pane_id) {
    const r = deps.goto(here.pane_id, here.tmux_session);
    return { ...r, ...base, action: 'jumped', pane_id: here.pane_id, ...(r.ok ? {} : { reason: 'failed' }) };
  }
  if (deps.elsewhere(owner.session_id)) {
    return { ok: false, ...base, reason: 'elsewhere', detail: 'The chat for this thread is open in Superset, not tmux' };
  }

  const dir = deps.projectDirOf(owner.session_id) || owner.cwd;
  if (!dir || !isValidProjectDir(dir)) return { ok: false, ...base, reason: 'no_dir', detail: `No project directory for chat ${owner.session_id.slice(0, 8)}` };
  let paneId = opts.pane ?? '';
  if (!paneId) {
    const p = deps.acquire(dir, preferredLane(dir, live));
    if (!p.ok) return { ok: false, ...base, reason: 'no_pane', detail: p.detail };
    paneId = p.paneId;
  }
  const r = deps.resume(paneId, dir, owner.session_id);
  return { ...r, ...base, action: 'resumed', pane_id: paneId, ...(r.ok ? {} : { reason: 'failed' }) };
}

/** The real wiring, minus the two things only the server knows: the live map and the board. */
export function defaultGotoDeps(live: () => Record<string, LiveLoc>, projectDirOf: (sid: string) => string | null): GotoDeps {
  return {
    threads: () => readThreads(),
    search: (q) => searchArchive(q),
    mentions: transcriptMentions,
    live,
    projectDirOf,
    elsewhere: (sid) => supersetLive(sid),
    goto: gotoPane,
    acquire: (dir, lane) => acquirePane(dir, lane, lane),
    resume: (paneId, dir, sid) => launchInPane({ paneId, projectDir: dir, sessionId: sid, sourceAgent: 'claude', selectedAgent: 'claude' }),
  };
}
