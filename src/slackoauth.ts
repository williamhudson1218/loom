import { createHash, randomBytes } from 'node:crypto';
import { OAUTH_URL, SlackError, redact, userGrant, type OAuthGrant } from './slackapi.ts';

// "Connect Slack": OAuth v2 with PKCE against ONE shared Slack app, so each
// person gets their own user token without creating an app. A PKCE app is a
// public client: there is no client secret anywhere, and the exchange proves
// itself with the code_verifier instead (docs.slack.dev/authentication/using-pkce).
//
// The flow: POST /api/slack/oauth/start makes a verifier, its S256 challenge and
// a state, remembers {state -> verifier} here for 10 minutes, and returns the
// authorize URL; the page opens it in the user's browser. Slack redirects to
// http://localhost:<port>/slack/callback, which takes the state (single use),
// exchanges the code and stores the token (src/routes/slack.ts).

export const AUTHORIZE_URL = 'https://slack.com/oauth/v2/authorize';
export const CALLBACK_PATH = '/slack/callback';
export const STATE_TTL_MS = 10 * 60_000;

const b64url = (b: Buffer): string => b.toString('base64url');

/** RFC 7636 S256: base64url(sha256(verifier)), unpadded. */
export function challengeFor(verifier: string): string {
  return b64url(createHash('sha256').update(verifier, 'ascii').digest());
}

/** A fresh verifier (43 chars of base64url from 32 random bytes) and its challenge. */
export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: challengeFor(verifier) };
}

export function redirectUri(port: number): string {
  return `http://localhost:${port}${CALLBACK_PATH}`;
}

/* ----------------------------------------------------------- pending flows */

export interface PendingAuth {
  verifier: string;
  readonly: boolean;
  clientId: string;
  redirectUri: string;
  createdAt: number;
}

/** How a started flow ended, for the page polling /api/slack/status?oauth=<state>. */
export type Outcome = { state: 'pending' } | { state: 'ok' } | { state: 'error'; error: string; hint?: string } | { state: 'unknown' };

const pending = new Map<string, PendingAuth>();
const outcomes = new Map<string, { at: number; outcome: Outcome }>();

function sweep(now: number): void {
  for (const [k, v] of pending) if (now - v.createdAt > STATE_TTL_MS) pending.delete(k);
  for (const [k, v] of outcomes) if (now - v.at > STATE_TTL_MS) outcomes.delete(k);
}

/** Start a flow: the state to send, and the authorize URL carrying it. */
export function beginAuth(p: { clientId: string; port: number; scopes: string[]; readonly: boolean; now?: number }): { state: string; url: string } {
  const now = p.now ?? Date.now();
  sweep(now);
  const { verifier, challenge } = pkcePair();
  const state = b64url(randomBytes(24));
  const redirect = redirectUri(p.port);
  pending.set(state, { verifier, readonly: p.readonly, clientId: p.clientId, redirectUri: redirect, createdAt: now });
  const q = new URLSearchParams({
    client_id: p.clientId,
    user_scope: p.scopes.join(','),
    redirect_uri: redirect,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return { state, url: `${AUTHORIZE_URL}?${q}` };
}

/** Claim a state: its flow once, then never again. Unknown, reused and expired states give null. */
export function takeState(state: string, now = Date.now()): PendingAuth | null {
  const p = pending.get(state);
  if (!p) return null;
  pending.delete(state);
  if (now - p.createdAt > STATE_TTL_MS) return null;
  return p;
}

export function recordOutcome(state: string, outcome: Outcome, now = Date.now()): void {
  outcomes.set(state, { at: now, outcome });
}

export function outcomeOf(state: string, now = Date.now()): Outcome {
  const o = outcomes.get(state);
  if (o && now - o.at <= STATE_TTL_MS) return o.outcome;
  const p = pending.get(state);
  if (p && now - p.createdAt <= STATE_TTL_MS) return { state: 'pending' };
  return { state: 'unknown' };
}

/** Tests: forget every flow. */
export function resetOAuthState(): void {
  pending.clear();
  outcomes.clear();
}

/* --------------------------------------------------------------- exchange */

/** POST oauth.v2.access with the code and verifier. No client_secret: this is a public client. */
export async function exchangeCode(p: { clientId: string; code: string; verifier: string; redirectUri: string; fetchImpl?: typeof fetch }): Promise<OAuthGrant> {
  const body = new URLSearchParams({ client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri, grant_type: 'authorization_code' });
  let d: Record<string, unknown>;
  try {
    const r = await (p.fetchImpl ?? fetch)(OAUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    d = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    throw new SlackError('oauth.v2.access', 'network: ' + redact((e as Error)?.message ?? e));
  }
  if (!d?.ok) throw new SlackError('oauth.v2.access', redact(String(d?.error ?? 'exchange_failed')));
  const g = userGrant(d);
  if (!g) throw new SlackError('oauth.v2.access', 'no_user_token');
  return g;
}

/** The words the callback page and the Settings note use for an OAuth failure. */
export function oauthHint(code: string): string {
  const hints: Record<string, string> = {
    access_denied: 'Slack access was not approved. Start Connect Slack again to retry.',
    bad_state: 'This sign-in link expired or was already used. Start Connect Slack again from Loom.',
    invalid_code: 'Slack did not accept the sign-in code. Start Connect Slack again.',
    code_already_used: 'This sign-in code was already used. Start Connect Slack again.',
    bad_redirect_uri: 'The shared Slack app does not list this redirect URL. Ask your Slack admin to add it from the shared-app manifest.',
    invalid_client_id: 'Slack does not recognise this client id. Check it in Settings, Slack.',
    invalid_code_verifier: 'Slack rejected the sign-in proof. Start Connect Slack again.',
    no_user_token: 'Slack returned no user token. The shared app needs user scopes, not bot scopes.',
    invalid_refresh_token: 'The Slack connection expired. Connect Slack again.',
    reconnect_slack: 'The Slack connection expired. Reconnect Slack in Settings, Slack.',
    token_expired: 'The Slack connection expired. Connect Slack again.',
  };
  if (hints[code]) return hints[code];
  if (code.startsWith('network')) return 'Could not reach slack.com.';
  return 'Slack sign-in failed (' + code + '). Start Connect Slack again.';
}
