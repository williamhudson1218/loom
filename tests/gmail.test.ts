import { setConnectRaiser } from '../src/connectreturn.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { getSetting, setSetting } from '../src/settingsSchema.ts';
import { memoryBackend, setKeychainBackend } from '../src/secrets.ts';
import { challengeFor } from '../src/slackoauth.ts';
import {
  GOOGLE_REFRESH_SERVICE,
  GOOGLE_TOKEN_URL,
  beginGoogleAuth,
  emailFromIdToken,
  googleAccessToken,
  googleOutcomeOf,
  listGoogleAccounts,
  missingScopes,
  resetGoogleOAuth,
  resolveGoogleAccount,
  saveGoogleAccount,
  storeGoogleRefresh,
  takeGoogleState,
} from '../src/googleoauth.ts';
import { GMAIL_API, buildMime, chooseEmailRoute, gmailAdapter, threadMessages } from '../src/gmailapi.ts';
import { AmbiguousSendError, cleanEmail, emailPayload } from '../src/outboxemail.ts';
import { makeGoogleRoutes } from '../src/routes/google.ts';
import { ROUTES, type RouteCtx, type RouteDef } from '../src/routes/index.ts';
import { connectionStates, type ConnInputs } from '../src/connections.ts';

// No real Google: every token and Gmail call goes to an injected fetch, the
// Keychain is the in-memory backend, and the settings DB is a temp file.
// All addresses are placeholders.

const CID = '1234-abc.apps.googleusercontent.com';
const SECRET = 'GOCSPX-test';
let dir: string;
let dbPath: string;
let kc: ReturnType<typeof memoryBackend>;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-gmail-'));
  dbPath = path.join(dir, 'manager.db');
  kc = memoryBackend();
  setKeychainBackend(kc);
  resetGoogleOAuth();
  delete process.env.LOOM_GOOGLE_CLIENT_ID;
  delete process.env.LOOM_GOOGLE_CLIENT_SECRET;
});
afterEach(() => {
  setKeychainBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const db = () => openDb(dbPath);
const idToken = (claims: Record<string, unknown>) => ['e30', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
const SCOPE = 'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/gmail.send https://www.googleapis.com/auth/gmail.metadata';

type Call = { url: string; init: RequestInit };
function stubFetch(handler: (url: string, init: RequestInit) => { status?: number; json?: unknown } | Promise<{ status?: number; json?: unknown }>) {
  const calls: Call[] = [];
  const f = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const r = await handler(String(url), init);
    return new Response(JSON.stringify(r.json ?? {}), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe('Connect Gmail: the authorize URL', () => {
  it('carries PKCE S256, the loopback redirect, offline access and the narrow scopes', () => {
    const { state, url } = beginGoogleAuth({ clientId: CID, clientSecret: SECRET, port: 4317, loginHint: 'alex@example.com' });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    const q = u.searchParams;
    expect(q.get('client_id')).toBe(CID);
    expect(q.get('redirect_uri')).toBe('http://127.0.0.1:4317/google/callback');
    expect(q.get('response_type')).toBe('code');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('access_type')).toBe('offline');
    expect(q.get('state')).toBe(state);
    expect(q.get('login_hint')).toBe('alex@example.com');
    expect(q.get('scope')!.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.metadata']);
    // The secret never goes in the browser URL.
    expect(url).not.toContain(SECRET);
    const flow = takeGoogleState(state)!;
    expect(q.get('code_challenge')).toBe(challengeFor(flow.verifier));
  });

  it('a state is claimable once and expires after ten minutes', () => {
    const a = beginGoogleAuth({ clientId: CID, clientSecret: SECRET, port: 4317, now: 1000 });
    expect(googleOutcomeOf(a.state, 1000)).toEqual({ state: 'pending' });
    expect(takeGoogleState(a.state, 2000)).not.toBeNull();
    expect(takeGoogleState(a.state, 2000)).toBeNull();
    const b = beginGoogleAuth({ clientId: CID, clientSecret: SECRET, port: 4317, now: 1000 });
    expect(takeGoogleState(b.state, 1000 + 10 * 60_000 + 1)).toBeNull();
    expect(takeGoogleState('made-up')).toBeNull();
  });

  it('reads the email from the id_token and spots unticked scopes', () => {
    expect(emailFromIdToken(idToken({ email: 'Alex@Example.com', email_verified: true }))).toBe('alex@example.com');
    expect(emailFromIdToken(idToken({ email: 'alex@example.com', email_verified: false }))).toBe('');
    expect(emailFromIdToken('garbage')).toBe('');
    expect(missingScopes(SCOPE)).toEqual([]);
    expect(missingScopes('openid email https://www.googleapis.com/auth/gmail.metadata')).toEqual(['gmail.send']);
  });
});

/* -------------------------------------------------------------- callback */

function ctxFor(url: string, body?: unknown) {
  const out: { status?: number; body?: Record<string, any>; html?: string } = {};
  const res = {
    headersSent: false,
    writeHead(code: number) {
      out.status = code;
    },
    end(html: string) {
      out.html = html;
    },
  };
  const ctx = {
    req: { socket: { localPort: 4317 } },
    res,
    url: new URL('http://127.0.0.1:4317' + url),
    json(code: number, b: unknown) {
      out.status = code;
      out.body = b as Record<string, any>;
    },
    body: async () => (body ?? {}) as Record<string, unknown>,
  } as unknown as RouteCtx;
  return { ctx, out };
}

function googleRoutes(exchange: Parameters<typeof makeGoogleRoutes>[0] extends infer _ ? any : never, revoked: string[] = []) {
  const list = makeGoogleRoutes({ openDb: db, exchange, revoke: async (e) => void revoked.push(e), cliExists: () => false });
  const by: Record<string, RouteDef> = Object.fromEntries(list.map((r) => [`${r.method} ${r.path}`, r]));
  return async (key: string, url: string, body?: unknown) => {
    const { ctx, out } = ctxFor(url, body);
    await by[key].handler!(ctx);
    return out;
  };
}

describe('Connect Gmail: routes', () => {
  it('are in the guarded route table; only the callback and status are reads', () => {
    const rows = ROUTES.filter((r) => r.path.includes('google')).map((r) => `${r.method} ${r.path} ${r.kind}`);
    expect(rows.sort()).toEqual(
      ['GET /api/google/status read', 'GET /google/callback read', 'POST /api/google/account browser', 'POST /api/google/disconnect browser', 'POST /api/google/oauth/start browser'].sort(),
    );
  });

  it('start needs a client id', async () => {
    const call = googleRoutes(async () => ({ access_token: 'x' }));
    expect((await call('POST /api/google/oauth/start', '/api/google/oauth/start')).body).toMatchObject({ error: 'no_client_id' });
  });

  it('the full flow stores the refresh token in the Keychain, the account in settings, and nothing secret anywhere else', async () => {
    const d = db();
    setSetting(d, 'google_client_id', CID);
    setSetting(d, 'google_client_secret', SECRET);
    d.close();
    const seen: Record<string, string>[] = [];
    const call = googleRoutes(async (p: Record<string, string>) => {
      seen.push(p);
      return { access_token: 'ya29.access', expires_in: 3599, refresh_token: '1//refresh', id_token: idToken({ email: 'alex@example.com', email_verified: true }), scope: SCOPE };
    });
    const start = await call('POST /api/google/oauth/start', '/api/google/oauth/start');
    expect(start.status).toBe(200);
    const state = start.body!.state as string;
    const raised: string[] = [];
    setConnectRaiser((k) => void raised.push(k));
    const cb = await call('GET /google/callback', `/google/callback?state=${state}&code=4/abc`);
    setConnectRaiser(null);
    expect(cb.status).toBe(200);
    expect(cb.html).toContain('Gmail connected as alex@example.com');
    expect(raised).toEqual(['google']);
    expect(seen[0]).toMatchObject({ clientId: CID, clientSecret: SECRET, code: '4/abc', redirectUri: 'http://127.0.0.1:4317/google/callback' });
    expect(JSON.parse(kc.get(GOOGLE_REFRESH_SERVICE, 'alex@example.com')!)).toEqual({ refresh_token: '1//refresh', client_id: CID, client_secret: SECRET });
    const d2 = db();
    expect(listGoogleAccounts(d2)).toEqual([{ email: 'alex@example.com', label: 'alex@example.com' }]);
    const rows = d2.prepare('SELECT value FROM settings').all() as { value: string }[];
    d2.close();
    expect(rows.some((r) => r.value.includes('1//refresh') || r.value.includes('ya29'))).toBe(false);
    const st = await call('GET /api/google/status', `/api/google/status?oauth=${state}`);
    expect(st.body).toMatchObject({ oauth: { state: 'ok', email: 'alex@example.com' }, route: 'gmail', hasSecret: true });
    expect(JSON.stringify(st.body)).not.toContain(SECRET);
    // The state is single-use: replaying the redirect is refused before any exchange.
    const replay = await call('GET /google/callback', `/google/callback?state=${state}&code=4/abc`);
    expect(replay.status).toBe(400);
    expect(seen.length).toBe(1);
  });

  it('refuses a denied consent, missing scopes, or a grant with no refresh token', async () => {
    const d = db();
    setSetting(d, 'google_client_id', CID);
    d.close();
    for (const [grant, q, code] of [
      [{}, '&error=access_denied', 'access_denied'],
      [{ access_token: 'a', refresh_token: 'r', id_token: idToken({ email: 'alex@example.com' }), scope: 'openid email' }, '&code=c', 'missing_scopes'],
      [{ access_token: 'a', id_token: idToken({ email: 'alex@example.com' }), scope: SCOPE }, '&code=c', 'no_refresh_token'],
    ] as const) {
      const call = googleRoutes(async () => grant);
      const st = (await call('POST /api/google/oauth/start', '/api/google/oauth/start')).body!.state;
      const cb = await call('GET /google/callback', `/google/callback?state=${st}${q}`);
      expect(cb.status).not.toBe(200);
      expect((await call('GET /api/google/status', `/api/google/status?oauth=${st}`)).body!.oauth).toMatchObject({ state: 'error', error: code });
    }
    const d2 = db();
    expect(listGoogleAccounts(d2)).toEqual([]);
    d2.close();
  });

  it('labels, default and disconnect per account', async () => {
    const d = db();
    saveGoogleAccount(d, { email: 'alex@example.com' });
    saveGoogleAccount(d, { email: 'alex@work.example.com' });
    d.close();
    storeGoogleRefresh('alex@work.example.com', { refresh_token: 'r', client_id: CID, client_secret: '' });
    const revoked: string[] = [];
    const call = googleRoutes(async () => ({}), revoked);
    expect((await call('POST /api/google/account', '/api/google/account', { email: 'alex@work.example.com', label: 'work', default: true })).body!.accounts).toEqual([
      expect.objectContaining({ email: 'alex@work.example.com', label: 'work', isDefault: true }),
      expect.objectContaining({ email: 'alex@example.com', isDefault: false }),
    ]);
    expect((await call('POST /api/google/account', '/api/google/account', { email: 'alex@example.com', label: 'work' })).body).toMatchObject({ error: 'label_in_use' });
    expect((await call('POST /api/google/account', '/api/google/account', { email: 'alex@example.com', label: 'has space' })).body).toMatchObject({ error: 'bad_label' });
    const out = await call('POST /api/google/disconnect', '/api/google/disconnect', { email: 'alex@work.example.com' });
    expect(out.body!.accounts.map((a: { email: string }) => a.email)).toEqual(['alex@example.com']);
    expect(revoked).toEqual(['alex@work.example.com']);
    expect(kc.get(GOOGLE_REFRESH_SERVICE, 'alex@work.example.com')).toBeNull();
    expect((await call('POST /api/google/disconnect', '/api/google/disconnect', { email: 'nobody@example.com' })).status).toBe(404);
  });
});

/* -------------------------------------------------------------- tokens */

describe('Gmail tokens', () => {
  it('refreshes once for concurrent callers and caches the result', async () => {
    storeGoogleRefresh('alex@example.com', { refresh_token: '1//r1', client_id: CID, client_secret: SECRET });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { f, calls } = stubFetch(async () => {
      await gate;
      return { json: { access_token: 'ya29.new', expires_in: 3600 } };
    });
    const a = googleAccessToken('alex@example.com', { fetchImpl: f });
    const b = googleAccessToken('alex@example.com', { fetchImpl: f });
    release();
    expect(await a).toBe('ya29.new');
    expect(await b).toBe('ya29.new');
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(GOOGLE_TOKEN_URL);
    const body = new URLSearchParams(String(calls[0].init.body));
    expect(Object.fromEntries(body)).toEqual({ client_id: CID, client_secret: SECRET, refresh_token: '1//r1', grant_type: 'refresh_token' });
    expect(await googleAccessToken('alex@example.com', { fetchImpl: f })).toBe('ya29.new');
    expect(calls.length).toBe(1);
    await googleAccessToken('alex@example.com', { fetchImpl: f, force: true });
    expect(calls.length).toBe(2);
  });

  it('a refused refresh asks for a reconnect; a network failure does not', async () => {
    storeGoogleRefresh('alex@example.com', { refresh_token: '1//r1', client_id: CID, client_secret: SECRET });
    const marks: string[] = [];
    const net = (async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;
    await expect(googleAccessToken('alex@example.com', { fetchImpl: net, onReconnect: (_e, r) => marks.push(r) })).rejects.toThrow('network');
    expect(marks).toEqual([]);
    const { f } = stubFetch(() => ({ status: 400, json: { error: 'invalid_grant' } }));
    await expect(googleAccessToken('alex@example.com', { fetchImpl: f, onReconnect: (_e, r) => marks.push(r) })).rejects.toThrow('reconnect_gmail');
    expect(marks).toEqual(['invalid_grant']);
  });

  it('keeps a rotated refresh token', async () => {
    storeGoogleRefresh('alex@example.com', { refresh_token: '1//old', client_id: CID, client_secret: SECRET });
    const { f } = stubFetch(() => ({ json: { access_token: 'ya29.x', expires_in: 3600, refresh_token: '1//new' } }));
    await googleAccessToken('alex@example.com', { fetchImpl: f });
    expect(JSON.parse(kc.get(GOOGLE_REFRESH_SERVICE, 'alex@example.com')!).refresh_token).toBe('1//new');
  });
});

/* -------------------------------------------------------------- adapter */

const ACCTS = [
  { email: 'alex@example.com', label: 'alex@example.com' },
  { email: 'alex@work.example.com', label: 'work' },
];

function decodeRaw(call: Call): string {
  const j = JSON.parse(String(call.init.body)) as { raw: string };
  return Buffer.from(j.raw, 'base64url').toString('utf8');
}
function bodyOf(mime: string): string {
  const [, rest] = mime.split('\r\n\r\n');
  return Buffer.from(rest.replace(/\r\n/g, ''), 'base64').toString('utf8');
}

describe('the built-in Gmail adapter', () => {
  it('sends a reply as RFC 2822 with threading headers, on the thread, from the named account', async () => {
    const tokens: string[] = [];
    const { f, calls } = stubFetch(() => ({ json: { id: 'm1', threadId: '18c0ffee12345' } }));
    const a = gmailAdapter({ accounts: () => ACCTS, token: async (e) => (tokens.push(e), 'ya29.t'), fetchImpl: f, now: () => new Date('2026-11-10T12:00:00Z') });
    const r = cleanEmail({
      account: 'work',
      to: 'Sam Rivera <sam@example.org>',
      cc: 'pat@example.org',
      subject: 'Re: Quarter close — notes',
      body: 'Thanks,\nwill send Friday.',
      threadId: '18c0ffee12345',
      inReplyTo: '<abc@mail.example.org>',
      references: '<root@mail.example.org> <abc@mail.example.org>',
    });
    if (!r.ok) throw new Error(r.detail);
    const out = await a.send(emailPayload(r.email), r.email.account);
    expect(out).toEqual({ messageId: 'm1', threadId: '18c0ffee12345' });
    expect(tokens).toEqual(['alex@work.example.com']);
    expect(calls[0].url).toBe(`${GMAIL_API}/messages/send`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer ya29.t');
    expect(JSON.parse(String(calls[0].init.body)).threadId).toBe('18c0ffee12345');
    const mime = decodeRaw(calls[0]);
    const head = mime.split('\r\n\r\n')[0].split('\r\n');
    expect(head).toEqual([
      'From: alex@work.example.com',
      'To: Sam Rivera <sam@example.org>',
      'Cc: pat@example.org',
      `Subject: =?UTF-8?B?${Buffer.from('Re: Quarter close — notes').toString('base64')}?=`,
      'Date: Tue, 10 Nov 2026 12:00:00 +0000',
      'In-Reply-To: <abc@mail.example.org>',
      'References: <root@mail.example.org> <abc@mail.example.org>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset="UTF-8"',
      'Content-Transfer-Encoding: base64',
    ]);
    expect(bodyOf(mime)).toBe('Thanks,\r\nwill send Friday.');
  });

  it('builds multipart/mixed for attachments', () => {
    const mime = buildMime({ to: 'sam@example.org', subject: 'Files', body: 'Attached.', attachments: ['/tmp/report.pdf'] }, 'alex@example.com', {
      readFile: () => Buffer.from('%PDF-1.4'),
      boundary: 'B',
      now: new Date(0),
    });
    expect(mime).toContain('Content-Type: multipart/mixed; boundary="B"');
    expect(mime).toContain('--B\r\nContent-Type: text/plain');
    expect(mime).toContain('Content-Type: application/pdf; name="report.pdf"\r\nContent-Disposition: attachment; filename="report.pdf"');
    expect(mime).toContain(Buffer.from('%PDF-1.4').toString('base64'));
    expect(mime.trimEnd().endsWith('--B--')).toBe(true);
  });

  it('retries once on 401 with a fresh token, and treats 5xx and a dropped connection as maybe-sent', async () => {
    const forced: boolean[] = [];
    let n = 0;
    const { f } = stubFetch(() => (++n === 1 ? { status: 401, json: {} } : { json: { id: 'm2', threadId: 't' } }));
    const a = gmailAdapter({ accounts: () => ACCTS, token: async (_e, force) => (forced.push(!!force), force ? 'fresh' : 'stale'), fetchImpl: f });
    expect(await a.send({ to: 'sam@example.org', subject: 's', body: 'b' })).toEqual({ messageId: 'm2', threadId: 't' });
    expect(forced).toEqual([false, true]);

    const five = gmailAdapter({ accounts: () => ACCTS, token: async () => 't', fetchImpl: stubFetch(() => ({ status: 503 })).f });
    await expect(five.send({ to: 'sam@example.org', subject: 's', body: 'b' })).rejects.toBeInstanceOf(AmbiguousSendError);
    const drop = gmailAdapter({ accounts: () => ACCTS, token: async () => 't', fetchImpl: (async () => { throw new Error('socket hang up'); }) as unknown as typeof fetch });
    await expect(drop.send({ to: 'sam@example.org', subject: 's', body: 'b' })).rejects.toBeInstanceOf(AmbiguousSendError);
    const four = gmailAdapter({ accounts: () => ACCTS, token: async () => 't', fetchImpl: stubFetch(() => ({ status: 400, json: { error: { message: 'Invalid To header' } } })).f });
    const e = await four.send({ to: 'sam@example.org', subject: 's', body: 'b' }).catch((x) => x);
    expect(e).not.toBeInstanceOf(AmbiguousSendError);
    expect(e.message).toContain('Invalid To header');
  });

  it('maps a metadata thread to {id, from, date, at, snippet, labels}', async () => {
    const { f, calls } = stubFetch(() => ({
      json: {
        messages: [
          { id: 'a1', internalDate: '1762776000000', labelIds: ['SENT'], snippet: 'Sounds good &amp; thanks', payload: { headers: [{ name: 'From', value: 'Alex <alex@example.com>' }, { name: 'Date', value: 'Mon, 10 Nov 2026 12:00:00 +0000' }] } },
          { id: 'a2', internalDate: '1762779600000', labelIds: ['INBOX'], snippet: 'One more question &#39;here&#39;', payload: { headers: [{ name: 'from', value: 'Sam <sam@example.org>' }] } },
        ],
      },
    }));
    const a = gmailAdapter({ accounts: () => ACCTS, token: async () => 't', fetchImpl: f });
    const msgs = await a.thread('18c0ffee12345');
    expect(msgs).toEqual([
      { id: 'a1', from: 'Alex <alex@example.com>', date: 'Mon, 10 Nov 2026 12:00:00 +0000', at: 1762776000000, snippet: 'Sounds good & thanks', labels: ['SENT'] },
      { id: 'a2', from: 'Sam <sam@example.org>', date: '', at: 1762779600000, snippet: "One more question 'here'", labels: ['INBOX'] },
    ]);
    const u = new URL(calls[0].url);
    expect(u.pathname).toBe('/gmail/v1/users/me/threads/18c0ffee12345');
    expect(u.searchParams.get('format')).toBe('metadata');
    expect(u.searchParams.getAll('metadataHeaders')).toEqual(['From', 'Date', 'Message-ID']);
    expect(threadMessages({})).toEqual([]);
  });

  it('knows its own address and resolves accounts by label, email or default', async () => {
    const a = gmailAdapter({ accounts: () => ACCTS, token: async () => 't', fetchImpl: stubFetch(() => ({})).f });
    expect(await a.addresses()).toEqual(['alex@example.com']);
    expect(await a.addresses('work')).toEqual(['alex@work.example.com']);
    expect(resolveGoogleAccount(ACCTS, 'ALEX@WORK.EXAMPLE.COM').label).toBe('work');
    expect(() => resolveGoogleAccount(ACCTS, 'personal')).toThrow('no connected Gmail account is labelled "personal"');
    expect(() => resolveGoogleAccount([], undefined)).toThrow('no_gmail_account');
  });

  it('a draft may name an account by its address', () => {
    expect(cleanEmail({ account: 'alex+ops@example.com', to: 'sam@example.org', subject: 's', body: 'b' }).ok).toBe(true);
    expect(cleanEmail({ account: 'bad label', to: 'sam@example.org', subject: 's', body: 'b' }).ok).toBe(false);
  });
});

describe('which way email goes', () => {
  it('auto: Gmail once connected, else the CLI, else off', () => {
    expect(chooseEmailRoute({ via: 'auto', gmailAccounts: 0, cli: '/home/x/.claude/tools/gmail/gmail.mjs' })).toBe('cli');
    expect(chooseEmailRoute({ via: 'auto', gmailAccounts: 1, cli: '/home/x/.claude/tools/gmail/gmail.mjs' })).toBe('gmail');
    expect(chooseEmailRoute({ via: 'auto', gmailAccounts: 1, cli: '' })).toBe('gmail');
    expect(chooseEmailRoute({ via: 'auto', gmailAccounts: 0, cli: '' })).toBeNull();
  });
  it('a pinned route is used even when the other is set up, and is off when it is not', () => {
    expect(chooseEmailRoute({ via: 'cli', gmailAccounts: 2, cli: '/x' })).toBe('cli');
    expect(chooseEmailRoute({ via: 'cli', gmailAccounts: 2, cli: '' })).toBeNull();
    expect(chooseEmailRoute({ via: 'gmail', gmailAccounts: 0, cli: '/x' })).toBeNull();
    expect(chooseEmailRoute({ via: 'gmail', gmailAccounts: 1, cli: '/x' })).toBe('gmail');
  });
  it('defaults to auto with no accounts, so an existing CLI setup sends exactly as before', () => {
    const d = db();
    expect(getSetting(d, 'email_via')).toBe('auto');
    expect(getSetting(d, 'google_accounts')).toEqual([]);
    d.close();
  });
});

describe('the header dot for Gmail', () => {
  const base: ConnInputs = { slackMode: 'off', slackReconnect: '', gh: 'unknown', emailSetting: '', emailCli: '', emailCliExists: false };
  const gm = (i: Partial<ConnInputs>) => connectionStates({ ...base, ...i }).find((c) => c.id === 'gmail')!;
  it('is green with an account, amber when one needs reconnecting, and follows a pinned CLI', () => {
    expect(gm({ gmailAccounts: 1 }).state).toBe('ok');
    expect(gm({ gmailAccounts: 2, gmailReconnect: 1 }).state).toBe('warn');
    expect(gm({ gmailAccounts: 1, emailVia: 'cli', emailCli: '/x', emailCliExists: true }).state).toBe('ok');
    expect(gm({ gmailAccounts: 1, emailVia: 'cli' }).state).toBe('off');
    expect(gm({ emailVia: 'gmail' }).state).toBe('warn');
    expect(gm({ emailCli: '/x', emailCliExists: true }).detail).toContain('email CLI');
  });
  it('says who gh is signed in as', () => {
    expect(connectionStates({ ...base, gh: 'ok', ghLogin: 'octo-cat' }).find((c) => c.id === 'github')!.detail).toContain('octo-cat');
  });
});
