import { execFileSync } from 'node:child_process';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { openDb } from '../db.ts';
import { probeEnvironment, type ProbeReport } from '../probe.ts';
import { getSetting, setSetting } from '../settingsSchema.ts';
import {
  SlackError,
  authTest,
  clearTokenCache,
  deleteToken,
  maskToken,
  redact,
  slackToken,
  slackTokenSource,
  storeGrant,
  storeToken,
  type CallOpts,
  type OAuthGrant,
  type SlackIdentity,
} from '../slackapi.ts';
import { buildManifest, buildSharedManifest, manifestScopes, scopeSummary } from '../slackmanifest.ts';
import { beginAuth, exchangeCode, oauthHint, outcomeOf, recordOutcome, takeState } from '../slackoauth.ts';
import { effectiveMode } from '../slackmode.ts';
import { preferredPort, serverPort } from '../serverport.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Slack connection: token paste/test/disconnect, mode, manifest (§5).
// Every entry is gated by requireWrite(kind) in src/routes/index.ts before its
// handler runs; tests/auth.test.ts sweeps this list, so a route cannot skip it.
//
// The token only ever arrives in the body of POST /api/slack/token and goes to
// the Keychain; no response, log line or setting row carries it (§13).

export interface SlackRouteDeps {
  openDb(): Database.Database;
  authTest(opts?: CallOpts): ReturnType<typeof authTest>;
  /** Read-only environment probe (claude mcp list) for MCP detection. */
  probe(db: Database.Database): Promise<ProbeReport>;
  /** The person's full name for the app title. */
  fullName(): string;
  /** oauth.v2.access with the code and verifier (Connect Slack). */
  exchange(p: { clientId: string; code: string; verifier: string; redirectUri: string }): Promise<OAuthGrant>;
  callOpts?: CallOpts;
}

function macFullName(): string {
  try {
    if (process.platform === 'darwin') {
      const n = execFileSync('id', ['-F'], { timeout: 2000, encoding: 'utf8' }).trim();
      if (n) return n;
    }
  } catch {
    /* fall through */
  }
  return os.userInfo().username;
}

const defaultDeps: SlackRouteDeps = {
  openDb: () => openDb(),
  authTest: (o) => authTest(o),
  probe: (db) =>
    probeEnvironment({
      claudeBin: getSetting(db, 'claude_bin') || undefined,
      extraPath: getSetting(db, 'extra_path') as string[],
    }),
  fullName: macFullName,
  exchange: (p) => exchangeCode(p),
};

/** The port this request reached Loom on, so the redirect matches the running server. */
function portOf(ctx: RouteCtx): number {
  return ctx.req?.socket?.localPort || Number(ctx.url.port) || serverPort();
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The small page the browser tab shows after Slack redirects back. */
function callbackPage(ctx: RouteCtx, status: number, ok: boolean, text: string): void {
  const res = ctx.res;
  if (res.headersSent) return;
  const title = ok ? 'Slack connected' : 'Slack not connected';
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · Loom</title>
<style>body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#f6f6f8;color:#1d1d22}
@media (prefers-color-scheme:dark){body{background:#17171b;color:#e8e8ee}}main{max-width:420px;padding:24px}h1{font-size:18px;margin:0 0 8px}</style></head>
<body><main><h1>${title}</h1><p>${esc(text)}</p></main></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(html);
}

const flag = (v: unknown): boolean => v === true || v === '1' || v === 'true' || v === 1;

/** Slack error codes worth telling the user about in words. */
function explain(e: unknown): { error: string; hint?: string } {
  if (!(e instanceof SlackError)) return { error: redact((e as Error)?.message ?? e) };
  const hints: Record<string, string> = {
    invalid_auth: 'Slack rejected this token. Copy the User OAuth Token (xoxp-) again.',
    token_revoked: 'This token was revoked. Install the app again and copy the new token.',
    token_expired: 'This token has expired. Install the app again and copy the new token.',
    account_inactive: 'This Slack account is inactive.',
    not_authed: 'No token was sent.',
    ratelimited: 'Slack is rate limiting this app. Try again in a minute.',
    reconnect_slack: 'The Slack connection expired. Reconnect Slack.',
  };
  const code = redact(e.code);
  return { error: code, hint: hints[code] ?? (code.startsWith('network') ? 'Could not reach slack.com.' : undefined) };
}

export function makeSlackRoutes(over: Partial<SlackRouteDeps> = {}): RouteDef[] {
  const deps: SlackRouteDeps = { ...defaultDeps, ...over };

  const withDb = async <T>(f: (db: Database.Database) => Promise<T> | T): Promise<T> => {
    const db = deps.openDb();
    try {
      return await f(db);
    } finally {
      db.close();
    }
  };

  /** Record what a passing Test learned, and compare against what the features need. */
  function record(db: Database.Database, identity: SlackIdentity, scopes: string[], readonly: boolean) {
    setSetting(db, 'slack_identity', identity);
    setSetting(db, 'slack_scopes_granted', scopes);
    return scopeSummary(scopes, readonly);
  }

  const view = (identity: SlackIdentity, scopes: string[], readonly: boolean, token?: string) => ({
    ok: true,
    identity: { team: identity.team, team_id: identity.team_id, user: identity.user, user_id: identity.user_id, url: identity.url },
    scopes: { list: scopes, ...scopeSummary(scopes, readonly) },
    // Shown as `xoxp-…1a2b`; the token itself is never echoed.
    token: token ? maskToken(token) : undefined,
    tokenSource: slackTokenSource(),
  });

  async function postToken(ctx: RouteCtx): Promise<void> {
    const body = await ctx.body();
    const token = typeof body?.token === 'string' ? body.token.trim() : '';
    if (!token) return ctx.json(400, { ok: false, error: 'missing_token' });
    if (process.env.SLACK_USER_TOKEN?.trim()) {
      return ctx.json(409, { ok: false, error: 'token_from_environment', hint: 'SLACK_USER_TOKEN is set; it wins over a stored token.' });
    }
    if (/^xoxb-/.test(token)) {
      return ctx.json(400, { ok: false, error: 'not_a_user_token', hint: 'This is a bot token. Copy the User OAuth Token, which starts with xoxp-.' });
    }
    if (!/^xoxp-[A-Za-z0-9-]+$/.test(token)) {
      return ctx.json(400, { ok: false, error: 'not_a_slack_token', hint: 'A Slack user token starts with xoxp-.' });
    }
    const readonly = flag(body?.readonly);
    let r: Awaited<ReturnType<typeof authTest>>;
    try {
      r = await deps.authTest({ ...deps.callOpts, token });
    } catch (e) {
      // Nothing is stored when the Test fails.
      return ctx.json(400, { ok: false, ...explain(e) });
    }
    await withDb((db) => {
      storeToken(token, r.identity.team_id);
      record(db, r.identity, r.scopes, readonly);
      setSetting(db, 'slack_mode', 'direct');
      setSetting(db, 'slack_reconnect', '');
    });
    ctx.json(200, view(r.identity, r.scopes, readonly, token));
  }

  async function postTest(ctx: RouteCtx): Promise<void> {
    const body = await ctx.body();
    if (!slackToken()) return ctx.json(409, { ok: false, error: 'not_connected' });
    const readonly = flag(body?.readonly);
    let r: Awaited<ReturnType<typeof authTest>>;
    try {
      r = await deps.authTest({ ...deps.callOpts, token: slackToken() });
    } catch (e) {
      return ctx.json(400, { ok: false, ...explain(e) });
    }
    await withDb((db) => record(db, r.identity, r.scopes, readonly));
    ctx.json(200, view(r.identity, r.scopes, readonly, slackToken()));
  }

  async function postDisconnect(ctx: RouteCtx): Promise<void> {
    if (slackTokenSource() === 'env') {
      return ctx.json(409, { ok: false, error: 'token_from_environment', hint: 'The token comes from SLACK_USER_TOKEN. Unset it in the environment.' });
    }
    await withDb((db) => {
      deleteToken();
      setSetting(db, 'slack_identity', {});
      setSetting(db, 'slack_scopes_granted', []);
      setSetting(db, 'slack_mode', 'off');
      setSetting(db, 'slack_reconnect', '');
    });
    clearTokenCache();
    ctx.json(200, { ok: true, mode: 'off' });
  }

  async function postMode(ctx: RouteCtx): Promise<void> {
    const mode = (await ctx.body())?.mode;
    if (mode !== 'direct' && mode !== 'mcp' && mode !== 'off') return ctx.json(400, { ok: false, error: 'bad_mode' });
    await withDb(async (db) => {
      if (mode === 'direct' && !slackToken()) return ctx.json(409, { ok: false, error: 'not_connected', hint: 'Connect with a token first.' });
      if (mode === 'mcp') {
        const p = await deps.probe(db);
        if (!p.slackMcp.found) {
          return ctx.json(409, { ok: false, error: 'no_slack_mcp', hint: 'No Slack server in `claude mcp list`. Add the Slack connector in Claude Code first.' });
        }
      }
      setSetting(db, 'slack_mode', mode);
      ctx.json(200, { ok: true, mode: effectiveMode(mode, !!slackToken()) });
    });
  }

  async function getStatus(ctx: RouteCtx): Promise<void> {
    const readonly = flag(ctx.url.searchParams.get('readonly'));
    await withDb(async (db) => {
      const setting = getSetting(db, 'slack_mode');
      const identity = getSetting(db, 'slack_identity') as Partial<SlackIdentity>;
      const granted = getSetting(db, 'slack_scopes_granted') as string[];
      const connected = !!slackToken();
      const out: Record<string, unknown> = {
        ok: true,
        setting,
        mode: effectiveMode(setting, connected),
        connected,
        tokenSource: slackTokenSource(),
        identity: identity.team_id ? identity : null,
        scopes: connected && granted.length ? { list: granted, ...scopeSummary(granted, readonly) } : null,
        // Connect Slack: the shared app's client id (public), and why a connection lapsed.
        clientId: (getSetting(db, 'slack_client_id') as string) || null,
        clientIdFromEnv: !!process.env.LOOM_SLACK_CLIENT_ID?.trim(),
        reconnect: connected ? null : (getSetting(db, 'slack_reconnect') as string) || null,
        reconnectHint: connected ? null : (getSetting(db, 'slack_reconnect') as string) ? oauthHint(getSetting(db, 'slack_reconnect') as string) : null,
      };
      const st = ctx.url.searchParams.get('oauth');
      if (st) out.oauth = outcomeOf(st);
      // `claude mcp list` is slow, so the page asks for it only on the Slack step.
      if (flag(ctx.url.searchParams.get('probe'))) {
        const p = await deps.probe(db);
        out.mcp = { found: p.slackMcp.found, connected: p.slackMcp.connected, name: p.slackMcp.name ?? null };
        out.slackApp = p.slackApp;
      }
      ctx.json(200, out);
    });
  }

  /** Connect Slack, step 1: a PKCE pair and a state, and the authorize URL for the page to open. */
  async function postOAuthStart(ctx: RouteCtx): Promise<void> {
    const body = await ctx.body();
    const readonly = flag(body?.readonly);
    if (process.env.SLACK_USER_TOKEN?.trim()) {
      return ctx.json(409, { ok: false, error: 'token_from_environment', hint: 'SLACK_USER_TOKEN is set; it wins over a stored token.' });
    }
    const clientId = await withDb((db) => getSetting(db, 'slack_client_id') as string);
    if (!clientId) return ctx.json(409, { ok: false, error: 'no_client_id', hint: 'Enter the shared Slack app client id first.' });
    const { state, url } = beginAuth({ clientId, port: portOf(ctx), scopes: manifestScopes(readonly), readonly });
    ctx.json(200, { ok: true, url, state });
  }

  /**
   * Connect Slack, step 2: Slack redirects the browser here. It is a top-level
   * navigation from slack.com, so it carries no Loom token or Loom Origin; the
   * guard is the state, a random value only the page that started the flow
   * holds, claimable once within 10 minutes. Anything else is refused before
   * any exchange.
   */
  async function getCallback(ctx: RouteCtx): Promise<void> {
    const q = ctx.url.searchParams;
    const state = q.get('state') ?? '';
    const flow = state ? takeState(state) : null;
    if (!flow) return callbackPage(ctx, 400, false, oauthHint('bad_state'));
    const fail = (code: string, status = 400) => {
      const c = redact(code);
      recordOutcome(state, { state: 'error', error: c, hint: oauthHint(c) });
      callbackPage(ctx, status, false, oauthHint(c));
    };
    const err = q.get('error');
    if (err) return fail(err.replace(/[^a-z0-9_]/gi, '').slice(0, 64) || 'access_denied');
    const code = q.get('code') ?? '';
    if (!code) return fail('invalid_code');
    let grant: OAuthGrant;
    try {
      grant = await deps.exchange({ clientId: flow.clientId, code, verifier: flow.verifier, redirectUri: flow.redirectUri });
    } catch (e) {
      return fail(e instanceof SlackError ? e.code : 'exchange_failed', 502);
    }
    let r: Awaited<ReturnType<typeof authTest>>;
    try {
      r = await deps.authTest({ ...deps.callOpts, token: grant.access_token });
    } catch (e) {
      // Nothing is stored when the Test fails, as with a pasted token.
      return fail(e instanceof SlackError ? e.code : 'auth_test_failed', 502);
    }
    try {
      await withDb((db) => {
        storeGrant(grant, flow.clientId, r.identity.team_id);
        record(db, r.identity, r.scopes, flow.readonly);
        setSetting(db, 'slack_mode', 'direct');
        setSetting(db, 'slack_reconnect', '');
      });
    } catch (e) {
      return fail(e instanceof SlackError ? e.code : 'keychain_failed', 500);
    }
    recordOutcome(state, { state: 'ok' });
    const who = [r.identity.user, r.identity.team].filter(Boolean).join(' in ');
    callbackPage(ctx, 200, true, `Slack connected${who ? ' as ' + who : ''}. You can close this tab and return to Loom.`);
  }

  function getManifest(ctx: RouteCtx): void {
    if (flag(ctx.url.searchParams.get('shared'))) {
      const manifest = buildSharedManifest({ port: preferredPort() });
      return ctx.json(200, { ok: true, shared: true, manifest, text: JSON.stringify(manifest, null, 2), scopes: manifest.oauth_config.scopes.user });
    }
    const readonly = flag(ctx.url.searchParams.get('readonly'));
    const manifest = buildManifest({ fullName: deps.fullName(), readonly });
    ctx.json(200, { ok: true, readonly, manifest, text: JSON.stringify(manifest, null, 2), scopes: manifest.oauth_config.scopes.user });
  }

  return [
    { method: 'POST', path: '/api/slack/token', kind: 'browser', handler: postToken },
    { method: 'POST', path: '/api/slack/test', kind: 'browser', handler: postTest },
    { method: 'POST', path: '/api/slack/disconnect', kind: 'browser', handler: postDisconnect },
    { method: 'POST', path: '/api/slack/mode', kind: 'browser', handler: postMode },
    { method: 'POST', path: '/api/slack/oauth/start', kind: 'browser', handler: postOAuthStart },
    // Slack's redirect back. Guarded by the single-use state, not a Loom token (see getCallback).
    { method: 'GET', path: '/slack/callback', kind: 'read', handler: getCallback },
    // Reads: Host-checked like every request. Neither returns a secret.
    { method: 'GET', path: '/api/slack/manifest', kind: 'read', handler: getManifest },
    { method: 'GET', path: '/api/slack/status', kind: 'read', handler: getStatus },
  ];
}

export const routes: RouteDef[] = makeSlackRoutes();
