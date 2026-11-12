import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { channelLabels, readThreads, type ThreadRec } from './slack.ts';
import { parseSlackThread, type ThreadRef } from './slackref.ts';
import { autoStartThread, getOwner, noteStart, startProjectFor, type PickedText, type StartedThread } from './slackowner.ts';
import { openDb, getDefaultAgent } from './db.ts';
import { MANAGED_SESSION } from './managed.ts';
import { searchArchive, isValidProjectDir, type ArchiveResult } from './findchat.ts';
import { gotoPane, launchInPane, type GotoResult } from './goto.ts';
import { acquirePaneAutoAsync, noteLaunch } from './newthread.ts';
import { currentTerminal } from './terminal.ts';
import { locateTranscript } from './liveindex.ts';
import { parseLane } from './compact.ts';
import type { LiveLoc } from './dashboard.ts';

// "Open the chat for this Slack thread": the global hotkey (app/main.ts) opens
// a pick overlay, the clicked Slack message resolves to its thread parent
// (pickedThread), and that permalink is POSTed to /api/slack/thread-goto, which
// lands here. A pasted or curl'd link takes the same path. A
// Slack permalink resolves to the chat that owns the thread, and that chat is
// jumped to if it is running in a pane, or resumed into one if not. A thread no
// chat owns starts one (slackowner.autoStartThread) with the thread as its first
// prompt; before 2026-11-05 that was only a notification.
//
// The hotkey asks before it starts one (slack_goto_confirm_new): it posts with
// mode 'ask' first, which jumps to an owner exactly as before but answers
// action 'ask' for an unowned thread and starts nothing; the user's answer comes
// back as a second post with mode 'start' and the optional `context`, which goes
// into the opening prompt. No mode is the old one-shot behaviour (curl, paste).

/* ------------------------------------------------------------ the link */

export { parseSlackThread, type ThreadRef } from './slackref.ts';

/** What the pick overlay's AX helper reports for the clicked message. */
export interface PickedMessage {
  url: string; // the message's own permalink (a reply's carries ?thread_ts= when Slack adds it)
  inThread: boolean; // clicked inside the open thread pane
  rootUrl?: string | null; // that pane's root permalink, when the helper found it
  text?: string; // the message body, when the helper could read it
  author?: string;
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
  session_id: string; // '' for a chat Loom started whose session id is not known yet
  cwd: string; // where the chat was started; '' when unknown
  source: 'table' | 'state' | 'search';
  pane_id?: string; // the pane a still-starting chat was opened in
  at?: number; // when Loom's table recorded it (ms)
}

export interface LookupDeps {
  // Loom's own slack_threads table: checked first.
  owned?: (key: string) => { session_id: string; cwd: string; pane_id: string; at?: number } | null;
  threads: () => Record<string, ThreadRec>;
  search: (q: string) => Promise<ArchiveResult>;
  // Does this transcript really mention the link? Guards the full-text match.
  mentions: (jsonlPath: string, needles: string[]) => boolean;
}

/**
 * Who owns a thread. Loom's own table first, then the slack-threads hook's state
 * file; a thread neither knows falls back to the transcripts that mention the
 * parent's permalink, and the most recently active of those wins.
 */
export async function findOwner(ref: ThreadRef, deps: LookupDeps): Promise<Owner | null> {
  const mine = deps.owned?.(ref.key);
  if (mine && (mine.session_id || mine.pane_id)) return { session_id: mine.session_id, cwd: mine.cwd, source: 'table', pane_id: mine.pane_id || undefined, ...(mine.at ? { at: mine.at } : {}) };
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
  action?: 'jumped' | 'resumed' | 'started' | 'ask';
  /** action 'resumed': into a fresh Loom-managed window. */
  managed?: boolean;
  /** action 'ask': what the confirm prompt names. */
  ask?: { channel: string; channel_name: string; project: string; project_dir: string };
  reason?: 'not_slack' | 'no_owner' | 'elsewhere' | 'no_dir' | 'no_pane' | 'failed' | 'no_project';
  started?: StartedThread;
  key?: string;
  session_id?: string;
  /** The never-started session a lookup found and set aside. */
  stale?: string;
  source?: Owner['source'];
  pane_id?: string;
  timings?: GotoTimings;
}

type Acquired = { ok: true; paneId: string; managed?: boolean; readyMs?: number } | { ok: false; detail: string };

/** Where the time went, for pick.log: the find-chat lookup, getting a pane (and its shell), and the jump or launch. */
export interface GotoTimings {
  lookup_ms: number;
  acquire_ms?: number;
  ready_ms?: number;
  act_ms?: number;
  total_ms: number;
}

export interface GotoDeps extends LookupDeps {
  live: () => Record<string, LiveLoc>;
  projectDirOf: (sessionId: string) => string | null; // the board's record, when it has one
  elsewhere: (sessionId: string) => boolean;
  /**
   * Whether the owner's transcript exists. A chat Loom started is recorded as the
   * thread's owner at launch, before it has written a line; if it never came up,
   * the row names a session `claude --resume` cannot find, and every later open
   * resumed it into a pane that printed "No conversation found" and went back to the
   * shell. Absent, every owner is taken as resumable (as before).
   */
  transcriptExists?: (sessionId: string, cwd: string) => boolean;
  goto: (paneId: string, tmuxSession: string) => GotoResult;
  acquire: (projectDir: string, lane: string) => Acquired | Promise<Acquired>;
  resume: (paneId: string, projectDir: string, sessionId: string, focus: boolean) => GotoResult;
  // Nothing owns the thread: start a chat for it (see slackowner.autoStartThread).
  // Absent, an unowned thread is just reported, as before.
  start?: (ref: ThreadRef, picked: PickedText, opts: { pane?: string; projectDir?: string; context?: string; replace?: boolean }) => StartedOrFailed | Promise<StartedOrFailed>;
  /** Whether a resume into a fresh managed window should switch the terminal to it (see resumeFocus). */
  focusManaged?: () => boolean;
  // Where a start would go, and the channel's name, for the confirm prompt. Never starts anything.
  startTarget?: (ref: ThreadRef) => { channel_name: string; project_dir: string };
}

/** 'ask': report an unowned thread instead of starting. 'start': start (or jump, if an owner appeared). */
export type GotoMode = 'ask' | 'start';

export type StartedOrFailed = { ok: true; started: StartedThread } | { ok: false; reason: 'no_project' | 'failed'; detail: string };

/**
 * The lane a resumed chat should land in: the one already running the most
 * chats in the same project, so a chat in one project comes back among that project's
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

/** How long a chat Loom started may go without a transcript before it counts as never started. */
export const STARTING_GRACE_MS = 2 * 60_000;

export async function threadGoto(
  text: string,
  deps: GotoDeps,
  opts: { pane?: string; picked?: PickedText; mode?: GotoMode; context?: string } = {},
): Promise<ThreadGotoResult> {
  const t0 = Date.now();
  const t: GotoTimings = { lookup_ms: 0, total_ms: 0 };
  const done = (r: ThreadGotoResult): ThreadGotoResult => ({ ...r, timings: { ...t, total_ms: Date.now() - t0 } });
  const ref = parseSlackThread(text);
  if (!ref) return done({ ok: false, reason: 'not_slack', detail: 'Not a Slack message link' });
  let owner = await findOwner(ref, deps);
  t.lookup_ms = Date.now() - t0;
  const live = deps.live();
  // An owner that is not running and has no transcript never started: the thread is
  // unowned, and a new chat for it replaces the dead row.
  let stale = '';
  // A start younger than STARTING_GRACE_MS may simply not have written its first line yet.
  const starting = owner?.at !== undefined && Date.now() - owner.at < STARTING_GRACE_MS;
  if (owner?.session_id && !starting && !live[`claude:${owner.session_id}`]?.running && deps.transcriptExists && !deps.transcriptExists(owner.session_id, owner.cwd)) {
    stale = owner.session_id;
    owner = null;
  }
  if (!owner) {
    if (!deps.start) return done({ ok: false, reason: 'no_owner', key: ref.key, detail: 'No chat owns this thread' });
    if (opts.mode === 'ask') {
      const st = deps.startTarget?.(ref) ?? { channel_name: '', project_dir: '' };
      const ask = { channel: ref.channel, channel_name: st.channel_name, project: st.project_dir ? path.basename(st.project_dir) : '', project_dir: st.project_dir };
      return done({ ok: true, detail: stale ? 'The chat started for this thread never began' : 'No chat owns this thread', action: 'ask', key: ref.key, ask, ...(stale ? { stale } : {}) });
    }
    const ta = Date.now();
    const s = await deps.start(ref, opts.picked ?? {}, { pane: opts.pane, context: opts.context, ...(stale ? { replace: true } : {}) });
    t.act_ms = Date.now() - ta;
    if (!s.ok) return done({ ok: false, reason: s.reason, key: ref.key, detail: s.detail });
    const st = s.started;
    return done({ ok: true, detail: `started a chat in ${st.where}`, action: 'started', key: ref.key, session_id: st.session_id, pane_id: st.pane_id, started: st });
  }
  const base = { key: ref.key, session_id: owner.session_id, source: owner.source };

  if (!owner.session_id) {
    // Started by Loom a moment ago and not yet tied to a session: its pane is the chat.
    const there = Object.values(live).find((l) => l.pane_id === owner.pane_id);
    if (!there) return done({ ok: false, ...base, reason: 'failed', detail: 'The chat for this thread is still starting' });
    const ta = Date.now();
    const r = deps.goto(there.pane_id, there.tmux_session);
    t.act_ms = Date.now() - ta;
    return done({ ...r, ...base, action: 'jumped', pane_id: there.pane_id, ...(r.ok ? {} : { reason: 'failed' }) });
  }
  const here = live[`claude:${owner.session_id}`];
  if (here?.running && here.pane_id) {
    const ta = Date.now();
    const r = deps.goto(here.pane_id, here.tmux_session);
    t.act_ms = Date.now() - ta;
    return done({ ...r, ...base, action: 'jumped', pane_id: here.pane_id, ...(r.ok ? {} : { reason: 'failed' }) });
  }
  if (deps.elsewhere(owner.session_id)) {
    return done({ ok: false, ...base, reason: 'elsewhere', detail: 'The chat for this thread is open in Superset, not tmux' });
  }

  const dir = deps.projectDirOf(owner.session_id) || owner.cwd;
  if (!dir || !isValidProjectDir(dir)) return done({ ok: false, ...base, reason: 'no_dir', detail: `No project directory for chat ${owner.session_id.slice(0, 8)}` });
  let paneId = opts.pane ?? '';
  let managed = false;
  if (!paneId) {
    const ta = Date.now();
    const p = await deps.acquire(dir, preferredLane(dir, live));
    t.acquire_ms = Date.now() - ta;
    if (!p.ok) return done({ ok: false, ...base, reason: 'no_pane', detail: p.detail });
    paneId = p.paneId;
    managed = !!p.managed;
    if (p.readyMs !== undefined) t.ready_ms = p.readyMs;
  }
  const ta = Date.now();
  const r = deps.resume(paneId, dir, owner.session_id, resumeFocus(managed, deps.focusManaged?.() ?? false));
  t.act_ms = Date.now() - ta;
  return done({ ...r, ...base, action: 'resumed', pane_id: paneId, managed, ...(r.ok ? {} : { reason: 'failed' }) });
}

/**
 * Whether a resume switches the terminal to its pane. A lane pane: yes. A fresh
 * managed window: only for an external terminal (Ghostty and co.), the same rule
 * as the dashboard's Resume; Loom's own terminal shows it in the app instead
 * (app/main.ts opens it there). Before, every managed resume was left unfocused,
 * so with an external terminal the resumed chat appeared nowhere.
 */
export function resumeFocus(managed: boolean, externalTerminal: boolean): boolean {
  return !managed || externalTerminal;
}

/** Loom's own ownership table, as findOwner's first source. A missing or locked DB reads as "no row". */
function ownedFromDb(key: string): { session_id: string; cwd: string; pane_id: string; at: number } | null {
  try {
    const db = openDb();
    try {
      const r = getOwner(db, key);
      return r ? { session_id: r.session_id, cwd: r.project_dir, pane_id: r.pane_id, at: r.created_at } : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/**
 * The real wiring, minus the two things only the server knows: the live map and
 * the board. An unowned thread starts a chat, where acquire would put a resume
 * (the same lane choice on the owner's workspace, a managed window otherwise).
 */
export function defaultGotoDeps(live: () => Record<string, LiveLoc>, projectDirOf: (sid: string) => string | null): GotoDeps {
  return {
    owned: ownedFromDb,
    threads: () => readThreads(),
    search: (q) => searchArchive(q),
    mentions: transcriptMentions,
    live,
    projectDirOf,
    elsewhere: (sid) => supersetLive(sid),
    transcriptExists: (sid, cwd) => !!locateTranscript(sid, cwd),
    goto: gotoPane,
    acquire: (dir, lane) => acquirePaneAutoAsync(dir, lane, lane),
    focusManaged: () => currentTerminal() !== 'inside',
    resume: (paneId, dir, sid, focus) => launchInPane({ paneId, projectDir: dir, sessionId: sid, sourceAgent: 'claude', selectedAgent: 'claude', focus }),
    start: async (ref, picked, o) => {
      const r = await autoStartThread(
        ref,
        picked,
        {
          db: () => openDb(),
          validDir: isValidProjectDir,
          agent: () => {
            const db = openDb();
            try {
              return getDefaultAgent(db) === 'codex' ? 'codex' : 'claude';
            } finally {
              db.close();
            }
          },
          launch: async ({ projectDir, prompt, agent, sessionId, pane }) => {
            let paneId = pane ?? '';
            let managed = false;
            if (!paneId) {
              const p = await acquirePaneAutoAsync(projectDir, preferredLane(projectDir, live()), '');
              if (!p.ok) return p;
              paneId = p.paneId;
              managed = p.managed;
            }
            const l = launchInPane({ paneId, projectDir, sessionId, sourceAgent: agent, selectedAgent: agent, fresh: true, prompt, focus: resumeFocus(managed, currentTerminal() !== 'inside') });
            if (!l.ok) return { ok: false, detail: l.detail };
            noteLaunch({ pane_id: paneId, where: paneId, project: path.basename(projectDir), projectDir, agent, prompt: prompt.slice(0, 200) });
            return { ok: true, paneId, where: managed ? 'a new window in ' + MANAGED_SESSION : l.detail.replace(/^started; ?/, '') || paneId };
          },
        },
        { pane: o.pane, projectDir: o.projectDir, context: o.context, replace: o.replace },
      );
      if (!r.ok) return r;
      noteStart(r);
      return { ok: true, started: r };
    },
    startTarget: (ref) => {
      let project_dir = '';
      try {
        const db = openDb();
        try {
          project_dir = startProjectFor(db, ref.channel, isValidProjectDir)?.dir ?? '';
        } finally {
          db.close();
        }
      } catch {
        /* no project known: the prompt just leaves it out */
      }
      let channel_name = '';
      try {
        channel_name = String(channelLabels()[ref.channel] ?? '').replace(/^[#@]/, '');
      } catch {
        /* no label cache */
      }
      return { channel_name, project_dir };
    },
  };
}
