import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb as realOpenDb } from '../db.ts';
import { knownRepos, listRuns, pruneMergedWorktrees, summarize, type PruneDeps, type PruneResult } from '../prune.ts';
import { repoRootFor } from '../trees.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Prune trees (src/prune.ts). Every entry is gated by requireWrite(kind) in
// src/routes/index.ts before its handler runs; tests/auth.test.ts sweeps this list.
//
//   POST /api/trees/prune          Loom's page and any feature in it: { repo?, dry_run?, source?, paths? }.
//                                  `paths` limits a real run to what a confirm dialog listed.
//                                  No repo = every repo Loom knows.
//   POST /api/cli/trees/prune      `loom trees prune`: { repo, dry_run? }. Any git repo.
//   GET  /api/trees/prune/history  the last runs, newest first (?since=<id>).

export interface PruneRouteDeps {
  openDb(): Database.Database;
  prune?: Partial<PruneDeps>;
}

let deps: PruneRouteDeps = { openDb: () => realOpenDb() };
export function setPruneRouteDeps(over: Partial<PruneRouteDeps>): void {
  deps = { ...deps, ...over };
}

function withDb<T>(fn: (db: Database.Database) => Promise<T>): Promise<T> {
  const db = deps.openDb();
  return fn(db).finally(() => db.close());
}

const SOURCE_RE = /^[a-z][a-z0-9-]{0,23}$/;

const view = (r: PruneResult) => ({ ...r, summary: summarize(r) });

async function runAll(repos: string[], dryRun: boolean, trigger: string, db: Database.Database, only?: string[]): Promise<PruneResult[]> {
  const out: PruneResult[] = [];
  for (const repo of repos) out.push(await pruneMergedWorktrees(repo, { dryRun, trigger, db, only, deps: deps.prune }));
  return out;
}

export async function prunePageHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b) return json(400, { ok: false, detail: 'bad body' });
  const dryRun = b.dry_run === true;
  const source = typeof b.source === 'string' && SOURCE_RE.test(b.source) ? b.source : 'api';
  await withDb(async (db) => {
    const known = knownRepos(db);
    let repos = known;
    if (typeof b.repo === 'string' && b.repo) {
      const root = repoRootFor(b.repo);
      // The page may only name a repo Loom already lists; the CLI route is the one for anything else.
      if (!root || !known.includes(root)) return json(404, { ok: false, detail: 'not a repo Loom knows' });
      repos = [root];
    }
    const only = Array.isArray(b.paths) && b.paths.every((p) => typeof p === 'string') ? (b.paths as string[]) : undefined;
    const results = await runAll(repos, dryRun, source, db, only);
    json(200, { ok: true, dryRun, results: results.map(view) });
  });
}

export async function pruneCliHandler({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || typeof b.repo !== 'string' || !path.isAbsolute(b.repo)) return json(400, { ok: false, detail: 'repo must be an absolute path' });
  if (!fs.existsSync(b.repo)) return json(404, { ok: false, detail: 'no such directory' });
  const root = repoRootFor(b.repo);
  if (!root) return json(404, { ok: false, detail: 'not inside a git repository with a working tree' });
  const dryRun = b.dry_run === true;
  await withDb(async (db) => {
    const [r] = await runAll([root], dryRun, 'cli', db);
    json(200, { ok: true, dryRun, results: [view(r)] });
  });
}

export async function historyHandler({ json, url }: RouteCtx): Promise<void> {
  const since = Number(url.searchParams.get('since') ?? 0);
  await withDb(async (db) => {
    const runs = listRuns(db, { sinceId: Number.isFinite(since) && since > 0 ? since : 0, limit: 10 });
    json(200, { ok: true, runs: runs.map((r) => ({ ...r, summary: summarize({ ...r, dryRun: false, error: r.error || undefined }) })) });
  });
}

export const routes: RouteDef[] = [
  { method: 'POST', path: '/api/trees/prune', kind: 'browser', handler: prunePageHandler },
  { method: 'POST', path: '/api/cli/trees/prune', kind: 'cli', handler: pruneCliHandler },
  { method: 'GET', path: '/api/trees/prune/history', kind: 'read', handler: historyHandler },
];
