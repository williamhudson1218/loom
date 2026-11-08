import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import Database from 'better-sqlite3';
import path from 'node:path';
import { openDb } from './db.ts';
import { defaultGitAsync, type AsyncGitRunner } from './git.ts';
import { listShipProjects } from './projects.ts';
import { getSetting } from './settingsSchema.ts';
import { tmux } from './tmux.ts';
import { repoRootFor, invalidate as invalidateTrees } from './trees.ts';

/**
 * Prune trees: remove every worktree of a repo that is merged and clean.
 *
 * Every decision is made from git and the process table at the moment of
 * removal, never from the Trees tab's cached scan. Removal is plain
 * `git worktree remove` (no force) followed by `git branch -d` (never -D), so
 * whatever git itself refuses stays put, and the refusal is recorded.
 *
 * A worktree is pruned only when ALL of these hold:
 *   - it is a linked worktree from `git worktree list` (not the primary checkout,
 *     not locked, its directory exists, it has a branch that is not the base);
 *   - `git status --porcelain` is empty (ignored files are allowed: they go with it);
 *   - no stash entry was made on its branch;
 *   - its branch is merged into the base: an ancestor of it, every commit
 *     patch-equivalent (`git cherry`), or its whole diff matching one commit on
 *     the base (a squash merge);
 *   - the branch has commits of its own (a branch nobody committed to has
 *     "merged" nothing, and is usually a workspace about to be used);
 *   - no tmux pane and no running process has its working directory inside it;
 *   - no other tool still manages it (an active Superset workspace).
 */

export { PRUNE_SCHEMA_SQL } from './prunesql.ts';

const HISTORY_KEEP = 50;

export interface PruneRemoved {
  path: string;
  name: string;
  branch: string;
  merge: string;
  branchDeleted: boolean;
  /** Why the branch was kept, when `git branch -d` refused (or would refuse). */
  branchNote?: string;
}

export interface PruneSkipped {
  path: string;
  name: string;
  branch: string | null;
  reason: string;
}

export interface PruneResult {
  repo: string;
  base: string;
  dryRun: boolean;
  trigger: string;
  startedAt: number;
  finishedAt: number;
  /** In a dry run: what a real run would remove right now. */
  removed: PruneRemoved[];
  skipped: PruneSkipped[];
  error?: string;
  /** The history row, for real runs. */
  id?: number;
}

export interface LiveDir {
  dir: string;
  what: string;
}

export type GitInputRunner = (args: string[], cwd: string, input: string) => Promise<string>;

export interface PruneDeps {
  git: AsyncGitRunner;
  /** git with stdin, for `git patch-id`. */
  gitInput: GitInputRunner;
  /** Every directory something is running in right now: pane cwds and process cwds. */
  liveDirs(): Promise<LiveDir[]>;
  /** Worktree paths another tool still manages, each with the skip reason to record. */
  managedElsewhere(): Promise<Map<string, string>>;
  now(): number;
}

export interface PruneOpts {
  dryRun?: boolean;
  trigger?: string;
  db?: Database.Database;
  /** Overrides the base branch lookup (tests). */
  base?: string;
  /**
   * Remove only these paths (what a confirm dialog listed); anything else that
   * became prunable since is skipped. Each one is still re-checked.
   */
  only?: string[];
  deps?: Partial<PruneDeps>;
}

/* ------------------------------------------------------------ live dirs */

const MAX_BUFFER = 64 * 1024 * 1024;

function run(cmd: string, args: string[], cwd: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { cwd, encoding: 'utf-8', timeout, maxBuffer: MAX_BUFFER }, (err, out) => (err ? reject(err) : resolve(String(out)))),
  );
}

/** `lsof -F pcn` output: p<pid>, c<command>, then f/n pairs. Only cwd entries are asked for. */
export function parseLsofCwds(out: string): LiveDir[] {
  const dirs: LiveDir[] = [];
  let pid = '';
  let cmd = '';
  for (const line of out.split('\n')) {
    const tag = line.slice(0, 1);
    const val = line.slice(1);
    if (tag === 'p') { pid = val; cmd = ''; }
    else if (tag === 'c') cmd = val;
    else if (tag === 'n' && val.startsWith('/')) dirs.push({ dir: val, what: `process ${pid}${cmd ? ` (${cmd})` : ''}` });
  }
  return dirs;
}

/** The working directory of every process the user can see. One lsof call, about a second. */
export async function processCwds(): Promise<LiveDir[]> {
  try {
    return parseLsofCwds(await run('lsof', ['-w', '-a', '-d', 'cwd', '-F', 'pcn'], '/'));
  } catch (e) {
    // lsof exits 1 when some processes cannot be inspected but still prints the rest.
    const out = (e as { stdout?: unknown }).stdout;
    if (typeof out === 'string' && out) return parseLsofCwds(out);
    throw new Error('lsof failed: ' + (e as Error).message);
  }
}

/** Every pane on Loom's tmux server, by its current directory. */
export function tmuxPaneDirs(runTmux: (args: string[]) => string = (a) => tmux(a)): LiveDir[] {
  let out = '';
  try {
    out = runTmux(['list-panes', '-a', '-F', '#{pane_id}\t#{session_name}\t#{pane_current_path}']);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((l) => l.split('\t'))
    .filter((f) => f.length >= 3 && f[2].startsWith('/'))
    .map(([id, sess, dir]) => ({ dir, what: `tmux pane ${id} (${sess})` }));
}

async function defaultLiveDirs(): Promise<LiveDir[]> {
  return [...tmuxPaneDirs(), ...(await processCwds())];
}

/**
 * Worktrees the Superset app still tracks as active (non-archived) workspaces,
 * from every `<home>/.superset/host/<id>/host.db`. Read-only; a missing,
 * locked or differently shaped database means nothing is tracked, so with no
 * Superset installed this is a no-op.
 */
export function supersetWorkspaces(home: string = os.homedir()): Map<string, string> {
  const tracked = new Map<string, string>();
  const hostDir = path.join(home, '.superset', 'host');
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(hostDir);
  } catch {
    return tracked;
  }
  for (const id of ids) {
    const file = path.join(hostDir, id, 'host.db');
    if (!fs.existsSync(file)) continue;
    let db: Database.Database | null = null;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const rows = db.prepare(`SELECT worktree_path FROM workspaces WHERE archived_at IS NULL`).all() as { worktree_path: unknown }[];
      for (const r of rows) if (typeof r.worktree_path === 'string' && r.worktree_path) tracked.set(real(r.worktree_path), 'Superset workspace');
    } catch {
      /* unreadable or another schema: treat as untracked */
    } finally {
      db?.close();
    }
  }
  return tracked;
}

const defaultGitInput: GitInputRunner = (args, cwd, input) =>
  new Promise((resolve, reject) => {
    const child = execFile('git', args, { cwd, encoding: 'utf-8', timeout: 60_000, maxBuffer: MAX_BUFFER }, (err, out) => (err ? reject(err) : resolve(String(out))));
    child.stdin?.end(input);
  });

export const defaultPruneDeps: PruneDeps = {
  git: defaultGitAsync,
  gitInput: defaultGitInput,
  liveDirs: defaultLiveDirs,
  managedElsewhere: async () => supersetWorkspaces(),
  now: () => Date.now(),
};

/* ----------------------------------------------------------- git checks */

export interface ListedTree {
  path: string;
  name: string;
  branch: string | null;
  primary: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain`, keeping the locked/prunable flags the Trees parser drops. */
export function parsePorcelainTrees(out: string): ListedTree[] {
  const trees: ListedTree[] = [];
  let cur: Partial<ListedTree> & { bare?: boolean } = {};
  let first = true;
  const flush = () => {
    if (cur.path) {
      if (!cur.bare) trees.push({ path: cur.path, name: path.basename(cur.path), branch: cur.branch ?? null, primary: first, locked: !!cur.locked, prunable: !!cur.prunable });
      first = false;
    }
    cur = {};
  };
  for (const line of out.split('\n')) {
    if (line === '') { flush(); continue; }
    const sep = line.indexOf(' ');
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1);
    if (key === 'worktree') cur.path = value;
    else if (key === 'branch') cur.branch = value.startsWith('refs/heads/') ? value.slice('refs/heads/'.length) : value;
    else if (key === 'bare') cur.bare = true;
    else if (key === 'locked') cur.locked = true;
    else if (key === 'prunable') cur.prunable = true;
  }
  flush();
  return trees;
}

async function ok(git: AsyncGitRunner, args: string[], cwd: string): Promise<boolean> {
  try {
    await git(args, cwd);
    return true;
  } catch {
    return false;
  }
}

async function out(git: AsyncGitRunner, args: string[], cwd: string): Promise<string | null> {
  try {
    return await git(args, cwd);
  } catch {
    return null;
  }
}

const firstLine = (e: unknown): string => {
  const err = e as { stderr?: unknown; message?: string };
  const s = (typeof err.stderr === 'string' && err.stderr.trim()) || err.message || String(e);
  return s.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join(' ').slice(0, 240);
};

/**
 * The branch the merge test runs against: the repo's Ship base branch when it
 * has one (preferring the remote's copy, which is where merges land), else
 * origin/HEAD, else the usual names. Never HEAD: "merged into whatever is
 * checked out" is not a safe rule.
 */
export async function resolvePruneBase(repo: string, git: AsyncGitRunner, db?: Database.Database): Promise<string | null> {
  const exists = (ref: string) => ok(git, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo);
  let shipBase = '';
  if (db) {
    try {
      shipBase = listShipProjects(db, { includeDisabled: true }).find((p) => p.project_dir === repo)?.base_branch ?? '';
    } catch {
      shipBase = '';
    }
  }
  if (shipBase) {
    for (const ref of [`origin/${shipBase}`, shipBase]) if (await exists(ref)) return ref;
  }
  const head = ((await out(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repo)) ?? '').trim();
  if (head.startsWith('refs/remotes/') && (await exists(head.slice('refs/remotes/'.length)))) return head.slice('refs/remotes/'.length);
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) if (await exists(ref)) return ref;
  return null;
}

/** How the branch reached the base, or null when it has not. */
export async function mergedHow(repo: string, branch: string, base: string, deps: Pick<PruneDeps, 'git' | 'gitInput'>): Promise<{ how: string } | { none: string }> {
  const { git } = deps;
  const ref = `refs/heads/${branch}`;
  if (await ok(git, ['merge-base', '--is-ancestor', ref, base], repo)) {
    // An ancestor with a reflog of one "Created" entry was never committed to.
    const log = ((await out(git, ['reflog', 'show', '--format=%gs', ref, '--'], repo)) ?? '').split('\n').filter(Boolean);
    if (log.length === 1 && log[0].startsWith('branch: Created')) return { none: 'no commits of its own (never worked in)' };
    return { how: 'merged' };
  }
  const cherry = ((await out(git, ['cherry', base, ref], repo)) ?? '').split('\n').filter(Boolean);
  if (cherry.length && cherry.every((l) => l.startsWith('-'))) return { how: 'patch-equivalent' };

  // Squash merge: the branch's whole diff equals one commit on the base.
  const mb = ((await out(git, ['merge-base', base, ref], repo)) ?? '').trim();
  if (mb) {
    const files = ((await out(git, ['diff', '--name-only', '--no-renames', mb, ref], repo)) ?? '').split('\n').filter(Boolean);
    if (files.length) {
      const diff = await out(git, ['diff', '--no-color', '--no-ext-diff', '--no-renames', mb, ref], repo);
      if (diff) {
        try {
          const mine = (await deps.gitInput(['patch-id', '--stable'], repo, diff)).trim().split(/\s+/)[0];
          const log = await out(git, ['log', '-p', '--no-merges', '--no-color', '--no-ext-diff', '--no-renames', `${mb}..${base}`, '--', ...files], repo);
          if (mine && log) {
            const ids = (await deps.gitInput(['patch-id', '--stable'], repo, log)).split('\n').map((l) => l.split(' ')[0]);
            if (ids.includes(mine)) return { how: 'squash-merged' };
          }
        } catch {
          /* patch-id unavailable: not provably merged */
        }
      }
    }
  }
  return { none: `not merged into ${base}` };
}

/** What `git branch -d` will say, predicted: it wants the branch merged into its upstream, or HEAD without one. */
async function branchDeletable(repo: string, branch: string, git: AsyncGitRunner): Promise<{ ok: boolean; note?: string }> {
  const up = ((await out(git, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', `refs/heads/${branch}@{upstream}`], repo)) ?? '').trim();
  const target = up || 'HEAD';
  if (await ok(git, ['merge-base', '--is-ancestor', `refs/heads/${branch}`, target], repo)) return { ok: true };
  return { ok: false, note: `branch kept: git branch -d refuses, it is not merged into ${up || 'the checked-out branch'} (squash merges look unmerged to git)` };
}

const real = (p: string): string => {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
};

const inside = (dir: string, root: string) => dir === root || dir.startsWith(root + '/');

type Check = { skip: string } | { keep: true; merge: string };

/** Everything except the live check, in order of what is worth saying first. */
async function staticCheck(repo: string, t: ListedTree, base: string, deps: PruneDeps, stashes: string[], managed: Map<string, string>): Promise<Check> {
  const baseName = base.startsWith('origin/') ? base.slice('origin/'.length) : base;
  if (t.primary) return { skip: 'the primary checkout' };
  if (t.locked) return { skip: 'locked (git worktree lock)' };
  const owner = managed.get(real(t.path));
  if (owner) return { skip: owner };
  if (t.prunable || !fs.existsSync(t.path)) return { skip: 'directory is missing (git worktree prune clears the record)' };
  if (real(t.path) === real(repo)) return { skip: 'the primary checkout' };
  if (!t.branch) return { skip: 'detached HEAD: no branch to test' };
  if (t.branch === baseName) return { skip: `on the base branch ${baseName}` };

  let status: string;
  try {
    status = await deps.git(['status', '--porcelain'], t.path);
  } catch (e) {
    return { skip: 'git status failed: ' + firstLine(e) };
  }
  const changed = status.split('\n').filter((l) => l.trim()).length;
  if (changed) return { skip: `not clean: ${changed} changed or untracked path${changed === 1 ? '' : 's'}` };

  const mine = stashes.filter((s) => s.startsWith(`WIP on ${t.branch}:`) || s.startsWith(`On ${t.branch}:`)).length;
  if (mine) return { skip: `${mine} stash entr${mine === 1 ? 'y' : 'ies'} on ${t.branch}` };

  const m = await mergedHow(repo, t.branch, base, deps);
  if ('none' in m) return { skip: m.none };
  return { keep: true, merge: m.how };
}

function liveReason(t: ListedTree, dirs: LiveDir[]): string | null {
  const root = real(t.path);
  const hits = dirs.filter((d) => inside(d.dir, root) || inside(real(d.dir), root));
  if (!hits.length) return null;
  const shown = [...new Set(hits.map((h) => h.what))];
  return `in use: ${shown.slice(0, 3).join(', ')}${shown.length > 3 ? ` +${shown.length - 3} more` : ''}`;
}

/* -------------------------------------------------------------- the run */

const SCAN_CONCURRENCY = 6;

/** Bounded-concurrency map that keeps order. */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await fn(items[i]);
  }));
  return results;
}

const locks = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier prune of the same repo has settled. */
function serialised<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  const tail = next.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
  return next;
}

/**
 * Prune one repo. `repo` may be any directory inside it. Dry runs make the same
 * checks and stop short of the two git writes; branch deletion is predicted.
 */
export function pruneMergedWorktrees(repoDir: string, opts: PruneOpts = {}): Promise<PruneResult> {
  const deps: PruneDeps = { ...defaultPruneDeps, ...(opts.deps ?? {}) };
  const repo = repoRootFor(repoDir) ?? repoDir;
  return serialised(real(repo), () => pruneNow(repo, opts, deps));
}

async function pruneNow(repo: string, opts: PruneOpts, deps: PruneDeps): Promise<PruneResult> {
  const dryRun = !!opts.dryRun;
  const result: PruneResult = { repo, base: '', dryRun, trigger: opts.trigger ?? 'api', startedAt: deps.now(), finishedAt: 0, removed: [], skipped: [] };
  const finish = (): PruneResult => {
    result.finishedAt = deps.now();
    if (!dryRun) {
      if (result.removed.length) invalidateTrees();
      if (opts.db) result.id = recordRun(opts.db, result);
    }
    return result;
  };

  if (!repoRootFor(repo)) {
    result.error = 'not a git repository';
    return finish();
  }
  const base = opts.base ?? (await resolvePruneBase(repo, deps.git, opts.db));
  if (!base) {
    result.error = 'no base branch: set one in Settings › Ship, or run git remote set-head origin --auto';
    return finish();
  }
  result.base = base;

  let listed: ListedTree[];
  try {
    listed = parsePorcelainTrees(await deps.git(['worktree', 'list', '--porcelain'], repo));
  } catch (e) {
    result.error = 'git worktree list failed: ' + firstLine(e);
    return finish();
  }

  // A dry run reads the process table once; a real run reads it again for each
  // tree, immediately before removing it.
  let snapshot: LiveDir[] | null = null;
  const live = async (): Promise<LiveDir[]> => {
    if (!dryRun) return deps.liveDirs();
    snapshot ??= await deps.liveDirs();
    return snapshot;
  };

  const only = opts.only ? new Set(opts.only) : null;
  const stashList = async () => ((await out(deps.git, ['stash', 'list', '--format=%gs'], repo)) ?? '').split('\n').filter(Boolean);
  // First pass, read-only and in parallel: which trees could go at all. A real
  // run then re-checks each candidate from scratch, one at a time, immediately
  // before removing it; the first pass only decides what is worth re-checking.
  const firstStashes = await stashList();
  const managedNow = async () => {
    try {
      return await deps.managedElsewhere();
    } catch {
      return new Map<string, string>();
    }
  };
  const firstManaged = await managedNow();
  const first = await pool(listed, SCAN_CONCURRENCY, async (t): Promise<Check> => {
    const c = await staticCheck(repo, t, base, deps, firstStashes, firstManaged);
    // Outside the confirmed list: keep the real reason when there is one.
    return only && !only.has(t.path) && !('skip' in c) ? { skip: 'not in the confirmed list' } : c;
  });

  for (let i = 0; i < listed.length; i++) {
    const t = listed[i];
    const skip = (reason: string) => result.skipped.push({ path: t.path, name: t.name, branch: t.branch, reason });
    let c = first[i];
    if ('skip' in c) { skip(c.skip); continue; }
    if (!dryRun) {
      c = await staticCheck(repo, t, base, deps, await stashList(), await managedNow());
      if ('skip' in c) { skip(c.skip); continue; }
    }
    let dirs: LiveDir[];
    try {
      dirs = await live();
    } catch (e) {
      skip('could not check for running processes: ' + firstLine(e));
      continue;
    }
    const busy = liveReason(t, dirs);
    if (busy) { skip(busy); continue; }

    const branch = t.branch!;
    if (dryRun) {
      const d = await branchDeletable(repo, branch, deps.git);
      result.removed.push({ path: t.path, name: t.name, branch, merge: c.merge, branchDeleted: d.ok, ...(d.note ? { branchNote: d.note } : {}) });
      continue;
    }

    try {
      await deps.git(['worktree', 'remove', t.path], repo);
    } catch (e) {
      skip('git worktree remove refused: ' + firstLine(e));
      continue;
    }
    const entry: PruneRemoved = { path: t.path, name: t.name, branch, merge: c.merge, branchDeleted: false };
    try {
      await deps.git(['branch', '-d', branch], repo);
      entry.branchDeleted = true;
    } catch (e) {
      entry.branchNote = 'branch kept: git branch -d refused: ' + firstLine(e);
    }
    result.removed.push(entry);
  }
  return finish();
}

/* ------------------------------------------------------------- history */

export interface PruneRun {
  id: number;
  repo: string;
  trigger: string;
  started_at: number;
  finished_at: number;
  removed: PruneRemoved[];
  skipped: PruneSkipped[];
  error: string;
}

export function recordRun(db: Database.Database, r: PruneResult): number {
  const info = db
    .prepare(`INSERT INTO tree_prune_runs (repo, trigger, started_at, finished_at, removed, skipped, error) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(r.repo, r.trigger, r.startedAt, r.finishedAt, JSON.stringify(r.removed), JSON.stringify(r.skipped), r.error ?? '');
  db.prepare(`DELETE FROM tree_prune_runs WHERE id NOT IN (SELECT id FROM tree_prune_runs ORDER BY id DESC LIMIT ?)`).run(HISTORY_KEEP);
  return Number(info.lastInsertRowid);
}

export function listRuns(db: Database.Database, opts: { limit?: number; sinceId?: number } = {}): PruneRun[] {
  const rows = db
    .prepare(`SELECT * FROM tree_prune_runs WHERE id > ? ORDER BY id DESC LIMIT ?`)
    .all(opts.sinceId ?? 0, Math.min(opts.limit ?? 10, HISTORY_KEEP)) as (Omit<PruneRun, 'removed' | 'skipped'> & { removed: string; skipped: string })[];
  const parse = <T>(s: string): T[] => {
    try {
      const v = JSON.parse(s);
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return rows.map((r) => ({ ...r, removed: parse<PruneRemoved>(r.removed), skipped: parse<PruneSkipped>(r.skipped) }));
}

/** One line for a toast or the history list. */
export function summarize(r: Pick<PruneResult, 'removed' | 'skipped' | 'dryRun' | 'error'> & { repo: string }): string {
  const name = path.basename(r.repo);
  if (r.error) return `${name}: prune failed, ${r.error}`;
  const n = r.removed.length;
  const verb = r.dryRun ? 'would remove' : 'removed';
  const kept = r.skipped.filter((s) => s.reason !== 'the primary checkout' && s.reason !== 'not in the confirmed list').length;
  return `${name}: ${verb} ${n} worktree${n === 1 ? '' : 's'}, kept ${kept}`;
}

/* ------------------------------------------------------------ repos */

/** Repos Loom knows: where indexed chats ran, plus the Ship list. */
export function knownRepos(db: Database.Database): string[] {
  const dirs = new Set<string>();
  try {
    for (const r of db.prepare(`SELECT DISTINCT project_dir FROM chats`).all() as { project_dir: string }[]) if (r.project_dir) dirs.add(r.project_dir);
  } catch {
    /* no chats table */
  }
  try {
    for (const p of listShipProjects(db, { includeDisabled: true })) dirs.add(p.project_dir);
  } catch {
    /* no ship table */
  }
  const roots = new Set<string>();
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue;
    const root = repoRootFor(d);
    if (root) roots.add(root);
  }
  return [...roots].sort();
}

/* ---------------------------------------------------------- after ship */

export interface ShipSeen {
  repo: string;
  shipped: { number: number; mergedAt: number }[];
}

/**
 * Called with every fresh set of ship boards. A ship counts once: the first
 * board that shows it merged claims its row, and only ships merged after Loom
 * first watched the repo can fire (the first sighting seeds the history, so a
 * new install does not prune for last week's ships). Several new ships in one
 * pass make one run. Ships seen while the setting is off are recorded and never
 * fire later.
 */
export function pruneAfterShips(
  db: Database.Database,
  boards: ShipSeen[],
  opts: { now?: number; prune?: (repo: string, trigger: string) => Promise<unknown> } = {},
): { repo: string; ships: number[] }[] {
  const now = opts.now ?? Date.now();
  const on = getSetting(db, 'trees_prune_after_ship');
  const fired: { repo: string; ships: number[] }[] = [];
  const claim = db.prepare(`INSERT OR IGNORE INTO tree_prune_ships (repo, pr_number, merged_at, seen_at, status) VALUES (?, ?, ?, ?, ?)`);
  for (const b of boards) {
    const merged = b.shipped.filter((s) => s.mergedAt > 0 && s.number > 0);
    const fresh: number[] = [];
    db.transaction(() => {
      const seed = db.prepare(`SELECT seen_at FROM tree_prune_ships WHERE repo = ? AND pr_number = 0`).get(b.repo) as { seen_at: number } | undefined;
      if (!seed) {
        claim.run(b.repo, 0, 0, now, 'seed');
        for (const s of merged) claim.run(b.repo, s.number, s.mergedAt, now, 'before');
        return;
      }
      for (const s of merged) {
        const status = s.mergedAt < seed.seen_at ? 'before' : on ? 'fired' : 'off';
        if (claim.run(b.repo, s.number, s.mergedAt, now, status).changes === 1 && status === 'fired') fresh.push(s.number);
      }
    })();
    if (!fresh.length) continue;
    fired.push({ repo: b.repo, ships: fresh });
    const trigger = `ship ${fresh.map((n) => '#' + n).join(' ')}`;
    const go = opts.prune ?? ((repo: string, trig: string) => pruneMergedWorktrees(repo, { trigger: trig, db }));
    void Promise.resolve()
      .then(() => go(b.repo, trigger))
      .catch((e) => console.error('[loom] prune after ship failed for', b.repo, (e as Error).message));
  }
  return fired;
}

async function withOwnDb<T>(fn: (db: Database.Database) => Promise<T>): Promise<T> {
  const db = openDb();
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

/** server.ts calls this after each ship-board refresh. Never throws. */
export function onShipBoards(boards: ShipSeen[]): void {
  let db: Database.Database | null = null;
  try {
    db = openDb();
    pruneAfterShips(db, boards, { prune: (repo, trigger) => withOwnDb((own) => pruneMergedWorktrees(repo, { trigger, db: own })) });
  } catch (e) {
    console.error('[loom] prune after ship skipped:', (e as Error).message);
  } finally {
    db?.close();
  }
}
