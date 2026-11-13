import { TEST_LINKS_MAX, cleanLinkLabel, cleanTestUrl, parseLinkKind, type TestLinkKind } from './testlinks.ts';

// Links handed over when a session is created (POST /api/cli/sessions `links`).
// The chat's Claude session id does not exist yet, so the links are held against
// the new pane and attached to the chat once a live chat shows in that pane. A
// hold that never gets a chat is dropped when its pane dies or after PENDING_LINKS_TTL_MS.

/** Longer than the board's 25 s launch wait, since a chat can sit on a trust prompt first. */
export const PENDING_LINKS_TTL_MS = 60_000;

export interface NewLink {
  url: string;
  label: string;
  kind: TestLinkKind;
}

export type ParsedLinks = { ok: true; links: NewLink[] } | { ok: false; detail: string };

/** Validate the `links` request field: at most 10, each an http(s) url with an optional label and kind. */
export function parseLinksInput(raw: unknown): ParsedLinks {
  if (raw === undefined) return { ok: true, links: [] };
  if (!Array.isArray(raw)) return { ok: false, detail: 'links must be an array' };
  if (raw.length > TEST_LINKS_MAX) return { ok: false, detail: `links takes at most ${TEST_LINKS_MAX} entries` };
  const links: NewLink[] = [];
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i] as Record<string, unknown> | null;
    if (!l || typeof l !== 'object' || Array.isArray(l)) return { ok: false, detail: `links[${i}] must be an object` };
    const url = cleanTestUrl(l.url);
    if (!url) return { ok: false, detail: `links[${i}].url must be an http(s) URL` };
    if (l.label !== undefined && (typeof l.label !== 'string' || l.label.length > 120)) return { ok: false, detail: `links[${i}].label must be a string of at most 120 characters` };
    const kind = parseLinkKind(l.kind);
    if (!kind) return { ok: false, detail: `links[${i}].kind must be "home" or omitted` };
    links.push({ url, label: cleanLinkLabel(l.label), kind });
  }
  return { ok: true, links };
}

interface Held {
  links: NewLink[];
  at: number;
}

const held = new Map<string, Held>();

/** Hold `links` against a new pane (replacing any earlier hold on the same pane id). */
export function holdLinks(paneId: string, links: NewLink[], now: number): void {
  if (paneId && links.length) held.set(paneId, { links, at: now });
}

export function heldCount(): number {
  return held.size;
}

export function clearHeld(): void {
  held.clear();
}

export interface ResolveOpts {
  now: number;
  /** Live chats right now. */
  live: { session_id: string; pane_id: string }[];
  /** Pane ids that still exist, or null when that is unknown (then only the timeout expires a hold). */
  alivePanes: Set<string> | null;
  attach: (sessionId: string, link: NewLink, at: number) => void;
  ttlMs?: number;
}

/** Attach each hold whose pane now has a live chat; drop holds whose pane died or that timed out. */
export function resolveHeldLinks(o: ResolveOpts): { attached: number; expired: number } {
  let attached = 0;
  let expired = 0;
  for (const [pane, h] of [...held]) {
    const chat = o.live.find((l) => l.pane_id === pane && l.session_id);
    if (chat) {
      h.links.forEach((l, i) => o.attach(chat.session_id, l, o.now - i));
      held.delete(pane);
      attached++;
    } else if ((o.alivePanes && !o.alivePanes.has(pane)) || o.now - h.at > (o.ttlMs ?? PENDING_LINKS_TTL_MS)) {
      held.delete(pane);
      expired++;
    }
  }
  return { attached, expired };
}
