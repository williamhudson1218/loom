import { openDb } from '../db.ts';
import { PluginManager } from '../pluginmgr.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Settings › Helpers: install, update and remove the Claude Code plugin (§4).
// Every entry is gated by requireWrite(kind) in src/routes/index.ts before its
// handler runs; tests/auth.test.ts sweeps this list, so a route cannot skip it.

async function withManager<T>(fn: (m: PluginManager) => Promise<T>): Promise<T> {
  const db = openDb();
  try {
    return await fn(new PluginManager({ db }));
  } finally {
    db.close();
  }
}

const act = (run: (m: PluginManager) => Promise<unknown>) => async (ctx: RouteCtx) => {
  ctx.json(200, await withManager(run));
};

export const routes: RouteDef[] = [
  // status + command preview + legacy hook entries (read-only; no secrets in it)
  { method: 'GET', path: '/api/plugin/status', kind: 'read', handler: act((m) => m.status()) },
  { method: 'POST', path: '/api/plugin/install', kind: 'browser', handler: act((m) => m.install()) },
  { method: 'POST', path: '/api/plugin/update', kind: 'browser', handler: act((m) => m.update()) },
  { method: 'POST', path: '/api/plugin/remove', kind: 'browser', handler: act((m) => m.remove()) },
];
