import type http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { TOOL_DIR } from '../paths.ts';
import { termToken, tokenMatches } from '../ptybridge.ts';
import { orchTokenOk } from '../orchserver.ts';
import { routes as pluginRoutes } from './plugin.ts';
import { routes as slackRoutes } from './slack.ts';
import { routes as shipRoutes } from './ship.ts';
import { routes as shortcutRoutes } from './shortcut.ts';
import { routes as wizardRoutes } from './wizard.ts';
import { routes as watcherRoutes } from './watchers.ts';
import { routes as cliRoutes } from './cli.ts';
import { routes as settingsExtraRoutes } from './settingsextra.ts';
import { routes as treeRoutes } from './trees.ts';
import { routes as googleRoutes } from './google.ts';
import { routes as githubRoutes } from './github.ts';
import { routes as updateRoutes } from './update.ts';

// ---- The route table and the one write guard (§13) --------------------------
//
// Every route that changes anything is a row here, and the server runs
// requireWrite(row.kind) on it before any handler code. tests/auth.test.ts
// iterates ROUTES and asserts each one refuses a missing token, a foreign Origin
// and a foreign Host, so a new route cannot quietly skip the guard.
//
// The kinds:
//   browser  Loom's own page (and the Electron main process). Host and Origin are
//            Loom's, and `x-loom-token` (or the older `x-loom-term-token`) is this
//            launch's token, which only a page served to Loom's own Host carries.
//   cli      The plugin's `loom` CLI and hooks. Host is Loom's, no Origin (a
//            browser always sends one on a write), and `x-loom-cli-token` matches
//            $LOOM_HOME/cli-token (0600).
//   orch     The orchestrator's MCP process: its own 0600 token, unchanged.
//   read     A module GET with nothing to guard beyond the Host check every
//            request gets. Never use it for a route that changes state.

export type WriteKind = 'browser' | 'cli' | 'orch';
export type RouteKind = WriteKind | 'read';
export type Method = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

export interface RouteCtx {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  url: URL;
  json(code: number, body: unknown): void;
  /** The JSON object body (capped at 256 KB). null for a missing, malformed or non-object body. */
  body(): Promise<Record<string, unknown> | null>;
}

export interface RouteDef {
  method: Method;
  /** Exact pathname; parameters go in the query string. */
  path: string;
  kind: RouteKind;
  /** A GET on this path is a separate read the server answers inline (so it is not refused). */
  reads?: boolean;
  /** The page used to call this with GET. The client helper upgrades such calls to POST. */
  legacyGet?: boolean;
  /** Module routes carry a handler; core rows (handled inline in server.ts) do not. */
  handler?: (ctx: RouteCtx) => void | Promise<void>;
}

const b = (method: Method, p: string, extra: Partial<RouteDef> = {}): RouteDef => ({ method, path: p, kind: 'browser', ...extra });

/**
 * The writes server.ts still handles inline. Gate rows only: the handlers stay
 * where they are, and this table is what authorises them.
 */
export const CORE_ROUTES: RouteDef[] = [
  // Chats on the board
  b('POST', '/goto', { legacyGet: true }),
  b('POST', '/send'),
  b('POST', '/close'),
  b('POST', '/save', { legacyGet: true }),
  b('POST', '/unsave', { legacyGet: true }),
  b('POST', '/resume'),
  b('POST', '/branch'),
  b('POST', '/restore', { legacyGet: true }),
  b('POST', '/api/rename'),
  b('POST', '/api/hide'),
  b('POST', '/api/restore'),
  b('POST', '/api/parked/unpark'),
  b('POST', '/api/parked/resume'),
  b('POST', '/api/new-thread'),
  b('POST', '/api/new-thread/retry'),
  b('POST', '/api/new-thread/dismiss'),
  b('POST', '/api/panes/move'),
  b('POST', '/api/panes/ungroup'),
  // Projects, tags, terminals
  b('POST', '/api/projects', { reads: true }),
  b('POST', '/api/projects/update'),
  b('POST', '/api/projects/remove'),
  b('POST', '/api/tags', { reads: true }),
  b('POST', '/api/tags/update'),
  b('POST', '/api/tags/delete'),
  b('POST', '/api/chat-tags'),
  b('POST', '/api/terminals', { reads: true }),
  b('POST', '/api/term/cmd'),
  // Ship
  b('POST', '/api/ship/label'),
  b('POST', '/api/ship/assign'),
  b('POST', '/api/ship/start'),
  // Slack, outbox, watchers
  b('POST', '/api/slack/open'),
  b('POST', '/api/slack/thread-goto'),
  b('PUT', '/api/slack/channel-projects', { reads: true }),
  b('POST', '/api/slack/channel-projects', { reads: true }),
  b('POST', '/api/slack/start/dismiss'),
  b('POST', '/api/slack/start/project'),
  b('POST', '/api/outbox/send'),
  b('POST', '/api/outbox/discard'),
  b('POST', '/api/outbox/send-now'),
  b('POST', '/api/watchers/toggle'),
  b('POST', '/api/watchers/goto'),
  // Trees
  b('POST', '/api/trees/goto', { legacyGet: true }),
  b('POST', '/api/trees/remove'),
  // Settings: T1's settingsGet/settingsPut (src/settings.ts), called inline by server.ts.
  b('PUT', '/api/settings', { reads: true }),
  b('POST', '/api/settings', { reads: true }),
  b('PUT', '/api/settings/default-agent'),
  // EM (T5 removes the tab; the route stays guarded until it is deleted)
  // Orchestrator UI writes (src/orchserver.ts) and the MCP process's tool calls
  b('POST', '/api/orch/send'),
  b('PUT', '/api/orch/send'),
  b('POST', '/api/orch/ask'),
  b('PUT', '/api/orch/ask'),
  b('POST', '/api/orch/notify'),
  b('PUT', '/api/orch/notify'),
  b('POST', '/api/orch/resolve'),
  b('PUT', '/api/orch/resolve'),
  { method: 'POST', path: '/api/orch/tool', kind: 'orch' },
];

/** Routes owned by the feature modules (later waves fill these files, never server.ts). */
export const MODULE_ROUTES: RouteDef[] = [
  ...pluginRoutes,
  ...slackRoutes,
  ...shipRoutes,
  ...shortcutRoutes,
  ...wizardRoutes,
  ...watcherRoutes,
  ...cliRoutes,
  ...settingsExtraRoutes,
  ...treeRoutes,
  ...googleRoutes,
  ...githubRoutes,
  ...updateRoutes,
];

export const ROUTES: RouteDef[] = [...CORE_ROUTES, ...MODULE_ROUTES];

/** Paths the page used to hit with GET; the client helper sends them as POST. */
export function legacyGetPaths(routes: RouteDef[] = ROUTES): string[] {
  return [...new Set(routes.filter((r) => r.legacyGet).map((r) => r.path))];
}

// ---- The guard ---------------------------------------------------------------

// The port Loom is serving on (src/serverport.ts), set through setLoomPort() once
// it has bound, which may be past the configured one.
let configuredPort = 4317; // the running port; startListening() sets it after bind
export function setLoomPort(port: number): void {
  configuredPort = port;
}

/**
 * Loom's own ports: the one configured, and the one this request actually
 * arrived on. They are the same in a running Loom; a test server on port 0 is
 * reachable either way.
 */
function portsOf(req: http.IncomingMessage): number[] {
  const local = req.socket?.localPort;
  return local && local !== configuredPort ? [configuredPort, local] : [configuredPort];
}

export function ownHost(req: http.IncomingMessage): boolean {
  const host = req.headers.host;
  return !!host && portsOf(req).some((port) => host === `localhost:${port}` || host === `127.0.0.1:${port}`);
}

export function ownOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  return !!origin && portsOf(req).some((port) => origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`);
}

export type Verdict = { ok: true } | { ok: false; status: number; reason: string };

const header = (req: http.IncomingMessage, name: string): string => {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] ?? '' : v ?? '';
};

/** The single write guard (§13). Pure apart from reading the CLI/orch token files. */
export function requireWrite(req: http.IncomingMessage, kind: RouteKind): Verdict {
  if (!ownHost(req)) return { ok: false, status: 403, reason: 'bad host' };
  if (kind === 'read') return { ok: true };
  if (kind === 'browser') {
    if (!ownOrigin(req)) return { ok: false, status: 403, reason: 'bad origin' };
    const given = header(req, 'x-loom-token') || header(req, 'x-loom-term-token');
    if (!tokenMatches(given, termToken())) return { ok: false, status: 403, reason: 'bad token' };
    return { ok: true };
  }
  if (kind === 'cli') {
    if (req.headers.origin !== undefined) return { ok: false, status: 403, reason: 'bad origin' };
    let want = '';
    try {
      want = readCliToken();
    } catch {
      /* no token file: refuse */
    }
    if (!tokenMatches(header(req, 'x-loom-cli-token'), want)) return { ok: false, status: 403, reason: 'bad token' };
    return { ok: true };
  }
  if (kind === 'orch') {
    if (req.headers.origin !== undefined && !ownOrigin(req)) return { ok: false, status: 403, reason: 'bad origin' };
    return orchTokenOk(req) ? { ok: true } : { ok: false, status: 403, reason: 'bad token' };
  }
  return { ok: false, status: 403, reason: 'unknown route kind' };
}

export type GateResult = { ok: true; route?: RouteDef } | { ok: false; status: number; detail: string };

/**
 * What every request passes before any handler. Every request must carry Loom's
 * own Host (DNS rebinding). A request matching a table row must pass that row's
 * guard. Anything else that is not a GET is refused, and so is a GET on a path
 * that only exists as a write (`/save?...` from an <img> tag, say).
 */
export function gate(req: http.IncomingMessage, url: URL, routes: RouteDef[] = ROUTES): GateResult {
  if (!ownHost(req)) return { ok: false, status: 403, detail: 'bad host' };
  const method = (req.method || 'GET').toUpperCase();
  const route = routes.find((r) => r.path === url.pathname && r.method === method);
  if (route) {
    const v = requireWrite(req, route.kind);
    return v.ok ? { ok: true, route } : { ok: false, status: v.status, detail: v.reason };
  }
  const onPath = routes.filter((r) => r.path === url.pathname);
  if (method === 'GET' || method === 'HEAD') {
    if (onPath.length && !onPath.some((r) => r.reads)) return { ok: false, status: 405, detail: 'method not allowed' };
    return { ok: true };
  }
  return { ok: false, status: 405, detail: 'method not allowed' };
}

/** Run a module route's handler with a small context. */
export function runRoute(route: RouteDef, req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const json = (code: number, body: unknown) => {
    if (res.headersSent) return;
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  let bodyP: Promise<Record<string, unknown> | null> | null = null;
  const body = () =>
    (bodyP ??= new Promise((resolve) => {
      let raw = '';
      let over = false;
      req.on('data', (chunk: Buffer) => {
        if (raw.length + chunk.length > 256 * 1024) over = true;
        else raw += chunk;
      });
      req.on('end', () => {
        if (over) return resolve(null);
        try {
          const v: unknown = JSON.parse(raw || '{}');
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
        } catch {
          resolve(null);
        }
      });
      req.on('error', () => resolve(null));
    }));
  Promise.resolve()
    .then(() => route.handler!({ req, res, url, json, body }))
    .catch((e) => json(500, { ok: false, detail: (e as Error).message }));
}

// ---- The CLI token ($LOOM_HOME/cli-token, 0600) -------------------------------

export const cliTokenPath = (dir: string = TOOL_DIR): string => path.join(dir, 'cli-token');

function writeToken(file: string): string {
  const token = randomBytes(32).toString('base64url');
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, token + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return token;
}

export function readCliToken(dir: string = TOOL_DIR): string {
  return fs.readFileSync(cliTokenPath(dir), 'utf8').trim();
}

/** Create the CLI token if it is missing or unreadable, and keep it 0600. */
export function ensureCliToken(dir: string = TOOL_DIR): string {
  const file = cliTokenPath(dir);
  try {
    const token = readCliToken(dir);
    if (token.length >= 32) {
      if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      return token;
    }
  } catch {
    /* missing: create it */
  }
  fs.mkdirSync(dir, { recursive: true });
  return writeToken(file);
}

/** A fresh token, invalidating the old one (Settings › Helpers › Remove). */
export function rotateCliToken(dir: string = TOOL_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  return writeToken(cliTokenPath(dir));
}
