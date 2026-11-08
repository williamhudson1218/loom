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
  storeToken,
  type CallOpts,
  type SlackIdentity,
} from '../slackapi.ts';
import { buildManifest, scopeSummary } from '../slackmanifest.ts';
import { effectiveMode } from '../slackmode.ts';
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
};

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
      };
      // `claude mcp list` is slow, so the page asks for it only on the Slack step.
      if (flag(ctx.url.searchParams.get('probe'))) {
        const p = await deps.probe(db);
        out.mcp = { found: p.slackMcp.found, connected: p.slackMcp.connected, name: p.slackMcp.name ?? null };
        out.slackApp = p.slackApp;
      }
      ctx.json(200, out);
    });
  }

  function getManifest(ctx: RouteCtx): void {
    const readonly = flag(ctx.url.searchParams.get('readonly'));
    const manifest = buildManifest({ fullName: deps.fullName(), readonly });
    ctx.json(200, { ok: true, readonly, manifest, text: JSON.stringify(manifest, null, 2), scopes: manifest.oauth_config.scopes.user });
  }

  return [
    { method: 'POST', path: '/api/slack/token', kind: 'browser', handler: postToken },
    { method: 'POST', path: '/api/slack/test', kind: 'browser', handler: postTest },
    { method: 'POST', path: '/api/slack/disconnect', kind: 'browser', handler: postDisconnect },
    { method: 'POST', path: '/api/slack/mode', kind: 'browser', handler: postMode },
    // Reads: Host-checked like every request. Neither returns a secret.
    { method: 'GET', path: '/api/slack/manifest', kind: 'read', handler: getManifest },
    { method: 'GET', path: '/api/slack/status', kind: 'read', handler: getStatus },
  ];
}

export const routes: RouteDef[] = makeSlackRoutes();
