// "Open in Slack" lands on a message but Slack does not mark it, so on a busy
// channel it is unclear which thread you landed on. After the open, Loom finds
// the thread's root message in Slack's Accessibility tree (loom-ax's `list` op,
// the same reader the pick overlay uses) and flashes an outline around it on
// the pick overlay, click-through, for about a second.
//
// Everything here is pure or injected, so it is tested without Electron or
// Slack. The overlay side lives in app/picker.ts (flashRects); main.ts wires the
// two together through setSlackOpenedHook (src/slack.ts).

export interface AxRect { x: number; y: number; w: number; h: number }
export interface ListedMessage { url: string; rect: AxRect; inThread: boolean; text?: string; author?: string }
export interface Display { x: number; y: number; width: number; height: number }

/** `1731000000.123456` from a permalink's `/p1731000000123456`, or null. */
export function permalinkTs(url: string): string | null {
  const m = /\/p(\d{10})(\d{6})(?:[?#/]|$)/.exec(url);
  return m ? `${m[1]}.${m[2]}` : null;
}

/** The channel id in `/archives/<id>/`, or null. */
export function permalinkChannel(url: string): string | null {
  return /\/archives\/([A-Z0-9]+)\//i.exec(url)?.[1] ?? null;
}

const isReply = (url: string) => url.includes('thread_ts=');
const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();

/** Share of a rect that lies on some display, 0..1. */
export function visibleShare(r: AxRect, displays: Display[]): number {
  const area = r.w * r.h;
  if (!(area > 0)) return 0;
  let best = 0;
  for (const d of displays) {
    const w = Math.min(r.x + r.w, d.x + d.width) - Math.max(r.x, d.x);
    const h = Math.min(r.y + r.h, d.y + d.height) - Math.max(r.y, d.y);
    if (w > 0 && h > 0) best = Math.max(best, (w * h) / area);
  }
  return best;
}

// Slack's virtual list keeps a few rows above and below the viewport, and a
// row half under the composer is still the one you landed on.
const MIN_VISIBLE = 0.5;
// AX clips a row to the list's viewport: one scrolled out of view reads as a
// 1-point sliver at the top edge (measured 2026-11-13), not as off-screen.
const MIN_HEIGHT = 20;
const MAX_TARGETS = 2; // the channel row and, when open, the thread pane's root

/**
 * Which on-screen messages are this thread's root. By permalink ts first (the
 * root's own permalink, in the channel view or as the open thread pane's top
 * item). Only when no permalink matches: by the cached root text and author,
 * and only when exactly one message fits, since a wrong flash is worse than none.
 */
export function flashTargets(messages: ListedMessage[], key: string, root: { text: string; author: string } | null, displays: Display[]): AxRect[] {
  const [channel, ts] = key.split('/');
  const onScreen = (m: ListedMessage) => m.rect.h >= MIN_HEIGHT && m.rect.w >= MIN_HEIGHT && visibleShare(m.rect, displays) >= MIN_VISIBLE;
  const roots = messages.filter((m) => !isReply(m.url));
  const byTs = roots.filter((m) => permalinkTs(m.url) === ts && (permalinkChannel(m.url) ?? channel) === channel);
  if (byTs.length) return byTs.filter(onScreen).slice(0, MAX_TARGETS).map((m) => m.rect);
  const want = root ? norm(root.text).slice(0, 80) : '';
  if (want.length < 12) return [];
  const byText = roots.filter((m) => {
    if (!m.text || !norm(m.text).startsWith(want)) return false;
    return !root!.author || !m.author || norm(m.author) === norm(root!.author);
  });
  return byText.length === 1 && onScreen(byText[0]) ? [byText[0].rect] : [];
}

/** Two reads agree on where the targets are: Slack has finished scrolling. */
export function settled(a: AxRect[] | null, b: AxRect[]): boolean {
  if (!a || a.length !== b.length || !b.length) return false;
  return a.every((r, i) => Math.abs(r.x - b[i].x) <= 2 && Math.abs(r.y - b[i].y) <= 2 && Math.abs(r.h - b[i].h) <= 2);
}

export interface FlashDeps {
  /** loom-ax `list`; resolves {ok:false} on any failure. */
  list: () => Promise<{ ok: boolean; messages?: ListedMessage[] }>;
  slackFront: () => Promise<boolean>;
  displays: () => Display[];
  root: () => { text: string; author: string } | null;
  flash: (rects: AxRect[]) => void;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export const FLASH_WAIT_MS = 3_000; // how long Slack gets to come forward and scroll
const POLL_MS = 250;

/**
 * Wait for Slack to come forward and settle, then flash the root. Resolves to
 * why it stopped, for the log; never throws (a missed flash is silent).
 */
export async function flashOpenedThread(key: string, deps: FlashDeps): Promise<'flashed' | 'not_front' | 'not_found' | 'unreadable'> {
  const deadline = deps.now() + FLASH_WAIT_MS;
  let last: AxRect[] | null = null;
  let front = false;
  let readable = false;
  try {
    // A first look after one poll interval: `open` returns before Slack has moved.
    while (true) {
      await deps.sleep(POLL_MS);
      if (deps.now() > deadline) break;
      if (!(await deps.slackFront())) continue;
      front = true;
      const r = await deps.list();
      if (!r.ok || !r.messages) continue;
      readable = true;
      const t = flashTargets(r.messages, key, deps.root(), deps.displays());
      if (settled(last, t)) {
        deps.flash(t);
        return 'flashed';
      }
      last = t.length ? t : null;
    }
    // Out of time while still moving: no flash. An outline where the message
    // was a moment ago is worse than none.
  } catch {
    return 'unreadable';
  }
  return !front ? 'not_front' : readable ? 'not_found' : 'unreadable';
}
