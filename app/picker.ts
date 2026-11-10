import { app, BrowserWindow, clipboard, globalShortcut, ipcMain, screen, type Rectangle } from 'electron';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { pickedThread, parseSlackThread } from '../src/slackgoto.ts';
import { NEW_THREAD_HTML, OVERLAY_HTML, PASTE_HTML, newThreadWhere } from '../src/pickpages.ts';
import { hoverFor, needsTrustCheck, overlaysMatch, PickMachine, type HoverHit, type PickPhase } from '../src/pickstate.ts';
import { newPressId, pickLog, type LogFields } from '../src/picklog.ts';

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
function prepareOverlays(): void {
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

/** How an open went. Not ok: the overlay shows `detail` in place before it closes. */
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
  }
  helperUntrusted = false;
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
  broadcast('rect', r.rect);
  broadcast('busy', 'Opening…');
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
  if (out && !out.ok) return failPick(out.detail || 'Could not open the chat for this thread');
  endPick('opened');
}

ipcMain.on('loom-pick-click', (_e, msg: ClickMsg) => void onClick(msg));
ipcMain.on('loom-pick-painted', (_e, m: { d?: number; t?: number; vis?: string }) => {
  log('painted', { d: m?.d, ipc_ms: m?.t ? Date.now() - m.t : undefined, vis: m?.vis, phase: machine.phase });
});
