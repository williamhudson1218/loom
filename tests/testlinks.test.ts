import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { applyEvent, ingestEvents } from '../src/events.ts';
import { addTestLink, allTestLinks, cleanTestUrl, clearTestLinks, listTestLinks, TEST_LINKS_MAX, TEST_LINKS_VIEW_JS } from '../src/testlinks.ts';
import { createServer } from '../src/server.ts';
import { ensureCliToken, readCliToken } from '../src/routes/index.ts';
import { setCliDeps } from '../src/routes/cli.ts';
import { renderDashboard } from '../src/dashboard.ts';

const SID = '11111111-2222-3333-4444-555555555555';
const mem = () => {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
};

describe('test links store', () => {
  it('accepts http(s) only', () => {
    expect(cleanTestUrl('http://localhost:3000/a?b=1')).toBe('http://localhost:3000/a?b=1');
    expect(cleanTestUrl('https://example.com')).toBe('https://example.com/');
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x</b>', 'ftp://x/y', 'localhost:3000', '', 'not a url', 42, null]) expect(cleanTestUrl(bad)).toBeNull();
    const db = mem();
    expect(addTestLink(db, SID, 'javascript:alert(1)', 'x', 1).ok).toBe(false);
    expect(addTestLink(db, SID, 'file:///etc/hosts', 'x', 1).ok).toBe(false);
    expect(addTestLink(db, SID, 'data:text/html,hi', 'x', 1).ok).toBe(false);
    expect(listTestLinks(db, SID)).toEqual([]);
  });

  it('the same URL on the same chat updates label and time', () => {
    const db = mem();
    addTestLink(db, SID, 'http://localhost:3000/a', 'first', 10);
    addTestLink(db, SID, 'http://localhost:3000/b', 'other', 20);
    addTestLink(db, SID, 'http://localhost:3000/a', 'second', 30);
    expect(listTestLinks(db, SID)).toEqual([
      { url: 'http://localhost:3000/a', label: 'second', added_at: 30 },
      { url: 'http://localhost:3000/b', label: 'other', added_at: 20 },
    ]);
    addTestLink(db, 'other-chat', 'http://localhost:3000/a', 'x', 5);
    expect(listTestLinks(db, SID)).toHaveLength(2);
  });

  it('keeps the newest 10 per chat', () => {
    const db = mem();
    for (let i = 1; i <= 13; i++) addTestLink(db, SID, `http://localhost:3000/p${i}`, `l${i}`, i);
    addTestLink(db, 'other-chat', 'http://localhost:3000/z', 'z', 1);
    const l = listTestLinks(db, SID);
    expect(TEST_LINKS_MAX).toBe(10);
    expect(l).toHaveLength(10);
    expect(l[0].url).toBe('http://localhost:3000/p13');
    expect(l[9].url).toBe('http://localhost:3000/p4');
    expect(Object.keys(allTestLinks(db)).sort()).toEqual([SID, 'other-chat'].sort());
  });

  it('clear drops one URL or all', () => {
    const db = mem();
    addTestLink(db, SID, 'http://localhost:3000/a', 'a', 1);
    addTestLink(db, SID, 'http://localhost:3000/b', 'b', 2);
    clearTestLinks(db, SID, 'http://localhost:3000/a');
    expect(listTestLinks(db, SID).map((x) => x.label)).toEqual(['b']);
    clearTestLinks(db, SID);
    expect(listTestLinks(db, SID)).toEqual([]);
  });

  it('events apply and an unknown scheme is set aside as bad', () => {
    const db = mem();
    expect(applyEvent(db, { kind: 'testlinks.add', session: SID, url: 'http://localhost:1/x', label: 'x', at: 5 }).ok).toBe(true);
    expect(applyEvent(db, { kind: 'testlinks.add', session: SID, url: 'javascript:1', at: 6 }).ok).toBe(false);
    expect(applyEvent(db, { kind: 'testlinks.clear', session: SID, at: 7 }).ok).toBe(true);
    expect(listTestLinks(db, SID)).toEqual([]);
  });
});

describe('CLI round trip (python CLI -> event file -> ingest -> /api/cli/test-links -> /api/data)', () => {
  let server: http.Server;
  let port = 0;
  let home: string;
  let dbFile: string;
  const cli = (...args: string[]) =>
    spawnSync('python3', [path.join(__dirname, '..', 'plugin', 'loom', 'bin', 'loom'), ...args], {
      env: { ...process.env, LOOM_HOME: home, LOOM_PORT: '1', CLAUDE_CODE_SESSION_ID: SID },
      encoding: 'utf-8',
    });
  const ingest = () => {
    const db = new Database(dbFile);
    applySchema(db);
    const r = ingestEvents(db, { dir: path.join(home, 'events') });
    db.close();
    return r;
  };
  const call = async (p: string) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { headers: { 'x-loom-cli-token': readCliToken() } });
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeAll(async () => {
    ensureCliToken();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-testlinks-'));
    dbFile = path.join(home, 'tl.db');
    setCliDeps({
      openDb: () => {
        const db = new Database(dbFile);
        applySchema(db);
        return db;
      },
    });
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('add, dedupe, list over HTTP, reject bad schemes, clear', async () => {
    expect(cli('test-links', 'add', 'http://localhost:3000/orders/42', '--label', 'Order detail').status).toBe(0);
    expect(cli('test-links', 'add', 'http://localhost:3000/orders', '--label', 'Orders list').status).toBe(0);
    expect(cli('test-links', 'add', 'http://localhost:3000/orders/42', '--label', 'Order detail, refund row').status).toBe(0);
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x']) expect(cli('test-links', 'add', bad).status).toBe(2);
    expect(fs.readdirSync(path.join(home, 'events')).filter((n) => n.endsWith('.json'))).toHaveLength(3);
    expect(ingest().applied).toBe(3);

    const r = await call('/api/cli/test-links?session=' + SID);
    expect(r.status).toBe(200);
    expect(r.body.links.map((l: any) => [l.url, l.label])).toEqual([
      ['http://localhost:3000/orders/42', 'Order detail, refund row'],
      ['http://localhost:3000/orders', 'Orders list'],
    ]);
    expect((await call('/api/cli/test-links')).status).toBe(400);
    expect((await call('/api/cli/test-links?session=nobody')).body.links).toEqual([]);

    const data = await (await fetch(`http://127.0.0.1:${port}/api/data`, { headers: { host: 'localhost:4317' } })).json();
    expect(data.testLinks).toBeDefined();

    expect(cli('test-links', 'clear', 'http://localhost:3000/orders').status).toBe(0);
    expect(ingest().applied).toBe(1);
    expect((await call('/api/cli/test-links?session=' + SID)).body.links).toHaveLength(1);
    expect(cli('test-links', 'clear').status).toBe(0);
    ingest();
    expect((await call('/api/cli/test-links?session=' + SID)).body.links).toEqual([]);
  });

  it('caps at 10 through the CLI', async () => {
    for (let i = 1; i <= 12; i++) {
      expect(cli('test-links', 'add', `http://localhost:3000/p${i}`, '--label', `p${i}`).status).toBe(0);
      await new Promise((r) => setTimeout(r, 3));
    }
    ingest();
    const l = (await call('/api/cli/test-links?session=' + SID)).body.links;
    expect(l).toHaveLength(10);
  });
});

describe('board UI', () => {
  // Evaluate the page JS with stubs: the Test button exists only when the chat has links.
  const run = (testLinks: any, sid = 'a') => {
    const ctx: any = {
      DATA: { testLinks },
      mbtn: (act: string, label: string) => `<button data-act="${act}">${label}</button>`,
      esc: (s: string) => String(s),
      $: () => null,
      document: { querySelector: () => null, addEventListener() {} },
      window: { open() {}, addEventListener() {} },
      URL,
    };
    vm.createContext(ctx);
    vm.runInContext(TEST_LINKS_VIEW_JS, ctx);
    return vm.runInContext(`testHeadHtml({session_id:${JSON.stringify(sid)}})`, ctx) as string;
  };

  it('no button without links, "Test (N)" button with them', () => {
    expect(run({})).toBe('');
    expect(run({ b: [{ url: 'http://x/', label: '', added_at: 1 }] })).toBe('');
    const h = run({ a: [{ url: 'http://x/1', label: 'one', added_at: 1 }, { url: 'http://x/2', label: '', added_at: 2 }] });
    expect(h).toContain('data-act="testlinks"');
    expect(h).toContain('>2<');
  });

  it('page carries the popover, opens via window.open noopener, and parses', () => {
    const html = String(renderDashboard([], Date.now(), {}, 'claude'));
    expect(html).toContain('id="testpop"');
    expect(html).toContain("window.open(u,'_blank','noopener')");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1])).not.toThrow();
  });
});
