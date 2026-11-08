import type Database from 'better-sqlite3';
import { compareTs, type SlackMessage } from '../../slack.ts';
import type { Match, Params, Watcher } from '../model.ts';

// The Slack source: poll one channel's history since the watermark, run the
// trigger over each new message. The first poll after enabling is a baseline:
// existing matches are marked seen and nothing acts. watcher_seen is the dedupe
// set, so a message is considered at most once per watcher, ever.

export const POLL_MS = 60_000;
const MAX_BACKOFF_MS = 30 * 60_000;

export interface SlackCtx {
  /** The connected user's Slack id, for mentions-me and ignore-self. */
  selfUserId: string;
  /** watchers_ignore_self: skip your own posts (person-authored triggers only). */
  ignoreSelf: boolean;
}

export interface RuleHit {
  title: string;
}

const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const firstLine = (s: string) => s.split('\n')[0].trim().slice(0, 120);
const plain = (s: string) => s.replace(/<[^|>]*\|([^>]*)>/g, '$1').replace(/<([^>]*)>/g, '$1').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

/** The Slack triggers. bot-post-contains and pr-link-post are byte-for-byte the previous build's rules. */
export const SLACK_RULES: Record<string, (m: SlackMessage, params: Params, ctx: SlackCtx) => RuleHit | null> = {
  // A post from a given bot/user whose text (or blocks) contains a phrase.
  'bot-post-contains'(m, params) {
    const bots = strList(params.bot_ids);
    const users = strList(params.user_ids);
    const needle = typeof params.needle === 'string' ? params.needle : '';
    if (!needle) return null;
    const fromBot = (!!m.bot_id && bots.includes(m.bot_id)) || (!!m.user && users.includes(m.user));
    if (!fromBot) return null;
    const text = m.text ?? '';
    if (!text.includes(needle) && !JSON.stringify(m.blocks ?? '').includes(needle)) return null;
    // A bot often links its item as <url|#123 Title>; fall back to the first line.
    const title = (text.match(/\|(#\d+[^>]*)>/) ?? [])[1] ?? firstLine(text.replace(/<[^|>]*\|([^>]*)>/g, '$1'));
    return { title: title || needle };
  },
  // A person's top-level post linking a pull request in one of the given repos.
  // Bot and system posts (any subtype) and the excluded users are skipped. One
  // match per message, however many PRs it links.
  'pr-link-post'(m, params, ctx) {
    const repos = strList(params.repos);
    if (!repos.length || m.subtype || m.bot_id || !m.user) return null;
    if (strList(params.exclude_user_ids).includes(m.user)) return null;
    if (ctx.ignoreSelf && ctx.selfUserId && m.user === ctx.selfUserId) return null;
    if (m.thread_ts && m.thread_ts !== m.ts) return null;
    const text = m.text ?? '';
    const nums: string[] = [];
    let label = '';
    for (const [, repo, n, l] of text.matchAll(/<https:\/\/github\.com\/([^/|>]+\/[^/|>]+)\/pull\/(\d+)[^|>]*(?:\|([^>]*))?>/g)) {
      if (!repos.includes(repo) || nums.includes(n)) continue;
      nums.push(n);
      if (!label && l && !l.includes('github.com')) label = l.trim();
    }
    if (!nums.length) return null;
    // Slack's link label when it is a title, else the poster's own words.
    const rest = (label || firstLine(text.replace(/<[^>]*>/g, '').replace(/^[\s:—–-]+/, '')))
      .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
    return { title: `${nums.map((n) => '#' + n).join(', ')}${rest ? ' ' + rest : ''}`.slice(0, 120) };
  },
  // A message that @-mentions the connected user.
  'mentions-me'(m, _params, ctx) {
    if (!ctx.selfUserId || m.subtype) return null;
    if (ctx.ignoreSelf && m.user === ctx.selfUserId) return null;
    if (!(m.text ?? '').includes(`<@${ctx.selfUserId}>`)) return null;
    return { title: firstLine(plain(m.text ?? '')) || 'mention' };
  },
  // A message containing a phrase (case-insensitive). People only, unless any_author.
  phrase(m, params, ctx) {
    const needle = typeof params.needle === 'string' ? params.needle.trim().toLowerCase() : '';
    if (!needle || m.subtype === 'channel_join') return null;
    if (!params.any_author && (m.bot_id || !m.user)) return null;
    if (ctx.ignoreSelf && ctx.selfUserId && m.user === ctx.selfUserId) return null;
    const text = m.text ?? '';
    if (!text.toLowerCase().includes(needle) && !JSON.stringify(m.blocks ?? '').toLowerCase().includes(needle)) return null;
    return { title: firstLine(plain(text)) || needle };
  },
};

export function permalink(workspace: string, channel: string, ts: string): string {
  const host = workspace ? `${workspace}.slack.com` : 'slack.com';
  return `https://${host}/archives/${channel}/p${ts.replace('.', '')}`;
}

export const slackChannel = (w: Watcher): string => String(w.source.params.channel ?? '');

/** The match for one message, or null. Pure. */
export function slackMatch(w: Watcher, m: SlackMessage, ctx: SlackCtx): Match | null {
  const rule = SLACK_RULES[w.trigger.kind];
  if (!rule) return null;
  const hit = rule(m, w.trigger.params, ctx);
  if (!hit) return null;
  const channel = slackChannel(w);
  const url = permalink(String(w.source.params.workspace ?? ''), channel, m.ts);
  return {
    key: m.ts,
    subject: `slack:${channel}/${m.thread_ts || m.ts}`,
    title: hit.title,
    permalink: url,
    vars: {
      TITLE: hit.title,
      URL: url,
      PERMALINK: url,
      CHANNEL: channel,
      TS: m.ts,
      AUTHOR: m.user ? `<@${m.user}>` : m.bot_id ?? '',
      TEXT: plain(m.text ?? '').slice(0, 2000),
    },
  };
}

export interface IngestResult {
  baseline: boolean;
  matched: number;
  considered: number;
}

/**
 * Record one successful poll, in one transaction: every matching message not
 * seen before goes into the seen set and (unless this is the baseline poll) to
 * `consider`, which records its event. The watermark advances to the newest
 * message whether it matched or not.
 */
export function ingest(
  db: Database.Database,
  w: Watcher,
  msgs: SlackMessage[],
  now: number,
  ctx: SlackCtx,
  consider: (m: Match) => void,
): IngestResult {
  const baseline = !w.poll.baselined;
  const sorted = [...msgs].sort((a, b) => compareTs(a.ts, b.ts));
  const seen = db.prepare(`INSERT OR IGNORE INTO watcher_seen (watcher_id, ts, seen_at, baseline) VALUES (?, ?, ?, ?)`);
  let matched = 0;
  let considered = 0;
  db.transaction(() => {
    for (const msg of sorted) {
      const hit = slackMatch(w, msg, ctx);
      if (!hit) continue;
      matched++;
      if (seen.run(w.id, msg.ts, now, baseline ? 1 : 0).changes === 0) continue; // dedupe
      if (baseline) continue;
      consider(hit);
      considered++;
    }
    let watermark = w.poll.watermark;
    const newest = sorted[sorted.length - 1]?.ts;
    if (newest && (!watermark || compareTs(newest, watermark) > 0)) watermark = newest;
    if (!watermark) watermark = (now / 1000).toFixed(6); // empty channel: start from now
    db.prepare(
      `UPDATE watchers SET baselined = 1, watermark = ?, last_poll_at = ?, last_ok_at = ?, last_error = '', error_count = 0, next_poll_at = ? WHERE id = ?`,
    ).run(watermark, now, now, now + POLL_MS, w.id);
  })();
  return { baseline, matched, considered };
}

export function backoffMs(errorCount: number): number {
  return Math.min(POLL_MS * 2 ** Math.max(0, errorCount - 1), MAX_BACKOFF_MS);
}

export function recordPollError(db: Database.Database, w: Watcher, err: string, now: number): void {
  const n = w.poll.error_count + 1;
  db.prepare(`UPDATE watchers SET last_poll_at = ?, last_error = ?, error_count = ?, next_poll_at = ? WHERE id = ?`).run(
    now, err.slice(0, 500), n, now + backoffMs(n), w.id,
  );
}
