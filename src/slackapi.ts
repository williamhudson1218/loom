import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.ts';
import { keychain } from './secrets.ts';

// Loom's own Slack Web API client: plain fetch, no SDK, one function per method
// Loom calls. It replaces the shell-outs to the owner's slack CLI and hook
// scripts, so a new user needs nothing but a token.
//
// The token rule: it only ever travels in the Authorization header, never in a
// URL, argv, a child's environment, a file under the Loom home, or an error
// message. Every error this module raises passes through redact().

/* ------------------------------------------------------------------ redaction */

const TOKEN_RE = /xox[abposr]-[A-Za-z0-9-]+/g;
const BEARER_RE = /Bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/** Mask anything that looks like a Slack token or a bearer credential. */
export function redact(s: unknown): string {
  return String(s ?? '').replace(BEARER_RE, 'Bearer [redacted]').replace(TOKEN_RE, (t) => t.slice(0, 5) + '[redacted]');
}

/** How the UI shows a stored token: `xoxp-…1a2b`. */
export function maskToken(token: string): string {
  const prefix = /^xox[a-z]-/.exec(token)?.[0] ?? '';
  return prefix + '…' + token.slice(-4);
}

export class SlackError extends Error {
  constructor(
    readonly method: string,
    readonly code: string,
    readonly status = 0,
    readonly retryAfter = 0,
  ) {
    super(redact(`slack ${method}: ${code}`));
    this.name = 'SlackError';
  }
}

/* ---------------------------------------------------------------- the token */

export const KEYCHAIN_SERVICE = 'Loom Slack token';
export const DEFAULT_ACCOUNT = 'default';
/** The owner's pre-Loom CLI token file. Read only on a migrated install. */
export const LEGACY_TOKEN_PATH = path.join(os.homedir(), '.claude', 'tools', 'slack', 'token.json');

export type TokenSource = 'env' | 'keychain' | 'legacy' | 'none';

export interface TokenConfig {
  /** Keychain account: the team id from the last passing Test, else '' (=> 'default'). */
  account(): string;
  /** Whether the legacy token file may be read (a migrated install). */
  allowLegacy(): boolean;
  legacyPath: string;
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

/**
 * Reads the two settings rows the token order depends on straight from the DB,
 * so this works before (and without) the settings registry. A DB that cannot be
 * opened means no team id and the legacy rule below.
 */
function settingRow(key: string): string | undefined {
  try {
    const db = openDb();
    try {
      return (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

/** The legacy token file is read on a migrated install, or one from before setup_origin existed. */
export function legacyAllowed(setupOrigin: string | undefined): boolean {
  return setupOrigin === undefined || setupOrigin === 'migrated';
}

const defaultConfig: TokenConfig = {
  account() {
    try {
      return String(JSON.parse(settingRow('slack_identity') ?? '{}').team_id ?? '');
    } catch {
      return '';
    }
  },
  // `setup_origin` is written by the migration ('migrated') or the wizard ('new').
  // Unset means an install from before either existed, which is the owner's
  // existing setup: it keeps reading its token file until it is migrated.
  allowLegacy() {
    if (process.env.VITEST) return false; // never the owner's real token file from a test run
    return legacyAllowed(settingRow('setup_origin'));
  },
  legacyPath: LEGACY_TOKEN_PATH,
};

let config: TokenConfig = defaultConfig;
export function configureToken(c: Partial<TokenConfig> | null): void {
  config = c ? { ...defaultConfig, ...c } : defaultConfig;
  clearTokenCache();
}

const CACHE_MS = 5 * 60_000;
let memo: { at: number; token: string; source: TokenSource } | null = null;

export function clearTokenCache(): void {
  memo = null;
}

function resolve(): { token: string; source: TokenSource } {
  const env = process.env.SLACK_USER_TOKEN?.trim();
  if (env) return { token: env, source: 'env' };
  const team = config.account();
  for (const account of team ? [team, DEFAULT_ACCOUNT] : [DEFAULT_ACCOUNT]) {
    try {
      const tok = keychain().get(KEYCHAIN_SERVICE, account)?.trim();
      if (tok) return { token: tok, source: 'keychain' };
    } catch {
      /* a locked or denied Keychain reads as no token; the reason is not the token */
    }
  }
  if (config.allowLegacy()) {
    const tok = readJson<{ user_token?: string }>(config.legacyPath, {}).user_token?.trim();
    if (tok) return { token: tok, source: 'legacy' };
  }
  return { token: '', source: 'none' };
}

function cached(): { token: string; source: TokenSource } {
  // The env var is read live so a test or a shell override takes effect at once.
  if (process.env.SLACK_USER_TOKEN?.trim()) return { token: process.env.SLACK_USER_TOKEN.trim(), source: 'env' };
  if (!memo || Date.now() - memo.at > CACHE_MS) memo = { at: Date.now(), ...resolve() };
  return memo;
}

/** The Slack user token, or '' when none resolves. Never log the result. */
export function slackToken(): string {
  return cached().token;
}

/** Where the token comes from, for Settings ("token from environment" has no Replace). */
export function slackTokenSource(): TokenSource {
  return cached().source;
}

/** The token, or throw a redacted error naming the fix. */
export function requireToken(): string {
  const t = slackToken();
  if (!t) throw new SlackError('token', 'not_connected');
  return t;
}

/** Store a token that has passed a Test. `account` is the team id from auth.test. */
export function storeToken(token: string, account: string = DEFAULT_ACCOUNT): void {
  if (!/^xox[a-z]-/.test(token)) throw new SlackError('token', 'not_a_slack_token');
  keychain().set(KEYCHAIN_SERVICE, account || DEFAULT_ACCOUNT, token);
  // A token stored before the first Test sits under 'default'; once it has a team, drop that copy.
  if (account && account !== DEFAULT_ACCOUNT) {
    try {
      keychain().delete(KEYCHAIN_SERVICE, DEFAULT_ACCOUNT);
    } catch {
      /* stale default copy: harmless */
    }
  }
  clearTokenCache();
}

/** Disconnect: remove the Keychain item(s). The legacy file is the owner's and is left alone. */
export function deleteToken(account: string = config.account()): void {
  for (const a of new Set([account || DEFAULT_ACCOUNT, DEFAULT_ACCOUNT])) keychain().delete(KEYCHAIN_SERVICE, a);
  clearTokenCache();
}

/* ------------------------------------------------------------------- calling */

export interface CallOpts {
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

type Params = Record<string, string | number | boolean | undefined>;

interface Raw {
  ok: boolean;
  error?: string;
  [k: string]: unknown;
}

interface CallResult<T> {
  data: T & Raw;
  headers: Headers | null;
}

/**
 * One Web API call. Reads go as GET with query params; writes as a JSON POST.
 * The token is in the Authorization header only. Network and HTTP failures
 * become a SlackError whose text is redacted.
 */
async function call<T = Record<string, unknown>>(method: string, params: Params, opts: CallOpts = {}, write = false): Promise<CallResult<T>> {
  const token = opts.token ?? requireToken();
  const doFetch = opts.fetchImpl ?? fetch;
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]));
  const url = 'https://slack.com/api/' + method + (write || !Object.keys(clean).length ? '' : '?' + new URLSearchParams(clean));
  let r: Response;
  try {
    r = await doFetch(url, {
      method: write ? 'POST' : 'GET',
      headers: write ? { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json; charset=utf-8' } : { Authorization: 'Bearer ' + token },
      body: write ? JSON.stringify(params) : undefined,
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (e) {
    throw new SlackError(method, 'network: ' + redact((e as Error)?.message ?? e));
  }
  if (r.status === 429) throw new SlackError(method, 'ratelimited', 429, Number(r.headers?.get?.('retry-after') ?? 0) || 0);
  let d: T & Raw;
  try {
    d = (await r.json()) as T & Raw;
  } catch {
    throw new SlackError(method, `HTTP ${r.status}`, r.status);
  }
  if (!d || !d.ok) throw new SlackError(method, redact(d?.error ?? `HTTP ${r.status}`), r.status);
  return { data: d, headers: r.headers ?? null };
}

/* ------------------------------------------------------------------- methods */

export interface SlackIdentity {
  team_id: string;
  team: string;
  user_id: string;
  user: string;
  url: string; // https://<workspace>.slack.com/
}

/** auth.test: who the token is, and (from x-oauth-scopes) what it may do. */
export async function authTest(opts: CallOpts = {}): Promise<{ identity: SlackIdentity; scopes: string[] }> {
  const { data, headers } = await call<{ team_id?: string; team?: string; user_id?: string; user?: string; url?: string }>('auth.test', {}, opts);
  const scopes = String(headers?.get?.('x-oauth-scopes') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    identity: { team_id: data.team_id ?? '', team: data.team ?? '', user_id: data.user_id ?? '', user: data.user ?? '', url: data.url ?? '' },
    scopes,
  };
}

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  username?: string;
  bot_id?: string;
  subtype?: string;
  thread_ts?: string;
  reply_count?: number;
  blocks?: unknown;
  files?: { id: string; name?: string; mimetype?: string }[];
}

interface Page {
  messages?: SlackMessage[];
  has_more?: boolean;
  response_metadata?: { next_cursor?: string };
}

/** conversations.history: newest-first pages, followed up to `maxPages`. */
export async function conversationsHistory(channel: string, p: { oldest?: string; latest?: string; limit?: number; maxPages?: number } = {}, opts: CallOpts = {}): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor = '';
  for (let i = 0; i < (p.maxPages ?? 1); i++) {
    const { data } = await call<Page>('conversations.history', { channel, limit: p.limit ?? 100, oldest: p.oldest, latest: p.latest, cursor }, opts);
    out.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor ?? '';
    if (!data.has_more || !cursor) break;
  }
  return out;
}

/** conversations.replies: a thread, root first. */
export async function conversationsReplies(channel: string, ts: string, p: { limit?: number; oldest?: string; maxPages?: number } = {}, opts: CallOpts = {}): Promise<SlackMessage[]> {
  const out: SlackMessage[] = [];
  let cursor = '';
  for (let i = 0; i < (p.maxPages ?? 1); i++) {
    const { data } = await call<Page>('conversations.replies', { channel, ts, limit: p.limit ?? 200, oldest: p.oldest, cursor }, opts);
    out.push(...(data.messages ?? []));
    cursor = data.response_metadata?.next_cursor ?? '';
    if (!data.has_more || !cursor) break;
  }
  return out;
}

export interface Conversation {
  id: string;
  name?: string;
  is_channel?: boolean;
  is_group?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  user?: string; // the other person, for an IM
}

export async function conversationsInfo(channel: string, opts: CallOpts = {}): Promise<Conversation> {
  const { data } = await call<{ channel?: Conversation }>('conversations.info', { channel }, opts);
  return data.channel ?? { id: channel };
}

/** conversations.list, every page (up to `maxPages`), for the watcher channel picker. */
export async function conversationsList(p: { types?: string; excludeArchived?: boolean; maxPages?: number } = {}, opts: CallOpts = {}): Promise<Conversation[]> {
  const out: Conversation[] = [];
  let cursor = '';
  for (let i = 0; i < (p.maxPages ?? 20); i++) {
    const { data } = await call<{ channels?: Conversation[]; response_metadata?: { next_cursor?: string } }>(
      'conversations.list',
      { types: p.types ?? 'public_channel,private_channel', exclude_archived: p.excludeArchived ?? true, limit: 200, cursor },
      opts,
    );
    out.push(...(data.channels ?? []));
    cursor = data.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return out;
}

export interface SlackUser {
  id: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  profile?: { display_name?: string; real_name?: string; image_48?: string };
}

/** The name Slack shows for a person: display name, then real name, then handle. */
export function userLabel(u: SlackUser): string {
  return u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id;
}

/** The handle a DM label uses (`@handle`): display name, else the account name, as the thread hook always did. */
export function dmHandle(u: SlackUser): string {
  return u.profile?.display_name || u.name || '';
}

export async function usersList(p: { maxPages?: number } = {}, opts: CallOpts = {}): Promise<SlackUser[]> {
  const out: SlackUser[] = [];
  let cursor = '';
  for (let i = 0; i < (p.maxPages ?? 12); i++) {
    const { data } = await call<{ members?: SlackUser[]; response_metadata?: { next_cursor?: string } }>('users.list', { limit: 200, cursor }, opts);
    out.push(...(data.members ?? []));
    cursor = data.response_metadata?.next_cursor ?? '';
    if (!cursor) break;
  }
  return out;
}

export async function usersInfo(user: string, opts: CallOpts = {}): Promise<SlackUser> {
  const { data } = await call<{ user?: SlackUser }>('users.info', { user }, opts);
  return data.user ?? { id: user };
}

/** emoji.list: name -> image url, or `alias:<name>`. */
export async function emojiList(opts: CallOpts = {}): Promise<Record<string, string>> {
  const { data } = await call<{ emoji?: Record<string, unknown> }>('emoji.list', {}, opts);
  return Object.fromEntries(Object.entries(data.emoji ?? {}).filter(([, v]) => typeof v === 'string')) as Record<string, string>;
}

export async function chatGetPermalink(channel: string, messageTs: string, opts: CallOpts = {}): Promise<string> {
  const { data } = await call<{ permalink?: string }>('chat.getPermalink', { channel, message_ts: messageTs }, opts);
  return data.permalink ?? '';
}

export async function filesInfo(file: string, opts: CallOpts = {}): Promise<Record<string, unknown>> {
  const { data } = await call<{ file?: Record<string, unknown> }>('files.info', { file }, opts);
  return data.file ?? {};
}

/* ------------------------------------------------- write methods (Outbox, T11) */
// Only ever reached from an explicit click (Outbox Send) or `loom thread stage
// --react`. Nothing in this module calls them on its own.

export async function chatPostMessage(p: { channel: string; text: string; thread_ts?: string; unfurl_links?: boolean; unfurl_media?: boolean }, opts: CallOpts = {}): Promise<{ channel: string; ts: string }> {
  const { data } = await call<{ channel?: string; ts?: string }>('chat.postMessage', p, opts, true);
  return { channel: data.channel ?? p.channel, ts: data.ts ?? '' };
}

/** Open (or find) a DM / group DM. `users` is a comma-separated id list. */
export async function conversationsOpen(users: string, opts: CallOpts = {}): Promise<string> {
  const { data } = await call<{ channel?: { id?: string } }>('conversations.open', { users }, opts, true);
  return data.channel?.id ?? '';
}

export async function reactionsAdd(channel: string, timestamp: string, name: string, opts: CallOpts = {}): Promise<void> {
  await call('reactions.add', { channel, timestamp, name }, opts, true);
}

export async function reactionsRemove(channel: string, timestamp: string, name: string, opts: CallOpts = {}): Promise<void> {
  await call('reactions.remove', { channel, timestamp, name }, opts, true);
}

/** Step 1 of an upload: where to PUT the bytes. (files.getUploadURLExternal takes form params.) */
export async function filesGetUploadURLExternal(filename: string, length: number, opts: CallOpts = {}): Promise<{ upload_url: string; file_id: string }> {
  const { data } = await call<{ upload_url?: string; file_id?: string }>('files.getUploadURLExternal', { filename, length }, opts);
  return { upload_url: data.upload_url ?? '', file_id: data.file_id ?? '' };
}

/** Step 3 of an upload: share the uploaded files into a channel/thread. */
export async function filesCompleteUploadExternal(
  p: { files: { id: string; title?: string }[]; channel_id?: string; thread_ts?: string; initial_comment?: string },
  opts: CallOpts = {},
): Promise<Record<string, unknown>> {
  const { data } = await call('files.completeUploadExternal', p as unknown as Params, opts, true);
  return data;
}

/* -------------------------------------------------------- scopes per feature */

const HISTORY = ['channels:history', 'groups:history', 'im:history', 'mpim:history'];
const READ = ['channels:read', 'groups:read', 'im:read', 'mpim:read'];

/** The user scopes each method needs (§5.3). auth.test and chat.getPermalink need none. */
export const METHOD_SCOPES: Record<string, string[]> = {
  'auth.test': [],
  'conversations.history': HISTORY,
  'conversations.replies': HISTORY,
  'conversations.info': READ,
  'conversations.list': READ,
  'users.list': ['users:read'],
  'users.info': ['users:read'],
  'emoji.list': ['emoji:read'],
  'chat.postMessage': ['chat:write'],
  'chat.getPermalink': [],
  'conversations.open': ['im:write', 'mpim:write'],
  'files.getUploadURLExternal': ['files:write'],
  'files.completeUploadExternal': ['files:write'],
  'files.info': ['files:read'],
  'reactions.add': ['reactions:write'],
  'reactions.remove': ['reactions:write'],
  'search.messages': ['search:read'],
};

/** What each Loom feature calls. The manifest generator and the Test summary read this. */
export const FEATURE_METHODS: Record<string, string[]> = {
  identity: ['auth.test'],
  watchers: ['conversations.history', 'chat.getPermalink'],
  parked: ['conversations.replies'],
  previews: ['conversations.replies', 'files.info'],
  labels: ['conversations.info', 'conversations.list', 'users.info'],
  directory: ['users.list', 'emoji.list'],
  send: ['chat.postMessage', 'chat.getPermalink'],
  dm: ['conversations.open'],
  uploads: ['files.getUploadURLExternal', 'files.completeUploadExternal'],
  reactions: ['reactions.add', 'reactions.remove'],
  search: ['search.messages'],
};

/** Features that only read. A read-only manifest asks for exactly these scopes. */
export const READ_FEATURES = ['identity', 'watchers', 'parked', 'previews', 'labels', 'directory', 'search'];

export function scopesFor(features: string[] = Object.keys(FEATURE_METHODS)): string[] {
  const s = new Set<string>();
  for (const f of features) for (const m of FEATURE_METHODS[f] ?? []) for (const sc of METHOD_SCOPES[m] ?? []) s.add(sc);
  return [...s].sort();
}

export interface ScopeReport {
  granted: number; // of the required ones
  required: number;
  missing: string[];
  /** Per feature: the scopes it still lacks (empty = works). */
  features: Record<string, string[]>;
}

/** Compare what auth.test reported against what the enabled features need. */
export function compareScopes(granted: string[], features: string[] = Object.keys(FEATURE_METHODS)): ScopeReport {
  const have = new Set(granted);
  const required = scopesFor(features);
  const missing = required.filter((s) => !have.has(s));
  const per: Record<string, string[]> = {};
  for (const f of features) per[f] = scopesFor([f]).filter((s) => !have.has(s));
  return { granted: required.length - missing.length, required: required.length, missing, features: per };
}

/* ------------------------------------------------------------ text rendering */

/** `<@U123>` -> `@Name` for every user the map knows; everything else unchanged (as the old CLI did). */
export function renderMentions(text: string, users: Record<string, string>): string {
  let out = text;
  let from = 0;
  for (;;) {
    const at = out.indexOf('<@', from);
    if (at < 0) break;
    const end = out.indexOf('>', at);
    if (end < 0) break;
    const id = out.slice(at + 2, end).split('|')[0];
    const name = users[id];
    if (name) {
      const rep = '@' + name;
      out = out.slice(0, at) + rep + out.slice(end + 1);
      from = at + rep.length;
    } else from = end + 1;
  }
  return out;
}

/** `#name` for a channel, `@person` for a DM (given the person's label), null when Slack gave nothing usable. */
export function conversationLabel(c: Conversation, personLabel?: string): string | null {
  if (c.is_im) return personLabel ? '@' + personLabel : null;
  return c.name ? '#' + c.name : null;
}
