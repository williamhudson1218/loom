import { describe, expect, it } from 'vitest';
import type http from 'node:http';
import { archiveExcludeSessionIds, createServer } from '../src/server.ts';

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

  it('rejects an invalid selected agent for resume instead of treating it as Claude', async () => {
    const response = await request(createServer(), 'POST', '/resume?agent=other&session=nope&pane=%1');

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, detail: 'invalid agent' });
  });

  it('rejects Codex sends before reaching the Claude pane helper', async () => {
    const response = await request(createServer(), 'POST', '/send?agent=codex&session=codex-session&text=hello');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ ok: false, detail: 'in-panel send is only supported for Claude' });
  });

  it('rejects Codex closes before reaching the Claude pane helper', async () => {
    const response = await request(createServer(), 'POST', '/close?agent=codex&session=codex-session');

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ ok: false, detail: 'in-panel close is only supported for Claude' });
  });
});
