import { app, BrowserWindow, globalShortcut, ipcMain, screen, type Rectangle } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { pickedThread } from '../src/slackgoto.ts';

// Pick mode for "open the chat for this Slack thread", shaped like the macOS
// screenshot crosshairs: the hotkey covers every display with a transparent,
// click-capturing overlay, the Slack message under the cursor is outlined as
// the mouse moves, a click on one resolves it to its thread parent and hands
// that permalink to /api/slack/thread-goto, and Esc backs out.
//
// What is under the cursor comes from slack-ax (app/native/slack-ax.swift), a
// long-lived helper that hit-tests Slack's Accessibility tree. It disclaims
// Loom as its responsible process, so the Accessibility grant belongs to the
// helper ("slack-ax" in the list), not to Loom.app.

export interface AxRect { x: number; y: number; w: number; h: number }
type HitReply =
  | { ok: true; url: string; rect: AxRect; inThread: boolean; rootUrl: string | null }
  | { ok: false; reason: 'not_message' | 'covered' | 'no_slack' | 'untrusted' | 'bad_request' | 'helper_down' };

const HIT_EVERY_MS = 100; // ~10 hit-tests a second while the mouse moves

function helperPath(): string {
  // Packaged: extraResources puts it beside app.asar. Dev (`yarn start`): the
  // build output next to dist/.
  return app.isPackaged ? path.join(process.resourcesPath, 'slack-ax') : path.join(__dirname, '..', 'build-native', 'slack-ax');
}

/* ------------------------------------------------------------ the helper */

let helper: ChildProcessWithoutNullStreams | null = null;
// Pending replies, per process: a restarted helper's late `exit` must only
// fail its own requests, not the ones already queued for its replacement.
const queues = new WeakMap<ChildProcessWithoutNullStreams, ((line: string) => void)[]>();

function ensureHelper(): ChildProcessWithoutNullStreams {
  if (helper && helper.exitCode === null && !helper.killed) return helper;
  const p = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting: ((line: string) => void)[] = [];
  queues.set(p, waiting);
  // Replies come back in request order, one line each.
  readline.createInterface({ input: p.stdout }).on('line', (line) => waiting.shift()?.(line));
  p.stderr.on('data', (d: Buffer) => console.error('[loom] slack-ax:', d.toString().trim()));
  const fail = () => {
    if (helper === p) helper = null;
    for (const w of waiting.splice(0)) w('{"ok":false,"reason":"helper_down"}');
  };
  p.on('exit', fail);
  p.on('error', (e) => {
    console.error('[loom] slack-ax failed to start:', e.message);
    fail();
  });
  helper = p;
  return p;
}

function ask<T>(req: object): Promise<T> {
  return new Promise((resolve) => {
    let p: ChildProcessWithoutNullStreams;
    try {
      p = ensureHelper();
    } catch {
      return resolve({ ok: false, reason: 'helper_down' } as T);
    }
    queues.get(p)!.push((line) => {
      try {
        resolve(JSON.parse(line) as T);
      } catch {
        resolve({ ok: false, reason: 'helper_down' } as T);
      }
    });
    p.stdin.write(JSON.stringify(req) + '\n');
  });
}

export function stopHelper(): void {
  helper?.kill();
  helper = null;
}

/* ------------------------------------------------------------ the overlay */

const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none;
    /* not 0: macOS passes clicks through fully transparent pixels */
    background:rgba(0,0,0,0.01)}
  #box{position:fixed;display:none;border:2px solid #4c8dff;border-radius:6px;
    background:rgba(76,141,255,0.14);box-shadow:0 0 0 1px rgba(0,0,0,0.35);pointer-events:none}
  #hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:8px;
    font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;background:rgba(20,22,30,0.88);pointer-events:none}
</style></head><body><div id="box"></div><div id="hint"></div><script>
  const { ipcRenderer } = require('electron');
  const origin = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  const box = document.getElementById('box'), hint = document.getElementById('hint');
  const IDLE = 'Click a Slack message to open its chat. Esc cancels.';
  hint.textContent = IDLE;
  let timer = 0;
  ipcRenderer.on('rect', (_e, r) => {
    if (!r) { box.style.display = 'none'; return; }
    Object.assign(box.style, { display: 'block', left: (r.x - origin.x - 2) + 'px', top: (r.y - origin.y - 2) + 'px', width: r.w + 'px', height: r.h + 'px' });
  });
  ipcRenderer.on('hint', (_e, text) => {
    hint.textContent = text;
    clearTimeout(timer);
    timer = setTimeout(() => { hint.textContent = IDLE; }, 1800);
  });
  window.addEventListener('mousedown', (e) => { e.preventDefault(); ipcRenderer.send('loom-pick-click'); });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
</script></body></html>`;

let overlays: BrowserWindow[] = [];
let ticker: NodeJS.Timeout | null = null;
let lastPoint = '';
let busy = false;

export function picking(): boolean {
  return overlays.length > 0;
}

function overlayFor(bounds: Rectangle): BrowserWindow {
  const w = new BrowserWindow({
    ...bounds,
    // A non-activating panel: showing it, and clicking it, never activates Loom
    // or raises a Loom window, so the frontmost app keeps focus and Cmd-Tab
    // works with the crosshairs up. It can never be key, so no keyboard input.
    type: 'panel',
    focusable: false,
    acceptFirstMouse: true, // the first click is the pick, not a focus click
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    enableLargerThanScreen: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  // Above the menu bar and full-screen apps, like the screenshot crosshairs.
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML) + '#' + encodeURIComponent(JSON.stringify({ x: bounds.x, y: bounds.y })));
  w.once('ready-to-show', () => w.showInactive());
  return w;
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of overlays) if (!w.isDestroyed()) w.webContents.send(channel, payload);
}

function closeOverlays(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  lastPoint = '';
  globalShortcut.unregister('Escape');
  for (const w of overlays) if (!w.isDestroyed()) w.destroy();
  overlays = [];
}

async function track(): Promise<void> {
  if (busy) return;
  const pt = screen.getCursorScreenPoint();
  const key = `${pt.x},${pt.y}`;
  if (key === lastPoint) return;
  lastPoint = key;
  busy = true;
  try {
    const r = await ask<HitReply>({ op: 'hit', x: pt.x, y: pt.y });
    if (picking()) broadcast('rect', r.ok ? r.rect : null);
  } finally {
    busy = false;
  }
}

export interface PickDeps {
  notify: (body: string) => void;
  goto: (url: string) => Promise<void>; // POST the parent permalink to the server
}

let helperUntrusted = false; // the helper's last trust answer was no
let prompted = false; // the system dialog has been shown this run
let pickDeps: PickDeps | null = null;

const GRANT_HINT = 'Switch on "slack-ax" in System Settings, Privacy & Security, Accessibility, then press the hotkey again.';

/**
 * Enter pick mode, or say why not. Pressing the hotkey again while picking
 * cancels, like a second Esc.
 *
 * The trust that matters is slack-ax's own, not Loom's: the helper disclaims
 * Loom's responsibility (see the top of slack-ax.swift), so it has its own row
 * in the Accessibility list. A helper that last said no is restarted first,
 * since a process can keep answering no after the switch is turned on.
 */
export async function startPick(deps: PickDeps): Promise<void> {
  if (picking()) return closeOverlays();
  pickDeps = deps;
  if (helperUntrusted) stopHelper();
  const t = await ask<{ trusted?: boolean; ok?: boolean; reason?: string }>({ op: 'trust' });
  if (t.trusted !== true) {
    if (t.reason === 'helper_down') return deps.notify('The Slack reader (slack-ax) failed to start');
    helperUntrusted = true;
    // The prompt adds slack-ax to the list (switched off) and shows the system
    // dialog that links to it. Once per run: after that the row exists.
    if (!prompted) await ask({ op: 'trust', prompt: true });
    prompted = true;
    return deps.notify('Loom reads Slack through its helper, slack-ax. ' + GRANT_HINT);
  }
  helperUntrusted = false;
  overlays = screen.getAllDisplays().map((d) => overlayFor(d.bounds));
  // The overlay never takes focus (see overlayFor), so Esc can only arrive as a
  // global shortcut, held just while picking.
  globalShortcut.register('Escape', closeOverlays);
  ticker = setInterval(() => void track(), HIT_EVERY_MS);
}

async function onClick(): Promise<void> {
  if (!picking() || !pickDeps) return;
  const deps = pickDeps;
  const pt = screen.getCursorScreenPoint();
  const r = await ask<HitReply>({ op: 'hit', x: pt.x, y: pt.y, root: true });
  if (!r.ok) {
    if (r.reason === 'not_message') return broadcast('hint', 'Not a Slack message. Click a message, or press Esc.');
    if (r.reason === 'covered') return broadcast('hint', 'Slack is behind another window there.');
    closeOverlays();
    if (r.reason === 'no_slack') return deps.notify('Slack is not running');
    if (r.reason === 'untrusted') {
      helperUntrusted = true;
      return deps.notify(GRANT_HINT);
    }
    return deps.notify('Could not read Slack (' + r.reason + ')');
  }
  const ref = pickedThread(r);
  if (!ref) return broadcast('hint', 'That message has no permalink.');
  closeOverlays();
  await deps.goto(ref.url);
}

ipcMain.on('loom-pick-click', () => void onClick());
