import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type http from 'node:http';
import { openDb } from '../src/db.ts';
import type { ChatView, LiveLoc } from '../src/dashboard.ts';
import { RELAY_PREFIX, orchSettings, queuedRelays, recentLog, relayToChat } from '../src/orchestrator.ts';
import { askAboutText, chatInfos, observations, orchHistory, orchTick, type Snap } from '../src/orchserver.ts';
import { termToken } from '../src/ptybridge.ts';
import { ensureOrchToken, orchDir, orchTranscriptPath } from '../src/orchsession.ts';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../src/server.ts';

const T0 = 1_700_000_000_000;
const ORCH_SID = 'orch-test-sid-0001';

const view = (sid: string, over: Partial<ChatView> = {}): ChatView => ({
  agent: 'claude', session_id: sid, project: 'acme-app', project_dir: '/r', jsonl_path: `/nope/${sid}.jsonl`, title: `chat ${sid}`,
  claude_auto_title: '', pr_url: '', overview: `summary ${sid}`, state: '', breakdown: [], first_message: '', message_count: 3,
  started_at: T0, last_active_at: T0, last_turn_at: T0, activity: {}, summary_pending: false, saved: false, saved_at: 0, tags: [], ...over,
});
const loc = (sid: string, pane: string, over: Partial<LiveLoc> = {}): LiveLoc => ({
  agent: 'claude', session_id: sid, pane_id: pane, tmux_session: 'loom-tp-2', window_index: '1', pane_index: '0', running: true, ...over,
});

describe('chatInfos tags', () => {
  it('carries each chat\'s tags into list_chats rows', () => {
    const rows = chatInfos({ views: [view('a', { tags: ['ach'] }), view('b')], live: {} }, '');
    expect(Object.fromEntries(rows.map((r) => [r.session_id, r.tags]))).toEqual({ a: ['ach'], b: [] });
  });
});

describe('orchestrator chat rows', () => {
  it('lists running chats first with their state, pane and Slack threads, and leaves the orchestrator out', () => {
    const snap: Snap = {
      views: [view('a', { last_active_at: T0 + 5 }), view('b'), view('c', { pr_url: 'https://github.com/o/r/pull/7' }), view(ORCH_SID)],
      live: {
        'claude:b': loc('b', '%2', { working: true, name: 'blue-vanilla', stage: 'shipping' }),
        'claude:c': loc('c', '%3', { working: false }),
        [`claude:${ORCH_SID}`]: loc(ORCH_SID, '%9'),
      },
    };
    const rows = chatInfos(snap, ORCH_SID, { 'C1/1.1': { url: 'https://x.slack.com/archives/C1/p1', session_id: 'c' } });
    expect(rows.map((r) => [r.chat, r.state])).toEqual([['claude:b', 'working'], ['claude:c', 'your_turn'], ['claude:a', 'not_running']]);
    expect(rows[0]).toMatchObject({ pane: 'blue-vanilla', tmux: 'loom-tp-2:1.0', stage: 'shipping' });
    expect(rows[1]).toMatchObject({ slack: ['https://x.slack.com/archives/C1/p1'], pr: 'https://github.com/o/r/pull/7' });
  });

  it('observes running chats and chats with a PR, never the orchestrator', () => {
    const snap: Snap = { views: [view('a'), view('b', { pr_url: 'https://github.com/o/r/pull/1' }), view('c'), view(ORCH_SID)], live: { 'claude:a': loc('a', '%1', { working: true }), [`claude:${ORCH_SID}`]: loc(ORCH_SID, '%9') } };
    const obs = observations(snap, ORCH_SID, () => T0);
    expect(obs.map((o) => [o.key, o.live, o.working])).toEqual([['claude:a', true, true], ['claude:b', false, false]]);
  });

  it('asks about a chat by name, and still names it when it is not on the board', () => {
    const [c] = chatInfos({ views: [view('a')], live: { 'claude:a': loc('a', '%1', { name: 'cozy-donut' }) } }, '');
    expect(askAboutText(c, 'claude:a')).toBe('The user asks about chat claude:a ("chat a", pane cozy-donut, your turn): where does it stand, and does it need the user? Read it (chat_tail) before answering.');
    expect(askAboutText(undefined, 'claude:zz')).toContain('claude:zz');
  });
});

describe('orchestrator tick (fake tmux)', () => {
  let focused = '%1';
  const run = vi.fn((args: string[]) => {
    if (args[0] === 'list-clients') return '100 loom-tp-2\n';
    if (args[0] === 'display-message' && args.includes('#{@loom_role}')) return args[3] === '%50' ? 'orchestrator\n' : '\n';
    if (args[0] === 'display-message') return focused + '\n';
    return '';
  });
  const send = vi.fn((_p: string, _t: string, _a: string) => ({ ok: true, detail: 'sent' }));

  beforeAll(() => {
    const db = openDb();
    orchSettings.setSessionId(db, ORCH_SID);
    orchSettings.setPaneId(db, '%50');
    db.close();
  });
  afterAll(() => {
    const db = openDb();
    db.prepare(`DELETE FROM settings WHERE key LIKE 'orchestrator_%'`).run();
    db.close();
  });

  const snapAt = (working: boolean): Snap => ({
    views: [view('w1', { jsonl_path: '/nope/w1.jsonl', last_active_at: Date.now() })],
    live: { 'claude:w1': loc('w1', '%7', { working, name: 'lucky-fern' }), [`claude:${ORCH_SID}`]: loc(ORCH_SID, '%50', { tmux_session: 'loom-managed' }) },
  });

  it('debounces a finished turn into one [Loom events] message to the orchestrator pane', () => {
    orchTick(snapAt(true), T0, { run, send });
    orchTick(snapAt(false), T0 + 15_000, { run, send });
    expect(send).not.toHaveBeenCalled(); // inside the quiet window
    orchTick(snapAt(false), T0 + 40_000, { run, send });
    expect(send).toHaveBeenCalledTimes(1);
    const [pane, text] = send.mock.calls[0];
    expect(pane).toBe('%50');
    expect(text).toMatch(/^\[Loom events\] .*1 change: \(1\) your turn: "chat w1" · lucky-fern/);
    const db = openDb();
    expect(recentLog(db, 0).some((l) => l.kind === 'events')).toBe(true);
    db.close();
  });

  it('holds the batch while the user is in the orchestrator pane', () => {
    send.mockClear();
    orchTick(snapAt(true), T0 + 100_000, { run, send });
    orchTick(snapAt(false), T0 + 115_000, { run, send });
    focused = '%50';
    orchTick(snapAt(false), T0 + 140_000, { run, send });
    expect(send).not.toHaveBeenCalled();
    focused = '%1';
    orchTick(snapAt(false), T0 + 155_000, { run, send });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('delivers a relay queued for the focused chat once focus moves off it', () => {
    send.mockClear();
    const db = openDb();
    relayToChat(db, { focused: () => '%7', resolve: (agent, sid) => ({ agent, session_id: sid, pane_id: '%7', label: 'lucky-fern' }), send, now: () => T0 + 200_000 }, 'claude', 'w1', 'stop and wait');
    expect(queuedRelays(db)).toHaveLength(1);
    focused = '%7';
    orchTick(snapAt(true), T0 + 210_000, { run, send });
    expect(send).not.toHaveBeenCalled();
    focused = '%1';
    orchTick(snapAt(true), T0 + 225_000, { run, send });
    expect(send).toHaveBeenCalledWith('%7', `${RELAY_PREFIX} stop and wait`, 'claude');
    expect(queuedRelays(db)).toHaveLength(0);
    db.close();
  });
});

describe('orchestrator routes', () => {
  // An empty LOOM_HOME DB is a fresh install (orchestrator off); these routes test an enabled one.
  beforeAll(() => {
    const db = openDb();
    db.prepare(`INSERT OR REPLACE INTO settings(key, value) VALUES ('orchestrator_enabled', '1')`).run();
    db.close();
  });
  afterAll(() => {
    const db = openDb();
    db.prepare(`DELETE FROM settings WHERE key = 'orchestrator_enabled'`).run();
    db.close();
  });
  async function request(method: string, pathname: string, opts: { body?: unknown; headers?: Record<string, string> } = {}) {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    try {
      const r = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
        method,
        // Loom's own page by default (Origin + launch token); a test overrides either.
        headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), origin: `http://127.0.0.1:${address.port}`, 'x-loom-token': termToken(), ...(opts.headers ?? {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('serves the view with items, log and the notify setting', async () => {
    const r = await request('GET', '/api/orch');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, notify: 'needs_you', items: expect.any(Array), log: expect.any(Array), messages: expect.any(Array) });
  });

  it('runs MCP tool calls only with the token', async () => {
    expect((await request('POST', '/api/orch/tool', { body: { name: 'list_items', args: {} } })).status).toBe(403);
    expect((await request('POST', '/api/orch/tool', { body: { name: 'list_items' }, headers: { 'x-loom-orch-token': 'wrong' } })).status).toBe(403);
    const token = ensureOrchToken(orchDir());
    const up = await request('POST', '/api/orch/tool', { body: { name: 'upsert_item', args: { kind: 'blocked', title: 'route test item', who: 'CI' } }, headers: { 'x-loom-orch-token': token } });
    expect(up.body).toMatchObject({ ok: true, result: { created: true, item: { kind: 'blocked', who: 'CI' } } });
    const list = await request('POST', '/api/orch/tool', { body: { name: 'list_items', args: {} }, headers: { 'x-loom-orch-token': token } });
    expect(list.body.result.items.some((i: { title: string }) => i.title === 'route test item')).toBe(true);
    const res = await request('POST', '/api/orch/resolve', { body: { id: up.body.result.item.id } });
    expect(res.body).toMatchObject({ ok: true, item: { resolved_at: expect.any(Number) } });
  });

  it("refuses the UI's writes from another origin or without the launch token", async () => {
    expect((await request('POST', '/api/orch/send', { body: { text: 'hi' }, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    expect((await request('POST', '/api/orch/notify', { body: { mode: 'off' }, headers: { 'x-loom-token': 'wrong' } })).status).toBe(403);
    // Allowed, but nothing to send to: no orchestrator is running in the test.
    expect((await request('POST', '/api/orch/send', { body: { text: 'hi' } })).status).toBe(409);
    expect((await request('POST', '/api/orch/ask', { body: { session: 'x', agent: 'claude' } })).status).toBe(409);
  });

  it('switches notifications off and back', async () => {
    expect((await request('POST', '/api/orch/notify', { body: { mode: 'off' } })).body).toEqual({ ok: true, notify: 'off' });
    expect((await request('GET', '/api/orch')).body.notify).toBe('off');
    expect((await request('POST', '/api/orch/notify', { body: { mode: 'loud' } })).status).toBe(400);
    await request('POST', '/api/orch/notify', { body: { mode: 'needs_you' } });
  });

  it('puts the badge count and the orchestrator session on /api/data', async () => {
    const r = await request('GET', '/api/data');
    expect(r.body.orch).toMatchObject({ needsYou: expect.any(Number), enabled: true, live: false });
  });
});

describe('orchestrator history paging', () => {
  const SID = 'orch-history-test-0001';
  const file = () => orchTranscriptPath(orchDir(), SID);
  let prev: string;
  beforeAll(() => {
    const db = openDb();
    prev = orchSettings.sessionId(db);
    orchSettings.setSessionId(db, SID);
    db.close();
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    // 10 turns, 1 s apart, alternating roles.
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify(
      i % 2 === 0
        ? { type: 'user', timestamp: new Date(T0 + i * 1000).toISOString(), message: { role: 'user', content: `turn ${i}` } }
        : { type: 'assistant', timestamp: new Date(T0 + i * 1000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: `turn ${i}` }] } },
    ));
    fs.writeFileSync(file(), lines.join('\n') + '\n');
  });
  afterAll(() => {
    fs.rmSync(file(), { force: true });
    const db = openDb();
    if (prev) orchSettings.setSessionId(db, prev);
    else db.prepare(`DELETE FROM settings WHERE key = 'orchestrator_session_id'`).run();
    db.close();
  });

  it('returns the turns before the cursor, oldest first, and says whether more remain', () => {
    const a = orchHistory(T0 + 8000, 3);
    expect(a.messages.map((m) => m.text)).toEqual(['turn 5', 'turn 6', 'turn 7']);
    expect(a.more).toBe(true);
    const b = orchHistory(T0 + 5000, 3);
    expect(b.messages.map((m) => m.text)).toEqual(['turn 2', 'turn 3', 'turn 4']);
    expect(b.more).toBe(true);
    const c = orchHistory(T0 + 3000, 10);
    expect(c.messages.map((m) => m.text)).toEqual(['turn 0', 'turn 1', 'turn 2']);
    expect(c.more).toBe(false);
    expect(orchHistory(T0, 5)).toEqual({ ok: true, messages: [], more: false });
  });
});
