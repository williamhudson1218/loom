import { searchMessages, type CallOpts, type SearchMatch } from './slackapi.ts';
import { toMrkdwn, type Draft } from './outbox.ts';

// `loom slack mine`: the person's own recent Slack messages, for the voice-tuning
// skill to measure how they write. Read-only. Two kinds of message are not theirs
// to learn from and are left out:
//   - what Loom's Outbox sent (Claude drafted it), matched by ts or exact text
//   - what the Claude Slack connector posted, which carries a "Sent using Claude" stamp

export type ChannelType = 'dm' | 'channel' | 'thread';

export interface MineMessage {
  ts: string;
  channel_type: ChannelType;
  /** The conversation: its id, and its name (a channel's #name; Slack names a DM by the other person's user id). */
  channel: string;
  channel_name: string;
  text: string;
}

export interface MineResult {
  messages: MineMessage[];
  kept: number;
  skipped: { outbox: number; stamped: number; system: number; empty: number };
}

/**
 * The connector's stamp. Slack writes it as a context block, `*Sent using* <@U…>`
 * (a mention of the Claude app's user, with no "Claude" text in it); older or
 * rendered forms read "Sent using Claude" or `<@U…|Claude>`.
 */
const STAMP_RE = /sent using[\s*_]*(?:<@[A-Z0-9]+(?:\|[^>]*)?>|(?:<[^>|]*\|)?@?claude)/i;

export function isStamped(m: Pick<SearchMatch, 'text' | 'blocks' | 'attachments'>): boolean {
  if (STAMP_RE.test(m.text ?? '')) return true;
  for (const extra of [m.blocks, m.attachments]) {
    if (extra && STAMP_RE.test(JSON.stringify(extra))) return true;
  }
  return false;
}

/** Slack's own notices posted under the person's name: joins, leaves, renames, topic changes. */
const SYSTEM_RE = /^(?:<@[A-Z0-9]+(?:\|[^>]*)?>\s+)?has (?:joined|left|renamed) the (?:channel|group|conversation)|^(?:set|cleared) the channel (?:topic|purpose|description)/i;

export function isSystem(m: Pick<SearchMatch, 'subtype' | 'text'>): boolean {
  if (m.subtype && m.subtype !== 'thread_broadcast' && m.subtype !== 'file_share' && m.subtype !== 'me_message') return true;
  return SYSTEM_RE.test((m.text ?? '').trim());
}

/** DM or group DM, a reply inside a thread, or a top-level channel message. */
export function channelTypeOf(m: SearchMatch): ChannelType {
  const c = m.channel ?? {};
  if (c.is_im || c.is_mpim || /^D/.test(c.id ?? '')) return 'dm';
  const threadTs = m.thread_ts || /[?&]thread_ts=(\d+\.\d+)/.exec(m.permalink ?? '')?.[1] || '';
  if (threadTs && threadTs !== m.ts) return 'thread';
  return 'channel';
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** What the Outbox sent: every posted ts, and every sent text (as drafted and as rendered for Slack). */
export function outboxSent(drafts: Iterable<Pick<Draft, 'status' | 'messages' | 'sent_parts'>>): { ts: Set<string>; text: Set<string> } {
  const ts = new Set<string>();
  const text = new Set<string>();
  const addText = (t: string) => {
    if (!t?.trim()) return;
    text.add(norm(t));
    text.add(norm(toMrkdwn(t)));
  };
  for (const d of drafts) {
    for (const p of d.sent_parts ?? []) {
      if (p.ts) ts.add(p.ts);
      addText(p.text);
    }
    if (d.status === 'sent') for (const t of d.messages ?? []) addText(t);
  }
  return { ts, text };
}

/** Keep the person's own messages, newest first; count what was left out and why. */
export function filterMine(matches: SearchMatch[], drafts: Iterable<Pick<Draft, 'status' | 'messages' | 'sent_parts'>>): MineResult {
  const sent = outboxSent(drafts);
  const out: MineResult = { messages: [], kept: 0, skipped: { outbox: 0, stamped: 0, system: 0, empty: 0 } };
  const sorted = [...matches].sort((a, b) => Number(b.ts) - Number(a.ts));
  const seen = new Set<string>();
  for (const m of sorted) {
    const key = (m.channel?.id ?? '') + '/' + m.ts;
    if (seen.has(key)) continue;
    seen.add(key);
    const text = m.text ?? '';
    if (!text.trim()) {
      out.skipped.empty++;
      continue;
    }
    if (isSystem(m)) {
      out.skipped.system++;
      continue;
    }
    if (sent.ts.has(m.ts) || sent.text.has(norm(text))) {
      out.skipped.outbox++;
      continue;
    }
    if (isStamped(m)) {
      out.skipped.stamped++;
      continue;
    }
    out.messages.push({ ts: m.ts, channel_type: channelTypeOf(m), channel: m.channel?.id ?? '', channel_name: m.channel?.name ?? '', text });
  }
  out.kept = out.messages.length;
  return out;
}

/** The search query for "my messages": by user id when known, else Slack's own from:me. */
export function mineQuery(userId?: string): string {
  return userId && /^[UW][A-Z0-9]+$/.test(userId) ? `from:<@${userId}>` : 'from:me';
}

/** Fetch and filter. `limit` counts the hits asked of Slack, before filtering. */
export async function fetchMine(p: { limit: number; userId?: string; drafts: Iterable<Pick<Draft, 'status' | 'messages' | 'sent_parts'>> }, opts: CallOpts = {}): Promise<MineResult> {
  const matches = await searchMessages(mineQuery(p.userId), { limit: p.limit }, opts);
  return filterMine(matches, p.drafts);
}
