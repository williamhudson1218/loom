import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer } from '../src/server.ts';
import { ensureCliToken, readCliToken } from '../src/routes/index.ts';
import { setCliDeps, tickPendingLinks, type CliDeps } from '../src/routes/cli.ts';
import { applySchema } from '../src/schema.ts';
import { addTestLink, ensureTestLinkColumns, listTestLinks, parseLinkKind, TEST_LINKS_MAX } from '../src/testlinks.ts';
import { clearHeld, heldCount, holdLinks, parseLinksInput, resolveHeldLinks, PENDING_LINKS_TTL_MS } from '../src/pendinglinks.ts';

const SID = '11111111-2222-3333-4444-555555555555';
const mem = () => {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
};

describe('link kind and migration', () => {
  it('parseLinkKind accepts home, link and absent only', () => {
    expect(parseLinkKind(undefined)).toBe('link');
    expect(parseLinkKind('link')).toBe('link');
    expect(parseLinkKind('home')).toBe('home');
    expect(parseLinkKind('HOME')).toBeNull();
    expect(parseLinkKind('other')).toBeNull();
    expect(parseLinkKind(3)).toBeNull();
  });

  it('adds the column to an old table; existing rows are ordinary links; it is idempotent', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE chat_test_links (session_id TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL DEFAULT '', added_at INTEGER NOT NULL, PRIMARY KEY (session_id, url))`);
    db.prepare(`INSERT INTO chat_test_links VALUES (?, ?, ?, ?)`).run(SID, 'http://localhost:1/a', 'old', 5);
    ensureTestLinkColumns(db);
    ensureTestLinkColumns(db);
    expect(listTestLinks(db, SID)).toEqual([{ url: 'http://localhost:1/a', label: 'old', added_at: 5, kind: 'link' }]);
  });

  it('applySchema on a fresh database has the column, default link', () => {
    const db = mem();
    addTestLink(db, SID, 'http://localhost:1/a', 'a', 1);
    expect(listTestLinks(db, SID)[0].kind).toBe('link');
  });

  it('home sorts first whatever its age, and survives the cap', () => {
    const db = mem();
    addTestLink(db, SID, 'https://example.com/home', 'Origin', 1, 'home');
    for (let i = 2; i <= 14; i++) addTestLink(db, SID, `http://localhost:1/p${i}`, `p${i}`, i);
    const l = listTestLinks(db, SID);
    expect(l).toHaveLength(TEST_LINKS_MAX);
    expect(l[0]).toMatchObject({ url: 'https://example.com/home', kind: 'home' });
    expect(l[1].url).toBe('http://localhost:1/p14');
  });

  it('re-adding a home URL as an ordinary link keeps it home', () => {
    const db = mem();
    addTestLink(db, SID, 'https://example.com/home', 'Origin', 1, 'home');
    addTestLink(db, SID, 'https://example.com/home', 'Again', 9);
    expect(listTestLinks(db, SID)[0]).toMatchObject({ label: 'Again', kind: 'home' });
  });
});

describe('parseLinksInput', () => {
  it('accepts none, and up to 10 valid links', () => {
    expect(parseLinksInput(undefined)).toEqual({ ok: true, links: [] });
    expect(parseLinksInput([])).toEqual({ ok: true, links: [] });
    const r = parseLinksInput([{ url: 'https://example.com/a', label: '  Ticket  42 ', kind: 'home' }, { url: 'http://localhost:3000/x' }]);
    expect(r).toEqual({
      ok: true,
      links: [
        { url: 'https://example.com/a', label: 'Ticket 42', kind: 'home' },
        { url: 'http://localhost:3000/x', label: '', kind: 'link' },
      ],
    });
    expect(parseLinksInput(Array.from({ length: 10 }, (_, i) => ({ url: `https://example.com/${i}` }))).ok).toBe(true);
  });
  it('rejects bad input', () => {
    const bads: unknown[] = [
      'x',
      {},
      Array.from({ length: 11 }, (_, i) => ({ url: `https://example.com/${i}` })),
      [null],
      ['https://example.com'],
      [{}],
      [{ url: 'javascript:alert(1)' }],
      [{ url: 'file:///etc/passwd' }],
      [{ url: 'https://example.com', label: 5 }],
      [{ url: 'https://example.com', label: 'x'.repeat(121) }],
      [{ url: 'https://example.com', kind: 'primary' }],
    ];
    for (const b of bads) expect(parseLinksInput(b).ok).toBe(false);
  });
});

describe('resolveHeldLinks', () => {
  beforeEach(() => clearHeld());
  const L = (u: string, kind: 'home' | 'link' = 'link') => ({ url: u, label: '', kind });

  it('attaches once a live chat is in the pane, in request order, and forgets the hold', () => {
    holdLinks('%5', [L('https://example.com/h', 'home'), L('https://example.com/t')], 1000);
    const got: [string, string, number][] = [];
    const attach = (sid: string, l: { url: string }, at: number) => void got.push([sid, l.url, at]);
    expect(resolveHeldLinks({ now: 2000, live: [{ session_id: 'other', pane_id: '%9' }], alivePanes: new Set(['%5', '%9']), attach })).toEqual({ attached: 0, expired: 0 });
    expect(heldCount()).toBe(1);
    expect(resolveHeldLinks({ now: 3000, live: [{ session_id: SID, pane_id: '%5' }], alivePanes: new Set(['%5']), attach })).toEqual({ attached: 1, expired: 0 });
    expect(got).toEqual([[SID, 'https://example.com/h', 3000], [SID, 'https://example.com/t', 2999]]);
    expect(heldCount()).toBe(0);
  });

  it('expires on timeout and when the pane died', () => {
    holdLinks('%5', [L('https://example.com/a')], 1000);
    holdLinks('%6', [L('https://example.com/b')], 1000);
    const attach = () => {
      throw new Error('must not attach');
    };
    expect(resolveHeldLinks({ now: 1000 + PENDING_LINKS_TTL_MS, live: [], alivePanes: new Set(['%5']), attach })).toEqual({ attached: 0, expired: 1 });
    expect(heldCount()).toBe(1);
    expect(resolveHeldLinks({ now: 1000 + PENDING_LINKS_TTL_MS + 1, live: [], alivePanes: null, attach })).toEqual({ attached: 0, expired: 1 });
    expect(heldCount()).toBe(0);
  });

  it('holds nothing for an empty list', () => {
    holdLinks('%5', [], 1);
    expect(heldCount()).toBe(0);
  });
});

describe('POST /api/cli/sessions links', () => {
  let server: http.Server;
  let port = 0;
  let prev: CliDeps;
  let dir: string;
  let dbFile: string;
  let live: { session_id: string; pane_id: string; cwd: string }[] = [];
  let panes = '';
  let tmuxCalls: string[][] = [];

  beforeAll(async () => {
    ensureCliToken();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pendinglinks-'));
    dbFile = path.join(dir, 'l.db');
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
    prev = setCliDeps({
      openDb: () => {
        const db = new Database(dbFile);
        applySchema(db);
        return db;
      },
      live: () => live,
      tmux: (a) => {
        tmuxCalls.push(a);
        if (a[0] === 'has-session') throw new Error('none');
        if (a[0] === 'new-session') return '%23\n';
        if (a[0] === 'list-panes' && a.includes('-a')) return panes;
        return '';
      },
      namePanes: () => {},
      dirExists: (d) => d === '/work/demo',
    });
  });
  afterAll(async () => {
    setCliDeps(prev);
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    clearHeld();
    fs.rmSync(dbFile, { force: true });
    live = [];
    panes = '%23\n';
    tmuxCalls = [];
  });

  const post = async (body: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/cli/sessions`, {
      method: 'POST',
      headers: { 'x-loom-cli-token': readCliToken(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: r.status, body: (await r.json()) as any };
  };
  const NEW = { name: 'loom-demo-2', cwd: '/work/demo', argv: ['claude'] };
  const links = () => {
    const db = new Database(dbFile);
    try {
      applySchema(db);
      return listTestLinks(db, SID);
    } finally {
      db.close();
    }
  };

  it('a request without links is unchanged and holds nothing', async () => {
    expect((await post(NEW)).status).toBe(201);
    expect(heldCount()).toBe(0);
  });

  it('400s on bad links before touching tmux', async () => {
    for (const bad of [[{ url: 'javascript:1' }], [{ url: 'https://example.com', kind: 'x' }], Array.from({ length: 11 }, () => ({ url: 'https://example.com/a' })), 'nope']) {
      expect(await post({ ...NEW, links: bad })).toMatchObject({ status: 400, body: { ok: false, error: 'bad-request' } });
    }
    expect(tmuxCalls.some((c) => c[0] === 'new-session')).toBe(false);
    expect(heldCount()).toBe(0);
  });

  it('holds the links, then attaches them to the chat once it is live (home first)', async () => {
    const r = await post({ ...NEW, links: [{ url: 'http://localhost:3000/orders', label: 'Orders' }, { url: 'https://example.com/ticket/7', label: 'Ticket 7', kind: 'home' }] });
    expect(r.status).toBe(201);
    expect(heldCount()).toBe(1);
    expect(tickPendingLinks()).toEqual({ attached: 0, expired: 0 });
    expect(links()).toEqual([]);
    live = [{ session_id: SID, pane_id: '%23', cwd: '/work/demo' }];
    expect(tickPendingLinks()).toEqual({ attached: 1, expired: 0 });
    expect(heldCount()).toBe(0);
    expect(links().map((l) => [l.url, l.kind])).toEqual([
      ['https://example.com/ticket/7', 'home'],
      ['http://localhost:3000/orders', 'link'],
    ]);
  });

  it('drops the hold when the pane dies or it times out, and leaks nothing', async () => {
    await post({ ...NEW, links: [{ url: 'https://example.com/a' }] });
    panes = '';
    expect(tickPendingLinks()).toEqual({ attached: 0, expired: 1 });
    expect(heldCount()).toBe(0);
    await post({ ...NEW, links: [{ url: 'https://example.com/a' }] });
    expect(tickPendingLinks(Date.now() + PENDING_LINKS_TTL_MS + 5)).toEqual({ attached: 0, expired: 1 });
    expect(links()).toEqual([]);
  });
});
