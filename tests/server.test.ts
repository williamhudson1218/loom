import { describe, expect, it, vi, beforeEach } from 'vitest';
import type http from 'node:http';
import { archiveExcludeSessionIds, createServer } from '../src/server.ts';
import { termToken } from '../src/ptybridge.ts';
import { movePane, ungroupPane, readWorld, type LanePane } from '../src/compact.ts';
import { launchInPane } from '../src/goto.ts';
import { acquireManagedPane } from '../src/managed.ts';
import { currentTerminal } from '../src/terminal.ts';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import { toChatViews } from '../src/dashboard.ts';
import path from 'node:path';

// The pane routes swap real panes, so they are stubbed here: these tests pin the
// HTTP contract, and the move logic itself is covered in compact.test.ts against
// a fake tmux.
vi.mock('../src/compact.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/compact.ts')>()),
  movePane: vi.fn(),
  ungroupPane: vi.fn(),
  readWorld: vi.fn(),
}));
// A managed window is a real tmux window; the routes stop at the call.
vi.mock('../src/managed.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/managed.ts')>()),
  acquireManagedPane: vi.fn(),
}));
// Likewise launching types into a real pane; the lane routes stop at the call.
// Which terminal is in effect reads the real settings and tmux server; pin it.
vi.mock('../src/terminal.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/terminal.ts')>()),
  currentTerminal: vi.fn(() => 'inside'),
}));
vi.mock('../src/goto.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/goto.ts')>()),
  launchInPane: vi.fn(),
}));

async function request(
  server: http.Server,
  method: string,
  pathname: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  try {
    // Loom's own page: its Origin and the launch token (the route table's browser guard).
    const page = { origin: `http://127.0.0.1:${address.port}`, 'x-loom-token': termToken() };
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method,
      headers: body === undefined ? page : { 'content-type': 'application/json', ...page },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

describe('outbox send protections', () => {
  it('refuses a send without the Loom Origin and token, before anything is posted', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    try {
      const r = await fetch(`http://127.0.0.1:${address.port}/api/outbox/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'd1', messages: ['hi'], after: 'close' }) });
      expect(r.status).toBe(403);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('archiveExcludeSessionIds', () => {
  it('does not exclude a Claude archive hit for a same-id Codex board chat', () => {
    expect(archiveExcludeSessionIds([
      { agent: 'codex', session_id: 'same-id' },
      { agent: 'claude', session_id: 'claude-board-id' },
    ])).toEqual(['claude-board-id']);
  });
});

describe('agent-selection routes', () => {
  it('rejects an invalid default agent', async () => {
    const response = await request(createServer(), 'PUT', '/api/settings/default-agent', { agent: 'other' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, detail: 'invalid agent' });
  });

  it('rejects an invalid selected agent for resume instead of treating it as Claude', async () => {
    const response = await request(createServer(), 'POST', '/resume?agent=other&session=nope&pane=%1');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, detail: 'invalid agent' });
  });

  it('accepts "ask every time" as a launch preference', async () => {
    const response = await request(createServer(), 'PUT', '/api/settings/default-agent', { agent: 'ask' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, defaultAgent: 'ask' });
  });

  // Send/close reach the pane helper for BOTH agents now; with no live Codex pane
  // in this environment they fail on the lookup, not on an agent gate.
  it('routes Codex sends to the pane helper instead of rejecting the agent', async () => {
    const response = await request(createServer(), 'POST', '/send?agent=codex&session=codex-session&text=hello');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ ok: false, detail: 'chat is not live — resume it first' });
  });

  it('routes Codex closes to the pane helper instead of rejecting the agent', async () => {
    const response = await request(createServer(), 'POST', '/close?agent=codex&session=codex-session');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ ok: false, detail: 'no live pane' });
  });
});

describe('pane group routes', () => {
  beforeEach(() => {
    vi.mocked(movePane).mockReset();
    vi.mocked(ungroupPane).mockReset();
  });

  it('moves a pane and returns the result', async () => {
    vi.mocked(movePane).mockReturnValue({ ok: true, pane_id: '%9', target: '%7', session: 'loom-tp-2', swappedWith: '%8', group: 'g-1' });
    const response = await request(createServer(), 'POST', '/api/panes/move', { pane: 'blue-vanilla', to: '%7' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, pane_id: '%9', target: '%7', session: 'loom-tp-2', swappedWith: '%8', group: 'g-1' });
    expect(vi.mocked(movePane).mock.calls[0].slice(0, 2)).toEqual(['blue-vanilla', '%7']);
  });

  it('rejects a move without both panes', async () => {
    const response = await request(createServer(), 'POST', '/api/panes/move', { pane: '%9' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, detail: 'pane and to are required' });
    expect(movePane).not.toHaveBeenCalled();
  });

  it('rejects a body that is not an object', async () => {
    const response = await request(createServer(), 'POST', '/api/panes/ungroup', 'not json{');

    expect(response.status).toBe(400);
    expect(ungroupPane).not.toHaveBeenCalled();
  });

  it('reports an unknown pane as 404 and a refused move as 409', async () => {
    vi.mocked(movePane).mockReturnValueOnce({ ok: false, detail: 'unknown pane: nope' });
    expect((await request(createServer(), 'POST', '/api/panes/move', { pane: 'nope', to: '%7' })).status).toBe(404);

    vi.mocked(movePane).mockReturnValueOnce({ ok: false, detail: 'cross-lane move refused (tp -> tp-forms)' });
    const refused = await request(createServer(), 'POST', '/api/panes/move', { pane: '%9', to: '%7' });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ ok: false, detail: 'cross-lane move refused (tp -> tp-forms)' });
  });

  it('ungroups a pane', async () => {
    vi.mocked(ungroupPane).mockReturnValue({ ok: true, pane_id: '%9' });
    const response = await request(createServer(), 'POST', '/api/panes/ungroup', { pane: '%9' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, pane_id: '%9' });
  });
});

describe('lane launch routes', () => {
  const shell = (pane_id: string, tmux_session: string, pane_index: string, extra: Partial<LanePane> = {}): LanePane => ({
    pane_id, tmux_session, window_index: '1', pane_index, command: 'zsh', name: '', group: '', agent: false, ...extra,
  });
  // An archive-style launch: unknown to the (empty test) DB, so it resolves via
  // proj, which only has to be an existing directory.
  const proj = encodeURIComponent(process.cwd());

  beforeEach(() => {
    vi.mocked(readWorld).mockReset();
    vi.mocked(launchInPane).mockReset();
  });

  it('lists each lane with room', async () => {
    vi.mocked(readWorld).mockReturnValue({
      focused: null,
      panes: [shell('%a', 'loom-tp-3', '0', { agent: true, command: '2.1.233' }), shell('%b', 'loom-tp-3', '1', { name: 'red-otter' })],
    });
    const response = await request(createServer(), 'GET', '/api/lanes');

    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ lane: 'tp', pane_id: '%b', where: 'loom-tp-3:1.1', name: 'red-otter' }]);
  });

  it('resumes into the lane\'s next open pane, resolved at request time', async () => {
    vi.mocked(readWorld).mockReturnValue({ focused: null, panes: [shell('%9', 'loom-tp-4', '2'), shell('%8', 'loom-tp-5', '0')] });
    vi.mocked(launchInPane).mockReturnValue({ ok: true, detail: 'launched' });
    const response = await request(createServer(), 'POST', `/resume?agent=claude&session=s1&lane=tp&proj=${proj}`);

    expect(response.status).toBe(200);
    expect(vi.mocked(launchInPane).mock.calls[0][0]).toEqual(expect.objectContaining({ paneId: '%9', fork: false }));
  });

  it('refuses a lane with no open pane', async () => {
    vi.mocked(readWorld).mockReturnValue({ focused: null, panes: [shell('%9', 'loom-tp-4', '0', { agent: true })] });
    const response = await request(createServer(), 'POST', `/branch?agent=claude&session=s1&lane=tp&proj=${proj}`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ ok: false, detail: 'no open pane in lane tp' });
    expect(launchInPane).not.toHaveBeenCalled();
  });

  it('needs a lane or a pane when lane sessions exist', async () => {
    vi.mocked(readWorld).mockReturnValue({ focused: null, panes: [shell('%9', 'loom-tp-4', '0')] });
    const response = await request(createServer(), 'POST', `/resume?agent=claude&session=s1&proj=${proj}`);

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, reason: 'no_pane', detail: 'no pane' });
    expect(launchInPane).not.toHaveBeenCalled();
    expect(acquireManagedPane).not.toHaveBeenCalled();
  });

  it('with an external terminal set, a managed resume is focused (switch-client) instead of left to Loom', async () => {
    vi.mocked(readWorld).mockReturnValue({ focused: null, panes: [shell('%1', 'loom-managed', '0')] });
    vi.mocked(acquireManagedPane).mockReset();
    vi.mocked(acquireManagedPane).mockReturnValue({ ok: true, paneId: '%78', name: 'red-otter', where: 'loom-managed · red-otter' });
    vi.mocked(launchInPane).mockReset();
    vi.mocked(launchInPane).mockReturnValue({ ok: true, detail: 'resumed' });
    vi.mocked(currentTerminal).mockReturnValueOnce('iterm2');
    const response = await request(createServer(), 'POST', `/resume?agent=claude&session=s1&proj=${proj}`);
    expect(response.status).toBe(200);
    expect(vi.mocked(launchInPane).mock.calls[0][0]).not.toHaveProperty('focus', false);
  });

  it('with no lane sessions at all, resumes into a managed window and does not focus Ghostty', async () => {
    vi.mocked(readWorld).mockReturnValue({ focused: null, panes: [shell('%1', 'loom-managed', '0')] });
    vi.mocked(acquireManagedPane).mockReset();
    vi.mocked(acquireManagedPane).mockReturnValue({ ok: true, paneId: '%77', name: 'red-otter', where: 'loom-managed · red-otter' });
    vi.mocked(launchInPane).mockReturnValue({ ok: true, detail: 'resumed' });
    const response = await request(createServer(), 'POST', `/resume?agent=claude&session=s1&proj=${proj}`);

    expect(response.status).toBe(200);
    expect(vi.mocked(acquireManagedPane).mock.calls[0][0]).toBe(process.cwd());
    expect(vi.mocked(launchInPane).mock.calls[0][0]).toEqual(expect.objectContaining({ paneId: '%77', focus: false }));
  });

  it('relays a managed-window refusal (the memory cap) as a 409 and launches nothing', async () => {
    vi.mocked(readWorld).mockReturnValue({ focused: null, panes: [] });
    vi.mocked(acquireManagedPane).mockReset();
    vi.mocked(acquireManagedPane).mockReturnValue({ ok: false, detail: 'Not starting a new chat: only 0.1 GB of memory is free' });
    const response = await request(createServer(), 'POST', `/branch?agent=claude&session=s1&proj=${proj}`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ ok: false, detail: 'Not starting a new chat: only 0.1 GB of memory is free' });
    expect(launchInPane).not.toHaveBeenCalled();
  });

  it('still launches into an explicit pane without reading lanes', async () => {
    vi.mocked(launchInPane).mockReturnValue({ ok: true, detail: 'launched' });
    const response = await request(createServer(), 'POST', `/resume?agent=claude&session=s1&pane=%2542&proj=${proj}`);

    expect(response.status).toBe(200);
    expect(vi.mocked(launchInPane).mock.calls[0][0]).toEqual(expect.objectContaining({ paneId: '%42' }));
    expect(readWorld).not.toHaveBeenCalled();
  });
});

describe('rename and remove-from-board routes', () => {
  // Routes open the throwaway manager.db (vitest.config points LOOM_HOME at one).
  async function seed(sessionId: string, saved = 0): Promise<void> {
    const parsed = await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl'));
    const db = openDb();
    upsertChat(db, { ...parsed, session_id: sessionId }, 1000, 5000);
    db.prepare(`UPDATE chats SET saved = ? WHERE session_id = ?`).run(saved, sessionId);
    db.close();
  }
  const titleOf = (sessionId: string): string | undefined => {
    const db = openDb();
    try {
      return toChatViews(db).find((v) => v.session_id === sessionId)?.title;
    } finally {
      db.close();
    }
  };
  const visible = (sessionId: string): boolean => {
    const db = openDb();
    try {
      return toChatViews(db).some((v) => v.session_id === sessionId);
    } finally {
      db.close();
    }
  };

  it('stores a title override that the board then shows', async () => {
    await seed('rename-1');
    const response = await request(createServer(), 'POST', '/api/rename', { session: 'rename-1', agent: 'claude', title: '  My title  ' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, title: 'My title' });
    expect(titleOf('rename-1')).toBe('My title');
  });

  it('clears the override when the title is empty', async () => {
    await seed('rename-2');
    await request(createServer(), 'POST', '/api/rename', { session: 'rename-2', agent: 'claude', title: 'Temp' });
    const response = await request(createServer(), 'POST', '/api/rename', { session: 'rename-2', agent: 'claude', title: '   ' });

    expect(response.body).toEqual({ ok: true, title: '' });
    expect(titleOf('rename-2')).not.toBe('Temp');
  });

  it('rejects a rename for an unknown session, a bad agent, or a body that is not JSON', async () => {
    expect((await request(createServer(), 'POST', '/api/rename', { session: 'nope', agent: 'claude', title: 'x' })).status).toBe(404);
    expect((await request(createServer(), 'POST', '/api/rename', { session: 'rename-1', agent: 'other', title: 'x' })).status).toBe(400);
    expect((await request(createServer(), 'POST', '/api/rename', 'not json{')).status).toBe(400);
  });

  it('removes a chat that is not running from the board', async () => {
    await seed('hide-1');
    expect(visible('hide-1')).toBe(true);
    const response = await request(createServer(), 'POST', '/api/hide', { session: 'hide-1', agent: 'claude' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true });
    expect(visible('hide-1')).toBe(false);
  });

  it('refuses to remove a saved chat, and 404s an unknown one', async () => {
    await seed('hide-2', 1);
    const saved = await request(createServer(), 'POST', '/api/hide', { session: 'hide-2', agent: 'claude' });
    expect(saved.status).toBe(409);
    expect(saved.body).toEqual({ ok: false, detail: 'chat is saved — unsave it first' });
    expect(visible('hide-2')).toBe(true);
    expect((await request(createServer(), 'POST', '/api/hide', { session: 'nope', agent: 'claude' })).status).toBe(404);
  });
});

describe('slack channel-project mapping routes', () => {
  it('sets, lists and clears a channel\'s project', async () => {
    const server = createServer();
    const put = await request(server, 'PUT', '/api/slack/channel-projects', { channel: 'C0TESTMAP1', project: process.cwd() });
    expect(put.status).toBe(200);
    expect((put.body as { projects: Record<string, string> }).projects.C0TESTMAP1).toBe(process.cwd());
    const list = await request(createServer(), 'GET', '/api/slack/channel-projects');
    expect((list.body as { projects: Record<string, string> }).projects.C0TESTMAP1).toBe(process.cwd());
    const del = await request(createServer(), 'PUT', '/api/slack/channel-projects', { channel: 'C0TESTMAP1', project: '' });
    expect((del.body as { projects: Record<string, string> }).projects.C0TESTMAP1).toBeUndefined();
  });

  it('rejects a bad channel id or a project that is not a directory', async () => {
    expect((await request(createServer(), 'PUT', '/api/slack/channel-projects', { channel: 'general', project: process.cwd() })).status).toBe(400);
    expect((await request(createServer(), 'PUT', '/api/slack/channel-projects', { channel: 'C1', project: '/definitely/not/here' })).status).toBe(400);
  });

  it('404s a banner action for a start it does not know', async () => {
    expect((await request(createServer(), 'POST', '/api/slack/start/dismiss', { key: 'C1/1.1', at: 1 })).status).toBe(404);
  });
});

describe('tag routes', () => {
  const j = (path: string, body: unknown, headers?: Record<string, string>) => requestWith(createServer(), 'POST', path, body, headers);
  // The write guard wants Loom's own origin and Host; build a request that has them.
  async function requestWith(server: http.Server, method: string, pathname: string, body?: unknown, headers: Record<string, string> = {}) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    try {
      const page = { origin: `http://127.0.0.1:${address.port}`, 'x-loom-token': termToken() };
      const r = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { method, headers: { 'content-type': 'application/json', ...page, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: r.status, body: (await r.json()) as Record<string, unknown> };
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  }
  async function seedChat(sid: string) {
    const parsed = await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl'));
    const db = openDb();
    upsertChat(db, { ...parsed, session_id: sid }, 1000, 5000);
    db.close();
  }

  it('lists tags without the write guard', async () => {
    const r = await requestWith(createServer(), 'GET', '/api/tags');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body.tags)).toBe(true);
  });

  it('creates, recolours, renames, assigns and deletes a tag end to end', async () => {
    await seedChat('tag-route-1');
    const made = await j('/api/tags', { name: 'route-tag' });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ ok: true, tag: { name: 'route-tag' } });
    expect((await j('/api/tags', { name: 'ROUTE-TAG' })).status).toBe(409);

    const recolored = await j('/api/tags/update', { name: 'route-tag', color: '#ff8086' });
    expect(recolored.body).toMatchObject({ ok: true, tag: { color: '#ff8086' } });
    expect((await j('/api/tags/update', { name: 'route-tag', color: 'pink' })).status).toBe(400);
    const renamed = await j('/api/tags/update', { name: 'route-tag', newName: 'route-tag-2' });
    expect(renamed.body).toMatchObject({ ok: true, tag: { name: 'route-tag-2' } });

    const set = await j('/api/chat-tags', { session: 'tag-route-1', agent: 'claude', tags: ['route-tag-2'] });
    expect(set.status).toBe(200);
    expect(set.body.tags).toEqual(['route-tag-2']);
    expect((set.body.tags_all as { name: string; count: number }[]).find((t) => t.name === 'route-tag-2')?.count).toBe(1);
    expect((await j('/api/chat-tags', { session: 'tag-route-1', agent: 'claude', tags: ['nope'] })).status).toBe(404);
    expect((await j('/api/chat-tags', { session: 'tag-route-1', agent: 'bad', tags: [] })).status).toBe(400);

    expect((await j('/api/tags/delete', { name: 'route-tag-2' })).status).toBe(200);
    expect((await j('/api/tags/delete', { name: 'route-tag-2' })).status).toBe(404);
  });

  it('refuses every write that lacks Loom\'s own origin', async () => {
    for (const p of ['/api/tags', '/api/tags/update', '/api/tags/delete', '/api/chat-tags']) {
      const r = await j(p, { name: 'x' }, { origin: 'https://evil.example' });
      expect(r.status, p).toBe(403);
    }
  });
});

