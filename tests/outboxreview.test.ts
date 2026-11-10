import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDraft, burstGapMs, pendingDrafts, readOutbox, reconcileDrafts, sendDraft, updateDraft, type SlackPoster } from '../src/outbox.ts';
import { cachedHead, cleanReactions, cleanReview, clearHeadCache, githubPoster, headMoved, reviewPayload, type DraftReview, type GithubPoster } from '../src/outboxreview.ts';
import { OUTBOX_PURE_JS, OUTBOX_VIEW_JS } from '../src/outboxview.ts';

// Nothing here reaches GitHub or Slack: gh and the Slack poster are stubs that record calls.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-review-'));
const store = () => path.join(fs.mkdtempSync(path.join(dir, 's-')), 'outbox.json');
const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const review = (over: Partial<DraftReview> = {}): DraftReview => ({
  repo: 'acme/app',
  pr: 12,
  commit_id: SHA,
  event: 'REQUEST_CHANGES',
  body: 'Two blockers.',
  comments: [
    { path: 'src/a.ts', line: 10, body: 'This drops the filter.' },
    { path: 'src/b.ts', line: 20, start_line: 18, side: 'RIGHT', body: 'Null slips through `x`.' },
  ],
  ...over,
});
const THREAD = '1793990180.251589';
const rx = [{ channel: 'C0TESTOUT01', ts: THREAD, add: ['large_orange_circle'], remove: ['eyes'] }];

type Log = string[];
function ghStub(log: Log, o: { head?: string; fail?: string; posted?: { id: number; url: string } | null } = {}): GithubPoster & { posts: DraftReview[] } {
  const posts: DraftReview[] = [];
  return {
    posts,
    head: async () => { log.push('gh:head'); return { sha: o.head ?? SHA, title: 'Fix the thing', url: 'https://github.com/acme/app/pull/12' }; },
    post: async (r) => {
      log.push('gh:post');
      if (o.fail) throw new Error(o.fail);
      posts.push(r);
      return { id: 777, url: 'https://github.com/acme/app/pull/12#pullrequestreview-777' };
    },
    findPosted: async () => { log.push('gh:find'); return o.posted ?? null; },
  };
}
function slackStub(log: Log, failPostAt: number | null = null): SlackPoster {
  let n = 0;
  return {
    resolveChannel: async (t) => t,
    post: async (p) => {
      const i = n++;
      if (i === failPostAt) { log.push('slack:fail'); throw new Error('ratelimited'); }
      log.push('slack:post:' + p.text);
      return { channel: p.channel, ts: `1793990000.00000${i + 1}` };
    },
    upload: async () => { throw new Error('no uploads here'); },
    permalink: async (c, ts) => `https://acme.slack.com/archives/${c}/p${ts.replace('.', '')}?thread_ts=${THREAD}`,
    react: async (p) => { log.push(`react:${p.remove ? '-' : '+'}${p.name}`); },
    sleep: async (ms) => { log.push('sleep:' + ms); },
  };
}
const addBundle = (f: string, over: Record<string, unknown> = {}) =>
  addDraft({ id: 'r1', session_id: 's', channel: 'C0TESTOUT01', thread_ts: THREAD, messages: ['Left two blockers on the PR.', 'Ping me when fixed.'], review: review(), reactions: rx, ...over } as any, { file: f });

describe('review drafts in the store', () => {
  it('round-trips a review bundle, and loads an old Slack-only draft unchanged', () => {
    const f = store();
    expect(addBundle(f).ok).toBe(true);
    const d = readOutbox(f).r1;
    expect(d.review).toMatchObject({ repo: 'acme/app', pr: 12, event: 'REQUEST_CHANGES', comments: [{ path: 'src/a.ts', line: 10 }, { start_line: 18 }] });
    expect(d.reactions).toEqual(rx);
    // An old draft written before reviews existed: no review fields, still pending and listed.
    const old = { id: 'o1', session_id: 's', channel: 'C1', messages: ['hi'], status: 'pending', created_at: '2026-11-01T09:00:00' };
    const g = store();
    fs.writeFileSync(g, JSON.stringify({ drafts: { o1: old } }));
    expect(readOutbox(g).o1).toEqual(old);
    expect(pendingDrafts(g, path.join(dir, 'none.json')).map((x) => x.id)).toEqual(['o1']);
  });

  it('allows a review-only draft (no channel, no messages) and lists it', () => {
    const f = store();
    expect(addDraft({ id: 'r2', session_id: 's', channel: '', messages: [], review: review({ event: 'APPROVE', body: '', comments: [] }) } as any, { file: f }).ok).toBe(true);
    expect(pendingDrafts(f, path.join(dir, 'none.json')).map((x) => x.id)).toEqual(['r2']);
    // Without a review, a draft still needs a channel and text.
    expect(addDraft({ id: 'r3', session_id: 's', channel: '', messages: [] } as any, { file: f }).ok).toBe(false);
  });

  it('one pending review per PR per chat: a newer one supersedes, a different PR does not', () => {
    const f = store();
    addDraft({ id: 'a', session_id: 's', channel: '', messages: [], review: review(), at: 1000 } as any, { file: f });
    addDraft({ id: 'b', session_id: 's', channel: '', messages: [], review: review({ pr: 13 }), at: 2000 } as any, { file: f });
    addDraft({ id: 'c', session_id: 's', channel: '', messages: [], review: review(), at: 3000 } as any, { file: f });
    const o = readOutbox(f);
    expect([o.a.status, o.b.status, o.c.status]).toEqual(['superseded', 'pending', 'pending']);
  });

  it('update replaces the review alone and keeps the Slack text; refuses once the review is posted', () => {
    const f = store();
    addBundle(f);
    expect(updateDraft('r1', null, f, Date.now(), undefined, { review: review({ event: 'APPROVE', body: 'LGTM' }) }).ok).toBe(true);
    expect(readOutbox(f).r1.review!.event).toBe('APPROVE');
    expect(readOutbox(f).r1.messages).toHaveLength(2);
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    raw.drafts.r1.review_posted = { id: 1, url: 'u', at: 'x' };
    fs.writeFileSync(f, JSON.stringify(raw));
    expect(updateDraft('r1', null, f, Date.now(), undefined, { review: review() }).detail).toBe('the review is already posted');
  });
});

describe('validation', () => {
  it('requires repo, pr, commit, a known event, and path/line/body on every comment', () => {
    expect(cleanReview(review()).ok).toBe(true);
    for (const bad of [
      { repo: 'nope' }, { pr: 0 }, { commit_id: 'zz' }, { event: 'MERGE' }, { body: '', event: 'COMMENT' as const },
      { comments: [{ path: '', line: 1, body: 'x' }] }, { comments: [{ path: 'a', line: 0, body: 'x' }] }, { comments: [{ path: 'a', line: 1, body: ' ' }] },
      { comments: [{ path: 'a', line: 5, start_line: 9, body: 'x' }] },
    ]) {
      expect(cleanReview(review(bad as any)).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(cleanReview(review({ event: 'APPROVE', body: '' })).ok).toBe(true); // a bare approve is fine
    expect(cleanReactions([{ channel: 'C0TESTOUT01', ts: THREAD, add: [':eyes:'] }])).toEqual({ ok: true, reactions: [{ channel: 'C0TESTOUT01', ts: THREAD, add: ['eyes'] }] });
    expect(cleanReactions([{ channel: 'C0TESTOUT01', ts: THREAD }]).ok).toBe(false);
    expect(cleanReactions([{ channel: 'x', ts: THREAD, add: ['eyes'] }]).ok).toBe(false);
    expect(addBundle(store(), { review: { ...review(), event: 'nope' } })).toMatchObject({ ok: false });
  });

  it('posts every inline comment in one payload, against the stored commit', () => {
    expect(reviewPayload(review())).toEqual({
      commit_id: SHA,
      event: 'REQUEST_CHANGES',
      body: 'Two blockers.',
      comments: [
        { path: 'src/a.ts', line: 10, side: 'RIGHT', body: 'This drops the filter.' },
        { path: 'src/b.ts', line: 20, side: 'RIGHT', start_line: 18, start_side: 'RIGHT', body: 'Null slips through `x`.' },
      ],
    });
  });

  it('the gh poster makes one POST with the payload on stdin', async () => {
    const calls: { args: string[]; input?: string }[] = [];
    const gh = githubPoster(async (args, input) => {
      calls.push({ args, input });
      return JSON.stringify({ id: 9, html_url: 'https://github.com/acme/app/pull/12#pullrequestreview-9' });
    });
    expect(await gh.post(review())).toEqual({ id: 9, url: 'https://github.com/acme/app/pull/12#pullrequestreview-9' });
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(['api', '-X', 'POST', 'repos/acme/app/pulls/12/reviews', '--input', '-']);
    expect(JSON.parse(calls[0].input!).comments).toHaveLength(2);
  });
});

describe('send all', () => {
  it('posts the review, then the Slack burst, then the reactions; no gap around the review', async () => {
    const f = store();
    addBundle(f);
    const log: Log = [];
    const gh = ghStub(log);
    const r = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log) });
    expect(r).toMatchObject({ ok: true, detail: 'posted', review_url: 'https://github.com/acme/app/pull/12#pullrequestreview-777' });
    expect(log).toEqual([
      'gh:head',
      'gh:post',
      'slack:post:Left two blockers on the PR.',
      'sleep:' + burstGapMs('Ping me when fixed.'),
      'slack:post:Ping me when fixed.',
      'react:+large_orange_circle',
      'react:-eyes',
    ]);
    expect(gh.posts).toHaveLength(1);
    const d = readOutbox(f).r1;
    expect(d.status).toBe('sent');
    expect(d.review_posted).toMatchObject({ id: 777 });
  });

  it('a failed review stops the send: nothing goes to Slack and the draft stays pending', async () => {
    const f = store();
    addBundle(f);
    const log: Log = [];
    const r = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: ghStub(log, { fail: 'Validation Failed: line must be part of the diff' }), slack: slackStub(log) });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('GitHub review failed: Validation Failed');
    expect(r.detail).toContain('Nothing was posted to Slack');
    expect(log.filter((x) => x.startsWith('slack') || x.startsWith('react'))).toEqual([]);
    const d = readOutbox(f).r1;
    expect(d.status).toBe('pending');
    expect(d.review_posted).toBeUndefined();
    expect(d.send_started_at).toBeUndefined();
  });

  it('a retry after a Slack failure posts only the Slack part, never the review again', async () => {
    const f = store();
    addBundle(f);
    const log: Log = [];
    const gh = ghStub(log);
    const first = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log, 0) });
    expect(first.ok).toBe(false);
    expect(first.detail).toContain('review posted; send failed');
    expect(readOutbox(f).r1.review_posted).toMatchObject({ id: 777 });
    log.length = 0;
    const again = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log) });
    expect(again.ok).toBe(true);
    expect(gh.posts).toHaveLength(1);
    expect(log.some((x) => x.startsWith('gh:'))).toBe(false); // not even a head check: the review is out
    expect(log.filter((x) => x.startsWith('slack:post'))).toHaveLength(2);
  });

  it('a partial burst after the review keeps the rest, and the retry skips the review', async () => {
    const f = store();
    addBundle(f);
    const log: Log = [];
    const gh = ghStub(log);
    const first = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log, 1) });
    expect(first).toMatchObject({ ok: false, partial: 1 });
    expect(readOutbox(f).r1.messages).toEqual(['Ping me when fixed.']);
    const again = await sendDraft('r1', ['Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log) });
    expect(again.ok).toBe(true);
    expect(gh.posts).toHaveLength(1);
  });

  it('PR head moved: refuses with stale_head until sent again with ackStale, then posts against the stored commit', async () => {
    const f = store();
    addBundle(f);
    const log: Log = [];
    const gh = ghStub(log, { head: 'fff0000aaa1111bbb2222ccc3333ddd4444eee55' });
    const first = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log) });
    expect(first).toMatchObject({ ok: false, stale_head: 'fff0000aaa1111bbb2222ccc3333ddd4444eee55', detail: 'PR has new commits since this review was drafted' });
    expect(gh.posts).toHaveLength(0);
    expect(readOutbox(f).r1.send_started_at).toBeUndefined();
    const second = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log), ackStale: true });
    expect(second.ok).toBe(true);
    expect(gh.posts[0].commit_id).toBe(SHA);
  });

  it('a review-only draft never touches Slack', async () => {
    const f = store();
    addDraft({ id: 'r2', session_id: 's', channel: '', messages: [], review: review({ event: 'APPROVE', body: '', comments: [] }) } as any, { file: f });
    const log: Log = [];
    const slack = slackStub(log);
    const r = await sendDraft('r2', [], { file: f, github: ghStub(log), slack });
    expect(r).toMatchObject({ ok: true, detail: 'posted' });
    expect(log).toEqual(['gh:head', 'gh:post']);
    expect(readOutbox(f).r2.permalink).toContain('pullrequestreview-777');
  });

  it('an interrupted send whose review landed is found on GitHub and not posted again', async () => {
    const f = store();
    addBundle(f);
    const raw = JSON.parse(fs.readFileSync(f, 'utf-8'));
    raw.drafts.r1.send_started_at = Date.now() - 11 * 60_000; // older than the send lock
    fs.writeFileSync(f, JSON.stringify(raw));
    const log: Log = [];
    const gh = ghStub(log, { posted: { id: 555, url: 'https://github.com/acme/app/pull/12#pullrequestreview-555' } });
    const r = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: gh, slack: slackStub(log), checkPosted: async () => false });
    expect(r.ok).toBe(true);
    expect(gh.posts).toHaveLength(0);
    expect(readOutbox(f).r1.review_posted).toMatchObject({ id: 555 });
  });

  it('a reaction that fails is reported but does not undo or repeat the send', async () => {
    const f = store();
    addBundle(f);
    const log: Log = [];
    const slack = { ...slackStub(log), react: async () => { throw new Error('missing_scope'); } };
    const r = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, github: ghStub(log), slack });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain('reactions failed');
    expect(readOutbox(f).r1.status).toBe('sent');
  });

  it('dry run renders the review, messages and reactions and posts nothing', async () => {
    const f = store();
    addBundle(f);
    const log: Log = [];
    const r = await sendDraft('r1', ['Left two blockers on the PR.', 'Ping me when fixed.'], { file: f, dry: true, github: ghStub(log), slack: slackStub(log) });
    expect(r.rendered).toContain('[GitHub] Request changes on acme/app#12 with 2 inline comments');
    expect(r.rendered).toContain('+large_orange_circle -eyes');
    expect(log).toEqual([]);
  });

  it('reconcile leaves a bundle whose review is not posted alone', async () => {
    const f = store();
    addBundle(f);
    const marked: string[] = [];
    const ids = await reconcileDrafts({
      me: 'U1', file: f, legacy: '',
      replies: async () => [{ ts: '1793990999.000001', user: 'U1', text: 'Left two blockers on the PR.' }],
      mark: async (id) => { marked.push(id); },
    });
    expect(ids).toEqual([]);
  });
});

describe('typing gap and head check', () => {
  it('is ~3 s plus 1 s per 30 characters, capped at 15 s', () => {
    expect(burstGapMs('')).toBe(3_000);
    expect(burstGapMs('x'.repeat(30))).toBe(4_000);
    expect(burstGapMs('x'.repeat(300))).toBe(13_000);
    expect(burstGapMs('x'.repeat(2000))).toBe(15_000);
  });
  it('compares full and short shas', () => {
    expect(headMoved(SHA, SHA)).toBe(false);
    expect(headMoved(SHA.slice(0, 7), SHA)).toBe(false);
    expect(headMoved(SHA, 'fff0000')).toBe(true);
  });
  it('caches the PR head for a minute', async () => {
    clearHeadCache();
    const log: Log = [];
    const gh = ghStub(log);
    await cachedHead(gh, 'acme/app', 12, 1_000);
    await cachedHead(gh, 'acme/app', 12, 30_000);
    await cachedHead(gh, 'acme/app', 12, 70_000);
    expect(log).toEqual(['gh:head', 'gh:head']);
  });
});

describe('the card', () => {
  const lib = new Function(`${OUTBOX_PURE_JS}; return { reviewBadge, reviewShown, ghRender, reviewLoc };`)() as {
    reviewBadge: (e: string) => { cls: string; label: string };
    reviewShown: (n: number, all: boolean) => number;
    ghRender: (t: string) => string;
    reviewLoc: (c: object) => string;
  };
  const card = (d: object, state: { head?: object; all?: boolean; confirm?: boolean; ack?: boolean } = {}) => {
    const f = new Function(
      'DATA', 'esc', 'rel', 'hhmm', 'NL',
      `var TERM_TOKEN='t',SENDING={},SEND_LOCAL={},LEAVING={},DRAFT_EDITS={},DRAFT_EDIT_ON={},draftConfirm=${state.confirm ? "'r1'" : 'null'},draftArmDiscard=null,draftMsg={},SLK_DIR=null,SLK_EMOJI=null;
       var fetch=function(){return new Promise(function(){});};var renderOutbox=function(){};
       var slkCtx=function(){return {users:{},channels:{},emoji:{},custom:{}};};var slkRender=function(m){return '<p>'+esc(m)+'</p>';};var slkBubbles=function(ms){return ms.map(function(m){return '<p>'+esc(m)+'</p>';}).join('');};
       ${OUTBOX_PURE_JS}${OUTBOX_VIEW_JS.slice(OUTBOX_VIEW_JS.indexOf('function draftTexts'))}
       ${state.head ? `REVIEW_HEAD['r1']=${JSON.stringify({ at: Date.now(), ...state.head })};` : `REVIEW_HEAD['r1']={at:Date.now(),stale:false,head:''};`}
       ${state.all ? "REVIEW_ALL['r1']=1;" : ''}${state.ack ? "STALE_ACK['r1']=1;" : ''}
       return draftCardHtml(DATA.drafts[0],{});`,
    );
    const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]!);
    return f({ drafts: [d] }, esc, () => '', () => '10:00', '\n') as string;
  };
  const bundle = { id: 'r1', session_id: 's', created_at: '2026-11-10T10:00:00Z', channel: 'C0TESTOUT01', thread_ts: THREAD, label: '#eng', messages: ['Left two blockers.'], review: { ...review(), title: 'Fix the thing' }, reactions: rx };

  it('badges each event in its colour', () => {
    expect(lib.reviewBadge('APPROVE')).toEqual({ cls: 'approve', label: 'Approve' });
    expect(lib.reviewBadge('REQUEST_CHANGES')).toEqual({ cls: 'changes', label: 'Request changes' });
    expect(lib.reviewBadge('COMMENT')).toEqual({ cls: 'comment', label: 'Comment' });
    for (const [ev, cls] of [['APPROVE', 'approve'], ['REQUEST_CHANGES', 'changes'], ['COMMENT', 'comment']]) {
      expect(card({ ...bundle, review: { ...bundle.review, event: ev } })).toContain(`<span class="gh-badge ${cls}">`);
    }
  });

  it('shows the PR link, body, each comment as path:line, then the Slack preview and the reactions line', () => {
    const html = card(bundle);
    const gh = html.indexOf('class="gh-sec"');
    const slack = html.indexOf('class="dbody"');
    expect(gh).toBeGreaterThan(-1);
    expect(slack).toBeGreaterThan(gh); // GitHub above Slack
    expect(html).toContain('href="https://github.com/acme/app/pull/12"');
    expect(html).toContain('acme/app#12 · Fix the thing');
    expect(html).toContain('src/a.ts:10');
    expect(html).toContain('src/b.ts:18-20');
    expect(html).toContain('<code class="gh-code">x</code>');
    expect(html).toMatch(/React :large_orange_circle:, remove :eyes: on the request message/);
  });

  it('collapses a long comment list behind show all', () => {
    const many = { ...bundle, review: { ...bundle.review, comments: Array.from({ length: 7 }, (_, i) => ({ path: `f${i}.ts`, line: i + 1, body: 'c' + i })) } };
    expect(lib.reviewShown(7, false)).toBe(3);
    const short = card(many);
    expect(short.match(/class="gh-cmt"/g)).toHaveLength(3);
    expect(short).toContain('Show all 7 comments');
    expect(card(many, { all: true }).match(/class="gh-cmt"/g)).toHaveLength(7);
  });

  it('warns when the PR has new commits and gates the send behind Send anyway', () => {
    const stale = card(bundle, { head: { stale: true, head: 'fff0000aaa' }, confirm: true });
    expect(stale).toContain('PR has new commits since this review was drafted');
    expect(stale).toContain('data-dact="ack-stale"');
    expect(stale).toMatch(/data-dact="post-none" disabled/);
    const acked = card(bundle, { head: { stale: true, head: 'fff0000aaa' }, confirm: true, ack: true });
    expect(acked).not.toContain('data-dact="ack-stale"');
    expect(acked).not.toMatch(/data-dact="post-none" disabled/);
    expect(acked).toContain('Post the review (Request changes, 2 comments) on acme/app#12, then post as You to #eng');
  });

  it('a review-only card has no Slack body and cannot park', () => {
    const html = card({ ...bundle, channel: '', thread_ts: undefined, label: '', messages: [], reactions: undefined }, { confirm: true });
    expect(html).not.toContain('class="dbody"');
    expect(html).toMatch(/data-dact="post-park" disabled title="a review with no Slack message/);
  });

  it('renders fenced code readable and escapes everything else', () => {
    const out = lib.ghRender('Use:\n```ts\nconst a = <b>;\n```\n**bold** <script>');
    expect(out).toContain('<pre class="gh-pre">const a = &lt;b&gt;;</pre>');
    expect(out).toContain('<b>bold</b> &lt;script&gt;');
  });

  it('the page script still parses', () => {
    expect(() => new Function(OUTBOX_PURE_JS + OUTBOX_VIEW_JS)).not.toThrow();
  });
});
