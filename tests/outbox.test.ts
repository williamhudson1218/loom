import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addDraft, burstGapMs, closeDraft, discardDraft, listDrafts, mergeLegacy, pendingDrafts, readOutbox, sendDraft, sendNow, sendProgress, sendPayload,
  legacyWriteBack, reconcileLive, slackPoster, toMrkdwn, updateDraft, type Draft,
} from '../src/outbox.ts';

function outboxFile(drafts: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-'));
  const f = path.join(dir, 'outbox.json');
  fs.writeFileSync(f, JSON.stringify({ drafts }));
  return f;
}

const base = { session_id: 's1', channel: 'C1', created_at: '2026-10-16T09:00:00', messages: ['hello'] };
const status = (f: string, id: string) => readOutbox(f)[id]?.status;

/**
 * A fetch stub standing in for slack.com: records every call, answers per method.
 * No request ever leaves the process.
 */
function slackStub(answers: Record<string, (body: any, n: number) => unknown> = {}) {
  const calls: { method: string; body: any; auth: string }[] = [];
  const counts: Record<string, number> = {};
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = String(url).replace('https://slack.com/api/', '').split('?')[0];
    const body = init.body ? JSON.parse(String(init.body)) : Object.fromEntries(new URL(String(url)).searchParams);
    calls.push({ method, body, auth: String((init.headers as Record<string, string>)?.Authorization ?? '') });
    counts[method] = (counts[method] ?? 0) + 1;
    const a = answers[method];
    const out = a ? a(body, counts[method]) : method === 'chat.postMessage' ? { ok: true, channel: body.channel, ts: `1793990000.00000${counts[method]}` }
      : method === 'chat.getPermalink' ? { ok: true, permalink: `https://acme.slack.com/archives/${body.channel}/p${String(body.message_ts).replace('.', '')}` }
      : { ok: false, error: 'unknown_method' };
    return { status: 200, headers: new Headers(), json: async () => out } as Response;
  }) as typeof fetch;
  const slack = { ...slackPoster({ token: 'xoxp-test-token', fetchImpl }), sleep: async () => {} };
  return { calls, slack, posts: () => calls.filter((c) => c.method === 'chat.postMessage') };
}

describe('outbox store', () => {
  it('lists only pending drafts, oldest first, labelled from the channel cache', () => {
    const f = outboxFile({
      a: { ...base, id: 'a', status: 'sent' },
      b: { ...base, id: 'b', status: 'pending', created_at: '2026-10-16T09:05:00' },
      c: { ...base, id: 'c', status: 'pending', channel: 'C2' },
      d: { ...base, id: 'd', status: 'pending', messages: [] },
    });
    const labels = path.join(path.dirname(f), 'labels.json');
    fs.writeFileSync(labels, JSON.stringify({ C1: '#general' }));
    expect(pendingDrafts(f, labels).map((d) => [d.id, d.label])).toEqual([['c', 'C2'], ['b', '#general']]);
  });

  it('add supersedes the same chat’s pending draft for the same destination, and is idempotent by id', () => {
    const f = outboxFile({});
    expect(addDraft({ id: 'd1', session_id: 's1', channel: 'C1', thread_ts: '1.2', messages: ['one'], at: 1_000 }, f).ok).toBe(true);
    expect(addDraft({ id: 'd2', session_id: 's1', channel: 'C1', thread_ts: '1.2', messages: ['two'], at: 2_000 }, f).ok).toBe(true);
    addDraft({ id: 'd3', session_id: 's1', channel: 'C1', messages: ['other dest'], at: 3_000 }, f);
    expect([status(f, 'd1'), status(f, 'd2'), status(f, 'd3')]).toEqual(['superseded', 'pending', 'pending']);
    // The same add again (an event file read twice) changes nothing: d2 stays the live one.
    const before = fs.readFileSync(f, 'utf-8');
    expect(addDraft({ id: 'd1', session_id: 's1', channel: 'C1', thread_ts: '1.2', messages: ['one'], at: 1_000 }, f).detail).toBe('already recorded');
    expect(fs.readFileSync(f, 'utf-8')).toBe(before);
    expect(addDraft({ id: 'bad id!', session_id: 's1', channel: 'C1', messages: ['x'] }, f).ok).toBe(false);
    expect(addDraft({ id: 'd9', session_id: 's1', channel: 'C1', messages: ['  '] }, f).ok).toBe(false);
  });

  it('update revises a pending draft in place and refuses a closed one', () => {
    const f = outboxFile({ p: { ...base, id: 'p', status: 'pending' }, s: { ...base, id: 's', status: 'sent' } });
    expect(updateDraft('p', ['revised'], f).ok).toBe(true);
    expect(readOutbox(f).p.messages).toEqual(['revised']);
    expect(readOutbox(f).p.revised_at).toBeTruthy();
    expect(updateDraft('s', ['x'], f)).toEqual({ ok: false, detail: 'already sent' });
    expect(updateDraft('nope', ['x'], f).detail).toBe('no such draft');
  });

  it('writes the file 0600, atomically', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-')), 'sub', 'outbox.json');
    addDraft({ id: 'd1', session_id: 's1', channel: 'C1', messages: ['x'] }, f);
    expect(fs.statSync(f).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(path.dirname(f))).toEqual(['outbox.json']);
  });

  it('listDrafts: pending, or everything recent with all', () => {
    const now = Date.parse('2026-11-06T12:00:00');
    const f = outboxFile({
      p: { ...base, id: 'p', status: 'pending' },
      s: { ...base, id: 's', status: 'sent', closed_at: '2026-11-05T10:00:00' },
      old: { ...base, id: 'old', status: 'sent', closed_at: '2026-09-01T10:00:00' },
    });
    expect(listDrafts(f, false, 14, now).map((d) => d.id)).toEqual(['p']);
    expect(listDrafts(f, true, 14, now).map((d) => d.id).sort()).toEqual(['p', 's']);
  });
});

describe('legacy outbox import (read-only)', () => {
  const legacyFile = (drafts: Record<string, unknown>) => {
    const f = outboxFile(drafts);
    fs.chmodSync(f, 0o444); // the import must never need to write it
    return f;
  };

  it('imports every draft with its id and fields preserved, and never writes the legacy file', () => {
    const legacy = legacyFile({
      d19a1: { ...base, id: 'd19a1', status: 'pending', thread_ts: '1793839555.348489', thread_url: 'https://a.slack.com/archives/C1/p1793839555348489' },
      d19a2: { ...base, id: 'd19a2', status: 'sent', sent_by: 'chat', permalink: 'https://a.slack.com/x' },
    });
    const before = fs.readFileSync(legacy, 'utf-8');
    const own = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-own-')), 'outbox.json');
    const got = readOutbox({ file: own, legacy });
    expect(Object.keys(got).sort()).toEqual(['d19a1', 'd19a2']);
    expect(got.d19a1).toMatchObject({ ...base, status: 'pending', thread_ts: '1793839555.348489', origin: 'legacy' });
    expect(got.d19a2).toMatchObject({ status: 'sent', sent_by: 'chat', permalink: 'https://a.slack.com/x' });
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(before);
    // A second read is a no-op.
    const ownBefore = fs.readFileSync(own, 'utf-8');
    readOutbox({ file: own, legacy });
    expect(fs.readFileSync(own, 'utf-8')).toBe(ownBefore);
  });

  it('a status the old CLI closed wins over pending; Loom’s own close is never reopened', () => {
    const own: Record<string, Draft> = {
      a: { ...base, id: 'a', status: 'pending' } as Draft,
      b: { ...base, id: 'b', status: 'sent', sent_by: 'loom' } as Draft,
    };
    const changed = mergeLegacy(own, { a: { ...base, id: 'a', status: 'sent', sent_by: 'chat' } as Draft, b: { ...base, id: 'b', status: 'pending' } as Draft });
    expect(changed).toBe(true);
    expect([own.a.status, own.a.sent_by, own.b.status, own.b.sent_by]).toEqual(['sent', 'chat', 'sent', 'loom']);
  });

  it('a later legacy revision carries over while both are pending; a new legacy draft supersedes an older Loom one for the same destination', () => {
    const own: Record<string, Draft> = { a: { ...base, id: 'a', status: 'pending', revised_at: '2026-10-16T09:01:00' } as Draft };
    mergeLegacy(own, { a: { ...base, id: 'a', status: 'pending', messages: ['newer'], revised_at: '2026-10-16T09:02:00' } as Draft });
    expect(own.a.messages).toEqual(['newer']);
    mergeLegacy(own, { z: { ...base, id: 'z', status: 'pending', created_at: '2026-10-16T10:00:00', messages: ['newest'] } as Draft });
    expect([own.a.status, own.z.status]).toEqual(['superseded', 'pending']);
  });
});

describe('send progress and Send now', () => {
  it('tracks posted count and the next post time through a burst, then clears', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01' } });
    const st = slackStub();
    const seen: { sent: number; next_at: number | null; total: number }[] = [];
    const snap = () => { const p = sendProgress().x; if (p) seen.push({ sent: p.sent, next_at: p.next_at, total: p.total }); };
    const slack = {
      ...st.slack,
      sleep: async () => { snap(); },
      post: async (p: any) => { snap(); return st.slack.post(p); },
    };
    const r = await sendDraft('x', ['one', 'two', 'three'], { file: f, slack, now: () => 1000 });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([
      { total: 3, sent: 0, next_at: null }, // posting the first
      { total: 3, sent: 1, next_at: 1000 + burstGapMs('two') }, // gap before the second
      { total: 3, sent: 1, next_at: null }, // posting the second
      { total: 3, sent: 2, next_at: 1000 + burstGapMs('three') },
      { total: 3, sent: 2, next_at: null },
    ]);
    expect(sendProgress()).toEqual({});
  });

  it('Send now ends the current gap early, posts each message exactly once, and only works during a gap', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01' } });
    const st = slackStub();
    const slack = { ...st.slack, sleep: () => new Promise<void>(() => {}) }; // a gap that never ends by itself
    expect(sendNow('x')).toBe(false); // nothing sending
    const run = sendDraft('x', ['one', 'two', 'three'], { file: f, slack });
    await new Promise((r) => setTimeout(r, 20));
    expect(sendProgress().x).toMatchObject({ sent: 1 });
    expect(sendProgress().x.next_at).toBeTypeOf('number');
    expect(st.posts()).toHaveLength(1);
    expect(sendNow('x')).toBe(true);
    expect(sendNow('x')).toBe(false); // one message per press
    await new Promise((r) => setTimeout(r, 20));
    expect(st.posts().map((c) => c.body.text)).toEqual(['one', 'two']);
    expect(sendProgress().x).toMatchObject({ sent: 2 });
    expect(sendNow('x')).toBe(true); // the next gap applies, and can be cut too
    expect((await run).ok).toBe(true);
    expect(st.posts().map((c) => c.body.text)).toEqual(['one', 'two', 'three']);
    expect(readOutbox(f).x.status).toBe('sent');
    expect(sendProgress()).toEqual({});
    expect(sendNow('x')).toBe(false);
  });

  it('clears progress after a partial failure and after a failed single send', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01' } });
    const flaky = slackStub({ 'chat.postMessage': (b, n) => (n === 1 ? { ok: true, channel: b.channel, ts: '1793990000.000001' } : { ok: false, error: 'ratelimited' }) });
    expect(await sendDraft('x', ['a', 'b'], { file: f, slack: flaky.slack })).toMatchObject({ ok: false, partial: 1 });
    expect(sendProgress()).toEqual({});
    const down = slackStub({ 'chat.postMessage': () => ({ ok: false, error: 'channel_not_found' }) });
    expect((await sendDraft('x', ['b'], { file: f, slack: down.slack })).ok).toBe(false);
    expect(sendProgress()).toEqual({});
  });
});

describe('sending (fetch stub; nothing reaches Slack)', () => {
  it('posts exactly the confirmed text to the draft’s destination, then marks it sent with the permalink', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01', thread_ts: '1793985656.300399' } });
    const st = slackStub();
    const r = await sendDraft('x', ['edited **text**'], { file: f, slack: st.slack });
    expect(r).toMatchObject({ ok: true, detail: 'posted' });
    expect(st.posts().map((c) => c.body)).toEqual([{ channel: 'C0TESTOUT01', text: 'edited *text*', thread_ts: '1793985656.300399', unfurl_links: true, unfurl_media: true }]);
    expect(st.calls.every((c) => c.auth === 'Bearer xoxp-test-token')).toBe(true);
    const d = readOutbox(f).x;
    expect(d).toMatchObject({ status: 'sent', sent_by: 'loom' });
    expect(d.permalink).toContain('C0TESTOUT01');
    expect(d.send_started_at).toBeUndefined();
  });

  it('a burst posts each message in order, with a typing gap between them', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01' } });
    const st = slackStub();
    const gaps: number[] = [];
    const r = await sendDraft('x', ['one', 'two'], { file: f, slack: { ...st.slack, sleep: async (ms) => { gaps.push(ms); } } });
    expect(r.ok).toBe(true);
    expect(st.posts().map((c) => c.body.text)).toEqual(['one', 'two']);
    expect(gaps).toEqual([burstGapMs('two')]);
  });

  it('never posts twice: a second Send while the first is in flight is refused', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01' } });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const st = slackStub();
    const slow = { ...st.slack, post: async (p: any) => { await gate; return st.slack.post(p); } };
    const first = sendDraft('x', ['hi'], { file: f, slack: slow });
    const second = await sendDraft('x', ['hi'], { file: f, slack: slow });
    expect(second).toMatchObject({ ok: false });
    // The draft is claimed on disk while it is posted: nothing else may close or supersede it.
    expect(readOutbox(f).x.send_started_at).toBeTypeOf('number');
    expect(closeDraft('x', 'discarded', {}, f).detail).toBe('being sent');
    release();
    expect((await first).ok).toBe(true);
    expect(st.posts()).toHaveLength(1);
    expect(await sendDraft('x', ['hi'], { file: f, slack: st.slack })).toMatchObject({ ok: false, detail: 'already sent' });
    expect(st.posts()).toHaveLength(1);
  });

  it('a send interrupted by a restart is not retried blind', async () => {
    const now = Date.parse('2026-11-06T12:00:00');
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01', send_started_at: now - 60_000 } });
    const st = slackStub();
    expect((await sendDraft('x', ['hi'], { file: f, slack: st.slack, now: () => now })).ok).toBe(false);
    // Past the lock: Slack is checked first, and a post found there is not repeated.
    const later = () => now + 20 * 60_000;
    expect(await sendDraft('x', ['hi'], { file: f, slack: st.slack, now: later, checkPosted: async () => true })).toMatchObject({ ok: false, detail: 'already sent (found in Slack)' });
    expect(st.posts()).toHaveLength(0);
    expect((await sendDraft('x', ['hi'], { file: f, slack: st.slack, now: later, checkPosted: async () => false })).ok).toBe(true);
    expect(st.posts()).toHaveLength(1);
  });

  it('the real check before a retry: a stale claim is looked up in the thread, and a post found there is marked, not resent', async () => {
    const created = '2026-11-05T15:39:07';
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01', thread_ts: '1793839555.348489', created_at: created, messages: ['The export is fixed and ready to download now'], send_started_at: Date.now() - 30 * 60_000 } });
    const st = slackStub();
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = String(url).replace('https://slack.com/api/', '').split('?')[0];
      const out = method === 'auth.test' ? { ok: true, user_id: 'UME' } : { ok: true, messages: [{ ts: String(Date.parse(created) / 1000 + 30) + '.000100', user: 'UME', text: 'The export is fixed and ready to download now' }] };
      return { status: 200, headers: new Headers(), json: async () => out } as Response;
    }) as typeof fetch;
    const r = await sendDraft('x', ['The export is fixed and ready to download now'], {
      file: f, legacy: '', slack: st.slack,
      checkPosted: async (id) => (await reconcileLive({ file: f, legacy: '' }, [id], { token: 'xoxp-test-token', fetchImpl })).includes(id),
    });
    expect(r).toMatchObject({ ok: false, detail: 'already sent (found in Slack)' });
    expect(readOutbox(f).x).toMatchObject({ status: 'sent', sent_by: 'chat' });
    expect(st.posts()).toHaveLength(0);
  });

  it('a failed post leaves the draft pending and unclaimed; a burst that fails part-way keeps only the unsent rest', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: 'C0TESTOUT01' } });
    const down = slackStub({ 'chat.postMessage': () => ({ ok: false, error: 'channel_not_found' }) });
    expect(await sendDraft('x', ['hi'], { file: f, slack: down.slack })).toMatchObject({ ok: false, detail: expect.stringContaining('channel_not_found') });
    expect(readOutbox(f).x).toMatchObject({ status: 'pending', messages: ['hello'] });
    expect(readOutbox(f).x.send_started_at).toBeUndefined();

    const flaky = slackStub({ 'chat.postMessage': (b, n) => (n === 1 ? { ok: true, channel: b.channel, ts: '1793990000.000001' } : { ok: false, error: 'ratelimited' }) });
    const r = await sendDraft('x', ['first', 'second', 'third'], { file: f, slack: flaky.slack });
    expect(r).toMatchObject({ ok: false, partial: 1 });
    const d = readOutbox(f).x;
    expect(d).toMatchObject({ status: 'pending', messages: ['second', 'third'], sent_parts: [{ ts: '1793990000.000001', text: 'first' }] });
    expect(d.send_started_at).toBeUndefined();
    // The retry posts only what is left.
    const ok = slackStub();
    expect((await sendDraft('x', d.messages, { file: f, slack: ok.slack })).ok).toBe(true);
    expect(ok.posts().map((c) => c.body.text)).toEqual(['second', 'third']);
  });

  it('resolves #name and @person destinations; a top-level post starts a thread the chat owns', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', channel: '#general' }, y: { ...base, id: 'y', session_id: 's2', status: 'pending', channel: '@sam' } });
    const st = slackStub({
      'conversations.list': () => ({ ok: true, channels: [{ id: 'C0GENERAL1', name: 'general' }, { id: 'C0OTHER01', name: 'general-chat' }] }),
      'users.list': () => ({ ok: true, members: [{ id: 'U0SAM00001', name: 'sam' }, { id: 'U0SAMANTHA', name: 'samantha' }] }),
      'conversations.open': (b) => ({ ok: true, channel: { id: b.users === 'U0SAM00001' ? 'D0SAMDM001' : 'D0WRONG01' } }),
    });
    const started: string[] = [];
    await sendDraft('x', ['hello all'], { file: f, slack: st.slack, onStarted: (ref, sid) => started.push(`${sid}:${ref.key}`) });
    await sendDraft('y', ['hi sam'], { file: f, slack: st.slack, onStarted: (ref, sid) => started.push(`${sid}:${ref.key}`) });
    expect(st.posts().map((c) => c.body.channel)).toEqual(['C0GENERAL1', 'D0SAMDM001']);
    expect(started).toEqual(['s1:C0GENERAL1/1793990000.000001']); // a DM starts no thread
  });

  it('dry run renders what would post and touches nothing', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending' } });
    const st = slackStub();
    const r = await sendDraft('x', ['**one**', 'two'], { file: f, dry: true, slack: st.slack });
    expect(r).toMatchObject({ ok: true, dry: true, rendered: '*one*\n---\ntwo' });
    expect(st.calls).toEqual([]);
    expect(status(f, 'x')).toBe('pending');
  });

  it('refuses a draft that is gone, already handled, or emptied', async () => {
    const f = outboxFile({ s: { ...base, id: 's', status: 'sent' }, p: { ...base, id: 'p', status: 'pending' } });
    const st = slackStub();
    expect(await sendDraft('nope', ['x'], { file: f, slack: st.slack })).toMatchObject({ ok: false, detail: 'no such draft' });
    expect(await sendDraft('s', ['x'], { file: f, slack: st.slack })).toMatchObject({ ok: false, detail: 'already sent' });
    expect(await sendDraft('p', ['x', '  '], { file: f, slack: st.slack })).toMatchObject({ ok: false });
    expect(await discardDraft('s', f)).toMatchObject({ ok: false, detail: 'already sent' });
    expect(st.calls).toEqual([]);
    expect(await discardDraft('p', f)).toMatchObject({ ok: true });
    expect(status(f, 'p')).toBe('discarded');
  });

  it('sends several messages as one burst payload', () => {
    expect(sendPayload({ channel: '@d' }, ['a', 'b'])).toEqual({ channel: '@d', messages: ['a', 'b'] });
  });

  it('converts markdown to mrkdwn exactly as the old CLI did, leaving code alone', () => {
    expect(toMrkdwn('**b** __i__ ~~s~~ [t](https://x.y/z)\n# H\n* item `**raw**`')).toBe('*b* _i_ ~s~ <https://x.y/z|t>\n*H*\n• item `**raw**`');
  });
});

import { STALE_AFTER_MS, draftSentIn, normalizeForMatch, reconcileDrafts, staleReason } from '../src/outbox.ts';

describe('outbox reconciliation (drafts posted outside Loom)', () => {
  const T = { ...base, channel: 'C1', thread_ts: '1793839555.348489', thread_url: 'https://t.slack.com/archives/C1/p1793839555348489' };
  const created = '2026-11-05T15:39:07';
  const afterTs = String(Date.parse(created) / 1000 + 600) + '.000100';
  const text = 'Ah if you copied it from the help article, that is the generic version -> https://app.example.com/docs?client=X';

  it('normalizes Slack storage (entities, link wrappers, marks)', () => {
    expect(normalizeForMatch('*Go* to -&gt; <https://a.b/c|link>')).toBe('go to -> link https://a.b/c');
    expect(draftSentIn([text], ['Ah if you copied it from the help article, that is the generic version -&gt; <https://app.example.com/docs?client=X>'])).toBe(true);
    expect(draftSentIn([text], ['something unrelated entirely'])).toBe(false);
  });

  it('marks a pending draft sent when Will’s message is in the thread, never posting', async () => {
    const f = outboxFile({ x: { ...T, id: 'x', status: 'pending', created_at: created, messages: [text] } });
    const marked: [string, string][] = [];
    const ids = await reconcileDrafts({
      file: f, me: 'UME',
      replies: async () => [{ ts: afterTs, user: 'UME', text: text.replace('->', '-&gt;') }],
      mark: async (id, p) => { marked.push([id, p]); },
    });
    expect(ids).toEqual(['x']);
    expect(marked[0][0]).toBe('x');
    expect(marked[0][1]).toContain('thread_ts=1793839555.348489');
  });

  it('matches a superseded revision of the same chat’s draft', async () => {
    const f = outboxFile({
      old: { ...T, id: 'old', status: 'superseded', created_at: '2026-11-05T15:28:42', messages: [text] },
      cur: { ...T, id: 'cur', status: 'pending', created_at: created, messages: ['A rewritten second opinion that was not posted anywhere'] },
    });
    const ids = await reconcileDrafts({ file: f, me: 'UME', replies: async () => [{ ts: afterTs, user: 'UME', text }], mark: async () => {} });
    expect(ids).toEqual(['cur']);
  });

  it('leaves it pending for someone else’s message, an older message, a non-thread draft, or a read failure', async () => {
    const f = outboxFile({ x: { ...T, id: 'x', status: 'pending', created_at: created, messages: [text] }, y: { ...base, id: 'y', status: 'pending', messages: [text] } });
    const mark = async () => { throw new Error('must not mark'); };
    expect(await reconcileDrafts({ file: f, me: 'UME', replies: async () => [{ ts: afterTs, user: 'OTHER', text }], mark })).toEqual([]);
    expect(await reconcileDrafts({ file: f, me: 'UME', replies: async () => [{ ts: '1700000000.000100', user: 'UME', text }], mark })).toEqual([]);
    expect(await reconcileDrafts({ file: f, me: 'UME', replies: async () => { throw new Error('ratelimited'); }, mark })).toEqual([]);
  });
});

describe('outbox: unthreaded drafts and stale marks', () => {
  const created = '2026-11-05T15:39:07';
  const afterTs = String(Date.parse(created) / 1000 + 600) + '.000100';
  const text = 'Heads up, the Q3 amendment export is fixed and ready to download from the Tax Filings page';

  it('finds a top-level or DM draft in the channel history, read-only', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', channel: 'C9', status: 'pending', created_at: created, messages: [text] } });
    const asked: string[] = [];
    const ids = await reconcileDrafts({
      file: f, me: 'UME', replies: async () => [],
      history: async (ch, oldest) => { asked.push(ch + '@' + oldest); return [{ ts: afterTs, user: 'UME', text }]; },
      mark: async () => {},
    });
    expect(ids).toEqual(['x']);
    expect(asked[0].startsWith('C9@')).toBe(true);
  });

  it('does not match someone else’s post in the history', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', channel: 'C9', status: 'pending', created_at: created, messages: [text] } });
    const ids = await reconcileDrafts({ file: f, me: 'UME', replies: async () => [], history: async () => [{ ts: afterTs, user: 'OTHER', text }], mark: async () => { throw new Error('no'); } });
    expect(ids).toEqual([]);
  });

  it('reports threads where Will posted something else after the draft', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', created_at: created, thread_ts: '1793839555.348489', messages: [text] } });
    let seen: string[] = [];
    await reconcileDrafts({
      file: f, me: 'UME', willPosted: (ids) => { seen = ids; }, mark: async () => {},
      replies: async () => [{ ts: afterTs, user: 'UME', text: 'a completely different follow-up from Will in the thread' }],
    });
    expect(seen).toEqual(['x']);
  });

  it('staleReason: ended chat, or old with a newer post by Will; never a live recent draft', () => {
    const now = Date.parse('2026-11-06T12:00:00');
    const d = { created_at: created };
    expect(staleReason(d, { chatLive: false, willPostedAfter: false, now })).toBe('chat ended');
    expect(staleReason(d, { chatLive: true, willPostedAfter: true, now: Date.parse('2026-11-08T12:00:00') })).toContain('posted');
    expect(staleReason(d, { chatLive: true, willPostedAfter: true, now })).toBe(''); // only 20h old
    expect(staleReason(d, { chatLive: true, willPostedAfter: false, now })).toBe('');
    expect(staleReason({ created_at: '2026-11-06T11:00:00' }, { chatLive: true, willPostedAfter: true, now })).toBe('');
    expect(STALE_AFTER_MS).toBe(48 * 3600_000);
  });

  it('pendingDrafts marks stale ones but keeps every one of them', () => {
    const f = outboxFile({
      a: { ...base, id: 'a', status: 'pending', session_id: 'gone' },
      b: { ...base, id: 'b', status: 'pending', session_id: 'alive', created_at: '2026-11-06T11:00:00' },
    });
    const out = pendingDrafts(f, '/nonexistent', { liveSessions: new Set(['alive']), marks: {}, now: Date.parse('2026-11-06T12:00:00') });
    expect(out.map((d) => [d.id, d.stale ?? false, d.stale_reason ?? ''])).toEqual([['a', true, 'chat ended'], ['b', false, '']]);
  });
});

describe('legacy outbox while the old CLI still writes it (migrated installs)', () => {
  const FIX = path.join(__dirname, 'fixtures', 'state', 'slack-outbox.json');
  const PENDING = 'd19a3c0f9c3d';
  /** A copy of the fixture: the live legacy file is never touched. */
  const copy = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-legacy-'));
    const legacy = path.join(d, 'slack-outbox.json');
    fs.copyFileSync(FIX, legacy);
    return { legacy, file: path.join(d, 'outbox.json') };
  };
  const legacyDrafts = (f: string) => JSON.parse(fs.readFileSync(f, 'utf-8')).drafts as Record<string, Draft>;
  /** What the old CLI's `outbox add` does: supersede this chat's pending draft for the destination, add the new one. */
  const oldCliAdd = (legacy: string, d: Partial<Draft> & { id: string }) => {
    const data = JSON.parse(fs.readFileSync(legacy, 'utf-8'));
    for (const x of Object.values(data.drafts) as Draft[]) {
      if (x.status === 'pending' && x.session_id === d.session_id && x.channel === d.channel && (x.thread_ts ?? '') === (d.thread_ts ?? '')) Object.assign(x, { status: 'superseded', closed_at: d.created_at });
    }
    data.drafts[d.id] = { status: 'pending', ...d };
    fs.writeFileSync(legacy + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(legacy + '.tmp', legacy);
  };

  it('keeps picking up NEW drafts written to the legacy file after the first import, ids preserved, no duplicates', () => {
    const { legacy, file } = copy();
    const o = { file, legacy };
    expect(Object.keys(readOutbox(o)).sort()).toEqual(['d19a3c0f1a2b', 'd19a3c0f9c3d', 'd19a3c1a0001']);
    const sid = '11111111-2222-3333-4444-555555555555';
    oldCliAdd(legacy, { id: 'd19a3d000001', session_id: sid, channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', messages: ['a newer revision'], created_at: '2026-11-06T10:00:00' });
    oldCliAdd(legacy, { id: 'd19a3d000002', session_id: 'another-chat', channel: 'D0TESTDM01', messages: ['a new DM draft'], created_at: '2026-11-06T10:01:00' });
    const got = readOutbox(o);
    expect(Object.keys(got).sort()).toEqual(['d19a3c0f1a2b', 'd19a3c0f9c3d', 'd19a3c1a0001', 'd19a3d000001', 'd19a3d000002']);
    expect(got.d19a3d000001).toMatchObject({ status: 'pending', messages: ['a newer revision'] });
    expect(got[PENDING].status).toBe('superseded');
    expect(pendingDrafts(file, '/nonexistent', { legacy }).map((d) => d.id)).toEqual(['d19a3d000001', 'd19a3d000002']);
    // Reading again, or after the file is touched with nothing new, duplicates nothing.
    const t = new Date(Date.now() + 5000);
    fs.utimesSync(legacy, t, t);
    expect(Object.keys(readOutbox(o))).toHaveLength(5);
    expect(Object.keys(JSON.parse(fs.readFileSync(file, 'utf-8')).drafts)).toHaveLength(5);
  });

  it('writes a Loom Send back to the legacy file: only the close fields on that id, under the old CLI’s format', async () => {
    const { legacy, file } = copy();
    const before = legacyDrafts(legacy);
    const st = slackStub();
    const r = await sendDraft(PENDING, before[PENDING].messages, { file, legacy, writeBack: true, slack: st.slack });
    expect(r.ok).toBe(true);
    const after = legacyDrafts(legacy);
    const mine = readOutbox({ file, legacy })[PENDING];
    expect(after[PENDING]).toEqual({ ...before[PENDING], status: 'sent', closed_at: mine.closed_at, sent_at: mine.sent_at, sent_by: 'loom', permalink: mine.permalink });
    for (const id of Object.keys(before)) if (id !== PENDING) expect(after[id]).toEqual(before[id]);
    // The same write the old CLI makes: indent 2, sorted keys, atomic (no tmp left behind).
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(JSON.stringify(sortKeys(JSON.parse(fs.readFileSync(legacy, 'utf-8'))), null, 2));
    expect(fs.readdirSync(path.dirname(legacy)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    // And reading it back changes nothing in Loom.
    expect(readOutbox({ file, legacy })[PENDING].sent_by).toBe('loom');
  });

  it('writes discards and supersedes back too', () => {
    const { legacy, file } = copy();
    const o = { file, legacy, writeBack: true };
    addDraft({ id: 'd19a3e000001', session_id: '11111111-2222-3333-4444-555555555555', channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', messages: ['newer, via loom outbox add'] }, o);
    expect(legacyDrafts(legacy)[PENDING].status).toBe('superseded');
    expect(legacyDrafts(legacy).d19a3e000001).toBeUndefined(); // Loom's own drafts are not copied into the old file
    const { legacy: l2, file: f2 } = copy();
    closeDraft(PENDING, 'discarded', {}, { file: f2, legacy: l2, writeBack: true });
    expect(legacyDrafts(l2)[PENDING]).toMatchObject({ status: 'discarded' });
    expect(legacyDrafts(l2)[PENDING].closed_at).toBeTruthy();
  });

  it('never writes the legacy file unless write-back is on, and never reopens or overwrites a draft the old file already closed', async () => {
    const { legacy, file } = copy();
    const bytes = fs.readFileSync(legacy, 'utf-8');
    await sendDraft(PENDING, ['x'], { file, legacy, slack: slackStub().slack });
    expect(fs.readFileSync(legacy, 'utf-8')).toBe(bytes);
    const { legacy: l2, file: f2 } = copy();
    readOutbox({ file: f2, legacy: l2 }); // imported
    const data = JSON.parse(fs.readFileSync(l2, 'utf-8'));
    data.drafts[PENDING].status = 'sent';
    data.drafts[PENDING].sent_by = 'chat';
    fs.writeFileSync(l2, JSON.stringify(data, null, 2));
    // Loom has not seen that yet (same mtime second is fine: size changed) and tries to discard: the old file keeps 'sent'.
    closeDraft(PENDING, 'discarded', {}, { file: f2, legacy: l2, writeBack: true });
    expect(legacyDrafts(l2)[PENDING]).toMatchObject({ status: 'sent', sent_by: 'chat' });
  });

  it('waits for the old CLI’s lock', () => {
    const { legacy } = copy();
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const holder = spawn('python3', ['-c', `import fcntl,time,sys\nf=open(sys.argv[1]+'.lock','w')\nfcntl.flock(f,fcntl.LOCK_EX)\nprint('locked',flush=True)\ntime.sleep(1.2)`, legacy]);
    return new Promise<void>((resolve, reject) => {
      holder.stdout.once('data', () => {
        const t0 = Date.now();
        const done = legacyWriteBack(legacy, [{ id: PENDING, status: 'discarded', closed_at: '2026-11-06T12:00:00' }]);
        try {
          expect(Date.now() - t0).toBeGreaterThan(700);
          expect(done).toEqual([PENDING]);
          resolve();
        } catch (e) {
          reject(e);
        }
      });
    });
  });
});

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  return v;
}
