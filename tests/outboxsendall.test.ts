import { LOADING_MARK_JS } from '../src/logo.ts';
import { describe, it, expect } from 'vitest';
import { BRAND_ICONS_JS } from '../src/brandicons.ts';
import { OUTBOX_PURE_JS, OUTBOX_VIEW_JS } from '../src/outboxview.ts';
import { renderDashboard } from '../src/dashboard.ts';

const lib = new Function(
  `${OUTBOX_PURE_JS}; return { draftSendable, sendAllBatch, batchOverlaps, batchStaleNote, draftFirstLine, runSendAll };`,
)() as {
  draftSendable: (d: any, texts: string[], busy?: any) => boolean;
  sendAllBatch: (ds: any[], textsOf: (d: any) => string[], busy?: any) => any[];
  batchOverlaps: (ds: any[]) => { nums: number[]; kind: string; text: string }[];
  batchStaleNote: (d: any, now: number) => string;
  draftFirstLine: (d: any, texts: string[]) => string;
  runSendAll: (items: any[], after: string, io: any) => Promise<any>;
};

const NOW = Date.parse('2026-11-05T12:00:00Z');
const dr = (id: string, created: string, x: object = {}) => ({ id, session_id: 'S', status: 'pending', channel: 'C1', created_at: created, messages: ['hi ' + id], ...x });
const texts = (d: any) => (d.email ? [d.email.body] : d.messages.slice());

describe('send all: which drafts are sendable', () => {
  it('takes a plain pending draft', () => {
    const d = dr('a', '2026-11-05T10:00:00Z');
    expect(lib.draftSendable(d, texts(d), {})).toBe(true);
  });
  it('leaves out drafts that are posting, leaving, redrafting, scheduled or closed', () => {
    const d = dr('a', '2026-11-05T10:00:00Z');
    expect(lib.draftSendable({ ...d, status: 'sent' }, texts(d))).toBe(false);
    expect(lib.draftSendable({ ...d, send_state: 'sending' }, texts(d))).toBe(false);
    expect(lib.draftSendable(d, texts(d), { sending: { a: { total: 1, sent: 0 } } })).toBe(false);
    expect(lib.draftSendable(d, texts(d), { local: { a: 1 } })).toBe(false);
    expect(lib.draftSendable(d, texts(d), { leaving: { a: 1 } })).toBe(false);
    expect(lib.draftSendable(d, texts(d), { redraft: { a: 1 } })).toBe(false);
    expect(lib.draftSendable({ ...d, redraft: { active: true, ids: [] } }, texts(d))).toBe(false);
    expect(lib.draftSendable({ ...d, scheduled: { step_id: 'x', label: 'Scheduled' } }, texts(d))).toBe(false);
  });
  it('a failed send in the chat, or a kept redraft, can still be sent', () => {
    const d = dr('a', '2026-11-05T10:00:00Z', { send_state: 'failed', redraft: { active: false, kept: true, ids: ['m1'] } });
    expect(lib.draftSendable(d, texts(d))).toBe(true);
  });
  it('needs text or files on every message, as a card\'s Send does', () => {
    const d = dr('a', '2026-11-05T10:00:00Z', { messages: ['one', ''] });
    expect(lib.draftSendable(d, ['one', ''])).toBe(false);
    expect(lib.draftSendable({ ...d, files: [[], ['/x/shot.png']] }, ['one', ''])).toBe(true);
    expect(lib.draftSendable(d, [' ', 'two'])).toBe(false); // an edit emptied message 1
  });
  it('takes review-only and email drafts', () => {
    expect(lib.draftSendable(dr('r', '2026-11-05T10:00:00Z', { messages: [], review: { repo: 'o/r', pr: 1, event: 'COMMENT', body: 'ok', commit_id: 'abc' } }), [])).toBe(true);
    expect(lib.draftSendable(dr('m', '2026-11-05T10:00:00Z', { messages: [], email: { to: ['a@example.com'], subject: 's', body: 'b' } }), ['b'])).toBe(true);
    expect(lib.draftSendable(dr('n', '2026-11-05T10:00:00Z', { messages: [] }), [])).toBe(false);
  });
  it('batches the sendable ones oldest first', () => {
    const ds = [dr('c', '2026-11-05T11:00:00Z'), dr('a', '2026-11-05T09:00:00Z'), dr('b', '2026-11-05T10:00:00Z', { send_state: 'sending' }), dr('d', '2026-11-05T10:30:00Z')];
    expect(lib.sendAllBatch(ds, texts, {}).map((d) => d.id)).toEqual(['a', 'd', 'c']);
    expect(lib.sendAllBatch(ds, texts, { local: { a: 1 } }).map((d) => d.id)).toEqual(['d', 'c']);
  });
});

describe('send all: same-destination callout', () => {
  it('names drafts that post to the same thread, the later one as a possible rewrite', () => {
    const ds = [
      dr('a', '1', { thread_ts: '1700000000.000100' }),
      dr('b', '2', { channel: 'C2' }),
      dr('c', '3', { thread_ts: '1700000000.000100' }),
    ];
    expect(lib.batchOverlaps(ds)).toEqual([{ nums: [1, 3], kind: 'the same thread', text: '#1 and #3 post to the same thread — #3 may be a rewrite of #1' }]);
  });
  it('covers three-way overlaps, top-level channel posts, PRs and email threads', () => {
    const three = [dr('a', '1'), dr('b', '2'), dr('c', '3')];
    expect(lib.batchOverlaps(three)[0].text).toBe('#1, #2 and #3 post to the same channel — #3 may be a rewrite of the earlier ones');
    const rv = { repo: 'o/r', pr: 7, event: 'COMMENT', body: '', commit_id: 'abc' };
    // A review + Slack draft and a review-only draft share the PR, not the Slack thread.
    const pr = [dr('a', '1', { review: rv, thread_ts: '1.2' }), dr('b', '2', { review: rv, messages: [] })];
    expect(lib.batchOverlaps(pr).map((o) => o.kind)).toEqual(['the same PR']);
    const mail = (id: string) => dr(id, id, { messages: [], email: { to: ['x@example.com'], subject: 'Re: hi', threadId: 't1', body: 'b' } });
    expect(lib.batchOverlaps([mail('1'), mail('2')]).map((o) => o.kind)).toEqual(['the same email thread']);
  });
  it('says nothing when every draft goes somewhere else', () => {
    expect(lib.batchOverlaps([dr('a', '1'), dr('b', '2', { channel: 'C2' }), dr('c', '3', { thread_ts: '9.9' })])).toEqual([]);
  });
  it('drops "newer draft in this chat" but keeps every other stale reason', () => {
    expect(lib.batchStaleNote(dr('a', '2026-11-05T09:00:00Z'), NOW)).toBe('');
    expect(lib.batchStaleNote(dr('a', '2026-11-04T09:00:00Z'), NOW)).toBe('over 24h old');
    expect(lib.batchStaleNote(dr('a', '2026-11-05T09:00:00Z', { stale: true, stale_reason: 'chat ended' }), NOW)).toBe('chat ended');
  });
  it('quotes the first non-empty line', () => {
    expect(lib.draftFirstLine(dr('a', '1'), ['\n  first line\nsecond'])).toBe('first line');
    expect(lib.draftFirstLine(dr('a', '1', { files: [['/x.png']] }), [''])).toBe('(images only)');
  });
});

describe('send all: the run', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const io = (reply: (id: string) => any, ready: (id: string) => boolean = () => true) => {
    const calls: [string, string][] = [];
    const prog: string[] = [];
    return {
      calls, prog,
      ready: (it: any) => ready(it.id),
      progress: (it: any, sent: number, n: number) => prog.push(`${it.id} ${sent + 1}/${n}`),
      send: (it: any, after: string) => { calls.push([it.id, after]); return Promise.resolve(reply(it.id)); },
    };
  };
  it('sends oldest first, one at a time, with park/close only on the last', async () => {
    const x = io(() => ({ ok: true }));
    const r = await lib.runSendAll(items, 'park', x);
    expect(x.calls).toEqual([['a', 'none'], ['b', 'none'], ['c', 'park']]);
    expect(x.prog).toEqual(['a 1/3', 'b 2/3', 'c 3/3']);
    expect(r).toMatchObject({ sent: 3, total: 3, stopped: null });
  });
  it('waits for each send before starting the next', async () => {
    let open = 0, most = 0;
    const r = await lib.runSendAll(items, 'none', {
      ready: () => true,
      send: () => { open++; most = Math.max(most, open); return new Promise((res) => setTimeout(() => { open--; res({ ok: true }); }, 5)); },
    });
    expect(most).toBe(1);
    expect(r.sent).toBe(3);
  });
  it('stops at a refusal and leaves the rest untouched', async () => {
    const x = io((id) => (id === 'b' ? { ok: false, stale_thread: [{ id: 'm1' }] } : { ok: true }));
    const r = await lib.runSendAll(items, 'close', x);
    expect(x.calls).toEqual([['a', 'none'], ['b', 'none']]);
    expect(r).toMatchObject({ sent: 1, total: 3, index: 1, stopped: { id: 'b' }, result: { ok: false } });
  });
  it('stops on any other failure and when the server is off', async () => {
    const failed = await lib.runSendAll(items, 'none', io((id) => (id === 'a' ? { ok: false, detail: 'already sent' } : { ok: true })));
    expect(failed).toMatchObject({ sent: 0, stopped: { id: 'a' }, result: { detail: 'already sent' } });
    const off = io(() => ({ ok: true }));
    off.send = (it: any, after: string) => { off.calls.push([it.id, after]); return Promise.reject(new Error('fetch failed')); };
    const r = await lib.runSendAll(items, 'none', off);
    expect(off.calls).toEqual([['a', 'none']]);
    expect(r.sent).toBe(0);
    expect(r.error).toBeTruthy();
  });
  it('skips a draft that stopped being sendable, and moves park onto the last one still sendable', async () => {
    const x = io(() => ({ ok: true }), (id) => id !== 'c');
    const r = await lib.runSendAll(items, 'park', x);
    expect(x.calls).toEqual([['a', 'none'], ['b', 'park']]);
    expect(r).toMatchObject({ sent: 2, skipped: 1, stopped: null });
  });
});

describe('send all: the rail', () => {
  const rail = (drafts: any[], batch: object | null) =>
    new Function(
      'DATA', 'esc', 'rel', 'hhmm', 'NL',
      `var TERM_TOKEN='t',SENDING={},SEND_LOCAL={},LEAVING={},DRAFT_EDITS={},DRAFT_EDIT_ON={},draftConfirm=null,draftArmDiscard=null,draftMsg={},SLK_DIR=null,SLK_EMOJI=null;
       var slkCtx=function(){return {users:{},channels:{},emoji:{},custom:{}};};
       ${BRAND_ICONS_JS}${LOADING_MARK_JS}${OUTBOX_PURE_JS}${OUTBOX_VIEW_JS.slice(OUTBOX_VIEW_JS.indexOf('function draftTexts'))}
       FRESH={b:{at:Date.now(),items:[{id:'m1',author:'Dana',snippet:'any news?',at:1}]}};
       BATCH=${JSON.stringify(batch)};
       return sendAllHtml(DATA.drafts,${NOW});`,
    )({ drafts }, (x: string) => String(x).replace(/</g, '&lt;'), () => '', () => '10:00', '\n') as string;
  const ds = [dr('a', '2026-11-05T09:00:00Z', { thread_ts: '1.1' }), dr('b', '2026-11-05T10:00:00Z', { channel: 'C2' }), dr('c', '2026-11-05T11:00:00Z', { thread_ts: '1.1' })];

  it('offers Send all (N) only with two or more sendable drafts', () => {
    expect(rail(ds, null)).toContain('data-sall="open"');
    expect(rail(ds, null)).toContain('Send all (3)');
    expect(rail(ds.slice(0, 1), null)).not.toContain('data-sall="open"');
    expect(rail([ds[0], { ...ds[1], send_state: 'sending' }], null)).not.toContain('data-sall="open"');
  });
  it('the confirm lists each draft in order with its warnings, the overlap callout and the four buttons', () => {
    const html = rail(ds, { phase: 'confirm', sid: 'S', ids: ['a', 'b', 'c'] });
    expect(html.indexOf('#1</b>')).toBeLessThan(html.indexOf('#2</b>'));
    expect(html).toContain('hi a');
    expect(html).toContain('#1 and #3 post to the same thread — #3 may be a rewrite of #1');
    expect(html).toContain('1 new message since this was drafted'); // b's own fresh-check warning
    expect(html).not.toContain('newer draft in this chat');
    for (const a of ['post-none', 'post-park', 'post-close', 'cancel']) expect(html).toContain(`data-sall="${a}"`);
    expect(html).toContain('Send all anyway');
    expect(html).toContain('Enter send all · ⌥Enter send all &amp; park · ⇧Enter send all &amp; close · Esc cancel');
  });
  it('shows progress while sending', () => {
    expect(rail(ds, { phase: 'sending', sid: 'S', ids: ['a', 'b', 'c'], k: 2, n: 3 })).toContain('Sending 2 of 3…');
  });
  it('is wired into the rail, through the same send request as a card', () => {
    const html = renderDashboard([], 1);
    expect(html).toContain("'<div id=\"outcards\">'+(ds.length?sendAllHtml(ds,now)+ds.map(");
    expect(html).toContain('outboxSendReq(it.id,draftTexts(d),a,it.ack_stale,it.ack_fresh)');
    expect(html.match(/fetch\('\/api\/outbox\/send'/g)!.length).toBe(1);
  });
});
