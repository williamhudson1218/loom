import type { RouteDef } from './index.ts';
import type { UpdateState } from '../updater.ts';

// Settings › Updates and the header's "Update ready" (src/updateview.ts). The
// updater itself lives in the Electron main process (app/main.ts, src/updater.ts),
// which registers itself here; the standalone server and tests have no host and
// report updates as unavailable.

export interface UpdateHost {
  state(): UpdateState;
  /** Starts a check (or joins the one running); the route does not wait for it. */
  check(): Promise<UpdateState>;
  /** Hand the ready update to the apply script and quit. */
  restart(): { ok: true; version: string } | { ok: false; detail: string };
}

let host: UpdateHost | null = null;
export function setUpdateHost(h: UpdateHost | null): void {
  host = h;
}

const NO_HOST: Partial<UpdateState> = { status: 'disabled', detail: 'Updates are only available in the Loom app.' };

export function currentUpdateHost(): UpdateHost | null {
  return host;
}

export interface UpdateReply {
  status: number;
  body: Record<string, unknown>;
}

// The three actions, shared by the desktop routes below and the phone's (src/mobile/api.ts),
// which passes its own host so tests can stub it.
export function updateStateReply(h: UpdateHost | null): UpdateReply {
  return { status: 200, body: { ok: true, state: h ? h.state() : NO_HOST } };
}

export function updateCheckReply(h: UpdateHost | null): UpdateReply {
  if (!h) return { status: 200, body: { ok: true, state: NO_HOST } };
  // Answer at once with the check under way ("checking"), not after the
  // download and verify: the page follows it through the pushed state and
  // GET /api/update. Waiting here left the button looking dead for the
  // whole download, so it got clicked twice.
  h.check().catch(() => {});
  return { status: 200, body: { ok: true, state: h.state() } };
}

export function updateApplyReply(h: UpdateHost | null): UpdateReply {
  if (!h) return { status: 409, body: { ok: false, detail: NO_HOST.detail } };
  const r = h.restart();
  return { status: r.ok ? 200 : 409, body: r };
}

export const routes: RouteDef[] = [
  {
    method: 'GET', path: '/api/update', kind: 'read', reads: true,
    handler: (ctx) => { const r = updateStateReply(host); ctx.json(r.status, r.body); },
  },
  {
    method: 'POST', path: '/api/update/check', kind: 'browser',
    handler: (ctx) => { const r = updateCheckReply(host); ctx.json(r.status, r.body); },
  },
  {
    method: 'POST', path: '/api/update/apply', kind: 'browser',
    handler: (ctx) => { const r = updateApplyReply(host); ctx.json(r.status, r.body); },
  },
];
