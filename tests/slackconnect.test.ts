import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { getSetting, setSetting } from '../src/settingsSchema.ts';
import { memoryBackend, setKeychainBackend } from '../src/secrets.ts';
import { KEYCHAIN_SERVICE, SlackError, configureToken, scopesFor, slackToken } from '../src/slackapi.ts';
import { buildManifest, manifestScopes, scopeSummary } from '../src/slackmanifest.ts';
import { SLACK_FEATURES, effectiveMode, featureOn, slackFeatureOn, slackMode, type SlackFeature, type SlackMode } from '../src/slackmode.ts';
import { makeSlackRoutes } from '../src/routes/slack.ts';
import { ROUTES, type RouteCtx, type RouteDef } from '../src/routes/index.ts';
import type { ProbeReport } from '../src/probe.ts';

// No real Slack, Keychain or settings DB: Slack is a stub, the Keychain is the
// in-memory backend, and the DB is a file in a temp dir. The token is fake.
const TOKEN = 'xoxp-1111-2222-3333-abcdef0123456789';

let dir: string;
let dbPath: string;
let kc: ReturnType<typeof memoryBackend>;
let probeReport: Partial<ProbeReport['slackMcp']>;
let authImpl: (o?: { token?: string }) => Promise<{ identity: { team_id: string; team: string; user_id: string; user: string; url: string }; scopes: string[] }>;
const seenTokens: (string | undefined)[] = [];

const IDENTITY = { team_id: 'T1', team: 'Acme', user_id: 'U1', user: 'ada', url: 'https://acme.slack.com/' };
const ALL = scopesFor();

beforeEach(() => {
  delete process.env.SLACK_USER_TOKEN;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-slackconnect-'));
  dbPath = path.join(dir, 'manager.db');
  kc = memoryBackend();
  setKeychainBackend(kc);
  const accountFromDb = () => {
    const db = openDb(dbPath);
    try {
      return String((getSetting(db, 'slack_identity') as { team_id?: string }).team_id ?? '');
    } finally {
      db.close();
    }
  };
  configureToken({ account: accountFromDb, allowLegacy: () => false });
  probeReport = { found: false, connected: false };
  seenTokens.length = 0;
  authImpl = async (o) => {
    seenTokens.push(o?.token);
    return { identity: IDENTITY, scopes: ALL };
  };
});
afterEach(() => {
  delete process.env.SLACK_USER_TOKEN;
  configureToken(null);
  setKeychainBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

function routes(): Record<string, RouteDef> {
  const list = makeSlackRoutes({
    openDb: () => openDb(dbPath),
    authTest: ((o?: { token?: string }) => authImpl(o)) as never,
    probe: (async () => ({ slackMcp: probeReport, slackApp: { found: false } }) as unknown as ProbeReport) as never,
    fullName: () => 'Ada Lovelace',
  });
  return Object.fromEntries(list.map((r) => [`${r.method} ${r.path}`, r]));
}

async function hit(r: RouteDef, opts: { body?: unknown; query?: string } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  let out: { status: number; body: Record<string, unknown> } | null = null;
  const ctx = {
    req: {} as never,
    res: {} as never,
    url: new URL('http://localhost:4317' + r.path + (opts.query ?? '')),
    json: (status: number, body: unknown) => (out = { status, body: body as Record<string, unknown> }),
    body: async () => (opts.body && typeof opts.body === 'object' ? (opts.body as Record<string, unknown>) : opts.body === undefined ? {} : null),
  } as RouteCtx;
  await r.handler!(ctx);
  if (!out) throw new Error('handler sent no response');
  return out;
}

const peek = <T>(f: (db: Database.Database) => T): T => {
  const db = openDb(dbPath);
  try {
    return f(db);
  } finally {
    db.close();
  }
};

describe('manifest', () => {
  it('matches the snapshot: user scopes only, no bot, emoji:read and mpim:write included', () => {
    expect(buildManifest({ fullName: 'Ada Lovelace' })).toEqual({
      display_information: {
        name: 'Loom (Ada Lovelace)',
        description: 'Loom links your Slack threads to your Claude Code chats and sends the drafts you approve.',
      },
      oauth_config: {
        scopes: {
          user: [
            'channels:history', 'channels:read', 'chat:write', 'emoji:read', 'files:read', 'files:write',
            'groups:history', 'groups:read', 'im:history', 'im:read', 'im:write', 'mpim:history', 'mpim:read',
            'mpim:write', 'reactions:write', 'search:read', 'users:read',
          ],
        },
      },
      settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
    });
  });

  it('has no bot user and no bot scopes', () => {
    const m = buildManifest() as unknown as Record<string, unknown>;
    expect(JSON.stringify(m)).not.toMatch(/bot/i);
    expect(m.features).toBeUndefined();
  });

  it('read-only strips every write scope', () => {
    const ro = manifestScopes(true);
    expect(ro).toEqual(
      ['channels:history', 'channels:read', 'emoji:read', 'files:read', 'groups:history', 'groups:read', 'im:history', 'im:read', 'mpim:history', 'mpim:read', 'search:read', 'users:read'],
    );
    for (const w of ['chat:write', 'im:write', 'mpim:write', 'files:write', 'reactions:write']) expect(ro).not.toContain(w);
    expect(buildManifest({ readonly: true }).display_information.description).toMatch(/never posts/);
  });

  it('names the app from the full name, safely', () => {
    expect(buildManifest({ fullName: '  ' }).display_information.name).toBe('Loom');
    expect(buildManifest({ fullName: 'Al "<b>" O\'Neil' }).display_information.name).toBe("Loom (Al b O'Neil)");
  });

  it('GET /api/slack/manifest serves it, readonly by query', async () => {
    const r = routes();
    const full = await hit(r['GET /api/slack/manifest'], { query: '' });
    expect(full.status).toBe(200);
    expect((full.body.manifest as { display_information: { name: string } }).display_information.name).toBe('Loom (Ada Lovelace)');
    expect(full.body.scopes).toContain('emoji:read');
    const ro = await hit(r['GET /api/slack/manifest'], { query: '?readonly=1' });
    expect(ro.body.readonly).toBe(true);
    expect(ro.body.scopes).not.toContain('chat:write');
    expect(JSON.parse(ro.body.text as string)).toEqual(ro.body.manifest);
  });
});

describe('scope comparison', () => {
  it('reports the missing scopes and offers Re-authorise', () => {
    const granted = ALL.filter((s) => s !== 'emoji:read' && s !== 'mpim:write');
    const s = scopeSummary(granted);
    expect(s.missing).toEqual(['emoji:read', 'mpim:write']);
    expect(s.text).toBe(`${ALL.length - 2} of ${ALL.length} scopes granted, emoji:read, mpim:write missing`);
    expect(s.reauthorise).toBe(true);
    expect(s.features.directory).toEqual(['emoji:read']);
    expect(s.features.dm).toEqual(['mpim:write']);
    expect(s.features.send).toEqual([]);
  });

  it('a complete grant has nothing to re-authorise', () => {
    const s = scopeSummary(ALL);
    expect(s.missing).toEqual([]);
    expect(s.reauthorise).toBe(false);
    expect(s.text).toBe(`${ALL.length} of ${ALL.length} scopes granted`);
  });

  it('read-only compares only against the read scopes', () => {
    const s = scopeSummary(manifestScopes(true), true);
    expect(s.missing).toEqual([]);
    expect(scopeSummary(manifestScopes(true), false).missing).toContain('chat:write');
  });
});

describe('POST /api/slack/token', () => {
  it('Tests first, then stores in the Keychain under the team id, records identity and scopes, goes direct', async () => {
    const r = routes();
    const res = await hit(r['POST /api/slack/token'], { body: { token: TOKEN } });
    expect(res.status).toBe(200);
    expect(seenTokens).toEqual([TOKEN]);
    expect(kc.items.get(`${KEYCHAIN_SERVICE}\u0000T1`) ?? [...kc.items.entries()].find(([k]) => k.includes('T1'))?.[1]).toBe(TOKEN);
    expect(peek((db) => getSetting(db, 'slack_identity'))).toMatchObject({ team_id: 'T1', user_id: 'U1', url: 'https://acme.slack.com/' });
    expect(peek((db) => getSetting(db, 'slack_scopes_granted'))).toEqual(ALL);
    expect(peek((db) => getSetting(db, 'slack_mode'))).toBe('direct');
    expect(slackToken()).toBe(TOKEN);
    expect(res.body.token).toBe('xoxp-…6789');
    expect((res.body.scopes as { reauthorise: boolean }).reauthorise).toBe(false);
  });

  it('never echoes the token, in the response or the settings rows', async () => {
    const res = await hit(routes()['POST /api/slack/token'], { body: { token: TOKEN } });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    const rows = peek((db) => db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('a failing Test stores nothing and says why, without the token', async () => {
    authImpl = async () => {
      throw new SlackError('auth.test', 'invalid_auth', 200);
    };
    const res = await hit(routes()['POST /api/slack/token'], { body: { token: TOKEN } });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, error: 'invalid_auth' });
    expect(String(res.body.hint)).toMatch(/xoxp-/);
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(kc.items.size).toBe(0);
    expect(peek((db) => getSetting(db, 'slack_identity'))).toEqual({});
    expect(slackToken()).toBe('');
  });

  it('a network failure carrying the token is redacted', async () => {
    authImpl = async () => {
      throw new SlackError('auth.test', 'network: fetch failed for https://x/?t=' + TOKEN);
    };
    const res = await hit(routes()['POST /api/slack/token'], { body: { token: TOKEN } });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(kc.items.size).toBe(0);
  });

  it('refuses a missing, bot or malformed token before calling Slack', async () => {
    const r = routes()['POST /api/slack/token'];
    expect((await hit(r, { body: {} })).body.error).toBe('missing_token');
    expect((await hit(r, { body: { token: 'xoxb-1-2-3' } })).body.error).toBe('not_a_user_token');
    expect((await hit(r, { body: { token: 'hello' } })).body.error).toBe('not_a_slack_token');
    expect((await hit(r, { body: null })).body.error).toBe('missing_token');
    expect(seenTokens).toEqual([]);
    expect(kc.items.size).toBe(0);
  });

  it('refuses while SLACK_USER_TOKEN is set (the environment wins)', async () => {
    process.env.SLACK_USER_TOKEN = 'xoxp-env-token-1234';
    const res = await hit(routes()['POST /api/slack/token'], { body: { token: TOKEN } });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('token_from_environment');
    expect(kc.items.size).toBe(0);
  });

  it('a token missing scopes is stored and reported, not rejected', async () => {
    authImpl = async () => ({ identity: IDENTITY, scopes: ALL.filter((s) => s !== 'emoji:read') });
    const res = await hit(routes()['POST /api/slack/token'], { body: { token: TOKEN } });
    expect(res.status).toBe(200);
    const sc = res.body.scopes as { missing: string[]; reauthorise: boolean; text: string };
    expect(sc.missing).toEqual(['emoji:read']);
    expect(sc.reauthorise).toBe(true);
    expect(sc.text).toMatch(/emoji:read missing/);
    expect(slackToken()).toBe(TOKEN);
  });

  it('readonly judges the grant against the read scopes only', async () => {
    authImpl = async () => ({ identity: IDENTITY, scopes: manifestScopes(true) });
    const res = await hit(routes()['POST /api/slack/token'], { body: { token: TOKEN, readonly: true } });
    expect((res.body.scopes as { missing: string[] }).missing).toEqual([]);
  });
});

describe('POST /api/slack/test', () => {
  it('needs a connection', async () => {
    const res = await hit(routes()['POST /api/slack/test']);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not_connected');
  });

  it('re-tests the stored token and refreshes identity and scopes', async () => {
    const r = routes();
    await hit(r['POST /api/slack/token'], { body: { token: TOKEN } });
    authImpl = async (o) => {
      seenTokens.push(o?.token);
      return { identity: { ...IDENTITY, user: 'grace' }, scopes: ALL.filter((s) => s !== 'files:write') };
    };
    const res = await hit(r['POST /api/slack/test']);
    expect(res.status).toBe(200);
    expect(seenTokens.at(-1)).toBe(TOKEN);
    expect((res.body.scopes as { missing: string[] }).missing).toEqual(['files:write']);
    expect(peek((db) => getSetting(db, 'slack_identity'))).toMatchObject({ user: 'grace' });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });
});

describe('POST /api/slack/disconnect', () => {
  it('deletes the Keychain item, clears identity and scopes, turns Slack off', async () => {
    const r = routes();
    await hit(r['POST /api/slack/token'], { body: { token: TOKEN } });
    expect(kc.items.size).toBe(1);
    const res = await hit(r['POST /api/slack/disconnect']);
    expect(res.status).toBe(200);
    expect(kc.items.size).toBe(0);
    expect(slackToken()).toBe('');
    expect(peek((db) => getSetting(db, 'slack_identity'))).toEqual({});
    expect(peek((db) => getSetting(db, 'slack_scopes_granted'))).toEqual([]);
    expect(peek((db) => getSetting(db, 'slack_mode'))).toBe('off');
  });

  it('cannot remove a token that comes from the environment', async () => {
    process.env.SLACK_USER_TOKEN = 'xoxp-env-token-1234';
    const res = await hit(routes()['POST /api/slack/disconnect']);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('token_from_environment');
  });
});

describe('MCP detection and POST /api/slack/mode', () => {
  it('mcp needs a Slack server in `claude mcp list`', async () => {
    const r = routes();
    const no = await hit(r['POST /api/slack/mode'], { body: { mode: 'mcp' } });
    expect(no.status).toBe(409);
    expect(no.body.error).toBe('no_slack_mcp');
    expect(peek((db) => getSetting(db, 'slack_mode'))).not.toBe('mcp');
    probeReport = { found: true, connected: true, name: 'claude.ai Slack' };
    const yes = await hit(r['POST /api/slack/mode'], { body: { mode: 'mcp' } });
    expect(yes.status).toBe(200);
    expect(yes.body.mode).toBe('mcp');
    expect(peek((db) => getSetting(db, 'slack_mode'))).toBe('mcp');
  });

  it('direct needs a token; off always works; junk is refused', async () => {
    const r = routes();
    expect((await hit(r['POST /api/slack/mode'], { body: { mode: 'direct' } })).status).toBe(409);
    expect((await hit(r['POST /api/slack/mode'], { body: { mode: 'off' } })).status).toBe(200);
    expect((await hit(r['POST /api/slack/mode'], { body: { mode: 'both' } })).status).toBe(400);
  });

  it('status reports the effective mode, identity, scopes and (on request) the MCP probe', async () => {
    const r = routes();
    const cold = await hit(r['GET /api/slack/status']);
    expect(cold.body).toMatchObject({ ok: true, mode: 'off', connected: false, identity: null, scopes: null, tokenSource: 'none' });
    expect(cold.body.mcp).toBeUndefined();
    await hit(r['POST /api/slack/token'], { body: { token: TOKEN } });
    probeReport = { found: true, connected: false, name: 'slack' };
    const warm = await hit(r['GET /api/slack/status'], { query: '?probe=1' });
    expect(warm.body).toMatchObject({ mode: 'direct', connected: true, tokenSource: 'keychain', mcp: { found: true, connected: false, name: 'slack' } });
    expect((warm.body.identity as { team: string }).team).toBe('Acme');
    expect(JSON.stringify(warm.body)).not.toContain(TOKEN);
  });
});

describe('route table', () => {
  it('registers every Slack route in ROUTES with writes on the browser guard', () => {
    const mine = ROUTES.filter((r) => r.path.startsWith('/api/slack/') && ['/token', '/test', '/disconnect', '/mode', '/manifest', '/status'].some((s) => r.path.endsWith(s)));
    expect(mine.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/slack/manifest',
      'GET /api/slack/status',
      'POST /api/slack/disconnect',
      'POST /api/slack/mode',
      'POST /api/slack/test',
      'POST /api/slack/token',
    ]);
    for (const r of mine) expect(r.kind).toBe(r.method === 'GET' ? 'read' : 'browser');
  });
});

describe('modes and feature gates (§5.2, §5.4)', () => {
  const direct: SlackMode = 'direct';

  it('effective mode: direct without a token is off', () => {
    expect(effectiveMode('direct', true)).toBe('direct');
    expect(effectiveMode('direct', false)).toBe('off');
    expect(effectiveMode('mcp', false)).toBe('mcp');
    expect(effectiveMode('off', true)).toBe('off');
  });

  // The seven §5.4 items, one test each. Direct runs it; mcp and off do not.
  const gated: [string, SlackFeature][] = [
    ['1 Slack-source watchers', 'watchers'],
    ['2 parked-thread reply detection and Send & park', 'parked'],
    ['3 Outbox Send / Send & park / Send & close', 'send'],
    ['4 channel names, people names and custom emoji', 'names'],
    ['5 thread previews, root text, unread/replied counts', 'previews'],
    ['6 sent-draft reconcile', 'reconcile'],
    ['7 loom thread stage --react / --ack', 'react'],
  ];
  for (const [label, feature] of gated) {
    it(`§5.4 ${label}: on in direct, off in mcp and off`, () => {
      expect(featureOn(feature, 'direct')).toBe(true);
      expect(featureOn(feature, 'mcp')).toBe(false);
      expect(featureOn(feature, 'off')).toBe(false);
    });
  }

  it('the supporting caches (labels, directory) are direct only', () => {
    for (const f of ['labels', 'directory'] as const) {
      expect([featureOn(f, 'direct'), featureOn(f, 'mcp'), featureOn(f, 'off')]).toEqual([true, false, false]);
    }
  });

  it('goto, ownership and Outbox drafts still work in MCP-only mode, and not when off', () => {
    for (const f of ['goto', 'ownership', 'outboxDrafts'] as const) {
      expect([featureOn(f, 'direct'), featureOn(f, 'mcp'), featureOn(f, 'off')]).toEqual([true, true, false]);
    }
  });

  it('parked polling also honours slack_poll_parked', () => {
    expect(featureOn('parked', direct, false)).toBe(false);
    expect(featureOn('parked', direct, true)).toBe(true);
    expect(featureOn('send', direct, false)).toBe(true);
  });

  it('every feature is covered by one of the lists above', () => {
    const covered = new Set<string>([...gated.map((g) => g[1]), 'labels', 'directory', 'goto', 'ownership', 'outboxDrafts']);
    expect([...SLACK_FEATURES].filter((f) => !covered.has(f))).toEqual([]);
  });

  it('slackMode / slackFeatureOn read the setting and the token', () => {
    const db = openDb(':memory:');
    try {
      setSetting(db, 'slack_mode', 'direct');
      expect(slackMode(db)).toBe('off'); // no token
      expect(slackFeatureOn('send', db)).toBe(false);
      process.env.SLACK_USER_TOKEN = 'xoxp-env-token-1234';
      expect(slackMode(db)).toBe('direct');
      expect(slackFeatureOn('send', db)).toBe(true);
      setSetting(db, 'slack_poll_parked', false);
      expect(slackFeatureOn('parked', db)).toBe(false);
      setSetting(db, 'slack_mode', 'mcp');
      expect(slackMode(db)).toBe('mcp');
      expect(slackFeatureOn('send', db)).toBe(false);
      expect(slackFeatureOn('goto', db)).toBe(true);
      setSetting(db, 'slack_mode', 'off');
      expect(slackMode(db)).toBe('off');
      expect(slackFeatureOn('goto', db)).toBe(false);
    } finally {
      db.close();
    }
  });
});
