import { execFile } from 'node:child_process';
import { deviceStore, type Device, type DevicePrefs, type PushSub } from './devices.ts';
import { loadVapidKeys, sendPush, type PushPayload, type VapidKeys } from './webpush.ts';
import type { SoundEvent } from '../sounds.ts';
import type { Draft } from '../outbox.ts';

// When a phone hears about something. The edges are the ones the Mac already
// reacts to: the plugin's Stop / Notification hooks (your turn, blocked: the same
// events the chat sounds hear), a new pending outbox draft, and a watcher moving
// into needs-you. Suppression mirrors the sounds (background chats, short turns,
// coalescing), then each device's own prefs: which kinds, "only when I'm away"
// (the Mac has had no input for 2 minutes) and quiet hours (22:00 to 07:00 local,
// blocked still allowed).

export type PushKind = 'turn' | 'blocked' | 'draft' | 'watcher';

export interface PushEvent extends PushPayload {
  kind: PushKind;
}

const PREF_FOR: Record<PushKind, keyof DevicePrefs> = { turn: 'turn', blocked: 'blocked', draft: 'drafts', watcher: 'watcher' };
export const AWAY_IDLE_MS = 120_000;
export const PUSH_COALESCE_MS = 5_000;

export interface PushDeps {
  devices(): Device[];
  vapid(): VapidKeys;
  send(sub: PushSub, p: PushPayload): Promise<number>;
  dropEndpoint(endpoint: string): void;
  /** ms since the last keyboard/mouse input on the Mac, or null when unknown. */
  hidIdleMs(): Promise<number | null>;
  now(): number;
}

/** 22:00 to 07:00 local. */
export function inPushQuiet(now: number): boolean {
  const h = new Date(now).getHours();
  return h >= 22 || h < 7;
}

/** `HIDIdleTime` (nanoseconds) from `ioreg -c IOHIDSystem`. */
export function parseHidIdle(out: string): number | null {
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(out);
  return m ? Math.floor(Number(m[1]) / 1e6) : null;
}

export function realHidIdleMs(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile('ioreg', ['-c', 'IOHIDSystem', '-d', '4'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, out) => resolve(err ? null : parseHidIdle(String(out))));
  });
}

const realDeps = (): PushDeps => ({
  devices: () => deviceStore().devices(),
  vapid: () => loadVapidKeys(),
  send: (sub, p) => sendPush(sub, p, loadVapidKeys()),
  dropEndpoint: (e) => deviceStore().dropEndpoint(e),
  hidIdleMs: realHidIdleMs,
  now: () => Date.now(),
});

export class PushDispatcher {
  private last = new Map<string, { at: number; kind: PushKind }>();
  constructor(private deps: PushDeps = realDeps()) {}

  /** Send one event to every device that wants it. Resolves with who got it and why the rest did not. */
  async dispatch(ev: PushEvent): Promise<{ sent: string[]; skipped: Record<string, string> }> {
    const d = this.deps;
    const now = d.now();
    const sent: string[] = [];
    const skipped: Record<string, string> = {};
    let idle: number | null | undefined;
    for (const dev of d.devices()) {
      if (!dev.push) {
        skipped[dev.id] = 'no-subscription';
        continue;
      }
      if (!dev.prefs[PREF_FOR[ev.kind]]) {
        skipped[dev.id] = 'pref-off';
        continue;
      }
      if (dev.prefs.quiet && ev.kind !== 'blocked' && inPushQuiet(now)) {
        skipped[dev.id] = 'quiet';
        continue;
      }
      if (dev.prefs.away) {
        if (idle === undefined) idle = await d.hidIdleMs();
        // Unknown idle sends: better one push too many than a missed one.
        if (idle !== null && idle < AWAY_IDLE_MS) {
          skipped[dev.id] = 'at-mac';
          continue;
        }
      }
      const prev = this.last.get(dev.id);
      if (prev && now - prev.at < PUSH_COALESCE_MS && !(ev.kind === 'blocked' && prev.kind !== 'blocked')) {
        skipped[dev.id] = 'coalesced';
        continue;
      }
      this.last.set(dev.id, { at: now, kind: ev.kind });
      const status = await d.send(dev.push, { title: ev.title, body: ev.body, url: ev.url, tag: ev.tag });
      if (status === 404 || status === 410) {
        d.dropEndpoint(dev.push.endpoint);
        skipped[dev.id] = 'gone';
      } else if (status >= 200 && status < 300) sent.push(dev.id);
      else skipped[dev.id] = `status-${status}`;
    }
    return { sent, skipped };
  }
}

/* ------------------------------------------------------------------ triggers */

export interface ChatInfo {
  key: string;
  topic: string;
  name: string;
  line: string;
}

export interface TriggerDeps {
  /** The live chat a hook event names, or null (not live / unknown). */
  chat(sessionId: string): ChatInfo | null;
  minTurnS(): number;
  now(): number;
}

const one = (s: string, n = 120): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const bodyOf = (name: string, line: string): string => one([name, line].filter(Boolean).join(' · '), 160);

/** A plugin Stop (done) or Notification (blocked) event -> a push, or null when it is suppressed. */
export function chatEventPush(ev: SoundEvent, background: boolean, deps: TriggerDeps): PushEvent | null {
  if (background || ev.reminder) return null;
  if (ev.kind === 'done' && ev.turn_started_at && deps.now() - ev.turn_started_at < deps.minTurnS() * 1000) return null;
  const c = deps.chat(ev.session_id);
  if (!c) return null;
  const blocked = ev.kind === 'blocked';
  return {
    kind: blocked ? 'blocked' : 'turn',
    title: one(`${blocked ? 'Blocked' : 'Your turn'}: ${c.topic || 'a chat'}`, 80),
    body: bodyOf(c.name, c.line),
    url: `/m/#s=${encodeURIComponent(c.key)}`,
    tag: `s-${c.key}`,
  };
}

/** New pending drafts since the last look. The first look only records what is there. */
export class DraftWatch {
  private seen: Set<string> | null = null;
  next(drafts: Pick<Draft, 'id' | 'label' | 'channel' | 'messages'>[], names: (d: Pick<Draft, 'id'>) => string = () => ''): PushEvent[] {
    const ids = new Set(drafts.map((d) => d.id));
    if (!this.seen) {
      this.seen = ids;
      return [];
    }
    const fresh = drafts.filter((d) => !this.seen!.has(d.id));
    this.seen = ids;
    return fresh.map((d) => ({
      kind: 'draft' as const,
      title: one(`New draft: ${d.label || d.channel || 'outbox'}`, 80),
      body: bodyOf(names(d), d.messages?.[0] ?? ''),
      url: '/m/#outbox',
      tag: `d-${d.id}`,
    }));
  }
}

export function watcherPush(id: string, text: string): PushEvent {
  return { kind: 'watcher', title: 'Watcher needs you', body: one(text, 160), url: '/m/', tag: `w-${id}` };
}

let shared: PushDispatcher | null = null;
/** The running Loom's dispatcher. No device with a subscription means nothing is ever sent. */
export function pushDispatcher(): PushDispatcher {
  return (shared ??= new PushDispatcher());
}
export function setPushDispatcher(d: PushDispatcher | null): void {
  shared = d;
}

/** Fire and forget: a push failing never touches the caller. Off under vitest unless a test installs a dispatcher. */
export function pushSoon(ev: PushEvent | null): void {
  if (!ev) return;
  if (process.env.VITEST && !shared) return;
  void pushDispatcher().dispatch(ev).catch(() => {});
}
