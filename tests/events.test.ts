import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { applyEvent, ingestEvents } from '../src/events.ts';
import { readOutbox } from '../src/outbox.ts';
import { getOwner, syncLegacyThreads, threadState, recentAcks } from '../src/slackowner.ts';
import { importChannelLabels, importOutbox, importThreads, step } from '../src/migrations/state.ts';

const FIX = path.join(__dirname, 'fixtures', 'state');
const SID = '11111111-2222-3333-4444-555555555555';
const OTHER = '66666666-7777-8888-9999-000000000000';
const KEY = 'C0TESTCHAN1/1793839555.348489';
const URL = 'https://acme.slack.com/archives/C0TESTCHAN1/p1793839555348489';

let dir: string, events: string, outbox: string, db: Database.Database;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-events-'));
  events = path.join(dir, 'events');
  outbox = path.join(dir, 'outbox.json');
  fs.mkdirSync(events);
  db = new Database(':memory:');
  applySchema(db);
});

let seq = 0;
/** Drop an event file the way the plugin's write_event does: a dot-tmp, then a rename. */
function drop(kind: string, fields: Record<string, unknown>, at = 1_793_990_000_000 + seq): string {
  const name = `${at}-${String(++seq).padStart(6, '0')}.json`;
  const tmp = path.join(events, '.' + name + '.tmp');
  fs.writeFileSync(tmp, JSON.stringify({ v: 1, kind, at, ...fields }), { mode: 0o600 });
  fs.renameSync(tmp, path.join(events, name));
  return name;
}
const ingest = () => ingestEvents(db, { dir: events, outbox: { file: outbox, legacy: '' } });
const left = () => fs.readdirSync(events).filter((n) => n.endsWith('.json'));

describe('event ingest', () => {
  it('applies outbox events in order and deletes each file once applied', () => {
    drop('outbox.add', { id: 'd1aa', session: SID, channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', thread_url: URL, messages: ['first'] });
    drop('outbox.update', { id: 'd1aa', session: SID, messages: ['first, revised'] });
    drop('outbox.add', { id: 'd1bb', session: SID, channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', thread_url: URL, messages: ['second'] });
    drop('outbox.add', { id: 'd1cc', session: SID, channel: '#demo', messages: ['top level'] });
    drop('outbox.supersede', { id: 'd1cc', session: SID });
    const r = ingest();
    expect(r.applied).toBe(5);
    expect(left()).toEqual([]);
    const d = readOutbox({ file: outbox, legacy: '' });
    expect(d.d1aa).toMatchObject({ status: 'superseded', messages: ['first, revised'] });
    expect(d.d1bb).toMatchObject({ status: 'pending', session_id: SID, channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', messages: ['second'] });
    expect(d.d1cc.status).toBe('superseded');
  });

  it('is idempotent: the same event files read again change nothing', () => {
    const evs: [string, Record<string, unknown>][] = [
      ['outbox.add', { id: 'd2aa', session: SID, channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', messages: ['one'] }],
      ['outbox.add', { id: 'd2bb', session: SID, channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', messages: ['two'] }],
      ['thread.claim', { session: SID, key: KEY, url: URL, cwd: '/tmp/p', mode: 'if_unowned' }],
      ['thread.stage', { session: SID, key: KEY, url: URL, stage: 'looking', react: true }],
      ['thread.ack', { session: SID, key: KEY, text: 'Looking into it' }],
      ['ship.label', { session: SID, label: 'Fix the thing', repo: '/tmp/p' }],
    ];
    const at = 1_793_990_100_000;
    for (const [k, f] of evs) drop(k, f, at);
    ingest();
    const snap = () => JSON.stringify({
      outbox: readOutbox({ file: outbox, legacy: '' }),
      owners: db.prepare(`SELECT * FROM slack_threads`).all(),
      state: db.prepare(`SELECT * FROM slack_thread_state`).all(),
      labels: db.prepare(`SELECT * FROM ship_labels`).all(),
    });
    const once = snap();
    // Loom quit after applying but before deleting: every file comes round again.
    for (const [k, f] of evs) drop(k, f, at);
    expect(ingest().applied).toBe(evs.length);
    expect(snap()).toBe(once);
    // The superseded first draft did not come back to life.
    expect(readOutbox({ file: outbox, legacy: '' }).d2aa.status).toBe('superseded');
  });

  it('never loses a draft to a bad file: it is set aside in events/bad, not deleted', () => {
    const name = drop('outbox.add', { id: 'has spaces', session: SID, channel: 'C1', messages: ['x'] });
    fs.writeFileSync(path.join(events, '9999999999999-000001.json'), '{"kind": "outbox.add", "id": "d3", trunc');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(path.join(events, '9999999999999-000001.json'), old, old);
    const r = ingest();
    expect(r.bad.sort()).toEqual(['9999999999999-000001.json', name].sort());
    expect(fs.readdirSync(path.join(events, 'bad')).sort()).toEqual(['9999999999999-000001.json', name].sort());
    expect(left()).toEqual([]);
  });

  it('leaves a fresh file that does not parse yet for the next pass, and skips dot-tmp files', () => {
    fs.writeFileSync(path.join(events, '9999999999999-000002.json'), '{"kind":');
    fs.writeFileSync(path.join(events, '.9999999999999-000003.json.tmp'), '{');
    const r = ingest();
    expect(r.applied).toBe(0);
    expect(r.bad).toEqual([]);
    expect(fs.readdirSync(events).sort()).toEqual(['.9999999999999-000003.json.tmp', '9999999999999-000002.json']);
  });

  it('a revision of a draft that was already sent is done, not bad', () => {
    drop('outbox.add', { id: 'd4', session: SID, channel: 'C1', messages: ['x'] });
    ingest();
    const d = readOutbox({ file: outbox, legacy: '' });
    d.d4.status = 'sent';
    fs.writeFileSync(outbox, JSON.stringify({ drafts: d }));
    drop('outbox.update', { id: 'd4', messages: ['late'] });
    expect(ingest()).toMatchObject({ applied: 1, bad: [] });
    expect(readOutbox({ file: outbox, legacy: '' }).d4.messages).toEqual(['x']);
  });
});

describe('thread events', () => {
  const ref = { key: KEY, url: URL };
  it('if_unowned claims only an unowned thread; takeover and force move it', () => {
    expect(applyEvent(db, { kind: 'thread.claim', session: SID, ...ref, mode: 'if_unowned', cwd: '/a' }).detail).toBe('claimed');
    expect(applyEvent(db, { kind: 'thread.claim', session: OTHER, ...ref, mode: 'if_unowned' }).detail).toBe('unchanged');
    expect(getOwner(db, KEY)?.session_id).toBe(SID);
    expect(applyEvent(db, { kind: 'thread.claim', session: OTHER, ...ref, mode: 'takeover', cwd: '/b' }).detail).toBe('claimed');
    expect(getOwner(db, KEY)).toMatchObject({ session_id: OTHER, project_dir: '/b', source: 'claim' });
    expect(applyEvent(db, { kind: 'thread.claim', session: SID, ...ref, mode: 'force' }).detail).toBe('claimed');
    expect(getOwner(db, KEY)?.session_id).toBe(SID);
    expect(applyEvent(db, { kind: 'thread.release', session: SID, key: KEY }).detail).toBe('released');
    expect(getOwner(db, KEY)).toBeNull();
  });

  it('a started claim never takes a DM; a key alone (no url) is enough', () => {
    applyEvent(db, { kind: 'thread.claim', session: SID, key: 'D0DM000001/1793839555.348489', mode: 'if_unowned', started: true });
    expect(getOwner(db, 'D0DM000001/1793839555.348489')).toBeNull();
    applyEvent(db, { kind: 'thread.claim', session: SID, key: KEY, mode: 'if_unowned', started: true });
    expect(getOwner(db, KEY)).toMatchObject({ source: 'send', url: URL.replace('acme.slack.com', 'app.slack.com') });
  });

  it('stage remembers react from looking; one ack per thread; recent acks', () => {
    applyEvent(db, { kind: 'thread.stage', key: KEY, stage: 'looking', react: false, at: 1 });
    applyEvent(db, { kind: 'thread.stage', key: KEY, stage: 'done', react: true, note: 'shipped', at: 2 });
    expect(threadState(db, KEY)).toMatchObject({ stage: 'done', note: 'shipped', react: 0 });
    expect(applyEvent(db, { kind: 'thread.ack', key: KEY, text: 'Taking a look', at: 3 }).detail).toBe('acked');
    expect(applyEvent(db, { kind: 'thread.ack', key: KEY, text: 'Again', at: 4 }).detail).toBe('already acked');
    expect(recentAcks(db)).toEqual(['Taking a look']);
    expect(applyEvent(db, { kind: 'thread.stage', key: KEY, stage: 'sideways' }).ok).toBe(false);
  });

  it('ship.label upserts and clears', () => {
    applyEvent(db, { kind: 'ship.label', session: SID, label: 'One', repo: '/r/', at: 1 });
    applyEvent(db, { kind: 'ship.label', session: SID, label: 'Two', repo: '/r', at: 2 });
    expect(db.prepare(`SELECT repo, label FROM ship_labels`).all()).toEqual([{ repo: '/r', label: 'Two' }]);
    applyEvent(db, { kind: 'ship.label', session: SID, clear: true });
    expect(db.prepare(`SELECT * FROM ship_labels`).all()).toEqual([]);
  });

  it('rejects unknown kinds', () => {
    expect(applyEvent(db, { kind: 'outbox.send', id: 'd1' }).ok).toBe(false);
  });
});

describe('legacy thread state', () => {
  const legacy = () => JSON.parse(fs.readFileSync(path.join(FIX, 'slack-threads.json'), 'utf-8')).threads;

  it('mirrors owners and stages in once, follows the old hook’s takeovers, and keeps Loom’s own claims', () => {
    expect(syncLegacyThreads(db, legacy(), 5)).toBeGreaterThan(0);
    expect(getOwner(db, KEY)).toMatchObject({ session_id: SID, project_dir: '/tmp/demo-project', source: 'legacy' });
    expect(threadState(db, KEY)).toMatchObject({ stage: 'looking', react: 1, ack_text: 'Taking a look' });
    expect(threadState(db, 'C0TESTCHAN3/1793900000.000200')?.stage).toBe('done');
    expect(getOwner(db, 'C0TESTCHAN3/1793900000.000200')).toBeNull(); // a stage-only record owns nothing
    // Unchanged file: nothing to do.
    expect(syncLegacyThreads(db, legacy(), 6)).toBe(0);
    // The old hook moves a thread (its own takeover): the legacy row follows.
    const moved = legacy();
    moved[KEY] = { ...moved[KEY], session_id: OTHER };
    syncLegacyThreads(db, moved, 7);
    expect(getOwner(db, KEY)?.session_id).toBe(OTHER);
    // Loom's own claim is never overwritten by the file.
    applyEvent(db, { kind: 'thread.claim', session: SID, key: KEY, url: URL, mode: 'force' });
    moved[KEY] = { ...moved[KEY], session_id: 'someone-else', claimed_at: '2026-11-06T10:00:00' };
    syncLegacyThreads(db, moved, 8);
    expect(getOwner(db, KEY)).toMatchObject({ session_id: SID, source: 'claim' });
  });

  it('a thread Loom released is not dragged back by an unchanged file', () => {
    syncLegacyThreads(db, legacy(), 5);
    applyEvent(db, { kind: 'thread.release', key: 'C0TESTCHAN2/1793900000.000100' });
    syncLegacyThreads(db, legacy(), 6);
    expect(getOwner(db, 'C0TESTCHAN2/1793900000.000100')).toBeNull();
  });

  it('runs before the events on each ingest pass', () => {
    drop('thread.claim', { session: OTHER, key: KEY, url: URL, mode: 'if_unowned' });
    ingestEvents(db, { dir: events, outbox: { file: outbox, legacy: '' }, legacyThreads: legacy });
    expect(getOwner(db, KEY)?.session_id).toBe(SID); // the old hook's claim came first
  });
});

describe('migrations/state (§12 step 5)', () => {
  const ctx = () => ({ db, loomHome: dir, legacyStateDir: FIX, now: 1_000, log: () => {} });

  it('imports a legacy outbox fixture with ids and fields preserved, and leaves the fixture untouched', () => {
    const before = fs.readFileSync(path.join(FIX, 'slack-outbox.json'), 'utf-8');
    expect(importOutbox(ctx())).toBe(3);
    const got = readOutbox({ file: path.join(dir, 'outbox.json'), legacy: '' });
    const want = JSON.parse(before).drafts;
    for (const id of Object.keys(want)) expect(got[id]).toMatchObject(want[id]);
    expect(fs.readFileSync(path.join(FIX, 'slack-outbox.json'), 'utf-8')).toBe(before);
    // Again: a no-op.
    const own = fs.readFileSync(path.join(dir, 'outbox.json'), 'utf-8');
    importOutbox(ctx());
    expect(fs.readFileSync(path.join(dir, 'outbox.json'), 'utf-8')).toBe(own);
  });

  it('imports thread owners in the transaction step and labels after commit, idempotently', () => {
    step.run({ ...ctx(), home: dir, claudeHome: dir, claudeJsonPath: '', codexHooksPath: '', slackTokenPath: '', env: {} } as any);
    expect(getOwner(db, KEY)?.session_id).toBe(SID);
    expect(importThreads(ctx())).toBe(0);
    expect(importChannelLabels(ctx())).toBe(2);
    expect(importChannelLabels(ctx())).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'slack-cache.json'), 'utf-8')).channels).toEqual({ C0TESTCHAN1: '#demo-eng', D0TESTDM01: '@sam' });
  });

  it('does nothing on an install with no legacy files', () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-nolegacy-'));
    const c = { ...ctx(), legacyStateDir: empty };
    expect([importThreads(c), importOutbox(c), importChannelLabels(c)]).toEqual([0, 0, 0]);
    expect(fs.existsSync(path.join(dir, 'outbox.json'))).toBe(false);
  });
});

describe('review drafts through events', () => {
  it('records a review bundle from outbox.add and revises the review alone from outbox.update', () => {
    const review = { repo: 'acme/app', pr: 12, commit_id: 'abc1234def5678', event: 'REQUEST_CHANGES', body: 'Two blockers.', comments: [{ path: 'src/a.ts', line: 10, body: 'x' }] };
    drop('outbox.add', { id: 'r1aa', session: SID, channel: '', messages: [], review, reactions: [{ channel: 'C0TESTCHAN1', ts: '1793839555.348489', add: ['white_check_mark'] }] });
    ingest();
    expect(readOutbox({ file: outbox, legacy: '' }).r1aa).toMatchObject({ status: 'pending', channel: '', messages: [], review: { event: 'REQUEST_CHANGES' } });
    drop('outbox.update', { id: 'r1aa', session: SID, review: { ...review, event: 'APPROVE' } });
    ingest();
    expect(readOutbox({ file: outbox, legacy: '' }).r1aa.review!.event).toBe('APPROVE');
    expect(left()).toEqual([]);
  });
});
