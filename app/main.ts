import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from 'electron';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, SERVER_PORT } from '../src/server.ts';
import { openDb } from '../src/db.ts';
import { runPass } from '../src/cli.ts';
import { writeLayout } from '../src/snapshot.ts';
import { restore } from '../src/restore.ts';
import { attachGhosttyTabs } from '../src/ghostty.ts';
import { SESSION_PREFIX } from '../src/paths.ts';
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
import { defaultRunner } from '../src/analyzer.ts';
import { scanTick, triageTick } from '../src/em/index.ts';

// Finder-launched apps inherit a minimal PATH; restore the dirs we shell out to
// (claude, tmux, osascript). Both Homebrew prefixes are included so this works on
// Apple Silicon (/opt/homebrew/bin) and Intel (/usr/local/bin) Macs.
// TMUX_TMPDIR so tmux finds the running server socket.
const home = os.homedir();
process.env.PATH = [
  path.join(home, '.local/bin'),
  '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
  process.env.PATH || '',
].join(':');
process.env.TMUX_TMPDIR = process.env.TMUX_TMPDIR || '/tmp';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1100,
    height: 840,
    title: 'Loom',
    backgroundColor: '#0d0f15',
    show: false,
  });
  win.loadURL(`http://localhost:${SERVER_PORT}/`);
  win.once('ready-to-show', () => win?.show());
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

function showWindow(): void {
  if (!win || win.isDestroyed()) createWindow();
  else {
    win.show();
    win.focus();
  }
}

const paneTints = new PaneTints();

// A chat counts as "working" if its transcript was written in the last few seconds.
const WORKING_MS = 10_000;

// One pass over the world, feeding both the tray counts and the pane tints. They
// want the same three things — the chat rows, the live pane join, and each
// transcript's mtime — so computing them separately would double the DB open, the
// `list-panes` and the full `ps` walk on every 4s tick.
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
      desiredTints(live, lastActive, now, SESSION_PREFIX),
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
  tray.setTitle(parts.length ? ' ' + parts.join(' ') : ' ◍');
  tray.setToolTip(`Loom — ${c.live} live · ${c.working} working · ${c.yourTurn} your turn`);
}

function clearPaneTints(): void {
  const windows = paneTints.clearAll(SESSION_PREFIX);
  if (windows) console.log(`[loom] cleared pane tints across ${windows} window(s)`);
}

function doRestore(): void {
  try {
    const r = restore({ prefix: SESSION_PREFIX });
    const g = r.attach.length
      ? attachGhosttyTabs(r.attach, { attached: attachedSessions(), saved: r.windows })
      : { ok: true, detail: 'every session already has a tab' };
    const detail =
      `Recreated ${r.restored.length} session(s)${r.restored.length ? ': ' + r.restored.join(', ') : ''}\n` +
      (r.skipped.length ? `Already running: ${r.skipped.join(', ')}\n` : '') +
      `\nTabs: ${g.detail}`;
    dialog.showMessageBox({ type: 'info', title: 'Loom', message: 'Workspace restore', detail });
  } catch (e) {
    dialog.showErrorBox('Loom — restore failed', String((e as Error).message));
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

function buildTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Loom', click: showWindow },
      { type: 'separator' },
      { label: 'Restore workspace (after tmux crash)', click: doRestore },
      { label: 'Clear pane tints', click: clearPaneTints },
      { label: 'Refresh now', click: () => void runOnce() },
      { type: 'separator' },
      { label: 'Quit Loom', click: () => { quitting = true; app.quit(); } },
    ]),
  );
  tray.on('click', showWindow);
  updateTray();
}

app.on('second-instance', showWindow);
app.on('window-all-closed', () => {
  /* stay alive in the tray */
});
app.on('before-quit', () => {
  quitting = true;
  // Bracket the quit: the line written here and the one the watcher writes if
  // the server disappears are what tell us whether Loom's exit is implicated.
  noteTmuxState(Date.now(), 'loom-quit');
  // Hand the panes back unstyled. tmux owns pane options, so a tint Loom leaves
  // behind outlives Loom — it sits there until the pane or the server dies.
  clearPaneTints();
});

app.whenReady().then(() => {
  createServer().listen(SERVER_PORT, '127.0.0.1', () => {
    createWindow();
  });

  // The real crash recovery. before-quit handles a clean exit, but nothing fires
  // on SIGKILL, so a killed Loom leaves stale tints on panes it will never see
  // again. Sweep the whole workspace once, unconditionally, BEFORE the first
  // paint below — after it, our own fresh tints would be swept too.
  clearPaneTints();

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
  setInterval(() => {
    nameNewPanes(SESSION_PREFIX);
    updateTray();
  }, 4 * 1000);

  // EM ticks. These must live HERE, not in src/server.ts's `import.meta.url`
  // block — that guard is deliberately false in the bundle, so anything inside
  // it never runs in the packaged app, which is the actual always-on daemon.
  //
  // Fast tick: signals + detectors only, no model calls. A tick with nothing
  // wrong costs nothing, so it is free to run often.
  setInterval(() => {
    const db = openDb();
    try {
      scanTick(db, Object.fromEntries(liveSessions()), Date.now());
    } catch (e) {
      console.error('[loom] em scan failed:', (e as Error).message);
    } finally {
      db.close();
    }
  }, 30 * 1000);

  // Slow tick: one model call per NEW finding. Serialized against itself so a
  // slow pass cannot overlap the next one and double-handle a finding.
  let triaging = false;
  setInterval(() => {
    if (triaging) return;
    triaging = true;
    const db = openDb();
    void triageTick(db, Date.now(), { live: Object.fromEntries(liveSessions()) })
      .catch((e: Error) => console.error('[loom] em triage failed:', e.message))
      .finally(() => {
        db.close();
        triaging = false;
      });
  }, 5 * 60 * 1000);
});
