import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { getSetting, setSetting } from '../src/settingsSchema.ts';
import { memoryBackend, setKeychainBackend } from '../src/secrets.ts';
import {
  KEYCHAIN_SERVICE,
  RECONNECT,
  REFRESH_SERVICE,
  SlackError,
  authTest,
  configureToken,
  deleteToken,
  freshToken,
  scopesFor,
  slackRefreshData,
  slackToken,
  storeGrant,
  storeToken,
} from '../src/slackapi.ts';
import { buildSharedManifest } from '../src/slackmanifest.ts';
import { setServerPort } from '../src/serverport.ts';
import { STATE_TTL_MS, beginAuth, challengeFor, exchangeCode, outcomeOf, pkcePair, resetOAuthState, takeState } from '../src/slackoauth.ts';
import { makeSlackRoutes } from '../src/routes/slack.ts';
import type { RouteCtx, RouteDef } from '../src/routes/index.ts';
import type { ProbeReport } from '../src/probe.ts';

// No real Slack and no real Keychain: Slack is a fetch stub, the Keychain is the
// in-memory backend, the settings DB a temp file. Every token here is fake.
const CLIENT = '1111111111.2222222222';
const ACCESS = 'xoxe.xoxp-1-aaaaaaaaaaaa';
const ACCESS2 = 'xoxe.xoxp-1-bbbbbbbbbbbb';
const ACCESS3 = 'xoxe.xoxp-1-cccccccccccc';
const REFRESH = 'xoxe-1-rrrrrrrr1';
const REFRESH2 = 'xoxe-1-rrrrrrrr2';
const PASTED = 'xoxp-1111-2222-3333-abcdef0123456789';
const IDENTITY = { team_id: 'T1', team: 'Acme', user_id: 'U1', user: 'ada', url: 'https://acme.slack.com/' };

let kc: ReturnType<typeof memoryBackend>;
let reconnects: string[];

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/** A fetch stub that answers by method name, from a queue per method (the last answer repeats). */
function slackStub(answers: Record<string, unknown[]>) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: String(init.body ?? '') });
    const m = new URL(url).pathname.split('/').pop()!;
    const q = answers[m] ?? [{ ok: false, error: 'unknown_method' }];
    const body = q.length > 1 ? q.shift() : q[0];
    await new Promise((r) => setTimeout(r, 5));
    return { status: 200, headers: new Headers({ 'x-oauth-scopes': 'chat:write,users:read' }), json: async () => body } as Response;
  }) as unknown as typeof fetch;
  const calls = (m: string) => seen.filter((s) => s.url.endsWith('/' + m));
  return { fetchImpl, seen, calls };
}

const refreshItem = (account = 'default') => {
  const raw = kc.get(REFRESH_SERVICE, account);
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  delete process.env.SLACK_USER_TOKEN;
  kc = memoryBackend();
  setKeychainBackend(kc);
  reconnects = [];
  configureToken({ account: () => '', allowLegacy: () => false, reconnectNeeded: (r) => void reconnects.push(r) });
  resetOAuthState();
});
afterEach(() => {
  configureToken(null);
  setKeychainBackend(null);
});

describe('PKCE', () => {
  it('derives the S256 challenge from the RFC 7636 test vector', () => {
    expect(challengeFor('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('makes a 43-128 char base64url verifier, fresh each time, with its challenge', () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toBe(challengeFor(a.verifier));
  });

  it('builds the authorize URL with the challenge, S256, user scopes and the localhost redirect', () => {
    const { state, url } = beginAuth({ clientId: CLIENT, port: 4999, scopes: ['chat:write', 'users:read'], readonly: false });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(u.searchParams.get('client_id')).toBe(CLIENT);
    expect(u.searchParams.get('user_scope')).toBe('chat:write,users:read');
    expect(u.searchParams.get('scope')).toBeNull(); // no bot scopes
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:4999/slack/callback');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(state);
    const flow = takeState(state)!;
    expect(u.searchParams.get('code_challenge')).toBe(challengeFor(flow.verifier));
  });
});

describe('state', () => {
  it('is single use', () => {
    const { state } = beginAuth({ clientId: CLIENT, port: 4317, scopes: [], readonly: true });
    expect(outcomeOf(state)).toEqual({ state: 'pending' });
    expect(takeState(state)?.readonly).toBe(true);
    expect(takeState(state)).toBeNull();
    expect(takeState('never-issued')).toBeNull();
  });

  it('expires after 10 minutes', () => {
    const t0 = 1_000_000;
    const { state } = beginAuth({ clientId: CLIENT, port: 4317, scopes: [], readonly: false, now: t0 });
    expect(takeState(state, t0 + STATE_TTL_MS + 1)).toBeNull();
    const second = beginAuth({ clientId: CLIENT, port: 4317, scopes: [], readonly: false, now: t0 });
    expect(takeState(second.state, t0 + STATE_TTL_MS - 1)).not.toBeNull();
  });
});

describe('exchange', () => {
  it('posts code + verifier + redirect, form encoded, and never a client_secret', async () => {
    const s = slackStub({ 'oauth.v2.access': [{ ok: true, team: { id: 'T1' }, authed_user: { id: 'U1', access_token: ACCESS, refresh_token: REFRESH, expires_in: 43200, token_type: 'user' } }] });
    const g = await exchangeCode({ clientId: CLIENT, code: 'c0de', verifier: 'v'.repeat(43), redirectUri: 'http://localhost:4317/slack/callback', fetchImpl: s.fetchImpl });
    expect(g).toMatchObject({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 43200, team_id: 'T1', user_id: 'U1' });
    const req = s.seen[0];
    expect(req.method).toBe('POST');
    expect(req.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    expect(req.headers.Authorization).toBeUndefined();
    const p = new URLSearchParams(req.body);
    expect(p.get('client_id')).toBe(CLIENT);
    expect(p.get('code')).toBe('c0de');
    expect(p.get('code_verifier')).toBe('v'.repeat(43));
    expect(p.get('redirect_uri')).toBe('http://localhost:4317/slack/callback');
    expect(p.has('client_secret')).toBe(false);
    expect(req.body).not.toMatch(/secret/);
  });

  it('turns a Slack refusal into a SlackError naming the code', async () => {
    const s = slackStub({ 'oauth.v2.access': [{ ok: false, error: 'invalid_code' }] });
    await expect(exchangeCode({ clientId: CLIENT, code: 'x', verifier: 'v', redirectUri: 'r', fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: 'invalid_code' });
  });
});

describe('refresh', () => {
  const rotated = (tok: string, ref: string) => ({ ok: true, access_token: tok, refresh_token: ref, expires_in: 43200, token_type: 'user' });

  it('refreshes before a call when the token expires within 5 minutes, and persists the rotated refresh token', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 60 }, CLIENT);
    const s = slackStub({ 'oauth.v2.access': [rotated(ACCESS2, REFRESH2)], 'auth.test': [{ ok: true, team_id: 'T1', user_id: 'U1' }] });
    await authTest({ fetchImpl: s.fetchImpl });
    expect(s.calls('oauth.v2.access')).toHaveLength(1);
    const p = new URLSearchParams(s.calls('oauth.v2.access')[0].body);
    expect(Object.fromEntries(p)).toEqual({ grant_type: 'refresh_token', refresh_token: REFRESH, client_id: CLIENT });
    expect(s.calls('auth.test')[0].headers.Authorization).toBe('Bearer ' + ACCESS2);
    expect(slackToken()).toBe(ACCESS2);
    expect(refreshItem()).toMatchObject({ refresh_token: REFRESH2, client_id: CLIENT });
    expect(refreshItem().expires_at).toBeGreaterThan(Date.now() + 40_000_000);
  });

  it('does not refresh a token that is good for longer than 5 minutes', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }, CLIENT);
    const s = slackStub({ 'auth.test': [{ ok: true }] });
    await authTest({ fetchImpl: s.fetchImpl });
    expect(s.calls('oauth.v2.access')).toHaveLength(0);
    expect(s.calls('auth.test')[0].headers.Authorization).toBe('Bearer ' + ACCESS);
  });

  it('is single-flight: concurrent calls share one refresh', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 10 }, CLIENT);
    const s = slackStub({ 'oauth.v2.access': [rotated(ACCESS2, REFRESH2), rotated(ACCESS3, 'xoxe-1-wrong')] });
    const toks = await Promise.all([freshToken({ fetchImpl: s.fetchImpl }), freshToken({ fetchImpl: s.fetchImpl }), freshToken({ fetchImpl: s.fetchImpl })]);
    expect(toks).toEqual([ACCESS2, ACCESS2, ACCESS2]);
    expect(s.calls('oauth.v2.access')).toHaveLength(1);
    expect(refreshItem().refresh_token).toBe(REFRESH2);
  });

  it('a later refresh uses the rotated refresh token, not the first one', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 10 }, CLIENT);
    const s = slackStub({ 'oauth.v2.access': [{ ...rotated(ACCESS2, REFRESH2), expires_in: 10 }, rotated(ACCESS3, 'xoxe-1-third')] });
    await freshToken({ fetchImpl: s.fetchImpl });
    await freshToken({ fetchImpl: s.fetchImpl });
    const bodies = s.calls('oauth.v2.access').map((c) => new URLSearchParams(c.body).get('refresh_token'));
    expect(bodies).toEqual([REFRESH, REFRESH2]);
    expect(slackToken()).toBe(ACCESS3);
  });

  it('retries once after token_expired when a refresh token exists', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }, CLIENT);
    const s = slackStub({
      'auth.test': [{ ok: false, error: 'token_expired' }, { ok: true, team_id: 'T1' }],
      'oauth.v2.access': [rotated(ACCESS2, REFRESH2)],
    });
    const r = await authTest({ fetchImpl: s.fetchImpl });
    expect(r.identity.team_id).toBe('T1');
    expect(s.calls('auth.test').map((c) => c.headers.Authorization)).toEqual(['Bearer ' + ACCESS, 'Bearer ' + ACCESS2]);
    expect(s.calls('oauth.v2.access')).toHaveLength(1);
  });

  it('retries only once: a second token_expired is thrown', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }, CLIENT);
    const s = slackStub({ 'auth.test': [{ ok: false, error: 'token_expired' }], 'oauth.v2.access': [rotated(ACCESS2, REFRESH2)] });
    await expect(authTest({ fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: 'token_expired' });
    expect(s.calls('auth.test')).toHaveLength(2);
    expect(s.calls('oauth.v2.access')).toHaveLength(1);
  });

  it('a refused refresh clears the token and refresh data and reports a reconnect', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 10 }, CLIENT);
    const s = slackStub({ 'oauth.v2.access': [{ ok: false, error: 'invalid_refresh_token' }], 'auth.test': [{ ok: true }] });
    const err = await authTest({ fetchImpl: s.fetchImpl }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackError);
    expect(err.code).toBe(RECONNECT);
    expect(String(err.message)).not.toContain('xoxe');
    expect(reconnects).toEqual(['invalid_refresh_token']);
    expect(kc.get(KEYCHAIN_SERVICE, 'default')).toBeNull();
    expect(refreshItem()).toBeNull();
    expect(slackToken()).toBe('');
    expect(s.calls('auth.test')).toHaveLength(0);
  });

  it('a network failure during refresh clears nothing', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 10 }, CLIENT);
    const fetchImpl = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    await expect(freshToken({ fetchImpl })).rejects.toMatchObject({ code: expect.stringMatching(/^network/) });
    expect(slackToken()).toBe(ACCESS);
    expect(refreshItem()?.refresh_token).toBe(REFRESH);
    expect(reconnects).toEqual([]);
  });

  it('a pasted xoxp- token is never refreshed: token_expired is thrown after one call', async () => {
    storeToken(PASTED);
    expect(slackRefreshData()).toBeNull();
    const s = slackStub({ 'auth.test': [{ ok: false, error: 'token_expired' }], 'oauth.v2.access': [rotated(ACCESS2, REFRESH2)] });
    await expect(authTest({ fetchImpl: s.fetchImpl })).rejects.toMatchObject({ code: 'token_expired' });
    expect(s.calls('auth.test')).toHaveLength(1);
    expect(s.calls('oauth.v2.access')).toHaveLength(0);
    expect(slackToken()).toBe(PASTED);
  });

  it('pasting a token over an OAuth one drops the old refresh data', () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }, CLIENT);
    expect(slackRefreshData()).not.toBeNull();
    storeToken(PASTED);
    expect(slackRefreshData()).toBeNull();
    expect(refreshItem()).toBeNull();
  });

  it('a non-rotating grant (no expires_in, no refresh token) is stored as a plain token', async () => {
    storeGrant({ access_token: 'xoxp-1-plain' }, CLIENT);
    expect(slackRefreshData()).toBeNull();
    const s = slackStub({ 'auth.test': [{ ok: true }] });
    await authTest({ fetchImpl: s.fetchImpl });
    expect(s.calls('oauth.v2.access')).toHaveLength(0);
  });

  it('a refresh token with no expiry (expires_at 0) is only used after Slack says the token expired', async () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH }, CLIENT);
    expect(slackRefreshData()?.expires_at).toBe(0);
    const s = slackStub({ 'auth.test': [{ ok: true }] });
    await authTest({ fetchImpl: s.fetchImpl });
    expect(s.calls('oauth.v2.access')).toHaveLength(0);
  });

  it('Disconnect removes the token and the refresh data', () => {
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600 }, CLIENT);
    deleteToken();
    expect(kc.items.size).toBe(0);
  });
});

describe('shared-app manifest', () => {
  it('has PKCE, token rotation, the localhost redirect and user scopes only', () => {
    const m = buildSharedManifest({ port: 4317 });
    expect(m.oauth_config.pkce_enabled).toBe(true);
    // Every port Loom may fall back to, so the app is created once (src/serverport.ts).
    expect(m.oauth_config.redirect_urls).toEqual(Array.from({ length: 10 }, (_, i) => `http://localhost:${4317 + i}/slack/callback`));
    expect(m.oauth_config.scopes.user).toEqual(scopesFor());
    expect(Object.keys(m.oauth_config.scopes)).toEqual(['user']);
    expect(m.settings.token_rotation_enabled).toBe(true);
    expect(JSON.stringify(m)).not.toMatch(/bot_user|"bot"/);
  });
});

/* ------------------------------------------------------------------ routes */

describe('Connect Slack routes', () => {
  let dir: string;
  let dbPath: string;
  let authCalls: (string | undefined)[];
  let authImpl: (o?: { token?: string }) => Promise<{ identity: typeof IDENTITY; scopes: string[] }>;
  let exchangeImpl: (p: { code: string; verifier: string; redirectUri: string; clientId: string }) => Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-slackoauth-'));
    dbPath = path.join(dir, 'manager.db');
    configureToken({
      account: () => String((peek((db) => getSetting(db, 'slack_identity')) as { team_id?: string }).team_id ?? ''),
      allowLegacy: () => false,
      reconnectNeeded: (r) => void reconnects.push(r),
    });
    authCalls = [];
    authImpl = async (o) => {
      authCalls.push(o?.token);
      return { identity: IDENTITY, scopes: scopesFor() };
    };
    exchangeImpl = async () => ({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 43200 });
  });
  afterEach(() => {
    delete process.env.LOOM_SLACK_CLIENT_ID;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const peek = <T>(f: (db: Database.Database) => T): T => {
    const db = openDb(dbPath);
    try {
      return f(db);
    } finally {
      db.close();
    }
  };

  function routes(): Record<string, RouteDef> {
    const list = makeSlackRoutes({
      openDb: () => openDb(dbPath),
      authTest: ((o?: { token?: string }) => authImpl(o)) as never,
      probe: (async () => ({ slackMcp: { found: false }, slackApp: { found: false } }) as unknown as ProbeReport) as never,
      fullName: () => 'Ada Lovelace',
      exchange: ((p: Parameters<typeof exchangeImpl>[0]) => exchangeImpl(p)) as never,
    });
    return Object.fromEntries(list.map((r) => [`${r.method} ${r.path}`, r]));
  }

  async function hit(r: RouteDef, opts: { body?: unknown; query?: string; port?: number } = {}) {
    let out: { status: number; body: Record<string, unknown>; html?: string } | null = null;
    const res = {
      headersSent: false,
      writeHead(status: number) {
        out = { status, body: {} };
        this.headersSent = true;
      },
      end(html: string) {
        out!.html = html;
      },
    };
    const ctx = {
      req: { socket: { localPort: opts.port ?? 4317 } } as never,
      res: res as never,
      url: new URL('http://localhost:' + (opts.port ?? 4317) + r.path + (opts.query ?? '')),
      json: (status: number, body: unknown) => (out = { status, body: body as Record<string, unknown> }),
      body: async () => (opts.body ?? {}) as Record<string, unknown>,
    } as RouteCtx;
    await r.handler!(ctx);
    if (!out) throw new Error('handler sent no response');
    return out as { status: number; body: Record<string, unknown>; html?: string };
  }

  const start = async (port = 4317) => {
    peek((db) => setSetting(db, 'slack_client_id', CLIENT));
    const r = await hit(routes()['POST /api/slack/oauth/start'], { port });
    expect(r.status).toBe(200);
    return r.body as { url: string; state: string };
  };

  it('start refuses without a client id', async () => {
    const r = await hit(routes()['POST /api/slack/oauth/start']);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('no_client_id');
  });

  it('start takes the client id from LOOM_SLACK_CLIENT_ID, and the redirect from the port the request came in on', async () => {
    process.env.LOOM_SLACK_CLIENT_ID = '3333333333.4444444444';
    const r = await hit(routes()['POST /api/slack/oauth/start'], { port: 5123 });
    const u = new URL(String(r.body.url));
    expect(u.searchParams.get('client_id')).toBe('3333333333.4444444444');
    expect(u.searchParams.get('redirect_uri')).toBe('http://localhost:5123/slack/callback');
  });

  it('callback: exchanges, runs auth.test with the new token, stores token + refresh, sets direct', async () => {
    peek((db) => setSetting(db, 'slack_reconnect', 'invalid_refresh_token'));
    const { state } = await start();
    let seen: Parameters<typeof exchangeImpl>[0] | null = null;
    exchangeImpl = async (p) => {
      seen = p;
      return { access_token: ACCESS, refresh_token: REFRESH, expires_in: 43200 };
    };
    const r = await hit(routes()['GET /slack/callback'], { query: `?code=c0de&state=${state}` });
    expect(r.status).toBe(200);
    expect(r.html).toContain('Slack connected');
    expect(r.html).toContain('You can close this tab and return to Loom.');
    expect(r.html).not.toContain('xoxe');
    expect(seen!).toMatchObject({ clientId: CLIENT, code: 'c0de', redirectUri: 'http://localhost:4317/slack/callback' });
    expect(authCalls).toEqual([ACCESS]);
    expect(kc.get(KEYCHAIN_SERVICE, 'T1')).toBe(ACCESS);
    expect(refreshItem('T1')).toMatchObject({ refresh_token: REFRESH, client_id: CLIENT });
    expect(peek((db) => getSetting(db, 'slack_mode'))).toBe('direct');
    expect(peek((db) => getSetting(db, 'slack_reconnect'))).toBe('');
    expect(peek((db) => (getSetting(db, 'slack_identity') as { team_id?: string }).team_id)).toBe('T1');
    const st = await hit(routes()['GET /api/slack/status'], { query: `?oauth=${state}` });
    expect(st.body.oauth).toEqual({ state: 'ok' });
    expect(st.body.connected).toBe(true);
    // A second use of the same state is refused before any exchange.
    exchangeImpl = async () => {
      throw new Error('must not exchange');
    };
    const again = await hit(routes()['GET /slack/callback'], { query: `?code=c0de&state=${state}` });
    expect(again.status).toBe(400);
    expect(again.html).toContain('expired or was already used');
  });

  it('callback with error=access_denied stores nothing and reports it to the page', async () => {
    const { state } = await start();
    const r = await hit(routes()['GET /slack/callback'], { query: `?error=access_denied&state=${state}` });
    expect(r.status).toBe(400);
    expect(r.html).toContain('not approved');
    expect(kc.items.size).toBe(0);
    expect(authCalls).toEqual([]);
    const st = await hit(routes()['GET /api/slack/status'], { query: `?oauth=${state}` });
    expect(st.body.oauth).toMatchObject({ state: 'error', error: 'access_denied' });
    expect(peek((db) => getSetting(db, 'slack_mode'))).not.toBe('direct');
  });

  it('callback with an unknown state does not exchange', async () => {
    exchangeImpl = async () => {
      throw new Error('must not exchange');
    };
    const r = await hit(routes()['GET /slack/callback'], { query: '?code=c0de&state=forged' });
    expect(r.status).toBe(400);
    expect(kc.items.size).toBe(0);
  });

  it('callback stores nothing when auth.test fails on the new token', async () => {
    const { state } = await start();
    authImpl = async () => {
      throw new SlackError('auth.test', 'invalid_auth');
    };
    const r = await hit(routes()['GET /slack/callback'], { query: `?code=c0de&state=${state}` });
    expect(r.status).toBe(502);
    expect(kc.items.size).toBe(0);
  });

  it('status reports a lapsed connection as Reconnect', async () => {
    peek((db) => setSetting(db, 'slack_reconnect', 'invalid_refresh_token'));
    const st = await hit(routes()['GET /api/slack/status']);
    expect(st.body.connected).toBe(false);
    expect(st.body.reconnect).toBe('invalid_refresh_token');
    expect(String(st.body.reconnectHint)).toMatch(/Connect Slack again/);
  });

  it('the shared manifest route lists every port from the configured one, whatever port the request came in on', async () => {
    setServerPort(4400, 4400);
    try {
      const r = await hit(routes()['GET /api/slack/manifest'], { query: '?shared=1', port: 4403 });
      expect((r.body.manifest as { oauth_config: { redirect_urls: string[] } }).oauth_config.redirect_urls).toEqual(
        Array.from({ length: 10 }, (_, i) => `http://localhost:${4400 + i}/slack/callback`),
      );
    } finally {
      setServerPort(4317, 4317);
    }
  });

  it('the pasted-token route still works and clears a reconnect flag', async () => {
    peek((db) => setSetting(db, 'slack_reconnect', 'invalid_refresh_token'));
    const r = await hit(routes()['POST /api/slack/token'], { body: { token: PASTED } });
    expect(r.status).toBe(200);
    expect(kc.get(KEYCHAIN_SERVICE, 'T1')).toBe(PASTED);
    expect(kc.get(REFRESH_SERVICE, 'T1')).toBeNull();
    expect(peek((db) => getSetting(db, 'slack_reconnect'))).toBe('');
  });
});

describe('refresh across processes', () => {
  it('a refusal after another process already rotated the pair adopts its token instead of clearing', async () => {
    configureToken({ account: () => '', allowLegacy: () => false, reconnectNeeded: (r) => void reconnects.push(r) });
    storeGrant({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 10 }, CLIENT);
    const fetchImpl = (async () => {
      // The other process wins the race while this request is in flight.
      kc.set(KEYCHAIN_SERVICE, 'default', ACCESS3);
      kc.set(REFRESH_SERVICE, 'default', JSON.stringify({ refresh_token: 'xoxe-1-other', expires_at: Date.now() + 43_200_000, client_id: CLIENT }));
      return { status: 200, headers: new Headers(), json: async () => ({ ok: false, error: 'invalid_refresh_token' }) } as Response;
    }) as unknown as typeof fetch;
    expect(await freshToken({ fetchImpl })).toBe(ACCESS3);
    expect(reconnects).toEqual([]);
    expect(slackToken()).toBe(ACCESS3);
  });
});
