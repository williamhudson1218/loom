import { openDb } from '../db.ts';
import { DEFAULT_SHIP_COMMAND, addShipProject, listShipProjects, removeShipProject, updateShipProject } from '../projects.ts';
import { writePluginStateFile } from '../pluginmgr.ts';
import { shipCandidates } from '../ships.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Per-project ship settings and launch (§10).
// Every entry is gated by requireWrite(kind) in src/routes/index.ts before its
// handler runs; tests/auth.test.ts sweeps this list, so a route cannot skip it.
// The Ship modal's own routes (detail, diff, label, assign, start) are still
// answered inline by server.ts; they read the same ship_projects rows.

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const bool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

function withDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** The plugin's hooks read the ship repos and label gate from plugin-state.json: rewrite it after any change to ship_projects. */
function withSync<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  return withDb((db) => {
    const r = fn(db);
    try {
      writePluginStateFile(db);
    } catch (e) {
      console.error('[loom] plugin-state.json not updated:', (e as Error).message);
    }
    return r;
  });
}

/** Settings › Ship: every row, enabled or not. `override` says the env list is in force. */
export function listHandler({ json }: RouteCtx): void {
  const projects = withDb((db) => listShipProjects(db, { includeDisabled: true }));
  json(200, { ok: true, projects, defaultCommand: DEFAULT_SHIP_COMMAND, override: !!process.env.LOOM_SHIP_REPOS });
}

/** Git projects with staged work that are not on Ship yet (the "Add <repo> to Ship" offer). */
export function candidatesHandler({ json }: RouteCtx): void {
  json(200, { ok: true, candidates: shipCandidates() });
}

/** Put a git project on Ship. Any folder inside the checkout works. */
export async function addHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b) return json(400, { ok: false, detail: 'bad body' });
  const r = withSync((db) =>
    addShipProject(db, str(b.path), { command: b.ship_command, labelRequired: bool(b.label_required), shipLock: bool(b.ship_lock), baseBranch: str(b.base_branch), enabled: bool(b.enabled) }),
  );
  json(r.ok ? 200 : 400, r.ok ? { ok: true, project: r.project } : { ok: false, detail: r.detail });
}

export async function updateHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || !str(b.project_dir)) return json(400, { ok: false, detail: 'project_dir is required' });
  const r = withSync((db) =>
    updateShipProject(db, str(b.project_dir), { ship_command: b.ship_command, base_branch: typeof b.base_branch === 'string' ? b.base_branch : undefined, label_required: bool(b.label_required), ship_lock: bool(b.ship_lock), enabled: bool(b.enabled) }),
  );
  json(r.ok ? 200 : r.detail === 'unknown repo' ? 404 : 400, r.ok ? { ok: true, project: r.project } : { ok: false, detail: r.detail });
}

export async function removeHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || !str(b.project_dir)) return json(400, { ok: false, detail: 'project_dir is required' });
  const ok = withSync((db) => removeShipProject(db, str(b.project_dir)));
  json(ok ? 200 : 404, ok ? { ok: true } : { ok: false, detail: 'unknown repo' });
}

export const routes: RouteDef[] = [
  { method: 'GET', path: '/api/ship/projects', kind: 'read', handler: listHandler },
  { method: 'GET', path: '/api/ship/candidates', kind: 'read', handler: candidatesHandler },
  { method: 'POST', path: '/api/ship/projects', kind: 'browser', handler: addHandler },
  { method: 'POST', path: '/api/ship/projects/update', kind: 'browser', handler: updateHandler },
  { method: 'POST', path: '/api/ship/projects/remove', kind: 'browser', handler: removeHandler },
];
