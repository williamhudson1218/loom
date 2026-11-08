import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { memoryBackend, setKeychainBackend } from '../src/secrets.ts';
import {
  KEYCHAIN_SERVICE,
  SlackError,
  authTest,
  chatPostMessage,
  clearTokenCache,
  compareScopes,
  configureToken,
  conversationLabel,
  conversationsHistory,
  conversationsInfo,
  conversationsReplies,
  deleteToken,
  emojiList,
  filesInfo,
  legacyAllowed,
  maskToken,
  reactionsAdd,
  redact,
  renderMentions,
  requireToken,
  scopesFor,
  READ_FEATURES,
  slackToken,
  slackTokenSource,
  storeToken,
  usersList,
} from '../src/slackapi.ts';
import { channelHistory, channelLabelFor, rootTextFor, type SlackLookups } from '../src/slack.ts';
import { refreshDirectory } from '../src/slackdir.ts';

// No real Slack, no real Keychain: every call goes to a fetch stub, and the
// Keychain is the in-memory backend. The token below is fake.
const TOKEN = 'xoxp-9999-8888-7777-0123456789abcdef';

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function stub(routes: Record<string, unknown | ((u: URL) => unknown)>, opts: { headers?: Record<string, string>; status?: number } = {}) {
  const seen: Seen[] = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    seen.push({ url, method: init.method ?? 'GET', headers: { ...(init.headers as Record<string, string>) }, body: init.body as string | undefined });
    const u = new URL(url);
    const m = u.pathname.split('/').pop()!;
    let body = routes[m];
    if (typeof body === 'function') body = (body as (u: URL) => unknown)(u);
    if (body instanceof Error) throw body;
    return { status: opts.status ?? 200, headers: new Headers(opts.headers ?? {}), json: async () => body } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, seen };
}

let legacyDir: string;
beforeEach(() => {
  legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-legacy-'));
  setKeychainBackend(memoryBackend());
  configureToken({ account: () => '', allowLegacy: () => false, legacyPath: path.join(legacyDir, 'token.json') });
  vi.stubEnv('SLACK_USER_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  setKeychainBackend(null);
  configureToken(null);
});

describe('token resolution', () => {
  it('prefers SLACK_USER_TOKEN, then the Keychain (team, then default), then the legacy file when allowed', () => {
    const kc = memoryBackend();
    setKeychainBackend(kc);
    let team = '';
    let legacy = false;
    configureToken({ account: () => team, allowLegacy: () => legacy, legacyPath: path.join(legacyDir, 'token.json') });
    fs.writeFileSync(path.join(legacyDir, 'token.json'), JSON.stringify({ user_token: 'xoxp-legacy' }));

    expect(slackToken()).toBe('');
    expect(slackTokenSource()).toBe('none');
    expect(() => requireToken()).toThrow('not_connected');

    legacy = true;
    clearTokenCache();
    expect(slackToken()).toBe('xoxp-legacy');
    expect(slackTokenSource()).toBe('legacy');

    kc.set(KEYCHAIN_SERVICE, 'default', 'xoxp-default');
    clearTokenCache();
    expect(slackToken()).toBe('xoxp-default');

    team = 'T1';
    kc.set(KEYCHAIN_SERVICE, 'T1', 'xoxp-team');
    clearTokenCache();
    expect(slackToken()).toBe('xoxp-team');
    expect(slackTokenSource()).toBe('keychain');

    vi.stubEnv('SLACK_USER_TOKEN', 'xoxp-env');
    expect(slackToken()).toBe('xoxp-env');
    expect(slackTokenSource()).toBe('env');
  });

  it('caches the lookup until it is cleared', () => {
    const kc = memoryBackend();
    let reads = 0;
    setKeychainBackend({ ...kc, get: (s, a) => (reads++, kc.get(s, a)) });
    configureToken({ account: () => '', allowLegacy: () => false });
    kc.set(KEYCHAIN_SERVICE, 'default', 'xoxp-a');
    slackToken();
    slackToken();
    expect(reads).toBe(1);
    kc.set(KEYCHAIN_SERVICE, 'default', 'xoxp-b');
    expect(slackToken()).toBe('xoxp-a');
    clearTokenCache();
    expect(slackToken()).toBe('xoxp-b');
  });

  it('a Keychain that throws reads as no token, without leaking anything', () => {
    setKeychainBackend({ get: () => { throw new Error('denied'); }, set: () => {}, delete: () => {} });
    configureToken({ account: () => '', allowLegacy: () => false });
    expect(slackToken()).toBe('');
  });

  it('stores under the team id, drops the pre-Test default copy, and deletes on disconnect', () => {
    const kc = memoryBackend();
    setKeychainBackend(kc);
    configureToken({ account: () => 'T1', allowLegacy: () => false });
    expect(() => storeToken('not-a-token', 'T1')).toThrow('not_a_slack_token');
    storeToken(TOKEN); // before the first Test
    expect(kc.get(KEYCHAIN_SERVICE, 'default')).toBe(TOKEN);
    storeToken(TOKEN, 'T1');
    expect(kc.get(KEYCHAIN_SERVICE, 'T1')).toBe(TOKEN);
    expect(kc.get(KEYCHAIN_SERVICE, 'default')).toBeNull();
    expect(slackToken()).toBe(TOKEN);
    deleteToken();
    expect(kc.items.size).toBe(0);
    expect(slackToken()).toBe('');
  });

  it('reads the legacy file only for a migrated or pre-setup install', () => {
    expect(legacyAllowed(undefined)).toBe(true);
    expect(legacyAllowed('migrated')).toBe(true);
    expect(legacyAllowed('new')).toBe(false);
  });
});

describe('redaction', () => {
  it('masks Slack tokens and bearer credentials', () => {
    expect(redact(`fetch failed for Bearer ${TOKEN} and ${TOKEN}`)).not.toContain('9999-8888');
    expect(redact('xoxb-1-2-abc')).toBe('xoxb-[redacted]');
    expect(redact('Authorization: Bearer abc.def')).toBe('Authorization: Bearer [redacted]');
    expect(redact('plain text')).toBe('plain text');
    expect(maskToken(TOKEN)).toBe('xoxp-…cdef');
  });

  it('never lets the token reach an error, a URL or the console, however a call fails', async () => {
    const logs: string[] = [];
    const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map((k) =>
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))),
    );
    const failures: (() => Promise<unknown>)[] = [
      // network error whose text includes the token (as a proxy or fetch polyfill might)
      () => authTest({ token: TOKEN, fetchImpl: stub({ 'auth.test': new Error(`connect failed: Authorization: Bearer ${TOKEN}`) }).fetchImpl }),
      // Slack echoing the token back in an error field
      () => authTest({ token: TOKEN, fetchImpl: stub({ 'auth.test': { ok: false, error: `invalid_auth ${TOKEN}` } }).fetchImpl }),
      // HTTP 500 with a non-JSON body
      () => authTest({ token: TOKEN, fetchImpl: (async () => ({ status: 500, headers: new Headers(), json: async () => { throw new Error('not json ' + TOKEN); } })) as unknown as typeof fetch }),
      // rate limit
      () => conversationsHistory('C1', {}, { token: TOKEN, fetchImpl: stub({ 'conversations.history': {} }, { status: 429, headers: { 'retry-after': '7' } }).fetchImpl }),
      () => channelHistory('C1', '1.0', { token: TOKEN, fetchImpl: stub({ 'conversations.history': { ok: false, error: 'not_authed ' + TOKEN } }).fetchImpl }),
    ];
    const messages: string[] = [];
    for (const f of failures) {
      try {
        await f();
        messages.push('no error');
      } catch (e) {
        messages.push(String((e as Error).message) + ' ' + String((e as Error).stack ?? '') + ' ' + JSON.stringify(e));
      }
    }
    spies.forEach((s) => s.mockRestore());
    expect(messages.every((m) => m !== 'no error')).toBe(true);
    for (const m of [...messages, ...logs]) expect(m).not.toContain(TOKEN.slice(5));
    expect(messages[3]).toContain('ratelimited');
  });

  it('puts the token in the Authorization header only, never in the URL or body', async () => {
    const { fetchImpl, seen } = stub({
      'conversations.history': { ok: true, messages: [] },
      'chat.postMessage': { ok: true, channel: 'C1', ts: '1.1' },
    });
    await conversationsHistory('C1', { oldest: '1.0' }, { token: TOKEN, fetchImpl });
    await chatPostMessage({ channel: 'C1', text: 'hi' }, { token: TOKEN, fetchImpl });
    for (const s of seen) {
      expect(s.url).not.toContain(TOKEN);
      expect(s.body ?? '').not.toContain(TOKEN);
      expect(s.headers.Authorization).toBe('Bearer ' + TOKEN);
    }
    expect(seen[0].method).toBe('GET');
    expect(seen[0].url).toContain('oldest=1.0');
    expect(seen[1].method).toBe('POST');
    expect(JSON.parse(seen[1].body!)).toEqual({ channel: 'C1', text: 'hi' });
  });
});

describe('methods', () => {
  it('auth.test returns the identity and the granted scopes from x-oauth-scopes', async () => {
    const { fetchImpl } = stub(
      { 'auth.test': { ok: true, team_id: 'T1', team: 'Acme', user_id: 'U1', user: 'sam', url: 'https://acme.slack.com/' } },
      { headers: { 'x-oauth-scopes': 'channels:history, users:read,emoji:read' } },
    );
    expect(await authTest({ token: TOKEN, fetchImpl })).toEqual({
      identity: { team_id: 'T1', team: 'Acme', user_id: 'U1', user: 'sam', url: 'https://acme.slack.com/' },
      scopes: ['channels:history', 'users:read', 'emoji:read'],
    });
  });

  it('pages history, replies, users; reads info and emoji', async () => {
    let page = 0;
    const { fetchImpl, seen } = stub({
      'conversations.history': () => (page++ === 0 ? { ok: true, messages: [{ ts: '3' }], has_more: true, response_metadata: { next_cursor: 'c' } } : { ok: true, messages: [{ ts: '2' }] }),
      'conversations.replies': { ok: true, messages: [{ ts: '1.0', text: 'root' }, { ts: '1.1' }] },
      'conversations.info': { ok: true, channel: { id: 'D1', is_im: true, user: 'U2' } },
      'users.list': { ok: true, members: [{ id: 'U1', name: 'a' }] },
      'emoji.list': { ok: true, emoji: { party: 'https://e/p.png', bad: 3 } },
      'files.info': { ok: true, file: { id: 'F1' } },
    });
    const o = { token: TOKEN, fetchImpl };
    expect((await conversationsHistory('C1', { maxPages: 3 }, o)).map((m) => m.ts)).toEqual(['3', '2']);
    expect(seen[1].url).toContain('cursor=c');
    expect((await conversationsReplies('C1', '1.0', {}, o))[0].text).toBe('root');
    expect((await conversationsInfo('D1', o)).user).toBe('U2');
    expect((await usersList({}, o))[0].id).toBe('U1');
    expect(await emojiList(o)).toEqual({ party: 'https://e/p.png' });
    expect((await filesInfo('F1', o)).id).toBe('F1');
  });

  it('write methods POST, and only when called', async () => {
    const { fetchImpl, seen } = stub({ 'reactions.add': { ok: true } });
    await reactionsAdd('C1', '1.0', 'eyes', { token: TOKEN, fetchImpl });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe('POST');
  });

  it('a Slack error is a SlackError carrying the code', async () => {
    const { fetchImpl } = stub({ 'conversations.info': { ok: false, error: 'channel_not_found' } });
    await expect(conversationsInfo('C9', { token: TOKEN, fetchImpl })).rejects.toBeInstanceOf(SlackError);
    await expect(conversationsInfo('C9', { token: TOKEN, fetchImpl })).rejects.toThrow('channel_not_found');
  });
});

describe('scopes', () => {
  it('a read-only feature set needs history, read, users and emoji scopes but no write scope', () => {
    const s = scopesFor(READ_FEATURES);
    expect(s).toContain('channels:history');
    expect(s).toContain('users:read');
    expect(s).toContain('emoji:read');
    expect(s.some((x) => x.endsWith(':write'))).toBe(false);
  });

  it('reports what is missing, overall and per feature', () => {
    const r = compareScopes(['channels:history', 'groups:history', 'im:history', 'mpim:history', 'users:read'], ['parked', 'directory']);
    expect(r.missing).toEqual(['emoji:read']);
    expect(r.granted).toBe(r.required - 1);
    expect(r.features.parked).toEqual([]);
    expect(r.features.directory).toEqual(['emoji:read']);
  });
});

describe('rendering', () => {
  it('renders known mentions and leaves unknown ones', () => {
    expect(renderMentions('hi <@U1> and <@U2>', { U1: 'Sam' })).toBe('hi @Sam and <@U2>');
    expect(renderMentions('no mentions', {})).toBe('no mentions');
  });
  it('labels channels and DMs', () => {
    expect(conversationLabel({ id: 'C1', name: 'general' })).toBe('#general');
    expect(conversationLabel({ id: 'D1', is_im: true, user: 'U1' }, 'sam')).toBe('@sam');
    expect(conversationLabel({ id: 'D1', is_im: true })).toBeNull();
  });
});

describe('slack.ts background fills go through the API, not a CLI', () => {
  const flush = () => new Promise((r) => setTimeout(r, 10));
  it('fills a channel label (DM via users.info) and a thread root into the Loom cache', async () => {
    const calls: string[] = [];
    const api: SlackLookups = {
      authTest: async () => (calls.push('auth.test'), { identity: { team_id: 'T1', team: '', user_id: 'U0', user: '', url: '' }, scopes: [] }),
      conversationsInfo: async (id) => (calls.push('conversations.info'), id === 'D7' ? { id, is_im: true, user: 'U5' } : { id, name: 'ops' }),
      conversationsReplies: async (_c, ts) => (calls.push('conversations.replies'), [{ ts, text: 'ping <@U5>', user: 'U5' }]),
      usersInfo: async (id) => (calls.push('users.info'), { id, profile: { display_name: 'Pat' } }),
      users: () => ({}),
    };
    expect(channelLabelFor('C7', api)).toBe('C7');
    expect(channelLabelFor('D7', api)).toBe('D7');
    expect(rootTextFor('C7/5.0', api)).toBeNull();
    await flush();
    expect(channelLabelFor('C7', api)).toBe('#ops');
    expect(channelLabelFor('D7', api)).toBe('@Pat');
    expect(rootTextFor('C7/5.0', api)).toBe('ping <@U5>'); // the directory map is empty, so the mention stays raw
    const cache = JSON.parse(fs.readFileSync(path.join(process.env.LOOM_HOME!, 'slack-cache.json'), 'utf-8'));
    expect(cache.channels).toMatchObject({ C7: '#ops', D7: '@Pat' });
    expect(cache.roots['C7/5.0'].author).toBe('Pat');
    expect(calls).toContain('users.info');
  });

  it('the directory refresh uses the API client with the resolved token', async () => {
    setKeychainBackend(memoryBackend({ [KEYCHAIN_SERVICE + '\u0000default']: TOKEN }));
    clearTokenCache();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dir-'));
    const { fetchImpl, seen } = stub({
      'users.list': { ok: true, members: [{ id: 'U1', profile: { display_name: 'Sam' } }] },
      'auth.test': { ok: true, user_id: 'U1', user: 'sam' },
      'emoji.list': { ok: true, emoji: {} },
    });
    const d = await refreshDirectory({ file: path.join(dir, 'd.json'), labelsFile: path.join(dir, 'x'), fetchImpl });
    expect(d.me.name).toBe('Sam');
    expect(seen.every((s) => s.headers.Authorization === 'Bearer ' + TOKEN)).toBe(true);
    // No token at all: no calls, the previous directory comes back.
    setKeychainBackend(memoryBackend());
    clearTokenCache();
    const none = stub({});
    await refreshDirectory({ file: path.join(dir, 'd.json'), labelsFile: path.join(dir, 'x'), fetchImpl: none.fetchImpl });
    expect(none.seen).toHaveLength(0);
  });
});
