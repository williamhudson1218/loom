import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TOOL_DIR } from '../paths.ts';
import type { RouteCtx, RouteDef } from '../routes/index.ts';
import type { Agent } from '../types.ts';
import type { LiveLoc } from '../dashboard.ts';
import type { Draft } from '../outbox.ts';
import type { FreshItem } from '../outboxfresh.ts';
import { readTranscript } from '../transcript.ts';
import { clearCookieHeader, deviceCookie, deviceStore, setCookieHeader, type Device } from './devices.ts';
import { applyServe, clearLeftoverServe, realTailscaleDeps, tailscaleStatus, type PhoneAccess, type TailscaleDeps } from './tailscale.ts';
import { portRange, preferredPort } from '../serverport.ts';
import { loadVapidKeys, validSubscription } from './webpush.ts';
import { mobileFile } from './web.ts';

// The phone's API (/m/api/*). The gate (src/routes/index.ts) has already checked
// Host, the same-origin Origin on writes, and (kind `device`) the device cookie
// before any handler here runs. What a phone may do is deliberately narrow:
// read sessions/transcripts/outbox, type a line into a live Claude pane, send Esc
// to one, close a live Claude or Codex chat the way the desktop's Close does, act on outbox drafts through the desktop's own send/discard/redraft, and
// manage its own notifications and pairing. No raw keys, no terminal, no settings.

/* ------------------------------------------------------------------ deps */

/** One live chat on the board (standing watcher chats and the orchestrator already left out). */
export interface MobileChat {
  agent: Agent;
  session_id: string;
  title: string;
  project: string;
  state: string;
  jsonl_path: string;
  last_active_at: number;
  last_turn_at: number;
  live: LiveLoc;
  /** Saved for later (a live saved chat is rare: saving one frees its pane). */
  saved?: boolean;
  /** Send & park: 'waiting' on someone, or 'replied' (someone answered). */
  parked?: '' | 'waiting' | 'replied';
  /** The sidebar group the chat was moved into (chatgroups.ts). */
  group?: { id: number; name: string } | null;
}

export interface SidebarGroup {
  id: number;
  name: string;
}

export interface OutboxResult {
  status: number;
  body: Record<string, unknown>;
}

export interface MobileDeps {
  chats(): MobileChat[];
  /** The user's sidebar groups in display order (chatgroups.ts listGroups). */
  groups(): SidebarGroup[];
  tail(c: MobileChat): string;
  /** tmux, for `display-message` and the interrupt's `send-keys`. Tests inject a fake: never a real pane. */
  tmux(args: string[]): string;
  /** Type a line into a pane and submit it (src/goto.ts sendToPane). */
  send(paneId: string, text: string, agent: Agent): { ok: boolean; detail: string };
  /** End the agent in a pane, the desktop's Close (src/goto.ts closeSession). */
  close(paneId: string, agent: Agent): { ok: boolean; detail: string };
  drafts(): Draft[];
  fresh?(d: Draft): Promise<FreshItem[]>;
  outboxSend(body: Record<string, unknown>): Promise<OutboxResult>;
  outboxDiscard(id: string): Promise<OutboxResult>;
  outboxRedraft(id: string): Promise<OutboxResult>;
  /** The port Loom is serving on (tailscale serve proxies to it). */
  port(): number;
  /** Where phone photo uploads land (0700). Tests point it at a temp dir. */
  uploadsDir(): string;
  tailscale: TailscaleDeps;
}

const unwired = (): never => {
  throw new Error('mobile deps not wired');
};

let deps: MobileDeps = {
  chats: () => [],
  groups: () => [],
  tail: () => '',
  tmux: unwired,
  send: () => ({ ok: false, detail: 'not wired' }),
  close: () => ({ ok: false, detail: 'not wired' }),
  drafts: () => [],
  outboxSend: async () => ({ status: 503, body: { ok: false, detail: 'not wired' } }),
  outboxDiscard: async () => ({ status: 503, body: { ok: false, detail: 'not wired' } }),
  outboxRedraft: async () => ({ status: 503, body: { ok: false, detail: 'not wired' } }),
  port: () => 4317,
  uploadsDir: () => path.join(TOOL_DIR, 'uploads', 'mobile'),
  tailscale: realTailscaleDeps,
};

/** server.ts fills these in; tests pass fakes. Returns the previous set. */
export function setMobileDeps(over: Partial<MobileDeps>): MobileDeps {
  const prev = deps;
  deps = { ...deps, ...over };
  return prev;
}

/* ------------------------------------------------------------------ phone access */

// The wish (on/off + the tailnet name) is persisted in devices.json and re-applied
// at startup, since the port may have moved. The gate reads tailnetHostNow().

let lastAccess: PhoneAccess | null = null;
let lastCheckAt = 0;

/** The Host the gate lets through to /m/: the tailnet name, only while Phone access is on. */
export function tailnetHostNow(): string | null {
  const w = deviceStore().phoneAccess();
  return w.on && w.host ? w.host : null;
}

export async function setPhoneAccess(on: boolean): Promise<PhoneAccess> {
  const r = await applyServe(on, deps.port(), deps.tailscale);
  const prev = deviceStore().phoneAccess();
  deviceStore().setPhoneAccess({ on, host: r.host ?? prev.host });
  lastAccess = r.access;
  lastCheckAt = Date.now();
  return r.access;
}

/** Startup: re-apply serve for the port this run picked, when Phone access was left on. */
export async function reapplyPhoneAccess(): Promise<PhoneAccess | null> {
  if (!deviceStore().phoneAccess().on) {
    // Off: a serve on 443 that an earlier run left pointing at Loom is turned off; anything else is left alone.
    const ports = [...new Set([...portRange(preferredPort()), deps.port()])];
    await clearLeftoverServe(ports, deps.tailscale);
    return null;
  }
  return setPhoneAccess(true);
}

/** For Settings › Devices. Re-checks Tailscale at most every 30 s. */
export async function phoneAccessView(): Promise<PhoneAccess> {
  const w = deviceStore().phoneAccess();
  if (lastAccess && Date.now() - lastCheckAt < 30_000 && lastAccess.on === w.on) return lastAccess;
  const s = await tailscaleStatus(deps.tailscale);
  lastCheckAt = Date.now();
  if (!s.ok) lastAccess = { on: w.on, state: s.state, detail: s.detail };
  else {
    if (w.on && s.host !== w.host) deviceStore().setPhoneAccess({ on: true, host: s.host });
    lastAccess = w.on && lastAccess?.state === 'error' ? { ...lastAccess, url: `https://${s.host}/m/` } : { on: w.on, state: w.on ? 'on' : 'off', url: `https://${s.host}/m/` };
  }
  return lastAccess;
}

/** Tests: forget the cached view. */
export function resetPhoneAccessCache(): void {
  lastAccess = null;
  lastCheckAt = 0;
}

/* ------------------------------------------------------------------ sessions */

// The desktop sidebar's status sections (src/grouping.ts STATUS_GROUPS / statusGroupOf), for
// the live chats the phone lists. Closed never applies: a Send & close chat is off the phone.
export type Status = 'working' | 'turn' | 'waiting' | 'saved' | 'recent';
export const STATUS_SECTIONS: { key: Status; name: string }[] = [
  { key: 'working', name: 'Working' },
  { key: 'turn', name: 'Your turn' },
  { key: 'waiting', name: 'Waiting on others' },
  { key: 'saved', name: 'Saved for later' },
  { key: 'recent', name: 'Recent' },
];

/** statusGroupOf with the dashboard's predicates: parked first, then saved, working, your turn (live and waiting_on_user), else Recent. */
export function statusOf(c: Pick<MobileChat, 'state' | 'parked' | 'saved'> & { live: Pick<LiveLoc, 'working'> }): Status {
  if (c.parked === 'waiting') return 'waiting';
  if (c.parked === 'replied') return 'turn';
  if (c.saved) return 'saved';
  if (c.live.working) return 'working';
  if (c.state === 'waiting_on_user') return 'turn';
  return 'recent';
}

const fresh = (c: MobileChat): number => c.last_turn_at || c.last_active_at;
export const sessionKey = (c: Pick<MobileChat, 'agent' | 'session_id'>): string => `${c.agent}:${c.session_id}`;
const paneRef = (l: LiveLoc): string => `${l.tmux_session}:${l.window_index}.${l.pane_index}`;
const STAGES = new Set(['discovery', 'implementation', 'shipping', 'thread', 'blocked']);

/** Every pane's @topic, from ONE `tmux list-panes -a` call. Empty on any failure. */
export function paneTopics(tmux: (args: string[]) => string): Map<string, string> {
  const out = new Map<string, string>();
  let text = '';
  try {
    text = tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{@topic}']);
  } catch {
    return out;
  }
  for (const line of text.split('\n')) {
    const i = line.indexOf('\t');
    if (i < 0) continue;
    const id = line.slice(0, i).trim();
    const topic = line.slice(i + 1).trim();
    if (/^%\d+$/.test(id) && topic) out.set(id, topic);
  }
  return out;
}

export function sessionRow(c: MobileChat, tail: string, topics: Map<string, string> = new Map(), drafts = 0) {
  const g = statusOf(c);
  return {
    key: sessionKey(c),
    name: c.live.name ?? '',
    topic: topics.get(c.live.pane_id) || c.title || 'Untitled',
    stage: STAGES.has(c.live.stage ?? '') ? c.live.stage! : 'implementation',
    group: g,
    project: c.project,
    last_active_at: fresh(c),
    tail: g === 'working' ? '' : tail,
    pane: paneRef(c.live),
    drafts,
  };
}

export type SessionRow = ReturnType<typeof sessionRow>;
export interface SessionSection {
  key: string;
  name: string;
  kind: 'group' | 'status';
  sessions: SessionRow[];
}

/** Pending drafts per session id. */
export function draftCounts(drafts: Pick<Draft, 'session_id'>[]): Map<string, number> {
  const n = new Map<string, number>();
  for (const d of drafts) if (d.session_id) n.set(d.session_id, (n.get(d.session_id) ?? 0) + 1);
  return n;
}

/**
 * The phone's list, laid out like the desktop sidebar: the user's groups first (drag order,
 * only those with a live chat here), then the status sections in desktop order for the rest.
 * Every section is most recently active first, ties on key. counts are by status over every
 * chat, grouped or not, so the badge still counts every chat whose turn it is.
 */
export function sessionsPayload(
  chats: MobileChat[],
  tail: (c: MobileChat) => string,
  drafts: Pick<Draft, 'session_id'>[],
  topics: Map<string, string> = new Map(),
  groups: SidebarGroup[] = [],
) {
  const nDrafts = draftCounts(drafts);
  const rows = chats.map((c) => ({ c, st: statusOf(c), key: sessionKey(c) }));
  rows.sort((a, b) => fresh(b.c) - fresh(a.c) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const counts: Record<Status, number> = { working: 0, turn: 0, waiting: 0, saved: 0, recent: 0 };
  for (const r of rows) counts[r.st]++;
  const known = new Set(groups.map((g) => g.id));
  const byGroup = new Map<number, SessionRow[]>();
  const byStatus = new Map<Status, SessionRow[]>();
  for (const r of rows) {
    const row = sessionRow(r.c, r.st === 'working' ? '' : tail(r.c), topics, nDrafts.get(r.c.session_id) ?? 0);
    const gid = r.c.group?.id;
    if (gid && known.has(gid)) (byGroup.get(gid) ?? byGroup.set(gid, []).get(gid)!).push(row);
    else (byStatus.get(r.st) ?? byStatus.set(r.st, []).get(r.st)!).push(row);
  }
  const sections: SessionSection[] = [];
  for (const g of groups) {
    const s = byGroup.get(g.id);
    if (s?.length) sections.push({ key: `g:${g.id}`, name: g.name, kind: 'group', sessions: s });
  }
  for (const st of STATUS_SECTIONS) {
    const s = byStatus.get(st.key);
    if (s?.length) sections.push({ key: st.key, name: st.name, kind: 'status', sessions: s });
  }
  return { sections, counts, outbox_pending: drafts.length };
}

/** Claude Code shows in tmux as its version string (2.1.233) or `claude`. */
export const isClaudeCommand = (cmd: string): boolean => /^\d+\.\d+\.\d+$/.test(cmd.trim()) || cmd.trim() === 'claude';
/** The pane is running the chat's own agent right now. Codex shows as `codex` (native install) or `node` (the npm launcher). */
export const isAgentCommand = (agent: Agent, cmd: string): boolean => (agent === 'codex' ? /^(codex|node)$/.test(cmd.trim()) : isClaudeCommand(cmd));

function paneCommand(paneId: string): string {
  if (!/^%\d+$/.test(paneId)) return '';
  try {
    return deps.tmux(['display-message', '-p', '-t', paneId, '#{pane_current_command}']).trim();
  } catch {
    return '';
  }
}

const findChat = (key: unknown): MobileChat | undefined => (typeof key === 'string' ? deps.chats().find((c) => sessionKey(c) === key) : undefined);

/** One line for a tool call: its name and the input that says what it did. */
export function toolLine(name: string, input: unknown): string {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const pick = ['description', 'command', 'file_path', 'path', 'pattern', 'url', 'query', 'prompt', 'skill'].map((k) => i[k]).find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const what = (pick ?? '').replace(/\s+/g, ' ').trim();
  return what ? `${name}: ${what.length > 100 ? what.slice(0, 100) + '…' : what}` : name;
}

export interface MobileMsg {
  role: 'user' | 'assistant' | 'tool';
  text: string;
}

/** The last ~100 messages, tool calls as one-liners. Claude transcripts only carry tool calls; Codex uses the shared reader. */
export function mobileTranscript(agent: Agent, jsonlPath: string, limit = 100): MobileMsg[] {
  if (agent !== 'claude') return readTranscript(agent, jsonlPath, { limit }).map((m) => ({ role: m.role, text: m.text }));
  let text = '';
  try {
    const st = fs.statSync(jsonlPath);
    const start = Math.max(0, st.size - 400_000);
    const fd = fs.openSync(jsonlPath, 'r');
    try {
      const buf = Buffer.alloc(st.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      text = buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
  } catch {
    return [];
  }
  const out: MobileMsg[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o: { type?: string; isMeta?: boolean; message?: { role?: string; content?: unknown } };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const content = o.message?.content;
    if (o.type === 'user' && o.message?.role === 'user' && !o.isMeta) {
      const t = typeof content === 'string' ? content.trim() : Array.isArray(content) ? content.filter((b) => b?.type === 'text' && typeof b.text === 'string').map((b) => b.text.trim()).join('\n').trim() : '';
      if (t) out.push({ role: 'user', text: t });
    } else if (o.type === 'assistant' && o.message?.role === 'assistant') {
      if (typeof content === 'string') {
        if (content.trim()) out.push({ role: 'assistant', text: content.trim() });
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) out.push({ role: 'assistant', text: b.text.trim() });
        else if (b?.type === 'tool_use' && typeof b.name === 'string') out.push({ role: 'tool', text: toolLine(b.name, b.input) });
      }
    }
  }
  return out.slice(-limit);
}

/* ------------------------------------------------------------------ outbox */

/** Where a draft's conversation lives, for the phone's Open link: the Slack thread, the PR, or
 *  the channel (slack.com/app_redirect opens it in the Slack app). Email drafts have none. */
export function draftUrl(d: Draft): string | undefined {
  if (d.review && !d.messages?.length) return /^[\w.-]+\/[\w.-]+$/.test(d.review.repo) && Number.isInteger(Number(d.review.pr)) ? `https://github.com/${d.review.repo}/pull/${d.review.pr}` : undefined;
  if (d.kind === 'email' || d.email) return undefined;
  if (d.thread_url && /^https:\/\/[\w-]+\.slack\.com\//.test(d.thread_url)) return d.thread_url;
  if (d.channel && /^[CDG][A-Z0-9]+$/.test(d.channel)) return `https://slack.com/app_redirect?channel=${d.channel}`;
  return undefined;
}

export function draftKind(d: Draft): 'thread' | 'dm' | 'channel' | 'email' | 'review' {
  if (d.review && !d.messages?.length) return 'review';
  if (d.kind === 'email' || d.email) return 'email';
  if (d.thread_ts || d.thread_url) return 'thread';
  if ((d.label ?? '').startsWith('@') || /^D[A-Z0-9]+$/.test(d.channel)) return 'dm';
  return 'channel';
}

function draftWhere(d: Draft): { where: string; ctx: string } {
  if (d.review && !d.messages?.length) return { where: `${d.review.repo}#${d.review.pr}`, ctx: d.review.title ?? '' };
  if (d.email) return { where: d.email.to.join(', '), ctx: d.email.subject };
  return { where: d.label || d.channel, ctx: d.thread_url ?? '' };
}

function draftMessages(d: Draft): string[] {
  if (d.messages?.length) return d.messages;
  if (d.email) return [d.email.html ? d.email.body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : d.email.body];
  if (d.review) return [d.review.body, ...d.review.comments.map((c) => `${c.path}: ${c.body}`)].filter(Boolean);
  return [];
}

export async function outboxPayload(drafts: Draft[], chats: MobileChat[], freshFor?: (d: Draft) => Promise<FreshItem[]>) {
  const names = new Map(chats.map((c) => [c.session_id, c.live.name ?? '']));
  const rows = await Promise.all(
    drafts.map(async (d) => {
      let items: FreshItem[] = [];
      if (freshFor) {
        try {
          items = await Promise.race([freshFor(d), new Promise<FreshItem[]>((r) => setTimeout(() => r([]), 3000).unref?.())]);
        } catch {
          items = [];
        }
      }
      const { where, ctx } = draftWhere(d);
      const stale = !!d.stale || items.length > 0;
      return {
        id: d.id,
        kind: draftKind(d),
        where,
        ctx,
        from: names.get(d.session_id) ?? '',
        url: draftUrl(d),
        created_at: d.created_at,
        messages: draftMessages(d),
        stale,
        ...(d.stale_reason ? { stale_note: d.stale_reason } : items.length ? { stale_note: `${items.length} new message${items.length === 1 ? '' : 's'} since this was drafted` } : {}),
        ...(items.length ? { new_messages: items.map((i) => ({ who: i.author, text: i.snippet })) } : {}),
      };
    }),
  );
  // Newest first. created_at is local 'YYYY-MM-DDTHH:MM:SS', so string order is time order.
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  return { drafts: rows };
}

/* ------------------------------------------------------------------ handlers */

/** The device the gate already verified; touches last_seen. */
function me(ctx: RouteCtx): Device {
  const d = deviceStore().verify(deviceCookie(ctx.req.headers.cookie));
  if (!d) throw new Error('not paired'); // unreachable: the gate refused it
  deviceStore().touch(d.id);
  return d;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

// A burst limit on POST /m/api/pair across all callers, on top of the code's own 5 tries.
let pairHits: number[] = [];
export const PAIR_RATE = { max: 10, windowMs: 60_000 };
export function resetPairRate(): void {
  pairHits = [];
}

async function pair(ctx: RouteCtx): Promise<void> {
  const now = Date.now();
  pairHits = pairHits.filter((t) => now - t < PAIR_RATE.windowMs);
  if (pairHits.length >= PAIR_RATE.max) return ctx.json(429, { ok: false, detail: 'too many pairing attempts; wait a minute' });
  pairHits.push(now);
  const b = await ctx.body();
  if (!b) return ctx.json(400, { ok: false, detail: 'invalid body' });
  const r = deviceStore().requestPairing(b.code, b.name);
  if (!r.ok) return ctx.json(r.status, { ok: false, detail: r.detail });
  ctx.json(200, { ok: true, pending_id: r.pending_id, claim: r.claim });
}

function pairStatus(ctx: RouteCtx): void {
  const r = deviceStore().pairStatus(ctx.url.searchParams.get('id'), ctx.url.searchParams.get('claim'));
  if (r.state === 'approved' && r.cookie) ctx.res.setHeader('set-cookie', setCookieHeader(r.cookie));
  ctx.json(200, { state: r.state });
}

function getMe(ctx: RouteCtx): void {
  const d = me(ctx);
  ctx.json(200, { device: { id: d.id, name: d.name }, prefs: d.prefs, tailnetHost: tailnetHostNow() });
}

function getSessions(ctx: RouteCtx): void {
  me(ctx);
  ctx.json(200, sessionsPayload(deps.chats(), deps.tail, deps.drafts(), paneTopics(deps.tmux), deps.groups()));
}

/** One chat: its row, transcript, and its pending drafts (the outbox cards, so the chat screen docks them without a second poll). */
async function getSession(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const c = findChat(ctx.url.searchParams.get('key'));
  if (!c) return ctx.json(404, { ok: false, detail: 'no such live chat' });
  const can = c.agent === 'claude' && isClaudeCommand(paneCommand(c.live.pane_id));
  const mine = deps.drafts().filter((d) => d.session_id === c.session_id);
  const { drafts } = await outboxPayload(mine, deps.chats(), deps.fresh);
  ctx.json(200, { session: sessionRow(c, deps.tail(c), paneTopics(deps.tmux), mine.length), messages: mobileTranscript(c.agent, c.jsonl_path), can_reply: can, drafts });
}

/** Reply and interrupt: the chat must be live and its pane running Claude right now. */
function claudePane(ctx: RouteCtx, key: unknown): MobileChat | null {
  const c = findChat(key);
  if (!c) {
    ctx.json(409, { ok: false, detail: 'chat is not live' });
    return null;
  }
  if (c.agent !== 'claude' || !isClaudeCommand(paneCommand(c.live.pane_id))) {
    ctx.json(403, { ok: false, detail: 'that pane is not running Claude' });
    return null;
  }
  return c;
}

/* ------------------------------------------------------------------ photo uploads */

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const UPLOAD_TTL_MS = 7 * 24 * 3600 * 1000;
const IMAGE_ID = /^[0-9a-f]{32}$/;

/** The image type by its first bytes, never by the header; null when it is not one we take. */
export function sniffImage(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.subarray(0, 6).toString('latin1'))) return 'gif';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (b.length >= 12 && b.subarray(4, 8).toString('latin1') === 'ftyp' && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(b.subarray(8, 12).toString('latin1'))) return 'heic';
  return null;
}

/** Same escaping as the terminal drop (src/termdrop.ts): backslash everything outside a safe set; quote if it has a control char. */
export function shellEscapePath(p: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(p)) return "'" + p.replace(/'/g, "'\\''") + "'";
  return p.replace(/[^A-Za-z0-9_\-.,:+@%/=~]/g, '\\$&');
}

function pruneUploads(dir: string): void {
  try {
    const cutoff = Date.now() - UPLOAD_TTL_MS;
    for (const f of fs.readdirSync(dir)) {
      const fp = path.join(dir, f);
      try {
        if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch {
        /* raced with another prune */
      }
    }
  } catch {
    /* no dir yet */
  }
}

/** The saved file for an upload id, or null when the id is malformed or the file is gone. */
function uploadPath(id: unknown): string | null {
  if (typeof id !== 'string' || !IMAGE_ID.test(id)) return null;
  const dir = deps.uploadsDir();
  for (const ext of ['jpg', 'png', 'gif', 'webp', 'heic']) {
    const fp = path.join(dir, id + '.' + ext);
    if (fs.existsSync(fp)) return fp;
  }
  return null;
}

/** POST /m/api/image: the raw image bytes as the body. Saved under the uploads dir; the reply names it by id. */
async function uploadImage(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  await new Promise<void>((resolve) => {
    ctx.req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_IMAGE_BYTES) over = true;
      else chunks.push(c);
    });
    ctx.req.on('end', () => resolve());
    ctx.req.on('error', () => resolve());
  });
  if (over) return ctx.json(413, { ok: false, detail: 'image is too large (12 MB max)' });
  const buf = Buffer.concat(chunks);
  const ext = sniffImage(buf);
  if (!ext) return ctx.json(415, { ok: false, detail: 'not a supported image (jpeg, png, heic, webp, gif)' });
  const dir = deps.uploadsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  pruneUploads(dir);
  const id = randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(dir, id + '.' + ext), buf, { mode: 0o600 });
  ctx.json(200, { ok: true, id });
}

async function reply(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const b = await ctx.body();
  let text = str(b?.text).trim();
  const ids = b?.images === undefined ? [] : b.images;
  if (!Array.isArray(ids) || ids.length > 10) return ctx.json(400, { ok: false, detail: 'images must be a list of up to 10 ids' });
  const paths: string[] = [];
  for (const id of ids) {
    const fp = uploadPath(id);
    if (!fp) return ctx.json(400, { ok: false, detail: 'unknown image' });
    paths.push(fp);
  }
  if (!text && !paths.length) return ctx.json(400, { ok: false, detail: 'text is required' });
  if (text.length > 8000) return ctx.json(400, { ok: false, detail: 'text is too long' });
  const c = claudePane(ctx, b?.key);
  if (!c) return;
  if (paths.length) text = (paths.map(shellEscapePath).join(' ') + ' ' + text).trim();
  const r = deps.send(c.live.pane_id, text, c.agent);
  ctx.json(r.ok ? 200 : 500, r);
}

/** POST /m/api/close: end the chat's agent like the desktop's Close. The session stays resumable. */
async function closeChat(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const b = await ctx.body();
  const c = findChat(b?.key);
  if (!c) return ctx.json(409, { ok: false, detail: 'chat is not live' });
  if (!isAgentCommand(c.agent, paneCommand(c.live.pane_id))) return ctx.json(403, { ok: false, detail: 'that pane is not running Claude or Codex' });
  const r = deps.close(c.live.pane_id, c.agent);
  ctx.json(r.ok ? 200 : 500, r);
}

async function interrupt(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const b = await ctx.body();
  const c = claudePane(ctx, b?.key);
  if (!c) return;
  try {
    deps.tmux(['send-keys', '-t', c.live.pane_id, 'Escape']);
    ctx.json(200, { ok: true, detail: 'interrupted' });
  } catch (e) {
    ctx.json(500, { ok: false, detail: 'send-keys failed: ' + (e as Error).message });
  }
}

/** `?session=<agent>:<session id>` narrows the outbox to one chat's drafts. */
export const SESSION_KEY_RE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9._-]{1,128}$/;

async function getOutbox(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const want = ctx.url.searchParams.get('session');
  if (want !== null && !SESSION_KEY_RE.test(want)) return ctx.json(400, { ok: false, detail: 'bad session key' });
  const sid = want === null ? null : want.slice(want.indexOf(':') + 1);
  const drafts = deps.drafts().filter((d) => sid === null || d.session_id === sid);
  ctx.json(200, await outboxPayload(drafts, deps.chats(), deps.fresh));
}

async function outboxSend(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const b = await ctx.body();
  if (!b) return ctx.json(400, { ok: false, detail: 'invalid body' });
  // The phone's ack_stale is the desktop's "Post anyway": it acknowledges every new message the sheet showed.
  const body: Record<string, unknown> = { id: b.id, messages: b.messages, after: b.after ?? 'none' };
  if (b.ack_stale === true) Object.assign(body, { ack_stale: true, ack_fresh: true });
  const r = await deps.outboxSend(body);
  ctx.json(r.status, r.body);
}

async function outboxDiscard(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const id = str((await ctx.body())?.id);
  if (!id) return ctx.json(400, { ok: false, detail: 'id is required' });
  const r = await deps.outboxDiscard(id);
  ctx.json(r.status, r.body);
}

async function outboxRedraft(ctx: RouteCtx): Promise<void> {
  me(ctx);
  const id = str((await ctx.body())?.id);
  if (!id) return ctx.json(400, { ok: false, detail: 'id is required' });
  const r = await deps.outboxRedraft(id);
  ctx.json(r.status, r.body);
}

function getPrefs(ctx: RouteCtx): void {
  ctx.json(200, { prefs: me(ctx).prefs });
}

async function putPrefs(ctx: RouteCtx): Promise<void> {
  const d = me(ctx);
  const b = await ctx.body();
  if (!b) return ctx.json(400, { ok: false, detail: 'invalid body' });
  ctx.json(200, { prefs: deviceStore().setPrefs(d.id, b) });
}

function getDevices(ctx: RouteCtx): void {
  const d = me(ctx);
  ctx.json(200, { devices: deviceStore().devices().map((x) => ({ id: x.id, name: x.name, created_at: x.created_at, last_seen_at: x.last_seen_at, this: x.id === d.id })) });
}

async function revokeDevice(ctx: RouteCtx): Promise<void> {
  const d = me(ctx);
  const id = str((await ctx.body())?.id);
  if (!deviceStore().revoke(id)) return ctx.json(404, { ok: false, detail: 'no such device' });
  if (id === d.id) ctx.res.setHeader('set-cookie', clearCookieHeader());
  ctx.json(200, { ok: true });
}

function pushKey(ctx: RouteCtx): void {
  me(ctx);
  ctx.json(200, { publicKey: loadVapidKeys().publicKey });
}

async function pushSubscribe(ctx: RouteCtx): Promise<void> {
  const d = me(ctx);
  const sub = validSubscription((await ctx.body())?.subscription);
  if (!sub) return ctx.json(400, { ok: false, detail: 'not a push subscription from a known push service' });
  deviceStore().setPush(d.id, sub);
  ctx.json(200, { ok: true });
}

async function pushUnsubscribe(ctx: RouteCtx): Promise<void> {
  const d = me(ctx);
  await ctx.body();
  deviceStore().setPush(d.id, null);
  ctx.json(200, { ok: true });
}

const dv = (method: RouteDef['method'], path: string, handler: RouteDef['handler']): RouteDef => ({ method, path, kind: 'device', handler });

/** Every /m/api route. Kept out of ROUTES: the gate judges these with requireDevice, never requireWrite. */
export const MOBILE_ROUTES: RouteDef[] = [
  { method: 'POST', path: '/m/api/pair', kind: 'device-open', handler: pair },
  { method: 'GET', path: '/m/api/pair/status', kind: 'device-open', handler: pairStatus },
  dv('GET', '/m/api/me', getMe),
  dv('GET', '/m/api/sessions', getSessions),
  dv('GET', '/m/api/session', getSession),
  dv('POST', '/m/api/reply', reply),
  dv('POST', '/m/api/image', uploadImage),
  dv('POST', '/m/api/interrupt', interrupt),
  dv('POST', '/m/api/close', closeChat),
  dv('GET', '/m/api/outbox', getOutbox),
  dv('POST', '/m/api/outbox/send', outboxSend),
  dv('POST', '/m/api/outbox/discard', outboxDiscard),
  dv('POST', '/m/api/outbox/redraft', outboxRedraft),
  dv('GET', '/m/api/prefs', getPrefs),
  dv('PUT', '/m/api/prefs', putPrefs),
  dv('GET', '/m/api/devices', getDevices),
  dv('POST', '/m/api/devices/revoke', revokeDevice),
  dv('GET', '/m/api/push/key', pushKey),
  dv('POST', '/m/api/push/subscribe', pushSubscribe),
  dv('POST', '/m/api/push/unsubscribe', pushUnsubscribe),
];

/* ------------------------------------------------------------------ static + headers */

export const MOBILE_CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'";

/** Every /m/ response: no framing, no referrer, no sniffing, the CSP. */
export function setMobileHeaders(res: http.ServerResponse): void {
  res.setHeader('content-security-policy', MOBILE_CSP);
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-content-type-options', 'nosniff');
}

/** GET /m/...: the PWA's files (src/mobile/web.ts), or a 404. */
export function serveMobileStatic(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  req.resume();
  if (url.pathname === '/m') {
    res.writeHead(301, { location: '/m/' });
    return void res.end();
  }
  if (url.pathname.startsWith('/m/api/')) {
    res.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return void res.end(JSON.stringify({ ok: false, detail: 'not found' }));
  }
  const f = mobileFile(url.pathname);
  if (!f) {
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return void res.end('not found');
  }
  const headers: Record<string, string> = { 'content-type': f.type };
  headers['cache-control'] = /^image\//.test(f.type) ? 'max-age=86400' : 'no-store';
  if (url.pathname === '/m/sw.js') headers['service-worker-allowed'] = '/m/';
  res.writeHead(200, headers);
  res.end(req.method === 'HEAD' ? undefined : f.body);
}
