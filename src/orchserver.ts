import fs from 'node:fs';
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { execFile } from 'node:child_process';
import type Database from 'better-sqlite3';
import { openDb } from './db.ts';
import type { ChatView, LiveLoc } from './dashboard.ts';
import { agentSessionKey } from './placements.ts';
import { defaultRun, focusedPaneFrom, readWorld, type TmuxRunner } from './compact.ts';
import { sendToPane } from './goto.ts';
import { readTranscript, type Msg } from './transcript.ts';
import { readAllThreads, type ThreadRec } from './slack.ts';
import { parseSlackThread } from './slackref.ts';
import { cachedPipeline, parsePrRef, wantPipeline } from './pipeline.ts';
import { readOutbox } from './outbox.ts';
import { threadState } from './slackowner.ts';
import { sweepItems, type ChatFact, type PrFact, type SweepFacts } from './orchsweep.ts';
import { detectFirstRunPrompt, type OrchStartState } from './orchstart.ts';
import { acquireManagedPane } from './managed.ts';
import { waitForShellReady } from './newthread.ts';
import type { Agent } from './types.ts';
import {
  EventBatcher,
  deliverQueued,
  detectEvents,
  formatEventBatch,
  listItems,
  logOrch,
  needsYouCount,
  newObsState,
  notifyNeedsYou,
  orchSettings,
  queuedRelays,
  recentLog,
  relayToChat,
  resolveItem,
  startOfDay,
  type ChatObs,
  type ChatTarget,
  type RelayDeps,
} from './orchestrator.ts';
import { callOrchTool, type ChatInfo, type OrchToolDeps } from './orchtools.ts';
import { toolBin, toolEnv } from './toolpath.ts';
import {
  ensureOrchFiles,
  ensureOrchToken,
  isOrchPane,
  orchDir,
  orchTranscriptPath,
  remoteControlUrl,
  superviseOrchestrator,
  type McpSpec,
  type OrchFiles,
  type SuperviseMemo,
  type SuperviseResult,
} from './orchsession.ts';

// The server side of the orchestrator: its HTTP routes (/api/orch/*), the tool
// deps the MCP calls run against, and the tick that supervises the session,
// detects transitions and delivers events and queued relays. server.ts mounts the
// routes and calls orchTick() from its existing 15s board pass, so detection adds
// no tick of its own and nothing on the orchestrator side ever polls.

export interface Snap {
  views: ChatView[];
  live: Record<string, LiveLoc>;
}

/* ------------------------------------------------------------ state */

let files: OrchFiles | null = null; // set when this process supervises the session
const memo: SuperviseMemo = { launches: [] };
let lastSupervise: SuperviseResult | null = null;
const obs = newObsState();
const batcher = new EventBatcher();
let sweptAt = 0;
/** The sweep re-reads the outbox and the PR cache; once a minute is plenty for a rail. */
export const SWEEP_EVERY_MS = 60_000;

/**
 * Turn the orchestrator on for this process: write its prompt + MCP config and
 * start supervising its session on the next tick. Called by the Electron app
 * (the always-on daemon) with the bundled MCP spec. Without it, the routes and
 * the tool endpoint still work; only the session is not started from here.
 */
export function configureOrchestrator(mcp: McpSpec, dir: string = orchDir()): OrchFiles {
  files = ensureOrchFiles(dir, mcp);
  return files;
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------ chats */

export function orchSessionId(): string {
  try {
    return withDb((db) => orchSettings.sessionId(db));
  } catch {
    return '';
  }
}

const where = (L: LiveLoc) => `${L.tmux_session}:${L.window_index}.${L.pane_index}`;

/** list_chats rows, the orchestrator's own session left out. */
export function chatInfos(snap: Snap, orchSid: string, threads: Record<string, ThreadRec> = readAllThreads(), chatPr: (v: ChatView) => string = (v) => v.pr_url): ChatInfo[] {
  const slack = new Map<string, string[]>();
  for (const t of Object.values(threads)) if (t.session_id) (slack.get(t.session_id) ?? slack.set(t.session_id, []).get(t.session_id)!).push(t.url);
  const rows: ChatInfo[] = [];
  for (const v of snap.views) {
    if (orchSid && v.session_id === orchSid) continue;
    const key = agentSessionKey(v.agent, v.session_id);
    const L = snap.live[key];
    rows.push({
      chat: key, agent: v.agent, session_id: v.session_id,
      title: v.title || v.claude_auto_title || v.first_message.slice(0, 80),
      state: L ? (L.working ? 'working' : 'your_turn') : 'not_running',
      summary: v.overview, project: v.project,
      pane: L ? L.name || L.pane_id : '', tmux: L ? where(L) : '', stage: L?.stage ?? '',
      pr: chatPr(v), slack: slack.get(v.session_id) ?? [], tags: v.tags,
      last_active_at: v.last_active_at, jsonl_path: v.jsonl_path,
    });
  }
  const rank = { working: 0, your_turn: 1, not_running: 2 } as const;
  return rows.sort((a, b) => rank[a.state] - rank[b.state] || b.last_active_at - a.last_active_at);
}

function targetFrom(snap: Snap, agent: Agent, sid: string): ChatTarget | null {
  const L = snap.live[agentSessionKey(agent, sid)];
  if (!L) return null;
  const v = snap.views.find((x) => x.agent === agent && x.session_id === sid);
  return { agent, session_id: sid, pane_id: L.pane_id, label: L.name || v?.title || L.pane_id };
}

export function relayDeps(getSnap: () => Snap, run: TmuxRunner = defaultRun): RelayDeps {
  return {
    focused: () => focusedPaneFrom(run),
    resolve: (agent, sid) => targetFrom(getSnap(), agent, sid),
    send: (paneId, text, agent) => sendToPane(paneId, text, agent),
    now: () => Date.now(),
  };
}

const gh = (args: string[]) =>
  new Promise<string>((resolve, reject) =>
    execFile(toolBin('gh'), args, { encoding: 'utf-8', timeout: 20_000, env: toolEnv(toolBin('gh')) }, (err, out) => (err ? reject(err) : resolve(out))),
  );

export function toolDeps(getSnap: () => Snap): OrchToolDeps {
  const relay = relayDeps(getSnap);
  return {
    chats: () => chatInfos(getSnap(), orchSessionId()),
    tail: (c, turns) => readTranscript(c.agent, c.jsonl_path, { limit: turns }),
    gh,
    cachedPr: (url) => {
      const r = parsePrRef(url);
      return r ? cachedPipeline(r.repo, r.number) : null;
    },
    slackForChat: (sid) =>
      Object.entries(readAllThreads()).filter(([, t]) => t.session_id === sid).map(([key, t]) => ({ key, url: t.url })),
    slackOwner: (url) => {
      const ref = parseSlackThread(url);
      if (!ref) return null;
      const t = readAllThreads()[ref.key];
      if (!t?.session_id) return null;
      const v = getSnap().views.find((x) => x.session_id === t.session_id);
      return { key: ref.key, url: t.url, chat: agentSessionKey(v?.agent ?? 'claude', t.session_id) };
    },
    relay: (agent, sid, text) => withDb((db) => relayToChat(db, relay, agent, sid, text)),
    withDb,
    notify: (item) => withDb((db) => notifyNeedsYou(db, item)),
    now: () => Date.now(),
  };
}

/* ------------------------------------------------------------ the sweep */

/**
 * The facts the sweep checks items against, from what Loom already holds: the
 * board snapshot, the outbox, the PR pipeline cache, the Slack thread stages.
 * Each lookup answers null when Loom has no data, which never clears anything:
 * a board that has not indexed yet must not read as "every chat archived".
 */
export function sweepFacts(snap: Snap, db: Database.Database, readDrafts: () => Record<string, { status: string }> = readOutbox, now: number = Date.now()): SweepFacts {
  const views = new Map(snap.views.map((v) => [agentSessionKey(v.agent, v.session_id), v]));
  let drafts: Record<string, { status: string }> | null = null;
  return {
    chat: (ref): ChatFact | null => {
      if (!snap.views.length || !/^[a-z]+:./.test(ref)) return null;
      const v = views.get(ref);
      const L = snap.live[ref];
      if (!v) return L ? null : { onBoard: false, closed: false, live: false, working: false, lastTurnAt: 0, lastActiveAt: 0 };
      return { onBoard: true, closed: !!v.done && !L, live: !!L, working: !!L?.working, lastTurnAt: v.last_turn_at || 0, lastActiveAt: v.last_active_at || 0 };
    },
    pr: (url): PrFact | null => {
      const r = parsePrRef(url);
      if (!r) return null;
      // Register interest so the pipeline tick fetches a PR no chat is showing.
      const p = wantPipeline(r.repo, r.number, false, now);
      if (!p) return null;
      const st = (k: string) => p.steps.find((x) => x.key === k)?.state ?? '';
      const merged = st('merged');
      return { state: merged === 'pass' ? 'merged' : merged === 'fail' ? 'closed' : 'open', deploy: st('deploy') };
    },
    draft: (id) => {
      try {
        drafts ??= readDrafts();
      } catch {
        drafts = {};
      }
      return drafts[id]?.status ?? null;
    },
    slack: (url) => {
      const ref = parseSlackThread(url);
      if (!ref) return null;
      try {
        return threadState(db, ref.key)?.stage || null;
      } catch {
        return null;
      }
    },
  };
}

/** Clear every open item whose condition no longer holds, and say so in the log. Returns what it cleared. */
export function sweepRail(db: Database.Database, facts: SweepFacts, now: number): { id: number; title: string; why: string }[] {
  const cleared = sweepItems(listItems(db), facts, now).filter((c) => resolveItem(db, c.id, now, c.why));
  if (cleared.length) {
    const text = cleared.map((c) => `${c.title} (${c.why})`).join(' · ');
    logOrch(db, 'cleared', `${cleared.length} item${cleared.length === 1 ? '' : 's'}`, text, now);
  }
  return cleared;
}

/* ------------------------------------------------------------ the tick */

/** What the orchestrator session itself looks like right now. */
function orchLive(snap: Snap, sid: string): LiveLoc | null {
  return sid ? snap.live[agentSessionKey('claude', sid)] ?? null : null;
}

function prSignal(v: ChatView): ChatObs['pr'] {
  const ref = parsePrRef(v.pr_url);
  if (!ref) return undefined;
  const p = cachedPipeline(ref.repo, ref.number);
  if (!p) return undefined;
  const st = (k: string) => p.steps.find((s) => s.key === k)?.state ?? '';
  return { ref: `${ref.repo}#${ref.number}`, checks: st('checks'), review: st('review') };
}

export function observations(snap: Snap, orchSid: string, mtime: (v: ChatView) => number): ChatObs[] {
  const out: ChatObs[] = [];
  for (const v of snap.views) {
    if (v.session_id === orchSid) continue;
    const key = agentSessionKey(v.agent, v.session_id);
    const L = snap.live[key];
    // Only chats that are running, or ran recently enough to have a PR still moving.
    if (!L && !v.pr_url) continue;
    out.push({
      key, title: v.title || v.claude_auto_title, name: L?.name ?? '', project: v.project,
      live: !!L, working: !!L?.working, lastWriteAt: mtime(v), pr: prSignal(v),
    });
  }
  return out;
}

const statMtime = (v: ChatView) => {
  try {
    return fs.statSync(v.jsonl_path).mtimeMs;
  } catch {
    return v.last_active_at;
  }
};

/**
 * One pass, on the board's 15s snapshot. Never throws. Order matters: deliver
 * queued relays first (focus may have left since the last pass), then detect,
 * then flush a due batch into the orchestrator unless Will is in its pane.
 */
export interface TickIo {
  run: TmuxRunner;
  send: (paneId: string, text: string, agent: Agent) => { ok: boolean; detail: string };
}

const realIo: TickIo = { run: defaultRun, send: (p, t, a) => sendToPane(p, t, a) };

export function orchTick(snap: Snap, now: number = Date.now(), io: TickIo = realIo): void {
  const { run } = io;
  try {
    withDb((db) => {
      if (files) {
        lastSupervise = superviseOrchestrator(db, files, {
          run,
          world: () => readWorld(run),
          acquire: (dir) => acquireManagedPane(dir, { run, ready: (id) => waitForShellReady(id, run) }),
          now: () => now,
          exists: (f) => fs.existsSync(f),
        }, memo);
      }
      if (now - sweptAt >= SWEEP_EVERY_MS) {
        sweptAt = now;
        try {
          sweepRail(db, sweepFacts(snap, db, readOutbox, now), now);
        } catch (e) {
          console.error('[loom] orchestrator sweep failed:', (e as Error).message);
        }
      }
      const relay: RelayDeps = { ...relayDeps(() => snap, run), send: io.send, now: () => now };
      if (queuedRelays(db).length) deliverQueued(db, relay);

      const sid = orchSettings.sessionId(db);
      const { events, cancel } = detectEvents(obs, observations(snap, sid, statMtime), now);
      for (const k of cancel) batcher.cancel(k);
      for (const e of events) batcher.add(e, now);
      if (!batcher.due(now)) return;
      const me = orchLive(snap, sid);
      const paneId = orchSettings.paneId(db);
      // Hold the batch while the orchestrator is down, or while Will is in its pane.
      if (!me || !isOrchPane(run, me.pane_id) || focusedPaneFrom(run) === paneId) return;
      const batch = batcher.take();
      const text = formatEventBatch(batch, now);
      const r = io.send(me.pane_id, text, 'claude');
      logOrch(db, r.ok ? 'events' : 'failed', 'orchestrator', batch.map((e) => e.text).join(' · '), now);
      if (!r.ok) for (const e of batch) batcher.add(e, now); // retry next pass
    });
  } catch (e) {
    console.error('[loom] orchestrator tick failed:', (e as Error).message);
  }
}

/* ------------------------------------------------------------ routes */

function json(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage, then: (b: Record<string, unknown> | null) => void): void {
  let raw = '';
  req.on('data', (c: Buffer) => {
    if (raw.length < 64 * 1024) raw += c;
  });
  req.on('end', () => {
    try {
      const b = JSON.parse(raw || '{}');
      then(b && typeof b === 'object' ? b : null);
    } catch {
      then(null);
    }
  });
}

/** The MCP process's token (0600 file in the orchestrator dir). The route table's `orch` kind. */
export function orchTokenOk(req: http.IncomingMessage): boolean {
  const got = Buffer.from(String(req.headers['x-loom-orch-token'] ?? ''));
  let want: Buffer;
  try {
    want = Buffer.from(ensureOrchToken(orchDir()));
  } catch {
    return false;
  }
  return got.length === want.length && timingSafeEqual(got, want);
}

/** The orchestrator view's whole payload. */
export function orchView(snap: Snap, now: number = Date.now(), run: TmuxRunner = defaultRun): Record<string, unknown> {
  return withDb((db) => {
    const sid = orchSettings.sessionId(db);
    const me = orchLive(snap, sid);
    const paneId = orchSettings.paneId(db);
    const dir = files?.dir ?? orchDir();
    const today = startOfDay(now);
    const transcript = sid ? orchTranscriptPath(dir, sid) : '';
    const messages = transcript ? readTranscript('claude', transcript, { limit: 120, withTime: true }) : [];
    const items = listItems(db, today);
    const covered = new Set(items.filter((i) => i.ref_type === 'chat' && !i.resolved_at).map((i) => i.ref_id));
    // Moving per agent: the items say it, and a working chat with no item still shows.
    const moving = chatInfos(snap, sid)
      .filter((c) => c.state === 'working' && !covered.has(c.chat))
      .map((c) => ({ chat: c.chat, pane: c.pane, title: c.title, stage: c.stage }));
    const enabled = orchSettings.enabled(db);
    const paneExists = !!paneId && isOrchPane(run, paneId);
    let startState: OrchStartState = !enabled ? 'disabled' : me ? 'running' : 'exited';
    let prompt: string | null = null;
    if (enabled && !me) {
      if (paneExists) {
        try {
          const hit = detectFirstRunPrompt(run(['capture-pane', '-p', '-t', paneId]));
          if (hit) {
            startState = 'prompt';
            prompt = hit.question;
          }
        } catch {
          /* pane vanished between checks */
        }
      }
      if (startState === 'exited') {
        const a = lastSupervise?.action;
        if (a === 'starting' || a === 'started' || a === 'restarted') startState = 'starting';
      }
    }
    return {
      ok: true,
      enabled,
      startState,
      prompt,
      paneExists,
      gaveUp: lastSupervise?.action === 'gave_up',
      supervised: !!files,
      sessionId: sid,
      paneId,
      live: !!me,
      working: !!me?.working,
      status: lastSupervise ? { action: lastSupervise.action, detail: lastSupervise.detail } : null,
      remoteUrl: me ? remoteControlUrl(run, me.pane_id) : '',
      notify: orchSettings.notify(db),
      needsYou: needsYouCount(db),
      items,
      moving,
      log: recentLog(db, now - 24 * 3_600_000),
      queued: queuedRelays(db),
      messages,
    };
  });
}

/** One page of earlier turns: the `limit` turns before `before` (a turn time, ms), oldest first.
 *  A restart resumes the same session id (and so the same transcript), so one file holds the whole history. */
export function orchHistory(before: number, limit: number): { ok: true; messages: Msg[]; more: boolean } {
  return withDb((db) => {
    const sid = orchSettings.sessionId(db);
    const dir = files?.dir ?? orchDir();
    const transcript = sid ? orchTranscriptPath(dir, sid) : '';
    let size = 0;
    try {
      size = transcript ? fs.statSync(transcript).size : 0;
    } catch {
      /* no transcript yet */
    }
    const n = Math.min(Math.max(1, Math.floor(limit) || 120), 500);
    const all = size ? readTranscript('claude', transcript, { limit: Number.MAX_SAFE_INTEGER, withTime: true, bytes: size + 1 }) : [];
    const older = all.filter((m) => (m.at ?? 0) > 0 && (m.at as number) < before);
    return { ok: true as const, messages: older.slice(-n), more: older.length > n };
  });
}

/** For /api/data: the sidebar entry's badge and the session to hide from the list. */
export function orchSummary(live: Record<string, LiveLoc> = {}): { sessionId: string; needsYou: number; enabled: boolean; live: boolean } {
  try {
    return withDb((db) => {
      const sessionId = orchSettings.sessionId(db);
      return { sessionId, needsYou: needsYouCount(db), enabled: orchSettings.enabled(db), live: !!(sessionId && live[agentSessionKey('claude', sessionId)]) };
    });
  } catch {
    return { sessionId: '', needsYou: 0, enabled: false, live: false };
  }
}

function sendToOrchestrator(snap: Snap, text: string): { ok: boolean; detail: string } {
  const sid = orchSessionId();
  const me = orchLive(snap, sid);
  if (!me) return { ok: false, detail: 'the orchestrator is not running' };
  return sendToPane(me.pane_id, text, 'claude');
}

/** The orchestrator's message for "Ask the orchestrator about this". */
export function askAboutText(c: ChatInfo | undefined, key: string): string {
  if (!c) return `The user asks about chat ${key}: where does it stand, and does it need the user?`;
  return `The user asks about chat ${c.chat} ("${c.title}"${c.pane ? `, pane ${c.pane}` : ''}, ${c.state.replace('_', ' ')}): where does it stand, and does it need the user? Read it (chat_tail) before answering.`;
}

/** Handles /api/orch*; returns false for any other path. */
export function handleOrchRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, getSnap: () => Snap): boolean {
  const p = url.pathname;
  if (p !== '/api/orch' && !p.startsWith('/api/orch/')) return false;

  if (p === '/api/orch' && req.method === 'GET') {
    const before = Number(url.searchParams.get('before'));
    if (Number.isFinite(before) && before > 0) {
      json(res, 200, orchHistory(before, Number(url.searchParams.get('limit'))));
      return true;
    }
    json(res, 200, orchView(getSnap()));
    return true;
  }

  // The MCP process's calls. Token-gated: these relay into other chats.
  if (p === '/api/orch/tool' && req.method === 'POST') {
    if (!orchTokenOk(req)) {
      json(res, 403, { ok: false, error: 'bad token' });
      return true;
    }
    readJson(req, (b) => {
      if (!b || typeof b.name !== 'string') return json(res, 400, { ok: false, error: 'name is required' });
      const args = b.args && typeof b.args === 'object' ? (b.args as Record<string, unknown>) : {};
      callOrchTool(toolDeps(getSnap), b.name, args)
        .then((out) => json(res, 200, out))
        .catch((e) => json(res, 200, { ok: false, error: (e as Error).message }));
    });
    return true;
  }

  if (req.method !== 'POST' && req.method !== 'PUT') {
    json(res, 405, { ok: false, detail: 'method not allowed' });
    return true;
  }
  // Host, Origin and the launch token were checked by the route table's
  // `browser` guard before this handler ran (src/routes/index.ts).
  readJson(req, (b) => {
    if (!b) return json(res, 400, { ok: false, detail: 'invalid body' });
    const now = Date.now();
    if (p === '/api/orch/send') {
      const text = typeof b.text === 'string' ? b.text.trim() : '';
      if (!text) return json(res, 400, { ok: false, detail: 'text is required' });
      const r = sendToOrchestrator(getSnap(), text);
      return json(res, r.ok ? 200 : 409, r);
    }
    if (p === '/api/orch/ask') {
      const sid = typeof b.session === 'string' ? b.session : '';
      const agent = b.agent === 'codex' ? 'codex' : 'claude';
      if (!sid) return json(res, 400, { ok: false, detail: 'session is required' });
      const snap = getSnap();
      const key = agentSessionKey(agent, sid);
      const c = chatInfos(snap, orchSessionId()).find((x) => x.chat === key);
      const text = askAboutText(c, key);
      const r = sendToOrchestrator(snap, text);
      if (r.ok) withDb((db) => logOrch(db, 'ask', c?.pane || key, text, now));
      return json(res, r.ok ? 200 : 409, r);
    }
    if (p === '/api/orch/notify') {
      const mode = b.mode === 'off' ? 'off' : b.mode === 'needs_you' ? 'needs_you' : null;
      if (!mode) return json(res, 400, { ok: false, detail: 'mode is needs_you or off' });
      withDb((db) => orchSettings.setNotify(db, mode));
      return json(res, 200, { ok: true, notify: mode });
    }
    if (p === '/api/orch/resolve') {
      const id = Number(b.id);
      if (!Number.isInteger(id)) return json(res, 400, { ok: false, detail: 'id is required' });
      const item = withDb((db) => resolveItem(db, id, now));
      return json(res, item ? 200 : 404, item ? { ok: true, item } : { ok: false, detail: 'no open item' });
    }
    return json(res, 404, { ok: false, detail: 'not found' });
  });
  return true;
}
