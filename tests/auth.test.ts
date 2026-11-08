import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createServer, loomWriteHeaders, withClientFetch } from '../src/server.ts';
import { termToken } from '../src/ptybridge.ts';
import { ensureOrchToken, orchDir } from '../src/orchsession.ts';
import { CORE_ROUTES, ROUTES, cliTokenPath, ensureCliToken, gate, legacyGetPaths, readCliToken, requireWrite, rotateCliToken, type RouteDef } from '../src/routes/index.ts';
import { clientFetchJs } from '../src/clientfetch.ts';

// The write guard (§13). Every request below that is refused is refused by the
// gate, before any handler runs, so none of them touches tmux, Slack or git.

let server: http.Server;
let port = 0;

beforeAll(async () => {
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('server did not bind');
  port = a.port;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Raw http.request, so Host and Origin are exactly what the test says. */
function raw(method: string, p: string, headers: Record<string, string>, body?: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    // agent: false — a fresh socket each time (Node's client mishandles a reused
    // socket after a DELETE with a body, which this sweep sends on purpose).
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let j: Record<string, unknown> = {};
        try {
          j = JSON.parse(s);
        } catch {
          /* html or text */
        }
        resolve({ status: res.statusCode ?? 0, body: j });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const own = () => `http://127.0.0.1:${port}`;
const goodHeaders = (r: RouteDef): Record<string, string> => {
  if (r.kind === 'browser') return { origin: own(), 'x-loom-token': termToken() };
  if (r.kind === 'cli') return { 'x-loom-cli-token': readCliToken() };
  if (r.kind === 'orch') return { 'x-loom-orch-token': ensureOrchToken(orchDir()) };
  return {};
};
const JSON_BODY = { 'content-type': 'application/json' };
const GUARD_REASONS = ['bad host', 'bad origin', 'bad token'];

describe('route table sweep', () => {
  const guarded = ROUTES.filter((r) => r.kind !== 'read');

  it('has every core write in it', () => {
    expect(CORE_ROUTES.length).toBeGreaterThanOrEqual(22);
    expect(guarded.length).toBe(ROUTES.filter((r) => r.kind !== 'read').length);
  });

  it('refuses every guarded route without its token', async () => {
    for (const r of guarded) {
      const h = goodHeaders(r);
      delete h['x-loom-token'];
      delete h['x-loom-cli-token'];
      delete h['x-loom-orch-token'];
      const out = await raw(r.method, r.path, { ...JSON_BODY, ...h }, '{}');
      expect(out.status, `${r.method} ${r.path}`).toBe(403);
      expect(GUARD_REASONS, `${r.method} ${r.path}`).toContain(out.body.detail);
    }
  });

  it('refuses every guarded route with a wrong token', async () => {
    for (const r of guarded) {
      const h = goodHeaders(r);
      for (const k of ['x-loom-token', 'x-loom-cli-token', 'x-loom-orch-token']) if (h[k]) h[k] = 'x'.repeat(h[k].length);
      const out = await raw(r.method, r.path, { ...JSON_BODY, ...h }, '{}');
      expect(out.status, `${r.method} ${r.path}`).toBe(403);
    }
  });

  it('refuses every guarded route from a foreign Origin, even with the token', async () => {
    for (const r of guarded) {
      const out = await raw(r.method, r.path, { ...JSON_BODY, ...goodHeaders(r), origin: 'https://evil.example' }, '{}');
      expect(out.status, `${r.method} ${r.path}`).toBe(403);
      expect(out.body.detail, `${r.method} ${r.path}`).toBe('bad origin');
    }
  });

  it('refuses every guarded route on a foreign Host (DNS rebinding), even with the token', async () => {
    for (const r of guarded) {
      const out = await raw(r.method, r.path, { ...JSON_BODY, ...goodHeaders(r), host: `evil.example:${port}` }, '{}');
      expect(out.status, `${r.method} ${r.path}`).toBe(403);
      expect(out.body.detail, `${r.method} ${r.path}`).toBe('bad host');
    }
  });

  it('refuses a write to a path that is not in the table at all', async () => {
    // Every path the server matches on, sent as a write with no credentials:
    // either a table row refuses it (403) or the default-deny does (405).
    const src = ['server.ts', 'orchserver.ts'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
    const paths = new Set<string>();
    for (const part of src.split("pathname === '").slice(1)) paths.add(part.slice(0, part.indexOf("'")));
    for (const part of src.split("p === '").slice(1)) paths.add(part.slice(0, part.indexOf("'")));
    const real = [...paths].filter((p) => p.startsWith('/') && !p.includes(' '));
    expect(real.length).toBeGreaterThan(40);
    for (const p of real) {
      for (const m of ['POST', 'PUT', 'DELETE', 'PATCH']) {
        const out = await raw(m, p, { ...JSON_BODY, origin: own() }, '{}');
        expect([403, 405], `${m} ${p}`).toContain(out.status);
      }
    }
  });

  it('refuses a GET on a path that only exists as a write', async () => {
    for (const p of ['/save?session=x', '/unsave?session=x', '/send?session=x&text=hi', '/close?session=x', '/goto?session=x', '/restore', '/api/trees/goto', '/api/outbox/send']) {
      const out = await raw('GET', p, { 'x-loom-token': termToken() });
      expect(out.status, p).toBe(405);
    }
  });

  it('still serves reads on Loom\'s own Host, and refuses them on any other', async () => {
    expect((await raw('GET', '/api/tags', {})).status).toBe(200);
    expect((await raw('GET', '/api/slack/channel-projects', {})).status).toBe(200);
    expect((await raw('GET', '/api/tags', { host: `localhost:${port}` })).status).toBe(200);
    expect((await raw('GET', '/api/tags', { host: `evil.example:${port}` })).status).toBe(403);
    expect((await raw('GET', '/api/live', { host: `evil.example:${port}` })).status).toBe(403);
  });

  it('lets the page\'s write through with either token header', async () => {
    // A known tag name is a 409 from the handler, which proves the gate let it in.
    const a = await raw('POST', '/api/tags', { ...JSON_BODY, origin: own(), 'x-loom-token': termToken() }, JSON.stringify({ name: 'auth-sweep' }));
    expect(a.status).toBe(200);
    const b = await raw('POST', '/api/tags', { ...JSON_BODY, origin: `http://localhost:${port}`, 'x-loom-term-token': termToken() }, JSON.stringify({ name: 'auth-sweep' }));
    expect(b.status).toBe(409);
    expect((await raw('POST', '/api/tags/delete', { ...JSON_BODY, origin: own(), 'x-loom-token': termToken() }, JSON.stringify({ name: 'auth-sweep' }))).status).toBe(200);
  });

  it('lets the Electron main process write with loomWriteHeaders()', async () => {
    const out = await raw('POST', '/api/slack/thread-goto', { ...JSON_BODY, ...loomWriteHeaders(port) }, JSON.stringify({ url: 'not a link' }));
    expect(out.status).toBe(404);
    expect(out.body.reason).toBe('not_slack');
  });
});

describe('requireWrite', () => {
  const fake = (headers: Record<string, string>, localPort = 4317) => ({ headers, socket: { localPort } }) as unknown as http.IncomingMessage;
  const host = { host: 'localhost:4317' };

  it('checks Host first for every kind', () => {
    for (const k of ['browser', 'cli', 'orch', 'read'] as const) {
      expect(requireWrite(fake({ host: 'localhost:9999' }), k)).toMatchObject({ ok: false, reason: 'bad host' });
    }
    expect(requireWrite(fake(host), 'read')).toEqual({ ok: true });
  });

  it('browser: Loom Origin and the launch token, nothing less', () => {
    const t = termToken();
    expect(requireWrite(fake({ ...host, origin: 'http://localhost:4317', 'x-loom-token': t }), 'browser')).toEqual({ ok: true });
    expect(requireWrite(fake({ ...host, origin: 'http://127.0.0.1:4317', 'x-loom-term-token': t }), 'browser')).toEqual({ ok: true });
    // The old isLoomWrite let a request with no Origin through; the guard does not.
    expect(requireWrite(fake({ ...host, 'x-loom-token': t }), 'browser')).toMatchObject({ ok: false, reason: 'bad origin' });
    expect(requireWrite(fake({ ...host, origin: 'http://localhost:9999', 'x-loom-token': t }), 'browser')).toMatchObject({ ok: false, reason: 'bad origin' });
    expect(requireWrite(fake({ ...host, origin: 'http://localhost:4317' }), 'browser')).toMatchObject({ ok: false, reason: 'bad token' });
  });

  it('cli: the cli-token file, and no browser Origin', () => {
    const t = ensureCliToken();
    expect(requireWrite(fake({ ...host, 'x-loom-cli-token': t }), 'cli')).toEqual({ ok: true });
    expect(requireWrite(fake({ ...host, 'x-loom-cli-token': t, origin: 'http://localhost:4317' }), 'cli')).toMatchObject({ ok: false, reason: 'bad origin' });
    expect(requireWrite(fake({ ...host, 'x-loom-cli-token': termToken() }), 'cli')).toMatchObject({ ok: false, reason: 'bad token' });
  });
});

describe('cli token file', () => {
  it('is created 0600, reused, and replaced by a rotation', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-cli-token-'));
    const a = ensureCliToken(dir);
    expect(a.length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(cliTokenPath(dir)).mode & 0o777).toBe(0o600);
    expect(ensureCliToken(dir)).toBe(a);
    fs.chmodSync(cliTokenPath(dir), 0o644);
    expect(ensureCliToken(dir)).toBe(a);
    expect(fs.statSync(cliTokenPath(dir)).mode & 0o777).toBe(0o600);
    const b = rotateCliToken(dir);
    expect(b).not.toBe(a);
    expect(readCliToken(dir)).toBe(b);
    expect(fs.statSync(cliTokenPath(dir)).mode & 0o777).toBe(0o600);
  });
});

describe('gate with module routes', () => {
  const fake = (method: string, headers: Record<string, string>) => ({ method, headers: { host: 'localhost:4317', ...headers }, socket: { localPort: 4317 } }) as unknown as http.IncomingMessage;
  const u = (p: string) => new URL(p, 'http://localhost');
  const routes: RouteDef[] = [
    { method: 'POST', path: '/api/wizard/step', kind: 'browser', handler: () => {} },
    { method: 'GET', path: '/api/wizard/state', kind: 'read', handler: () => {} },
    { method: 'GET', path: '/api/cli/status', kind: 'cli', handler: () => {} },
  ];

  it('returns the module row so the server can dispatch it, guard passed', () => {
    const r = gate(fake('POST', { origin: 'http://localhost:4317', 'x-loom-token': termToken() }), u('/api/wizard/step'), routes);
    expect(r).toMatchObject({ ok: true, route: { path: '/api/wizard/step' } });
    expect(gate(fake('POST', {}), u('/api/wizard/step'), routes)).toMatchObject({ ok: false, status: 403 });
    expect(gate(fake('GET', {}), u('/api/wizard/state'), routes)).toMatchObject({ ok: true, route: { path: '/api/wizard/state' } });
  });

  it('guards a cli GET too, and 405s a method a path does not have', () => {
    expect(gate(fake('GET', {}), u('/api/cli/status'), routes)).toMatchObject({ ok: false, status: 403 });
    expect(gate(fake('GET', { 'x-loom-cli-token': ensureCliToken() }), u('/api/cli/status'), routes)).toMatchObject({ ok: true });
    expect(gate(fake('PUT', { origin: 'http://localhost:4317', 'x-loom-token': termToken() }), u('/api/wizard/step'), routes)).toMatchObject({ ok: false, status: 405 });
    expect(gate(fake('GET', {}), u('/api/wizard/step'), routes)).toMatchObject({ ok: false, status: 405 });
  });
});

describe('client fetch helper', () => {
  function sandbox() {
    const calls: { input: unknown; init: { method?: string; headers?: Headers } | undefined }[] = [];
    const window: Record<string, unknown> = { fetch: (input: unknown, init?: { method?: string; headers?: Headers }) => (calls.push({ input, init }), Promise.resolve('ok')) };
    const ctx = vm.createContext({ window, location: { href: 'http://localhost:4317/', origin: 'http://localhost:4317' }, Headers, URL, Request, Object, String });
    vm.runInContext(clientFetchJs(legacyGetPaths()), ctx);
    vm.runInContext(`const TERM_TOKEN = 'tok123';`, ctx);
    return { calls, fetch: window.fetch as (i: unknown, o?: unknown) => Promise<unknown>, ctx };
  }

  it('adds the token to same-origin calls only', async () => {
    const s = sandbox();
    await s.fetch('/api/tags', { method: 'POST', headers: { 'content-type': 'application/json' } });
    await s.fetch('https://example.com/x');
    expect(s.calls[0].init?.headers?.get('x-loom-token')).toBe('tok123');
    expect(s.calls[0].init?.headers?.get('content-type')).toBe('application/json');
    expect(s.calls[0].init?.method).toBe('POST');
    expect(s.calls[1].init).toBeUndefined();
  });

  it('sends the page\'s old GET writes as POST, and leaves reads as GET', async () => {
    const s = sandbox();
    await s.fetch('/save?session=a&agent=claude');
    await s.fetch('/goto?session=a');
    await s.fetch('/api/data');
    expect(s.calls.map((c) => c.init?.method)).toEqual(['POST', 'POST', undefined]);
    expect(s.calls[2].init?.headers?.get('x-loom-token')).toBe('tok123');
  });

  it('wraps once, and has no backslashes for the page template', () => {
    const s = sandbox();
    vm.runInContext(clientFetchJs(legacyGetPaths()), s.ctx);
    void s.fetch('/api/data');
    expect(s.calls).toHaveLength(1);
    expect(clientFetchJs(legacyGetPaths())).not.toContain('\\');
  });

  it('is injected ahead of the dashboard script', async () => {
    expect(withClientFetch('<html><head></head><body><script>main()</script></body></html>')).toMatch(/<body><script>\(function\(\)\{[\s\S]*__loomFetch[\s\S]*<\/script><script>main\(\)/);
    const page = await new Promise<string>((resolve, reject) => {
      http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
        let s = '';
        res.on('data', (c) => (s += c));
        res.on('end', () => resolve(s));
      }).on('error', reject);
    });
    const at = page.indexOf('__loomFetch');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(page.indexOf('const TERM_TOKEN'));
  });
});
