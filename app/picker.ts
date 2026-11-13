import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, type Rectangle } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { pickedThread, parseSlackThread } from '../src/slackgoto.ts';
import { NEW_THREAD_HTML, OVERLAY_HTML, PASTE_HTML, newThreadWhere } from '../src/pickpages.ts';
import { hoverFor, needsTrustCheck, overlaysMatch, pickMayArm, pickMayLook, PickMachine, SLACK_BUNDLE_ID, type HoverHit, type PickPhase, type PickWhere } from '../src/pickstate.ts';
import { frontBundleId } from '../src/frontapp.ts';
import { newPressId, pickLog, type LogFields } from '../src/picklog.ts';
import { helperExe } from '../src/nativehelpers.ts';
import { AX_GRANT_HINT } from '../src/axcopy.ts';
import { lineAsker, type LineAsker } from '../src/lineasker.ts';

// Pick mode for "open the chat for this Slack thread", shaped like the macOS
// screenshot crosshairs: the hotkey covers every display with a transparent,
// click-capturing overlay, the Slack message under the cursor is outlined as
// the mouse moves, a click on one resolves it to its thread parent and hands
// that permalink to /api/slack/thread-goto, and Esc backs out.
//
// What is under the cursor comes from loom-ax (app/native/loom-ax.swift), a
// long-lived helper that hit-tests Slack's Accessibility tree. It is its own
// small app bundle named "Loom" and disclaims Loom.app as its responsible
// process, so the Accessibility grant belongs to the helper (the "Loom" row in
// the list), whose code hash survives Loom updates.

export interface AxRect { x: number; y: number; w: number; h: number }
type HitReply =
  | { ok: true; url: string; rect: AxRect; inThread: boolean; rootUrl: string | null; text?: string; author?: string }
  | { ok: false; reason: 'not_message' | 'covered' | 'no_slack' | 'untrusted' | 'bad_request' | 'helper_down' };

const HIT_EVERY_MS = 100; // ~10 hit-tests a second while the mouse moves

function helperPath(): string {
  // Packaged: extraFiles puts the bundle in Contents/Helpers. Dev (`yarn start`):
  // the build output next to dist/.
  return helperExe(app.isPackaged ? path.join(process.resourcesPath, '..', 'Helpers') : path.join(__dirname, '..', 'build-native'), 'ax');
}

/* ------------------------------------------------------------ the helper */

let helper: ChildProcessWithoutNullStreams | null = null;
// Pending replies, per process: a restarted helper's late `exit` must only
// fail its own requests, not the ones already queued for its replacement.
const askers = new WeakMap<ChildProcessWithoutNullStreams, LineAsker>();
const HELPER_DOWN = '{"ok":false,"reason":"helper_down"}';
// A hit-test or trust check answers in milliseconds. One that has not answered
// in this long never will: the request resolves helper_down and the helper is
// replaced, so a pick is never left waiting on it (src/lineasker.ts keeps the
// reply queue aligned across the timeout).
export const ASK_TIMEOUT_MS = 2_500;

/** Kill a helper that stopped answering; the next ask starts a fresh one. */
function restartHelper(p: ChildProcessWithoutNullStreams): void {
  console.error('[loom] loom-ax did not answer within ' + ASK_TIMEOUT_MS + 'ms; restarting it');
  if (helper === p) helper = null;
  askers.get(p)?.failAll();
  try {
    p.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

function ensureHelper(): ChildProcessWithoutNullStreams {
  if (helper && helper.exitCode === null && !helper.killed) return helper;
  const p = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const asker = lineAsker({
    write: (line) => void p.stdin.write(line),
    timeoutMs: ASK_TIMEOUT_MS,
    down: HELPER_DOWN,
    onTimeout: () => restartHelper(p),
  });
  askers.set(p, asker);
  // Replies come back in request order, one line each.
  readline.createInterface({ input: p.stdout }).on('line', (line) => asker.onLine(line));
  p.stderr.on('data', (d: Buffer) => console.error('[loom] loom-ax:', d.toString().trim()));
  // A write to a helper that just died: the exit handler fails the queue.
  p.stdin.on('error', () => {});
  const fail = () => {
    if (helper === p) helper = null;
    asker.failAll();
  };
  p.on('exit', fail);
  p.on('error', (e) => {
    console.error('[loom] loom-ax failed to start:', e.message);
    fail();
  });
  helper = p;
  return p;
}

async function ask<T>(req: object): Promise<T> {
  let p: ChildProcessWithoutNullStreams;
  try {
    p = ensureHelper();
  } catch {
    return { ok: false, reason: 'helper_down' } as T;
  }
  const line = await askers.get(p)!.ask(JSON.stringify(req) + '\n');
  try {
    return JSON.parse(line) as T;
  } catch {
    return { ok: false, reason: 'helper_down' } as T;
  }
}

export function stopHelper(): void {
  helper?.kill();
  helper = null;
}

/* ------------------------------------------------------------ the overlay */

interface Overlay {
  win: BrowserWindow;
  bounds: Rectangle;
  index: number; // display number, for pick.log
  ready: boolean; // loaded and painted: showing it is instant
}

// The overlays are built once, hidden, and reused for every press: building one
// per press made the crosshairs late and dropped clicks made before they
// appeared (see src/pickstate.ts). They are rebuilt only when the displays change.
let overlays: Overlay[] = [];
const machine = new PickMachine();
let ticker: NodeJS.Timeout | null = null;
let openGuard: NodeJS.Timeout | null = null;
let lastPoint = '';
let busy = false;
let hover: HoverHit<Extract<HitReply, { ok: true }>> | null = null;
// pick.log: one id per press ties its lines together (src/picklog.ts).
let press = '';
let pressAt = 0;
const log = (event: string, fields: LogFields = {}) => pickLog().write(press, event, { ...fields, t: pressAt ? Date.now() - pressAt : undefined });

export function picking(): boolean {
  return machine.phase !== 'idle';
}

/** The current press's log id, so main.ts can log the open under the same id. */
export function currentPress(): string {
  return press;
}

/** Log an event under the current press (main.ts: the open, the server's timings). */
export function pickEvent(event: string, fields: LogFields = {}): void {
  log(event, fields);
}

function overlayFor(bounds: Rectangle, index: number): Overlay {
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
  const o: Overlay = { win: w, bounds, index, ready: false };
  raise(w);
  w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML) + '#' + encodeURIComponent(JSON.stringify({ x: bounds.x, y: bounds.y, d: index })));
  w.once('ready-to-show', () => {
    o.ready = true;
    // Pressed before this display's overlay was ready: show it now.
    if (machine.phase === 'picking' && !w.isDestroyed()) {
      raise(w);
      w.showInactive();
      log('shown-late', { d: index, visible: w.isVisible() });
    }
  });
  w.webContents.on('render-process-gone', (_e, d) => {
    o.ready = false;
    log('overlay-gone', { d: index, reason: d.reason });
  });
  return o;
}

/**
 * Put an overlay above everything and make it take every click. Done on every
 * show, not once at build time: a reused hidden panel is not guaranteed to keep
 * its level or Space membership across hide/show. And the click capture is made
 * explicit: left at its default, macOS decides per pixel for a transparent
 * window, so a click on an overlay whose first frame had not painted yet fell
 * through to Slack, the "first click did nothing" case.
 */
function raise(w: BrowserWindow): void {
  if (w.isDestroyed()) return;
  // Above the menu bar and full-screen apps, like the screenshot crosshairs.
  w.setAlwaysOnTop(true, 'screen-saver');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  w.setIgnoreMouseEvents(false);
}

/** Build the overlays if the displays changed since they were built (or they died). */
export function prepareOverlays(): void {
  const displays = screen.getAllDisplays().map((d) => d.bounds);
  const alive = overlays.every((o) => !o.win.isDestroyed() && !o.win.webContents.isCrashed());
  if (alive && overlaysMatch(overlays.map((o) => o.bounds), displays)) return;
  for (const o of overlays) if (!o.win.isDestroyed()) o.win.destroy();
  overlays = displays.map((b, i) => overlayFor(b, i));
  pickLog().write('-', 'overlays-built', { n: overlays.length });
}

let displaysStale = false;
function onDisplaysChanged(): void {
  // Never rebuild under an open pick; do it once the pick ends.
  if (machine.phase === 'idle') prepareOverlays();
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

/* ------------------------------------------------------------ where a pick may look */

// The helper treats every Loom window as see-through (it skips our process's
// windows so the overlay never hides Slack), so Loom's own main window counts
// as not covering Slack. Loom therefore gates on its own windows and focus
// (src/pickstate.ts, pickMayLook) before it asks the helper anything.
let slackFront: boolean | null = null;
let frontAt = 0;
const FRONT_EVERY_MS = 500;
async function refreshFront(): Promise<void> {
  frontAt = Date.now();
  const id = await frontBundleId().catch(() => null);
  slackFront = id ? id === SLACK_BUNDLE_ID : null;
}
const isOverlay = (w: BrowserWindow) => overlays.some((o) => o.win === w);
function where(): PickWhere {
  const focused = BrowserWindow.getFocusedWindow();
  const loomWindows = BrowserWindow.getAllWindows()
    .filter((w) => !w.isDestroyed() && !isOverlay(w) && w.isVisible() && !w.isMinimized())
    .map((w) => w.getBounds());
  return { loomFocused: !!focused && !isOverlay(focused), slackFrontmost: slackFront, loomWindows };
}

function broadcast(channel: string, payload?: unknown): void {
  for (const o of overlays) if (!o.win.isDestroyed()) o.win.webContents.send(channel, payload);
}

/** End the pick: hide (not destroy) the overlays. Safe to call when idle. */
export function endPick(reason = 'end'): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
  if (openGuard) clearTimeout(openGuard);
  openGuard = null;
  lastPoint = '';
  hover = null;
  const was = machine.end();
  if (was !== 'idle') {
    globalShortcut.unregister('Escape');
    log('end', { reason, phase: was });
  }
  for (const o of overlays) if (!o.win.isDestroyed()) o.win.hide();
  broadcast('reset');
  if (displaysStale) {
    displaysStale = false;
    prepareOverlays();
  }
}

/** Show an error on the overlay, where the user is looking, then end the pick. */
export function failPick(text: string, ms = 2200): void {
  if (machine.phase === 'idle') return;
  if (ticker) clearInterval(ticker);
  ticker = null;
  broadcast('error', text);
  if (openGuard) clearTimeout(openGuard);
  openGuard = setTimeout(() => endPick('error-shown'), ms);
}

/* ------------------------------------------------------------ the open-in-Slack flash */

export const FLASH_SHOW_MS = 1_250; // the overlay's animation is 1.1 s
let flashSeq = 0;

/**
 * Flash rects (global screen points) on the overlays they fall on, click-through
 * and without focus, then hide them. Skipped while a pick is up (the overlays
 * are in use) or when an overlay is not built yet: a missed flash is silent.
 */
export function flashRects(rects: AxRect[]): boolean {
  if (machine.phase !== 'idle' || !rects.length) return false;
  if (!overlays.length) prepareOverlays();
  const seq = ++flashSeq;
  const hits = overlays.filter((o) => o.ready && !o.win.isDestroyed() && rects.some((r) =>
    r.x < o.bounds.x + o.bounds.width && r.x + r.w > o.bounds.x && r.y < o.bounds.y + o.bounds.height && r.y + r.h > o.bounds.y));
  if (!hits.length) return false;
  for (const o of hits) {
    o.win.setAlwaysOnTop(true, 'screen-saver');
    o.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    o.win.setIgnoreMouseEvents(true); // raise() turns click capture back on for the next pick
    o.win.webContents.send('flash', rects);
    o.win.showInactive();
  }
  pickLog().write('-', 'flash', { n: rects.length, d: hits.map((o) => o.index).join(',') });
  setTimeout(() => {
    // A newer flash owns the overlays now, or a pick took them over.
    if (seq !== flashSeq || machine.phase !== 'idle') return;
    for (const o of hits) {
      if (o.win.isDestroyed()) continue;
      o.win.hide();
      o.win.webContents.send('reset');
    }
  }, FLASH_SHOW_MS);
  return true;
}

/** loom-ax `list`: every Slack message in the AX tree with its permalink and frame. */
export function axList(): Promise<{ ok: boolean; messages?: { url: string; rect: AxRect; inThread: boolean; text?: string; author?: string }[] }> {
  return ask({ op: 'list' });
}

function showOverlays(): boolean {
  prepareOverlays();
  broadcast('reset');
  if (!machine.shown(Date.now())) return false;
  for (const o of overlays) {
    if (o.ready && !o.win.isDestroyed()) {
      raise(o.win);
      o.win.showInactive();
      log('shown', { d: o.index, visible: o.win.isVisible(), x: o.bounds.x, y: o.bounds.y, w: o.bounds.width, h: o.bounds.height });
    } else {
      log('not-ready', { d: o.index });
    }
  }
  return true;
}

async function track(): Promise<void> {
  if (busy || machine.phase !== 'picking') return;
  const pt = screen.getCursorScreenPoint();
  const key = `${pt.x},${pt.y}`;
  if (Date.now() - frontAt > FRONT_EVERY_MS) void refreshFront();
  // Over Loom (or with Loom focused) nothing is outlined, and the helper is not asked.
  const gate = pickMayLook(where(), pt.x, pt.y);
  if (gate !== 'ok') {
    if (lastPoint !== 'gated:' + gate) broadcast('rect', null);
    hover = null;
    lastPoint = 'gated:' + gate;
    return;
  }
  if (key === lastPoint) return;
  lastPoint = key;
  busy = true;
  try {
    // root:true, so the outlined message is a complete answer a click can use as is.
    const r = await ask<HitReply>({ op: 'hit', x: pt.x, y: pt.y, root: true });
    if (machine.phase !== 'picking') return;
    if (r.ok) hover = { rect: r.rect, at: Date.now(), hit: r };
    broadcast('rect', r.ok ? r.rect : null);
  } finally {
    busy = false;
  }
}

/** How an open went. Not ok: `detail` is shown as a notification (the overlay is already gone). */
export interface GotoOutcome {
  ok: boolean;
  detail?: string;
}

export interface PickDeps {
  notify: (body: string) => void;
  /** POST the parent permalink (and the clicked message) to the server. Resolves once the chat is on screen. */
  goto: (url: string, picked?: { text?: string; author?: string }) => Promise<GotoOutcome | void>;
  /** slack_paste_fallback: when the message cannot be read, offer a field to paste its link. */
  pasteFallback?: () => boolean;
}

/**
 * Whether the Slack reader may use Accessibility right now, without prompting.
 * The grant belongs to the helper, not to Loom.app, so this asks the helper.
 * `helper_down` means it could not start (not built, or killed).
 */
let statusSaidNo = 0; // when a status poll last heard "not trusted"
export async function axTrusted(): Promise<{ trusted: boolean; helperDown: boolean }> {
  // A process can keep answering no after the switch is turned on, so a helper
  // that said no is restarted before it is asked again (at most every 3 s, the
  // wizard and Settings poll faster than that).
  if (statusSaidNo && Date.now() - statusSaidNo > 3000) {
    stopHelper();
    statusSaidNo = 0;
  }
  const t = await ask<{ trusted?: boolean; reason?: string }>({ op: 'trust' });
  const trusted = t.trusted === true;
  if (!trusted && t.reason !== 'helper_down' && !statusSaidNo) statusSaidNo = Date.now();
  if (trusted) statusSaidNo = 0;
  return { trusted, helperDown: t.reason === 'helper_down' };
}

/**
 * The Grant button (wizard, Settings): ask macOS to show its Accessibility
 * prompt for the helper. The prompt names "Loom" and adds the helper's row to
 * the list, switched off; its Open System Settings button goes to that list.
 * Already trusted: no prompt, just the answer.
 */
export async function axRequest(): Promise<{ trusted: boolean; helperDown: boolean }> {
  const t = await ask<{ trusted?: boolean; reason?: string }>({ op: 'trust', prompt: true });
  prompted = true;
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

const GRANT_HINT = AX_GRANT_HINT + ' Then press the shortcut again.';

/**
 * Enter pick mode, or say why not. Pressing the hotkey again while picking
 * cancels, like a second Esc.
 *
 * The trust that matters is the helper's own, not Loom.app's: it disclaims
 * Loom's responsibility (see the top of loom-ax.swift), so it has its own row
 * in the Accessibility list. A helper that last said no is restarted first,
 * since a process can keep answering no after the switch is turned on.
 */
export async function startPick(deps: PickDeps): Promise<void> {
  const before = machine.phase;
  const act = machine.press(Date.now());
  if (act === 'open') {
    press = newPressId();
    pressAt = Date.now();
  }
  log('press', { act, phase: before });
  if (act === 'ignore') return;
  if (act === 'cancel' || act === 'dismiss') return endPick(act === 'cancel' ? 'press-cancel' : 'press-dismiss');
  pickDeps = deps;
  if (helperUntrusted) stopHelper();
  if (needsTrustCheck(trustedCache)) {
    const t = await ask<{ trusted?: boolean; ok?: boolean; reason?: string }>({ op: 'trust' });
    log('trust', { trusted: t.trusted === true, reason: t.reason });
    if (t.trusted !== true) {
      machine.end();
      if (t.reason === 'helper_down') {
        if (await pasteInstead(deps, 'The Slack reader could not start. Copy the message link in Slack (right-click, Copy link) and paste it here.')) return;
        return deps.notify('The Slack reader failed to start. Quit and reopen Loom.');
      }
      helperUntrusted = true;
      // The prompt adds the helper to the list (switched off) and shows the system
      // dialog that links to it. Once per run: after that the row exists.
      if (!prompted) await ask({ op: 'trust', prompt: true });
      prompted = true;
      if (await pasteInstead(deps, 'Loom cannot read Slack without Accessibility access. Copy the message link in Slack and paste it here.')) return;
      return deps.notify(`Loom needs Accessibility access to read Slack. ${GRANT_HINT}`);
    }
    trustedCache = true;
  }
  helperUntrusted = false;
  // Never arm over a focused Loom window: the helper would read Slack's layout through it.
  await refreshFront();
  const w = where();
  if (!pickMayArm(w)) {
    machine.end();
    log('refused', { reason: 'loom-focused', slack_front: slackFront });
    return deps.notify('Switch to Slack, then press the shortcut to pick a message.');
  }
  if (!showOverlays()) return; // ended (Esc, a second press) during the trust check
  // The overlay never takes focus (see overlayFor), so Esc can only arrive as a
  // global shortcut, held just while picking.
  globalShortcut.register('Escape', () => endPick('esc'));
  ticker = setInterval(() => void track(), HIT_EVERY_MS);
  void track(); // outline what is under the cursor now, not 100 ms from now
}

const OPEN_GUARD_MS = 15_000; // never leave the overlay up on a lost request

// Slack's AX tree can answer late for a part of the page it has not been asked
// about yet (Chromium hit-tests accessibility asynchronously): a few quick
// retries before telling the user to click again.
const RETRY_MS = [60, 120, 200];

/** What the overlay's renderer reports for a mousedown (src/pickpages.ts). */
interface ClickMsg {
  t?: number; // renderer Date.now() at the mousedown
  x?: number; // global screen point of the click
  y?: number;
  d?: number; // display index
  button?: number;
}

async function onClick(msg: ClickMsg = {}): Promise<void> {
  const now = Date.now();
  log('mousedown', { d: msg.d, x: msg.x, y: msg.y, button: msg.button, ipc_ms: msg.t ? now - msg.t : undefined, phase: machine.phase });
  if (!pickDeps || machine.click() === 'drop') {
    log('click-dropped', { reason: pickDeps ? machine.phase : 'no-deps' });
    return;
  }
  const deps = pickDeps;
  // Where the click was, not where the cursor is by the time this runs: the
  // main process can be busy for a moment, and the pointer moves on.
  const cur = screen.getCursorScreenPoint();
  const x = typeof msg.x === 'number' ? msg.x : cur.x;
  const y = typeof msg.y === 'number' ? msg.y : cur.y;
  const gate = pickMayLook(where(), x, y);
  if (gate !== 'ok') {
    machine.retry();
    log('hint', { reason: gate });
    return broadcast('hint', 'Loom is in front there. Click a message in Slack, or press Esc.');
  }
  const tHit = Date.now();
  let r: HitReply;
  let source = 'hover';
  let tries = 0;
  const seen = hoverFor(hover, x, y, tHit);
  if (seen) r = seen;
  else {
    source = 'helper';
    r = await ask<HitReply>({ op: 'hit', x, y, root: true });
    tries = 1;
    for (const wait of RETRY_MS) {
      if (r.ok || r.reason !== 'not_message' || machine.phase !== 'hitting') break;
      await new Promise((res) => setTimeout(res, wait));
      if (machine.phase !== 'hitting') break;
      r = await ask<HitReply>({ op: 'hit', x, y, root: true });
      tries++;
    }
  }
  log('hit', { source, tries, ms: Date.now() - tHit, ok: r.ok, reason: r.ok ? undefined : r.reason, channel: r.ok ? r.url : undefined, in_thread: r.ok ? r.inThread : undefined });
  if (machine.phase !== 'hitting') return log('click-abandoned', { phase: machine.phase }); // cancelled while the hit-test ran
  if (!r.ok) {
    if (r.reason === 'not_message' || r.reason === 'covered') {
      machine.retry();
      log('hint', { reason: r.reason });
      return broadcast('hint', r.reason === 'covered' ? 'Slack is behind another window there.' : 'Not a Slack message. Click a message, or press Esc.');
    }
    endPick('hit-' + r.reason);
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
    endPick('no-permalink');
    if (await pasteInstead(deps, 'That message has no permalink. Copy its link in Slack and paste it here.')) return;
    return deps.notify('That message has no permalink.');
  }
  // Keep the overlay up, saying so, until the chat is on screen (goto calls
  // endPick itself before it shows a prompt). Further clicks are dropped; Esc or
  // the hotkey dismisses the overlay and the open carries on.
  machine.opening();
  if (ticker) clearInterval(ticker);
  ticker = null;
  // The highlight goes the instant the click resolves, synchronously, before
  // any async work: the overlay used to stay up (outline + "Opening…") until
  // the chat was on screen, which read as a lingering blue border. Failures
  // are reported by notification, since the overlay is no longer there.
  for (const o of overlays) if (!o.win.isDestroyed()) o.win.hide();
  broadcast('reset');
  globalShortcut.unregister('Escape');
  openGuard = setTimeout(() => endPick('open-guard'), OPEN_GUARD_MS);
  const tGo = Date.now();
  log('goto-start', { channel: ref.url });
  let out: GotoOutcome | void;
  try {
    out = await deps.goto(ref.url, { text: r.text, author: r.author });
  } catch (e) {
    out = { ok: false, detail: (e as Error).message };
  }
  log('goto-end', { ms: Date.now() - tGo, ok: out ? out.ok : true, phase: machine.phase });
  if (machine.phase as PickPhase !== 'opening') return; // dismissed (Esc, the hotkey) while it opened
  if (out && !out.ok) {
    endPick('open-failed');
    return deps.notify(out.detail || 'Could not open the chat for this thread');
  }
  endPick('opened');
}

ipcMain.on('loom-pick-click', (_e, msg: ClickMsg) => void onClick(msg));
ipcMain.on('loom-pick-painted', (_e, m: { d?: number; t?: number; vis?: string }) => {
  log('painted', { d: m?.d, ipc_ms: m?.t ? Date.now() - m.t : undefined, vis: m?.vis, phase: machine.phase });
});
