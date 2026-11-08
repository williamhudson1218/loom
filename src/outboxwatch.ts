import fs from 'node:fs';
import { closeDraft, readOutbox, reconcileLive, OUTBOX_PATH, type Draft, type StoreOpts } from './outbox.ts';
import { parseSlackThread, type ThreadRef } from './slackref.ts';

// Noticing that a chat posted a draft itself. When Will types "send" in the
// terminal, the chat runs the Slack CLI (Bash) or the Slack MCP send tool. The
// chat's transcript shows that within a second, long before the 2-minute thread
// reconcile would: a tool_use naming the draft's channel + thread_ts is
// "sending", its tool_result without an error is "sent". Read-only against Slack;
// the one write is marking the draft sent by the chat (outbox.closeDraft), the
// same mark the reconcile makes. A draft Loom itself is posting is never marked
// here: its own send decides.

export type SendState = { state: 'sending' | 'sent' | 'failed'; note?: string };

export interface TranscriptEvent {
  kind: 'use' | 'result';
  id: string; // tool_use id
  ts: number; // ms, 0 if unknown
  name?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
  text?: string;
}

/** Flatten one transcript line into tool_use / tool_result events. */
export function eventsOfLine(line: string): TranscriptEvent[] {
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const content = o?.message?.content;
  if (!Array.isArray(content)) return [];
  const ts = Date.parse(o.timestamp ?? '') || 0;
  const out: TranscriptEvent[] = [];
  for (const c of content) {
    if (c?.type === 'tool_use' && typeof c.id === 'string') out.push({ kind: 'use', id: c.id, ts, name: String(c.name ?? ''), input: c.input && typeof c.input === 'object' ? c.input : {} });
    else if (c?.type === 'tool_result' && typeof c.tool_use_id === 'string') {
      const t = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((x: any) => x?.text ?? '').join('\n') : '';
      out.push({ kind: 'result', id: c.tool_use_id, ts, isError: c.is_error === true, text: t });
    }
  }
  return out;
}

/** A Bash command that posts to Slack: the Slack CLI's send, a raw chat.postMessage, or slack-threads' send. */
export function isBashSend(cmd: string): boolean {
  if (/\bpreview\b|--dry-run\b/.test(cmd)) return false;
  return /slack(\.mjs|\/slack|\b)[^|;&\n]*\s(send|post)\b/i.test(cmd) || /chat\.postMessage/.test(cmd) || /slack-threads\S*\s+send\b/.test(cmd);
}

const norm = (t: string) => String(t ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Does this tool call post to the draft's destination? Bash: the command text
 * mentions slack, the channel and (for a threaded draft) the thread_ts, and is
 * not a read/preview. MCP: a slack send tool with that channel_id and thread_ts.
 * An unthreaded draft also needs the opening of one of its messages in the call.
 */
export function postsDraft(ev: Pick<TranscriptEvent, 'name' | 'input'>, d: Pick<Draft, 'channel' | 'thread_ts' | 'messages'>): boolean {
  const input = ev.input ?? {};
  const name = ev.name ?? '';
  let blob = '';
  if (name === 'Bash') {
    const cmd = String(input.command ?? '');
    // Allowlist, not a blocklist: only an actual post counts. A read of the same
    // thread (read-thread, conversations.replies, the MCP read tool) names the
    // channel and ts too, and used to flip the card to "Sending…".
    if (!isBashSend(cmd)) return false;
    blob = cmd;
  } else if (/slack.*(send|post|schedule)/i.test(name) && !/draft/i.test(name)) {
    const ch = String(input.channel_id ?? input.channel ?? '');
    if (ch !== d.channel) return false;
    const th = String(input.thread_ts ?? '');
    if (d.thread_ts && th !== d.thread_ts) return false;
    if (d.thread_ts) return true;
    blob = JSON.stringify(input);
  } else return false;
  if (!blob.includes(d.channel)) return false;
  if (d.thread_ts) return blob.includes(d.thread_ts);
  const hay = norm(blob);
  return (d.messages ?? []).some((m) => {
    const h = norm(m).slice(0, 40);
    return h.length >= 12 && hay.includes(h);
  });
}

const resultFailed = (r: TranscriptEvent): boolean => !!r.isError || /"ok"\s*:\s*false/.test(r.text ?? '');

/**
 * Replay transcript events against pending drafts. Latest word wins per draft:
 * a call with no result yet is sending, a clean result is sent, an error is failed.
 * Calls older than the draft are about some earlier message (a read of the thread
 * just before drafting used to land inside a one-minute grace window).
 */
export function draftSendStates(events: TranscriptEvent[], drafts: Draft[]): Map<string, SendState> {
  const out = new Map<string, SendState>();
  const owner = new Map<string, string[]>(); // tool_use id -> draft ids
  for (const ev of events) {
    if (ev.kind === 'use') {
      const hit = drafts.filter((d) => (!ev.ts || isNaN(Date.parse(d.created_at)) || ev.ts >= Date.parse(d.created_at)) && postsDraft(ev, d));
      if (!hit.length) continue;
      owner.set(ev.id, hit.map((d) => d.id));
      for (const d of hit) out.set(d.id, { state: 'sending' });
    } else {
      const ids = owner.get(ev.id);
      if (!ids) continue;
      for (const id of ids) out.set(id, resultFailed(ev) ? { state: 'failed', note: 'Send failed in chat' } : { state: 'sent' });
    }
  }
  return out;
}

/**
 * Threads this chat STARTED: a Slack send (the CLI via Bash, or the MCP send tool)
 * that was not a reply and whose clean result carries the new message's permalink
 * (or channel + ts). A reply's permalink names a different root (?thread_ts=), so
 * only a link that points at its own root counts. Those threads belong to the chat.
 */
export function startedThreads(events: TranscriptEvent[]): ThreadRef[] {
  const sends = new Map<string, true>();
  const out = new Map<string, ThreadRef>();
  for (const ev of events) {
    if (ev.kind === 'use') {
      const input = ev.input ?? {};
      const name = ev.name ?? '';
      if (name === 'Bash') {
        const cmd = String(input.command ?? '');
        if (/slack\S*\s+send\b/.test(cmd) && !/\bthread_ts\b|\bpreview\b|\boutbox\b/.test(cmd)) sends.set(ev.id, true);
      } else if (/slack.*(send|post)/i.test(name) && !/draft|schedule/i.test(name) && !input.thread_ts) sends.set(ev.id, true);
      continue;
    }
    if (!sends.has(ev.id) || resultFailed(ev)) continue;
    const text = ev.text ?? '';
    let ref = parseSlackThread(text);
    if (ref && ref.ts !== ref.linkTs) ref = null; // a reply link: the thread is someone else's
    if (!ref) {
      const ch = /"channel"\s*:\s*"([A-Z0-9]+)"/.exec(text)?.[1];
      const ts = /"ts"\s*:\s*"(\d{10}\.\d{6})"/.exec(text)?.[1];
      if (ch && ts && !/permalink[^\n]*thread_ts/.test(text)) ref = { key: `${ch}/${ts}`, url: '', channel: ch, ts, linkTs: ts };
    }
    if (ref && !ref.channel.startsWith('D')) out.set(ref.key, ref);
  }
  return [...out.values()];
}

/** The last `bytes` of a transcript as events (a cut first line is dropped). */
export function readTailEvents(file: string, bytes = 512 * 1024, mustInclude = ''): TranscriptEvent[] {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    let lines = buf.toString('utf-8').split('\n');
    if (start > 0) lines = lines.slice(1);
    return lines.filter((l) => l && (!mustInclude || l.includes(mustInclude))).flatMap(eventsOfLine);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/* ---------------------------------------------------------------- watcher */

export interface WatchDeps {
  file?: string;
  /** The legacy outbox file to fold in (outbox.ts); defaults as readOutbox does. */
  legacy?: string;
  now?: () => number;
  /** session id -> transcript path (Claude chats only). */
  transcriptOf: (sessionId: string) => string | null;
  reconcileOne?: (id: string) => Promise<string[]>;
  /** Record that a chat started this thread. Must not move a thread another chat owns. */
  claimStarted?: (ref: ThreadRef, sessionId: string) => void;
  /** Live Claude chats to scan for started threads, besides those with a pending draft. */
  liveSessionIds?: () => string[];
}

const RECONCILE_EVERY_MS = 5000;
const RECONCILE_WINDOW_MS = 60_000;
const SENT_KEEP_MS = 60_000;

export class OutboxWatch {
  private states = new Map<string, SendState>();
  private since = new Map<string, number>(); // draft id -> when it went sending
  private lastReconcile = new Map<string, number>();
  private marking = new Set<string>();
  private sentAt = new Map<string, number>();
  private sig = new Map<string, string>();
  private startSig = new Map<string, string>();
  private startClaimed = new Set<string>();
  constructor(private deps: WatchDeps) {}

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private store(): StoreOpts {
    return { file: this.deps.file, legacy: this.deps.legacy };
  }

  /** When a chat started posting this draft (ms), if it is posting it now. */
  sendingSince(id: string): number | undefined {
    return this.states.get(id)?.state === 'sending' ? this.since.get(id) : undefined;
  }

  /** Per-draft send state for the page: sending / failed (+note). */
  stateOf(id: string): SendState | undefined {
    return this.states.get(id);
  }

  /** Ids marked sent in the last minute: lets the page animate them away instead of just dropping them. */
  recentlySent(): string[] {
    const t = this.now();
    return [...this.sentAt].filter(([, at]) => t - at < SENT_KEEP_MS).map(([id]) => id);
  }

  private async markSent(id: string): Promise<void> {
    if (this.marking.has(id)) return;
    this.marking.add(id);
    try {
      const r = closeDraft(id, 'sent', { by: 'chat', at: this.now() }, this.store());
      if (r.ok) {
        this.sentAt.set(id, this.now());
        this.states.delete(id);
        this.since.delete(id);
      } else if (readOutbox(this.store())[id]?.status !== 'pending') {
        /* already settled by the reconcile or by Loom's own send */
        this.sentAt.set(id, this.now());
      }
      /* 'being sent': Loom is posting it, and its send marks it */
    } catch {
      /* the next scan decides */
    } finally {
      this.marking.delete(id);
    }
  }

  /** One pass: scan the owning chats' transcripts, update states, mark what landed. */
  async tick(): Promise<void> {
    const pending = Object.values(readOutbox(this.store())).filter((d) => d.status === 'pending' && d.messages?.length);
    const bySession = new Map<string, Draft[]>();
    for (const d of pending) (bySession.get(d.session_id) ?? bySession.set(d.session_id, []).get(d.session_id)!).push(d);
    const next = new Map<string, SendState>();
    const toMark: string[] = [];
    for (const [sid, drafts] of bySession) {
      const file = this.deps.transcriptOf(sid);
      if (!file) continue;
      let sig = '';
      try {
        const st = fs.statSync(file);
        sig = `${st.size}:${st.mtimeMs}:${drafts.map((d) => d.id).join(',')}`;
      } catch {
        continue;
      }
      if (this.sig.get(sid) === sig) {
        for (const d of drafts) {
          const s = this.states.get(d.id);
          if (s) next.set(d.id, s);
        }
        continue;
      }
      this.sig.set(sid, sig);
      for (const [id, s] of draftSendStates(readTailEvents(file), drafts)) {
        if (s.state === 'sent') toMark.push(id);
        else next.set(id, s);
      }
    }
    for (const id of next.keys()) if (next.get(id)!.state === 'sending' && !this.since.has(id)) this.since.set(id, this.now());
    for (const id of [...this.since.keys()]) if (!next.has(id) || next.get(id)!.state !== 'sending') this.since.delete(id);
    this.states = next;
    await Promise.all(toMark.map((id) => this.markSent(id)));
    await this.reconcileSending();
    this.scanStarted([...new Set([...bySession.keys(), ...(this.deps.liveSessionIds?.() ?? [])])]);
    for (const [id, at] of this.sentAt) if (this.now() - at > SENT_KEEP_MS) this.sentAt.delete(id);
  }

  /** Threads the given chats started with their own Slack sends: record each as theirs. */
  private scanStarted(sessionIds: string[]): void {
    if (!this.deps.claimStarted) return;
    for (const sid of sessionIds) {
      const file = this.deps.transcriptOf(sid);
      if (!file) continue;
      let sig = '';
      try {
        const st = fs.statSync(file);
        sig = `${st.size}:${st.mtimeMs}`;
      } catch {
        continue;
      }
      if (this.startSig.get(sid) === sig) continue;
      this.startSig.set(sid, sig);
      for (const ref of startedThreads(readTailEvents(file, 512 * 1024, 'slack'))) {
        const k = `${sid}|${ref.key}`;
        if (this.startClaimed.has(k)) continue;
        this.startClaimed.add(k);
        try {
          this.deps.claimStarted(ref, sid);
        } catch {
          /* best effort; the next change to the transcript retries */
          this.startClaimed.delete(k);
        }
      }
    }
  }

  /** While a draft is sending: look at its thread right away, then every 5 s for a minute. */
  private async reconcileSending(): Promise<void> {
    const t = this.now();
    for (const [id, since] of this.since) {
      if (t - since > RECONCILE_WINDOW_MS) continue;
      if (t - (this.lastReconcile.get(id) ?? 0) < RECONCILE_EVERY_MS) continue;
      this.lastReconcile.set(id, t);
      try {
        const done = await (this.deps.reconcileOne ?? ((x) => reconcileLive(this.store(), [x])))(id);
        if (done.includes(id)) {
          this.sentAt.set(id, this.now());
          this.states.delete(id);
          this.since.delete(id);
        }
      } catch {
        /* best effort; the 2-minute tick retries */
      }
    }
  }
}

export { OUTBOX_PATH };
