import { app, BrowserWindow, Tray, Menu, dialog, globalShortcut, ipcMain, Notification, shell, screen } from 'electron';
import { loadWinState, saveWinState, restoreBounds } from '../src/winstate.ts';
import { startPick, stopHelper, axTrusted, axRequest, warmPicker, endPick, askNewThread, pickEvent, type GotoOutcome } from './picker.ts';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, startGhTicks, loomWriteHeaders } from '../src/server.ts';
import { serverPort } from '../src/serverport.ts';
import { startListening, startFailure } from '../src/serverstart.ts';
import { removeServerJson } from '../src/serverjson.ts';
import { attachTerminalBridge } from '../src/ptybridge.ts';
import { openDb, getSlackHotkey, loadTmuxSocketSetting } from '../src/db.ts';
import { getSetting, onSettingChanged } from '../src/settingsSchema.ts';
import { menuAccelerators } from '../src/keymap.ts';
import { composePath, resolveTmuxTmpdir, loginEnv, shouldAutostartOrchestrator } from '../src/appenv.ts';
import { practice, setShortcutHost, normalizeAccelerator } from '../src/routes/shortcut.ts';
import { parseSlackThread, findOwner, defaultGotoDeps } from '../src/slackgoto.ts';
import { getChannelProjects } from '../src/slackowner.ts';
import { channelLabels } from '../src/slack.ts';
import { runPass } from '../src/cli.ts';
import { writeLayout } from '../src/snapshot.ts';
import { restore } from '../src/restore.ts';
import { attachGhosttyTabs } from '../src/ghostty.ts';
import { currentTerminal, setInsideRaiser } from '../src/terminal.ts';
import { LOOM_SCHEME, parseLoomUrl, raiseLoom, setConnectRaiser } from '../src/connectreturn.ts';
import { SESSION_PREFIX, TOOL_DIR } from '../src/paths.ts';
import { trayIcon } from './trayIcon.ts';
import {
  liveSessions,
  liveSessionsFrom,
  listTmuxPanes,
  agentPaneIds,
  readPlacements,
  agentSessionKey,
  attachedSessions,
} from '../src/placements.ts';
import { makeTmuxWatcher, noteTmuxState } from '../src/tmuxwatch.ts';
import { toChatViews } from '../src/dashboard.ts';
import { PaneTints, desiredTints } from '../src/panetint.ts';
import { nameNewPanes } from '../src/panenames.ts';
import { PaneTopics, paneLabelConfig } from '../src/panetopics.ts';
import { makeCompactor, compactEnabled, setCompactEnabled } from '../src/compact.ts';
import { defaultRunner } from '../src/analyzer.ts';
import { startWatcherTicks } from '../src/watchers/engine.ts';
import { startManagedTicks } from '../src/managed.ts';
import { LiveIndexer, indexedMtimes } from '../src/liveindex.ts';
import { isOrchestratorRef } from '../src/orchsession.ts';
import { orchSessionId } from '../src/orchserver.ts';
import { tmux } from '../src/tmux.ts';
import { configureOrchestrator } from '../src/orchserver.ts';
import { setOrchNotifier, orchSettings } from '../src/orchestrator.ts';
import { notifyUser, setAppNotifier, type NotifyTarget } from '../src/notify.ts';
import { Updater, bundleOf, defaultCacheDir } from '../src/updater.ts';
import { setUpdateHost } from '../src/routes/update.ts';
import { installAppLog, setBuildInfo } from '../src/diagnostics.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { clearPidFile, noticeText, takeNotice } from '../src/watchdog.ts';

// Loom's own log ($LOOM_HOME/loom.log): the packaged app has no terminal, so the
// console is teed there for Copy details and Copy diagnostics (src/diagnostics.ts).
installAppLog();

// Finder-launched apps inherit a minimal PATH; restore the dirs we shell out to
// (claude, tmux, gh, osascript): the user's extra_path, the built-ins (both
// Homebrew prefixes, so Apple Silicon and Intel both work), then the login
// shell's PATH once it has answered. TMUX_TMPDIR (tmux_tmpdir) so tmux finds
// the running server socket.
const home = os.homedir();
const startupPath = process.env.PATH || '';
const startupTmpdir = process.env.TMUX_TMPDIR || '';
function readEnvSettings(): { extra: string[]; tmpdir: string } {
  try {
    const db = openDb();
    try {
      return { extra: getSetting(db, 'extra_path', { env: false }), tmpdir: getSetting(db, 'tmux_tmpdir', { env: false }) };
    } finally {
      db.close();
    }
  } catch {
    return { extra: [], tmpdir: 'auto' }; // no DB yet: built-ins only
  }
}
let loginPathCache = '';
let loginTmpdirCache = '';
function applyEnv(): void {
  const s = readEnvSettings();
  process.env.PATH = composePath({ home, extra: s.extra, loginPath: loginPathCache, current: startupPath });
  process.env.TMUX_TMPDIR = resolveTmuxTmpdir(s.tmpdir, loginTmpdirCache, startupTmpdir);
}
applyEnv();
// The login shell takes a moment (it sources the user's rc files): fold its answer in when it arrives.
void loginEnv().then((l) => {
  if (!l) return;
  loginPathCache = l.path;
  loginTmpdirCache = l.tmuxTmpdir;
  applyEnv();
});
// A Dock launch can hand Loom LANG=C.UTF-8, which macOS has no locale for: tmux
// clients and capture-pane then treat output as ASCII and print '_' for Unicode.
if (!/UTF-?8/i.test(process.env.LC_ALL || process.env.LC_CTYPE || '') && !/^[a-z]{2}_[A-Z]{2}\.UTF-?8$/i.test(process.env.LANG || '')) process.env.LC_CTYPE = 'en_US.UTF-8';
// Before anything talks to tmux: which server (socket) Loom drives.
loadTmuxSocketSetting();

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let trayMenu: Menu | null = null;
let quitting = false;
let slackAccel = '';

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow(): void {
  // Reopen at the size and place it was last closed at (src/winstate.ts).
  const savedWin = loadWinState();
  const startBounds = restoreBounds(savedWin, [screen.getPrimaryDisplay(), ...screen.getAllDisplays()].map((d) => d.workArea));
  win = new BrowserWindow({
    ...startBounds,
    title: 'Loom',
    backgroundColor: '#0d0f15',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  if (savedWin?.maximized) win.maximize();
  if (savedWin?.fullScreen) win.setFullScreen(true);
  {
    const w = win;
    let t: NodeJS.Timeout | undefined;
    const save = (): void => {
      if (w.isDestroyed() || w.isMinimized()) return;
      saveWinState({ bounds: w.getNormalBounds(), maximized: w.isMaximized(), fullScreen: w.isFullScreen() });
    };
    const soon = (): void => {
      if (t) clearTimeout(t);
      t = setTimeout(save, 500);
    };
    for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen'] as const) w.on(ev as 'resize', soon);
    w.on('close', () => {
      if (t) clearTimeout(t);
      save();
    });
  }
  // A file dropped anywhere must never navigate the window to it (or any link off Loom's own origin).
  const own = `http://localhost:${serverPort()}/`;
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(own)) e.preventDefault();
  });
  // target=_blank links (PRs, Slack threads, docs) must open in the user's own
  // browser or app. Electron's default is a bare child BrowserWindow, which hangs
  // on Slack's app-redirect page.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !url.startsWith(own)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(`http://localhost:${serverPort()}/`);
  win.once('ready-to-show', () => win?.show());
  watchRenderer(win);
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

// A hung or crashed page must not leave the window dead until Loom is quit.
// 'unresponsive' fires when the renderer stops answering the main process; if it
// is still stuck after the grace period, its process is crashed, and
// 'render-process-gone' (that crash, or any other) reloads the page. Reloads are
// capped so a page that dies on load does not spin.
const RENDERER_GRACE_MS = 10_000;
const RELOAD_CAP = 3;
const RELOAD_WINDOW_MS = 60_000;
function watchRenderer(w: BrowserWindow): void {
  let stuck: NodeJS.Timeout | null = null;
  const reloads: number[] = [];
  const clear = () => {
    if (stuck) clearTimeout(stuck);
    stuck = null;
  };
  w.on('unresponsive', () => {
    if (stuck) return;
    console.error(`[loom] window: page unresponsive; reloading it in ${RENDERER_GRACE_MS / 1000}s unless it recovers`);
    stuck = setTimeout(() => {
      stuck = null;
      if (w.isDestroyed() || quitting) return;
      console.error('[loom] window: page still unresponsive; crashing its renderer to reload it');
      w.webContents.forcefullyCrashRenderer();
    }, RENDERER_GRACE_MS);
  });
  w.on('responsive', () => {
    if (stuck) console.error('[loom] window: page responsive again');
    clear();
  });
  w.on('closed', clear);
  w.webContents.on('render-process-gone', (_e, d) => {
    clear();
    console.error(`[loom] window: renderer gone (${d.reason}, exit ${d.exitCode})`);
    if (w.isDestroyed() || quitting) return;
    const now = Date.now();
    while (reloads.length && now - reloads[0] > RELOAD_WINDOW_MS) reloads.shift();
    if (reloads.length >= RELOAD_CAP) return console.error(`[loom] window: ${RELOAD_CAP} reloads in a minute; leaving it until Loom restarts`);
    reloads.push(now);
    w.loadURL(`http://localhost:${serverPort()}/`);
  });
}

// Server-side notifications (parked replies, watchers, Needs you) come here so a click opens the chat.
// Shown notifications are held here until clicked or closed: Electron drops the click
// handler of a Notification that has been garbage-collected, so a click minutes later
// would only raise the app instead of opening the chat.
const liveNotifications = new Set<Notification>();
setAppNotifier(({ title, body, target, sound }) => {
  if (!Notification.isSupported()) throw new Error('notifications unavailable');
  const n = new Notification({
    title,
    body,
    silent: sound === 'off',
    ...(sound && sound !== 'off' && sound !== 'system' ? { sound } : {}),
  });
  n.on('click', () => {
    liveNotifications.delete(n);
    showWindow();
    const js =
      target && 'orch' in target
        ? 'typeof selectOrch === "function" && selectOrch()'
        : target && 'pr' in target
          ? 'typeof window.loomOpenPr === "function" && window.loomOpenPr(' + JSON.stringify(target.pr) + ')'
          : target
            ? 'typeof window.loomOpenChat === "function" && window.loomOpenChat(' + JSON.stringify(target.agent) + ',' + JSON.stringify(target.sid) + ')'
            : '';
    if (js) void win?.webContents.executeJavaScript(js).catch(() => {});
  });
  n.on('close', () => liveNotifications.delete(n));
  liveNotifications.add(n);
  n.show();
});

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}

// "Jump" with the terminal set to inside Loom: raise this window; the page opens the chat.
setInsideRaiser(showWindow);

// A sign-in that finished in the browser (Slack, Gmail, GitHub) brings Loom back
// in front of the browser. macOS 14+ may ignore a background app's own request
// (see src/connectreturn.ts), so the done page also opens loom://connected/<kind>,
// which the browser hands to Loom here, through open-url. The page polls the
// flow and shows the connected state on its own.
const raiseTarget = {
  window: () => (win && !win.isDestroyed() ? win : null),
  createWindow: () => createWindow(),
  showApp: () => {
    if (process.platform === 'darwin') app.show();
  },
  focusApp: () => app.focus({ steal: true }),
};
setConnectRaiser(() => raiseLoom(raiseTarget));
// open-url can arrive before ready (Loom launched by the link): raise once ready.
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (parseLoomUrl(url) === null) return;
  void app.whenReady().then(() => raiseLoom(raiseTarget));
});
if (!app.isDefaultProtocolClient(LOOM_SCHEME)) app.setAsDefaultProtocolClient(LOOM_SCHEME);

const paneTints = new PaneTints();

// A chat counts as "working" if its transcript was written in the last few seconds.
const WORKING_MS = 10_000;

// One pass over the world, feeding both the tray counts and the pane tints. They
// want the same three things — the chat rows, the live pane join, and each
// transcript's mtime — so computing them separately would double the DB open, the
// `list-panes` and the full `ps` walk on every 4s tick.
function readSetting<K extends 'ghostty_attach_cmd' | 'pane_tint' | 'pane_tint_base'>(key: K): ReturnType<typeof getSetting<K>> | undefined {
  try {
    const db = openDb();
    try {
      return getSetting(db, key);
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

function trayTick(): { live: number; working: number; yourTurn: number } {
  try {
    const db = openDb();
    const views = toChatViews(db);
    db.close();
    const now = Date.now();

    // liveSessions() inlined so the pane list it builds can be reused below for
    // the tint reconciliation, rather than shelling out to tmux a second time.
    const panes = listTmuxPanes();
    const live = liveSessionsFrom(panes, agentPaneIds(panes), readPlacements());

    // Keyed by agent:session_id, which is what liveSessionsFrom emits. Keying this
    // by the bare session_id silently matched nothing, so working/yourTurn were
    // pinned at 0 and the tray never showed a count.
    const byKey = new Map(views.map((v) => [agentSessionKey(v.agent, v.session_id), v]));

    // The transcript's mtime, NOT chats.last_active_at: that column only refreshes
    // on a summarizer pass, so it lags by minutes and would park a busy chat in a
    // staler bucket than it deserves for as long as the lag lasts.
    const lastActive = new Map<string, number>();
    for (const key of live.keys()) {
      const v = byKey.get(key);
      if (!v) continue;
      try {
        lastActive.set(key, fs.statSync(v.jsonl_path).mtimeMs);
      } catch {
        /* transcript gone */
      }
    }

    let working = 0;
    let yourTurn = 0;
    for (const key of live.keys()) {
      const v = byKey.get(key);
      if (!v) continue;
      const mt = lastActive.get(key);
      if (mt !== undefined && now - mt < WORKING_MS) working++;
      if (v.state === 'waiting_on_user') yourTurn++;
    }

    paneTints.apply(
      desiredTints(live, lastActive, now, SESSION_PREFIX, { enabled: readSetting('pane_tint'), base: readSetting('pane_tint_base') }),
      new Set(panes.map((p) => p.pane_id)),
    );

    return { live: live.size, working, yourTurn };
  } catch {
    // tmux or the DB is unavailable this tick; leave the tints exactly as they are.
    return { live: 0, working: 0, yourTurn: 0 };
  }
}

function updateTray(): void {
  const c = trayTick();
  if (!tray) return;
  const parts: string[] = [];
  if (c.working) parts.push(`⚡${c.working}`);
  if (c.yourTurn) parts.push(`🔵${c.yourTurn}`);
  tray.setTitle(parts.length ? ' ' + parts.join(' ') : '');
  tray.setToolTip(`Loom — ${c.live} live · ${c.working} working · ${c.yourTurn} your turn`);
  const compactItem = trayMenu?.getMenuItemById('compact');
  if (compactItem) compactItem.checked = compactEnabled();
}

function clearPaneTints(): void {
  const windows = paneTints.clearAll(SESSION_PREFIX);
  if (windows) console.log(`[loom] cleared pane tints across ${windows} window(s)`);
}

function doRestore(): void {
  try {
    const r = restore({ prefix: SESSION_PREFIX });
    // Tab rehoming is Ghostty-only; for any other terminal restore just rebuilds tmux.
    const g = !r.attach.length
      ? { ok: true, detail: 'every session already has a tab' }
      : currentTerminal() === 'ghostty'
        ? attachGhosttyTabs(r.attach, { attached: attachedSessions(), saved: r.windows, attachCmd: readSetting('ghostty_attach_cmd') })
        : { ok: true, detail: 'tmux sessions rebuilt; attach to them from your terminal' };
    const detail =
      `Recreated ${r.restored.length} session(s)${r.restored.length ? ': ' + r.restored.join(', ') : ''}\n` +
      (r.skipped.length ? `Already running: ${r.skipped.join(', ')}\n` : '') +
      `\nTabs: ${g.detail}`;
    dialog.showMessageBox({ type: 'info', title: 'Loom', message: 'Workspace restore', detail });
  } catch (e) {
    // Not showErrorBox: it is modal and synchronous, so the main thread (server,
    // tray, shortcuts) would stop until it was dismissed, and the watchdog would
    // take that for a freeze.
    void dialog.showMessageBox({ type: 'error', title: 'Loom', message: 'Workspace restore failed', detail: String((e as Error).message) });
  }
}

let passRunning = false;
async function runOnce(): Promise<void> {
  if (passRunning) return;
  passRunning = true;
  try {
    const db = openDb();
    await runPass(db, defaultRunner);
    db.close();
  } catch (e) {
    console.error('[loom] summarizer pass failed', e);
  } finally {
    passRunning = false;
  }
}

// The "open the chat for this Slack thread" hotkey: it opens a pick overlay
// (app/picker.ts), and the Slack message clicked there resolves to its thread
// parent, which is POSTed to the server's /api/slack/thread-goto: the same
// endpoint a curl with a permalink hits. Failures notify; a jump is its own
// feedback.
function slackHotkey(): string {
  const db = openDb();
  try {
    return getSlackHotkey(db);
  } finally {
    db.close();
  }
}

function notify(body: string): void {
  if (Notification.isSupported()) new Notification({ title: 'Loom', body, silent: true }).show();
}

interface GotoReply {
  ok: boolean;
  detail?: string;
  action?: string;
  reason?: string;
  ask?: { channel: string; channel_name: string; project: string };
  session_id?: string;
  pane_id?: string;
  managed?: boolean;
  source?: string;
  timings?: Record<string, number>;
  started?: { agent?: string; session_id?: string };
}

async function postThreadGoto(body: Record<string, unknown>): Promise<GotoReply> {
  const t = Date.now();
  const r = await fetch(`http://127.0.0.1:${serverPort()}/api/slack/thread-goto`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...loomWriteHeaders() },
    body: JSON.stringify(body),
  });
  const out = (await r.json()) as GotoReply;
  // The server's own breakdown (find-chat lookup, pane + shell, jump/launch) next to the round trip.
  pickEvent('server', { mode: String(body.mode ?? ''), ms: Date.now() - t, ok: out.ok, action: out.action, reason: out.reason, source: out.source, managed: out.managed, pane: out.pane_id, ...(out.timings ?? {}) });
  return out;
}

/** Run a page hook in the main window and wait for it; false when the page is not there yet. */
async function pageCall(js: string): Promise<boolean> {
  if (!win || win.isDestroyed()) return false;
  try {
    if (win.webContents.isLoading()) await new Promise<void>((r) => win!.webContents.once('did-finish-load', () => r()));
    return !!(await win.webContents.executeJavaScript(js));
  } catch {
    return false;
  }
}

// How long the hotkey's open may take before Loom's window comes up saying so.
const PENDING_AFTER_MS = 300;

/**
 * Open the chat for a picked thread, resolving once it is on screen. With
 * slack_goto_confirm_new on (the default), the first post only looks: an owned
 * thread is jumped to at once, and an unowned one comes back as action 'ask', so
 * the user can add context (or send it as is, or cancel) before a second post
 * starts the chat.
 *
 * With Loom's own terminal (`terminal: inside`) every outcome lands in Loom's
 * window, so that window is brought up and told what to show the moment the
 * server answers, instead of on the page's next 5 s poll; and when the server is
 * slow (a resume waiting on a new window's shell), it comes up early saying
 * "Opening…". Before, a resumed chat (a managed window, left unfocused) showed
 * nowhere at all, so the first press seemed to do nothing and the second, now
 * finding the chat running, jumped: the "two clicks".
 */
async function threadGoto(url: string, picked: { text?: string; author?: string } = {}): Promise<GotoOutcome> {
  const inside = currentTerminal() === 'inside';
  const label = threadLabel(url);
  let pendingUp = false;
  // The Slack screen (src/pendingview.ts, kind 'slack'): the page switches to it at once, so the
  // chat that was selected before never shows while this one loads; the window itself only comes
  // up after PENDING_AFTER_MS, so a fast jump does not flash it.
  const where = label === 'this thread' ? 'This Slack thread' : label.charAt(0).toUpperCase() + label.slice(1);
  const setScreen = (title: string, detail: string) => {
    pendingUp = true;
    void pageCall('typeof loomPending==="function"&&loomPending(' + JSON.stringify({ kind: 'slack', label: title, where, detail }) + ')');
  };
  let windowUp = false;
  const raise = () => {
    windowUp = true;
    showWindow();
    pickEvent('pending-shown');
  };
  const showPending = (title: string, detail = '') => {
    setScreen(title, detail);
    raise();
  };
  if (inside) setScreen('Opening your chat from Slack', 'Finding the chat for this thread.');
  const slow = inside ? setTimeout(raise, PENDING_AFTER_MS) : null;
  const fail = (detail: string): GotoOutcome => {
    // A failure before the window came up is the notification alone, not a card left waiting in a hidden window.
    if (pendingUp) void pageCall('typeof loomPending==="function"&&loomPending(' + (windowUp ? JSON.stringify({ label: 'Could not open ' + label, detail, state: 'error' }) : 'null') + ')');
    notify(detail);
    return { ok: false, detail };
  };
  try {
    const base = { url, text: picked.text, author: picked.author };
    let out = await postThreadGoto({ ...base, mode: confirmNewOn() ? 'ask' : undefined });
    if (slow) clearTimeout(slow);
    if (out.ok && out.action === 'ask') {
      if (pendingUp) void pageCall('typeof loomPending==="function"&&loomPending(null)');
      pendingUp = false;
      endPick('ask'); // the overlay would sit over the prompt
      const context = await askNewThread({ channel: out.ask?.channel ?? '', channelName: out.ask?.channel_name, author: picked.author, text: picked.text, project: out.ask?.project });
      pickEvent('ask-answer', { start: context !== null });
      if (context === null) return { ok: true };
      if (inside) showPending('Starting your chat from Slack', out.ask?.project ? 'In ' + out.ask.project + '.' : 'Starting Claude for this thread.');
      out = await postThreadGoto({ ...base, mode: 'start', context });
    }
    if (!out.ok) return fail(out.detail || 'Could not open the chat for this thread');
    let shown = true;
    if (out.action === 'started' && inside && out.session_id) {
      // No chat owned the thread, so one was started. Its session id is known, so the
      // card stays up ("Opening this chat…") and the page polls for it every 1.5 s,
      // opening it the moment it is live. Before, the card was cleared at once and the
      // chat only opened on a later 5 s board poll after Claude came up: 2-7 s of an
      // empty main area, and a start that never ran showed nothing at all.
      showWindow();
      shown = await pageCall('typeof loomOpenResumed==="function"&&loomOpenResumed("claude",' + JSON.stringify(out.session_id) + ',' + JSON.stringify(out.pane_id ?? '') + ',false,"started")');
    } else if (out.action === 'started') {
      // No chat owned the thread, so one was started: show it in Loom's main area
      // (the board picks the new start up on its refresh; nudge it now).
      showWindow();
      shown = await pageCall('typeof refresh==="function"&&refresh().then(function(){typeof loomPending==="function"&&loomPending(null);return true;})');
    } else if (inside && out.action === 'resumed' && out.session_id) {
      showWindow();
      shown = await pageCall('typeof loomOpenResumed==="function"&&loomOpenResumed("claude",' + JSON.stringify(out.session_id) + ',' + JSON.stringify(out.pane_id ?? '') + ')');
    } else if (inside && out.action === 'jumped') {
      // The server raised the window and published the focus request; take it now.
      showWindow();
      shown = await pageCall('typeof loomFocusNow==="function"&&loomFocusNow()');
    } else if (pendingUp) {
      // Nothing above lands in Loom's window (the chat opened in another terminal): clear the screen.
      void pageCall('typeof loomPending==="function"&&loomPending(null)');
    }
    pickEvent('view-shown', { action: out.action, inside, shown });
    return { ok: true };
  } catch (e) {
    return fail('Slack thread lookup failed: ' + (e as Error).message);
  } finally {
    if (slow) clearTimeout(slow);
  }
}

/** "#channel" for the loading and error states, from the label cache; "this thread" when unknown. */
function threadLabel(url: string): string {
  const ref = parseSlackThread(url);
  if (!ref) return 'this thread';
  try {
    const name = String(channelLabels()[ref.channel] ?? '').replace(/^[#@]/, '');
    return name ? 'the #' + name + ' thread' : 'this thread';
  } catch {
    return 'this thread';
  }
}

function confirmNewOn(): boolean {
  try {
    const db = openDb();
    try {
      return getSetting(db, 'slack_goto_confirm_new', { env: false });
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

// The hang watchdog (src/watchdog.ts): a detached process that pings
// /api/health and, when the main thread has been stuck ~25 s, samples its stack
// into $LOOM_HOME/hangs/, kills Loom and opens it again. Packaged app only
// (LOOM_WATCHDOG=1 forces it on in a dev run, LOOM_WATCHDOG=0 off). Stopped in
// before-quit, so a Loom that quits on purpose is never brought back.
let watchdog: ChildProcess | null = null;
function startWatchdog(port: number): void {
  const flag = process.env.LOOM_WATCHDOG;
  if (flag === '0' || (!app.isPackaged && flag !== '1')) return;
  // One at a time: the new watchdog takes the pid file, and any older one exits on
  // its next tick when it sees the file name someone else (it is never killed by a
  // pid read from a file, which may have been recycled).
  const script = path.join(__dirname, 'watchdog.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const bundle = bundleOf(process.execPath);
  try {
    const child = spawn(process.execPath, [script, '--pid', String(process.pid), '--port', String(port), '--home', TOOL_DIR, ...(bundle ? ['--app', bundle] : [])], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('error', (e) => console.error('[loom] watchdog failed to start:', e.message));
    child.on('exit', () => {
      if (watchdog === child) watchdog = null;
    });
    child.unref();
    watchdog = child;
  } catch (e) {
    console.error('[loom] watchdog failed to start:', (e as Error).message);
  }
}
function stopWatchdog(): void {
  const w = watchdog;
  watchdog = null;
  if (!w?.pid) return;
  try {
    process.kill(w.pid, 'SIGTERM');
  } catch {
    /* gone */
  }
  clearPidFile(TOOL_DIR, w.pid);
}
/** The restart notice a watchdog (or `chat-manager restart`) left for this launch. */
function announceRestart(): void {
  const n = takeNotice(TOOL_DIR);
  if (!n) return;
  const text = noticeText(n, (p) => p.replace(os.homedir(), '~'));
  console.error('[loom] ' + text);
  notify(text);
}

// The orchestrator's MCP server, as a command Claude Code can spawn. In the
// packaged app the bundle sits in app.asar.unpacked (see package.json asarUnpack).
let orchConfigured = false;
function orchShouldRun(): boolean {
  try {
    const db = openDb();
    try {
      return shouldAutostartOrchestrator(orchSettings.enabled(db), getSetting(db, 'orchestrator_autostart', { env: false }));
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

// Supervision runs only once configureOrchestrator has given it its files, so
// not configuring (orchestrator off, or autostart off) is what keeps it down.
function configureOrchSupervision(): void {
  if (orchConfigured || !orchShouldRun()) return;
  const script = path.join(__dirname, 'orchmcp.js').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  try {
    configureOrchestrator({ command: process.execPath, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } });
    orchConfigured = true;
  } catch (e) {
    console.error('[loom] orchestrator setup failed:', (e as Error).message);
  }
}

function startOrchestratorSession(): void {
  configureOrchSupervision();
  // A new Needs you item: a macOS notification that opens the orchestrator view.
  // The phone sees the orchestrator's own message through Remote Control.
  setOrchNotifier((item) => {
    let target: NotifyTarget;
    if (item.ref_type === 'chat' && item.ref_id) {
      const i = item.ref_id.indexOf(':');
      const head = i > 0 ? item.ref_id.slice(0, i) : '';
      target = head === 'claude' || head === 'codex' ? { agent: head, sid: item.ref_id.slice(i + 1) } : { agent: '', sid: item.ref_id };
    } else if (item.ref_type === 'pr' && item.ref_id) target = { pr: item.ref_id }; // the chat working that PR
    else target = { orch: true };
    notifyUser({ title: 'Needs you: ' + item.title, body: item.why || 'The orchestrator needs you.', target });
  });
}

// What a press would do, for practice mode: the same lookups the real jump makes,
// stopping before it acts.
async function practiceResult(url: string, picked: { text?: string; author?: string } = {}): Promise<void> {
  const ref = parseSlackThread(url);
  if (!ref) {
    practice.complete({ ok: false, detail: 'That is not a Slack message link.' });
    return;
  }
  let wouldDo: 'jump' | 'start' = 'start';
  try {
    const owner = await findOwner(ref, defaultGotoDeps(() => ({}), () => null));
    if (owner) wouldDo = 'jump';
  } catch {
    /* lookup failed: report the start case */
  }
  let project = '';
  try {
    const db = openDb();
    try {
      project = getChannelProjects(db)[ref.channel] ?? '';
    } finally {
      db.close();
    }
  } catch {
    /* no mapping known */
  }
  practice.complete({ ok: true, author: picked.author, channel: ref.channel, wouldDo, project });
}

function slackThreadGoto(): void {
  if (practice.armed()) {
    // Practice: the real pick, but the result goes to the wizard and nothing is opened.
    void startPick({
      notify: (body) => void practice.complete({ ok: false, detail: body }),
      goto: practiceResult,
      pasteFallback: () => pasteFallbackOn(),
    });
    return;
  }
  void startPick({ notify, goto: threadGoto, pasteFallback: () => pasteFallbackOn() });
}

function pasteFallbackOn(): boolean {
  try {
    const db = openDb();
    try {
      return getSetting(db, 'slack_paste_fallback', { env: false });
    } finally {
      db.close();
    }
  } catch {
    return true;
  }
}

/** Register `accel`; false when the system or another app holds it (or it is invalid). */
function tryGlobal(accel: string, onPress: () => void = slackThreadGoto): boolean {
  try {
    return globalShortcut.register(accel, onPress);
  } catch {
    return false; // an invalid accelerator throws
  }
}

function registerSlackHotkey(): string {
  const accel = slackHotkey();
  if (accel.toLowerCase() === 'off') return '';
  if (tryGlobal(accel)) return accel;
  console.error(`[loom] could not register the Slack thread hotkey ${accel}`);
  return '';
}

/** slack_goto_hotkey changed: swap the global shortcut live. The old one stays if the new one is refused. */
function reRegisterSlackHotkey(): void {
  const next = slackHotkey();
  if (next.toLowerCase() === 'off') {
    if (slackAccel) globalShortcut.unregister(slackAccel);
    slackAccel = '';
  } else if (next !== slackAccel) {
    if (tryGlobal(next)) {
      if (slackAccel) globalShortcut.unregister(slackAccel);
      slackAccel = next;
      warmPicker();
    } else {
      notify(`Could not register ${next}; another app or the system holds it. Keeping ${slackAccel || 'no shortcut'}.`);
    }
  }
  buildTrayMenu();
}

// Self-update from GitHub Releases (src/updater.ts). Packaged apps only; a run
// from source never updates. Version and commit are stamped by app/build.mjs.
declare const __LOOM_BUILD__: { version: string; commit: string; channel: string } | undefined;
const BUILD = typeof __LOOM_BUILD__ === 'object' && __LOOM_BUILD__ ? __LOOM_BUILD__ : { version: app.getVersion(), commit: '', channel: 'local' };
setBuildInfo({ ...BUILD, version: app.getVersion() || BUILD.version });
function autoUpdateOn(): boolean {
  const db = openDb();
  try {
    return getSetting(db, 'auto_update');
  } finally {
    db.close();
  }
}
let lastUpdateError: string | null = null;
const updater = new Updater({
  current: app.getVersion(),
  commit: BUILD.commit,
  channel: BUILD.channel,
  app: bundleOf(process.execPath),
  packaged: app.isPackaged,
  auto: autoUpdateOn,
  onChange: (st) => {
    // The tray's Restart to update item comes and goes with a ready update.
    if ((st.status === 'ready') !== trayShowsUpdate) buildTrayMenu();
    // Pushed to the page (src/updateview.ts) so Checking, Downloading and Update
    // ready show as they happen, not on the next poll or the next click.
    if (win && !win.isDestroyed()) win.webContents.send('loom:update-state', st);
    // Errors go to loom.log too, so a failed update leaves a record after the page moves on.
    if (st.status === 'error' && st.detail && st.detail !== lastUpdateError) console.log(`[loom] update: ${st.detail}`);
    lastUpdateError = st.status === 'error' ? st.detail : null;
  },
});
// install-app.sh drops this file before it quits Loom, so the quit it causes does
// not also start an update swap of its own.
const SKIP_QUIT_APPLY = path.join(defaultCacheDir(), 'skip-apply-on-quit');
let updateHandedOff = false;
function restartToUpdate(): { ok: true; version: string } | { ok: false; detail: string } {
  const ready = updater.state().ready;
  const r = updater.apply({ pid: process.pid, relaunch: true, loomHome: TOOL_DIR });
  if (!r.ok) return r;
  updateHandedOff = true;
  // Answer the page first; the apply script waits for this process to exit.
  setTimeout(() => {
    quitting = true;
    app.quit();
  }, 400);
  return { ok: true, version: ready?.version ?? '' };
}
setUpdateHost({
  state: () => updater.state(),
  check: () => updater.check({ manual: true }),
  restart: restartToUpdate,
});

setShortcutHost({
  // The conflict check: would register() succeed? Loom's own current shortcut counts as free.
  tryRegister(accel) {
    const n = normalizeAccelerator(accel);
    if (n && slackAccel && normalizeAccelerator(slackAccel) === n) return true;
    if (!tryGlobal(accel, () => {})) return false;
    globalShortcut.unregister(accel);
    return true;
  },
});

function autoUpdateOnSafe(): boolean {
  try {
    return autoUpdateOn();
  } catch {
    return true;
  }
}

function buildTray(): void {
  tray = new Tray(trayIcon());
  tray.on('click', showWindow);
  buildTrayMenu();
}

let trayShowsUpdate = false;
function buildTrayMenu(): void {
  if (!tray) return;
  trayShowsUpdate = updater.state().status === 'ready';
  trayMenu = Menu.buildFromTemplate([
    { label: 'Open Loom', click: showWindow },
    { type: 'separator' },
    { label: 'Restore workspace (after tmux crash)', click: doRestore },
    { label: 'Clear pane tints', click: clearPaneTints },
    {
      // Backed by ~/.loom/compact.off, so the state survives a restart and can
      // be flipped from a shell too; updateTray re-syncs the checkmark.
      id: 'compact',
      label: 'Compact lanes',
      type: 'checkbox',
      checked: compactEnabled(),
      click: (item) => setCompactEnabled(item.checked),
    },
    { label: 'Refresh now', click: () => void runOnce() },
    {
      label: 'Pick a Slack message to open its chat' + (slackAccel ? `  (${slackAccel.replace(/Command/g, 'Cmd').replace(/Control/g, 'Ctrl').replace(/Alt/g, 'Option')})` : ''),
      click: slackThreadGoto,
    },
    ...(updater.state().status === 'ready' ? [{ type: 'separator' as const }, { label: `Restart to update to ${updater.state().ready?.version ?? ''}`, click: () => void restartToUpdate() }] : []),
    { type: 'separator' },
    { label: 'Quit Loom', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(trayMenu);
  updateTray();
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {
  /* stay alive in the tray */
});
app.on('before-quit', () => {
  quitting = true;
  // First: from here the server may stop answering, and that is not a freeze.
  stopWatchdog();
  // A verified update waiting when Loom quits for any other reason is installed
  // then, without relaunching. Not when install-app.sh is the one quitting it.
  if (!updateHandedOff && updater.state().status === 'ready' && autoUpdateOnSafe()) {
    let skip = false;
    try {
      skip = Date.now() - fs.statSync(SKIP_QUIT_APPLY).mtimeMs < 5 * 60 * 1000;
      fs.rmSync(SKIP_QUIT_APPLY, { force: true });
    } catch {
      /* no marker */
    }
    if (!skip && updater.apply({ pid: process.pid, relaunch: false, loomHome: TOOL_DIR }).ok) updateHandedOff = true;
  }
  globalShortcut.unregisterAll();
  stopHelper();
  // Bracket the quit: the line written here and the one the watcher writes if
  // the server disappears are what tell us whether Loom's exit is implicated.
  noteTmuxState(Date.now(), 'loom-quit');
  // Hand the panes back unstyled. tmux owns pane options, so a tint Loom leaves
  // behind outlives Loom — it sits there until the pane or the server dies.
  clearPaneTints();
});

ipcMain.handle('loom:pick-folder', async (event) => {
  // Only Loom's own page may ask.
  if (!event.senderFrame?.url.startsWith(`http://localhost:${serverPort()}/`)) return '';
  const opts = { properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[] };
  const r = win && !win.isDestroyed() ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? '' : (r.filePaths[0] ?? '');
});

// Accessibility for the helper (the Slack reader and terminal scripting), polled by the
// wizard's macOS access and shortcut steps and by Settings. Only Loom's own page may ask.
const fromOwnPage = (event: Electron.IpcMainInvokeEvent) => !!event.senderFrame?.url.startsWith(`http://localhost:${serverPort()}/`);
ipcMain.handle('loom:ax-status', async (event) => (fromOwnPage(event) ? axTrusted() : { trusted: false, helperDown: false }));
// The Grant button: macOS's own Accessibility prompt, for the helper that needs it.
ipcMain.handle('loom:ax-request', async (event) => (fromOwnPage(event) ? axRequest() : { trusted: false, helperDown: false }));
ipcMain.handle('loom:open-accessibility', async (event) => {
  if (fromOwnPage(event)) await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

app.whenReady().then(() => {
  // Standard app menu with Settings… (Cmd+,) opening the Settings tab. Keeps the
  // default roles so copy/paste, window and edit shortcuts still work.
  const openSettings = () => {
    showWindow();
    void win?.webContents.executeJavaScript('typeof openSettings === "function" && openSettings()').catch(() => {});
  };
  // Menu accelerators come from the keymap registry (src/keymap.ts), so the menu
  // and the Help list cannot disagree. Actions the menu can run are mapped here.
  // ⌘N from anywhere, the terminal included: the menu accelerator fires before the page sees the key.
  const openNewThread = () => {
    showWindow();
    void win?.webContents.executeJavaScript('typeof openComposer === "function" && !composerOpen && openComposer()').catch(() => {});
  };
  const menuActions: Record<string, () => void> = { settings: openSettings, newThread: openNewThread };
  const accel = (action: string) => menuAccelerators().find((m) => m.action === action)?.accelerator;
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { type: 'separator' }, { label: 'Settings…', accelerator: accel('settings'), click: menuActions.settings }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: 'File', submenu: [{ label: 'New Thread', accelerator: accel('newThread'), click: menuActions.newThread }, { type: 'separator' }, { role: 'close' }] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
  const server = createServer();
  // The embedded terminal: WebSocket + node-pty on this same server. Quitting
  // closes Loom's views of the chats; the chats themselves keep running in tmux.
  // The configured port, or the next free one when another user's Loom (or anything
  // else) holds it. The terminal bridge attaches once the port is known.
  void startListening(server).then((choice) => {
    if (choice.kind !== 'bound') {
      const { title, message } = startFailure(choice);
      dialog.showErrorBox(title, message);
      app.quit();
      return;
    }
    const stopTerminals = attachTerminalBridge(server, { port: choice.port });
    startWatchdog(choice.port);
    announceRestart();
    app.on('will-quit', () => {
      stopTerminals();
      removeServerJson(TOOL_DIR);
    });
    createWindow();
  });
  // PR pipelines + ship groups (gh/git). The server.ts auto-run block never runs
  // in the bundle (its import.meta.url guard is false there), so they start here.
  startGhTicks();
  // Watchers (src/watchers/): Slack, chats and PRs, on one 15 s tick. Polling Slack
  // costs no model usage; a chat starts only when a Live watcher fires. Same bundle
  // reason as above; the runtime (snapshot, tmux, Slack) is registered by server.ts.
  startWatcherTicks();
  // Reap Loom-managed windows whose agent has exited (src/managed.ts).
  startManagedTicks();
  // The orchestrator session (src/orchsession.ts): started on the board tick that
  // startGhTicks runs, restarted when it dies. Its MCP server is dist/orchmcp.js,
  // run by this same binary as plain node; asarUnpack keeps it a real file.
  startOrchestratorSession();
  // Updates: once shortly after launch, then every 4 hours (src/updater.ts).
  updater.start();

  // The real crash recovery. before-quit handles a clean exit, but nothing fires
  // on SIGKILL, so a killed Loom leaves stale tints on panes it will never see
  // again. Sweep the whole workspace once, unconditionally, BEFORE the first
  // paint below — after it, our own fresh tints would be swept too.
  clearPaneTints();

  slackAccel = registerSlackHotkey();
  // Helper, trust answer and hidden overlays ready before the first press.
  if (slackAccel) warmPicker();
  // Live: a new slack_goto_hotkey takes effect without a restart.
  onSettingChanged((c) => {
    if (c.key === 'slack_goto_hotkey') reRegisterSlackHotkey();
    else if (c.key === 'orchestrator_enabled' || c.key === 'orchestrator_autostart') configureOrchSupervision();
    else if (c.key === 'extra_path' || c.key === 'tmux_tmpdir') applyEnv();
  });
  buildTray();
  app.setLoginItemSettings({ openAtLogin: true });

  // Background work — this app replaces the launchd jobs.
  void runOnce();
  setInterval(() => void runOnce(), 10 * 60 * 1000);
  noteTmuxState(Date.now(), 'loom-start');
  const watchTmux = makeTmuxWatcher();
  setInterval(() => {
    watchTmux(Date.now(), 'tmux-server-changed');
    try {
      writeLayout(Date.now());
    } catch {
      /* tmux down */
    }
  }, 15 * 1000);
  // Name new workspace panes on the fast tick, so a pane opened a moment ago is
  // addressable by name within seconds; once at startup for whatever is open.
  nameNewPanes(SESSION_PREFIX);
  // Lane compaction rides the same tick: slide live agent panes left into the
  // holes finished sessions leave behind (see src/compact.ts). Naming first, so
  // a pane swapped this tick already carries its name into compact.log.
  const compact = makeCompactor();
  setInterval(() => {
    nameNewPanes(SESSION_PREFIX);
    compact(Date.now());
    updateTray();
  }, 4 * 1000);

  // Topic + stage labels for every live chat pane (see src/panetopics.ts). The
  // tick is a tmux listing and a stat per chat; haiku is only called when a rule
  // fires, at most MAX_CONCURRENT at once, and never awaited here.
  const paneTopics = new PaneTopics(undefined, SESSION_PREFIX, () => {
    const db = openDb();
    try {
      return paneLabelConfig(db);
    } finally {
      db.close();
    }
  });
  // Index a live session the moment it appears (and keep its row fresh), rather
  // than waiting for the 10-minute full pass. One transcript at a time.
  const liveIndexer = new LiveIndexer();
  setInterval(() => {
    try {
      const live = liveSessions();
      const db = openDb();
      let indexed: Map<string, number>;
      try {
        indexed = indexedMtimes(db);
      } finally {
        db.close();
      }
      const orchSid = orchSessionId();
      liveIndexer.tick([...live.values()], indexed, Date.now(), (l) => isOrchestratorRef(l, orchSid, { run: tmux }));
    } catch (e) {
      console.error('[loom] live index failed:', (e as Error).message);
    }
  }, 5 * 1000);
  setInterval(() => {
    try {
      paneTopics.tick(liveSessions());
    } catch (e) {
      console.error('[loom] pane topics failed:', (e as Error).message);
    }
  }, 5 * 1000);
});
