import type http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from '../src/server.ts';
import { ensureCliToken, readCliToken } from '../src/routes/index.ts';
import { setCliDeps, type CliDeps } from '../src/routes/cli.ts';

// POST /api/cli/focus and /api/cli/sessions through the real server and guard.
// tmux, the terminal and ~/.claude.json are all fakes.

let server: http.Server;
let port = 0;
let prev: CliDeps;
let calls: string[][] = [];
let sessions: Record<string, string> = {};
let focused: [string, string][] = [];
let attached: string[] = [];
let trusted: string[] = [];
let ghostty = false;
let clients = '';
let dirs = new Set<string>();

const fakeTmux = (a: string[]): string => {
  calls.push(a);
  const target = (a[a.indexOf('-t') + 1] ?? '').replace(/^=/, '');
  if (a[0] === 'has-session') {
    if (!(target in sessions)) throw new Error('no such session');
    return '';
  }
  if (a[0] === 'list-panes' && a.includes('-a')) return Object.entries(sessions).map(([s, p]) => `${p}\t${s}`).join('\n');
  if (a[0] === 'list-panes') {
    if (!(target in sessions)) throw new Error("can't find session");
    return `%98\t0\t1\n${sessions[target]}\t1\t1`;
  }
  if (a[0] === 'list-clients') return clients;
  if (a[0] === 'new-session') {
    sessions[a[a.indexOf('-s') + 1]] = '%23';
    return '%23\n';
  }
  if (a[0] === 'display-message') return 'blue-vanilla\n';
  return '';
};

beforeAll(async () => {
  ensureCliToken();
  server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
  prev = setCliDeps({
    tmux: fakeTmux,
    goto: (p, s) => {
      focused.push([p, s]);
      return { ok: true, detail: 'tmux ok' };
    },
    ghostty: () => ghostty,
    attachTab: (s) => {
      attached.push(s);
      return { ok: true, detail: 'attached' };
    },
    pretrust: (d) => void trusted.push(d),
    namePanes: () => {},
    dirExists: (d) => dirs.has(d),
  });
});
afterAll(async () => {
  setCliDeps(prev);
  await new Promise<void>((r) => server.close(() => r()));
});
beforeEach(() => {
  calls = [];
  sessions = { 'loom-demo-1': '%17' };
  focused = [];
  attached = [];
  trusted = [];
  ghostty = false;
  clients = '';
  dirs = new Set(['/work/demo']);
});

async function post(p: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'x-loom-cli-token': readCliToken(), 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as any };
}

const NEW = { name: 'loom-demo-2', cwd: '/work/demo', argv: ['claude', '--name', 'demo-2', 'do $(not) this; ok'] };

describe('POST /api/cli/focus', () => {
  it('focuses a session through its active pane', async () => {
    const r = await post('/api/cli/focus', { session: 'loom-demo-1' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, session: 'loom-demo-1', pane_id: '%17' } });
    expect(focused).toEqual([['%17', 'loom-demo-1']]);
    expect(attached).toEqual([]);
  });

  it('focuses by pane id, resolving the session', async () => {
    const r = await post('/api/cli/focus', { pane: '%17' });
    expect(r).toMatchObject({ status: 200, body: { session: 'loom-demo-1', pane_id: '%17' } });
  });

  it('attaches a Ghostty tab first when no client shows the session', async () => {
    ghostty = true;
    await post('/api/cli/focus', { session: 'loom-demo-1' });
    expect(attached).toEqual(['loom-demo-1']);
    attached = [];
    clients = 'loom-demo-1\n';
    await post('/api/cli/focus', { session: 'loom-demo-1' });
    expect(attached).toEqual([]);
  });

  it('404s for an unknown session or pane', async () => {
    expect(await post('/api/cli/focus', { session: 'loom-nope' })).toMatchObject({ status: 404, body: { ok: false, error: 'no-such-session' } });
    expect(await post('/api/cli/focus', { pane: '%99' })).toMatchObject({ status: 404, body: { ok: false, error: 'no-such-pane' } });
    expect(focused).toEqual([]);
  });

  it('400s unless exactly one of session/pane, and only loom- sessions', async () => {
    for (const b of [{}, { session: 'loom-demo-1', pane: '%17' }, { session: 'work' }, { pane: 'x' }, { session: 5 }]) {
      expect(await post('/api/cli/focus', b)).toMatchObject({ status: 400, body: { ok: false, error: 'bad-request' } });
    }
  });

  it('is guarded by the cli token', async () => {
    expect((await post('/api/cli/focus', { session: 'loom-demo-1' }, { 'x-loom-cli-token': 'x'.repeat(43) })).status).toBe(403);
  });
});

describe('POST /api/cli/sessions', () => {
  it('creates the session with argv passed after -- and no shell, names the pane, focuses', async () => {
    const r = await post('/api/cli/sessions', { ...NEW, env: { FOO: 'bar' }, trust: true, focus: true });
    expect(r).toMatchObject({ status: 201, body: { ok: true, session: 'loom-demo-2', pane_id: '%23', name: 'blue-vanilla', focused: true } });
    const ns = calls.find((c) => c[0] === 'new-session')!;
    expect(ns.slice(0, 6)).toEqual(['new-session', '-d', '-s', 'loom-demo-2', '-c', '/work/demo']);
    expect(ns).toContain('FOO=bar');
    expect(ns.slice(ns.indexOf('--'))).toEqual(['--', 'claude', '--name', 'demo-2', 'do $(not) this; ok']);
    expect(trusted).toEqual(['/work/demo']);
    expect(focused).toEqual([['%23', 'loom-demo-2']]);
  });

  it('does not trust or focus unless asked', async () => {
    const r = await post('/api/cli/sessions', NEW);
    expect(r.body.focused).toBe(false);
    expect(trusted).toEqual([]);
    expect(focused).toEqual([]);
  });

  it('409s on an existing name and touches nothing', async () => {
    const r = await post('/api/cli/sessions', { ...NEW, name: 'loom-demo-1', trust: true });
    expect(r).toMatchObject({ status: 409, body: { ok: false, error: 'duplicate' } });
    expect(calls.some((c) => c[0] === 'new-session')).toBe(false);
    expect(trusted).toEqual([]);
  });

  it('400s on bad input', async () => {
    const bads = [
      { ...NEW, name: 'tkt-1' },
      { ...NEW, name: 'loom-Bad' },
      { ...NEW, name: 'loom-' },
      { ...NEW, cwd: 'relative' },
      { ...NEW, cwd: '/missing' },
      { ...NEW, argv: [] },
      { ...NEW, argv: ['claude', 3] },
      { ...NEW, argv: 'claude' },
      { ...NEW, env: { 'BAD KEY': 'x' } },
      { ...NEW, env: { OK: 1 } },
    ];
    for (const b of bads) expect(await post('/api/cli/sessions', b)).toMatchObject({ status: 400, body: { ok: false, error: 'bad-request' } });
    expect(calls.some((c) => c[0] === 'new-session')).toBe(false);
  });

  it('500s with the tmux detail when new-session fails', async () => {
    const orig = setCliDeps({
      tmux: (a) => {
        if (a[0] === 'new-session') throw new Error('boom');
        return fakeTmux(a);
      },
    });
    const r = await post('/api/cli/sessions', NEW);
    setCliDeps({ tmux: orig.tmux });
    expect(r).toMatchObject({ status: 500, body: { ok: false, error: 'tmux', detail: 'boom' } });
  });
});
