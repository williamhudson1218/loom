import { describe, expect, it, vi, beforeEach } from 'vitest';
import type http from 'node:http';
import { archiveExcludeSessionIds, createServer } from '../src/server.ts';
import { movePane, ungroupPane, readWorld, type LanePane } from '../src/compact.ts';
import { launchInPane } from '../src/goto.ts';

// The pane routes swap real panes, so they are stubbed here: these tests pin the
// HTTP contract, and the move logic itself is covered in compact.test.ts against
// a fake tmux.
vi.mock('../src/compact.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/compact.ts')>()),
  movePane: vi.fn(),
  ungroupPane: vi.fn(),
  readWorld: vi.fn(),
}));
// Likewise launching types into a real pane; the lane routes stop at the call.
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
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

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

  it('sets a valid EM mode', async () => {
    const response = await request(createServer(), 'PUT', '/api/em/mode', { mode: 'off' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, mode: 'off' });
  });

  it('rejects an unknown EM mode rather than storing it', async () => {
    // getEmMode reads an unparseable stored value as 'off', so a bad write here
    // would silently disable the EM instead of erroring.
    const response = await request(createServer(), 'PUT', '/api/em/mode', { mode: 'on' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, detail: 'invalid mode' });
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

  it('needs a lane or a pane', async () => {
    const response = await request(createServer(), 'POST', `/resume?agent=claude&session=s1&proj=${proj}`);

    expect(response.status).toBe(400);
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
