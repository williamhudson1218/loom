import fs from 'node:fs';
import { openDb } from './db.ts';
import { pendingDrafts } from './outbox.ts';
import { getParked } from './parked.ts';
import { channelLabelFor, rootTextFor, threadsFor, type OwnedThread } from './slack.ts';
import { parseSlackThread } from './slackref.ts';

// The one list of Slack threads a chat is tied to. The board, the header's
// Slack button, the menus and the sidebar chip all read this and nothing else.
// Everything here is read-only: labels come from the cached conversations
// read (slack.ts), nothing is posted or reacted to.

export type ThreadRole = 'owner' | 'started' | 'replying' | 'draft' | 'parked';

export interface ChatThread {
  key: string; // `<channel>/<root ts>`, the dedupe key
  url: string;
  channel: string;
  ts: string;
  role: ThreadRole;
  channelLabel: string; // #name or the DM name; the raw id until resolved
  label: string; // one line: the parent message's first ~60 chars, or a fallback
  lastAt: number; // ms of the newest known activity (the root's own time when nothing else is known)
  draft: boolean; // a pending draft is waiting to post here
  parked: boolean; // the chat is parked on this thread
  pending: boolean; // the parent text is still being fetched
}

export interface MergeInput {
  owned: { key: string; url: string; source: string; at: number; preview: string | null }[];
  drafts: { key: string; url: string; at: number }[];
  parked: { key: string; url: string; at: number } | null;
  mentions: { key: string; url: string }[];
  channelLabel: (channel: string) => string;
  rootText: (key: string) => string | null;
}

export const LABEL_CHARS = 60;

/** First ~60 chars of the parent message on one line; with no text, "<channel> thread <date>". */
export function threadLabel(text: string | null | undefined, channelLabel: string, ts: string): string {
  const one = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (one) return one.length > LABEL_CHARS ? one.slice(0, LABEL_CHARS - 1).trimEnd() + '…' : one;
  const sec = Number(String(ts).split('.')[0]);
  const date = Number.isFinite(sec) && sec > 0 ? new Date(sec * 1000).toISOString().slice(0, 10) : '';
  return `${channelLabel} thread${date ? ' ' + date : ''}`;
}

const tsMs = (ts: string): number => {
  const n = Number(ts);
  return Number.isFinite(n) ? Math.round(n * 1000) : 0;
};

const ROLE_RANK: Record<ThreadRole, number> = { owner: 0, started: 0, parked: 2, draft: 2, replying: 2 };

/**
 * Owned and started threads first, then everything else; each group most recent
 * first. A key present in several sources is one entry: the strongest role wins
 * (owner/started over parked over draft over replying), the draft and parked
 * flags are set from their own sources.
 */
export function mergeChatThreads(inp: MergeInput): ChatThread[] {
  const byKey = new Map<string, ChatThread>();
  const seen = (key: string, url: string, role: ThreadRole, at: number): ChatThread | null => {
    const [channel, ts] = key.split('/');
    if (!channel || !ts) return null;
    let t = byKey.get(key);
    if (!t) {
      const cl = inp.channelLabel(channel);
      t = { key, url, channel, ts, role, channelLabel: cl, label: '', lastAt: tsMs(ts), draft: false, parked: false, pending: false };
      byKey.set(key, t);
    } else {
      if (ROLE_RANK[role] < ROLE_RANK[t.role]) t.role = role;
      else if (t.role === 'owner' && role === 'started') t.role = 'started';
      if (!t.url && url) t.url = url;
    }
    if (at > t.lastAt) t.lastAt = at;
    return t;
  };
  for (const o of inp.owned) seen(o.key, o.url, o.source === 'send' ? 'started' : 'owner', o.at);
  for (const d of inp.drafts) {
    const t = seen(d.key, d.url, 'draft', d.at);
    if (t) t.draft = true;
  }
  if (inp.parked) {
    const t = seen(inp.parked.key, inp.parked.url, 'parked', inp.parked.at);
    if (t) t.parked = true;
  }
  for (const m of inp.mentions) seen(m.key, m.url, 'replying', 0);
  const previews = new Map(inp.owned.map((o) => [o.key, o.preview]));
  for (const t of byKey.values()) {
    const text = previews.has(t.key) && previews.get(t.key) !== null ? previews.get(t.key) : inp.rootText(t.key);
    t.pending = text === null || text === undefined;
    t.label = threadLabel(text, t.channelLabel, t.ts);
  }
  const group = (t: ChatThread) => (t.role === 'owner' || t.role === 'started' ? 0 : 1);
  return [...byKey.values()].sort((a, b) => group(a) - group(b) || b.lastAt - a.lastAt || a.key.localeCompare(b.key));
}

/** The thread the header's main button opens: pending draft, then parked, then the most recent owned or started one. */
export function primaryThread(list: ChatThread[]): ChatThread | null {
  if (!list.length) return null;
  return list.find((t) => t.draft) ?? list.find((t) => t.parked) ?? list.find((t) => t.role === 'owner' || t.role === 'started') ?? list[0];
}

/* ------------------------------------------------------------- transcript permalinks */

const LINK_RE = /https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p\d{16}[^\s"'\\<>)\]|]*/g;
const MAX_MENTIONS = 6;
const SCAN_BYTES = 24 * 1024 * 1024;
const mentionMemo = new Map<string, { sig: string; refs: { key: string; url: string }[] }>();

/** Thread permalinks a transcript mentions, newest mention first, at most a handful. */
export function transcriptThreadRefs(jsonlPath: string): { key: string; url: string }[] {
  if (!jsonlPath) return [];
  try {
    const st = fs.statSync(jsonlPath);
    const sig = `${st.mtimeMs}:${st.size}`;
    const memo = mentionMemo.get(jsonlPath);
    if (memo?.sig === sig) return memo.refs;
    let text: string;
    if (st.size > SCAN_BYTES) {
      const fd = fs.openSync(jsonlPath, 'r');
      try {
        const buf = Buffer.alloc(SCAN_BYTES);
        fs.readSync(fd, buf, 0, SCAN_BYTES, st.size - SCAN_BYTES);
        text = buf.toString('utf-8');
      } finally {
        fs.closeSync(fd);
      }
    } else text = fs.readFileSync(jsonlPath, 'utf-8');
    const refs = refsFromText(text);
    mentionMemo.set(jsonlPath, { sig, refs });
    return refs;
  } catch {
    return [];
  }
}

export function refsFromText(text: string): { key: string; url: string }[] {
  const out: { key: string; url: string }[] = [];
  const seenKeys = new Set<string>();
  const links = text.match(LINK_RE) ?? [];
  for (let i = links.length - 1; i >= 0 && out.length < MAX_MENTIONS; i--) {
    const ref = parseSlackThread(links[i]);
    if (ref && !seenKeys.has(ref.key)) {
      seenKeys.add(ref.key);
      out.push({ key: ref.key, url: ref.url });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ the chat's list */

export function chatThreadList(view: { agent: string; session_id: string; jsonl_path: string }, owned: OwnedThread[] = threadsFor(view.session_id)): ChatThread[] {
  const drafts: MergeInput['drafts'] = [];
  for (const d of pendingDrafts()) {
    if (d.session_id !== view.session_id) continue;
    const ref = parseSlackThread(d.thread_url || d.permalink || '');
    if (ref) drafts.push({ key: ref.key, url: ref.url, at: Date.parse(d.created_at) || 0 });
  }
  let parked: MergeInput['parked'] = null;
  try {
    const db = openDb();
    try {
      const p = getParked(db, view.agent, view.session_id);
      const ref = p ? parseSlackThread(p.thread_url || p.permalink) : null;
      if (p && ref) parked = { key: ref.key, url: ref.url, at: Math.max(p.sent_at || 0, p.replied_at || 0) };
    } finally {
      db.close();
    }
  } catch {
    /* no parked table: no parked thread */
  }
  const ownedKeys = new Set(owned.map((o) => o.key));
  const mentions = view.agent === 'claude' ? transcriptThreadRefs(view.jsonl_path).filter((m) => !ownedKeys.has(m.key)) : [];
  return mergeChatThreads({
    owned: owned.map((o) => ({ key: o.key, url: o.url, source: o.source, at: o.lastAt, preview: o.preview })),
    drafts,
    parked,
    mentions,
    channelLabel: (c) => channelLabelFor(c),
    rootText: (k) => rootTextFor(k),
  });
}

/**
 * Threads per chat for the board's Slack chip: owned threads plus the thread of
 * each pending draft and the parked thread, deduped by key (no transcript scan,
 * which is too slow for every row). The selected chat's detail list may add more.
 */
export function slackCounts(
  owned: Record<string, { session_id: string }>,
  drafts: { session_id: string; thread_url?: string; permalink?: string }[],
  parked: { session_id: string; thread_url?: string; permalink?: string }[],
): Record<string, number> {
  const keys = new Map<string, Set<string>>();
  const add = (sid: string, key: string) => {
    if (!sid || !key) return;
    if (!keys.has(sid)) keys.set(sid, new Set());
    keys.get(sid)!.add(key);
  };
  for (const [k, t] of Object.entries(owned)) add(t.session_id, k);
  for (const d of drafts) add(d.session_id, parseSlackThread(d.thread_url || d.permalink || '')?.key ?? '');
  for (const p of parked) add(p.session_id, parseSlackThread(p.thread_url || p.permalink || '')?.key ?? '');
  return Object.fromEntries([...keys].map(([sid, set]) => [sid, set.size]));
}
