import { execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { getDefaultAgent, openDb, setDefaultAgent } from './db.ts';
import { toChatViews, renderDashboard, type ChatView, type LiveLoc } from './dashboard.ts';
import { liveSessions, listTmuxPanes, attachedSessions } from './placements.ts';
import { gotoPane, launchInPane, closeSession, sendToPane } from './goto.ts';
import { readTranscript } from './transcript.ts';
import { writeLayout } from './snapshot.ts';
import { restore } from './restore.ts';
import { attachGhosttyTabs } from './ghostty.ts';
import { searchArchive, isValidProjectDir, isValidTranscriptPath } from './findchat.ts';
import { SESSION_PREFIX } from './paths.ts';
import { paneNameMap } from './panenames.ts';
import { movePane, ungroupPane, defaultGroupDeps, readWorld, laneTargets, nextOpenPane } from './compact.ts';
import { agentSessionKey } from './placements.ts';
import { isLaunchPreference, type Agent, type LaunchPreference } from './types.ts';
import { recentLedger, getEmMode, setEmMode, isEmMode } from './em/ledger.ts';
import { scanTick, triageTick } from './em/index.ts';
import { getTrees, filesFor, diffFor, removeWorktrees, panesFromLive, knownWorktree, type ScanInput } from './trees.ts';
import type { DiffMode } from './git.ts';
import { buildDetail, lastMessageTail } from './detail.ts';
import { openThread, threadOwners } from './slack.ts';
import { discardDraft, pendingDrafts, sendDraft } from './outbox.ts';

export const SERVER_PORT = 4317;

// Map a running pane's (cleaned) title back to a session, for the bootstrap path
// before the placement hook has recorded anything. Skip the generic default.
function titleToSession(views: ChatView[]): Map<string, string> {
  const m = new Map<string, string>();
  // Claude sets the pane title to its own auto-title, so that's the reliable key;
  // also index Loom's title as a fallback. Skip the ambiguous default.
  for (const v of views) {
    for (const t of [v.claude_auto_title, v.title]) {
      const key = `${v.agent}:${t}`;
      if (t && t !== 'Claude Code' && !m.has(key)) m.set(key, v.session_id);
    }
  }
  return m;
}

// A live chat is "working" if its transcript was written very recently (Claude is
// actively generating / running tools) vs. idle and waiting for the user.
//
// THIS IS A PROXY AND IT UNDER-REPORTS. See `paneIsMidTurn` below: the transcript
// is appended between tool calls, not during one, so a session inside a long
// operation goes quiet for minutes while being very much mid-turn.
const WORKING_MS = 10_000;

/**
 * Is this pane's agent mid-turn RIGHT NOW, according to the pane itself.
 *
 * The mtime proxy above fails in one specific and very common way, and it is
 * the way Will noticed: "the animation of the rows when a session is actively
 * working only works when you first spin up a new thread then it never animates
 * again."
 *
 * That is exactly what the proxy predicts. A session that is starting up writes
 * a burst of transcript entries a few seconds apart, so it stays inside the 10s
 * window and reads as working. Once it settles into real work — a build, a big
 * read, a long search — it writes NOTHING for the duration of the tool call,
 * the mtime ages past the threshold, and it reads as idle for the rest of its
 * life. Measured against two panes known to be mid-turn (%36, %44, both showing
 * the interrupt hint): the proxy said working=false for both, while a session
 * merely chattering said true.
 *
 * Claude Code renders "esc to interrupt" in its status line for precisely the
 * period we are trying to detect, so the pane is the primary source and the
 * mtime is the cheap corroborator. Cost measured across 33 panes: 24ms total,
 * which is nothing against the poll interval.
 *
 * Deliberately falls back to FALSE on any error. A tmux that cannot answer
 * should leave the row steady rather than pulse it on a guess — a lying
 * animation is worse than a missing one, because it is the thing he uses to
 * decide whether an agent needs poking.
 */
function paneIsMidTurn(paneId: string | undefined): boolean {
  if (!paneId) return false;
  try {
    const out = execFileSync('tmux', ['capture-pane', '-p', '-t', paneId, '-S', '-4'], {
      encoding: 'utf8',
      timeout: 1000,
    });
    /* THREE SIGNALS, because a pane can be working in two different ways.
     *
     * Will: "this page doesn't show that it's being worked on if the main agent
     * kicks it off to a sub-agent."
     *
     * Right, and the interrupt hint alone cannot catch it. While a subagent
     * runs, the PARENT is genuinely not mid-turn — it is blocked on the Task
     * tool, its prompt is free, and it writes nothing to its transcript. So it
     * fails the mtime proxy AND the interrupt test, while real work is going on
     * in its name.
     *
     * What the pane does show is an agent roster:
     *
     *     ✻ Waiting for 1 background agent to finish
     *       ⏺ main
     *       ◯ Explore  Confirming no CADE9C conversion migration exists   3m 46s
     *
     * Measured across 23 panes: 3 showed the interrupt hint, 2 showed a roster
     * line, and the two sets did not overlap — so this is additive, not a
     * widening. The 18 idle panes matched none of the three, which is the part
     * that matters: unlike the `✻` glyph, which persists as a finished-turn
     * summary, `◯` is present only while a subagent is live.
     *
     * Still fails closed. No match means not working, so a tmux hiccup cannot
     * invent activity. */
    return (
      /esc to interrupt/i.test(out) ||
      /^\s*◯ /m.test(out) ||
      /Waiting for \d+ background agent/i.test(out)
    );
  } catch {
    return false;
  }
}

function snapshot(): { defaultAgent: LaunchPreference; views: ChatView[]; live: Record<string, LiveLoc> } {
  const db = openDb();
  const views = toChatViews(db);
  const defaultAgent = getDefaultAgent(db);
  db.close();
  const now = Date.now();
  // The DB's last_active_at only refreshes on a summarizer pass (minutes of lag).
  // The transcript file's mtime is the true last-activity time — read it live so
  // "X ago" is accurate every poll, and reuse it for the working flag.
  const mtime = new Map<string, number>();
  for (const v of views) {
    try {
      const mt = fs.statSync(v.jsonl_path).mtimeMs;
      mtime.set(agentSessionKey(v.agent, v.session_id), mt);
      if (mt > v.last_active_at) v.last_active_at = mt;
    } catch {
      /* file gone */
    }
  }
  const liveMap = liveSessions({ titleToSession: titleToSession(views) });
  const names = liveMap.size ? paneNameMap() : new Map<string, string>();
  const live: Record<string, LiveLoc> = {};
  for (const [key, info] of liveMap) {
    const mt = mtime.get(key) ?? 0;
    const name = names.get(info.pane_id);
    /* The pane is the authority; mtime is the cheap corroborator. Either one
       saying yes is enough, because they fail in opposite directions: mtime
       misses a long tool call, and the pane hint misses the instant between a
       tool returning and the next one starting. */
    const working = paneIsMidTurn(info.pane_id) || now - mt < WORKING_MS;
    live[key] = { ...info, working, ...(name ? { name } : {}) };
  }
  if (process.env.LOOM_DEBUG) {
    const panes = listTmuxPanes();
    console.error(`[loom-debug] views=${views.length} panes=${panes.length} live=${Object.keys(live).length}`);
  }
  return { defaultAgent, views, live };
}

function send(res: http.ServerResponse, code: number, type: string, body: string) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

function json(res: http.ServerResponse, code: number, body: unknown) {
  send(res, code, 'application/json', JSON.stringify(body));
}

type LaunchTarget = { ok: true; dir: string; sourceAgent: Agent } | { ok: false; code: number; detail: string };

// Resolve a session's project dir. Board chats resolve from the DB exactly as
// before; archive chats (older than the board window, so absent from the DB) carry
// theirs on the query string, where it's validated before reaching tmux.
function resolveLaunchTarget(views: ChatView[], sid: string, proj: string | null): LaunchTarget {
  const matches = views.filter((x) => x.session_id === sid);
  if (matches.length === 1) return { ok: true, dir: matches[0].project_dir, sourceAgent: matches[0].agent };
  if (matches.length > 1) return { ok: false, code: 409, detail: 'ambiguous session' };
  if (!proj) return { ok: false, code: 404, detail: 'unknown session' };
  if (!isValidProjectDir(proj)) return { ok: false, code: 400, detail: 'invalid project dir' };
  // Archive search currently returns Claude transcripts only.
  return { ok: true, dir: proj, sourceAgent: 'claude' };
}

function diffMode(url: URL): DiffMode {
  // Branch is the default deliberately: it answers "what did this agent do",
  // which stays true after the agent commits. Working-tree mode goes blank at
  // exactly that moment.
  return url.searchParams.get('mode') === 'worktree' ? 'worktree' : 'branch';
}

/**
 * Repos come from the sessions Loom has indexed, and live badges from where the
 * running panes actually are, so the Trees tab needs no configuration of its own.
 */
function treesInput(): ScanInput {
  const { views, live } = snapshot();
  return {
    projectDirs: views.map((v) => v.project_dir),
    panes: panesFromLive(views, live, (agent, sid) => agentSessionKey(agent as Agent, sid)),
  };
}

function requestAgent(url: URL): Agent {
  return url.searchParams.get('agent') === 'codex' ? 'codex' : 'claude';
}

function isAgent(value: unknown): value is Agent {
  return value === 'claude' || value === 'codex';
}

function selectedAgent(url: URL): Agent | null {
  const agent = url.searchParams.get('agent');
  return isAgent(agent) ? agent : null;
}

// The archive search indexes Claude transcripts only, so a same-id Codex board
// row must not suppress a Claude archive result.
export function archiveExcludeSessionIds(views: Pick<ChatView, 'agent' | 'session_id'>[]): string[] {
  return views.filter((view) => view.agent === 'claude').map((view) => view.session_id);
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/goto') {
      const sid = url.searchParams.get('session') || '';
      const agent = requestAgent(url);
      const { live } = snapshot();
      const info = live[agentSessionKey(agent, sid)];
      if (!info) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'no live pane' }));
      const r = gotoPane(info.pane_id, info.tmux_session);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    if (url.pathname === '/api/live') {
      const { live } = snapshot();
      return send(res, 200, 'application/json', JSON.stringify(live));
    }

    if (url.pathname === '/api/data') {
      const { defaultAgent, views, live } = snapshot();
      return send(res, 200, 'application/json', JSON.stringify({ generatedAt: Date.now(), defaultAgent, chats: views, live, slackOwners: threadOwners(), drafts: pendingDrafts() }));
    }

    // The detail panel: git, gh and a transcript scan for ONE chat. Deliberately
    // its own route, fetched on selection, so none of it rides the board poll.
    if (url.pathname === '/api/detail') {
      const sid = url.searchParams.get('session') || '';
      const agent = requestAgent(url);
      const { views, live } = snapshot();
      const v = views.find((x) => x.agent === agent && x.session_id === sid);
      if (!v) return json(res, 404, { ok: false, detail: 'unknown session' });
      buildDetail(v, live[agentSessionKey(agent, sid)])
        .then((d) => json(res, 200, d))
        .catch((e) => json(res, 200, { ok: false, detail: (e as Error).message }));
      return;
    }

    // Open an owned Slack thread in the Slack app (https permalink as fallback).
    // By key, validated against the thread state, so this cannot open arbitrary URLs.
    if (url.pathname === '/api/slack/open' && req.method === 'POST') {
      openThread(url.searchParams.get('key') || '')
        .then((r) => json(res, r.ok ? 200 : 404, r))
        .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }));
      return;
    }

    // Slack drafts awaiting Will's okay. Send posts AS WILL, so it only ever
    // fires from the confirm click, and posts exactly the messages in the body
    // (which the confirm displayed). LOOM_SLACK_DRYRUN=1 or `dry: true` renders
    // with the CLI's preview instead and leaves the draft pending.
    if ((url.pathname === '/api/outbox/send' || url.pathname === '/api/outbox/discard') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let body: { id?: unknown; messages?: unknown; dry?: unknown };
        try {
          body = JSON.parse(raw) ?? {};
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        const id = typeof body.id === 'string' ? body.id : '';
        if (!id) return json(res, 400, { ok: false, detail: 'id is required' });
        if (url.pathname === '/api/outbox/discard') {
          discardDraft(id).then((r) => json(res, r.ok ? 200 : 409, r));
          return;
        }
        const messages = Array.isArray(body.messages) && body.messages.every((m) => typeof m === 'string') ? (body.messages as string[]) : null;
        if (!messages) return json(res, 400, { ok: false, detail: 'messages must be an array of strings' });
        const dry = body.dry === true || process.env.LOOM_SLACK_DRYRUN === '1';
        sendDraft(id, messages, { dry }).then((r) => json(res, r.ok ? 200 : 409, r));
      });
      return;
    }

    // The panel's empty state: the tail of the last message of every live chat
    // whose turn it is. The client decides which chats those are (it owns the
    // state filter) and asks for their tails by key.
    if (url.pathname === '/api/tails') {
      const keys = (url.searchParams.get('keys') || '').split(',').filter(Boolean).slice(0, 40);
      const { views } = snapshot();
      const out: Record<string, string> = {};
      for (const k of keys) {
        const v = views.find((x) => agentSessionKey(x.agent, x.session_id) === k);
        if (v) out[k] = lastMessageTail(v);
      }
      return json(res, 200, { ok: true, tails: out });
    }

    if (url.pathname === '/api/settings/default-agent' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid agent' });
        }
        const agent = body && typeof body === 'object' ? (body as { agent?: unknown }).agent : undefined;
        if (!isLaunchPreference(agent)) return json(res, 400, { ok: false, detail: 'invalid agent' });
        const db = openDb();
        setDefaultAgent(db, agent);
        db.close();
        return json(res, 200, { ok: true, defaultAgent: agent });
      });
      return;
    }

    // Where a dashboard Resume/Branch can land: one open pane per lane. The
    // launch itself re-resolves the lane, so this is a menu, not a reservation.
    if (url.pathname === '/api/lanes') {
      return json(res, 200, laneTargets(readWorld()));
    }

    // ---- Pane groups: the HTTP face of `chat-manager move` / `ungroup` -----
    //
    // Panes by @name or %id. Refusals (cross-lane, session full) are 409 so a
    // caller can tell "no such pane" from "not allowed there".

    if ((url.pathname === '/api/panes/move' || url.pathname === '/api/panes/ungroup') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let body: { pane?: unknown; to?: unknown };
        try {
          const parsed: unknown = JSON.parse(raw);
          body = parsed && typeof parsed === 'object' ? parsed : {};
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        const pane = typeof body.pane === 'string' ? body.pane : '';
        const to = typeof body.to === 'string' ? body.to : '';
        const move = url.pathname === '/api/panes/move';
        if (move && (!pane || !to)) return json(res, 400, { ok: false, detail: 'pane and to are required' });
        if (!pane) return json(res, 400, { ok: false, detail: 'pane is required' });
        const r = move ? movePane(pane, to, defaultGroupDeps()) : ungroupPane(pane, defaultGroupDeps());
        if (r.ok) return json(res, 200, r);
        return json(res, r.detail.startsWith('unknown pane') ? 404 : 409, r);
      });
      return;
    }

    // ---- Trees: worktree inventory, diffs, and cleanup -------------------
    //
    // A scan shells out to git ~5 times per worktree, so these routes read a
    // 30s cache rather than the dashboard's 5s poll. `?refresh=1` forces it.

    if (url.pathname === '/api/trees') {
      getTrees(treesInput(), { force: url.searchParams.get('refresh') === '1' })
        .then((payload) => json(res, 200, payload))
        .catch((e) => json(res, 200, { generatedAt: Date.now(), scanMs: 0, stale: true, repos: [], detail: (e as Error).message }));
      return;
    }

    // Jump to the pane a worktree is live in, focusing its Ghostty tab. Same
    // gotoPane the board's cards use; the pane is validated against the scan
    // rather than trusted from the query string.
    if (url.pathname === '/api/trees/goto') {
      const wt = knownWorktree(url.searchParams.get('wt') || '');
      const paneId = url.searchParams.get('pane') || '';
      const pane = wt?.livePanes.find((p) => p.pane_id === paneId);
      if (!pane) return json(res, 404, { ok: false, detail: 'no live pane there' });
      return json(res, 200, gotoPane(pane.pane_id, pane.tmux_session));
    }

    if (url.pathname === '/api/trees/files') {
      const wt = url.searchParams.get('wt') || '';
      filesFor(wt, diffMode(url))
        .then((files) => (files ? json(res, 200, { ok: true, files }) : json(res, 404, { ok: false, detail: 'unknown worktree' })))
        .catch((e) => json(res, 200, { ok: false, detail: (e as Error).message }));
      return;
    }

    if (url.pathname === '/api/trees/diff') {
      const wt = url.searchParams.get('wt') || '';
      const file = url.searchParams.get('file') || '';
      diffFor(wt, file, diffMode(url))
        .then((diff) => (diff === null ? json(res, 404, { ok: false, detail: 'unknown worktree' }) : json(res, 200, { ok: true, diff })))
        .catch((e) => json(res, 200, { ok: false, detail: (e as Error).message }));
      return;
    }

    // The only route in Loom that deletes anything. It re-scans and re-derives
    // permission from that fresh state, so the browser's opinion of what is safe
    // is never the thing that authorises a removal.
    if (url.pathname === '/api/trees/remove' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let paths: unknown;
        try {
          paths = (JSON.parse(raw) as { paths?: unknown }).paths;
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string')) {
          return json(res, 400, { ok: false, detail: 'paths must be an array of strings' });
        }
        removeWorktrees(treesInput(), paths as string[])
          .then((outcome) => json(res, 200, outcome))
          .catch((e) => json(res, 200, { ok: false, removed: [], refused: [], failed: [], detail: (e as Error).message }));
      });
      return;
    }

    // Deep search across the whole archive (everything the 7-day board prunes),
    // powered by find-chat. Board chats are excluded so the archive section only
    // surfaces what isn't already visible above.
    if (url.pathname === '/api/search') {
      const q = url.searchParams.get('q') || '';
      const { views } = snapshot();
      searchArchive(
        q,
        archiveExcludeSessionIds(views),
      )
        .then((r) => json(res, 200, r))
        .catch((e) => json(res, 200, { ok: false, detail: (e as Error).message }));
      return;
    }

    if (url.pathname === '/restore') {
      // Rebuild any workspace (loom-*) session not already running, then open a
      // Ghostty tab attached to each newly-restored session.
      let r;
      try {
        r = restore({ prefix: SESSION_PREFIX });
      } catch (e) {
        return send(res, 200, 'application/json', JSON.stringify({ ok: false, detail: (e as Error).message }));
      }
      const g = r.attach.length
        ? attachGhosttyTabs(r.attach, { attached: attachedSessions(), saved: r.windows })
        : { ok: true, opened: 0, reused: 0, detail: 'nothing to restore' };
      return send(res, 200, 'application/json', JSON.stringify({
        ok: g.ok, restored: r.restored, skipped: r.skipped, opened: g.opened, reused: g.reused, detail: g.detail,
      }));
    }

    if (url.pathname === '/api/transcript') {
      const sid = url.searchParams.get('session') || '';
      const agent = requestAgent(url);
      const { views, live } = snapshot();
      const v = views.find((x) => x.agent === agent && x.session_id === sid);
      if (v) {
        const messages = readTranscript(v.agent, v.jsonl_path);
        return json(res, 200, {
          ok: true, title: v.title || v.first_message, project: v.project,
          agent: v.agent, live: !!live[agentSessionKey(agent, sid)], messages,
        });
      }
      // Archive chat: no DB row, so the caller passes the transcript path (which
      // find-chat returns) plus the labels it already has for the panel header.
      const jsonl = url.searchParams.get('jsonl') || '';
      if (!jsonl) return json(res, 404, { ok: false, detail: 'unknown session' });
      if (!isValidTranscriptPath(jsonl)) {
        return json(res, 400, { ok: false, detail: 'invalid transcript path' });
      }
      const proj = url.searchParams.get('proj') || '';
      return json(res, 200, {
        ok: true,
        title: url.searchParams.get('title') || '(archived chat)',
        project: proj ? path.basename(proj) : '',
        agent: 'claude',
        live: !!live[agentSessionKey(agent, sid)], // an archive chat has no live pane, but stay truthful
        messages: readTranscript(jsonl),
      });
    }

    if (url.pathname === '/send') {
      const sid = url.searchParams.get('session') || '';
      const agent = selectedAgent(url);
      if (!agent) return json(res, 400, { ok: false, detail: 'invalid agent' });
      const text = url.searchParams.get('text') || '';
      const { live } = snapshot();
      const info = live[agentSessionKey(agent, sid)];
      if (!info) return send(res, 409, 'application/json', JSON.stringify({ ok: false, detail: 'chat is not live — resume it first' }));
      const r = sendToPane(info.pane_id, text, agent);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    if (url.pathname === '/close') {
      const sid = url.searchParams.get('session') || '';
      const agent = selectedAgent(url);
      if (!agent) return json(res, 400, { ok: false, detail: 'invalid agent' });
      const { live } = snapshot();
      const info = live[agentSessionKey(agent, sid)];
      if (!info) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'no live pane' }));
      const r = closeSession(info.pane_id, agent);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    // Save a chat for later: flag it as a durable bookmark (exempt from the window
    // prune, pinned in the dashboard's Saved section). If the chat is still live,
    // also close its pane in the same call — one click clears the workspace.
    if (url.pathname === '/save') {
      const sid = url.searchParams.get('session') || '';
      const agent = requestAgent(url);
      const db = openDb();
      const changed = db
        .prepare(`UPDATE chats SET saved = 1, saved_at = ? WHERE agent = ? AND session_id = ?`)
        .run(Date.now(), agent, sid).changes;
      db.close();
      if (!changed) return json(res, 404, { ok: false, detail: 'unknown session' });
      const info = snapshot().live[agentSessionKey(agent, sid)];
      const closed = info ? closeSession(info.pane_id, agent).ok : false;
      return json(res, 200, { ok: true, closed });
    }

    if (url.pathname === '/unsave') {
      const sid = url.searchParams.get('session') || '';
      const agent = requestAgent(url);
      const db = openDb();
      const changed = db
        .prepare(`UPDATE chats SET saved = 0, saved_at = 0 WHERE agent = ? AND session_id = ?`)
        .run(agent, sid).changes;
      db.close();
      if (!changed) return json(res, 404, { ok: false, detail: 'unknown session' });
      return json(res, 200, { ok: true });
    }

    if ((url.pathname === '/resume' || url.pathname === '/branch') && req.method === 'POST') {
      const sid = url.searchParams.get('session') || '';
      const agent = selectedAgent(url);
      if (!agent) return json(res, 400, { ok: false, detail: 'invalid agent' });
      // `lane=` launches into that lane's next open pane, resolved now rather than
      // when the dashboard listed it; `pane=` names the pane outright.
      const lane = url.searchParams.get('lane') || '';
      let pane = url.searchParams.get('pane') || '';
      if (!pane && lane) {
        pane = nextOpenPane(lane, readWorld())?.pane_id ?? '';
        if (!pane) return json(res, 409, { ok: false, detail: `no open pane in lane ${lane}` });
      }
      if (!pane) return json(res, 400, { ok: false, detail: 'no pane' });
      const { views } = snapshot();
      const target = resolveLaunchTarget(views, sid, url.searchParams.get('proj'));
      if (!target.ok) return json(res, target.code, { ok: false, detail: target.detail });
      const fork = url.pathname === '/branch';
      if (fork && target.sourceAgent !== agent) {
        return json(res, 400, { ok: false, detail: 'a session can only be branched with its own agent' });
      }
      const r = launchInPane({
        paneId: pane,
        projectDir: target.dir,
        sessionId: sid,
        sourceAgent: target.sourceAgent,
        selectedAgent: agent,
        fork,
      });
      return json(res, r.ok ? 200 : 500, r);
    }

    if (url.pathname === '/api/em/mode' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let body: unknown;
        try {
          body = JSON.parse(raw);
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid mode' });
        }
        const mode = body && typeof body === 'object' ? (body as { mode?: unknown }).mode : undefined;
        if (!isEmMode(mode)) return json(res, 400, { ok: false, detail: 'invalid mode' });
        const db = openDb();
        setEmMode(db, mode);
        db.close();
        return json(res, 200, { ok: true, mode });
      });
      return;
    }

    if (url.pathname === '/api/em') {
      const since = Date.now() - 24 * 3_600_000;
      const db = openDb();
      const led = recentLedger(db, since);
      const mode = getEmMode(db);
      db.close();
      return json(res, 200, { ok: true, mode, ...led });
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const { defaultAgent, views, live } = snapshot();
      return send(res, 200, 'text/html; charset=utf-8', renderDashboard(views, Date.now(), live, defaultAgent, threadOwners(), pendingDrafts()));
    }

    send(res, 404, 'text/plain', 'not found');
  });
}

// Start only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(SERVER_PORT, '127.0.0.1', () => {
    console.log(`[loom] server on http://localhost:${SERVER_PORT}`);
  });
  // Capture a full tmux-layout snapshot for crash recovery while tmux is healthy.
  const snap = () => {
    try {
      writeLayout(Date.now());
    } catch {
      /* tmux not running */
    }
  };
  snap();
  setInterval(snap, 15_000);

  // EM fast tick: signals + detectors only. No model calls, so this is free to
  // run often — a tick with nothing wrong costs nothing.
  setInterval(() => {
    try {
      const db = openDb();
      scanTick(db, snapshot().live, Date.now());
      db.close();
    } catch (e) {
      console.error('[loom] em scan failed:', (e as Error).message);
    }
  }, 30_000);

  // EM slow tick: one model call per NEW finding. Serialized against itself so a
  // slow triage pass cannot overlap the next one and double-handle a finding.
  let triaging = false;
  setInterval(async () => {
    if (triaging) return;
    triaging = true;
    const db = openDb();
    try {
      await triageTick(db, Date.now(), { live: snapshot().live });
    } catch (e) {
      console.error('[loom] em triage failed:', (e as Error).message);
    } finally {
      db.close();
      triaging = false;
    }
  }, 300_000);
}
