import fs from 'node:fs';
import { execFile } from 'node:child_process';
import type { QuietHours } from './settingsSchema.ts';

// Chat sounds. The plugin's Stop and Notification hooks (plugin/loom/hooks/sound.py)
// report "a chat finished" or "a chat is blocked"; everything that decides whether
// that is worth a sound lives here, so a sound means "something you did not already
// know and would act on". decideSound is pure (every rule is unit-tested);
// SoundCoordinator adds the timing: the settle window where a blocked sound beats a
// finished one, and the one-time reminder for a chat that stays blocked.

export type SoundKind = 'done' | 'blocked';

export interface SoundEvent {
  kind: SoundKind;
  session_id: string;
  /** $TMUX_PANE of the chat, '' when it is not in a tmux pane. */
  pane: string;
  /** When the turn began (epoch ms), from the last real user prompt; absent when unknown. */
  turn_started_at?: number;
  /** The repeat of a block that has gone unanswered. */
  reminder?: boolean;
}

export interface SoundCtx {
  doneSound: string;
  blockedSound: string;
  minTurnS: number;
  quiet: QuietHours;
  mutedUntil: number;
  /** The orchestrator, a chat Loom runs for itself, or anything outside a tmux pane. */
  background: boolean;
  /** The user is looking at this chat's pane right now. */
  focused: boolean;
  /** When the last chat sound played (epoch ms, 0 for never). */
  lastPlayedAt: number;
  /** What that sound was for; a blocked chat is never swallowed by a finished one. */
  lastPlayedKind?: SoundKind;
}

export interface Decision {
  /** The macOS sound name to play, or null for silence. */
  play: string | null;
  reason: 'ok' | 'setting-off' | 'muted' | 'quiet-hours' | 'background' | 'focused' | 'short-turn' | 'coalesced';
}

export const COALESCE_MS = 5_000;
export const REMINDER_MS = 10 * 60_000;
/** How long a decided sound waits for a more important one (blocked) to arrive. */
export const SETTLE_MS = 1_500;
/** The sound `system` stands for in a chat sound (the preview uses the same one). */
export const SYSTEM_SOUND = 'Funk';

const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Is `now` (local time) inside the quiet window? Days name the day the window starts on, so one that wraps midnight spills into the next day. */
export function inQuietHours(q: QuietHours, now: number): boolean {
  if (!q.enabled) return false;
  const d = new Date(now);
  const m = d.getHours() * 60 + d.getMinutes();
  const day = d.getDay();
  const s = minutes(q.start);
  const e = minutes(q.end);
  if (s === e) return false;
  if (s < e) return q.days.includes(day) && m >= s && m < e;
  return (m >= s && q.days.includes(day)) || (m < e && q.days.includes((day + 6) % 7));
}

export const isMuted = (mutedUntil: number, now: number): boolean => mutedUntil > now;

/** True when sounds are silenced by the mute or the quiet hours; the banners' sound follows the same rule. */
export function soundsSilenced(s: { mutedUntil: number; quiet: QuietHours }, now: number): 'muted' | 'quiet-hours' | null {
  if (isMuted(s.mutedUntil, now)) return 'muted';
  return inQuietHours(s.quiet, now) ? 'quiet-hours' : null;
}

/** Whether, and what, to play for one event. Rules run in order; the first that says no wins. */
export function decideSound(ev: SoundEvent, ctx: SoundCtx, now: number): Decision {
  const setting = ev.kind === 'done' ? ctx.doneSound : ctx.blockedSound;
  if (setting === 'off') return { play: null, reason: 'setting-off' };
  const silenced = soundsSilenced(ctx, now);
  if (silenced) return { play: null, reason: silenced };
  if (ctx.background) return { play: null, reason: 'background' };
  if (ctx.focused) return { play: null, reason: 'focused' };
  // A turn of unknown length plays: better one sound too many than a missed long run.
  if (ev.kind === 'done' && ev.turn_started_at && now - ev.turn_started_at < ctx.minTurnS * 1000) return { play: null, reason: 'short-turn' };
  const outranks = ev.kind === 'blocked' && ctx.lastPlayedKind === 'done';
  if (ctx.lastPlayedAt && now - ctx.lastPlayedAt < COALESCE_MS && !outranks) return { play: null, reason: 'coalesced' };
  return { play: setting === 'system' ? SYSTEM_SOUND : setting, reason: 'ok' };
}

/* ------------------------------------------------------------ focus */

/** The terminals a chat can be open in. Frontmost + the active pane of an attached tmux window = looking at it. */
export const TERMINAL_APPS = new Set([
  'com.mitchellh.ghostty',
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'org.alacritty',
  'dev.warp.Warp-Stable',
  'co.zeit.hyper',
]);

/** The line `display-message` prints for FOCUS_FORMAT: active in its window, window active in its session, session attached. */
export const FOCUS_FORMAT = '#{pane_active} #{window_active} #{session_attached}';

export function parseFocusLine(out: string): boolean {
  const m = /^(\d+) (\d+) (\d+)$/.exec(out.trim());
  return !!m && m[1] === '1' && m[2] === '1' && Number(m[3]) > 0;
}

/** The user is looking at `pane`: a terminal is frontmost and the pane is what an attached tmux client shows. */
export async function paneFocused(pane: string, deps: { front: () => Promise<string | null>; tmux: (args: string[]) => string }): Promise<boolean> {
  if (!/^%\d+$/.test(pane)) return false;
  const app = await deps.front();
  if (!app || !TERMINAL_APPS.has(app)) return false;
  try {
    return parseFocusLine(deps.tmux(['display-message', '-p', '-t', pane, FOCUS_FORMAT]));
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ playing */

const SOUND_RE = /^[A-Za-z]{2,20}$/;

/** The file for a sound setting, or null when it is not a plain sound name or not installed. Shared with the preview. */
export function soundFile(name: string): string | null {
  if (name === 'off') return null;
  const n = name === 'system' ? SYSTEM_SOUND : name;
  if (!SOUND_RE.test(n)) return null;
  const file = `/System/Library/Sounds/${n}.aiff`;
  return fs.existsSync(file) ? file : null;
}

export function playSound(name: string): void {
  const file = soundFile(name);
  if (file) execFile('afplay', [file], () => {});
}

/* ------------------------------------------------------------ coordinator */

export interface SoundSettings {
  doneSound: string;
  blockedSound: string;
  minTurnS: number;
  quiet: QuietHours;
  mutedUntil: number;
}

export interface SoundDeps {
  settings(): SoundSettings;
  isBackground(ev: SoundEvent): boolean;
  isFocused(ev: SoundEvent): Promise<boolean> | boolean;
  /** The chat has not gone back to working since it blocked. */
  stillBlocked(sessionId: string): boolean;
  play(name: string): void;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}

interface Pending {
  ev: SoundEvent;
  name: string;
  timer: unknown;
}

interface Block {
  timer: unknown;
  reminded: boolean;
  at: number;
}

/** A block older than this is a new block if the chat reports blocked again. */
const BLOCK_FORGET_MS = 60 * 60_000;

export class SoundCoordinator {
  private lastPlayedAt = 0;
  private lastPlayedKind: SoundKind | undefined;
  private pending: Pending | null = null;
  private blocks = new Map<string, Block>();

  constructor(private deps: SoundDeps) {}

  /** Decide one event and, when it earns a sound, queue it. Resolves with the decision; the sound plays after the settle window. */
  async submit(ev: SoundEvent): Promise<Decision> {
    const d = this.deps;
    const now = d.now();
    if (ev.kind === 'done') this.endBlock(ev.session_id);
    if (ev.kind === 'blocked' && !ev.reminder) this.startBlock(ev, now);
    const decision = decideSound(ev, { ...d.settings(), background: d.isBackground(ev), focused: false, lastPlayedAt: this.lastPlayedAt, lastPlayedKind: this.lastPlayedKind }, now);
    if (decision.play === null) return decision;
    // Focus costs a process spawn or two, so it is asked only once nothing else said no.
    if (await d.isFocused(ev)) return { play: null, reason: 'focused' };
    this.queue(ev, decision.play);
    return decision;
  }

  private queue(ev: SoundEvent, name: string): void {
    const d = this.deps;
    if (this.pending) {
      // One sound per window, and the one that wants you beats the one that tells you.
      if (ev.kind === 'blocked' && this.pending.ev.kind === 'done') {
        d.clearTimer(this.pending.timer);
        this.pending = null;
      } else return;
    }
    const p: Pending = { ev, name, timer: null };
    p.timer = d.setTimer(() => {
      if (this.pending === p) this.pending = null;
      this.lastPlayedAt = d.now();
      this.lastPlayedKind = ev.kind;
      d.play(name);
    }, SETTLE_MS);
    this.pending = p;
  }

  private startBlock(ev: SoundEvent, now: number): void {
    const d = this.deps;
    const old = this.blocks.get(ev.session_id);
    if (old && now - old.at < BLOCK_FORGET_MS) return; // the same block, still unanswered: one reminder per block
    if (old) d.clearTimer(old.timer);
    const b: Block = { timer: null, reminded: false, at: now };
    b.timer = d.setTimer(() => void this.remind(ev, b), REMINDER_MS);
    this.blocks.set(ev.session_id, b);
  }

  private endBlock(sessionId: string): void {
    const b = this.blocks.get(sessionId);
    if (!b) return;
    this.deps.clearTimer(b.timer);
    this.blocks.delete(sessionId);
  }

  private async remind(ev: SoundEvent, b: Block): Promise<void> {
    if (b.reminded || this.blocks.get(ev.session_id) !== b) return;
    b.reminded = true;
    if (!this.deps.stillBlocked(ev.session_id)) {
      this.blocks.delete(ev.session_id);
      return;
    }
    await this.submit({ ...ev, reminder: true });
  }

  /** Drop timers (tests, shutdown). */
  stop(): void {
    if (this.pending) this.deps.clearTimer(this.pending.timer);
    this.pending = null;
    for (const b of this.blocks.values()) this.deps.clearTimer(b.timer);
    this.blocks.clear();
  }
}
