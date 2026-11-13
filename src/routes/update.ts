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

export const routes: RouteDef[] = [
  {
    method: 'GET', path: '/api/update', kind: 'read', reads: true,
    handler: (ctx) => ctx.json(200, { ok: true, state: host ? host.state() : NO_HOST }),
  },
  {
    method: 'POST', path: '/api/update/check', kind: 'browser',
    handler: (ctx) => {
      if (!host) return ctx.json(200, { ok: true, state: NO_HOST });
      // Answer at once with the check under way ("checking"), not after the
      // download and verify: the page follows it through the pushed state and
      // GET /api/update. Waiting here left the button looking dead for the
      // whole download, so it got clicked twice.
      host.check().catch(() => {});
      ctx.json(200, { ok: true, state: host.state() });
    },
  },
  {
    method: 'POST', path: '/api/update/apply', kind: 'browser',
    handler: (ctx) => {
      if (!host) return ctx.json(409, { ok: false, detail: NO_HOST.detail });
      const r = host.restart();
      ctx.json(r.ok ? 200 : 409, r);
    },
  },
];
