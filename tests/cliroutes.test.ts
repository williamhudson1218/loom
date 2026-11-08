import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, notifyScript } from '../src/server.ts';
import { ensureCliToken, readCliToken } from '../src/routes/index.ts';
import { setCliDeps, tmuxNamedPanes, tmuxDeliver, ROUTE_MAX, type NamedPane } from '../src/routes/cli.ts';
import { applySchema } from '../src/schema.ts';
import { applyEvent } from '../src/events.ts';
import { addDraft, readOutbox } from '../src/outbox.ts';
import { termToken } from '../src/ptybridge.ts';
import { openDb } from '../src/db.ts';
import { setSetting } from '../src/settingsSchema.ts';

// The plugin's HTTP surface (/api/cli/*), through the real server and its guard.
// Every dependency that would touch tmux, Slack or the real DB is a fake here.

const SID = '11111111-2222-3333-4444-555555555555';
const KEY = 'C0TESTCHAN1/1793839555.348489';
const URL_ = 'https://acme.slack.com/archives/C0TESTCHAN1/p1793839555348489';

let server: http.Server;
let port = 0;
let dir: string;
let dbFile: string;
let outbox: string;
const delivered: [string, string][] = [];
const slackCalls: { method: string; body: any }[] = [];
let slackOn = true;

const panes: NamedPane[] = [
  { pane_id: '%1', name: 'blue-vanilla', target: 'loom-a:1.0', command: '2.1.319', topic: 'Fix ACH', path: '/tmp/a' },
  { pane_id: '%2', name: 'cozy-donut', target: 'loom-a:1.1', command: '2.1.319', topic: '', path: '/tmp/b' },
  { pane_id: '%3', name: 'quiet-editor', target: 'loom-a:1.2', command: 'nvim', topic: '', path: '/tmp/c' },
  { pane_id: '%4', name: 'twin', target: 'loom-b:1.0', command: 'zsh', topic: '', path: '/tmp' },
  { pane_id: '%5', name: 'twin', target: 'loom-b:1.1', command: 'zsh', topic: '', path: '/tmp' },
];

beforeAll(async () => {
  ensureCliToken();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cliroutes-'));
  dbFile = path.join(dir, 'cli.db');
  outbox = path.join(dir, 'outbox.json');
  server = createServer();
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    const method = String(url).replace('https://slack.com/api/', '').split('?')[0];
    const body = init.body ? JSON.parse(String(init.body)) : {};
    slackCalls.push({ method, body });
    const out = method === 'reactions.remove' && body.name === 'no_entry' ? { ok: false, error: 'no_reaction' } : method === 'chat.postMessage' ? { ok: true, ts: '1793990000.000009', channel: body.channel } : { ok: true };
    return { status: 200, headers: new Headers(), json: async () => out } as Response;
  }) as typeof fetch;
  setCliDeps({
    openDb: () => {
      const db = new Database(dbFile);
      applySchema(db);
      return db;
    },
    outbox: { file: outbox, legacy: '' },
    chats: () => [{ session_id: SID, title: 'Fix the ACH retry', jsonl_path: '/tmp/x/' + SID + '.jsonl', project_dir: '/tmp/a' }],
    live: () => [{ session_id: SID, pane_id: '%1', cwd: '/tmp/a' }],
    panes: () => panes,
    deliver: (p, t) => {
      delivered.push([p, t]);
      return { ok: true, detail: 'delivered' };
    },
    legacyThreads: () => ({ 'C0TESTCHAN9/1793800000.000001': { url: 'https://acme.slack.com/archives/C0TESTCHAN9/p1793800000000001', session_id: 'legacy-sid', cwd: '/old' } }),
    slackOn: () => slackOn,
    slack: { token: 'xoxp-test-token', fetchImpl },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  delivered.length = 0;
  slackCalls.length = 0;
  slackOn = true;
});

async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method,
    headers: { 'x-loom-cli-token': readCliToken(), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: (await r.json()) as any };
}

describe('/api/cli reads', () => {
  it('threads: Loom’s claims with stage and ack, plus the old hook’s, filtered by key or session', async () => {
    const db = new Database(dbFile);
    applySchema(db);
    applyEvent(db, { kind: 'thread.claim', session: SID, key: KEY, url: URL_, cwd: '/tmp/a', mode: 'if_unowned' });
    applyEvent(db, { kind: 'thread.stage', key: KEY, stage: 'looking', react: true, at: 10 });
    applyEvent(db, { kind: 'thread.ack', key: KEY, text: 'Looking into it', at: 11 });
    db.close();
    const one = await call('GET', '/api/cli/threads?key=' + encodeURIComponent(KEY));
    expect(one.status).toBe(200);
    expect(one.body.threads).toEqual([
      { key: KEY, url: URL_, session_id: SID, stage: 'looking', react: true, ack: { text: 'Looking into it', at: 11 }, recent_acks: ['Looking into it'], title: 'Fix the ACH retry', cwd: '/tmp/a', transcript_path: '/tmp/x/' + SID + '.jsonl' },
    ]);
    expect((await call('GET', '/api/cli/threads')).body.threads.map((t: any) => t.key)).toEqual(['C0TESTCHAN1/1793839555.348489', 'C0TESTCHAN9/1793800000.000001']);
    expect((await call('GET', '/api/cli/threads?session=legacy-sid')).body.threads.map((t: any) => t.session_id)).toEqual(['legacy-sid']);
    expect((await call('GET', '/api/cli/threads?key=C0NONE/1.2')).status).toBe(400);
  });

  it('outbox: pending by default, everything recent with all=1, one draft by id', async () => {
    addDraft({ id: 'd5aa', session_id: SID, channel: 'C0TESTCHAN1', messages: ['one'] }, { file: outbox, legacy: '' });
    addDraft({ id: 'd5bb', session_id: SID, channel: 'C0TESTCHAN1', messages: ['two'] }, { file: outbox, legacy: '' });
    const list = await call('GET', '/api/cli/outbox');
    expect(list.body.drafts.map((d: any) => [d.id, d.status])).toEqual([['d5bb', 'pending']]);
    expect((await call('GET', '/api/cli/outbox?all=1')).body.drafts.map((d: any) => d.id)).toEqual(['d5aa', 'd5bb']);
    const one = await call('GET', '/api/cli/outbox/d5aa');
    expect(one).toMatchObject({ status: 200, body: { draft: { id: 'd5aa', status: 'superseded', messages: ['one'] } } });
    expect((await call('GET', '/api/cli/outbox/nope')).status).toBe(404);
  });

  it('the parameterised path is guarded like the table rows', async () => {
    expect((await call('GET', '/api/cli/outbox/d5aa', undefined, { 'x-loom-cli-token': 'x'.repeat(43) })).status).toBe(403);
    expect((await call('GET', '/api/cli/outbox/d5aa', undefined, { origin: `http://127.0.0.1:${port}` })).status).toBe(403);
    expect((await call('GET', '/api/cli/nothing-here')).status).toBe(404);
    expect((await call('GET', '/api/cli/nothing-here', undefined, { 'x-loom-cli-token': '' })).status).toBe(403);
  });

  it('ship-labels: one per chat, the newest', async () => {
    const db = new Database(dbFile);
    applySchema(db);
    applyEvent(db, { kind: 'ship.label', session: SID, label: 'Old', repo: '/r1', at: 1 });
    applyEvent(db, { kind: 'ship.label', session: SID, label: 'New', repo: '/r2', at: 2 });
    db.close();
    expect((await call('GET', '/api/cli/ship-labels?session=' + SID)).body.labels).toEqual({ [SID]: { label: 'New', repo: '/r2', at: 2 } });
  });

  it('route and whoami', async () => {
    const r = await call('GET', '/api/cli/route');
    expect(r.body.panes[0]).toEqual({ pane_id: '%1', name: 'blue-vanilla', target: 'loom-a:1.0', command: '2.1.319', topic: 'Fix ACH' });
    const me = await call('GET', `/api/cli/whoami?pane=%251&session=${SID}`);
    expect(me.body).toMatchObject({ name: 'blue-vanilla', pane_id: '%1', session: SID, project: '/tmp/a' });
    const bySession = await call('GET', `/api/cli/whoami?pane=&session=${SID}`);
    expect(bySession.body).toMatchObject({ name: 'blue-vanilla', pane_id: '%1' });
  });
});

describe('/api/cli/route/send', () => {
  it('delivers to a named Claude pane, flattened to one line', async () => {
    const r = await call('POST', '/api/cli/route/send', { to: 'cozy-donut', text: '[to cozy-donut from blue-vanilla]\nhello', pane: '%1' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, detail: 'delivered to cozy-donut (%2)' } });
    expect(delivered).toEqual([['%2', '[to cozy-donut from blue-vanilla] hello']]);
  });

  it('refuses your own pane, an unknown or ambiguous name, an editor, and an over-long text', async () => {
    expect((await call('POST', '/api/cli/route/send', { to: 'blue-vanilla', text: 'x', pane: '%1' })).status).toBe(409);
    expect((await call('POST', '/api/cli/route/send', { to: 'blue-vanila', text: 'x' })).status).toBe(404);
    expect((await call('POST', '/api/cli/route/send', { to: 'twin', text: 'x' })).status).toBe(409);
    expect((await call('POST', '/api/cli/route/send', { to: 'quiet-editor', text: 'x' })).status).toBe(409);
    expect((await call('POST', '/api/cli/route/send', { to: 'cozy-donut', text: 'y'.repeat(ROUTE_MAX + 1) })).status).toBe(400);
    expect(delivered).toEqual([]);
  });

  it('tmux helpers: list-panes parsing and literal-then-Enter delivery (fake runner)', () => {
    const out = '%1\tblue-vanilla\tloom-a:1.0\t2.1.319\tFix ACH\t/tmp/a\n%9\t\tloom-a:1.3\tzsh\t\t/tmp\n';
    expect(tmuxNamedPanes(() => out).map((p) => p.name)).toEqual(['blue-vanilla']);
    const argv: string[][] = [];
    expect(tmuxDeliver('%2', 'hi', (a) => { argv.push(a); return ''; }).ok).toBe(true);
    expect(argv).toEqual([['send-keys', '-t', '%2', '-l', 'hi'], ['send-keys', '-t', '%2', 'Enter']]);
  });
});

describe('/api/cli/slack (fetch stub)', () => {
  it('react removes the superseded reactions (tolerating ones not there) and adds the new one', async () => {
    const r = await call('POST', '/api/cli/slack/react', { channel: 'C0TESTCHAN1', ts: '1793839555.348489', add: 'white_check_mark', remove: ['eyes', 'no_entry'] });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(slackCalls.map((c) => `${c.method}:${c.body.name}`)).toEqual(['reactions.remove:eyes', 'reactions.remove:no_entry', 'reactions.add:white_check_mark']);
  });

  it('reply posts in the thread only', async () => {
    const r = await call('POST', '/api/cli/slack/reply', { channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', text: 'Looking into it', ack: true });
    expect(r).toMatchObject({ status: 200, body: { ok: true } });
    expect(slackCalls).toEqual([{ method: 'chat.postMessage', body: { channel: 'C0TESTCHAN1', text: 'Looking into it', thread_ts: '1793839555.348489' } }]);
    expect((await call('POST', '/api/cli/slack/reply', { channel: 'C0TESTCHAN1', text: 'top level?' })).status).toBe(400);
  });

  it('409 slack_off unless Slack is direct, and nothing is called', async () => {
    slackOn = false;
    expect(await call('POST', '/api/cli/slack/react', { channel: 'C0TESTCHAN1', ts: '1793839555.348489', add: 'eyes' })).toMatchObject({ status: 409, body: { error: 'slack_off' } });
    expect(await call('POST', '/api/cli/slack/reply', { channel: 'C0TESTCHAN1', thread_ts: '1793839555.348489', text: 'x' })).toMatchObject({ status: 409, body: { error: 'slack_off' } });
    expect(slackCalls).toEqual([]);
  });
});

describe('/api/outbox/send gating', () => {
  const page = () => ({ origin: `http://127.0.0.1:${port}`, 'x-loom-token': termToken(), 'content-type': 'application/json' });
  it('refuses a real Send unless Slack is direct (409 slack_off), and allows a dry run, which posts nothing', async () => {
    // Pin the mode off in the shared test DB, so this can never reach Slack whatever else ran first.
    const db = openDb();
    try {
      setSetting(db, 'slack_mode', 'off');
    } finally {
      db.close();
    }
    addDraft({ id: 'd7aa', session_id: SID, channel: 'C0TESTCHAN1', messages: ['hello'] }); // the test home's outbox
    const real = await fetch(`http://127.0.0.1:${port}/api/outbox/send`, { method: 'POST', headers: page(), body: JSON.stringify({ id: 'd7aa', messages: ['hello'] }) });
    expect(real.status).toBe(409);
    expect(await real.json()).toMatchObject({ ok: false, error: 'slack_off' });
    const dry = await fetch(`http://127.0.0.1:${port}/api/outbox/send`, { method: 'POST', headers: page(), body: JSON.stringify({ id: 'd7aa', messages: ['**hello**'], dry: true }) });
    expect(await dry.json()).toMatchObject({ ok: true, dry: true, rendered: '*hello*' });
    expect(readOutbox().d7aa.status).toBe('pending');
  });
});

describe('archive search follows find_chat_bin', () => {
  it('a configured find-chat that does not exist hides archive search; clearing it re-detects', async () => {
    const db = openDb();
    try {
      setSetting(db, 'find_chat_bin', path.join(dir, 'no-such-find-chat'));
    } finally {
      db.close();
    }
    const r = await fetch(`http://127.0.0.1:${port}/api/search?q=anything`);
    expect(await r.json()).toEqual({ ok: false, unavailable: true, detail: 'find-chat not installed' });
    const db2 = openDb();
    try {
      setSetting(db2, 'find_chat_bin', '');
    } finally {
      db2.close();
    }
  });
});

describe('notifications', () => {
  it('the notification uses notify_sound: off is silent, system the default, a name that sound', () => {
    expect(notifyScript('T', 'B', 'off')).toBe('display notification "B" with title "T"');
    expect(notifyScript('T', 'B', 'system')).toBe('display notification "B" with title "T" sound name "default"');
    expect(notifyScript('T', 'say "hi"', 'Hero')).toBe('display notification "say \\"hi\\"" with title "T" sound name "Hero"');
  });
});
