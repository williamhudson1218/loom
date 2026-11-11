import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import { keychain } from './secrets.ts';
import { getSetting, setSetting } from './settingsSchema.ts';
import { pkcePair } from './slackoauth.ts';

// "Connect Gmail": Google OAuth for installed apps, so Loom can send email drafts
// and read their threads without an external mail CLI.
//
// The flow mirrors Connect Slack (src/slackoauth.ts): POST /api/google/oauth/start
// makes a PKCE verifier, its S256 challenge and a single-use state, and returns the
// authorize URL; the page opens it in the default browser. Google redirects to the
// loopback address http://127.0.0.1:<port>/google/callback, which claims the state,
// exchanges the code and keeps the refresh token in the Keychain (src/routes/google.ts).
//
// The client is the person's own "Desktop app" OAuth client. Google documents that an
// installed app's client secret cannot be kept confidential, so it lives in settings
// (google_client_secret) like the client id; PKCE is what protects the exchange.
//
// Scopes, the narrowest that cover what Loom does:
//   openid email     the account's address (from the id_token): the "From" and the
//                    address that counts as "me" in the before-send check
//   gmail.send       send a draft (no read access at all)
//   gmail.metadata   threads.get with format=metadata: From, Date, Message-ID,
//                    labels and the snippet for the freshness check and parked
//                    replies. No message bodies or attachments.
// sendAs (alias addresses, signatures) needs gmail.settings.basic or gmail.readonly,
// so the built-in adapter reports the account address only and does not append a
// Gmail signature. Messages the account sent carry the SENT label, which every
// reader already treats as "mine", so aliases still count as the person.

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
export const GOOGLE_CALLBACK_PATH = '/google/callback';
export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.metadata',
] as const;
export const GOOGLE_STATE_TTL_MS = 10 * 60_000;
/** Keychain service for each account's refresh data; the Keychain account is the email address. */
export const GOOGLE_REFRESH_SERVICE = 'Loom Google refresh';
/** The error code once a refresh is refused and the person must connect the account again. */
export const RECONNECT_GMAIL = 'reconnect_gmail';

export class GoogleError extends Error {
  constructor(
    public step: string,
    public code: string,
  ) {
    super(`${step}: ${code}`);
  }
}

/** Google's loopback redirect for desktop clients: any port on 127.0.0.1 is accepted. */
export function googleRedirectUri(port: number): string {
  return `http://127.0.0.1:${port}${GOOGLE_CALLBACK_PATH}`;
}

/* ----------------------------------------------------------- pending flows */

export interface GooglePending {
  verifier: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  createdAt: number;
}
export type GoogleOutcome =
  | { state: 'pending' }
  | { state: 'ok'; email: string }
  | { state: 'error'; error: string; hint?: string }
  | { state: 'unknown' };

const pending = new Map<string, GooglePending>();
const outcomes = new Map<string, { at: number; outcome: GoogleOutcome }>();

function sweep(now: number): void {
  for (const [k, v] of pending) if (now - v.createdAt > GOOGLE_STATE_TTL_MS) pending.delete(k);
  for (const [k, v] of outcomes) if (now - v.at > GOOGLE_STATE_TTL_MS) outcomes.delete(k);
}

/** Start a flow: the state to send, and the authorize URL carrying it. */
export function beginGoogleAuth(p: { clientId: string; clientSecret: string; port: number; loginHint?: string; now?: number }): { state: string; url: string } {
  const now = p.now ?? Date.now();
  sweep(now);
  const { verifier, challenge } = pkcePair();
  const state = randomBytes(24).toString('base64url');
  const redirect = googleRedirectUri(p.port);
  pending.set(state, { verifier, clientId: p.clientId, clientSecret: p.clientSecret, redirectUri: redirect, createdAt: now });
  const q = new URLSearchParams({
    client_id: p.clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    // A refresh token, every time: without prompt=consent Google returns one only on the first grant.
    access_type: 'offline',
    prompt: 'consent select_account',
    ...(p.loginHint ? { login_hint: p.loginHint } : {}),
  });
  return { state, url: `${GOOGLE_AUTH_URL}?${q}` };
}

/** Claim a state once. Unknown, reused and expired states give null. */
export function takeGoogleState(state: string, now = Date.now()): GooglePending | null {
  const p = pending.get(state);
  if (!p) return null;
  pending.delete(state);
  if (now - p.createdAt > GOOGLE_STATE_TTL_MS) return null;
  return p;
}

export function recordGoogleOutcome(state: string, outcome: GoogleOutcome, now = Date.now()): void {
  outcomes.set(state, { at: now, outcome });
}

export function googleOutcomeOf(state: string, now = Date.now()): GoogleOutcome {
  const o = outcomes.get(state);
  if (o && now - o.at <= GOOGLE_STATE_TTL_MS) return o.outcome;
  const p = pending.get(state);
  if (p && now - p.createdAt <= GOOGLE_STATE_TTL_MS) return { state: 'pending' };
  return { state: 'unknown' };
}

export function resetGoogleOAuth(): void {
  pending.clear();
  outcomes.clear();
  tokens.clear();
  inflight.clear();
}

/* --------------------------------------------------------------- exchange */

export interface GoogleGrant {
  access_token: string;
  expires_in?: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
}

const redactG = (s: unknown): string =>
  String(s ?? '')
    .replace(/ya29\.[A-Za-z0-9._-]+/g, 'ya29.…')
    .replace(/1\/\/[A-Za-z0-9._-]+/g, '1//…')
    .slice(0, 200);

async function tokenCall(body: URLSearchParams, step: string, fetchImpl: typeof fetch = fetch): Promise<GoogleGrant> {
  let r: Response;
  let d: Record<string, unknown>;
  try {
    r = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    d = (await r.json()) as Record<string, unknown>;
  } catch (e) {
    throw new GoogleError(step, 'network: ' + redactG((e as Error)?.message ?? e));
  }
  if (!r.ok || typeof d?.access_token !== 'string' || !d.access_token) {
    throw new GoogleError(step, redactG(String(d?.error ?? `http_${r.status}`)).replace(/[^a-z0-9_.: -]/gi, ''));
  }
  return {
    access_token: d.access_token,
    expires_in: typeof d.expires_in === 'number' ? d.expires_in : undefined,
    refresh_token: typeof d.refresh_token === 'string' && d.refresh_token ? d.refresh_token : undefined,
    id_token: typeof d.id_token === 'string' ? d.id_token : undefined,
    scope: typeof d.scope === 'string' ? d.scope : undefined,
  };
}

/** Trade the code for tokens. The verifier proves this is the flow that started. */
export function exchangeGoogleCode(p: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string; fetchImpl?: typeof fetch }): Promise<GoogleGrant> {
  const body = new URLSearchParams({
    client_id: p.clientId,
    ...(p.clientSecret ? { client_secret: p.clientSecret } : {}),
    code: p.code,
    code_verifier: p.verifier,
    redirect_uri: p.redirectUri,
    grant_type: 'authorization_code',
  });
  return tokenCall(body, 'token', p.fetchImpl);
}

/**
 * The email in an id_token straight from Google's token endpoint over TLS. OpenID
 * Connect lets a client that got the token directly from the token endpoint skip
 * the signature check; nothing here trusts an id_token from anywhere else.
 */
export function emailFromIdToken(idToken: string | undefined): string {
  if (!idToken) return '';
  const part = idToken.split('.')[1];
  if (!part) return '';
  try {
    const j = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { email?: unknown; email_verified?: unknown };
    const e = typeof j.email === 'string' ? j.email.trim().toLowerCase() : '';
    return e && j.email_verified !== false ? e : '';
  } catch {
    return '';
  }
}

/** Every scope Loom needs, granted? Google lets a person untick scopes on the consent screen. */
export function missingScopes(granted: string | undefined): string[] {
  const have = new Set((granted ?? '').split(/\s+/).filter(Boolean));
  return GOOGLE_SCOPES.filter((s) => s.startsWith('https://') && !have.has(s)).map((s) => s.split('/').pop()!);
}

/* --------------------------------------------------------------- accounts */

export interface GoogleAccount {
  email: string;
  /** What a draft's `account` names; defaults to the email address. */
  label: string;
  /** Set when a refresh was refused; the account needs connecting again. */
  reconnect?: string;
}

export function listGoogleAccounts(db: Database.Database): GoogleAccount[] {
  return (getSetting(db, 'google_accounts') as GoogleAccount[]).map((a) => ({ ...a }));
}

function writeAccounts(db: Database.Database, list: GoogleAccount[]): void {
  setSetting(db, 'google_accounts', list);
}

/** Add or update an account (by email). A new account goes last; the first one is the default. */
export function saveGoogleAccount(db: Database.Database, a: { email: string; label?: string }): GoogleAccount {
  const list = listGoogleAccounts(db);
  const email = a.email.toLowerCase();
  const i = list.findIndex((x) => x.email === email);
  const next: GoogleAccount = { email, label: (a.label ?? (i >= 0 ? list[i].label : '') ?? '').trim() || email };
  if (i >= 0) list[i] = next;
  else list.push(next);
  writeAccounts(db, list);
  return next;
}

export function setGoogleLabel(db: Database.Database, email: string, label: string): GoogleAccount | null {
  const list = listGoogleAccounts(db);
  const a = list.find((x) => x.email === email.toLowerCase());
  if (!a) return null;
  const l = label.trim() || a.email;
  if (list.some((x) => x !== a && (x.label.toLowerCase() === l.toLowerCase() || x.email === l.toLowerCase()))) {
    throw new GoogleError('label', 'label_in_use');
  }
  a.label = l;
  writeAccounts(db, list);
  return a;
}

/** Move an account to the front: the one a draft with no account sends from. */
export function makeGoogleDefault(db: Database.Database, email: string): boolean {
  const list = listGoogleAccounts(db);
  const i = list.findIndex((x) => x.email === email.toLowerCase());
  if (i < 0) return false;
  list.unshift(...list.splice(i, 1));
  writeAccounts(db, list);
  return true;
}

export function markGoogleReconnect(db: Database.Database, email: string, reason: string): void {
  const list = listGoogleAccounts(db);
  const a = list.find((x) => x.email === email.toLowerCase());
  if (!a) return;
  if (reason) a.reconnect = reason;
  else delete a.reconnect;
  writeAccounts(db, list);
}

export function removeGoogleAccount(db: Database.Database, email: string): boolean {
  const list = listGoogleAccounts(db);
  const next = list.filter((x) => x.email !== email.toLowerCase());
  if (next.length === list.length) return false;
  writeAccounts(db, next);
  deleteGoogleRefresh(email);
  tokens.delete(email.toLowerCase());
  return true;
}

/**
 * The connected account a draft's `account` names: its label or its email,
 * either case. No account named means the default (the first). A name that
 * matches nothing is an error rather than a silent send from another address.
 */
export function resolveGoogleAccount(list: GoogleAccount[], wanted?: string): GoogleAccount {
  if (!list.length) throw new GoogleError('account', 'no_gmail_account');
  const w = (wanted ?? '').trim().toLowerCase();
  if (!w) return list[0];
  const hit = list.find((a) => a.label.toLowerCase() === w || a.email === w);
  if (!hit) throw new GoogleError('account', `no connected Gmail account is labelled "${wanted}"`);
  return hit;
}

/* --------------------------------------------------------------- tokens */

interface RefreshItem {
  refresh_token: string;
  client_id: string;
  client_secret: string;
}

export function storeGoogleRefresh(email: string, item: RefreshItem): void {
  keychain().set(GOOGLE_REFRESH_SERVICE, email.toLowerCase(), JSON.stringify(item));
}

export function readGoogleRefresh(email: string): RefreshItem | null {
  let raw: string | null = null;
  try {
    raw = keychain().get(GOOGLE_REFRESH_SERVICE, email.toLowerCase());
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<RefreshItem>;
    if (typeof d.refresh_token !== 'string' || !d.refresh_token || typeof d.client_id !== 'string') return null;
    return { refresh_token: d.refresh_token, client_id: d.client_id, client_secret: typeof d.client_secret === 'string' ? d.client_secret : '' };
  } catch {
    return null;
  }
}

export function deleteGoogleRefresh(email: string): void {
  try {
    keychain().delete(GOOGLE_REFRESH_SERVICE, email.toLowerCase());
  } catch {
    /* already gone, or the Keychain refused: the account row is removed either way */
  }
}

const tokens = new Map<string, { token: string; exp: number }>();
const inflight = new Map<string, Promise<string>>();
const EARLY_MS = 60_000;

/** Remember an access token the exchange just returned, so the first send does not refresh. */
export function primeGoogleToken(email: string, g: GoogleGrant, now = Date.now()): void {
  tokens.set(email.toLowerCase(), { token: g.access_token, exp: now + (g.expires_in ?? 3600) * 1000 });
}

export interface TokenOpts {
  fetchImpl?: typeof fetch;
  /** Ignore a cached token (Gmail answered 401). */
  force?: boolean;
  now?: () => number;
  /** A refresh was refused: record it so the header and Settings ask for a reconnect. */
  onReconnect?: (email: string, reason: string) => void;
}

/**
 * An access token for the account: the cached one until a minute before it
 * expires, else one refresh. Concurrent callers share that refresh (single
 * flight). A refusal from Google (invalid_grant: revoked, expired, password
 * changed, a Testing-mode client's 7-day limit) marks the account for
 * reconnecting; a network failure marks nothing.
 */
export function googleAccessToken(email: string, opts: TokenOpts = {}): Promise<string> {
  const key = email.toLowerCase();
  const now = opts.now ?? Date.now;
  const hit = tokens.get(key);
  if (!opts.force && hit && hit.exp - now() > EARLY_MS) return Promise.resolve(hit.token);
  const running = inflight.get(key);
  if (running) return running;
  const p = (async () => {
    const rd = readGoogleRefresh(key);
    if (!rd) {
      opts.onReconnect?.(key, 'no_refresh_token');
      throw new GoogleError('refresh', RECONNECT_GMAIL);
    }
    const body = new URLSearchParams({
      client_id: rd.client_id,
      ...(rd.client_secret ? { client_secret: rd.client_secret } : {}),
      refresh_token: rd.refresh_token,
      grant_type: 'refresh_token',
    });
    let g: GoogleGrant;
    try {
      g = await tokenCall(body, 'refresh', opts.fetchImpl);
    } catch (e) {
      const code = e instanceof GoogleError ? e.code : 'refresh_failed';
      if (!code.startsWith('network')) {
        opts.onReconnect?.(key, code);
        tokens.delete(key);
        throw new GoogleError('refresh', RECONNECT_GMAIL);
      }
      throw e;
    }
    // Google may rotate the refresh token; keep the new one when it sends one.
    if (g.refresh_token && g.refresh_token !== rd.refresh_token) storeGoogleRefresh(key, { ...rd, refresh_token: g.refresh_token });
    tokens.set(key, { token: g.access_token, exp: now() + (g.expires_in ?? 3600) * 1000 });
    return g.access_token;
  })();
  inflight.set(key, p);
  return p.finally(() => {
    if (inflight.get(key) === p) inflight.delete(key);
  });
}

/** Best-effort revoke on Disconnect, so the grant leaves the person's Google account too. */
export async function revokeGoogle(email: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const rd = readGoogleRefresh(email);
  if (!rd) return;
  try {
    await fetchImpl(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: rd.refresh_token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    /* offline: the Keychain item is still deleted */
  }
}

/** The words the callback page and Settings use for a Google failure. */
export function googleHint(code: string): string {
  const hints: Record<string, string> = {
    access_denied: 'Google access was not approved. Start Connect Gmail again to retry.',
    bad_state: 'This sign-in link expired or was already used. Start Connect Gmail again from Loom.',
    invalid_grant: 'Google did not accept the sign-in code. Start Connect Gmail again.',
    invalid_client: 'Google does not recognise this client id and secret. Check them in Settings, Outbox.',
    unauthorized_client: 'This Google client cannot use this sign-in. Create it as a Desktop app client.',
    redirect_uri_mismatch: 'Google refused the loopback redirect. The client must be a Desktop app client.',
    no_email: 'Google did not say which account signed in. Start Connect Gmail again.',
    no_refresh_token: 'Google returned no refresh token. Remove Loom at myaccount.google.com/permissions, then connect again.',
    missing_scopes: 'Some permissions were left unticked on the Google screen. Connect again and allow sending and reading message headers.',
    reconnect_gmail: 'The Gmail connection expired or was revoked. Connect the account again in Settings, Outbox.',
    keychain_failed: 'The macOS Keychain did not store the connection. Try again and allow Loom when macOS asks.',
  };
  if (hints[code]) return hints[code];
  if (code.startsWith('network')) return 'Could not reach Google.';
  return 'Google sign-in failed (' + code + '). Start Connect Gmail again.';
}
