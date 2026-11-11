import { beforeEach, describe, expect, it } from 'vitest';
import { BRAND_ICONS_JS } from '../src/brandicons.ts';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDraft, pendingDrafts, readOutbox, sendDraft, setSeen, updateDraft, type SlackPoster } from '../src/outbox.ts';
import { AmbiguousSendError, clearAddressCache, cleanEmail, cliAdapter, emailPayload, resolveEmailCli, SEND_ISSUED_MARK, snippetOf, type CliRun, type EmailAdapter, type EmailMessage } from '../src/outboxemail.ts';
import { checkFresh, cleanSeen, clearFreshCache, currentSeen, cachedFresh, ghActivityVia, type FreshDeps, type GhItem, type SlackMsgLite } from '../src/outboxfresh.ts';
import type { DraftReview, GithubPoster } from '../src/outboxreview.ts';
import { OUTBOX_PURE_JS, OUTBOX_VIEW_JS } from '../src/outboxview.ts';
import { applyEvent } from '../src/events.ts';
import { PARKED_SCHEMA_SQL, getParked, pollParked, sendAndPark, emailRepliesVia } from '../src/parked.ts';

// Nothing here sends mail, posts to Slack or reaches GitHub: the email CLI, Slack and gh are stubs that record calls.

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-email-'));
const store = () => path.join(fs.mkdtempSync(path.join(dir, 's-')), 'outbox.json');
const ME = 'alex@example.com';
const THREAD = '18c0ffee12345678';
const NOW = Date.parse('2026-11-10T10:00:00');
const reply = { to: ['sam@example.org'], subject: 'Re: Q3 filing', body: 'Hi Sam,\n\nAttached is the corrected return.\n\nOn Mon, Nov 9, 2026 at 9:00 AM Sam <sam@example.org> wrote:\n> Can you resend?', threadId: THREAD, inReplyTo: '<abc123@mail.example.org>', thread_subject: 'Q3 filing', account: 'work' };

function mailStub(o: { thread?: EmailMessage[]; fail?: 'plain' | 'ambiguous'; threadFails?: string } = {}): EmailAdapter & { sends: { payload: Record<string, unknown>; account?: string }[]; reads: number } {
  const sends: { payload: Record<string, unknown>; account?: string }[] = [];
  const m = {
    sends,
    reads: 0,
    async send(payload: Record<string, unknown>, account?: string) {
      if (o.fail === 'plain') throw new Error('invalid_grant');
      if (o.fail === 'ambiguous') throw new AmbiguousSendError('socket hang up');
      sends.push({ payload, account });
      return { messageId: 'm' + sends.length, threadId: (payload.threadId as string) || 'newthread1' };
    },
    async thread() {
      m.reads++;
      if (o.threadFails) throw new Error(o.threadFails);
      return o.thread ?? [];
    },
    async addresses() { return [ME]; },
  };
  return m;
}
const msg = (id: string, from: string, at: number, extra: Partial<EmailMessage> = {}): EmailMessage => ({ id, from, date: new Date(at).toUTCString(), at, snippet: 'text of ' + id, labels: ['INBOX'], ...extra });

beforeEach(() => {
  clearAddressCache();
  clearFreshCache();
});

describe('email drafts: validation and the store', () => {
  it('needs a recipient, a subject and a body; a reply needs threadId and inReplyTo', () => {
    expect(cleanEmail({ subject: 's', body: 'b' })).toMatchObject({ ok: false, detail: 'email needs at least one recipient' });
    expect(cleanEmail({ to: ['x@example.com'], body: 'b' })).toMatchObject({ ok: false, detail: 'email.subject is required' });
    expect(cleanEmail({ to: ['x@example.com'], subject: 's', body: '  ' })).toMatchObject({ ok: false, detail: 'email.body is required' });
    expect(cleanEmail({ to: ['nobody'], subject: 's', body: 'b' })).toMatchObject({ ok: false, detail: 'not an email address: nobody' });
    expect(cleanEmail({ to: ['x@example.com'], subject: 's', body: 'b', threadId: THREAD })).toMatchObject({ ok: false });
    expect(cleanEmail({ to: ['x@example.com'], subject: 's', body: 'b', attachments: ['relative.pdf'] })).toMatchObject({ ok: false });
    const ok = cleanEmail({ to: 'Sam <sam@example.org>, kim@example.org', cc: ['lee@example.org'], subject: 'Hi', body: 'Hello\r\nthere\n\n', signature: true });
    expect(ok).toEqual({ ok: true, email: { to: ['Sam <sam@example.org>', 'kim@example.org'], cc: ['lee@example.org'], subject: 'Hi', body: 'Hello\nthere', signature: true } });
    expect(cleanEmail(reply)).toMatchObject({ ok: true, email: { threadId: THREAD, inReplyTo: '<abc123@mail.example.org>', account: 'work' } });
  });

  it('round-trips through the store, shows as pending, and old drafts load unchanged', () => {
    const f = store();
    const old = { id: 'old1', session_id: 's', channel: 'C0TESTOUT01', messages: ['hello'], status: 'pending', created_at: '2026-11-01T09:00:00' };
    fs.writeFileSync(f, JSON.stringify({ drafts: { old1: old } }));
    expect(addDraft({ id: 'e1', session_id: 's', channel: '', messages: [], email: reply, at: NOW }, f)).toEqual({ ok: true, detail: 'recorded' });
    const all = readOutbox(f);
    expect(all.old1).toEqual(old);
    expect(all.e1).toMatchObject({ kind: 'email', channel: '', messages: [], email: { subject: 'Re: Q3 filing', to: ['sam@example.org'] }, status: 'pending' });
    expect(pendingDrafts(f, path.join(dir, 'nolabels.json')).map((d) => d.id)).toEqual(['old1', 'e1']);
    expect(addDraft({ id: 'e2', session_id: 's', channel: '', messages: ['x'], email: reply }, f)).toMatchObject({ ok: false });
    // A revision replaces the email; a newer draft for the same thread supersedes the older one.
    expect(updateDraft('e1', null, f, NOW + 1, undefined, { email: { ...reply, body: 'Shorter.' } })).toEqual({ ok: true, detail: 'updated' });
    expect(readOutbox(f).e1.email!.body).toBe('Shorter.');
    expect(updateDraft('old1', null, f, NOW + 1, undefined, { email: reply })).toMatchObject({ ok: false });
    addDraft({ id: 'e3', session_id: 's', channel: '', messages: [], email: reply, at: NOW + 5000 }, f);
    expect(readOutbox(f).e1.status).toBe('superseded');
  });

  it('arrives through the CLI event (`loom outbox add --email-file … --seen …`) and revises through outbox.update', () => {
    const f = store();
    const db = new Database(':memory:');
    const ev = { v: 1, kind: 'outbox.add', at: NOW, session: 'sess1', messages: [], channel: '', email: { ...reply }, seen: { email: '18c0ffee00000001' }, id: 'dabc01' };
    expect(applyEvent(db, ev as any, { outbox: { file: f } })).toEqual({ ok: true, detail: 'recorded' });
    expect(readOutbox(f).dabc01).toMatchObject({ kind: 'email', seen: { email: { id: '18c0ffee00000001', at: 0 } } });
    expect(applyEvent(db, { v: 1, kind: 'outbox.update', at: NOW + 1, session: 'sess1', id: 'dabc01', email: { ...reply, body: 'v2' } } as any, { outbox: { file: f } })).toEqual({ ok: true, detail: 'updated' });
    expect(readOutbox(f).dabc01.email!.body).toBe('v2');
  });

  it('builds the CLI payload the way gmail.mjs reads it', () => {
    const e = cleanEmail({ ...reply, cc: ['lee@example.org'], attachments: ['/tmp/a.pdf'] });
    if (!e.ok) throw new Error(e.detail);
    expect(emailPayload(e.email)).toEqual({ to: 'sam@example.org', cc: 'lee@example.org', subject: 'Re: Q3 filing', body: reply.body, threadId: THREAD, inReplyTo: '<abc123@mail.example.org>', references: '<abc123@mail.example.org>', attachments: ['/tmp/a.pdf'] });
  });

  it('resolves the email CLI from the setting, else the default when it exists, else off', () => {
    expect(resolveEmailCli('/opt/mail/cli.mjs', () => false, '/home/x/gmail.mjs')).toBe('/opt/mail/cli.mjs');
    expect(resolveEmailCli('', () => true, '/home/x/gmail.mjs')).toBe('/home/x/gmail.mjs');
    expect(resolveEmailCli('', () => false, '/home/x/gmail.mjs')).toBe('');
  });
});

describe('sending an email', () => {
  const add = (f: string, over: Record<string, unknown> = {}) => addDraft({ id: 'e1', session_id: 's', channel: '', messages: [], email: { ...reply, ...over }, at: NOW }, f);

  it('sends through the adapter with the account, records the message id, and never sends twice', async () => {
    const f = store();
    add(f);
    const mail = mailStub();
    const r = await sendDraft('e1', ['Hi Sam,\n\nEdited on the card.'], { file: f, email: mail });
    expect(r).toMatchObject({ ok: true, detail: 'sent', email_id: 'm1', email_thread: THREAD, permalink: `https://mail.google.com/mail/#all/${THREAD}` });
    expect(mail.sends).toHaveLength(1);
    expect(mail.sends[0].account).toBe('work');
    expect(mail.sends[0].payload).toMatchObject({ to: 'sam@example.org', body: 'Hi Sam,\n\nEdited on the card.', threadId: THREAD });
    const d = readOutbox(f).e1;
    expect(d).toMatchObject({ status: 'sent', sent_by: 'loom', email_sent: { messageId: 'm1', threadId: THREAD } });
    expect(d.email!.body).toBe('Hi Sam,\n\nEdited on the card.');
    expect(await sendDraft('e1', ['again'], { file: f, email: mail })).toMatchObject({ ok: false, detail: 'already sent' });
    expect(mail.sends).toHaveLength(1);
  });

  it('a second press while the first is in flight is refused', async () => {
    const f = store();
    add(f);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const mail = mailStub();
    const slow = { ...mail, send: async (p: Record<string, unknown>, a?: string) => { await gate; return mail.send(p, a); } };
    const first = sendDraft('e1', [reply.body], { file: f, email: slow });
    await new Promise((r) => setTimeout(r, 5));
    expect(await sendDraft('e1', [reply.body], { file: f, email: slow })).toMatchObject({ ok: false, detail: 'already sending' });
    expect(readOutbox(f).e1.send_started_at).toBeTypeOf('number');
    release();
    expect((await first).ok).toBe(true);
    expect(mail.sends).toHaveLength(1);
  });

  it('a plain failure releases the draft; a failure after the request reached Gmail keeps the claim', async () => {
    const f = store();
    add(f);
    expect(await sendDraft('e1', [reply.body], { file: f, email: mailStub({ fail: 'plain' }) })).toMatchObject({ ok: false, detail: 'email send failed: invalid_grant. Nothing was sent.' });
    expect(readOutbox(f).e1.send_started_at).toBeUndefined();
    const amb = await sendDraft('e1', [reply.body], { file: f, email: mailStub({ fail: 'ambiguous' }) });
    expect(amb.ok).toBe(false);
    expect(amb.detail).toContain('may have been sent');
    expect(readOutbox(f).e1.send_started_at).toBeTypeOf('number');
    const ok = mailStub();
    expect(await sendDraft('e1', [reply.body], { file: f, email: ok })).toMatchObject({ ok: false });
    expect(ok.sends).toHaveLength(0);
    // Past the lock, the thread is read first: the send that went out is found there and marked, not repeated.
    const later = () => Date.now() + 20 * 60_000;
    const found = mailStub({ thread: [msg('m9', `Alex <${ME}>`, Date.now(), { labels: ['SENT'] })] });
    expect(await sendDraft('e1', [reply.body], { file: f, email: found, now: later })).toMatchObject({ ok: false, detail: 'already sent (found in the thread)' });
    expect(found.sends).toHaveLength(0);
    expect(readOutbox(f).e1.status).toBe('sent');
  });

  it('with email off it says how to turn it on, and a dry run sends nothing', async () => {
    const f = store();
    add(f);
    expect(await sendDraft('e1', [reply.body], { file: f, email: null, emailOff: 'Email is off: set it up.' })).toEqual({ ok: false, detail: 'Email is off: set it up.' });
    const dry = await sendDraft('e1', [reply.body], { file: f, dry: true });
    expect(dry).toMatchObject({ ok: true, dry: true });
    expect(dry.rendered).toContain('[Email] Reply "Re: Q3 filing" to sam@example.org from the work account');
    expect(readOutbox(f).e1.status).toBe('pending');
  });
});

describe('the email CLI adapter', () => {
  const run = (o: { code?: number; out?: string; err?: string }, log: string[][]): CliRun => async (args) => {
    log.push(args);
    return { code: o.code ?? 0, out: o.out ?? '', err: o.err ?? '' };
  };
  it('passes --account after the subcommand, reads ids back, and tells an ambiguous failure apart', async () => {
    const log: string[][] = [];
    const a = cliAdapter(run({ out: JSON.stringify({ ok: true, messageId: 'mm', threadId: 'tt' }) }, log));
    expect(await a.send({ to: 'x@example.com' }, 'work')).toEqual({ messageId: 'mm', threadId: 'tt' });
    expect(log[0]).toEqual(['send', '--account', 'work']);
    await expect(cliAdapter(run({ code: 1, err: 'ERROR: Missing credentials' }, log)).send({}, undefined)).rejects.toThrow('Missing credentials');
    await expect(cliAdapter(run({ code: 1, err: `${SEND_ISSUED_MARK}\nERROR: socket hang up` }, log)).send({})).rejects.toBeInstanceOf(AmbiguousSendError);
  });
  it('maps a thread to id, from, date and a snippet without the quoted history', async () => {
    const log: string[][] = [];
    const out = JSON.stringify([{ id: 'a1', from: 'Sam <sam@example.org>', date: 'Mon, 9 Nov 2026', internalDate: '1793990000000', labelIds: ['INBOX'], body: 'Sure thing.\n\nOn Mon, Nov 9 Alex wrote:\n> old' }]);
    const t = await cliAdapter(run({ out }, log)).thread(THREAD);
    expect(log[0]).toEqual(['thread', '--id', THREAD]);
    expect(t).toEqual([{ id: 'a1', from: 'Sam <sam@example.org>', date: 'Mon, 9 Nov 2026', at: 1793990000000, snippet: 'Sure thing.', labels: ['INBOX'] }]);
    expect(snippetOf('> quoted\nreal line')).toBe('real line');
  });
});

/* ------------------------------------------------------------------ freshness */

const SLACK_THREAD = '1793990180.251589';
function slackDeps(msgs: SlackMsgLite[], me = 'U0ME00001'): FreshDeps {
  return { slackMe: async () => me, slackReplies: async () => msgs, slackHistory: async () => msgs, slackNames: () => ({ U0SAM0001: 'Sam' }) };
}
function slackStub(log: string[]): SlackPoster {
  return {
    resolveChannel: async (t) => t,
    post: async (p) => { log.push('post:' + p.text); return { channel: p.channel, ts: '1793999999.000001' }; },
    upload: async () => { throw new Error('no uploads'); },
    permalink: async (c, ts) => `https://acme.slack.com/archives/${c}/p${ts.replace('.', '')}`,
    sleep: async () => {},
  };
}
const SHA = 'abc1234def5678abc1234def5678abc1234def56';
const review: DraftReview = { repo: 'acme/app', pr: 12, commit_id: SHA, event: 'COMMENT', body: 'One question.', comments: [] };
const ghStub = (head = SHA): GithubPoster & { posts: number } => {
  const g = { posts: 0, head: async () => ({ sha: head, title: 't', url: 'u' }), post: async () => { g.posts++; return { id: 1, url: 'https://github.com/acme/app/pull/12#r1' }; }, findPosted: async () => null };
  return g;
};
// created_at is local time; Slack ts is seconds. Messages "after" the draft are later than NOW.
const afterTs = ((NOW + 60_000) / 1000).toFixed(6);
const beforeTs = ((NOW - 60_000) / 1000).toFixed(6);

describe('the freshness check on Send', () => {
  const addSlack = (f: string, over: Record<string, unknown> = {}) =>
    addDraft({ id: 'x', session_id: 's', channel: 'C0TESTOUT01', thread_ts: SLACK_THREAD, thread_url: `https://acme.slack.com/archives/C0TESTOUT01/p${SLACK_THREAD.replace('.', '')}`, messages: ['On it.'], at: NOW, ...over }, f);

  it('a Slack reply from someone else since the draft stops the send with the new items (409 stale_thread)', async () => {
    const f = store();
    addSlack(f);
    const log: string[] = [];
    const r = await sendDraft('x', ['On it.'], { file: f, slack: slackStub(log), fresh: slackDeps([{ ts: beforeTs, user: 'U0SAM0001', text: 'old' }, { ts: afterTs, user: 'U0SAM0001', text: 'Actually, hold off.' }]) });
    expect(r).toMatchObject({ ok: false, detail: '1 new message since this was drafted. Nothing was sent.' });
    expect(r.stale_thread).toEqual([{ id: 'slack:' + afterTs, kind: 'slack', author: 'Sam', at: Math.round(Number(afterTs) * 1000), snippet: 'Actually, hold off.', url: `https://acme.slack.com/archives/C0TESTOUT01/p${afterTs.replace('.', '')}?thread_ts=${SLACK_THREAD}&cid=C0TESTOUT01` }]);
    expect(log).toEqual([]);
    expect(readOutbox(f).x.send_started_at).toBeUndefined();
    // Send anyway: the items it was shown are acknowledged and it posts.
    const ok = await sendDraft('x', ['On it.'], { file: f, slack: slackStub(log), fresh: slackDeps([{ ts: afterTs, user: 'U0SAM0001', text: 'Actually, hold off.' }]), ackFresh: ['slack:' + afterTs] });
    expect(ok.ok).toBe(true);
    expect(log).toEqual(['post:On it.']);
  });

  it('the person’s own reply and messages before `seen` do not count; an item not yet shown still stops a Send anyway', async () => {
    const f = store();
    addSlack(f, { seen: { slack: afterTs } });
    const later = ((NOW + 120_000) / 1000).toFixed(6);
    const own = slackDeps([{ ts: afterTs, user: 'U0SAM0001', text: 'seen already' }, { ts: later, user: 'U0ME00001', text: 'me again' }]);
    const log: string[] = [];
    expect((await sendDraft('x', ['On it.'], { file: f, slack: slackStub(log), fresh: own })).ok).toBe(true);
    const f2 = store();
    addSlack(f2);
    const r = await sendDraft('x', ['On it.'], { file: f2, slack: slackStub(log), fresh: slackDeps([{ ts: afterTs, user: 'U0SAM0001', text: 'a' }, { ts: later, user: 'U0SAM0001', text: 'b' }]), ackFresh: ['slack:' + afterTs] });
    expect(r.stale_thread?.map((i) => i.snippet)).toEqual(['b']);
  });

  it('a top-level post checks the channel after the draft', async () => {
    const f = store();
    addDraft({ id: 'x', session_id: 's', channel: 'C0TESTOUT01', messages: ['Heads down today.'], at: NOW }, f);
    let oldest = '';
    const deps: FreshDeps = { ...slackDeps([]), slackHistory: async (_c, o) => { oldest = o; return [{ ts: afterTs, user: 'U0SAM0001', text: 'new topic' }]; } };
    const r = await sendDraft('x', ['Heads down today.'], { file: f, slack: slackStub([]), fresh: deps });
    expect(r.stale_thread).toHaveLength(1);
    expect(oldest).toBe((NOW / 1000).toFixed(6));
  });

  it('an email thread with a new message from someone else stops the send; the account’s own and drafts do not count', async () => {
    const f = store();
    addDraft({ id: 'e1', session_id: 's', channel: '', messages: [], email: reply, at: NOW, seen: { email: 'a1' } }, f);
    const thread = [msg('a1', 'Sam <sam@example.org>', NOW - 1000), msg('a2', `Alex <${ME}>`, NOW + 1000), msg('a3', 'x@example.org', NOW + 2000, { labels: ['DRAFT'] }), msg('a4', 'Sam <sam@example.org>', NOW + 3000)];
    const mail = mailStub({ thread });
    const r = await sendDraft('e1', [reply.body], { file: f, email: mail, fresh: { email: mail } });
    expect(r).toMatchObject({ ok: false, stale_thread: [{ id: 'email:a4', kind: 'email', author: 'Sam <sam@example.org>', snippet: 'text of a4' }] });
    expect(mail.sends).toHaveLength(0);
    expect((await sendDraft('e1', [reply.body], { file: f, email: mail, fresh: { email: mail }, ackFresh: ['email:a4'] })).ok).toBe(true);
    expect(mail.sends).toHaveLength(1);
  });

  it('a new GitHub comment by someone else stops a review draft; the person’s own does not', async () => {
    const items: GhItem[] = [
      { id: '5', kind: 'comment', author: 'alex', at: new Date(NOW + 60_000).toISOString(), body: 'mine', url: 'https://github.com/acme/app/pull/12#c5' },
      { id: '6', kind: 'review_comment', author: 'kim', at: new Date(NOW + 90_000).toISOString(), body: 'Wait, see line 3', url: 'https://github.com/acme/app/pull/12#c6' },
    ];
    const f = store();
    addDraft({ id: 'r1', session_id: 's', channel: '', messages: [], review, at: NOW }, f);
    const gh = ghStub();
    const deps: FreshDeps = { ghMe: async () => 'Alex', ghActivity: async () => items };
    const r = await sendDraft('r1', [], { file: f, github: gh, fresh: deps });
    expect(r.stale_thread).toEqual([{ id: 'gh:review_comment:6', kind: 'github', author: 'kim', at: NOW + 90_000, snippet: 'Wait, see line 3', url: 'https://github.com/acme/app/pull/12#c6' }]);
    expect(gh.posts).toBe(0);
    expect((await sendDraft('r1', [], { file: f, github: gh, fresh: { ...deps, ghActivity: async () => items.slice(0, 1) } })).ok).toBe(true);
  });

  it('a stale head and a stale thread come back in ONE refusal, and one Send anyway (both acks) sends', async () => {
    const f = store();
    addSlack(f, { review });
    const gh = ghStub('fff0000aaa1111bbb2222ccc3333ddd4444eee55');
    const deps = slackDeps([{ ts: afterTs, user: 'U0SAM0001', text: 'news' }]);
    const r = await sendDraft('x', ['On it.'], { file: f, github: gh, slack: slackStub([]), fresh: deps });
    expect(r).toMatchObject({ ok: false, stale_head: 'fff0000aaa1111bbb2222ccc3333ddd4444eee55', detail: 'PR has new commits since this review was drafted; 1 new message since this was drafted. Nothing was sent.' });
    expect(r.stale_thread).toHaveLength(1);
    const ok = await sendDraft('x', ['On it.'], { file: f, github: gh, slack: slackStub([]), fresh: deps, ackStale: true, ackFresh: true });
    expect(ok.ok).toBe(true);
    expect(gh.posts).toBe(1);
  });

  it('a check that cannot read the thread never sends silently: fresh_error until Send anyway', async () => {
    const f = store();
    addSlack(f);
    const log: string[] = [];
    const broken: FreshDeps = { ...slackDeps([]), slackReplies: async () => { throw new Error('invalid_auth'); } };
    const r = await sendDraft('x', ['On it.'], { file: f, slack: slackStub(log), fresh: broken });
    expect(r).toMatchObject({ ok: false, fresh_error: 'Slack: invalid_auth' });
    expect(r.detail).toContain('could not check the thread for new messages');
    expect(log).toEqual([]);
    // An acknowledgement of items does not cover a failed check; true (the could-not-check Send anyway) does.
    expect((await sendDraft('x', ['On it.'], { file: f, slack: slackStub(log), fresh: broken, ackFresh: [] })).fresh_error).toBeTruthy();
    expect((await sendDraft('x', ['On it.'], { file: f, slack: slackStub(log), fresh: broken, ackFresh: true })).ok).toBe(true);
    const e = store();
    addDraft({ id: 'e1', session_id: 's', channel: '', messages: [], email: reply, at: NOW }, e);
    const mail = mailStub({ threadFails: 'token expired' });
    expect(await sendDraft('e1', [reply.body], { file: e, email: mail, fresh: { email: mail } })).toMatchObject({ ok: false, fresh_error: 'email: token expired' });
    expect(mail.sends).toHaveLength(0);
  });
});

describe('seen: the baseline', () => {
  it('records the latest message in each target, once, and keeps a chat-passed seen', async () => {
    const f = store();
    addDraft({ id: 'x', session_id: 's', channel: 'C0TESTOUT01', thread_ts: SLACK_THREAD, messages: ['hi'], review, at: NOW }, f);
    const d = readOutbox(f).x;
    const seen = await currentSeen(d, {
      ...slackDeps([{ ts: SLACK_THREAD }, { ts: afterTs, user: 'U0SAM0001' }]),
      ghActivity: async () => [{ id: '9', kind: 'review', author: 'kim', at: '2026-11-10T09:00:00Z', body: '', url: '' }],
    }, 42);
    expect(seen).toEqual({ at: 42, slack: afterTs, github: { at: '2026-11-10T09:00:00Z', id: '9' } });
    expect(setSeen('x', seen, f)).toBe(true);
    expect(setSeen('x', { at: 1, slack: '1793999999.000000' }, f)).toBe(false);
    expect(readOutbox(f).x.seen).toEqual(seen);
    const g = store();
    addDraft({ id: 'y', session_id: 's', channel: 'C0TESTOUT01', messages: ['hi'], at: NOW, seen: { slack: beforeTs, bogus: 1 } }, g);
    expect(readOutbox(g).y.seen).toMatchObject({ slack: beforeTs });
    setSeen('y', { at: 1, slack: afterTs }, g);
    expect(readOutbox(g).y.seen!.slack).toBe(beforeTs);
    expect(cleanSeen({ nothing: true })).toBeNull();
    expect(cleanSeen({ email: 'a1b2c3' }, 5)).toEqual({ at: 5, email: { id: 'a1b2c3', at: 0 } });
  });

  it('the card’s passive check is cached a minute per draft', async () => {
    let n = 0;
    const deps: FreshDeps = { ...slackDeps([]), slackReplies: async () => { n++; return []; } };
    const t = { channel: 'C0TESTOUT01', thread_ts: SLACK_THREAD, created_at: '2026-11-10T10:00:00' };
    await cachedFresh('x', t, deps, 1_000);
    await cachedFresh('x', t, deps, 30_000);
    await cachedFresh('x', t, deps, 70_000);
    expect(n).toBe(2);
    expect((await checkFresh(t, deps)).ok).toBe(true);
  });

  it('reads reviews, comments and inline comments through gh', async () => {
    const calls: string[] = [];
    const act = ghActivityVia(async (args) => {
      calls.push(args[1]);
      if (args[1].includes('/reviews')) return JSON.stringify([{ id: 1, user: { login: 'kim' }, submitted_at: '2026-11-10T09:00:00Z', body: 'lgtm', html_url: 'h1', state: 'APPROVED' }, { id: 2, user: { login: 'kim' }, state: 'PENDING' }]);
      return JSON.stringify([]);
    });
    expect(await act('acme/app', 12)).toEqual([{ id: '1', kind: 'review', author: 'kim', at: '2026-11-10T09:00:00Z', body: 'lgtm', url: 'h1' }]);
    expect(calls).toEqual(['repos/acme/app/pulls/12/reviews?per_page=100', 'repos/acme/app/issues/12/comments?per_page=100', 'repos/acme/app/pulls/12/comments?per_page=100']);
  });
});

describe('Send & park for an email', () => {
  it('parks the chat on the Gmail thread and a reply from someone else (not the account) wakes it', async () => {
    const db = new Database(':memory:');
    db.exec(PARKED_SCHEMA_SQL);
    const f = store();
    addDraft({ id: 'e1', session_id: 'sess1', channel: '', messages: [], email: reply, at: NOW }, f);
    const mail = mailStub();
    const sentAt = Date.now();
    const r = await sendAndPark(db, 'e1', [reply.body], {
      readDraft: (x) => readOutbox(f)[x],
      send: (x, m) => sendDraft(x, m, { file: f, email: mail }),
      closePane: () => ({ found: true, ok: true }),
      now: sentAt,
    });
    expect(r).toMatchObject({ ok: true, parked: true, waiting_on: ['sam@example.org'] });
    const row = getParked(db, 'claude', 'sess1')!;
    expect(row).toMatchObject({ channel: 'email:work', thread_ts: THREAD, state: 'waiting' });
    const thread = [msg('b1', `Alex <${ME}>`, sentAt + 1000, { labels: ['SENT'] }), msg('b2', 'Sam <sam@example.org>', sentAt + 60_000)];
    const notes: string[] = [];
    const hit = await pollParked(db, {
      me: 'U0ME00001',
      replies: async () => { throw new Error('no Slack here'); },
      emailReplies: (account, t) => emailRepliesVia(mailStub({ thread }), account, t),
      notify: (title) => notes.push(title),
      now: sentAt + 10 * 60_000,
    });
    expect(hit.map((h) => h.reply_user)).toEqual(['Sam']);
    expect(notes).toEqual(['Sam replied']);
  });
});

/* ------------------------------------------------------------------ the card */

describe('the email card and the new-messages panel', () => {
  const card = (d: object, state: { confirm?: boolean; fresh?: object; block?: object; quote?: boolean; edit?: boolean } = {}) => {
    const f = new Function(
      'DATA', 'esc', 'rel', 'hhmm', 'NL',
      `var TERM_TOKEN='t',SENDING={},SEND_LOCAL={},LEAVING={},DRAFT_EDITS={},DRAFT_EDIT_ON={},draftConfirm=${state.confirm ? "'e1'" : 'null'},draftArmDiscard=null,draftMsg={},SLK_DIR=null,SLK_EMOJI=null;
       var fetch=function(){return new Promise(function(){});};var renderOutbox=function(){};
       var slkCtx=function(){return {users:{},channels:{},emoji:{},custom:{}};};var slkRender=function(m){return '<p>'+esc(m)+'</p>';};var slkBubbles=function(ms){return ms.map(function(m){return '<p>'+esc(m)+'</p>';}).join('');};
       ${BRAND_ICONS_JS}${OUTBOX_PURE_JS}${OUTBOX_VIEW_JS.slice(OUTBOX_VIEW_JS.indexOf('function draftTexts'))}
       FRESH['e1']=${JSON.stringify({ at: Date.now(), items: [], ...(state.fresh ?? {}) })};
       ${state.block ? `BLOCK['e1']=${JSON.stringify(state.block)};` : ''}${state.quote ? "EMAIL_QUOTE['e1']=1;" : ''}${state.edit ? "DRAFT_EDIT_ON['e1']=1;" : ''}
       return draftCardHtml(DATA.drafts[0],{});`,
    );
    const esc = (x: unknown) => String(x ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]!);
    return f({ drafts: [d] }, esc, () => '5m', () => '10:00', '\n') as string;
  };
  const em = { id: 'e1', session_id: 's', created_at: '2026-11-10T10:00:00', channel: '', messages: [], kind: 'email', email: { ...reply, cc: ['lee@example.org'] } };
  const item = { id: 'email:a4', kind: 'email', author: 'Sam <sam@example.org>', at: Date.now(), snippet: 'Never mind, found it.', url: `https://mail.google.com/mail/#all/${THREAD}` };

  it('shows from, To/Cc, subject, Reply in thread with the thread subject, and the body with its quote collapsed', () => {
    const html = card(em);
    expect(html).toContain('</svg>Email</span>');
    expect(html).toContain('Reply in thread: Q3 filing');
    expect(html).toContain(`href="https://mail.google.com/mail/#all/${THREAD}"`);
    expect(html).toContain('<b>From</b><span>work account</span>');
    expect(html).toContain('<b>To</b><span>sam@example.org</span><b>Cc</b><span>lee@example.org</span>');
    expect(html).toContain('<div class="em-subj">Re: Q3 filing</div>');
    expect(html).toContain('<div class="em-body">Hi Sam,\n\nAttached is the corrected return.</div>');
    expect(html).not.toContain('Can you resend?');
    expect(html).toContain('data-dact="email-quote"');
    expect(card(em, { quote: true })).toContain('&gt; Can you resend?');
    for (const a of ['send', 'edit', 'copy', 'discard']) expect(html).toContain(`data-dact="${a}"`);
    expect(card(em, { edit: true })).toContain('<textarea class="dtext" data-i="0"');
  });

  it('the confirm offers Send / Send & park / Send & close for an email, and says when email is off', () => {
    const html = card(em, { confirm: true });
    expect(html).toContain('Send the email as a reply in the thread to sam@example.org (+1 cc/bcc) from the work account');
    expect(html).toMatch(/data-dact="post-none"[^>]*>Send<\/button>/);
    expect(html).not.toMatch(/data-dact="post-park" disabled/);
    expect(card({ ...em, email_off: 'Email is off: set "Email CLI".' })).toContain('Email is off: set &quot;Email CLI&quot;.');
  });

  it('lists new messages (author, time, snippet, link) passively and in the confirm, with one Send anyway', () => {
    const passive = card(em, { fresh: { items: [item] } });
    expect(passive).toContain('1 new message since this was drafted');
    expect(passive).toContain('Sam &lt;sam@example.org&gt;');
    expect(passive).toContain('Never mind, found it.');
    expect(passive).toContain(`href="https://mail.google.com/mail/#all/${THREAD}"`);
    const conf = card(em, { confirm: true, block: { items: [item, { ...item, id: 'email:a5', snippet: 'And another.' }], error: '' } });
    expect(conf).toContain('2 new messages since this was drafted');
    expect(conf).toMatch(/data-dact="post-none"[^>]*>Send anyway<\/button>/);
    expect(conf).toContain('>Send anyway &amp; park</button>');
    expect(conf).toContain('>Send anyway &amp; close</button>');
    expect(conf).toContain('data-dact="cancel">Cancel</button>');
    expect(conf).not.toContain('class="fr-pass"'); // the passive copy is not repeated under the confirm
  });

  it('a failed check shows "Could not check" with Send anyway / Cancel', () => {
    const conf = card(em, { confirm: true, block: { items: [], error: 'email: token expired' } });
    expect(conf).toContain('Could not check the thread for new messages.');
    expect(conf).toContain('email: token expired');
    expect(conf).toMatch(/data-dact="post-none"[^>]*>Send anyway<\/button>/);
  });

  it('acknowledges exactly what was shown, and a 409 reopens the confirm with every warning', () => {
    expect(OUTBOX_VIEW_JS).toContain("const ack_fresh=w.error?true:w.items.map(function(i){return i.id;});");
    expect(OUTBOX_VIEW_JS).toContain("if(!j.ok&&(j.stale_head||j.stale_thread||j.fresh_error))");
    const lib = new Function(`${OUTBOX_PURE_JS}; return { freshMerge, emailSplitQuote, freshTitle };`)() as any;
    expect(lib.freshMerge([{ id: 'a', at: 2 }], [{ id: 'b', at: 1 }, { id: 'a', at: 2 }]).map((i: { id: string }) => i.id)).toEqual(['b', 'a']);
    expect(lib.emailSplitQuote('Hi\n\n> q1\n> q2')).toEqual({ main: 'Hi', quoted: '> q1\n> q2' });
    expect(lib.emailSplitQuote('a > b\nplain')).toEqual({ main: 'a > b\nplain', quoted: '' });
    expect(lib.freshTitle(1)).toBe('1 new message since this was drafted');
  });

  it('the page script still parses', () => {
    expect(() => new Function(OUTBOX_PURE_JS + OUTBOX_VIEW_JS)).not.toThrow();
  });
});

