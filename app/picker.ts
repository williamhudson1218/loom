import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, type Rectangle } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { pickedThread, parseSlackThread } from '../src/slackgoto.ts';
import { NEW_THREAD_HTML, OVERLAY_HTML, PASTE_HTML, newThreadWhere } from '../src/pickpages.ts';
import { needsTrustCheck, overlaysMatch, pressAction, PickTimer, type PickPhase } from '../src/pickstate.ts';

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
  | { ok: true; url: string; rect: AxRect; inThread: boolean; rootUrl: string | null; text?: string; author?: string }
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

interface Overlay {
  win: BrowserWindow;
  bounds: Rectangle;
  ready: boolean; // loaded and painted: showing it is instant
}

// The overlays are built once, hidden, and reused for every press: building one
// per press made the crosshairs late and dropped clicks made before they
// appeared (see src/pickstate.ts). They are rebuilt only when the displays change.
let overlays: Overlay[] = [];
let phase: PickPhase = 'idle';
let shownAt = 0;
let ticker: NodeJS.Timeout | null = null;
let openGuard: NodeJS.Timeout | null = null;
let lastPoint = '';
let busy = false;
const timer = new PickTimer(!!process.env.LOOM_PICK_TIMING);

export function picking(): boolean {
  return phase !== 'idle';
}

function overlayFor(bounds: Rectangle): Overlay {
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
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });
  const o: Overlay = { win: w, bounds, ready: false };
  // Above the menu bar and full-screen apps, like the screenshot crosshairs.
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML) + '#' + encodeURIComponent(JSON.stringify({ x: bounds.x, y: bounds.y })));
  w.once('ready-to-show', () => {
    o.ready = true;
    // Pressed before this display's overlay was ready: show it now.
    if (phase === 'picking' && !w.isDestroyed()) {
      w.showInactive();
      timer.mark('shown-late');
    }
  });
  return o;
}

/** Build the overlays if the displays changed since they were built (or they died). */
function prepareOverlays(): void {
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  const alive = overlays.every((o) => !o.win.isDestroyed());
  if (alive && overlaysMatch(overlays.map((o) => o.bounds), displays)) return;
  for (const o of overlays) if (!o.win.isDestroyed()) o.win.destroy();
  overlays = displays.map((b) => overlayFor(b));
}

let displaysStale = false;
function onDisplaysChanged(): void {
  // Never rebuild under an open pick; do it once the pick ends.
  if (phase === 'idle') prepareOverlays();
  else displaysStale = true;
}

let warmed = false;
/**
 * Called once the app is ready: start the helper, cache its trust answer and
 * build the overlays, so the first press costs no more than the rest.
 */
export function warmPicker(): void {
  if (warmed) return;
  warmed = true;
  void ask<{ trusted?: boolean }>({ op: 'trust' }).then((t) => {
    if (t.trusted === true) trustedCache = true;
  });
  prepareOverlays();
  screen.on('display-added', onDisplaysChanged);
  screen.on('display-removed', onDisplaysChanged);
  screen.on('display-metrics-changed', onDisplaysChanged);
}

function broadcast(channel: string, payload?: unknown): void {
  for (const o of overlays) if (!o.win.isDestroyed()) o.win.webContents.send(channel, payload);
}

/** End the pick: hide (not destroy) the overlays. Safe to call when idle. */
export function endPick(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  if (openGuard) clearTimeout(openGuard);
  openGuard = null;
  lastPoint = '';
  if (phase !== 'idle') {
    globalShortcut.unregister('Escape');
    timer.mark('hidden');
    if (process.env.LOOM_PICK_TIMING) console.error('[loom] pick timing:', timer.line());
  }
  phase = 'idle';
  for (const o of overlays) if (!o.win.isDestroyed()) o.win.hide();
  broadcast('reset');
  if (displaysStale) {
    displaysStale = false;
    prepareOverlays();
  }
}

function showOverlays(): void {
  prepareOverlays();
  broadcast('reset');
  phase = 'picking';
  shownAt = Date.now();
  let shown = 0;
  for (const o of overlays) {
    if (o.ready && !o.win.isDestroyed()) {
      o.win.showInactive();
      shown++;
    }
  }
  if (shown) timer.mark('shown');
}

async function track(): Promise<void> {
  if (busy || phase !== 'picking') return;
  const pt = screen.getCursorScreenPoint();
  const key = `${pt.x},${pt.y}`;
  if (key === lastPoint) return;
  lastPoint = key;
  busy = true;
  try {
    const r = await ask<HitReply>({ op: 'hit', x: pt.x, y: pt.y });
    if (phase === 'picking') broadcast('rect', r.ok ? r.rect : null);
  } finally {
    busy = false;
  }
}

export interface PickDeps {
  notify: (body: string) => void;
  goto: (url: string, picked?: { text?: string; author?: string }) => Promise<void>; // POST the parent permalink (and the clicked message) to the server
  /** slack_paste_fallback: when the message cannot be read, offer a field to paste its link. */
  pasteFallback?: () => boolean;
}

/**
 * Whether the Slack reader may use Accessibility right now, without prompting.
 * The grant belongs to the helper, not to Loom.app, so this asks the helper.
 * `helper_down` means it could not start (not built, or killed).
 */
export async function axTrusted(): Promise<{ trusted: boolean; helperDown: boolean }> {
  const t = await ask<{ trusted?: boolean; reason?: string }>({ op: 'trust' });
  return { trusted: t.trusted === true, helperDown: t.reason === 'helper_down' };
}

/* ------------------------------------------------------------ paste-the-link fallback */

let pasteWin: BrowserWindow | null = null;

/**
 * Ask for a Slack message link in a small focusable window, prefilled when the
 * clipboard already holds one. Resolves to the thread permalink, or null when
 * cancelled. Only a Slack message link is accepted.
 */
export function askPasteLink(why: string): Promise<string | null> {
  if (pasteWin && !pasteWin.isDestroyed()) pasteWin.destroy();
  const clip = clipboard.readText();
  const prefill = parseSlackThread(clip) ? clip.trim() : '';
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 460, height: 190, title: 'Paste the thread link', resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    pasteWin = w;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('loom-paste-link', onLink);
      if (!w.isDestroyed()) w.destroy();
      resolve(v);
    };
    const onLink = (e: Electron.IpcMainEvent, text: string) => {
      if (e.sender !== w.webContents) return;
      if (!text) return finish(null);
      const ref = parseSlackThread(text);
      if (!ref) return void w.webContents.send('err', 'That is not a Slack message link.');
      finish(ref.url);
    };
    ipcMain.on('loom-paste-link', onLink);
    w.on('closed', () => finish(null));
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PASTE_HTML) + '#' + encodeURIComponent(JSON.stringify({ why, prefill })));
    w.once('ready-to-show', () => { w.show(); w.focus(); });
  });
}

/* ------------------------------------------------------------ new-thread prompt */


let newThreadWin: BrowserWindow | null = null;

/**
 * No chat owns the picked thread: ask for optional context before starting one.
 * Resolves to the context ('' for Send as is), or null when cancelled.
 */
export function askNewThread(info: { channel: string; channelName?: string; author?: string; text?: string; project?: string }): Promise<string | null> {
  if (newThreadWin && !newThreadWin.isDestroyed()) newThreadWin.destroy();
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 480, height: 290, title: 'Start a chat for this thread', resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, show: false, webPreferences: { nodeIntegration: true, contextIsolation: false },
    });
    newThreadWin = w;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('loom-new-thread', onAnswer);
      if (!w.isDestroyed()) w.destroy();
      resolve(v);
    };
    const onAnswer = (e: Electron.IpcMainEvent, a: { start?: boolean; context?: string }) => {
      if (e.sender !== w.webContents) return;
      finish(a?.start ? String(a.context ?? '').trim() : null);
    };
    ipcMain.on('loom-new-thread', onAnswer);
    w.on('closed', () => finish(null));
    const init = { where: newThreadWhere(info), project: info.project ?? '' };
    w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(NEW_THREAD_HTML) + '#' + encodeURIComponent(JSON.stringify(init)));
    w.once('ready-to-show', () => {
      // Loom is in the background (Slack was frontmost), so take focus for the typing.
      app.focus({ steal: true });
      w.show();
      w.focus();
    });
  });
}

async function pasteInstead(deps: PickDeps, why: string): Promise<boolean> {
  if (!deps.pasteFallback?.()) return false;
  const url = await askPasteLink(why);
  if (url) await deps.goto(url, {});
  return true;
}

let helperUntrusted = false; // the helper's last trust answer was no
let trustedCache = false; // the helper has said yes; cleared by an 'untrusted' hit
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
  const act = pressAction({ phase, shownAt, now: Date.now() });
  if (act === 'ignore') return;
  if (act === 'cancel' || act === 'dismiss') return endPick();
  timer.start();
  pickDeps = deps;
  if (helperUntrusted) stopHelper();
  if (needsTrustCheck(trustedCache)) {
    const t = await ask<{ trusted?: boolean; ok?: boolean; reason?: string }>({ op: 'trust' });
    if (t.trusted !== true) {
      if (t.reason === 'helper_down') {
        if (await pasteInstead(deps, 'The Slack reader could not start. Copy the message link in Slack (right-click, Copy link) and paste it here.')) return;
        return deps.notify('The Slack reader (slack-ax) failed to start');
      }
      helperUntrusted = true;
      // The prompt adds slack-ax to the list (switched off) and shows the system
      // dialog that links to it. Once per run: after that the row exists.
      if (!prompted) await ask({ op: 'trust', prompt: true });
      prompted = true;
      if (await pasteInstead(deps, 'Loom cannot read Slack without Accessibility access. Copy the message link in Slack and paste it here.')) return;
      return deps.notify('Loom reads Slack through its helper, slack-ax. ' + GRANT_HINT);
    }
    trustedCache = true;
    timer.mark('trusted');
  }
  helperUntrusted = false;
  if (phase !== 'idle') return; // a second press landed during the trust check
  showOverlays();
  // The overlay never takes focus (see overlayFor), so Esc can only arrive as a
  // global shortcut, held just while picking.
  globalShortcut.register('Escape', endPick);
  ticker = setInterval(() => void track(), HIT_EVERY_MS);
  void track(); // outline what is under the cursor now, not 100 ms from now
}

const OPEN_GUARD_MS = 15_000; // never leave the overlay up on a lost request

const RETRY_MS = 80;

async function onClick(): Promise<void> {
  if (phase !== 'picking' || !pickDeps) return;
  const deps = pickDeps;
  timer.mark('click');
  const pt = screen.getCursorScreenPoint();
  let r = await ask<HitReply>({ op: 'hit', x: pt.x, y: pt.y, root: true });
  // Slack's AX tree can answer late for a part of the page it has not been asked
  // about yet: one quick retry before telling the user to click again.
  if (!r.ok && r.reason === 'not_message') {
    await new Promise((res) => setTimeout(res, RETRY_MS));
    if (phase !== 'picking') return;
    r = await ask<HitReply>({ op: 'hit', x: pt.x, y: pt.y, root: true });
  }
  timer.mark('hit');
  if (phase !== 'picking') return; // cancelled while the hit-test ran
  if (!r.ok) {
    if (r.reason === 'not_message') return broadcast('hint', 'Not a Slack message. Click a message, or press Esc.');
    if (r.reason === 'covered') return broadcast('hint', 'Slack is behind another window there.');
    endPick();
    if (r.reason === 'untrusted') {
      helperUntrusted = true;
      trustedCache = false;
    }
    const why = r.reason === 'no_slack' ? 'Slack is not running. Copy the message link and paste it here.' : r.reason === 'untrusted' ? 'Loom cannot read Slack without Accessibility access. Copy the message link and paste it here.' : 'Loom could not read that message. Copy its link in Slack and paste it here.';
    if (await pasteInstead(deps, why)) return;
    if (r.reason === 'no_slack') return deps.notify('Slack is not running');
    if (r.reason === 'untrusted') return deps.notify(GRANT_HINT);
    return deps.notify('Could not read Slack (' + r.reason + ')');
  }
  const ref = pickedThread(r);
  if (!ref) {
    // No permalink to read: only now is the paste field better than another click.
    endPick();
    if (await pasteInstead(deps, 'That message has no permalink. Copy its link in Slack and paste it here.')) return;
    return deps.notify('That message has no permalink.');
  }
  // Keep the overlay up, saying so, until the chat opens (goto calls endPick
  // itself before it shows a prompt). Further clicks are ignored; Esc or the
  // hotkey dismisses the overlay and the open carries on.
  phase = 'opening';
  if (ticker) clearInterval(ticker);
  ticker = null;
  broadcast('rect', r.rect);
  broadcast('busy', 'Opening…');
  openGuard = setTimeout(endPick, OPEN_GUARD_MS);
  try {
    await deps.goto(ref.url, { text: r.text, author: r.author });
  } finally {
    timer.mark('opened');
    if (phase === 'opening') endPick();
  }
}

ipcMain.on('loom-pick-click', () => void onClick());
