import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.ts';
import { termToken } from '../src/ptybridge.ts';
import { ROUTES, setTailnetHostSource } from '../src/routes/index.ts';
import { MOBILE_ROUTES, resetPairRate, setMobileDeps, type MobileChat, type MobileDeps } from '../src/mobile/api.ts';
import { DeviceStore, setDeviceStore } from '../src/mobile/devices.ts';
import { setTailscaleSetupDeps } from '../src/mobile/tailscale.ts';
import type { LiveLoc } from '../src/dashboard.ts';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import { chatGroupMap, createGroup, listGroups } from '../src/chatgroups.ts';
import type Database from 'better-sqlite3';

// The phone's door. Every /m/api route except the two pairing calls refuses a
// missing, revoked or forged device cookie; every phone write refuses a foreign
// Origin; and a request on the tailnet Host reaches /m/ and nothing else.
// Nothing here touches a real tmux pane: the mobile deps are fakes.

const TAILNET = 'mac.example-tailnet.ts.net';
let server: http.Server;
let port = 0;
let store: DeviceStore;
let tailOn = true;
const sent: { pane: string; text: string }[] = [];
const tmuxCalls: string[][] = [];
let paneCmd = '2.1.233';
const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-uploads-'));
const outboxCalls: { kind: string; arg: unknown }[] = [];
const closed: { pane: string; agent: string }[] = [];
let extraChats: MobileChat[] = [];
/** Panes whose capture shows Claude Code's spinner. */
const busyPanes = new Set(['%8']);
/** The group routes' db: in memory, never Loom's real one. Seeded in beforeAll. */
let gdb: Database.Database;
let gChat = { agent: 'claude', sid: '' };

const live = (over: Partial<LiveLoc> = {}): LiveLoc => ({ agent: 'claude', session_id: 's1', pane_id: '%7', tmux_session: 'loom-work', window_index: '1', pane_index: '0', running: true, working: false, name: 'blue-vanilla', stage: 'implementation', ...over });
const chat = (over: Partial<MobileChat> = {}): MobileChat => ({ agent: 'claude', session_id: 's1', title: 'Fix the widget', project: 'demo', state: 'waiting_on_user', jsonl_path: '/nonexistent.jsonl', last_active_at: 1000, last_turn_at: 1000, live: live(), ...over });

function fakeDeps(): Partial<MobileDeps> {
  return {
    chats: () => [
      chat(),
      chat({ session_id: 's2', state: 'working', live: live({ session_id: 's2', pane_id: '%8', working: true }) }),
      ...extraChats,
    ],
    tail: () => 'Should I ship it?',
    tmux: (args) => {
      tmuxCalls.push(args);
      if (args[0] === 'display-message') return paneCmd + '\n';
      if (args[0] === 'list-panes') return '%7\tShip the widget\n%8\t\n%9\tSomeone else\n';
      if (args[0] === 'capture-pane') return busyPanes.has(args[args.length - 1]) ? '⏺ Running the tests\n\n✻ Cogitating… (12s · ↓ 340 tokens · esc to interrupt)\n\n> \n' : '✻ Cooked for 9s · done 8:58 PM\n\n> \n';
      return '';
    },
    send: (pane, text) => {
      sent.push({ pane, text });
      return { ok: true, detail: 'sent' };
    },
    close: (pane, agent) => {
      closed.push({ pane, agent });
      return { ok: true, detail: 'sent Ctrl-C x2' };
    },
    drafts: () => [{ id: 'd1', session_id: 's1', channel: 'C0123', label: '#general', thread_ts: '1.2', messages: ['hello'], status: 'pending', created_at: '2026-01-01T10:00:00' }],
    outboxSend: async (b) => {
      outboxCalls.push({ kind: 'send', arg: b });
      return { status: 200, body: { ok: true } };
    },
    outboxDiscard: async (id) => {
      outboxCalls.push({ kind: 'discard', arg: id });
      return { status: 200, body: { ok: true } };
    },
    outboxRedraft: async (id) => {
      outboxCalls.push({ kind: 'redraft', arg: id });
      return { status: 200, body: { ok: true } };
    },
    uploadsDir: () => uploadsDir,
    withDb: (f) => f(gdb),
    tailscale: { exists: () => false, run: async () => ({ code: 1, stdout: '', stderr: 'no' }) },
  };
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mobile-'));
  store = new DeviceStore({ file: path.join(dir, 'devices.json') });
  setDeviceStore(store);
  setTailnetHostSource(() => (tailOn ? TAILNET : null));
  gdb = openDb(':memory:');
  const parsed = await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl'));
  upsertChat(gdb, parsed, 1000, 5000);
  gChat = { agent: parsed.agent, sid: parsed.session_id };
  server = createServer();
  setMobileDeps(fakeDeps());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const a = server.address();
  if (!a || typeof a === 'string') throw new Error('server did not bind');
  port = a.port;
});
afterAll(async () => {
  setTailnetHostSource(() => null);
  setDeviceStore(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  tailOn = true;
  paneCmd = '2.1.233';
  resetPairRate();
});

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  body: Record<string, unknown>;
}
function raw(method: string, p: string, headers: Record<string, string>, body?: string | Buffer): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => {
        let j: Record<string, unknown> = {};
        try {
          j = JSON.parse(s);
        } catch {
          /* html */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text: s, body: j });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const JSON_BODY = { 'content-type': 'application/json' };
const localOrigin = () => `http://127.0.0.1:${port}`;
const tail = { host: TAILNET, origin: `https://${TAILNET}` };
const desk = () => ({ ...JSON_BODY, origin: localOrigin(), 'x-loom-token': termToken() });

/** Pair a device end to end through the real routes; returns its cookie value. */
async function pairDevice(name = 'Test phone'): Promise<{ cookie: string; id: string }> {
  const start = await raw('POST', '/api/devices/pair-start', desk(), '{}');
  expect(start.status).toBe(200);
  const code = String(start.body.code);
  const req = await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, JSON.stringify({ code: code.toLowerCase(), name }));
  expect(req.status).toBe(200);
  const pending = String(req.body.pending_id);
  const claim = String(req.body.claim);
  const ok = await raw('POST', '/api/devices/approve', desk(), JSON.stringify({ id: pending }));
  expect(ok.status).toBe(200);
  const st = await raw('GET', `/m/api/pair/status?id=${pending}&claim=${encodeURIComponent(claim)}`, { host: TAILNET });
  expect(st.body.state).toBe('approved');
  const set = String(st.headers['set-cookie']?.[0] ?? '');
  const m = /^loom_device=([^;]+);/.exec(set);
  expect(m).not.toBeNull();
  const cookie = m![1];
  return { cookie, id: cookie.split('.')[0] };
}

import { shellEscapePath as shellEscapeForTest } from '../src/mobile/api.ts';

const deviceRoutes = MOBILE_ROUTES.filter((r) => r.kind === 'device');
const writes = MOBILE_ROUTES.filter((r) => r.method !== 'GET');

describe('the /m/api route table', () => {
  it('is all device or device-open, and only the two pairing calls are open', () => {
    expect(MOBILE_ROUTES.every((r) => r.kind === 'device' || r.kind === 'device-open')).toBe(true);
    expect(MOBILE_ROUTES.filter((r) => r.kind === 'device-open').map((r) => `${r.method} ${r.path}`).sort()).toEqual(['GET /m/api/pair/status', 'POST /m/api/pair']);
    expect(MOBILE_ROUTES.every((r) => r.path.startsWith('/m/api/'))).toBe(true);
  });

  it('never mixes with the desktop table', () => {
    expect(ROUTES.some((r) => r.path.startsWith('/m/') || r.kind === 'device' || r.kind === 'device-open')).toBe(false);
  });
});

describe('device cookie', () => {
  it('refuses every device route without a cookie (401), locally and on the tailnet', async () => {
    for (const r of deviceRoutes) {
      for (const h of [{ origin: localOrigin() }, tail]) {
        const out = await raw(r.method, r.path, { ...JSON_BODY, ...h }, '{}');
        expect([out.status, out.body.detail], `${r.method} ${r.path} ${h.origin}`).toEqual([401, 'not paired']);
      }
    }
  });

  it('refuses a forged cookie: a real device id with the wrong secret, a made-up id, junk', async () => {
    const { id } = await pairDevice('Forged test');
    const forged = [`${id}.${'A'.repeat(43)}`, `${'0'.repeat(16)}.${'A'.repeat(43)}`, 'junk', `${id}.`, `${id}`, `${id}.${'A'.repeat(43)}; loom_device=x`];
    for (const c of forged) {
      for (const r of deviceRoutes) {
        const out = await raw(r.method, r.path, { ...JSON_BODY, ...tail, cookie: `loom_device=${c}` }, '{}');
        expect(out.status, `${r.method} ${r.path} with ${c}`).toBe(401);
      }
    }
  });

  it('refuses a revoked cookie on every device route', async () => {
    const { cookie, id } = await pairDevice('Revoked test');
    expect((await raw('GET', '/m/api/me', { ...tail, cookie: `loom_device=${cookie}` })).status).toBe(200);
    expect((await raw('POST', '/api/devices/revoke', desk(), JSON.stringify({ id }))).status).toBe(200);
    for (const r of deviceRoutes) {
      const out = await raw(r.method, r.path, { ...JSON_BODY, ...tail, cookie: `loom_device=${cookie}` }, '{}');
      expect(out.status, `${r.method} ${r.path}`).toBe(401);
    }
  });

  it('stores only a hash of the secret, 0600', async () => {
    const { cookie } = await pairDevice('Hash test');
    const text = fs.readFileSync(store.file, 'utf8');
    expect(text).not.toContain(cookie.split('.')[1]);
    expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('sets the cookie HttpOnly, Secure, SameSite=Strict, Path=/m/, 400 days, and only once', async () => {
    const code = String((await raw('POST', '/api/devices/pair-start', desk(), '{}')).body.code);
    expect(((await raw('GET', '/api/devices', {})).body.pairing as { code: string }).code).toBe(code);
    const req = await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, JSON.stringify({ code, name: 'Once' }));
    const q = `/m/api/pair/status?id=${req.body.pending_id}&claim=${encodeURIComponent(String(req.body.claim))}`;
    expect((await raw('GET', q, { host: TAILNET })).body.state).toBe('pending');
    await raw('POST', '/api/devices/approve', desk(), JSON.stringify({ id: req.body.pending_id }));
    const first = await raw('GET', q, { host: TAILNET });
    const c = String(first.headers['set-cookie']?.[0]);
    for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/m/', `Max-Age=${400 * 24 * 3600}`]) expect(c).toContain(attr);
    const second = await raw('GET', q, { host: TAILNET });
    expect(second.body.state).toBe('expired');
    expect(second.headers['set-cookie']).toBeUndefined();
  });

  it('a wrong claim learns nothing and gets no cookie', async () => {
    await raw('POST', '/api/devices/pair-start', desk(), '{}');
    const code = ((await raw('GET', '/api/devices', {})).body.pairing as { code: string }).code;
    const req = await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, JSON.stringify({ code, name: 'Claim' }));
    await raw('POST', '/api/devices/approve', desk(), JSON.stringify({ id: req.body.pending_id }));
    const bad = await raw('GET', `/m/api/pair/status?id=${req.body.pending_id}&claim=${'x'.repeat(43)}`, { host: TAILNET });
    expect(bad.body.state).toBe('expired');
    expect(bad.headers['set-cookie']).toBeUndefined();
  });
});

describe('Origin on phone writes', () => {
  it('refuses every write from a foreign Origin or none, even with a valid cookie', async () => {
    const { cookie } = await pairDevice('Origin test');
    for (const r of writes) {
      for (const origin of ['https://evil.example', 'null', `http://${TAILNET}`, localOrigin(), undefined]) {
        const h: Record<string, string> = { ...JSON_BODY, host: TAILNET, cookie: `loom_device=${cookie}` };
        if (origin !== undefined) h.origin = origin;
        const out = await raw(r.method, r.path, h, '{}');
        expect([out.status, out.body.detail], `${r.method} ${r.path} from ${origin}`).toEqual([403, 'bad origin']);
      }
    }
  });

  it('locally, accepts only Loom\'s own origin', async () => {
    const { cookie } = await pairDevice('Local origin');
    const h = { ...JSON_BODY, cookie: `loom_device=${cookie}` };
    expect((await raw('PUT', '/m/api/prefs', { ...h, origin: `https://${TAILNET}` }, '{}')).status).toBe(403);
    expect((await raw('PUT', '/m/api/prefs', { ...h, origin: localOrigin() }, '{"quiet":true}')).status).toBe(200);
  });

  it('refuses a write to an unknown /m/ path', async () => {
    expect((await raw('POST', '/m/api/nope', { ...JSON_BODY, ...tail }, '{}')).status).toBe(405);
    expect((await raw('POST', '/m/api/nope', { ...JSON_BODY, host: TAILNET, origin: 'https://evil.example' }, '{}')).status).toBe(403);
    expect((await raw('POST', '/m/', { ...JSON_BODY, ...tail }, '{}')).status).toBe(405);
  });
});

describe('the tailnet Host reaches /m/ and nothing else', () => {
  it('refuses every desktop route, guarded or read, with or without the launch token', async () => {
    for (const r of ROUTES) {
      const out = await raw(r.method, r.path, { ...JSON_BODY, host: TAILNET, origin: `https://${TAILNET}`, 'x-loom-token': termToken() }, '{}');
      expect([out.status, out.body.detail], `${r.method} ${r.path}`).toEqual([403, 'bad host']);
    }
  });

  it('refuses the tokenless reads and every inline path server.ts answers', async () => {
    const src = ['server.ts', 'orchserver.ts'].map((f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8')).join('\n');
    const paths = new Set<string>(['/', '/api/data', '/api/live', '/api/transcript?session=s1', '/api/tails?keys=claude:s1', '/api/detail', '/api/devices', '/api/whoami', '/api/health', '/api/cli/outbox/x', '/vendor/xterm.js', '/m.evil', '/mobile']);
    for (const part of src.split("pathname === '").slice(1)) paths.add(part.slice(0, part.indexOf("'")));
    for (const p of paths) {
      if (!p.startsWith('/') || p.includes(' ')) continue;
      for (const host of [TAILNET, `${TAILNET}:443`, TAILNET.toUpperCase()]) {
        const out = await raw('GET', p, { host });
        expect(out.status, `GET ${p} on ${host}`).toBe(403);
      }
    }
  });

  it('serves /m/ on the tailnet Host with the security headers', async () => {
    const out = await raw('GET', '/m/', { host: TAILNET });
    expect(out.status).toBe(200);
    expect(out.headers['content-type']).toMatch(/text\/html/);
    expect(out.headers['content-security-policy']).toBe("default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; connect-src 'self'");
    expect(out.headers['x-frame-options']).toBe('DENY');
    expect(out.headers['referrer-policy']).toBe('no-referrer');
    expect(out.headers['cache-control']).toBe('no-store');
    const sw = await raw('GET', '/m/sw.js', { host: TAILNET });
    expect(sw.status).toBe(200);
    expect(sw.headers['service-worker-allowed']).toBe('/m/');
    expect((await raw('GET', '/m', { host: TAILNET })).status).toBe(301);
    expect((await raw('GET', '/m/nope.js', { host: TAILNET })).status).toBe(404);
    expect((await raw('GET', '/m/api/nope', { host: TAILNET })).status).toBe(404);
  });

  it('refuses even /m/ when Phone access is off, and any other Host', async () => {
    tailOn = false;
    expect((await raw('GET', '/m/', { host: TAILNET })).status).toBe(403);
    expect((await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, '{}')).status).toBe(403);
    tailOn = true;
    for (const host of ['evil.example', `other.example-tailnet.ts.net`, `${TAILNET}.evil.example`, `evil-${TAILNET}`, `${TAILNET}:8443`]) {
      expect((await raw('GET', '/m/', { host })).status, host).toBe(403);
    }
  });

  it('serves /m/ on Loom\'s own Host too', async () => {
    expect((await raw('GET', '/m/', {})).status).toBe(200);
    expect((await raw('GET', '/m/api/me', {})).status).toBe(401);
  });
});

describe('pairing', () => {
  it('burns the code after five wrong tries', async () => {
    const start = await raw('POST', '/api/devices/pair-start', desk(), '{}');
    for (let i = 0; i < 5; i++) {
      const out = await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, JSON.stringify({ code: 'AAAA-AAAA', name: 'x' }));
      expect(out.status).toBe(403);
    }
    const right = await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, JSON.stringify({ code: start.body.code, name: 'x' }));
    expect(right.status).toBe(400);
    expect((await raw('GET', '/api/devices', {})).body.pairing).toBeNull();
  });

  it('rate-limits pairing attempts', async () => {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, JSON.stringify({ code: 'x' }))).status;
    expect(last).toBe(429);
  });

  it('deny leaves no device and tells the phone', async () => {
    const before = store.devices().length;
    const start = await raw('POST', '/api/devices/pair-start', desk(), '{}');
    const req = await raw('POST', '/m/api/pair', { ...JSON_BODY, ...tail }, JSON.stringify({ code: start.body.code, name: 'Denied' }));
    const pending = ((await raw('GET', '/api/devices', {})).body.pending as { id: string; name: string }[]).find((p) => p.id === req.body.pending_id);
    expect(pending?.name).toBe('Denied');
    expect((await raw('POST', '/api/devices/deny', desk(), JSON.stringify({ id: req.body.pending_id }))).status).toBe(200);
    const st = await raw('GET', `/m/api/pair/status?id=${req.body.pending_id}&claim=${encodeURIComponent(String(req.body.claim))}`, { host: TAILNET });
    expect(st.body.state).toBe('denied');
    expect(st.headers['set-cookie']).toBeUndefined();
    expect(store.devices().length).toBe(before);
  });

  it('the desktop device routes refuse the phone\'s cookie in place of the launch token', async () => {
    const { cookie } = await pairDevice('No desktop');
    for (const p of ['/api/devices/pair-start', '/api/devices/approve', '/api/devices/revoke', '/api/devices/phone-access']) {
      const out = await raw('POST', p, { ...JSON_BODY, origin: localOrigin(), cookie: `loom_device=${cookie}` }, '{}');
      expect(out.status, p).toBe(403);
    }
  });
});

describe('what a paired phone can do', () => {
  let cookie = '';
  const ph = () => ({ ...JSON_BODY, ...tail, cookie: `loom_device=${cookie}` });
  beforeAll(async () => {
    cookie = (await pairDevice('Working phone')).cookie;
  });

  it('reads me, sessions and one session', async () => {
    const meR = await raw('GET', '/m/api/me', ph());
    expect(meR.body).toMatchObject({ device: { name: 'Working phone' }, tailnetHost: null });
    expect(typeof meR.body.version).toBe('string');
    const s = await raw('GET', '/m/api/sessions', ph());
    expect(s.status).toBe(200);
    expect(s.body.counts).toEqual({ working: 1, turn: 1, waiting: 0, saved: 0, recent: 0 });
    expect(s.body.outbox_pending).toBe(1);
    expect(s.body.version).toBe(meR.body.version);
    const secs = s.body.sections as { key: string; kind: string; sessions: { key: string; group: string; tail: string; pane: string; drafts: number }[] }[];
    expect(secs.map((x) => [x.key, x.kind, x.sessions.map((r) => r.group)])).toEqual([['stale', 'list', ['turn', 'working']]]);
    expect(secs[0].sessions[0]).toMatchObject({ key: 'claude:s1', group: 'turn', tail: 'Should I ship it?', pane: 'loom-work:1.0', drafts: 1 });
    const one = await raw('GET', '/m/api/session?key=claude:s1', ph());
    expect(one.body.can_reply).toBe(true);
    expect(one.body).toMatchObject({ start: 0 });
    expect(typeof one.body.total).toBe('number');
    expect((await raw('GET', '/m/api/session?key=claude:s1&from=0', ph())).body.start).toBe(0);
    expect((one.body.session as { drafts: number }).drafts).toBe(1);
    expect(one.body.live_status).toBeNull();
  });

  it('sends the live spinner line, and a busy pane reads as working before the board does', async () => {
    tmuxCalls.length = 0;
    const idle = (await raw('GET', '/m/api/session?key=claude:s1', ph())).body;
    expect(idle.live_status).toBeNull();
    expect((idle.session as { group: string }).group).toBe('turn');
    const working = (await raw('GET', '/m/api/session?key=claude:s2', ph())).body.live_status as { text: string; since: number };
    expect(working.text).toBe('Cogitating… 12s · 340 tokens');
    expect(Math.abs(Date.now() - 12_000 - working.since)).toBeLessThan(5_000);
    expect(tmuxCalls.filter((a) => a[0] === 'capture-pane')).toEqual([['capture-pane', '-p', '-t', '%7'], ['capture-pane', '-p', '-t', '%8']]);
    // s1 is still "your turn" on the board, but its pane shows the spinner (a reply just landed).
    busyPanes.add('%7');
    try {
      const b = (await raw('GET', '/m/api/session?key=claude:s1', ph())).body;
      expect((b.live_status as { text: string }).text).toBe('Cogitating… 12s · 340 tokens');
      expect(b.session).toMatchObject({ group: 'working', tail: '' });
    } finally {
      busyPanes.delete('%7');
    }
  });

  it('never captures a pane that is not running Claude', async () => {
    paneCmd = 'zsh';
    tmuxCalls.length = 0;
    try {
      expect((await raw('GET', '/m/api/session?key=claude:s1', ph())).body.live_status).toBeNull();
      expect(tmuxCalls.some((a) => a[0] === 'capture-pane')).toBe(false);
    } finally {
      paneCmd = '2.1.233';
    }
  });

  it('takes the topic from the pane\'s @topic with one list-panes call, falling back to the title', async () => {
    tmuxCalls.length = 0;
    const rows = ((await raw('GET', '/m/api/sessions', ph())).body.sections as { sessions: { key: string; topic: string }[] }[]).flatMap((x) => x.sessions);
    expect(rows.find((r) => r.key === 'claude:s1')?.topic).toBe('Ship the widget');
    expect(rows.find((r) => r.key === 'claude:s2')?.topic).toBe('Fix the widget');
    expect(tmuxCalls.filter((a) => a[0] === 'list-panes')).toEqual([['list-panes', '-a', '-F', '#{pane_id}\t#{@topic}']]);
    expect(tmuxCalls.length).toBe(1);
  });

  it('conversation mode reads the same live chats and panes (voice routes wired)', async () => {
    const t = await raw('GET', '/m/api/voice/turn?key=claude:s2', ph());
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ working: true, at_prompt: false, can_reply: true });
    paneCmd = 'zsh';
    expect((await raw('GET', '/m/api/voice/turn?key=claude:s1', ph())).body.can_reply).toBe(false);
    expect((await raw('GET', '/m/api/voice/turn?key=claude:gone', ph())).status).toBe(404);
    expect((await raw('GET', '/m/api/voice/turn?key=claude:s1', {})).status).toBe(401);
  });

  it('replies and interrupts only into a live pane running Claude', async () => {
    sent.length = 0;
    tmuxCalls.length = 0;
    expect((await raw('POST', '/m/api/reply', ph(), JSON.stringify({ key: 'claude:s1', text: 'yes, ship it' }))).status).toBe(200);
    expect(sent).toEqual([{ pane: '%7', text: 'yes, ship it' }]);
    expect((await raw('POST', '/m/api/interrupt', ph(), JSON.stringify({ key: 'claude:s1' }))).status).toBe(200);
    expect(tmuxCalls.at(-1)).toEqual(['send-keys', '-t', '%7', 'Escape']);
    expect((await raw('POST', '/m/api/reply', ph(), JSON.stringify({ key: 'claude:gone', text: 'x' }))).status).toBe(409);
    for (const cmd of ['zsh', 'nvim', 'node', '']) {
      paneCmd = cmd;
      sent.length = 0;
      expect((await raw('POST', '/m/api/reply', ph(), JSON.stringify({ key: 'claude:s1', text: 'rm -rf' }))).status, cmd).toBe(403);
      expect((await raw('POST', '/m/api/interrupt', ph(), JSON.stringify({ key: 'claude:s1' }))).status, cmd).toBe(403);
      expect(sent).toEqual([]);
    }
  });

  it('runs the desktop outbox actions, mapping ack_stale to post-anyway', async () => {
    outboxCalls.length = 0;
    const list = await raw('GET', '/m/api/outbox', ph());
    expect((list.body.drafts as unknown[])[0]).toMatchObject({ id: 'd1', kind: 'thread', where: '#general', from: 'blue-vanilla', messages: ['hello'], stale: false });
    await raw('POST', '/m/api/outbox/send', ph(), JSON.stringify({ id: 'd1', messages: ['hi'], after: 'park', ack_stale: true }));
    await raw('POST', '/m/api/outbox/discard', ph(), JSON.stringify({ id: 'd1' }));
    await raw('POST', '/m/api/outbox/redraft', ph(), JSON.stringify({ id: 'd1' }));
    expect(outboxCalls).toEqual([
      { kind: 'send', arg: { id: 'd1', messages: ['hi'], after: 'park', ack_stale: true, ack_fresh: true } },
      { kind: 'discard', arg: 'd1' },
      { kind: 'redraft', arg: 'd1' },
    ]);
  });

  it('folds the chat\'s own drafts into GET /m/api/session as outbox cards', async () => {
    const one = await raw('GET', '/m/api/session?key=claude:s1', ph());
    expect(one.body.drafts).toEqual([expect.objectContaining({ id: 'd1', kind: 'thread', where: '#general', from: 'blue-vanilla', messages: ['hello'], stale: false })]);
    const other = await raw('GET', '/m/api/session?key=claude:s2', ph());
    expect(other.body.drafts).toEqual([]);
    expect((other.body.session as { drafts: number }).drafts).toBe(0);
  });

  describe('close a chat', () => {
    beforeEach(() => {
      closed.length = 0;
      extraChats = [chat({ agent: 'codex', session_id: 'x1', live: live({ agent: 'codex', session_id: 'x1', pane_id: '%9' }) })];
    });
    afterAll(() => {
      extraChats = [];
    });

    it('refuses an unpaired phone and a foreign Origin', async () => {
      expect((await raw('POST', '/m/api/close', { ...JSON_BODY, ...tail }, JSON.stringify({ key: 'claude:s1' }))).status).toBe(401);
      expect((await raw('POST', '/m/api/close', { ...ph(), origin: 'https://evil.example' }, JSON.stringify({ key: 'claude:s1' }))).status).toBe(403);
      expect(closed).toEqual([]);
    });

    it('409 when the chat is not live, 403 when its pane is not running the agent', async () => {
      expect((await raw('POST', '/m/api/close', ph(), JSON.stringify({ key: 'claude:gone' }))).status).toBe(409);
      expect((await raw('POST', '/m/api/close', ph(), '{}')).status).toBe(409);
      for (const cmd of ['zsh', 'nvim', 'node', '']) {
        paneCmd = cmd;
        const r = await raw('POST', '/m/api/close', ph(), JSON.stringify({ key: 'claude:s1' }));
        expect([r.status, r.body.detail], cmd).toEqual([403, 'that pane is not running Claude or Codex']);
      }
      for (const cmd of ['2.1.233', 'zsh', 'claude']) {
        paneCmd = cmd;
        expect((await raw('POST', '/m/api/close', ph(), JSON.stringify({ key: 'codex:x1' }))).status, 'codex in ' + cmd).toBe(403);
      }
      expect(closed).toEqual([]);
    });

    it('closes through the desktop\'s closeSession with the chat\'s pane and agent', async () => {
      expect((await raw('POST', '/m/api/close', ph(), JSON.stringify({ key: 'claude:s1' }))).body).toEqual({ ok: true, detail: 'sent Ctrl-C x2' });
      for (const cmd of ['codex', 'node']) {
        paneCmd = cmd;
        expect((await raw('POST', '/m/api/close', ph(), JSON.stringify({ key: 'codex:x1' }))).status, cmd).toBe(200);
      }
      expect(closed).toEqual([{ pane: '%7', agent: 'claude' }, { pane: '%9', agent: 'codex' }, { pane: '%9', agent: 'codex' }]);
    });
  });

  it('narrows the outbox to one chat with ?session=, and refuses a malformed key', async () => {
    const ids = async (q: string) => ((await raw('GET', '/m/api/outbox' + q, ph())).body.drafts as { id: string }[]).map((d) => d.id);
    expect(await ids('?session=claude%3As1')).toEqual(['d1']);
    expect(await ids('?session=claude%3As2')).toEqual([]);
    expect(await ids('')).toEqual(['d1']);
    for (const bad of ['', 's1', 'claude%3A', 'claude%3As1%20x', '%3As1', 'claude%3A..%2Fx%2Fy']) {
      expect((await raw('GET', '/m/api/outbox?session=' + bad, ph())).status, bad).toBe(400);
    }
  });

  it('keeps prefs per device and validates push subscriptions', async () => {
    const p = await raw('PUT', '/m/api/prefs', ph(), JSON.stringify({ watcher: true, turn: false, bogus: true }));
    expect(p.body.prefs).toEqual({ turn: false, blocked: true, drafts: true, watcher: true, away: true, quiet: false });
    expect((await raw('GET', '/m/api/push/key', ph())).body.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
    const bad = { endpoint: 'https://evil.example/push', keys: { p256dh: 'B' + 'A'.repeat(86), auth: 'A'.repeat(22) } };
    expect((await raw('POST', '/m/api/push/subscribe', ph(), JSON.stringify({ subscription: bad }))).status).toBe(400);
  });

  it('lists devices with this marked, and can unpair itself', async () => {
    const own = await pairDevice('Self unpair');
    const h = { ...JSON_BODY, ...tail, cookie: `loom_device=${own.cookie}` };
    const list = (await raw('GET', '/m/api/devices', h)).body.devices as { id: string; this: boolean }[];
    expect(list.find((d) => d.this)?.id).toBe(own.id);
    const out = await raw('POST', '/m/api/devices/revoke', h, JSON.stringify({ id: own.id }));
    expect(out.status).toBe(200);
    expect(String(out.headers['set-cookie']?.[0])).toContain('Max-Age=0');
    expect((await raw('GET', '/m/api/me', h)).status).toBe(401);
  });

  describe('photo uploads', () => {
    const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 1)]);
    const imgHdr = () => ({ 'content-type': 'image/png', ...tail, cookie: `loom_device=${cookie}` });

    it('refuses an unpaired phone and a foreign Origin', async () => {
      expect((await raw('POST', '/m/api/image', { 'content-type': 'image/png', ...tail }, PNG)).status).toBe(401);
      expect((await raw('POST', '/m/api/image', { ...imgHdr(), origin: 'https://evil.example' }, PNG)).status).toBe(403);
    });

    it('saves an image by its magic bytes (0600) and returns only an id', async () => {
      const r = await raw('POST', '/m/api/image', imgHdr(), PNG);
      expect(r.status).toBe(200);
      const id = String(r.body.id);
      expect(id).toMatch(/^[0-9a-f]{32}$/);
      expect(Object.keys(r.body).sort()).toEqual(['id', 'ok']);
      const fp = path.join(uploadsDir, id + '.png');
      expect(fs.readFileSync(fp).equals(PNG)).toBe(true);
      expect(fs.statSync(fp).mode & 0o777).toBe(0o600);
    });

    it('refuses bytes that are not an image whatever the header says, and oversize bodies', async () => {
      const bad = await raw('POST', '/m/api/image', imgHdr(), Buffer.from('<html>not an image</html>'));
      expect(bad.status).toBe(415);
      const big = await raw('POST', '/m/api/image', imgHdr(), Buffer.concat([PNG, Buffer.alloc(12 * 1024 * 1024)])).catch(() => ({ status: 413 }));
      expect(big.status).toBe(413);
    });

    it('a reply with images types the escaped paths, then the text', async () => {
      const id = String((await raw('POST', '/m/api/image', imgHdr(), PNG)).body.id);
      sent.length = 0;
      const ok = await raw('POST', '/m/api/reply', ph(), JSON.stringify({ key: 'claude:s1', text: 'what is this?', images: [id] }));
      expect(ok.status).toBe(200);
      expect(sent).toEqual([{ pane: '%7', text: shellEscapeForTest(path.join(uploadsDir, id + '.png')) + ' what is this?' }]);
      sent.length = 0;
      expect((await raw('POST', '/m/api/reply', ph(), JSON.stringify({ key: 'claude:s1', text: '', images: [id] }))).status).toBe(200);
      expect(sent[0].text).toBe(shellEscapeForTest(path.join(uploadsDir, id + '.png')));
    });

    it('rejects unknown or path-like image ids and sends nothing', async () => {
      sent.length = 0;
      for (const images of [['0'.repeat(32)], ['../../etc/passwd'], [42], 'x']) {
        expect((await raw('POST', '/m/api/reply', ph(), JSON.stringify({ key: 'claude:s1', text: 'hi', images }))).status).toBe(400);
      }
      paneCmd = 'zsh';
      const id = String((await raw('POST', '/m/api/image', imgHdr(), PNG)).body.id);
      expect((await raw('POST', '/m/api/reply', ph(), JSON.stringify({ key: 'claude:s1', text: '', images: [id] }))).status).toBe(403);
      expect(sent).toEqual([]);
    });
  });
  it('GET /api/devices carries the setup checklist facts', async () => {
    setTailscaleSetupDeps({
      exists: () => true,
      run: async () => ({ code: 0, stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'example-mac.tail0000.ts.net.' }, CertDomains: ['example-mac.tail0000.ts.net'], Peer: { p: { OS: 'iOS', Online: false } } }), stderr: '' }),
    });
    try {
      const setup = (await raw('GET', '/api/devices', {})).body.setup as Record<string, unknown>;
      expect(setup).toMatchObject({ tailscaleInstalled: true, signedIn: true, magicDns: true, httpsCerts: true, iphone: 'offline', phoneAccess: false });
      expect(typeof setup.paired).toBe('boolean');
      expect(typeof setup.notifications).toBe('boolean');
    } finally {
      setTailscaleSetupDeps(null);
    }
  });

});

describe('phone group moves', () => {
  let cookie = '';
  const ph = () => ({ ...JSON_BODY, ...tail, cookie: `loom_device=${cookie}` });
  beforeAll(async () => {
    cookie = (await pairDevice('Group phone')).cookie;
  });

  it('refuses an unpaired phone and a foreign Origin', async () => {
    for (const p of ['/m/api/groups/move', '/m/api/groups/order']) {
      expect((await raw('POST', p, { ...JSON_BODY, ...tail }, '{}')).status, p).toBe(401);
      expect((await raw('POST', p, { ...ph(), origin: 'https://evil.example' }, '{}')).status, p).toBe(403);
    }
  });

  it('moves a chat into a group and back out through chatgroups.ts', async () => {
    const g = createGroup(gdb, 'Alpha') as { group: { id: number } };
    const key = `${gChat.agent}:${gChat.sid}`;
    const r = await raw('POST', '/m/api/groups/move', ph(), JSON.stringify({ key, group_id: g.group.id }));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, group: { id: g.group.id, name: 'Alpha' } });
    expect(chatGroupMap(gdb).get(key)).toMatchObject({ id: g.group.id });
    expect((r.body.groups as { name: string }[]).map((x) => x.name)).toContain('Alpha');
    expect((await raw('POST', '/m/api/groups/move', ph(), JSON.stringify({ key, group_id: null }))).body).toMatchObject({ ok: true, group: null });
    expect(chatGroupMap(gdb).has(key)).toBe(false);
  });

  it('refuses a bad key, an unknown group, an unknown chat and a non-integer group id', async () => {
    const key = `${gChat.agent}:${gChat.sid}`;
    expect((await raw('POST', '/m/api/groups/move', ph(), JSON.stringify({ key: 'nope', group_id: null }))).status).toBe(400);
    expect((await raw('POST', '/m/api/groups/move', ph(), JSON.stringify({ key: 'shell:abc', group_id: null }))).status).toBe(400);
    expect((await raw('POST', '/m/api/groups/move', ph(), JSON.stringify({ key, group_id: 'x' }))).status).toBe(400);
    expect((await raw('POST', '/m/api/groups/move', ph(), JSON.stringify({ key, group_id: 9999 }))).status).toBe(404);
    const g = listGroups(gdb)[0];
    expect((await raw('POST', '/m/api/groups/move', ph(), JSON.stringify({ key: 'claude:no-such-chat', group_id: g.id }))).status).toBe(404);
  });

  it('reorders the groups, and refuses a list that is not every group once', async () => {
    createGroup(gdb, 'Beta');
    const ids = listGroups(gdb).map((g) => g.id);
    const rev = ids.slice().reverse();
    const r = await raw('POST', '/m/api/groups/order', ph(), JSON.stringify({ ids: rev }));
    expect(r.status).toBe(200);
    expect(listGroups(gdb).map((g) => g.id)).toEqual(rev);
    expect((r.body.groups as { id: number }[]).map((g) => g.id)).toEqual(rev);
    expect((await raw('POST', '/m/api/groups/order', ph(), JSON.stringify({ ids: rev.slice(1) }))).status).toBe(400);
    expect((await raw('POST', '/m/api/groups/order', ph(), JSON.stringify({ ids: 'x' }))).status).toBe(400);
    expect(listGroups(gdb).map((g) => g.id)).toEqual(rev);
  });
});
