import type http from 'node:http';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb as realOpenDb } from '../db.ts';
import { legacyStateDir, listDrafts, readOutbox, type Draft, type StoreOpts } from '../outbox.ts';
import { readThreads, type ThreadRec } from '../slack.ts';
import { reactionsAdd, reactionsRemove, chatPostMessage, SlackError, type CallOpts } from '../slackapi.ts';
import { SLACK_OFF, slackFeatureOn } from '../slackmode.ts';
import { ensureThreadState, recentAcks, type ThreadStateRow } from '../slackowner.ts';
import { getSetting } from '../settingsSchema.ts';
import fs from 'node:fs';
import { isViewSession, tmux } from '../tmux.ts';
import { gotoPane } from '../goto.ts';
import { currentTerminal, insideLoading, type InsideLoading } from '../terminal.ts';
import { attachGhosttyTabs } from '../ghostty.ts';
import { pretrustFolder } from '../orchstart.ts';
import { nameNewPanes } from '../panenames.ts';
import { addTestLink, listTestLinks } from '../testlinks.ts';
import { heldCount, holdLinks, parseLinksInput, resolveHeldLinks } from '../pendinglinks.ts';
import type { RouteCtx, RouteDef, Verdict } from './index.ts';

// The plugin's `loom` CLI and hooks (§4.3). Every route here is kind 'cli' (§13):
// Loom's own Host, no Origin, and `x-loom-cli-token` from $LOOM_HOME/cli-token.
// Writes never come through here: they are event files (src/events.ts). These are
// the reads the CLI needs, and the few Slack actions only Loom can make because
// only Loom holds the token (D17). Each Slack action answers 409 `slack_off`
// unless Slack is connected in direct mode.
//
// Every entry is gated by requireWrite(kind) in src/routes/index.ts before its
// handler runs; tests/auth.test.ts sweeps this list, so a route cannot skip it.

/** What the CLI handlers need from the running server. server.ts fills it in (setCliDeps); tests pass fakes. */
export interface CliDeps {
  openDb(): Database.Database;
  outbox: StoreOpts;
  /** The board's chats and live panes, for titles, transcripts and pane lookups. */
  chats(): { session_id: string; title: string; jsonl_path: string; project_dir: string }[];
  live(): { session_id: string; pane_id: string; cwd?: string }[];
  /** Named panes on Loom's tmux socket. */
  panes(): NamedPane[];
  /** Type `text` into a pane, then Enter as its own key. */
  deliver(paneId: string, text: string): { ok: boolean; detail: string };
  /** The old hook's thread state (a fallback while it may still be written). */
  legacyThreads(): Record<string, ThreadRec>;
  slackOn(): boolean;
  slack: CallOpts;
  /** Run a tmux command on Loom's socket (argv, never a shell). */
  tmux(args: string[]): string;
  /** Bring a pane forward in the user's terminal (the `terminal` setting decides how). */
  goto(paneId: string, session: string): { ok: boolean; detail: string };
  /** True when the user's terminal is Ghostty, so an unattached session needs a tab attached. */
  ghostty(): boolean;
  /** Attach a Ghostty tab to a session. */
  attachTab(session: string): { ok: boolean; detail: string };
  /** Loom's own window's loading screen, when the terminal is Loom's own and its window is there; null otherwise. */
  loading(): InsideLoading | null;
  pretrust(dir: string): void;
  /** Give any unnamed workspace pane its @name. */
  namePanes(): void;
  dirExists(dir: string): boolean;
}

export interface NamedPane {
  pane_id: string;
  name: string;
  target: string;
  command: string;
  topic: string;
  path: string;
}

/** list-panes over Loom's socket: every pane that carries an @name. */
export function tmuxNamedPanes(run: (args: string[]) => string = (a) => tmux(a)): NamedPane[] {
  let out = '';
  try {
    out = run(['list-panes', '-a', '-F', '#{pane_id}\t#{@name}\t#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{@topic}\t#{pane_current_path}']);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f.length >= 6 && f[0].startsWith('%') && f[1])
    .map(([pane_id, name, target, command, topic, p]) => ({ pane_id, name, target, command, topic, path: p }));
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** The tmux-route delivery: the text literally, a short wait, then Enter as a separate key. */
export function tmuxDeliver(paneId: string, text: string, run: (args: string[]) => string = (a) => tmux(a)): { ok: boolean; detail: string } {
  try {
    run(['send-keys', '-t', paneId, '-l', text]);
    sleepSync(250);
    run(['send-keys', '-t', paneId, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  return { ok: true, detail: 'delivered' };
}

// Under vitest the tmux defaults are off: a test that forgot to stub them must not
// list, or type into, the developer's own panes on the default socket.
const inTests = !!process.env.VITEST;
function failInTests(): never {
  throw new Error('tmux is off under tests');
}
let deps: CliDeps = {
  openDb: () => realOpenDb(),
  outbox: {},
  chats: () => [],
  live: () => [],
  panes: () => (inTests ? [] : tmuxNamedPanes()),
  deliver: (p, t) => (inTests ? { ok: false, detail: 'tmux delivery is off under tests' } : tmuxDeliver(p, t)),
  legacyThreads: () => (legacyStateDir() ? readThreads(path.join(legacyStateDir(), 'slack-threads.json')) : {}),
  slackOn: () => slackFeatureOn('react'),
  slack: {},
  tmux: (a) => (inTests ? failInTests() : tmux(a)),
  goto: (p, s) => (inTests ? { ok: false, detail: 'focus is off under tests' } : gotoPane(p, s)),
  ghostty: () => !inTests && currentTerminal() === 'ghostty',
  attachTab: (s) => {
    const r = attachGhosttyTabs([s]);
    return { ok: r.ok, detail: r.detail };
  },
  loading: () => (inTests || currentTerminal() !== 'inside' ? null : insideLoading()),
  pretrust: (d) => void pretrustFolder(d),
  namePanes: () => void nameNewPanes(),
  dirExists: (d) => {
    try {
      return fs.statSync(d).isDirectory();
    } catch {
      return false;
    }
  },
};

/** server.ts wires the live snapshot in; tests override any part. Returns the previous deps. */
export function setCliDeps(over: Partial<CliDeps>): CliDeps {
  const prev = deps;
  deps = { ...deps, ...over };
  return prev;
}

const withDb = <T>(f: (db: Database.Database) => T): T => {
  const db = deps.openDb();
  try {
    return f(db);
  } finally {
    db.close();
  }
};

/* ------------------------------------------------------------------ threads */

export interface CliThread {
  key: string;
  url: string;
  session_id: string;
  stage: string;
  react: boolean | null;
  ack: { text: string; at: number } | null;
  recent_acks: string[];
  title: string;
  cwd: string;
  transcript_path: string;
}

/** Owned threads, Loom's table first and the old hook's file as a fallback, with stage and ack. */
export function cliThreads(db: Database.Database, filter: { key?: string; session?: string }): CliThread[] {
  ensureThreadState(db);
  const rows = db.prepare(`SELECT thread_key, url, session_id, project_dir FROM slack_threads WHERE session_id != ''`).all() as
    { thread_key: string; url: string; session_id: string; project_dir: string }[];
  const owners = new Map<string, { url: string; session_id: string; cwd: string }>();
  for (const [key, rec] of Object.entries(deps.legacyThreads())) if (rec?.session_id) owners.set(key, { url: rec.url, session_id: rec.session_id, cwd: rec.cwd ?? '' });
  for (const r of rows) owners.set(r.thread_key, { url: r.url, session_id: r.session_id, cwd: r.project_dir });
  const states = new Map((db.prepare(`SELECT * FROM slack_thread_state`).all() as ThreadStateRow[]).map((s) => [s.thread_key, s]));
  const chats = new Map(deps.chats().map((c) => [c.session_id, c]));
  const recent = recentAcks(db);
  const keys = filter.key ? [filter.key] : [...owners.keys()];
  const out: CliThread[] = [];
  for (const key of keys) {
    const o = owners.get(key);
    const st = states.get(key);
    if (!o && !st) continue;
    if (filter.session && o?.session_id !== filter.session) continue;
    const chat = o ? chats.get(o.session_id) : undefined;
    out.push({
      key,
      url: o?.url ?? '',
      session_id: o?.session_id ?? '',
      stage: st?.stage ?? '',
      react: st?.react === null || st?.react === undefined ? null : st.react === 1,
      ack: st?.ack_text ? { text: st.ack_text, at: st.ack_at } : null,
      recent_acks: recent,
      title: chat?.title ?? '',
      cwd: o?.cwd || chat?.project_dir || '',
      transcript_path: chat?.jsonl_path ?? '',
    });
  }
  return out.sort((a, b) => a.key.localeCompare(b.key));
}

/* ------------------------------------------------------------------ handlers */

const KEY_RE = /^[A-Z0-9]+\/\d{10}\.\d{6}$/;
const EMOJI_RE = /^[a-z0-9_+'-]{1,64}$/;

/** The CLI-facing shape of a draft: what `loom outbox list --json` prints. */
const cliDraft = (d: Draft) => {
  const { label: _l, stale: _s, stale_reason: _r, ...rest } = d;
  return rest;
};

function getThreads(ctx: RouteCtx): void {
  const key = ctx.url.searchParams.get('key') ?? '';
  const session = ctx.url.searchParams.get('session') ?? '';
  if (key && !KEY_RE.test(key)) return ctx.json(400, { ok: false, error: 'bad_key' });
  ctx.json(200, { ok: true, threads: withDb((db) => cliThreads(db, { key: key || undefined, session: session || undefined })) });
}

function getOutbox(ctx: RouteCtx): void {
  const all = ctx.url.searchParams.get('all') === '1';
  const keep = withDb((db) => getSetting(db, 'outbox_keep_days'));
  ctx.json(200, { ok: true, drafts: listDrafts(deps.outbox, all, keep).map(cliDraft) });
}

function getShipLabels(ctx: RouteCtx): void {
  const session = ctx.url.searchParams.get('session') ?? '';
  const rows = withDb(
    (db) =>
      (session
        ? db.prepare(`SELECT session_id, repo, label, updated_at FROM ship_labels WHERE session_id = ? ORDER BY updated_at`).all(session)
        : db.prepare(`SELECT session_id, repo, label, updated_at FROM ship_labels ORDER BY updated_at`).all()) as
        { session_id: string; repo: string; label: string; updated_at: number }[],
  );
  // One label per chat, the newest: the shape the old hook's file had.
  const labels: Record<string, { label: string; repo: string; at: number }> = {};
  for (const r of rows) labels[r.session_id] = { label: r.label, repo: r.repo, at: r.updated_at };
  ctx.json(200, { ok: true, labels });
}

function getTestLinks(ctx: RouteCtx): void {
  const session = ctx.url.searchParams.get('session') ?? '';
  if (!session) return ctx.json(400, { ok: false, detail: 'session is required' });
  ctx.json(200, { ok: true, links: withDb((db) => listTestLinks(db, session)) });
}

function getRoute(ctx: RouteCtx): void {
  ctx.json(200, { ok: true, panes: deps.panes().map(({ path: _p, ...p }) => p) });
}

const isClaude = (command: string) => /^\d+\.\d+\.\d+/.test(command);
const isShell = (command: string) => ['zsh', 'bash', 'sh', 'fish', '-zsh', '-bash'].includes(command);
export const ROUTE_MAX = 1000;

async function postRouteSend(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  const to = typeof b?.to === 'string' ? b.to.trim() : '';
  const from = typeof b?.pane === 'string' ? b.pane : '';
  const text = typeof b?.text === 'string' ? b.text.replace(/\s*\n\s*/g, ' ').trim() : '';
  if (!to || !text) return ctx.json(400, { ok: false, detail: 'to and text are required' });
  if (text.length > ROUTE_MAX) return ctx.json(400, { ok: false, detail: `text is over ${ROUTE_MAX} characters; write it to a file and send a pointer` });
  const panes = deps.panes();
  const hits = panes.filter((p) => p.name === to);
  if (!hits.length) return ctx.json(404, { ok: false, detail: `no pane named ${to}; live names: ${panes.map((p) => p.name).join(', ') || 'none'}` });
  if (hits.length > 1) return ctx.json(409, { ok: false, detail: `${hits.length} panes are named ${to}: ${hits.map((p) => p.pane_id).join(', ')}` });
  const p = hits[0];
  if (from && p.pane_id === from) return ctx.json(409, { ok: false, detail: `${to} is your own pane` });
  if (!isClaude(p.command) && !isShell(p.command)) return ctx.json(409, { ok: false, detail: `${to} is running ${p.command}; not typing into it` });
  const r = deps.deliver(p.pane_id, text);
  ctx.json(r.ok ? 200 : 500, { ok: r.ok, detail: r.ok ? `delivered to ${to} (${p.pane_id})` : r.detail });
}

function getWhoami(ctx: RouteCtx): void {
  const pane = ctx.url.searchParams.get('pane') ?? '';
  const session = ctx.url.searchParams.get('session') ?? '';
  const live = deps.live();
  const loc = (pane && live.find((l) => l.pane_id === pane)) || (session && live.find((l) => l.session_id === session)) || null;
  const paneId = pane || loc?.pane_id || '';
  const named = paneId ? deps.panes().find((p) => p.pane_id === paneId) : undefined;
  const sid = session || loc?.session_id || '';
  const chat = sid ? deps.chats().find((c) => c.session_id === sid) : undefined;
  ctx.json(200, { ok: true, name: named?.name ?? '', pane_id: paneId, session: sid, project: chat?.project_dir || loc?.cwd || named?.path || '' });
}

const slackErr = (e: unknown) => (e instanceof SlackError ? e.code : (e as Error).message);

async function postReact(ctx: RouteCtx): Promise<void> {
  if (!deps.slackOn()) return ctx.json(409, { ok: false, error: SLACK_OFF });
  const b = await ctx.body();
  const channel = typeof b?.channel === 'string' ? b.channel : '';
  const ts = typeof b?.ts === 'string' ? b.ts : '';
  const add = typeof b?.add === 'string' ? b.add : '';
  const remove = Array.isArray(b?.remove) ? (b!.remove as unknown[]).filter((x): x is string => typeof x === 'string') : [];
  if (!/^[A-Z0-9]+$/.test(channel) || !/^\d{10}\.\d{6}$/.test(ts)) return ctx.json(400, { ok: false, error: 'bad_target' });
  if ((add && !EMOJI_RE.test(add)) || remove.some((x) => !EMOJI_RE.test(x))) return ctx.json(400, { ok: false, error: 'bad_emoji' });
  for (const name of remove) {
    try {
      await reactionsRemove(channel, ts, name, deps.slack);
    } catch (e) {
      if (slackErr(e) !== 'no_reaction') return ctx.json(502, { ok: false, error: slackErr(e) });
    }
  }
  if (add) {
    try {
      await reactionsAdd(channel, ts, add, deps.slack);
    } catch (e) {
      if (slackErr(e) !== 'already_reacted') return ctx.json(502, { ok: false, error: slackErr(e) });
    }
  }
  ctx.json(200, { ok: true });
}

/** An in-thread reply (the ticket ack). Replies only: no top-level posts, no DMs opened. */
async function postReply(ctx: RouteCtx): Promise<void> {
  if (!deps.slackOn()) return ctx.json(409, { ok: false, error: SLACK_OFF });
  const b = await ctx.body();
  const channel = typeof b?.channel === 'string' ? b.channel : '';
  const thread = typeof b?.thread_ts === 'string' ? b.thread_ts : '';
  const text = typeof b?.text === 'string' ? b.text.trim() : '';
  if (!/^[A-Z0-9]+$/.test(channel) || !/^\d{10}\.\d{6}$/.test(thread)) return ctx.json(400, { ok: false, error: 'bad_target' });
  if (!text || text.length > 500) return ctx.json(400, { ok: false, error: 'bad_text' });
  try {
    const r = await chatPostMessage({ channel, text, thread_ts: thread }, deps.slack);
    ctx.json(200, { ok: true, ts: r.ts });
  } catch (e) {
    ctx.json(502, { ok: false, error: slackErr(e) });
  }
}

/* ------------------------------------------------------------------ focus + sessions */

const SESSION_RE = /^loom-[a-z0-9][a-z0-9-]{0,62}$/;
const FOCUS_SESSION_RE = /^loom-[A-Za-z0-9._-]{1,120}$/;
const PANE_RE = /^%\d+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bad = (ctx: RouteCtx, detail: string) => ctx.json(400, { ok: false, error: 'bad-request', detail });

/** The pane and session to bring forward: a session's active pane, or a pane's own session. */
function resolveTarget(opts: { session?: string; pane?: string }): { paneId: string; session: string } | { error: 'no-such-session' | 'no-such-pane' } {
  if (opts.session) {
    let out = '';
    try {
      out = deps.tmux(['list-panes', '-t', '=' + opts.session, '-F', '#{pane_id}\t#{pane_active}\t#{window_active}']);
    } catch {
      return { error: 'no-such-session' };
    }
    const rows = out.split('\n').map((l) => l.split('\t')).filter((f) => f[0]?.startsWith('%'));
    if (!rows.length) return { error: 'no-such-session' };
    const active = rows.find((f) => f[1] === '1' && f[2] === '1') ?? rows.find((f) => f[1] === '1') ?? rows[0];
    return { paneId: active[0], session: opts.session };
  }
  let out = '';
  try {
    out = deps.tmux(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}']);
  } catch {
    return { error: 'no-such-pane' };
  }
  for (const l of out.split('\n')) {
    const [id, session] = l.split('\t');
    if (id === opts.pane && session && !isViewSession(session)) return { paneId: id, session };
  }
  return { error: 'no-such-pane' };
}

/** Attach a Ghostty tab when the user's terminal is Ghostty and no tmux client shows the session, then focus. */
function focusTarget(t: { paneId: string; session: string }): { ok: boolean; detail: string } {
  let detail = '';
  if (deps.ghostty()) {
    let attached = true;
    try {
      attached = deps.tmux(['list-clients', '-F', '#{client_session}']).split('\n').includes(t.session);
    } catch {
      /* unknown: do not attach blindly */
    }
    if (!attached) {
      const r = deps.attachTab(t.session);
      detail = r.ok ? 'tab attached; ' : 'tab attach failed: ' + r.detail + '; ';
    }
  }
  const r = deps.goto(t.paneId, t.session);
  return { ok: r.ok, detail: detail + r.detail };
}

async function postFocus(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  const session = typeof b?.session === 'string' ? b.session : '';
  const pane = typeof b?.pane === 'string' ? b.pane : '';
  if (!!session === !!pane) return bad(ctx, 'exactly one of session or pane is required');
  if (session && !FOCUS_SESSION_RE.test(session)) return bad(ctx, 'session must start with loom-');
  if (pane && !PANE_RE.test(pane)) return bad(ctx, 'pane must look like %17');
  const t = resolveTarget({ session, pane });
  if ('error' in t) return ctx.json(404, { ok: false, error: t.error });
  if (!t.session.startsWith('loom-')) return bad(ctx, 'only loom- sessions can be focused');
  const r = focusTarget(t);
  ctx.json(200, { ok: true, session: t.session, pane_id: t.paneId, detail: r.detail });
}

async function postSessions(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  const name = typeof b?.name === 'string' ? b.name : '';
  const cwd = typeof b?.cwd === 'string' ? b.cwd : '';
  const argv = Array.isArray(b?.argv) ? (b!.argv as unknown[]) : null;
  if (!SESSION_RE.test(name)) return bad(ctx, 'name must match ^loom-[a-z0-9][a-z0-9-]{0,62}$');
  if (!cwd || !path.isAbsolute(cwd)) return bad(ctx, 'cwd must be an absolute path');
  if (!argv || !argv.length || argv.some((a) => typeof a !== 'string') || !(argv[0] as string)) return bad(ctx, 'argv must be a non-empty array of strings');
  const env = b?.env;
  if (env !== undefined && (!env || typeof env !== 'object' || Array.isArray(env))) return bad(ctx, 'env must be an object');
  const envPairs = Object.entries((env ?? {}) as Record<string, unknown>);
  if (envPairs.some(([k, v]) => !ENV_KEY_RE.test(k) || typeof v !== 'string')) return bad(ctx, 'env keys must be names and values strings');
  const title = b?.title;
  if (title !== undefined && (typeof title !== 'string' || title.length > 120)) return bad(ctx, 'title must be a string of at most 120 characters');
  const parsedLinks = parseLinksInput(b?.links);
  if (!parsedLinks.ok) return bad(ctx, parsedLinks.detail);
  if (!deps.dirExists(cwd)) return bad(ctx, 'cwd does not exist');
  // Duplicate check first: an existing session is never touched.
  let exists = true;
  try {
    deps.tmux(['has-session', '-t', '=' + name]);
  } catch {
    exists = false;
  }
  if (exists) return ctx.json(409, { ok: false, error: 'duplicate' });
  if (b?.trust === true) deps.pretrust(cwd);
  // With focus, in Loom's own window: the loading screen the Slack open uses, up before tmux is
  // asked for the session. Everything above only validates, so a rejected request never flashes it.
  const loading = b?.focus === true ? deps.loading() : null;
  const where = (typeof title === 'string' && title.trim()) || name;
  loading?.show({ label: 'Starting your chat', where, detail: 'Starting Claude for this session.' });
  const args = ['new-session', '-d', '-s', name, '-c', cwd, '-P', '-F', '#{pane_id}'];
  for (const [k, v] of envPairs) args.push('-e', `${k}=${v as string}`);
  args.push('--', ...(argv as string[]));
  let paneId = '';
  try {
    paneId = deps.tmux(args).trim();
  } catch (e) {
    loading?.end({ label: 'Could not start ' + where, detail: (e as Error).message });
    return ctx.json(500, { ok: false, error: 'tmux', detail: (e as Error).message });
  }
  if (!PANE_RE.test(paneId)) {
    const t = resolveTarget({ session: name });
    paneId = 'error' in t ? '' : t.paneId;
  }
  // The chat's session id is not known yet: the links wait on the pane until a live chat shows there (tickPendingLinks).
  if (paneId) holdLinks(paneId, parsedLinks.links, Date.now());
  let paneName = '';
  if (paneId) {
    try {
      deps.namePanes();
      paneName = deps.tmux(['display-message', '-p', '-t', paneId, '#{@name}']).trim();
    } catch {
      /* the sidebar names it on its next tick */
    }
  }
  let focused = false;
  if (b?.focus === true && paneId) {
    const f = focusTarget({ paneId, session: name });
    focused = f.ok;
    // The screen stays until the chat is on the board (the page's own wait, 25 s at most, then the failure card).
    if (loading) {
      if (f.ok) loading.openPane(paneId);
      else loading.end({ label: 'Could not open ' + where, detail: f.detail });
    }
  } else loading?.end({ label: 'Could not open ' + where, detail: 'The session has no pane to show.' });
  ctx.json(201, { ok: true, session: name, pane_id: paneId, name: paneName, focused });
}

/** Every pane id on Loom's tmux socket, or null when tmux does not answer. */
function alivePaneIds(): Set<string> | null {
  try {
    return new Set(deps.tmux(['list-panes', '-a', '-F', '#{pane_id}']).split('\n').map((l) => l.trim()).filter((l) => PANE_RE.test(l)));
  } catch {
    return null;
  }
}

/**
 * Attach links held at session creation to chats that have come up, and drop holds whose
 * pane died or that timed out. server.ts runs it every couple of seconds.
 */
export function tickPendingLinks(now: number = Date.now()): { attached: number; expired: number } {
  if (!heldCount()) return { attached: 0, expired: 0 };
  return resolveHeldLinks({
    now,
    live: deps.live(),
    alivePanes: alivePaneIds(),
    attach: (sid, l, at) => withDb((db) => void addTestLink(db, sid, l.url, l.label, at, l.kind)),
  });
}

export const routes: RouteDef[] = [
  { method: 'POST', path: '/api/cli/focus', kind: 'cli', handler: postFocus },
  { method: 'POST', path: '/api/cli/sessions', kind: 'cli', handler: postSessions },
  { method: 'GET', path: '/api/cli/threads', kind: 'cli', handler: getThreads },
  { method: 'GET', path: '/api/cli/outbox', kind: 'cli', handler: getOutbox },
  { method: 'GET', path: '/api/cli/ship-labels', kind: 'cli', handler: getShipLabels },
  { method: 'GET', path: '/api/cli/test-links', kind: 'cli', handler: getTestLinks },
  { method: 'GET', path: '/api/cli/route', kind: 'cli', handler: getRoute },
  { method: 'POST', path: '/api/cli/route/send', kind: 'cli', handler: postRouteSend },
  { method: 'GET', path: '/api/cli/whoami', kind: 'cli', handler: getWhoami },
  { method: 'POST', path: '/api/cli/slack/react', kind: 'cli', handler: postReact },
  { method: 'POST', path: '/api/cli/slack/reply', kind: 'cli', handler: postReply },
];

/**
 * `GET /api/cli/outbox/<id>`: the one CLI path with a parameter in it, which the
 * exact-path table cannot hold. server.ts calls this before its other routes
 * and passes the cli guard (requireWrite(req, 'cli'); passed in rather than
 * imported, since index.ts imports this file). Any other unknown /api/cli/ path
 * is a 404. Returns true when it answered.
 */
export function handleCliPath(req: http.IncomingMessage, res: http.ServerResponse, url: URL, guard: (req: http.IncomingMessage) => Verdict): boolean {
  if (!url.pathname.startsWith('/api/cli/') || routes.some((r) => r.path === url.pathname)) return false;
  const reply = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const v = guard(req);
  if (!v.ok) {
    req.resume();
    reply(v.status, { ok: false, detail: v.reason });
    return true;
  }
  const m = /^\/api\/cli\/outbox\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
  if (m && (req.method === 'GET' || req.method === 'HEAD')) {
    const d = readOutbox(deps.outbox)[m[1]];
    reply(d ? 200 : 404, d ? { ok: true, draft: cliDraft(d) } : { ok: false, detail: 'no such draft' });
    return true;
  }
  req.resume();
  reply(404, { ok: false, detail: 'not found' });
  return true;
}
