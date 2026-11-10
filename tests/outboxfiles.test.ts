import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDraft, draftImage, readOutbox, sendDraft, slackPoster, updateDraft, type SlackPoster } from '../src/outbox.ts';
import { OUTBOX_PURE_JS, OUTBOX_VIEW_JS } from '../src/outboxview.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-files-'));
const png = (n: string) => {
  const p = path.join(dir, n);
  fs.writeFileSync(p, Buffer.from('89504e470d0a1a0a', 'hex'));
  return p;
};
const store = () => path.join(fs.mkdtempSync(path.join(dir, 's-')), 'outbox.json');
const add = (f: string, over: Record<string, unknown> = {}) =>
  addDraft({ id: 'x', session_id: 's', channel: 'C0TESTOUT01', messages: ['top'], ...over } as any, { file: f });

interface Call { kind: 'post' | 'upload'; thread_ts?: string; text?: string; paths?: string[] }
function stub(failAt: number | null = null) {
  const calls: Call[] = [];
  let n = 0;
  const slack: SlackPoster = {
    resolveChannel: async (t) => t,
    post: async (p) => { if (n++ === failAt) throw new Error('ratelimited'); calls.push({ kind: 'post', thread_ts: p.thread_ts, text: p.text }); return { channel: p.channel, ts: `1793990000.00000${n}` }; },
    upload: async (p) => { if (n++ === failAt) throw new Error('upload_failed'); calls.push({ kind: 'upload', thread_ts: p.thread_ts, text: p.comment, paths: p.paths }); return { channel: p.channel, ts: `1793990000.00000${n}` }; },
    permalink: async (c, ts) => `https://acme.slack.com/archives/${c}/p${ts.replace('.', '')}`,
    sleep: async () => {},
  };
  return { slack, calls };
}

describe('files on a draft', () => {
  it('persists files per message, and rejects relative paths and an images-only message without files', () => {
    const f = store();
    const a = png('a.png');
    expect(add(f, { messages: ['top', 'more'], files: [[a], []] }).ok).toBe(true);
    expect(readOutbox(f).x.files).toEqual([[a], []]);
    expect(add(store(), { files: [['rel.png']] })).toMatchObject({ ok: false });
    expect(add(store(), { messages: ['top', ''] })).toMatchObject({ ok: false });
    expect(add(store(), { messages: ['top', ''], files: [[], [a]] }).ok).toBe(true);
  });

  it('update keeps files when omitted with the same count, replaces them when given, drops them when the count changes', () => {
    const f = store();
    const a = png('a.png'), b = png('b.png');
    add(f, { files: [[a]] });
    expect(updateDraft('x', ['top v2'], { file: f }).ok).toBe(true);
    expect(readOutbox(f).x.files).toEqual([[a]]);
    updateDraft('x', ['top v3'], { file: f }, Date.now() + 1000, [[b]]);
    expect(readOutbox(f).x.files).toEqual([[b]]);
    updateDraft('x', ['top v3', 'two'], { file: f }, Date.now() + 2000);
    expect(readOutbox(f).x.files).toBeUndefined();
    updateDraft('x', ['top v3', ''], { file: f }, Date.now() + 3000, [[], [a]]);
    expect(readOutbox(f).x.files).toEqual([[], [a]]);
  });

  it('serves only an image recorded on the draft, by index', () => {
    const f = store();
    const a = png('a.png');
    const txt = path.join(dir, 'secret.txt');
    fs.writeFileSync(txt, 'nope');
    add(f, { messages: ['top', 'two'], files: [[a], [txt]] });
    expect(draftImage('x', 0, 0, { file: f })?.type).toBe('image/png');
    expect(draftImage('x', 1, 0, { file: f })).toBeNull(); // not an image
    expect(draftImage('x', 0, 1, { file: f })).toBeNull();
    expect(draftImage('nope', 0, 0, { file: f })).toBeNull();
  });
});

describe('sending files', () => {
  it('uploads each message’s files in order, text as the comment, and an images-only message threads under message 1', async () => {
    const f = store();
    const a = png('a.png'), b = png('b.png'), c = png('c.png');
    add(f, { messages: ['top', 'then', ''], files: [[a], [], [b, c]] });
    const st = stub();
    const r = await sendDraft('x', ['top', 'then', ''], { file: f, slack: st.slack });
    expect(r.ok).toBe(true);
    expect(st.calls).toEqual([
      { kind: 'upload', thread_ts: undefined, text: 'top', paths: [a] },
      { kind: 'post', thread_ts: undefined, text: 'then' },
      { kind: 'upload', thread_ts: '1793990000.000001', text: undefined, paths: [b, c] },
    ]);
    expect(readOutbox(f).x.status).toBe('sent');
  });

  it('in a thread draft every message and its files stay in that thread', async () => {
    const f = store();
    const a = png('a.png');
    add(f, { thread_ts: '1793985656.300399', messages: ['reply', ''], files: [[], [a]] });
    const st = stub();
    await sendDraft('x', ['reply', ''], { file: f, slack: st.slack });
    expect(st.calls.map((c) => c.thread_ts)).toEqual(['1793985656.300399', '1793985656.300399']);
  });

  it('a failure part-way never re-uploads what is out: the retry sends only the rest', async () => {
    const f = store();
    const a = png('a.png'), b = png('b.png');
    add(f, { messages: ['top', 'two', ''], files: [[a], [], [b]] });
    const bad = stub(1);
    const r = await sendDraft('x', ['top', 'two', ''], { file: f, slack: bad.slack });
    expect(r).toMatchObject({ ok: false, partial: 1 });
    expect(readOutbox(f).x.messages).toEqual(['two', '']);
    expect(readOutbox(f).x.files).toEqual([[], [b]]);
    expect(readOutbox(f).x.sent_parts).toHaveLength(1);
    const good = stub();
    const r2 = await sendDraft('x', ['two', ''], { file: f, slack: good.slack });
    expect(r2.ok).toBe(true);
    expect(good.calls.map((c) => c.kind)).toEqual(['post', 'upload']);
    // the images-only message still threads under message 1 (posted in the first attempt)
    expect(good.calls[1].thread_ts).toBe(readOutbox(f).x.sent_parts![0].ts);
  });

  it('a failed first upload leaves the draft whole and pending', async () => {
    const f = store();
    add(f, { files: [[png('a.png')]] });
    const r = await sendDraft('x', ['top'], { file: f, slack: stub(0).slack });
    expect(r.ok).toBe(false);
    expect(readOutbox(f).x).toMatchObject({ status: 'pending', messages: ['top'] });
    expect(readOutbox(f).x.send_started_at).toBeUndefined();
  });

  it('refuses before posting anything when a file is gone, and a dry run lists the files', async () => {
    const f = store();
    const a = png('gone.png');
    add(f, { messages: ['top', 'two'], files: [[], [a]] });
    const dry = await sendDraft('x', ['top', 'two'], { file: f, dry: true, slack: stub().slack });
    expect(dry.rendered).toContain('[+ 1 file: gone.png]');
    fs.rmSync(a);
    const st = stub();
    expect(await sendDraft('x', ['top', 'two'], { file: f, slack: st.slack })).toMatchObject({ ok: false, detail: expect.stringContaining('file not found') });
    expect(st.calls).toEqual([]);
  });

  it('the real poster runs the three-step upload against the stub (no network)', async () => {
    const a = png('a.png');
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const u = String(url);
      seen.push(u.replace('https://slack.com/api/', '').split('?')[0]);
      let out: any = { ok: true };
      if (u.includes('getUploadURLExternal')) out = { ok: true, upload_url: 'https://files.slack.test/up', file_id: 'F1' };
      if (u.includes('completeUploadExternal')) out = { ok: true, files: [{ id: 'F1' }], _body: JSON.parse(String(init.body)) };
      if (u.includes('files.info')) out = { ok: true, file: { shares: { public: { C0TESTOUT01: [{ ts: '1793990000.000009' }] } } } };
      return { ok: true, status: 200, headers: new Headers(), json: async () => out } as Response;
    }) as typeof fetch;
    const poster = slackPoster({ token: 'xoxp-test-token', fetchImpl });
    const r = await poster.upload({ channel: 'C0TESTOUT01', thread_ts: '1.2', paths: [a], comment: 'hi' });
    expect(r.ts).toBe('1793990000.000009');
    expect(seen).toEqual(['files.getUploadURLExternal', 'https://files.slack.test/up', 'files.completeUploadExternal', 'files.info']);
  });
});

describe('the card shows where files land', () => {
  const lib = new Function(`${OUTBOX_PURE_JS}; return { fileWhere, filesLabel };`)() as any;
  const html = (draft: object) =>
    new Function(
      'DATA', 'esc', 'rel', 'hhmm', 'NL',
      `var TERM_TOKEN='t',SENDING={},SEND_LOCAL={},LEAVING={},DRAFT_EDITS={},DRAFT_EDIT_ON={},draftConfirm=null,draftArmDiscard=null,draftMsg={},SLK_DIR=null,SLK_EMOJI=null;
       var slkCtx=function(){return {users:{}};};var slkRender=function(m){return '<p>'+esc(m)+'</p>';};
       var slkBubbles=function(ms,c,t,ex){return ms.map(function(m,i){return '<div class="b">'+slkRender(m)+(ex[i]||'')+'</div>';}).join('');};
       ${OUTBOX_PURE_JS}${OUTBOX_VIEW_JS.slice(OUTBOX_VIEW_JS.indexOf('function draftTexts'))}
       return draftCardHtml(DATA.drafts[0],{});`,
    )({ drafts: [draft] }, (x: string) => x, () => '', () => '10:00', '\n') as string;

  it('labels a top-level post, an in-channel follow-up and a thread reply, with thumbnails under the right message', () => {
    const out = html({ id: 'd1', session_id: 's', created_at: '2026-11-09T10:00:00Z', channel: 'C1', messages: ['top', ''], files: [['/x/1.png'], ['/x/2.png', '/x/3.png']] });
    const first = out.indexOf('src="/api/outbox/file?id=d1&m=0&f=0"');
    const second = out.indexOf('src="/api/outbox/file?id=d1&m=1&f=0"');
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(out).toContain('src="/api/outbox/file?id=d1&m=1&f=1"');
    expect(out).toContain('Posts top-level in the channel');
    expect(out).toContain('Posts as a thread reply under message 1');
  });
  it('an in-thread draft labels its files as the thread', () => {
    expect(html({ id: 'd2', session_id: 's', created_at: '2026-11-09T10:00:00Z', channel: 'C1', thread_ts: '1.2', messages: ['r'], files: [['/x/1.png']] })).toContain('Posts in the thread');
    expect(lib.fileWhere({ files: [[], ['/a.png']] }, 1, '')).toBe('thread');
    expect(lib.fileWhere({ files: [[], ['/a.png']] }, 1, 'text')).toBe('channel');
  });
  it('an images-only message still passes the Send guard in the page script', () => {
    expect(OUTBOX_VIEW_JS).toContain('!t.trim()&&!draftFilesOf(d,i).length');
  });
});
