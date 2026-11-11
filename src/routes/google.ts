import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { openDb } from '../db.ts';
import {
  GoogleError,
  beginGoogleAuth,
  emailFromIdToken,
  exchangeGoogleCode,
  googleHint,
  googleOutcomeOf,
  listGoogleAccounts,
  makeGoogleDefault,
  markGoogleReconnect,
  missingScopes,
  primeGoogleToken,
  recordGoogleOutcome,
  removeGoogleAccount,
  revokeGoogle,
  saveGoogleAccount,
  setGoogleLabel,
  storeGoogleRefresh,
  takeGoogleState,
  type GoogleGrant,
} from '../googleoauth.ts';
import { getSetting } from '../settingsSchema.ts';
import { chooseEmailRoute } from '../gmailapi.ts';
import { serverPort } from '../serverport.ts';
import { resolveEmailCli } from '../outboxemail.ts';
import { connectDonePage, returnToLoom } from '../connectreturn.ts';
import { homeTilde } from '../connorigin.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Connect Gmail: start, Google's loopback redirect, status, and per-account
// label / default / disconnect. Every write row is guarded by requireWrite in
// src/routes/index.ts (tests/auth.test.ts sweeps the table). No response, log
// line or settings row carries a token: the refresh token goes to the Keychain.

export interface GoogleRouteDeps {
  openDb(): Database.Database;
  exchange(p: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string }): Promise<GoogleGrant>;
  revoke(email: string): Promise<void>;
  cliExists(p: string): boolean;
}

const defaultDeps: GoogleRouteDeps = {
  openDb: () => openDb(),
  exchange: (p) => exchangeGoogleCode(p),
  revoke: (e) => revokeGoogle(e),
  cliExists: (p) => !!p && fs.existsSync(p),
};

const portOf = (ctx: RouteCtx): number => ctx.req?.socket?.localPort || Number(ctx.url.port) || serverPort();
function callbackPage(ctx: RouteCtx, status: number, ok: boolean, text: string): void {
  const res = ctx.res;
  if (res.headersSent) return;
  const html = connectDonePage({ service: 'Gmail', kind: 'google', ok, text });
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(html);
  if (ok) returnToLoom('google');
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;

export function makeGoogleRoutes(over: Partial<GoogleRouteDeps> = {}): RouteDef[] {
  const deps: GoogleRouteDeps = { ...defaultDeps, ...over };
  const withDb = async <T>(f: (db: Database.Database) => Promise<T> | T): Promise<T> => {
    const db = deps.openDb();
    try {
      return await f(db);
    } finally {
      db.close();
    }
  };

  function statusOf(db: Database.Database) {
    const accounts = listGoogleAccounts(db);
    const clientId = getSetting(db, 'google_client_id') as string;
    const secret = getSetting(db, 'google_client_secret') as string;
    const via = getSetting(db, 'email_via') as string;
    const cliSetting = getSetting(db, 'email_cli', { env: false }) as string;
    const cli = resolveEmailCli(cliSetting);
    const cliOk = !!cli && deps.cliExists(cli);
    return {
      ok: true,
      clientId: clientId || null,
      clientIdFromEnv: !!process.env.LOOM_GOOGLE_CLIENT_ID?.trim(),
      hasSecret: !!secret,
      accounts: accounts.map((a, i) => ({ email: a.email, label: a.label, isDefault: i === 0, reconnect: a.reconnect ?? null, reconnectHint: a.reconnect ? googleHint('reconnect_gmail') : null })),
      via,
      cli: cliOk ? cli : null,
      // The CLI is something Loom found on this Mac; shown with ~ for the home folder.
      cliDisplay: cliOk ? homeTilde(cli) : null,
      route: chooseEmailRoute({ via, gmailAccounts: accounts.length, cli: cliOk ? cli : '' }),
    };
  }

  async function getStatus(ctx: RouteCtx): Promise<void> {
    await withDb((db) => {
      const out: Record<string, unknown> = statusOf(db);
      const st = ctx.url.searchParams.get('oauth');
      if (st) out.oauth = googleOutcomeOf(st);
      ctx.json(200, out);
    });
  }

  async function postStart(ctx: RouteCtx): Promise<void> {
    const body = await ctx.body();
    const hint = typeof body?.email === 'string' && EMAIL_RE.test(body.email) ? body.email : undefined;
    const { clientId, secret } = await withDb((db) => ({ clientId: getSetting(db, 'google_client_id') as string, secret: getSetting(db, 'google_client_secret') as string }));
    if (!clientId) return ctx.json(409, { ok: false, error: 'no_client_id', hint: 'Enter the Google client id and secret first.' });
    const { state, url } = beginGoogleAuth({ clientId, clientSecret: secret, port: portOf(ctx), loginHint: hint });
    ctx.json(200, { ok: true, url, state });
  }

  /**
   * Google's redirect back. A top-level navigation from accounts.google.com, so it
   * carries no Loom token; the guard is the single-use state only the starting page
   * holds. Anything else is refused before any exchange.
   */
  async function getCallback(ctx: RouteCtx): Promise<void> {
    const q = ctx.url.searchParams;
    const state = q.get('state') ?? '';
    const flow = state ? takeGoogleState(state) : null;
    if (!flow) return callbackPage(ctx, 400, false, googleHint('bad_state'));
    const fail = (code: string, status = 400) => {
      const c = code.replace(/[^a-z0-9_:. -]/gi, '').slice(0, 80) || 'failed';
      recordGoogleOutcome(state, { state: 'error', error: c, hint: googleHint(c) });
      callbackPage(ctx, status, false, googleHint(c));
    };
    const err = q.get('error');
    if (err) return fail(err);
    const code = q.get('code') ?? '';
    if (!code) return fail('invalid_grant');
    let g: GoogleGrant;
    try {
      g = await deps.exchange({ clientId: flow.clientId, clientSecret: flow.clientSecret, code, verifier: flow.verifier, redirectUri: flow.redirectUri });
    } catch (e) {
      return fail(e instanceof GoogleError ? e.code : 'exchange_failed', 502);
    }
    const email = emailFromIdToken(g.id_token);
    if (!email) return fail('no_email', 502);
    if (missingScopes(g.scope).length) return fail('missing_scopes');
    if (!g.refresh_token) return fail('no_refresh_token', 502);
    let label = email;
    try {
      storeGoogleRefresh(email, { refresh_token: g.refresh_token, client_id: flow.clientId, client_secret: flow.clientSecret });
      await withDb((db) => {
        label = saveGoogleAccount(db, { email }).label;
        markGoogleReconnect(db, email, '');
      });
    } catch {
      return fail('keychain_failed', 500);
    }
    primeGoogleToken(email, g);
    recordGoogleOutcome(state, { state: 'ok', email });
    callbackPage(ctx, 200, true, `Gmail connected as ${email}${label !== email ? ` (${label})` : ''}. Returning to Loom.`);
  }

  const emailArg = async (ctx: RouteCtx): Promise<{ email: string; body: Record<string, unknown> | null } | null> => {
    const body = await ctx.body();
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!EMAIL_RE.test(email)) {
      ctx.json(400, { ok: false, error: 'bad_email' });
      return null;
    }
    return { email, body };
  };

  async function postDisconnect(ctx: RouteCtx): Promise<void> {
    const a = await emailArg(ctx);
    if (!a) return;
    await deps.revoke(a.email);
    const removed = await withDb((db) => removeGoogleAccount(db, a.email));
    if (!removed) return ctx.json(404, { ok: false, error: 'not_connected' });
    await withDb((db) => ctx.json(200, statusOf(db)));
  }

  async function postAccount(ctx: RouteCtx): Promise<void> {
    const a = await emailArg(ctx);
    if (!a) return;
    await withDb((db) => {
      if (!listGoogleAccounts(db).some((x) => x.email === a.email)) return ctx.json(404, { ok: false, error: 'not_connected' });
      if (typeof a.body?.label === 'string') {
        const l = a.body.label.trim();
        if (l && !/^[A-Za-z0-9_.@+-]{1,64}$/.test(l)) return ctx.json(400, { ok: false, error: 'bad_label', hint: 'A label is letters, digits and . _ - @ +, up to 64.' });
        try {
          setGoogleLabel(db, a.email, l);
        } catch {
          return ctx.json(409, { ok: false, error: 'label_in_use', hint: 'Another connected account already uses that label.' });
        }
      }
      if (a.body?.default === true) makeGoogleDefault(db, a.email);
      ctx.json(200, statusOf(db));
    });
  }

  return [
    { method: 'POST', path: '/api/google/oauth/start', kind: 'browser', handler: postStart },
    { method: 'POST', path: '/api/google/disconnect', kind: 'browser', handler: postDisconnect },
    { method: 'POST', path: '/api/google/account', kind: 'browser', handler: postAccount },
    // Google's redirect back. Guarded by the single-use state, not a Loom token (see getCallback).
    { method: 'GET', path: '/google/callback', kind: 'read', handler: getCallback },
    { method: 'GET', path: '/api/google/status', kind: 'read', handler: getStatus },
  ];
}

export const routes: RouteDef[] = makeGoogleRoutes();
