import { app, BrowserWindow, Tray, Menu, nativeImage, dialog } from 'electron';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createServer, SERVER_PORT } from '../src/server.ts';
import { openDb } from '../src/db.ts';
import { runPass } from '../src/cli.ts';
import { writeLayout } from '../src/snapshot.ts';
import { restore } from '../src/restore.ts';
import { liveSessions } from '../src/placements.ts';
import { toChatViews } from '../src/dashboard.ts';
import { defaultRunner } from '../src/analyzer.ts';

// Finder-launched apps inherit a minimal PATH; restore the dirs we shell out to
// (claude, tmux, osascript). TMUX_TMPDIR so tmux finds the running server socket.
const home = os.homedir();
process.env.PATH = [
  path.join(home, '.local/bin'),
  '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin',
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

function computeCounts(): { live: number; working: number; yourTurn: number } {
  try {
    const db = openDb();
    const views = toChatViews(db);
    db.close();
    const byId = new Map(views.map((v) => [v.session_id, v]));
    const now = Date.now();
    let working = 0;
    let yourTurn = 0;
    const live = liveSessions({});
    for (const [sid] of live) {
      const v = byId.get(sid);
      if (!v) continue;
      try {
        if (now - fs.statSync(v.jsonl_path).mtimeMs < 10_000) working++;
      } catch {
        /* gone */
      }
      if (v.state === 'waiting_on_user') yourTurn++;
    }
    return { live: live.size, working, yourTurn };
  } catch {
    return { live: 0, working: 0, yourTurn: 0 };
  }
}

function updateTray(): void {
  if (!tray) return;
  const c = computeCounts();
  const parts: string[] = [];
  if (c.working) parts.push(`⚡${c.working}`);
  if (c.yourTurn) parts.push(`🔵${c.yourTurn}`);
  tray.setTitle(parts.length ? ' ' + parts.join(' ') : ' ◍');
  tray.setToolTip(`Loom — ${c.live} live · ${c.working} working · ${c.yourTurn} your turn`);
}

function doRestore(): void {
  try {
    const r = restore({});
    const detail = r.restored.length
      ? `Recreated ${r.restored.length} session(s): ${r.restored.join(', ')}\n\n` +
        `Open a Ghostty tab per session and attach:\n${r.attach.map((s) => '  ta ' + s).join('\n')}`
      : `Nothing to restore (already running: ${r.skipped.join(', ') || 'none'}).`;
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
});

app.whenReady().then(() => {
  createServer().listen(SERVER_PORT, '127.0.0.1', () => {
    createWindow();
  });
  buildTray();
  app.setLoginItemSettings({ openAtLogin: true });

  // Background work — this app replaces the launchd jobs.
  void runOnce();
  setInterval(() => void runOnce(), 10 * 60 * 1000);
  setInterval(() => {
    try {
      writeLayout(Date.now());
    } catch {
      /* tmux down */
    }
  }, 15 * 1000);
  setInterval(updateTray, 4 * 1000);
});
