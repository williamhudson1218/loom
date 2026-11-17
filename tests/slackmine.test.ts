import { describe, expect, it } from 'vitest';
import { channelTypeOf, fetchMine, filterMine, isStamped, mineQuery } from '../src/slackmine.ts';
import { buildManifest, buildSharedManifest, manifestScopes } from '../src/slackmanifest.ts';
import type { SearchMatch } from '../src/slackapi.ts';

const m = (ts: string, text: string, extra: Partial<SearchMatch> = {}): SearchMatch => ({ ts, text, channel: { id: 'C0TEST0001' }, ...extra });

describe('loom slack mine: filtering', () => {
  it('leaves out what the Outbox sent, by ts and by exact text', () => {
    const drafts = [
      { status: 'sent', messages: ['sent by loom'], sent_parts: [{ ts: '1700000003.000100', text: 'posted text' }] },
      { status: 'sent', messages: ['a *bold* reply'] },
      { status: 'pending', messages: ['still pending'] },
    ];
    const r = filterMine(
      [
        m('1700000001.000100', 'my own words'),
        m('1700000003.000100', 'edited in slack after posting'), // same ts as a sent part
        m('1700000004.000100', 'sent   by loom'), // same text, whitespace aside
        m('1700000005.000100', 'still pending'), // a pending draft was never sent: it's theirs if it's in Slack
      ],
      drafts,
    );
    expect(r.messages.map((x) => x.text)).toEqual(['still pending', 'my own words']);
    expect(r.skipped).toEqual({ outbox: 2, stamped: 0, system: 0, empty: 0 });
    expect(r.kept).toBe(2);
  });

  it('matches a sent draft by its Slack rendering too', () => {
    const r = filterMine([m('1700000001.000100', 'a *bold* reply')], [{ status: 'sent', messages: ['a **bold** reply'] }]);
    expect(r.skipped.outbox).toBe(1);
  });

  it('leaves out messages carrying the Claude connector stamp, in text or blocks', () => {
    const stampedBlocks = m('1700000002.000100', 'drafted reply', {
      blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: '*Sent using* <@U0CLAUDE01|Claude>' }] }],
    });
    const stampedText = m('1700000003.000100', 'another\n_Sent using Claude_');
    // What Slack actually stores: a context block mentioning the Claude app's user, no "Claude" text.
    const stampedMention = m('1700000004.000100', 'third', {
      blocks: [{ type: 'rich_text' }, { type: 'context', elements: [{ type: 'mrkdwn', text: '*Sent using* <@U0APPTEST1>', verbatim: false }] }],
    });
    const r = filterMine([m('1700000001.000100', 'mine'), stampedBlocks, stampedText, stampedMention], []);
    expect(r.messages.map((x) => x.text)).toEqual(['mine']);
    expect(r.skipped.stamped).toBe(3);
    expect(isStamped({ text: 'I sent using my phone' })).toBe(false);
  });

  it("drops Slack's own notices posted under the person's name", () => {
    const r = filterMine([
      m('1700000001.000100', 'has renamed the channel from "a" to "b"'),
      m('1700000002.000100', 'has joined the channel'),
      m('1700000003.000100', 'joined', { subtype: 'channel_join' }),
      m('1700000004.000100', 'a reply also sent to the channel', { subtype: 'thread_broadcast' }),
      m('1700000005.000100', 'who has renamed the channel? not me'),
    ], []);
    expect(r.messages.map((x) => x.text)).toEqual(['who has renamed the channel? not me', 'a reply also sent to the channel']);
    expect(r.skipped.system).toBe(3);
  });

  it('sorts newest first, drops empties and duplicate hits', () => {
    const r = filterMine([m('1700000001.000100', 'old'), m('1700000009.000100', 'new'), m('1700000009.000100', 'new'), m('1700000005.000100', ' ')], []);
    expect(r.messages.map((x) => x.text)).toEqual(['new', 'old']);
    expect(r.skipped.empty).toBe(1);
  });

  it("carries the conversation id and name", () => {
    const r = filterMine([m("1700000001.000100", "hi", { channel: { id: "D0TEST0001", name: "U0TEST0002", is_im: true } })], []);
    expect(r.messages[0]).toEqual({ ts: "1700000001.000100", channel_type: "dm", channel: "D0TEST0001", channel_name: "U0TEST0002", text: "hi" });
  });

  it('labels dm, thread and channel', () => {
    expect(channelTypeOf(m('1.1', 'x', { channel: { id: 'D0TEST0001', is_im: true } }))).toBe('dm');
    expect(channelTypeOf(m('1.1', 'x', { channel: { id: 'G0TEST0001', is_mpim: true } }))).toBe('dm');
    expect(channelTypeOf(m('1700000002.000200', 'x', { permalink: 'https://acme.slack.com/archives/C1/p1700000002000200?thread_ts=1700000001.000100&cid=C1' }))).toBe('thread');
    expect(channelTypeOf(m('1700000001.000100', 'x', { permalink: 'https://acme.slack.com/archives/C1/p1700000001000100?thread_ts=1700000001.000100' }))).toBe('channel');
    expect(channelTypeOf(m('1700000001.000100', 'x'))).toBe('channel');
  });

  it('searches by user id when known', () => {
    expect(mineQuery('U0TEST0001')).toBe('from:<@U0TEST0001>');
    expect(mineQuery('')).toBe('from:me');
    expect(mineQuery('not an id')).toBe('from:me');
  });

  it('pages search.messages newest first, up to the limit, and only reads', async () => {
    const calls: { method: string; q: URLSearchParams; get: boolean }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const u = new URL(String(url));
      calls.push({ method: u.pathname.slice(5), q: u.searchParams, get: (init.method ?? 'GET') === 'GET' });
      const page = Number(u.searchParams.get('page'));
      const matches = Array.from({ length: 100 }, (_, i) => m(`17000${String(page).padStart(2, '0')}${String(99 - i).padStart(3, '0')}.000100`, `p${page} m${i}`));
      return { status: 200, headers: new Headers(), json: async () => ({ ok: true, messages: { matches, paging: { page, pages: 9 } } }) } as Response;
    }) as typeof fetch;
    const r = await fetchMine({ limit: 250, userId: 'U0TEST0001', drafts: [] }, { token: 'xoxp-test-token', fetchImpl });
    expect(r.kept).toBe(250);
    expect(calls.map((c) => c.method)).toEqual(['search.messages', 'search.messages', 'search.messages']);
    expect(calls.every((c) => c.get && c.q.get('sort') === 'timestamp' && c.q.get('sort_dir') === 'desc' && c.q.get('query') === 'from:<@U0TEST0001>')).toBe(true);
  });
});

describe('Slack app manifest', () => {
  it('asks for search:read, which reading your own messages needs', () => {
    expect(manifestScopes(false)).toContain('search:read');
    expect(manifestScopes(true)).toContain('search:read');
    expect(buildSharedManifest().oauth_config.scopes.user).toContain('search:read');
    expect(buildManifest().oauth_config.scopes.user).toContain('search:read');
  });
});
