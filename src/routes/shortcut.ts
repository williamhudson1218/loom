import { execFile } from 'node:child_process';
import fs from 'node:fs';
import type { RouteDef } from './index.ts';
import { isAccelerator } from '../settingsSchema.ts';

// The ⌘⇧L Slack shortcut step: record, conflict check, practice (§5.5).
// Every entry is gated by requireWrite(kind) in src/routes/index.ts before its
// handler runs; tests/auth.test.ts sweeps this list, so a route cannot skip it.

/* ------------------------------------------------------------ accelerators */

const MOD_ORDER = ['Command', 'Control', 'Alt', 'Shift'] as const;
type Mod = (typeof MOD_ORDER)[number];

const MOD_ALIASES: Record<string, Mod> = {
  command: 'Command', cmd: 'Command', commandorcontrol: 'Command', cmdorctrl: 'Command', super: 'Command', meta: 'Command',
  control: 'Control', ctrl: 'Control',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
};

const KEY_ALIASES: Record<string, string> = { esc: 'Escape', enter: 'Return', plus: 'Plus', space: 'Space' };

export interface ParsedAccelerator { mods: Mod[]; key: string }

/** Canonical form of an Electron accelerator, or null when it is not one. Letters upper-case. */
export function parseAccelerator(s: string): ParsedAccelerator | null {
  if (!isAccelerator(s)) return null;
  const parts = s.split('+').map((p) => p.trim());
  const raw = parts[parts.length - 1];
  const mods = new Set<Mod>();
  for (const m of parts.slice(0, -1)) {
    const c = MOD_ALIASES[m.toLowerCase()];
    if (!c) return null; // valid for Electron but not one we classify (e.g. AltGr)
    mods.add(c);
  }
  const key = KEY_ALIASES[raw.toLowerCase()] ?? (raw.length === 1 ? raw.toUpperCase() : raw);
  return { mods: MOD_ORDER.filter((m) => mods.has(m)), key };
}

export function normalizeAccelerator(s: string): string | null {
  const p = parseAccelerator(s);
  return p ? [...p.mods, p.key].join('+') : null;
}

/** What a recorder's keydown event carries. `key` is KeyboardEvent.key, `code` KeyboardEvent.code. */
export interface KeyEventLike { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }

const EVENT_KEYS: Record<string, string> = {
  ' ': 'Space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right',
  escape: 'Escape', enter: 'Return', tab: 'Tab', backspace: 'Backspace', delete: 'Delete',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', insert: 'Insert', '+': 'Plus',
};

/**
 * An accelerator from a keydown. Null while only modifiers are held, and for a
 * bare key: a global shortcut with no modifier would swallow ordinary typing
 * (function keys are the one exception). With Option held `key` is a composed
 * character on macOS, so letters and digits come from `code`.
 */
export function acceleratorFromEvent(e: KeyEventLike): string | null {
  const k = e.key || '';
  if (['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'CapsLock', 'Dead', 'Unidentified'].includes(k)) return null;
  let key: string | undefined = EVENT_KEYS[k.toLowerCase()];
  const code = e.code || '';
  if (!key) {
    if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
    else if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
    else if (/^Digit[0-9]$/.test(code)) key = code.slice(5);
    else if (k.length === 1) key = k.toUpperCase();
  }
  if (!key) return null;
  const mods: Mod[] = [];
  if (e.metaKey) mods.push('Command');
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (!mods.length && !/^F\d+$/.test(key)) return null;
  const acc = [...mods, key].join('+');
  return isAccelerator(acc) ? acc : null;
}

/* ------------------------------------------------------------ conflicts */

/** macOS keeps these for itself; registering them is refused. */
const MACOS_RESERVED = new Set([
  'Command+Space', 'Command+Tab', 'Command+Q', 'Command+Shift+Q', 'Command+Alt+Escape', 'Command+Shift+3', 'Command+Shift+4', 'Command+Shift+5',
  'Control+Command+Q', 'Command+H', 'Command+M', 'Command+W', 'Command+Alt+Q', 'Command+`',
]);

/** Slack desktop's own shortcuts while it is focused; Loom's would override them. */
const SLACK_DESKTOP = new Set([
  'Command+K', 'Command+Shift+K', 'Command+Shift+A', 'Command+Shift+M', 'Command+Shift+T', 'Command+Shift+U', 'Command+Shift+S',
  'Command+Shift+Y', 'Command+Shift+D', 'Command+Shift+E', 'Command+T', 'Command+F', 'Command+G', 'Command+[', 'Command+]',
  'Command+/', 'Command+.', 'Command+N', 'Command+Shift+V', 'Command+Shift+X', 'Command+Shift+C', 'Command+Shift+H', 'Command+Shift+I',
  'Command+Alt+Up', 'Command+Alt+Down', 'Command+Shift+Return', 'Command+U', 'Command+Shift+F',
]);

export type ConflictLevel = 'ok' | 'warn' | 'refuse';
export interface ConflictResult { level: ConflictLevel; code: 'ok' | 'invalid' | 'macos_reserved' | 'slack_desktop' | 'taken' | 'no_modifier'; detail: string; accelerator: string | null }

/**
 * The static half of the conflict check. `taken` is whether Electron's
 * globalShortcut.register returned false (another app holds it); the caller
 * supplies it because only the main process can try.
 */
export function classifyAccelerator(accel: string, opts: { taken?: boolean } = {}): ConflictResult {
  const n = normalizeAccelerator(accel);
  if (!n) return { level: 'refuse', code: 'invalid', detail: 'That is not a shortcut Loom can register.', accelerator: null };
  const p = parseAccelerator(n)!;
  if (!p.mods.length && !/^F\d+$/.test(p.key)) return { level: 'refuse', code: 'no_modifier', detail: 'Add Command, Control or Option so it does not catch ordinary typing.', accelerator: n };
  if (MACOS_RESERVED.has(n)) return { level: 'refuse', code: 'macos_reserved', detail: 'macOS uses this shortcut itself.', accelerator: n };
  if (opts.taken) return { level: 'refuse', code: 'taken', detail: 'Another app or the system already holds this shortcut.', accelerator: n };
  if (SLACK_DESKTOP.has(n)) return { level: 'warn', code: 'slack_desktop', detail: "Slack uses this while it is focused; Loom's would override it.", accelerator: n };
  return { level: 'ok', code: 'ok', detail: '', accelerator: n };
}

/* ------------------------------------------------------------ the main-process host */

/** What only the Electron main process can do; app/main.ts installs it. */
export interface ShortcutHost {
  /** Try to register `accel` and release it again. false when something else holds it. Loom's own current shortcut counts as free. */
  tryRegister(accel: string): boolean;
}

let host: ShortcutHost | null = null;
export function setShortcutHost(h: ShortcutHost | null): void {
  host = h;
}

export function checkShortcut(accel: string): ConflictResult {
  const stat = classifyAccelerator(accel);
  if (stat.level === 'refuse' || !stat.accelerator) return stat;
  let taken = false;
  try {
    taken = host ? !host.tryRegister(stat.accelerator) : false;
  } catch {
    taken = true;
  }
  return taken ? classifyAccelerator(accel, { taken: true }) : stat;
}

/* ------------------------------------------------------------ practice */

export const PRACTICE_TIMEOUT_MS = 60_000;

export interface PracticeResult {
  ok: boolean;
  author?: string;
  channel?: string;
  wouldDo?: 'jump' | 'start';
  project?: string;
  detail?: string;
}
export type PracticeState = { state: 'idle' } | { state: 'armed'; expiresAt: number } | { state: 'done'; result: PracticeResult } | { state: 'timeout' };

/**
 * Practice mode: the wizard arms it, the next hotkey press reports what it
 * would have done instead of doing it, then it disarms. Times out after 60 s.
 */
export class Practice {
  private armedUntil = 0;
  private last: PracticeState = { state: 'idle' };
  constructor(private now: () => number = Date.now) {}
  arm(): void {
    this.armedUntil = this.now() + PRACTICE_TIMEOUT_MS;
    this.last = { state: 'armed', expiresAt: this.armedUntil };
  }
  cancel(): void {
    this.armedUntil = 0;
    this.last = { state: 'idle' };
  }
  armed(): boolean {
    return this.armedUntil > this.now();
  }
  /** Record the press's result; disarms. Ignored when not armed. */
  complete(result: PracticeResult): boolean {
    if (!this.armed()) return false;
    this.armedUntil = 0;
    this.last = { state: 'done', result };
    return true;
  }
  get(): PracticeState {
    if (this.last.state === 'armed' && !this.armed()) this.last = { state: 'timeout' };
    return this.last;
  }
}

export const practice = new Practice();

/* ------------------------------------------------------------ Slack.app */

const SLACK_BUNDLE = 'com.tinyspeck.slackmacgap';

export function findSlackApp(): Promise<string | null> {
  return new Promise((resolve) => {
    const fallback = () => resolve(fs.existsSync('/Applications/Slack.app') ? '/Applications/Slack.app' : null);
    try {
      execFile('mdfind', [`kMDItemCFBundleIdentifier == '${SLACK_BUNDLE}'`], { timeout: 5000, encoding: 'utf8' }, (err, out) => {
        const first = err ? '' : String(out).split('\n').map((s) => s.trim()).find((s) => s.endsWith('.app'));
        if (first) resolve(first);
        else fallback();
      });
    } catch {
      fallback();
    }
  });
}

/* ------------------------------------------------------------ routes */

export const routes: RouteDef[] = [
  {
    // Conflict check. Body {accelerator} or {event: KeyEventLike} from the recorder.
    method: 'POST', path: '/api/shortcut/check', kind: 'browser',
    handler: async (ctx) => {
      const b = await ctx.body();
      if (!b) return ctx.json(400, { ok: false, detail: 'invalid body' });
      const ev = b.event && typeof b.event === 'object' ? (b.event as KeyEventLike) : null;
      const accel = ev ? acceleratorFromEvent(ev) : typeof b.accelerator === 'string' ? b.accelerator : '';
      if (!accel) return ctx.json(200, { ok: true, recorded: false });
      ctx.json(200, { ok: true, recorded: true, ...checkShortcut(accel) });
    },
  },
  {
    // Arm, cancel or simulate practice mode.
    method: 'POST', path: '/api/shortcut/practice', kind: 'browser',
    handler: async (ctx) => {
      const b = await ctx.body();
      const action = b && typeof b.action === 'string' ? b.action : '';
      if (action === 'arm') practice.arm();
      else if (action === 'cancel') practice.cancel();
      else if (action === 'simulate') {
        practice.arm();
        practice.complete({ ok: true, author: 'Sample person', channel: 'C0SAMPLE', wouldDo: 'start', project: '' });
      } else return ctx.json(400, { ok: false, detail: 'action must be arm, cancel or simulate' });
      ctx.json(200, { ok: true, practice: practice.get() });
    },
  },
  {
    method: 'GET', path: '/api/shortcut/practice', kind: 'read', reads: true,
    handler: (ctx) => ctx.json(200, { ok: true, practice: practice.get() }),
  },
  {
    method: 'GET', path: '/api/shortcut/slack-app', kind: 'read', reads: true,
    handler: async (ctx) => {
      const p = await findSlackApp();
      ctx.json(200, { ok: true, found: !!p, path: p });
    },
  },
];
