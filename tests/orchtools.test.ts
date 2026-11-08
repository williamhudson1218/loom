import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { callOrchTool, type ChatInfo, type OrchToolDeps } from '../src/orchtools.ts';
import { ORCH_TOOLS } from '../src/orchdefs.ts';
import { handleMcpMessage, httpCaller, runMcpStdio, type ToolCaller, type ToolOutcome } from '../src/orchmcp.ts';

const T0 = 1_700_000_000_000;

const info = (over: Partial<ChatInfo> = {}): ChatInfo => ({
  chat: 'claude:s1', agent: 'claude', session_id: 's1', title: 'R03 retry', state: 'working', summary: 'retrying R03',
  project: 'acme-app', pane: 'blue-vanilla', tmux: 'loom-tp-2:1.1', stage: 'implementation',
  pr: 'https://github.com/o/r/pull/4231', slack: [], tags: [], last_active_at: T0, jsonl_path: '/x/s1.jsonl', ...over,
});

function deps(over: Partial<OrchToolDeps> = {}): OrchToolDeps & { db: Database.Database } {
  const db = openDb(':memory:');
  return {
    db,
    chats: () => [
      info(),
      info({ chat: 'claude:s2', session_id: 's2', title: 'old', state: 'not_running', pane: '', tmux: '', pr: '', last_active_at: T0 - 3_600_000 }),
      info({ chat: 'claude:s3', session_id: 's3', title: 'ancient', state: 'not_running', pane: '', tmux: '', pr: '', last_active_at: T0 - 48 * 3_600_000 }),
    ],
    tail: vi.fn(() => [{ role: 'user', text: 'go' }, { role: 'assistant', text: 'done' }]),
    gh: vi.fn(async () => JSON.stringify({
      number: 4231, title: 'R03 retry', url: 'https://github.com/o/r/pull/4231', state: 'OPEN', isDraft: false, reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      statusCheckRollup: [
        { name: 'Typecheck', status: 'COMPLETED', conclusion: 'SUCCESS' },
        { name: 'Integration Tests', status: 'COMPLETED', conclusion: 'FAILURE' },
        { name: 'Unit Tests', status: 'IN_PROGRESS', conclusion: '' },
      ],
    })),
    cachedPr: () => null,
    slackForChat: () => [{ key: 'C1/1.2', url: 'https://x.slack.com/archives/C1/p1000000002' }],
    slackOwner: (url) => (url.includes('C1') ? { key: 'C1/1.2', url, chat: 'claude:s1' } : null),
    relay: vi.fn(() => ({ status: 'sent' as const, detail: 'sent to blue-vanilla' })),
    withDb: (fn) => fn(db),
    notify: vi.fn(),
    now: () => T0,
    ...over,
  };
}

describe('Loom MCP tool handlers', () => {
  it('list_chats returns each chat\'s tags and filters on an optional tag (case-insensitive)', async () => {
    const d = deps({
      chats: () => [
        info({ tags: ['ach', 'urgent'] }),
        info({ chat: 'claude:s2', session_id: 's2', tags: ['forms'] }),
        info({ chat: 'claude:s3', session_id: 's3', tags: [] }),
      ],
    });
    const all = await callOrchTool(d, 'list_chats', {});
    const rows = all.ok ? (all.result as { chats: { chat: string; tags: string[] }[] }).chats : [];
    expect(rows.map((c) => [c.chat, c.tags])).toEqual([['claude:s1', ['ach', 'urgent']], ['claude:s2', ['forms']], ['claude:s3', []]]);
    const one = await callOrchTool(d, 'list_chats', { tag: 'ACH' });
    expect(one.ok && (one.result as { chats: { chat: string }[]; count: number }).chats.map((c) => c.chat)).toEqual(['claude:s1']);
    const none = await callOrchTool(d, 'list_chats', { tag: 'nope' });
    expect(none.ok && (none.result as { count: number }).count).toBe(0);
    expect(ORCH_TOOLS.find((t) => t.name === 'list_chats')?.inputSchema).toMatchObject({ properties: { tag: { type: 'string' } } });
  });

  it('list_chats leaves out stopped chats unless asked, and then only the last 24h, without internal fields', async () => {
    const d = deps();
    const a = await callOrchTool(d, 'list_chats', {});
    expect(a.ok && (a.result as { chats: { chat: string }[] }).chats.map((c) => c.chat)).toEqual(['claude:s1']);
    const b = await callOrchTool(d, 'list_chats', { include_stopped: true });
    const rows = b.ok ? (b.result as { chats: Record<string, unknown>[] }).chats : [];
    expect(rows.map((c) => c.chat)).toEqual(['claude:s1', 'claude:s2']);
    expect(rows[0]).not.toHaveProperty('jsonl_path');
    expect(rows[0]).toMatchObject({ pane: 'blue-vanilla', state: 'working', pr: 'https://github.com/o/r/pull/4231' });
  });

  it('chat_tail finds a chat by key or bare session id and clamps the turn count', async () => {
    const d = deps();
    expect(await callOrchTool(d, 'chat_tail', { chat: 's1', turns: 500 })).toMatchObject({ ok: true, result: { chat: 'claude:s1', messages: [{ role: 'user' }, { role: 'assistant' }] } });
    expect(vi.mocked(d.tail).mock.calls[0][1]).toBe(40);
    expect(await callOrchTool(d, 'chat_tail', { chat: 'nope' })).toMatchObject({ ok: false });
  });

  it('pr_status reads gh, from a URL or from a chat key, and summarises the checks', async () => {
    const d = deps();
    const r = await callOrchTool(d, 'pr_status', { pr: 'claude:s1' });
    expect(r).toMatchObject({ ok: true, result: { number: 4231, review: 'APPROVED', source: 'gh', checks: { state: 'red', failing: ['Integration Tests'], pending: 1, total: 3 } } });
    expect(vi.mocked(d.gh).mock.calls[0][0]).toEqual(['pr', 'view', 'https://github.com/o/r/pull/4231', '--json', expect.any(String)]);
    expect(await callOrchTool(d, 'pr_status', { pr: 'claude:s2' })).toMatchObject({ ok: false, error: 'chat claude:s2 has no PR' });
  });

  it('pr_status degrades without gh: the error, plus what Loom has cached', async () => {
    const d = deps({ gh: async () => { throw new Error('spawn gh ENOENT'); }, cachedPr: () => ({ steps: [] }) });
    expect(await callOrchTool(d, 'pr_status', { pr: 'https://github.com/o/r/pull/9' })).toMatchObject({
      ok: true, result: { source: 'loom-cache', gh_error: 'spawn gh ENOENT', cached: { steps: [] } },
    });
  });

  it('slack_thread answers both ways', async () => {
    const d = deps();
    expect(await callOrchTool(d, 'slack_thread', { chat: 'claude:s1' })).toMatchObject({ ok: true, result: { threads: [{ key: 'C1/1.2' }] } });
    expect(await callOrchTool(d, 'slack_thread', { url: 'https://x.slack.com/archives/C1/p1' })).toMatchObject({ ok: true, result: { owned: true, chat: 'claude:s1' } });
    expect(await callOrchTool(d, 'slack_thread', { url: 'https://x.slack.com/archives/C9/p1' })).toMatchObject({ ok: true, result: { owned: false } });
  });

  it('send_to_chat relays through the guard and passes a queued result through', async () => {
    const d = deps({ relay: vi.fn(() => ({ status: 'queued' as const, id: 3, detail: 'queued' })) });
    expect(await callOrchTool(d, 'send_to_chat', { chat: 'claude:s1', text: 'per company' })).toEqual({ ok: true, result: { status: 'queued', id: 3, detail: 'queued' } });
    expect(d.relay).toHaveBeenCalledWith('claude', 's1', 'per company');
    expect(await callOrchTool(d, 'send_to_chat', { chat: 'claude:s1', text: '' })).toMatchObject({ ok: false });
    const f = deps({ relay: () => ({ status: 'failed' as const, detail: 'not running' }) });
    expect(await callOrchTool(f, 'send_to_chat', { chat: 'claude:s1', text: 'x' })).toEqual({ ok: false, error: 'not running' });
  });

  it('upsert_item validates, writes, and notifies only when an item becomes needs_you', async () => {
    const d = deps();
    expect(await callOrchTool(d, 'upsert_item', { kind: 'urgent', title: 'x' })).toMatchObject({ ok: false });
    expect(await callOrchTool(d, 'upsert_item', { kind: 'moving', ref_type: 'wiki', title: 'x' })).toMatchObject({ ok: false });
    await callOrchTool(d, 'upsert_item', { kind: 'moving', ref_type: 'chat', ref_id: 'claude:s1', title: 'R03', who: 'blue-vanilla' });
    expect(d.notify).not.toHaveBeenCalled();
    const r = await callOrchTool(d, 'upsert_item', { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:s1', title: 'R03', why: 'which bank?' });
    expect(r).toMatchObject({ ok: true, result: { created: false, item: { kind: 'needs_you' } } });
    expect(d.notify).toHaveBeenCalledTimes(1);
    const list = await callOrchTool(d, 'list_items', {});
    expect(list.ok && (list.result as { items: unknown[] }).items).toHaveLength(1);
    const id = list.ok ? (list.result as { items: { id: number }[] }).items[0].id : 0;
    expect(await callOrchTool(d, 'resolve_item', { id })).toMatchObject({ ok: true });
    expect(await callOrchTool(d, 'resolve_item', { id })).toMatchObject({ ok: false });
    const done = await callOrchTool(d, 'list_items', { include_done: true });
    expect(done.ok && (done.result as { items: unknown[] }).items).toHaveLength(1);
  });

  it('refuses an unknown tool', async () => {
    expect(await callOrchTool(deps(), 'rm_rf', {})).toMatchObject({ ok: false });
  });

  it('every tool the MCP server lists has a handler', async () => {
    const d = deps();
    for (const t of ORCH_TOOLS) {
      const r = await callOrchTool(d, t.name, {});
      if (!r.ok) expect(r.error).not.toMatch(/unknown tool/);
    }
  });
});

describe('Loom MCP protocol', () => {
  const call: ToolCaller = vi.fn(async (name: string): Promise<ToolOutcome> => (name === 'list_items' ? { ok: true, result: { items: [] } } : { ok: false, error: 'boom' }));

  it('initializes with the tools capability and echoes the protocol version', async () => {
    const r = (await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, call)) as any;
    expect(r.result).toMatchObject({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'loom' } });
  });

  it('lists the tools and answers calls, marking failures isError', async () => {
    const l = (await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, call)) as any;
    expect(l.result.tools.map((t: { name: string }) => t.name)).toContain('send_to_chat');
    const ok = (await handleMcpMessage({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_items', arguments: {} } }, call)) as any;
    expect(JSON.parse(ok.result.content[0].text)).toEqual({ items: [] });
    expect(ok.result.isError).toBeUndefined();
    const bad = (await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'chat_tail', arguments: {} } }, call)) as any;
    expect(bad.result).toEqual({ content: [{ type: 'text', text: 'boom' }], isError: true });
    const unknown = (await handleMcpMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, call)) as any;
    expect(unknown.error.code).toBe(-32602);
  });

  it('stays silent on notifications and rejects unknown methods', async () => {
    expect(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, call)).toBeNull();
    expect(((await handleMcpMessage({ jsonrpc: '2.0', id: 6, method: 'resources/list' }, call)) as any).error.code).toBe(-32601);
  });

  it('runs over stdio: one JSON line in, one out, in order', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on('data', (c) => lines.push(...c.toString().split('\n').filter(Boolean)));
    const done = runMcpStdio(call, input, output);
    input.write('{"jsonrpc":"2.0","id":1,"method":"ping"}\n{"jsonrpc":"2.0","method":"notifications/initialized"}\nnot json\n');
    input.end('{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n');
    await done;
    expect(lines.map((l) => JSON.parse(l).id)).toEqual([null, 1, 2]);
  });

  it('forwards a call to Loom with the token from its file, re-read every call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-orch-tok-'));
    const tokenFile = path.join(dir, 'token');
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, result: { n: 1 } })));
    const caller = httpCaller({ port: 4999, tokenFile, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await caller('list_items', {})).toMatchObject({ ok: false, error: expect.stringContaining('token') });
    fs.writeFileSync(tokenFile, 'abc\n');
    expect(await caller('list_items', { include_done: true })).toEqual({ ok: true, result: { n: 1 } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:4999/api/orch/tool');
    expect((init.headers as Record<string, string>)['x-loom-orch-token']).toBe('abc');
    expect(JSON.parse(String(init.body))).toEqual({ name: 'list_items', args: { include_done: true } });
    const down = httpCaller({ port: 4999, tokenFile, fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch });
    expect(await down('list_items', {})).toMatchObject({ ok: false, error: expect.stringContaining('not reachable') });
  });
});
