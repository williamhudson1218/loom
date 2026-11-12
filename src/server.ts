import { createRequire } from 'node:module';
import { paneHome, tmux } from './tmux.ts';
import { actionAllowed, attachTerminalBridge, checkSnapAuth, isPaneId, snapshotScreen, isLoomHost, isTermAction, termCommand, termToken, viewKind } from './ptybridge.ts';
import { createTerminalSession, listTerminals } from './terminals.ts';
import http from 'node:http';
import { preferredPort, serverPort } from './serverport.ts';
import { localIdentity } from './portpick.ts';
import { startListening, startFailure } from './serverstart.ts';
import fs from 'node:fs';
import path from 'node:path';
import { getDefaultAgent, loadTmuxSocketSetting, openDb, setDefaultAgent } from './db.ts';
import { toChatViews, renderDashboard, type ChatView, type LiveLoc } from './dashboard.ts';
import { liveSessions, listTmuxPanes, attachedSessions } from './placements.ts';
import { gotoPane, launchInPane, closeSession, sendToPane } from './goto.ts';
import { readTranscript } from './transcript.ts';
import { writeLayout } from './snapshot.ts';
import { lastTurnAtFromTail } from './parser.ts';
import { restore } from './restore.ts';
import { attachGhosttyTabs } from './ghostty.ts';
import { searchArchive, isValidProjectDir, isValidTranscriptPath, findChatFromSettings, setFindChatBin } from './findchat.ts';
import { startPluginStateSync } from './pluginmgr.ts';
import { SESSION_PREFIX, TOOL_DIR } from './paths.ts';
import { paneNameMap, rememberPaneNames } from './panenames.ts';
import { realTopicDeps } from './panetopics.ts';
import { movePane, ungroupPane, defaultGroupDeps, readWorld, laneTargets, nextOpenPane } from './compact.ts';
import { agentSessionKey } from './placements.ts';
import { isLaunchPreference, type Agent, type LaunchPreference } from './types.ts';
import { getTrees, filesFor, diffFor, removeWorktrees, panesFromLive, knownWorktree, type ScanInput } from './trees.ts';
import type { DiffMode } from './git.ts';
import { buildDetail, lastMessageTail } from './detail.ts';
import { openThread, readAllThreads, threadOwners } from './slack.ts';
import { slackCounts } from './slackthreads.ts';
import { defaultGotoDeps, threadGoto, parseSlackThread } from './slackgoto.ts';
import { discardDraft, setSeen, LEGACY_OUTBOX_PATH, setLegacyWriteBack, legacyStateDir, draftImage, pendingDrafts as pendingDraftsRaw, readOutbox, readStaleMarks, reconcileLive, sendDraft, sendNow, sendProgress } from './outbox.ts';
import { startEventIngest } from './events.ts';
import { allTestLinks } from './testlinks.ts';
import { handleCliPath, setCliDeps } from './routes/cli.ts';
import { firstPaint } from './routes/wizard.ts';
import { connectionsSafe } from './connections.ts';
import { slackFeatureOn, slackMode, slackOffDetail, SLACK_OFF } from './slackmode.ts';
import { authTest, conversationsReplies } from './slackapi.ts';
import { getSetting, onSettingChanged } from './settingsSchema.ts';
import type { ThreadRef } from './slackref.ts';
import { emailRepliesVia, getParked, isEmailRow, listParked, pollParked, restoreChat, resumePrompt, sendThen, unparkChat, type AfterSend, waitingLabel, type ParkedRow } from './parked.ts';
import { OutboxWatch } from './outboxwatch.ts';
import { cachedHead, ghRun, githubPoster, headMoved } from './outboxreview.ts';
import { cliAdapter, cliRunner, EMAIL_OFF_DETAIL, resolveEmailCli, type EmailAdapter } from './outboxemail.ts';
import { chooseEmailRoute, gmailAdapter } from './gmailapi.ts';
import { googleAccessToken, listGoogleAccounts, markGoogleReconnect, type GoogleAccount } from './googleoauth.ts';
import { cachedFresh, clearFreshCache, currentSeen, ghActivityVia, ghMeVia, type FreshDeps } from './outboxfresh.ts';
import { getDirectory as getDirectoryRaw, readDirectory } from './slackdir.ts';
import { execFile } from 'node:child_process';
import { notifyScript, notifyUser } from './notify.ts';
import { EMOJI_MAP } from './emojimap.ts';
import { confirmLaunches, dismissLaunch, indexFreshLaunches, launchById, launchView, recentLaunches, startThread, waitForShellReady, waitForShellReadyAsync } from './newthread.ts';
import { pickLog } from './picklog.ts';
import { acquireManagedPane, pickStrategy, startManagedTicks } from './managed.ts';
import { readThreads } from './slack.ts';
import { claimThread, dismissStart, getChannelProjects, recentStarts, replaceStart, setChannelProject, setLastProject } from './slackowner.ts';
import { parseLane } from './compact.ts';
import { cachedPipeline, dots, parsePrRef, pipelineKey, tickPipelines, wantPipeline, type Pipeline } from './pipeline.ts';
import { refreshShipBoards, shipBoards, type ShipBoard } from './ships.ts';
import { onShipBoards } from './prune.ts';
import { gatherShipDetail, isShipRepo, safeRepoPath, shipFileDiff, startShipSession } from './shipdetail.ts';
import { addProject, listProjects, removeProject, seedProjects, updateProject } from './projects.ts';
import { trustedFolders } from './orchstart.ts';
import { MAX_LABEL, setOverride, setShipLabel } from './shipview.ts';
import { createTag, deleteTag, listTags, setChatTags, updateTag } from './tags.ts';
import { handleOrchRoute, orchSummary, orchTick } from './orchserver.ts';
import { ensureCliToken, gate, legacyGetPaths, requireWrite, runRoute } from './routes/index.ts';
import { clientFetchJs } from './clientfetch.ts';
import { codexVisible, currentTerminal, insideFocusState, terminalLabel } from './terminal.ts';
import { autoResumeParked, settingsGet, settingsPut } from './settings.ts';
import { orchSettings } from './orchestrator.ts';
import { provisionalViews, spawnTitles } from './liveindex.ts';
import { isOrchestratorRef } from './orchsession.ts';
import { configureWatcherRuntime, isDryRun, startWatcherTicks, BRIEFS_DIR as WATCHER_BRIEFS_DIR, type EngineDeps, type TestDeps } from './watchers/engine.ts';
import { attentionCount, getEvent, setWatcherEnabled, validateDraft, getWatcher } from './watchers/model.ts';
import { computeSignals } from './watchers/chatSignals.ts';
import { prStateFrom, type PrState } from './watchers/sources/prs.ts';
import { relayFromWatcher, tmuxLaunch } from './watchers/actions.ts';
import { relayDeps } from './orchserver.ts';
import { channelHistory } from './slack.ts';
import { conversationsHistory } from './slackapi.ts';
import { activeJobs, allPipelines } from './pipeline.ts';
import { getOwner } from './slackowner.ts';
import { currentLaunchSettings } from './launch.ts';

// /resume and /branch requests still waiting on a new window's shell, by session id.
const resumesInFlight = new Set<string>();


// ---- PR pipelines on the board ----------------------------------------------
// The board shows a dot strip per chat with a PR. The poll only ever reads the
// pipeline store; the background tick below is what talks to GitHub, and only
// for PRs the board asked about recently.
const BOARD_PR_WINDOW_MS = 3 * 24 * 3_600_000;
// A chat whose PR was found from its branch (no pr_url in the index) — learned by the detail panel.
const branchPrs = new Map<string, string>(); // chat key -> PR url
let pipelineLiveKeys = new Set<string>();

export interface PipeSummary {
  number: number;
  url: string;
  dots: ReturnType<typeof dots>;
  events: Pipeline['events'];
  inFlight: boolean;
  final: boolean;
  jobs: ReturnType<typeof activeJobs>;
}

/** The PR a chat is on: the last PR URL in its transcript (indexed), else the one its branch resolved to. */
const chatPrRef = (v: ChatView, ck: string) => parsePrRef(v.pr_url || branchPrs.get(ck) || '');

function boardPipes(views: ChatView[], live: Record<string, LiveLoc>, now: number = Date.now()): { pipes: Record<string, PipeSummary>; chatPr: Record<string, string> } {
  const pipes: Record<string, PipeSummary> = {};
  const chatPr: Record<string, string> = {};
  const liveKeys = new Set<string>();
  for (const v of views) {
    const ck = agentSessionKey(v.agent, v.session_id);
    const isLive = !!live[ck];
    if (!isLive && now - v.last_active_at > BOARD_PR_WINDOW_MS) continue;
    const ref = chatPrRef(v, ck);
    if (!ref) continue;
    const key = pipelineKey(ref.repo, ref.number);
    chatPr[ck] = key;
    if (isLive) liveKeys.add(key);
    const p = wantPipeline(ref.repo, ref.number, isLive, now);
    if (p && !pipes[key]) pipes[key] = summarize(p);
  }
  // Every recent ship PR too: its member chats show its pipeline on their cards.
  for (const b of shipBoards()) {
    for (const s of b.shipped) {
      const key = pipelineKey(b.slug, s.number);
      const isLive = s.members.some((m) => !!live[m]);
      if (isLive) liveKeys.add(key);
      const p = wantPipeline(b.slug, s.number, isLive, now);
      if (p && !pipes[key]) pipes[key] = summarize(p);
    }
  }
  pipelineLiveKeys = liveKeys;
  return { pipes, chatPr };
}

const summarize = (p: Pipeline): PipeSummary => ({ number: p.number, url: p.url, dots: dots(p), events: p.events, inFlight: p.inFlight, final: p.final, jobs: activeJobs(p) });

/** The Ship section of a chat's panel: the next ship it will ride, and the latest ship it rode with that ship's pipeline. */
function shipDetail(chatKey: string): unknown {
  for (const b of shipBoards()) {
    const role = b.byChat[chatKey];
    const holds = b.lock && b.lock.holderKey === chatKey;
    if (!role && !holds) continue;
    const mine = b.next.chats.find((c) => c.key === chatKey) ?? null;
    const latest = role?.ships.length ? b.shipped.find((s) => s.number === role.ships[0]) ?? null : null;
    return {
      repo: b.repo,
      slug: b.slug,
      lock: b.lock,
      next: mine ? { ...mine, fellows: b.next.chats.filter((c) => c.key !== chatKey).map((c) => ({ key: c.key, staged: c.staged, unstaged: c.unstaged })) } : null,
      shipped: latest ? { ...latest, pipeline: cachedPipeline(b.slug, latest.number) } : null,
      others: role?.ships.slice(1) ?? [],
    };
  }
  return null;
}

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
    const out = tmux(['capture-pane', '-p', '-t', paneId, '-S', '-4'], { timeout: 1000 });
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

// path -> the last turn read off the tail at a given mtime, so a 5s poll with
// twenty live chats reads nothing that has not changed.
const tailTurns = new Map<string, { mtime: number; at: number }>();
function tailTurnAt(jsonlPath: string, mtime: number): number {
  const hit = tailTurns.get(jsonlPath);
  if (hit && hit.mtime === mtime) return hit.at;
  const at = lastTurnAtFromTail(jsonlPath);
  tailTurns.set(jsonlPath, { mtime, at });
  return at;
}

type Snap = { defaultAgent: LaunchPreference; views: ChatView[]; live: Record<string, LiveLoc> };

// Building a snapshot is ~170 ms of synchronous work (DB read, a stat per chat,
// list-panes, a whole-machine ps, a capture-pane per live chat). The board poll,
// the orchestrator view, the EM/ship ticks and the detail route all ask within
// the same second, so they share one copy for SNAP_TTL_MS. Not reused under
// vitest, where tests change tmux between calls.
const SNAP_TTL_MS = 1500;
let snapMemo: { at: number; snap: Snap } | null = null;

// The outbox watcher: notices a chat posting its own draft from the transcript (src/outboxwatch.ts).
const outboxWatch = new OutboxWatch({
  transcriptOf: (sid) => {
    const v = snapshot().views.find((x) => x.session_id === sid && x.agent === 'claude');
    return v?.jsonl_path ?? null;
  },
  // A chat that posts a new top-level message owns the thread it started (a thread another chat owns stays put).
  claimStarted: (ref, sid) => claimStartedThread(ref, sid),
  liveSessionIds: () => Object.values(snapshot().live).filter((l) => l.agent === 'claude' && l.session_id).map((l) => l.session_id),
});

/** A chat started this thread (its own post, or Loom's Send of its draft): it owns it unless another chat already does. */
function claimStartedThread(ref: ThreadRef, sid: string): void {
  if (readAllThreads()[ref.key]?.session_id) return;
  const v = snapshot().views.find((x) => x.session_id === sid && x.agent === 'claude');
  const db = openDb();
  try {
    claimThread(db, { ...ref, url: ref.url || `https://app.slack.com/archives/${ref.channel}/p${ref.ts.replace('.', '')}` }, { agent: 'claude', sessionId: sid, projectDir: v?.project_dir ?? '', source: 'send' });
  } finally {
    db.close();
  }
}

/** The old hook's thread state, while an older install may still write it ('' dir = none). */
function legacyThreadState(): ReturnType<typeof readThreads> {
  const dir = legacyStateDir();
  return dir ? readThreads(path.join(dir, 'slack-threads.json')) : {};
}

/** A chat started posting this draft itself within the last two minutes: a Send now would post it twice. */
const CHAT_SENDING_MS = 120_000;
function chatIsSending(id: string): boolean {
  const since = outboxWatch.sendingSince(id);
  return since !== undefined && Date.now() - since < CHAT_SENDING_MS;
}

/**
 * The email adapter drafts send through: the built-in Gmail sender once an account
 * is connected (email_via auto or gmail), else the email CLI from the `email_cli`
 * setting or the default script; null when email is off. See chooseEmailRoute.
 */
function emailAdapter(): EmailAdapter | null {
  let setting = '';
  let via = 'auto';
  let accounts: GoogleAccount[] = [];
  try {
    const db = openDb();
    try {
      setting = getSetting(db, 'email_cli', { env: false });
      via = getSetting(db, 'email_via');
      accounts = listGoogleAccounts(db);
    } finally {
      db.close();
    }
  } catch {
    /* the default */
  }
  const cli = resolveEmailCli(setting);
  const route = chooseEmailRoute({ via, gmailAccounts: accounts.length, cli });
  if (route === 'cli') return cliAdapter(cliRunner(cli));
  if (route === 'gmail') {
    return gmailAdapter({
      accounts: () => accounts,
      token: (email, force) => googleAccessToken(email, { force, onReconnect: markReconnectSafe }),
    });
  }
  return null;
}

/** A refused Google refresh: flag the account so the header goes amber and Settings asks for a reconnect. */
function markReconnectSafe(email: string, reason: string): void {
  try {
    const db = openDb();
    try {
      markGoogleReconnect(db, email, reason || 'refresh_failed');
    } finally {
      db.close();
    }
  } catch {
    /* the send still reports the failure */
  }
}

let slackMeCache: { at: number; id: string } | null = null;
/** The person's Slack user id, cached ten minutes (one auth.test). */
async function slackMe(): Promise<string> {
  if (slackMeCache && Date.now() - slackMeCache.at < 600_000) return slackMeCache.id;
  const id = (await authTest()).identity.user_id;
  if (id) slackMeCache = { at: Date.now(), id };
  return id;
}

/** The freshness check's reads, all read-only: Slack replies / history, the email thread, the PR's reviews and comments. */
function freshDeps(): FreshDeps {
  return {
    slackMe,
    slackReplies: (channel, ts) => conversationsReplies(channel, ts, { limit: 200 }),
    slackHistory: (channel, oldest) => conversationsHistory(channel, { oldest, limit: 100, maxPages: 1 }),
    slackNames,
    email: emailAdapter(),
    ghMe: ghMeVia(ghRun),
    ghActivity: ghActivityVia(ghRun),
  };
}

/** The Send path's options: a top-level post claims its thread, an interrupted send is checked in Slack first, every send is freshness-checked. */
function sendOpts(dry: boolean, ackStale = false, ackFresh: boolean | string[] = false) {
  const email = dry ? null : emailAdapter();
  return {
    dry,
    ackStale,
    ackFresh,
    ...(dry ? {} : { fresh: freshDeps() }),
    email,
    emailOff: EMAIL_OFF_DETAIL,
    onStarted: claimStartedThread,
    checkPosted: async (x: string) => (await reconcileLive({}, [x])).includes(x),
  };
}

let seenBusy = false;
/** Record `seen` on drafts added since the last pass (the chat did not pass one): what each target held at add time. */
async function fillSeenTick(): Promise<void> {
  if (seenBusy) return;
  const fresh = Object.values(readOutbox()).filter((d) => d.status === 'pending' && !d.seen_tried && Date.now() - (Date.parse(d.created_at) || 0) < 30 * 60_000);
  if (!fresh.length) return;
  seenBusy = true;
  try {
    const deps = freshDeps();
    // Slack is only read in direct mode; a draft for Slack in another mode falls back to created_at.
    if (!slackFeatureOn('send')) Object.assign(deps, { slackReplies: undefined, slackHistory: undefined });
    for (const d of fresh) {
      if (d.seen) {
        setSeen(d.id, null);
        continue;
      }
      try {
        setSeen(d.id, await currentSeen(d, deps));
      } catch {
        setSeen(d.id, null);
      }
    }
  } finally {
    seenBusy = false;
  }
}

/** Pending drafts, each carrying send_state ('sending' | 'failed') and send_note while a chat is posting it. */
function pendingDrafts(): ReturnType<typeof pendingDraftsRaw> {
  const liveSessions = new Set(Object.values(snapshot().live).map((l) => l.session_id));
  const mailOff = (() => {
    let off: boolean | null = null;
    return () => (off ??= !emailAdapter());
  })();
  return pendingDraftsRaw(undefined, undefined, { liveSessions, marks: readStaleMarks() }).map((d) => {
    const s = outboxWatch.stateOf(d.id);
    const x = d.email && mailOff() ? { ...d, email_off: EMAIL_OFF_DETAIL } : d;
    return s ? { ...x, send_state: s.state, send_note: s.note ?? '' } : x;
  });
}

/** Names Slack ids resolve to for a parked chat's "waiting on": users, plus a DM channel's other party. */
function slackNames(): Record<string, string> {
  const dir = getDirectory();
  const out: Record<string, string> = { ...dir.users };
  for (const [id, label] of Object.entries(dir.channels)) if (id.startsWith('D')) out[id] = label;
  return out;
}

/** Close a chat's pane the way Save for later does (/save): Ctrl-C twice, so the session ends cleanly. */
function closeChatPane(agent: string, sid: string): { found: boolean; ok: boolean } {
  const info = snapshot().live[agentSessionKey(agent as Agent, sid)];
  if (!info) return { found: false, ok: false };
  return { found: true, ok: closeSession(info.pane_id, agent as Agent).ok };
}

function testLinksForBoard(): ReturnType<typeof allTestLinks> {
  const db = openDb();
  try {
    return allTestLinks(db);
  } catch {
    return {};
  } finally {
    db.close();
  }
}

function slackCountsFor(): Record<string, number> {
  const db = openDb();
  try {
    return slackCounts(readAllThreads(), pendingDrafts(), listParked(db));
  } finally {
    db.close();
  }
}

/** Parked chats for the board, each with the label the sidebar shows. */
function parkedForBoard(): (ParkedRow & { label: string; reply_first_line: string })[] {
  const db = openDb();
  try {
    const now = Date.now();
    const names = slackNames();
    return listParked(db).map((r) => ({
      ...r,
      label: r.state === 'waiting' ? waitingLabel(r, now) : `${r.reply_user || 'Someone'} replied`,
      reply_first_line: r.state === 'replied' ? firstLineOf(r.reply_text, names) : '',
    }));
  } finally {
    db.close();
  }
}

function firstLineOf(text: string, names: Record<string, string>): string {
  const line = text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id) => '@' + (names[id] || 'someone')).replace(/<([^<>|]+)\|([^<>]*)>/g, '$2').replace(/<([^<>]+)>/g, '$1').slice(0, 160);
}

/** Reopen a parked chat in a managed pane (or the next open lane pane) with the reply as its first prompt. */
function resumeParkedChat(r: ParkedRow, focus: boolean): { ok: boolean; detail: string } {
  const agent = r.agent as Agent;
  const { views, live } = snapshot();
  if (live[agentSessionKey(agent, r.session_id)]) return { ok: true, detail: 'already running' };
  const target = resolveLaunchTarget(views, r.session_id, null);
  if (!target.ok) return { ok: false, detail: target.detail };
  let pane = '';
  let managed = false;
  const world = readWorld();
  if (pickStrategy(world) === 'lanes') {
    const t = laneTargets(world)[0];
    pane = t ? nextOpenPane(t.lane, world)?.pane_id ?? '' : '';
    if (!pane) return { ok: false, detail: 'no open pane in any lane' };
  } else {
    const a = acquireManagedPane(target.dir, { ready: (id) => waitForShellReady(id) });
    if (!a.ok) return { ok: false, detail: a.detail };
    pane = a.paneId;
    managed = true;
  }
  const out = launchInPane({
    paneId: pane,
    projectDir: target.dir,
    sessionId: r.session_id,
    sourceAgent: target.sourceAgent,
    selectedAgent: agent,
    fork: false,
    prompt: resumePrompt(r),
    ...(!focus || (managed && currentTerminal() === 'inside') ? { focus: false } : {}),
  });
  return { ok: out.ok, detail: out.detail };
}

export { notifyScript };

let polling = false;
/** One pass over due parked threads: read-only conversations.replies. */
async function parkedTick(): Promise<void> {
  if (polling) return;
  polling = true;
  try {
    const db = openDb();
    try {
      const waiting = listParked(db).filter((r) => r.state === 'waiting');
      if (!waiting.length) return;
      // Reply detection reads Slack: direct mode (and slack_poll_parked) only. Email threads read the email CLI.
      const slackOn = waiting.some((r) => !isEmailRow(r)) && slackFeatureOn('parked', db);
      const mail = waiting.some(isEmailRow) ? emailAdapter() : null;
      if (!slackOn && !mail) return;
      const me = slackOn ? (await authTest()).identity.user_id : '';
      if (slackOn && !me && !mail) return;
      await pollParked(db, {
        me: me || '\u0000none',
        names: slackNames(),
        notify: (title, body, target) => notifyUser({ title, body, target }),
        autoResume: autoResumeParked(db),
        resume: async (r) => resumeParkedChat(r, false),
        replies: async (channel, ts) => {
          if (!slackOn || !me) throw new Error('Slack reply polling is off');
          return conversationsReplies(channel, ts, { limit: 200 });
        },
        ...(mail ? { emailReplies: (account: string, thread: string) => emailRepliesVia(mail, account, thread) } : {}),
      });
    } finally {
      db.close();
    }
  } catch (e) {
    console.error('[loom] parked poll failed:', (e as Error).message);
  } finally {
    polling = false;
  }
}

/** The Slack directory (names, emoji): refreshed from Slack only when the 'directory' feature is on, else the cache as is. */
function getDirectory(): ReturnType<typeof getDirectoryRaw> {
  try {
    if (slackFeatureOn('directory')) return getDirectoryRaw();
  } catch {
    /* the cache */
  }
  return readDirectory();
}

// find-chat (archive search): resolved from the `find_chat_bin` setting at start
// and whenever it changes. null = not installed, and the page hides archive search.
let findChatBin: string | null = null;
function syncFindChat(): void {
  try {
    const db = openDb();
    try {
      findChatBin = findChatFromSettings(db);
    } finally {
      db.close();
    }
  } catch {
    findChatBin = null;
  }
  setFindChatBin(findChatBin);
}
let findChatWatch: (() => void) | null = null;

// The legacy outbox file is still in use on a migrated install until its chats
// write through `loom outbox`: Loom's closes are written back to it meanwhile.
let migratedInstall = false;
function syncSetupOrigin(): void {
  try {
    const db = openDb();
    try {
      migratedInstall = getSetting(db, 'setup_origin') === 'migrated';
    } finally {
      db.close();
    }
  } catch {
    migratedInstall = false;
  }
}
setLegacyWriteBack(() => migratedInstall && !!LEGACY_OUTBOX_PATH && fs.existsSync(LEGACY_OUTBOX_PATH));

/** Whether the Codex option is offered (`codex_visible`: on, off, or auto = ~/.codex exists). */
/** The Watchers badge: watchers that need attention (an unreviewed Shadow result, or a failed last tick). */
function watchersUnreviewedSafe(): number {
  try {
    const db = openDb();
    try {
      return attentionCount(db);
    } finally {
      db.close();
    }
  } catch {
    return 0;
  }
}

/* ---- Watcher runtime: what the watcher loop and Test read and do (src/watchers/engine.ts) ---- */

function withWatcherDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The connected Slack user's id (slack_identity, from the last connection test), or ''. */
function slackSelfId(): string {
  try {
    return withWatcherDb((db) => {
      const raw = (db.prepare(`SELECT value FROM settings WHERE key = 'slack_identity'`).get() as { value: string } | undefined)?.value;
      const id = raw ? JSON.parse(raw) : {};
      return typeof id?.user_id === 'string' ? id.user_id : '';
    });
  } catch {
    return '';
  }
}

/** Cached PR pipelines with the chat that links each (the prs source). No gh call. */
function watcherPrs(): PrState[] {
  const { views } = snapshot();
  const owner = new Map<string, { agent: Agent; session_id: string }>();
  for (const v of views) {
    const ref = parsePrRef(v.pr_url);
    if (ref && !owner.has(pipelineKey(ref.repo, ref.number))) owner.set(pipelineKey(ref.repo, ref.number), { agent: v.agent, session_id: v.session_id });
  }
  return Object.entries(allPipelines()).map(([k, p]) => prStateFrom(p, owner.get(k) ?? null));
}

function watcherEngineDeps(): EngineDeps {
  return {
    now: () => Date.now(),
    history: (channel, oldest) => channelHistory(channel, oldest),
    slackOn: () => slackFeatureOn('watchers'),
    slackSelf: slackSelfId,
    threadOwner: (key) =>
      withWatcherDb((db) => {
        const o = getOwner(db, key);
        return o?.session_id ? { agent: o.agent, session_id: o.session_id } : null;
      }),
    chats: (needs) => {
      const { views, live } = snapshot();
      return computeSignals(views, live, Date.now(), needs);
    },
    prs: watcherPrs,
    world: () => readWorld(),
    launch: (paneId, command) => tmuxLaunch(paneId, command),
    acquireManaged: (dir) => acquireManagedPane(dir, { ready: (id) => waitForShellReady(id) }),
    launchSettings: () => currentLaunchSettings(),
    relay: (label, agent, sid, text, opts) => withWatcherDb((db) => relayFromWatcher(db, relayDeps(() => snapshot()), label, agent, sid, text, opts)),
    notify: (title, body, target) => {
      notifyUser({ title, body, target });
      return true;
    },
    // Into the orchestrator's own chat, the same focus-aware way a relay goes.
    tellOrch: (_key, text, label) =>
      withWatcherDb((db) => {
        if (!orchSettings.enabled(db)) return false;
        const sid = orchSettings.sessionId(db);
        if (!sid) return false;
        return relayFromWatcher(db, relayDeps(() => snapshot()), label, 'claude', sid, text).status !== 'failed';
      }),
    dryRun: isDryRun(),
    briefsDir: WATCHER_BRIEFS_DIR,
    selfPane: process.env.TMUX_PANE,
  };
}

function watcherTestDeps(): TestDeps {
  return {
    recent: (channel) => conversationsHistory(channel, { limit: 200, maxPages: 1 }),
    slackOn: () => slackFeatureOn('watchers'),
    slackSelf: slackSelfId,
    chats: () => {
      const { views, live } = snapshot();
      return computeSignals(views, live, Date.now(), { context: true, pendingTool: true });
    },
    prs: watcherPrs,
    now: () => Date.now(),
  };
}

configureWatcherRuntime({ engine: watcherEngineDeps, test: watcherTestDeps });

function codexVisibleSafe(): boolean {
  try {
    const db = openDb();
    try {
      return codexVisible(db);
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

/** The effective Slack mode for the header chip; 'off' if it cannot be read. */
function slackModeSafe(): string {
  try {
    return slackMode();
  } catch {
    return 'off';
  }
}

function provisionalForLive(views: ChatView[], live: Record<string, LiveLoc>): ChatView[] {
  if (views.length && Object.keys(live).every((k) => views.some((v) => agentSessionKey(v.agent, v.session_id) === k))) return [];
  try {
    const db = openDb();
    try {
      const orchSid = orchSettings.sessionId(db);
      return provisionalViews(views, live, spawnTitles(db), Date.now(), { exclude: (l) => isOrchestratorRef(l, orchSid, { run: tmux }) });
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

function snapshot(): Snap {
  const now = Date.now();
  if (snapMemo && !process.env.VITEST && now - snapMemo.at < SNAP_TTL_MS) return snapMemo.snap;
  const snap = buildSnapshot();
  snapMemo = { at: Date.now(), snap };
  return snap;
}

function buildSnapshot(): Snap {
  const db = openDb();
  // The orchestrator is pinned above the list with a view of its own, so it is
  // never a row on the board (nor a chat in its own list_chats).
  const orchSid = orchSettings.sessionId(db);
  // Hidden, not deleted: a row the indexer already wrote stays in the DB.
  const views = toChatViews(db).filter((v) => !isOrchestratorRef(v, orchSid));
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
      if (mt > v.last_active_at) {
        v.last_active_at = mt;
        // The file moved since the index pass: the last TURN may have too, and
        // that is what the board orders by. Read it off the tail, once per
        // mtime; a tail with no turn in it keeps the indexed value.
        v.last_turn_at = Math.max(v.last_turn_at, tailTurnAt(v.jsonl_path, mt));
      }
    } catch {
      /* file gone */
    }
  }
  const liveMap = liveSessions({ titleToSession: titleToSession(views) });
  const names = liveMap.size ? paneNameMap() : new Map<string, string>();
  // The pane classifier's @stage, trusted only for the session it labelled.
  const stages = liveMap.size ? new Map(realTopicDeps.readPanes().map((r) => [r.pane_id, r] as const)) : new Map();
  const live: Record<string, LiveLoc> = {};
  for (const [key, info] of liveMap) {
    const mt = mtime.get(key) ?? 0;
    const name = names.get(info.pane_id);
    /* The pane is the authority; mtime is the cheap corroborator. Either one
       saying yes is enough, because they fail in opposite directions: mtime
       misses a long tool call, and the pane hint misses the instant between a
       tool returning and the next one starting. */
    const working = paneIsMidTurn(info.pane_id) || now - mt < WORKING_MS;
    const ps = stages.get(info.pane_id);
    const stage = ps && ps.sid === info.session_id && ps.stage ? ps.stage : '';
    live[key] = { ...info, working, ...(name ? { name } : {}), ...(stage ? { stage } : {}) };
  }
  try {
    const named = Object.values(live).filter((l) => l.name);
    if (named.length) {
      const wdb = openDb();
      try {
        rememberPaneNames(wdb, named);
      } finally {
        wdb.close();
      }
    }
  } catch {
    /* best effort: search just falls back to the live name */
  }
  for (const v of views) {
    const n = live[agentSessionKey(v.agent, v.session_id)]?.name;
    if (n) v.pane_name = n;
  }
  if (process.env.LOOM_DEBUG) {
    const panes = listTmuxPanes();
    console.error(`[loom-debug] views=${views.length} panes=${panes.length} live=${Object.keys(live).length}`);
  }
  return { defaultAgent, views, live };
}

// The sidebar polls this every 5 s; 3 tmux calls each. Two seconds of reuse (never under vitest).
let termMemo: { at: number; v: ReturnType<typeof listTerminals> } | null = null;
function listTerminalsCached(): ReturnType<typeof listTerminals> {
  if (termMemo && !process.env.VITEST && Date.now() - termMemo.at < 2000) return termMemo.v;
  const v = listTerminals();
  termMemo = { at: Date.now(), v };
  return v;
}

function send(res: http.ServerResponse, code: number, type: string, body: string) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

// `trusted`: Claude Code has accepted this folder (~/.claude.json); the composer offers to trust one that is not.
function projectList(includeHidden = false): (ReturnType<typeof listProjects>[number] & { trusted: boolean })[] {
  try {
    const db = openDb();
    try {
      const trusted = trustedFolders();
      return listProjects(db, { includeHidden }).map((p) => ({ ...p, trusted: trusted.has(p.path) }));
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

/** Remember where a chat was last started: the Slack auto-start's fallback project. */
function rememberProject(dir: string): void {
  try {
    const db = openDb();
    try {
      setLastProject(db, dir);
    } finally {
      db.close();
    }
  } catch {
    /* bookkeeping only */
  }
}

/** Read a small JSON object body; a bad body is a 400, so the callback always gets an object. */
function readBody(req: http.IncomingMessage, res: http.ServerResponse, then: (body: Record<string, unknown>) => void): void {
  let raw = '';
  req.on('data', (chunk: Buffer) => {
    if (raw.length < 256 * 1024) raw += chunk;
  });
  req.on('end', () => {
    let b: unknown;
    try {
      b = JSON.parse(raw || '{}');
    } catch {
      return json(res, 400, { ok: false, detail: 'invalid body' });
    }
    then(b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {});
  });
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

// The terminal's browser-side libraries (xterm.js), served from node_modules in
// a checkout and from dist/vendor in the app bundle (app/build.mjs copies them).
const VENDOR: Record<string, { spec: string; type: string }> = {
  'xterm.js': { spec: '@xterm/xterm/lib/xterm.js', type: 'text/javascript; charset=utf-8' },
  'xterm.css': { spec: '@xterm/xterm/css/xterm.css', type: 'text/css; charset=utf-8' },
  'addon-fit.js': { spec: '@xterm/addon-fit/lib/addon-fit.js', type: 'text/javascript; charset=utf-8' },
  'addon-webgl.js': { spec: '@xterm/addon-webgl/lib/addon-webgl.js', type: 'text/javascript; charset=utf-8' },
  'addon-web-links.js': { spec: '@xterm/addon-web-links/lib/addon-web-links.js', type: 'text/javascript; charset=utf-8' },
};
const vendorCache = new Map<string, Buffer>();
const vendorRequire = typeof require === 'function' ? require : createRequire(import.meta.url.startsWith('file:') ? import.meta.url : path.join(process.cwd(), 'x.js'));

function vendorFile(name: string): { body: Buffer; type: string } | null {
  const v = Object.hasOwn(VENDOR, name) ? VENDOR[name] : undefined;
  if (!v) return null;
  let body = vendorCache.get(name);
  if (!body) {
    const candidates: string[] = [];
    if (typeof __dirname === 'string') candidates.push(path.join(__dirname, 'vendor', name));
    try {
      candidates.push(vendorRequire.resolve(v.spec));
    } catch {
      /* not installed here */
    }
    for (const c of candidates) {
      try {
        body = fs.readFileSync(c);
        break;
      } catch {
        /* next */
      }
    }
    if (!body) return null;
    vendorCache.set(name, body);
  }
  return { body, type: v.type };
}

function tagList() {
  const db = openDb();
  try {
    return listTags(db);
  } finally {
    db.close();
  }
}

// The page's fetch wrapper (src/clientfetch.ts) as its own script, ahead of the
// dashboard's: every same-origin call then carries the launch token.
const CLIENT_FETCH_TAG = `<script>${clientFetchJs(legacyGetPaths())}</script>`;
export function withClientFetch(html: string): string {
  const i = html.indexOf('<script');
  return i < 0 ? CLIENT_FETCH_TAG + html : html.slice(0, i) + CLIENT_FETCH_TAG + html.slice(i);
}

/**
 * Headers for a write from inside Loom's own process (the Electron main's Slack
 * hotkey): the same Origin + launch token the page sends.
 */
export function loomWriteHeaders(port: number = serverPort()): Record<string, string> {
  return { origin: `http://127.0.0.1:${port}`, 'x-loom-token': termToken() };
}

export function createServer(): http.Server {
  try {
    const db = openDb();
    try {
      seedProjects(db);
    } finally {
      db.close();
    }
  } catch (e) {
    console.error('[loom] project seed failed:', (e as Error).message);
  }
  try {
    ensureCliToken();
  } catch (e) {
    console.error('[loom] cli token failed:', (e as Error).message);
  }
  syncFindChat();
  syncSetupOrigin();
  findChatWatch ??= onSettingChanged((c) => {
    if (c.key === 'find_chat_bin') syncFindChat();
    if (c.key === 'setup_origin') syncSetupOrigin();
  });
  setCliDeps({
    chats: () => snapshot().views.filter((v) => v.agent === 'claude').map((v) => ({ session_id: v.session_id, title: v.title, jsonl_path: v.jsonl_path, project_dir: v.project_dir })),
    live: () => Object.values(snapshot().live).map((l) => ({ session_id: l.session_id, pane_id: l.pane_id, cwd: l.cwd })),
    legacyThreads: legacyThreadState,
  });
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    // The write guard (src/routes/index.ts, §13): Loom's own Host on every
    // request, and every row of the route table passes requireWrite(kind)
    // before any handler below runs. Module routes are dispatched from the table.
    const g = gate(req, url);
    if (!g.ok) {
      req.resume(); // drain an unread body so a kept-alive socket stays usable
      return json(res, g.status, { ok: false, detail: g.detail });
    }
    if (g.route?.handler) return runRoute(g.route, req, res, url);
    // /api/cli/outbox/<id> and any unknown /api/cli/ path: cli-guarded (src/routes/cli.ts).
    if (handleCliPath(req, res, url, (r) => requireWrite(r, 'cli'))) return;

    // The orchestrator: its view, the MCP tool endpoint, and the UI's sends.
    if (handleOrchRoute(req, res, url, snapshot)) return;

    if (url.pathname === '/goto') {
      const sid = url.searchParams.get('session') || '';
      const agent = requestAgent(url);
      const { live } = snapshot();
      const info = live[agentSessionKey(agent, sid)];
      if (!info) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'no live pane' }));
      const r = gotoPane(info.pane_id, info.tmux_session);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    // Who is on this port: another Loom (any user's) asks before it picks its own.
    // Uid and a hash of the data folder only; no path, no token.
    if (url.pathname === '/api/whoami') {
      return send(res, 200, 'application/json', JSON.stringify(localIdentity(TOOL_DIR)));
    }

    // The watchdog's ping (src/watchdog.ts). Answered straight from the event
    // loop with no tmux, DB or disk: if this is slow, the main thread is blocked.
    if (url.pathname === '/api/health') {
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, pid: process.pid, at: Date.now() }));
    }

    if (url.pathname === '/api/live') {
      const { live } = snapshot();
      return send(res, 200, 'application/json', JSON.stringify(live));
    }

    if (url.pathname === '/api/data') {
      const { defaultAgent, views, live } = snapshot();
      let launches = recentLaunches();
      if (launches.length) {
        confirmLaunches(live);
        const have = new Set(views.map((v) => agentSessionKey(v.agent, v.session_id)));
        indexFreshLaunches(launches, live, (agent, sid) => have.has(`${agent}:${sid}`));
      }
      launches = launches.map(launchView) as typeof launches;
      const { pipes, chatPr } = boardPipes(views, live);
      // A live session with no chat row yet shows as a provisional row until the live indexer lands it.
      const chats = [...views, ...provisionalForLive(views, live)];
      return send(res, 200, 'application/json', JSON.stringify({ generatedAt: Date.now(), defaultAgent, slackMode: slackModeSafe(), connections: connectionsSafe(), archiveSearch: findChatBin !== null, port: { actual: serverPort(), base: preferredPort() }, codexVisible: codexVisibleSafe(), chats, live, slackOwners: threadOwners(), slackCounts: slackCountsFor(), testLinks: testLinksForBoard(), slackStarts: recentStarts(), drafts: pendingDrafts(), parked: parkedForBoard(), launches, pipes, chatPr, ships: shipBoards(), projects: projectList(), orch: orchSummary(live), watchersUnreviewed: watchersUnreviewedSafe(), tags: tagList(), terminal: { kind: currentTerminal(), label: terminalLabel(currentTerminal()) }, focus: insideFocusState() }));
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
        .then((d) => {
          if (d.pipelineRef && !v.pr_url) branchPrs.set(agentSessionKey(agent, sid), `https://github.com/${d.pipelineRef.repo}/pull/${d.pipelineRef.number}`);
          json(res, 200, { ...d, ship: shipDetail(agentSessionKey(agent, sid)) });
        })
        .catch((e) => json(res, 200, { ok: false, detail: (e as Error).message }));
      return;
    }

    // ---- Projects: where New thread can start a chat ----
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      if (!isLoomHost(req.headers.host, serverPort())) return json(res, 403, { ok: false, detail: 'bad host' });
      return json(res, 200, { ok: true, projects: projectList(url.searchParams.get('all') === '1') });
    }
    if (url.pathname.startsWith('/api/projects/') || (url.pathname === '/api/projects' && req.method === 'POST')) {
      if (req.method !== 'POST') return json(res, 405, { ok: false, detail: 'POST only' });
      return readBody(req, res, (b) => {
        const db = openDb();
        try {
          if (url.pathname === '/api/projects') {
            const r = addProject(db, typeof b.path === 'string' ? b.path : '');
            return json(res, r.ok ? 200 : 400, r);
          }
          const id = Number(b.id);
          if (!Number.isInteger(id)) return json(res, 400, { ok: false, detail: 'id is required' });
          if (url.pathname === '/api/projects/update') {
            const p = updateProject(db, id, { name: b.name as string | undefined, color: b.color as string | undefined, hidden: typeof b.hidden === 'boolean' ? b.hidden : undefined });
            return p ? json(res, 200, { ok: true, project: p }) : json(res, 404, { ok: false, detail: 'no such project' });
          }
          if (url.pathname === '/api/projects/remove') return removeProject(db, id) ? json(res, 200, { ok: true }) : json(res, 404, { ok: false, detail: 'no such project' });
          return json(res, 404, { ok: false, detail: 'not found' });
        } finally {
          db.close();
        }
      });
    }

    // ---- Ship modal: staged work by chat, diffs, labels, attribution, the Ship launch ----
    // Reads need Loom's own Host (source code in the response); every write also
    // needs Loom's Origin and the launch token, like the terminal toolbar.
    if (url.pathname === '/api/ship/detail' || url.pathname === '/api/ship/diff') {
      if (!isLoomHost(req.headers.host, serverPort())) return json(res, 403, { ok: false, detail: 'bad host' });
      const repo = url.searchParams.get('repo') || '';
      if (!isShipRepo(repo)) return json(res, 404, { ok: false, detail: 'unknown repo' });
      if (url.pathname === '/api/ship/detail') {
        const { views, live } = snapshot();
        gatherShipDetail(repo, { views, live })
          .then((detail) => json(res, 200, { ok: true, detail }))
          .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }));
        return;
      }
      const file = url.searchParams.get('path') || '';
      if (!safeRepoPath(file)) return json(res, 400, { ok: false, detail: 'bad path' });
      shipFileDiff(repo, file, url.searchParams.get('which') === 'unstaged' ? 'unstaged' : 'staged')
        .then((r) => json(res, 200, { ok: true, ...r }))
        .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }));
      return;
    }
    if ((url.pathname === '/api/ship/label' || url.pathname === '/api/ship/assign' || url.pathname === '/api/ship/start') && req.method === 'POST') {
      return readBody(req, res, (b) => {
        const repo = typeof b.repo === 'string' ? b.repo : '';
        if (!isShipRepo(repo)) return json(res, 404, { ok: false, detail: 'unknown repo' });
        if (url.pathname === '/api/ship/label') {
          const sid = typeof b.session_id === 'string' ? b.session_id : '';
          if (!/^[A-Za-z0-9._-]{1,80}$/.test(sid) || typeof b.label !== 'string') return json(res, 400, { ok: false, detail: 'session_id and label are required' });
          const db = openDb();
          try {
            setShipLabel(db, sid, repo, b.label.slice(0, MAX_LABEL));
          } finally {
            db.close();
          }
          return json(res, 200, { ok: true });
        }
        if (url.pathname === '/api/ship/assign') {
          const file = typeof b.path === 'string' ? b.path : '';
          const key = typeof b.key === 'string' ? b.key : '';
          if (!safeRepoPath(file)) return json(res, 400, { ok: false, detail: 'bad path' });
          const { views } = snapshot();
          if (key && !views.some((v) => `${v.agent}:${v.session_id}` === key)) return json(res, 404, { ok: false, detail: 'unknown chat' });
          const db = openDb();
          try {
            setOverride(db, repo, file, key);
          } finally {
            db.close();
          }
          return json(res, 200, { ok: true });
        }
        const { views, live } = snapshot();
        gatherShipDetail(repo, { views, live })
          .then((detail) => {
            const r = startShipSession(detail, { start: startThread });
            return json(res, r.ok ? 200 : r.status, r.ok ? { ok: true, pane_id: r.paneId, where: r.where, prompt: r.prompt } : { ok: false, detail: r.detail });
          })
          .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }));
      });
    }

    // Ship groups: the next ship on each shared main checkout, the one in flight, and recent ship/ PRs.
    if (url.pathname === '/api/ships') {
      return json(res, 200, { ok: true, boards: shipBoards() satisfies ShipBoard[] });
    }

    // Open an owned Slack thread in the Slack app (https permalink as fallback).
    // By key, validated against the thread state, so this cannot open arbitrary URLs.
    if (url.pathname === '/api/slack/open' && req.method === 'POST') {
      openThread(url.searchParams.get('key') || '', undefined, undefined, url.searchParams.get('url') || '')
        .then((r) => json(res, r.ok ? 200 : 404, r))
        .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }));
      return;
    }

    // "Open the chat for this Slack thread" (the app's global hotkey posts the
    // clipboard here). Body {url, pane?, text?, author?}: the owning chat is jumped
    // to if live, otherwise resumed into `pane` or an open lane pane. A thread no
    // chat owns starts one, with the link and `text` as its first prompt (the
    // channel's mapped project, else the last project used). mode 'ask' starts
    // nothing: an unowned thread answers action 'ask' (the hotkey's confirm
    // prompt), and the follow-up post with mode 'start' and optional `context`
    // starts it. 200 on a jump, resume, ask or start; 404 for a non-Slack link.
    if (url.pathname === '/api/slack/thread-goto' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        if (raw.length < 64 * 1024) raw += chunk;
      });
      req.on('end', () => {
        let b: { url?: unknown; pane?: unknown; text?: unknown; author?: unknown; mode?: unknown; context?: unknown };
        try {
          b = JSON.parse(raw || '{}') ?? {};
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        const pane = typeof b.pane === 'string' && /^%\d+$/.test(b.pane) ? b.pane : undefined;
        // An explicit pane is typed into, so it must be a free shell, never a running agent.
        if (pane && !readWorld().panes.some((p) => p.pane_id === pane && !p.agent && /^(zsh|bash|fish|sh)$/.test(p.command))) {
          return json(res, 409, { ok: false, detail: `pane ${pane} is not an idle shell` });
        }
        const snap = snapshot();
        const dirs = new Map(snap.views.filter((v) => v.agent === 'claude').map((v) => [v.session_id, v.project_dir]));
        const picked = { text: typeof b.text === 'string' ? b.text.slice(0, 8000) : undefined, author: typeof b.author === 'string' ? b.author.slice(0, 200) : undefined };
        const mode = b.mode === 'ask' || b.mode === 'start' ? b.mode : undefined;
        const context = typeof b.context === 'string' ? b.context.slice(0, 4000) : undefined;
        threadGoto(typeof b.url === 'string' ? b.url : '', defaultGotoDeps(() => snap.live, (sid) => dirs.get(sid) ?? null), { pane, picked, mode, context })
          .then((r) => json(res, r.ok ? 200 : r.reason === 'no_owner' || r.reason === 'not_slack' ? 404 : 409, r))
          .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }));
      });
      return;
    }

    // Which project a Slack channel's threads start their chat in (channel id ->
    // dir). GET lists the map; PUT/POST {channel, project} sets one, and a null or
    // empty project removes it.
    if (url.pathname === '/api/slack/channel-projects') {
      if (req.method === 'GET') {
        const db = openDb();
        try {
          return json(res, 200, { ok: true, projects: getChannelProjects(db) });
        } finally {
          db.close();
        }
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        return readBody(req, res, (b) => {
          const channel = typeof b.channel === 'string' ? b.channel : '';
          const project = typeof b.project === 'string' ? b.project.trim() : '';
          if (!/^[A-Z0-9]+$/.test(channel)) return json(res, 400, { ok: false, detail: 'channel must be a Slack channel id' });
          if (project && !isValidProjectDir(project)) return json(res, 400, { ok: false, detail: 'project is not a directory' });
          const db = openDb();
          try {
            return json(res, 200, { ok: true, projects: setChannelProject(db, channel, project || null) });
          } finally {
            db.close();
          }
        });
      }
    }

    // The "Started a chat for this Slack thread" banner: dismiss it, or restart the
    // chat in another project (which also maps the channel to that project).
    if ((url.pathname === '/api/slack/start/dismiss' || url.pathname === '/api/slack/start/project') && req.method === 'POST') {
      return readBody(req, res, (b) => {
        const key = typeof b.key === 'string' ? b.key : '';
        const at = Number(b.at);
        const s = recentStarts().find((x) => x.key === key && x.at === at);
        if (!s) return json(res, 404, { ok: false, detail: 'unknown start' });
        if (url.pathname === '/api/slack/start/dismiss') {
          dismissStart(key, at);
          return json(res, 200, { ok: true });
        }
        const project = typeof b.project === 'string' ? b.project.trim() : '';
        if (!project || !isValidProjectDir(project)) return json(res, 400, { ok: false, detail: 'project is not a directory' });
        const ref = parseSlackThread(s.url);
        if (!ref) return json(res, 400, { ok: false, detail: 'bad thread url' });
        const snap = snapshot();
        // Stop the chat in the wrong project first, but only if it is still the one we started.
        const old = Object.values(snap.live).find((l) => l.pane_id === s.pane_id && (!s.session_id || l.session_id === s.session_id));
        if (old) closeSession(old.pane_id, s.agent);
        const db = openDb();
        try {
          setChannelProject(db, s.channel, project);
        } finally {
          db.close();
        }
        const deps = defaultGotoDeps(() => snap.live, () => null);
        void Promise.resolve(deps.start!(ref, { text: s.quote, author: s.author }, { projectDir: project }))
          .then((r) => {
            if (!r.ok) return json(res, 409, r);
            replaceStart(key, at, r.started);
            json(res, 200, { ok: true, started: r.started });
          })
          .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }));
      });
    }

    // ---- Watchers: on/off and a jump to a started chat's pane. The rest of the
    // watcher API (list, templates, create, edit, test, review) is src/routes/watchers.ts.
    if (url.pathname === '/api/watchers/toggle' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let body: { id?: unknown; enabled?: unknown };
        try {
          body = JSON.parse(raw) ?? {};
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        if (typeof body.id !== 'string' || typeof body.enabled !== 'boolean') return json(res, 400, { ok: false, detail: 'id and enabled are required' });
        const db = openDb();
        try {
          const w = getWatcher(db, body.id);
          if (!w) return json(res, 404, { ok: false, detail: 'unknown watcher' });
          if (body.enabled) {
            const v = validateDraft({ ...w, enabled: true }, { forEnable: true });
            if (!v.ok) return json(res, 400, { ok: false, detail: v.detail });
          }
          setWatcherEnabled(db, body.id, body.enabled);
          return json(res, 200, { ok: true, enabled: body.enabled });
        } finally {
          db.close();
        }
      });
      return;
    }

    // By event id, so the pane comes from the log rather than the query string.
    if (url.pathname === '/api/watchers/goto' && req.method === 'POST') {
      const db = openDb();
      const sp = getEvent(db, Number(url.searchParams.get('id')));
      db.close();
      if (!sp || !sp.pane_id) return json(res, 404, { ok: false, detail: 'no pane recorded' });
      const pane = readWorld().panes.find((p) => p.pane_id === sp.pane_id);
      if (!pane) return json(res, 404, { ok: false, detail: 'pane is gone' });
      return json(res, 200, gotoPane(pane.pane_id, pane.tmux_session));
    }

    // Slack drafts awaiting Will's okay. Send posts AS WILL, so it only ever
    // fires from the confirm click, and posts exactly the messages in the body
    // (which the confirm displayed). LOOM_SLACK_DRYRUN=1 or `dry: true` renders
    // with the CLI's preview instead and leaves the draft pending.
    if ((url.pathname === '/api/outbox/send' || url.pathname === '/api/outbox/discard') && req.method === 'POST') {
      // Posting is posting as Will: same Host + Origin + token gate as the terminal and ship writes.
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let body: { id?: unknown; messages?: unknown; dry?: unknown; park?: unknown; after?: unknown; ack_stale?: unknown; ack_fresh?: unknown };
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
        const dryAsked = body.dry === true || process.env.LOOM_SLACK_DRYRUN === '1';
        // Posting needs the Web API (direct mode). A dry run touches nothing, so it is always allowed.
        // A review-only draft with no reactions never touches Slack, so it does not need it.
        const pending = readOutbox()[id];
        const slackFree = (!!pending?.review || !!pending?.email) && !pending.messages?.length && !pending.reactions?.length;
        if (!dryAsked && !slackFree && !slackFeatureOn('send')) return json(res, 409, { ok: false, error: SLACK_OFF, detail: slackOffDetail() });
        // The chat is posting this draft itself right now: a second post would duplicate it.
        if (!dryAsked && chatIsSending(id)) return json(res, 409, { ok: false, detail: 'the chat is posting this draft now' });
        const messages = Array.isArray(body.messages) && body.messages.every((m) => typeof m === 'string') ? (body.messages as string[]) : null;
        if (!messages) return json(res, 400, { ok: false, detail: 'messages must be an array of strings' });
        if (body.after !== undefined && body.after !== 'none' && body.after !== 'park' && body.after !== 'close') {
          return json(res, 400, { ok: false, detail: "after must be 'none', 'park' or 'close'" });
        }
        // `park: true` is the old spelling of after: 'park'.
        const after: AfterSend = (body.after as AfterSend | undefined) ?? (body.park === true ? 'park' : 'none');
        const dry = body.dry === true || process.env.LOOM_SLACK_DRYRUN === '1';
        const ackStale = body.ack_stale === true;
        // ack_fresh: true (sent anyway past any warning) or the ids of the new messages the card showed.
        const ackFresh: boolean | string[] = body.ack_fresh === true ? true : Array.isArray(body.ack_fresh) && body.ack_fresh.every((x) => typeof x === 'string') ? (body.ack_fresh as string[]).slice(0, 500) : false;
        // A send that was refused for freshness refreshes the card's passive check too.
        const done = <T extends { ok: boolean; stale_thread?: unknown; fresh_error?: unknown }>(r: T): T => {
          if (!r.ok && (r.stale_thread || r.fresh_error)) clearFreshCache(id);
          return r;
        };
        if (after !== 'none' && !dry) {
          const db = openDb();
          sendThen(db, after, id, messages, {
            readDraft: (x) => readOutbox()[x],
            send: (x, m) => sendDraft(x, m, sendOpts(false, ackStale, ackFresh)).then(done),
            closePane: closeChatPane,
            names: slackNames(),
          })
            .then((r) => json(res, r.ok ? 200 : 409, r))
            .finally(() => db.close());
          return;
        }
        sendDraft(id, messages, sendOpts(dry, ackStale, ackFresh)).then(done).then((r) => json(res, r.ok ? 200 : 409, r));
      });
      return;
    }

    // Cut a burst's current typing gap short. Body {id}. Posts nothing itself: the running send does.
    if (url.pathname === '/api/outbox/send-now' && req.method === 'POST') {
      return readBody(req, res, (b) => {
        const id = typeof b.id === 'string' ? b.id : '';
        if (!id) return json(res, 400, { ok: false, detail: 'id is required' });
        const ok = sendNow(id);
        return json(res, ok ? 200 : 409, { ok, detail: ok ? 'sending the next message now' : 'no message is waiting to send' });
      });
    }

    // Restore to board: undo a Send & close. Body {session, agent}.
    if (url.pathname === '/api/restore' && req.method === 'POST') {
      return readBody(req, res, (b) => {
        const sid = typeof b.session === 'string' ? b.session : '';
        const agent = typeof b.agent === 'string' ? b.agent : 'claude';
        const db = openDb();
        try {
          if (!restoreChat(db, agent, sid)) return json(res, 404, { ok: false, detail: 'chat is not closed' });
          return json(res, 200, { ok: true });
        } finally {
          db.close();
        }
      });
    }

    // Parked chats (Send & park). Unpark drops the mark; resume reopens the chat with the reply as its first prompt.
    if ((url.pathname === '/api/parked/unpark' || url.pathname === '/api/parked/resume') && req.method === 'POST') {
      return readBody(req, res, (b) => {
        const sid = typeof b.session === 'string' ? b.session : '';
        const agent = typeof b.agent === 'string' ? b.agent : 'claude';
        const db = openDb();
        try {
          const row = getParked(db, agent, sid);
          if (!row) return json(res, 404, { ok: false, detail: 'chat is not parked' });
          if (url.pathname === '/api/parked/unpark') {
            unparkChat(db, agent, sid);
            return json(res, 200, { ok: true });
          }
          const r = resumeParkedChat(row, true);
          if (r.ok) unparkChat(db, agent, sid);
          return json(res, r.ok ? 200 : 409, r);
        } finally {
          db.close();
        }
      });
    }

    // Fast poll while a card is sending: the pending drafts with their send state, and what just landed.
    if (url.pathname === '/api/outbox/state' && req.method === 'GET') {
      return json(res, 200, { ok: true, drafts: pendingDrafts(), sent: outboxWatch.recentlySent(), sending: sendProgress() });
    }

    // A review draft's PR head, for the card's "new commits since" warning. Cached a minute per PR; read-only.
    if (url.pathname === '/api/outbox/review-head' && req.method === 'GET') {
      const d = readOutbox()[url.searchParams.get('id') ?? ''];
      if (!d?.review) return json(res, 404, { ok: false, detail: 'no such review draft' });
      const r = d.review;
      cachedHead(githubPoster(), r.repo, r.pr).then((h) =>
        json(res, 200, { ok: !h.error, head: h.sha, title: h.title, url: h.url, stale: !!h.sha && !d.review_posted && headMoved(r.commit_id, h.sha), ...(h.error ? { detail: h.error } : {}) }),
      );
      return;
    }

    // The card's passive freshness check: anything new in the draft's thread(s) since it was drafted. Cached a minute per draft; read-only.
    if (url.pathname === '/api/outbox/fresh' && req.method === 'GET') {
      const d = readOutbox()[url.searchParams.get('id') ?? ''];
      if (!d || d.status !== 'pending') return json(res, 404, { ok: false, detail: 'no such draft' });
      const deps = freshDeps();
      if (!slackFeatureOn('send')) Object.assign(deps, { slackMe: undefined });
      cachedFresh(d.id, d, deps).then((r) => json(res, 200, r.ok ? { ok: true, items: r.items } : { ok: false, error: r.error, items: r.items }));
      return;
    }

    // A thumbnail for the card: one image recorded on a draft, by message and file index. Never a path.
    if (url.pathname === '/api/outbox/file' && req.method === 'GET') {
      const q = url.searchParams;
      const img = draftImage(q.get('id') ?? '', Number(q.get('m')), Number(q.get('f')));
      if (!img) return json(res, 404, { ok: false, detail: 'no such image' });
      res.writeHead(200, { 'content-type': img.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      return res.end(img.bytes);
    }

    // What the draft renderer needs to read Slack text like Slack does: names for
    // <@U…> / <#C…>, custom emoji, and the sender (slackdir.ts). Read-only.
    if (url.pathname === '/api/slack/directory') return json(res, 200, { ok: true, ...getDirectory() });
    // Shortcode -> Unicode, static; the page loads it once.
    if (url.pathname === '/api/emoji-map') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'max-age=86400' });
      return res.end(JSON.stringify(EMOJI_MAP));
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

    // The few settings a person changes (src/settings.ts). Writes need a JSON body
    // from Loom's own page, like the orchestrator's.
    // ---- Chat tags. Reads are open; every write needs the Loom-origin guard.
    //   GET  /api/tags
    //   POST /api/tags         {name, color?}            create (colour auto when omitted)
    //   POST /api/tags/update  {name, newName?, color?}  rename / recolour
    //   POST /api/tags/delete  {name}
    //   POST /api/chat-tags    {session, agent, tags[]}  replace a chat's tags
    if (url.pathname === '/api/tags' && req.method === 'GET') return json(res, 200, { ok: true, tags: tagList() });
    if (
      (url.pathname === '/api/tags' || url.pathname === '/api/tags/update' || url.pathname === '/api/tags/delete' || url.pathname === '/api/chat-tags') &&
      req.method === 'POST'
    ) {
      return readBody(req, res, (b) => {
        const db = openDb();
        try {
          let r: { ok: boolean; code?: number; detail?: string } & Record<string, unknown>;
          if (url.pathname === '/api/tags') r = createTag(db, b.name, b.color);
          else if (url.pathname === '/api/tags/update') r = updateTag(db, b.name, { newName: b.newName, color: b.color });
          else if (url.pathname === '/api/tags/delete') r = deleteTag(db, b.name);
          else {
            if (typeof b.session !== 'string' || !isAgent(b.agent)) return json(res, 400, { ok: false, detail: 'session and a valid agent are required' });
            r = setChatTags(db, b.agent, b.session, b.tags);
          }
          const { code, ...body } = r;
          return json(res, r.ok ? 200 : code ?? 400, { ...body, tags_all: listTags(db) });
        } finally {
          db.close();
        }
      });
    }

    // Settings (src/settings.ts, T1). GET is a read; PUT/POST passed the
    // browser write guard in the route table before reaching here.
    if (url.pathname === '/api/settings') {
      if (req.method === 'GET') {
        const db = openDb();
        try {
          const r = settingsGet(db);
          return json(res, r.status, r.body);
        } finally {
          db.close();
        }
      }
      if (req.method === 'PUT' || req.method === 'POST') {
        return readBody(req, res, (b) => {
          const db = openDb();
          try {
            const r = settingsPut(db, b);
            return json(res, r.status, r.body);
          } finally {
            db.close();
          }
        });
      }
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
    // Terminals: tmux windows with no chat in them (src/terminals.ts).
    if (url.pathname === '/api/terminals') {
      if (req.method === 'GET') return json(res, 200, { ok: true, sessions: listTerminalsCached() });
      if (req.method === 'POST') {
        return readBody(req, res, (b) => {
          const r = createTerminalSession(typeof b.name === 'string' ? b.name : '', typeof b.project === 'string' ? b.project : '');
          return json(res, r.ok ? 200 : 400, r);
        });
      }
    }

    // The terminal toolbar. Same Host + Origin + launch-token checks as the
    // WebSocket (the token rides in a header), only views this launch has open,
    // and only the whitelisted verbs.
    if (url.pathname === '/api/term/cmd' && req.method === 'POST') {
      return readBody(req, res, (b) => {
        if (!isTermAction(b.action)) return json(res, 400, { ok: false, detail: 'unknown action' });
        const kind = viewKind(b.view);
        if (!kind) return json(res, 404, { ok: false, detail: 'no such terminal' });
        if (!actionAllowed(kind, b.action)) return json(res, 403, { ok: false, detail: 'not available in a chat view' });
        const r = termCommand(b.view as string, b.action, (a) => tmux(a), undefined, kind);
        return json(res, r.ok ? 200 : 409, r);
      });
    }

    // First-paint snapshot for the terminal pane: the chat's current screen, so
    // the page can show it before the pty attaches. Read-only, one async tmux call.
    if (url.pathname === '/api/term/snap') {
      const auth = checkSnapAuth(req.headers, String(req.headers['x-loom-term-token'] ?? ''), { port: serverPort(), token: termToken() });
      if (!auth.ok) return json(res, auth.status, { ok: false, detail: auth.reason });
      const pane = url.searchParams.get('pane');
      if (!isPaneId(pane)) return json(res, 400, { ok: false, detail: 'bad pane' });
      return void snapshotScreen(pane).then((r) => json(res, r ? 200 : 404, r ? { ok: true, ...r } : { ok: false, detail: 'no such pane' }));
    }

    if (url.pathname === '/api/lanes') {
      const world = readWorld();
      // launch_target=managed: no lane is ever offered, so every picker falls
      // through to a managed window.
      if (pickStrategy(world) === 'managed') return json(res, 200, []);
      if (url.searchParams.get('all') !== '1') return json(res, 200, laneTargets(world));
      // Every lane, room or not: the composer can target a full lane (it splits).
      const open = new Map(laneTargets(world).map((t) => [t.lane, t]));
      const lanes = [...new Set(world.panes.map((p) => parseLane(p.tmux_session)?.lane).filter((l): l is string => !!l))]
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((lane) => ({ lane, open: open.get(lane) ?? null }));
      return json(res, 200, lanes);
    }

    // New thread from the composer. The body carries the prompt and any images
    // (base64), so it is size-capped before parsing.
    if (url.pathname === '/api/new-thread' && req.method === 'POST') {
      let raw = '';
      let size = 0;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size <= 60 * 1024 * 1024) raw += chunk;
      });
      req.on('end', () => {
        if (size > 60 * 1024 * 1024) return json(res, 413, { ok: false, detail: 'too large' });
        let b: Record<string, unknown>;
        try {
          b = JSON.parse(raw) ?? {};
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        const images = Array.isArray(b.images) ? b.images.filter((i: any) => i && typeof i.type === 'string' && typeof i.data === 'string') : [];
        const r = startThread({
          prompt: typeof b.prompt === 'string' ? b.prompt : '',
          projectDir: typeof b.project === 'string' ? b.project : '',
          agent: b.agent === 'codex' ? 'codex' : 'claude',
          lane: typeof b.lane === 'string' ? b.lane : '',
          prefer: typeof b.prefer === 'string' ? b.prefer : '',
          focus: b.focus === true,
          images,
          trust: b.trust === true,
        }, undefined, { liveByPane: () => snapshot().live });
        if (r.ok) rememberProject(typeof b.project === 'string' ? b.project : '');
        return json(res, r.ok ? 200 : 409, r);
      });
      return;
    }

    // A launch that never started: Retry relaunches its prompt (images are already in
    // it as paths) into a different pane; Dismiss drops the red card.
    if ((url.pathname === '/api/new-thread/retry' || url.pathname === '/api/new-thread/dismiss') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => { raw += chunk; });
      req.on('end', () => {
        let id = '';
        try {
          id = String((JSON.parse(raw) as { id?: unknown }).id ?? '');
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        const l = launchById(id);
        if (!l || l.status !== 'failed') return json(res, 404, { ok: false, detail: 'no such failed launch' });
        if (url.pathname.endsWith('/dismiss')) return json(res, 200, { ok: dismissLaunch(id), detail: 'dismissed' });
        const r = startThread({ prompt: l.fullPrompt ?? l.prompt, projectDir: l.projectDir, agent: l.agent, exclude: [l.pane_id] }, undefined, { liveByPane: () => snapshot().live });
        if (r.ok) dismissLaunch(id);
        return json(res, r.ok ? 200 : 409, r);
      });
      return;
    }

    // Bring one pane up by %id: the open-a-chat card's "Show the pane", for a resumed
    // chat that never reached the board. The pane must exist outside a view session.
    if (url.pathname === '/api/panes/goto' && req.method === 'POST') {
      const auth = checkSnapAuth(req.headers, String(req.headers['x-loom-term-token'] ?? ''), { port: serverPort(), token: termToken() });
      if (!auth.ok) return json(res, auth.status, { ok: false, detail: auth.reason });
      const pane = url.searchParams.get('pane');
      if (!isPaneId(pane)) return json(res, 400, { ok: false, detail: 'bad pane' });
      const home = paneHome(pane, (a) => tmux(a));
      if (!home) return json(res, 404, { ok: false, detail: 'the pane is gone' });
      return json(res, 200, gotoPane(pane, home.session));
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
      if (findChatBin === null) return json(res, 200, { ok: false, unavailable: true, detail: 'find-chat not installed' });
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
      // Tab rehoming is Ghostty-only; for any other terminal restore just rebuilds tmux.
      const g = !r.attach.length
        ? { ok: true, opened: 0, reused: 0, detail: 'nothing to restore' }
        : currentTerminal() === 'ghostty'
          ? attachGhosttyTabs(r.attach, { attached: attachedSessions(), saved: r.windows })
          : { ok: true, opened: 0, reused: 0, detail: 'tmux sessions rebuilt; attach to them from your terminal' };
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

    // Rename: a title override that outlives re-indexing and re-summarizing (an
    // empty title clears it). Body {session, agent, title}.
    // Remove from board: hide a chat that is not running; it returns by itself if
    // it becomes active again. Body {session, agent}.
    if ((url.pathname === '/api/rename' || url.pathname === '/api/hide') && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        if (raw.length < 64 * 1024) raw += chunk;
      });
      req.on('end', () => {
        let b: { session?: unknown; agent?: unknown; title?: unknown };
        try {
          b = JSON.parse(raw || '{}') ?? {};
        } catch {
          return json(res, 400, { ok: false, detail: 'invalid body' });
        }
        const sid = typeof b.session === 'string' ? b.session : '';
        if (!sid || !isAgent(b.agent)) return json(res, 400, { ok: false, detail: 'session and a valid agent are required' });
        const agent = b.agent;
        const db = openDb();
        try {
          const known = db.prepare(`SELECT saved FROM chats WHERE agent = ? AND session_id = ?`).get(agent, sid) as { saved: number } | undefined;
          if (!known) return json(res, 404, { ok: false, detail: 'unknown session' });
          if (url.pathname === '/api/rename') {
            const title = typeof b.title === 'string' ? b.title.trim().slice(0, 200) : '';
            if (!title) db.prepare(`DELETE FROM chat_titles WHERE agent = ? AND session_id = ?`).run(agent, sid);
            else db.prepare(`INSERT INTO chat_titles (agent, session_id, title, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent, session_id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`).run(agent, sid, title, Date.now());
            return json(res, 200, { ok: true, title });
          }
          if (snapshot().live[agentSessionKey(agent, sid)]) return json(res, 409, { ok: false, detail: 'chat is running — close it first' });
          if (known.saved) return json(res, 409, { ok: false, detail: 'chat is saved — unsave it first' });
          db.prepare(`INSERT INTO chat_hidden (agent, session_id, hidden_at) VALUES (?, ?, ?) ON CONFLICT(agent, session_id) DO UPDATE SET hidden_at = excluded.hidden_at`).run(agent, sid, Date.now());
          return json(res, 200, { ok: true });
        } finally {
          db.close();
        }
      });
      return;
    }

    if ((url.pathname === '/resume' || url.pathname === '/branch') && req.method === 'POST') {
      const sid = url.searchParams.get('session') || '';
      const agent = selectedAgent(url);
      if (!agent) return json(res, 400, { ok: false, detail: 'invalid agent' });
      // `lane=` launches into that lane's next open pane, resolved now rather than
      // when the dashboard listed it; `pane=` names the pane outright.
      // Under launch_target=managed a lane is ignored: the chat gets a managed window.
      const asked = url.searchParams.get('lane') || '';
      const lane = asked && pickStrategy(readWorld()) === 'managed' ? '' : asked;
      let pane = url.searchParams.get('pane') || '';
      if (!pane && lane) {
        pane = nextOpenPane(lane, readWorld())?.pane_id ?? '';
        if (!pane) return json(res, 409, { ok: false, detail: `no open pane in lane ${lane}` });
      }
      const { views } = snapshot();
      const target = resolveLaunchTarget(views, sid, url.searchParams.get('proj'));
      if (!target.ok) return json(res, target.code, { ok: false, detail: target.detail });
      const fork = url.pathname === '/branch';
      if (fork && target.sourceAgent !== agent) {
        return json(res, 400, { ok: false, detail: 'a session can only be branched with its own agent' });
      }
      // Neither lane nor pane: with lane sessions that is a caller error (the picker
      // names a lane); with none, the chat gets a managed window of its own.
      if (!pane && pickStrategy(readWorld()) === 'lanes') return json(res, 400, { ok: false, reason: 'no_pane', detail: 'no pane' });
      // Async from here: a new managed window's shell is waited for without
      // blocking the main process (the whole app froze for that wait before).
      // A second click while the first is still waiting on its shell would put
      // two processes on one transcript.
      if (resumesInFlight.has(sid)) return json(res, 409, { ok: false, reason: 'busy', detail: 'already resuming this chat' });
      resumesInFlight.add(sid);
      void (async () => {
        const t0 = Date.now();
        let managed = false;
        let readyMs = 0;
        if (!pane) {
          const a = acquireManagedPane(target.dir);
          if (!a.ok) return json(res, 409, { ok: false, detail: a.detail });
          pane = a.paneId;
          managed = true;
          const t = Date.now();
          await waitForShellReadyAsync(pane);
          readyMs = Date.now() - t;
        }
        const r = launchInPane({
          paneId: pane,
          projectDir: target.dir,
          sessionId: sid,
          sourceAgent: target.sourceAgent,
          selectedAgent: agent,
          fork,
          ...(managed && currentTerminal() === 'inside' ? { focus: false } : {}), // Loom's own terminal shows a managed window; an external one is switched to it
        });
        if (r.ok) rememberProject(target.dir);
        pickLog().write(url.searchParams.get('trace') || '-', 'resume-served', { action: fork ? 'branch' : 'resume', ok: r.ok, pane, managed, ready_ms: readyMs, total_ms: Date.now() - t0 });
        json(res, r.ok ? 200 : 500, { ...r, pane_id: pane, managed });
      })()
        .catch((e) => json(res, 500, { ok: false, detail: (e as Error).message }))
        .finally(() => resumesInFlight.delete(sid));
      return;
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const { defaultAgent, views, live } = snapshot();
      // The terminal token goes only into a page asked for by Loom's own host
      // name: a rebinding page (evil.example -> 127.0.0.1) gets the board
      // without it, and so can never open a terminal (see ptybridge.ts).
      const token = isLoomHost(req.headers.host, serverPort()) ? termToken() : '';
      // Read fresh, never from the snapshot memo: Enter on the welcome screen
      // must not be followed by a reload that shows it again.
      const boot = (() => { const db = openDb(); try { return firstPaint(db); } catch { return { welcome: false }; } finally { db.close(); } })();
      const html = renderDashboard(views, Date.now(), live, defaultAgent, threadOwners(), pendingDrafts(), token, orchSummary(live), tagList(), boot);
      return send(res, 200, 'text/html; charset=utf-8', withClientFetch(html));
    }

    if (url.pathname.startsWith('/vendor/')) {
      const file = vendorFile(url.pathname.slice('/vendor/'.length));
      if (!file) return send(res, 404, 'text/plain', 'not found');
      res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-cache' });
      return res.end(file.body);
    }

    send(res, 404, 'text/plain', 'not found');
  });
}


/**
 * The background ticks that talk to GitHub and git for the board: PR pipelines
 * and ship groups. Exported so a test harness can run them against its own port.
 */
export function startGhTicks(): void {
  // PR pipelines: refresh whatever the board or a panel asked about and is due.
  // Each entry decides its own pace (20s in flight on a live chat, minutes otherwise).
  let piping = false;
  setInterval(() => {
    if (piping) return;
    piping = true;
    tickPipelines(pipelineLiveKeys)
      .catch((e) => console.error('[loom] pipeline tick failed:', (e as Error).message))
      .finally(() => { piping = false; });
  }, 5_000);

  // Ship groups: git status + the ship lock + recent ship/ PRs (gh, 60s cache),
  // attributed to chats by their transcripts' edits. Off the request path.
  // The orchestrator rides the same snapshot: supervise its session, detect
  // transitions, deliver events and queued relays (src/orchserver.ts).
  const ships = () => {
    const snap = snapshot();
    refreshShipBoards(snap.views, snap.live).then(onShipBoards).catch((e) => console.error('[loom] ship boards failed:', (e as Error).message));
    orchTick(snap);
  };
  setTimeout(ships, 2_000);
  setInterval(ships, 15_000);

  // Outbox: a chat posting its own draft shows in its transcript within a second.
  // The 2-minute thread reconcile (read-only) settles drafts posted any other way.
  let watching = false;
  setInterval(() => {
    if (watching) return;
    watching = true;
    outboxWatch.tick().catch((e) => console.error('[loom] outbox watch failed:', (e as Error).message)).finally(() => { watching = false; });
  }, 1_000);
  let reconciling = false;
  const reconcile = () => {
    if (reconciling) return;
    reconciling = true;
    if (!slackFeatureOn('reconcile')) {
      reconciling = false;
      return;
    }
    reconcileLive()
      .then((ids) => ids.length && console.log('[loom] outbox: marked sent (found in thread):', ids.join(',')))
      .catch((e) => console.error('[loom] outbox reconcile failed:', (e as Error).message))
      .finally(() => { reconciling = false; });
  };
  setTimeout(reconcile, 10_000);
  setInterval(reconcile, 120_000);
  // Parked chats: each thread is due about every 2 minutes, backing off as it ages (src/parked.ts).
  setTimeout(() => void parkedTick(), 15_000);
  setInterval(() => void parkedTick(), 30_000);
  // The plugin's event files (drafts, claims, stages, ship labels): on change and every 2 s.
  startEventIngest(() => openDb(), { legacyThreads: legacyThreadState });
  // `seen` for drafts the chat did not pass one for: what each target held when the draft arrived.
  setInterval(() => void fillSeenTick().catch((e) => console.error('[loom] outbox seen:', (e as Error).message)), 3000).unref?.();
  // plugin-state.json follows the settings its hooks gate on (src/pluginmgr.ts).
  startPluginStateSync(() => openDb());

}

// Start only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  loadTmuxSocketSetting();
  const server = createServer();
  void startListening(server).then((choice) => {
    if (choice.kind !== 'bound') {
      console.error(`[loom] ${startFailure(choice).message}`);
      process.exit(1);
    }
    attachTerminalBridge(server, { port: choice.port });
    console.log(`[loom] server on http://localhost:${choice.port}`);
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

  startGhTicks();
  startWatcherTicks();
  startManagedTicks();

}
