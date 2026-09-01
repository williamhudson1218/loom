import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  inspectWorktreesAsync,
  resolveBaseRefAsync,
  changedFilesAsync,
  fileDiffAsync,
  removalPlan,
  removeWorktree,
  type ChangedFile,
  type DiffMode,
  type WorktreeState,
} from './git.ts';

/**
 * The Trees tab's data layer: which repositories Loom knows about, their worktree
 * state, and a cache in front of it.
 *
 * Repos are discovered from the sessions Loom has already indexed rather than
 * configured — `chats.project_dir` is where each session was launched, so the set
 * of repos Will actually works in falls out of the board for free.
 */

export interface RepoTrees {
  root: string;
  name: string;
  base: string;
  worktrees: WorktreeState[];
}

export interface TreesPayload {
  generatedAt: number;
  scanMs: number;
  stale: boolean;
  repos: RepoTrees[];
}

/**
 * Collapse any directory to the main worktree of its repository.
 *
 * `--git-common-dir` is the important flag: inside `.worktrees/filing-tx-c3` the
 * plain `--show-toplevel` answers with that worktree, which would list the same
 * repository 44 times. The common dir always points at the primary `.git`.
 */
export function repoRootFor(dir: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: dir,
      encoding: 'utf-8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    // A bare repo has no working tree to browse.
    if (path.basename(out) !== '.git') return null;
    return path.dirname(out);
  } catch {
    return null;
  }
}

export function discoverRepos(projectDirs: string[]): string[] {
  const roots = new Set<string>();
  const seenDirs = new Set<string>();
  for (const dir of projectDirs) {
    if (!dir || seenDirs.has(dir)) continue;
    seenDirs.add(dir);
    const root = repoRootFor(dir);
    if (root) roots.add(root);
  }
  return [...roots].sort();
}

/** worktree path -> tmux session names living there, for the rail's live badges. */
export function liveByPath(
  sessions: { project_dir: string; tmux_session: string }[],
): Record<string, string[]> {
  const map: Record<string, string[]> = {};
  for (const s of sessions) {
    if (!s.project_dir || !s.tmux_session) continue;
    const list = (map[s.project_dir] ??= []);
    if (!list.includes(s.tmux_session)) list.push(s.tmux_session);
  }
  return map;
}

/* -------------------------------------------------------------------- cache */

// A full scan is ~2.4s for 44 worktrees. Far too slow to sit inside the
// dashboard's 5s poll, so the tab reads this cache and asks for a refresh
// explicitly; a scan already in flight is shared rather than duplicated.
const TTL_MS = 30_000;

interface Entry {
  at: number;
  scanMs: number;
  repos: RepoTrees[];
}

let cache: Entry | null = null;
let inflight: Promise<Entry> | null = null;

export interface ScanInput {
  projectDirs: string[];
  live: Record<string, string[]>;
}

async function scan(input: ScanInput): Promise<Entry> {
  const t0 = Date.now();
  const roots = discoverRepos(input.projectDirs);
  const repos: RepoTrees[] = [];
  for (const root of roots) {
    const base = await resolveBaseRefAsync(root);
    const worktrees = await inspectWorktreesAsync(root, { base, liveByPath: input.live });
    if (worktrees.length) repos.push({ root, name: path.basename(root), base, worktrees });
  }
  // Busiest repo first — the one with the most worktrees is the one being asked about.
  repos.sort((a, b) => b.worktrees.length - a.worktrees.length);
  return { at: Date.now(), scanMs: Date.now() - t0, repos };
}

export async function getTrees(input: ScanInput, opts: { force?: boolean } = {}): Promise<TreesPayload> {
  const fresh = cache && Date.now() - cache.at < TTL_MS;
  if (fresh && !opts.force) {
    return { generatedAt: cache!.at, scanMs: cache!.scanMs, stale: false, repos: cache!.repos };
  }
  if (!inflight) {
    inflight = scan(input).finally(() => { inflight = null; });
  }
  cache = await inflight;
  return { generatedAt: cache.at, scanMs: cache.scanMs, stale: false, repos: cache.repos };
}

/** Everything currently known, without triggering a scan. */
export function cachedWorktrees(): WorktreeState[] {
  return cache ? cache.repos.flatMap((r) => r.worktrees) : [];
}

export function cachedRepoFor(wtPath: string): RepoTrees | null {
  if (!cache) return null;
  return cache.repos.find((r) => r.worktrees.some((w) => w.path === wtPath)) ?? null;
}

export function invalidate(): void {
  cache = null;
}

/**
 * Only ever run git in a directory a scan has already vouched for. `wt` arrives
 * on a query string, so without this an arbitrary path reaches execFile.
 */
export function knownWorktree(wtPath: string): WorktreeState | null {
  return cachedWorktrees().find((w) => w.path === wtPath) ?? null;
}

/* ------------------------------------------------------------------- reads */

export async function filesFor(wtPath: string, mode: DiffMode): Promise<ChangedFile[] | null> {
  const wt = knownWorktree(wtPath);
  const repo = cachedRepoFor(wtPath);
  if (!wt || !repo) return null;
  return changedFilesAsync(wt.path, mode, repo.base);
}

export async function diffFor(wtPath: string, file: string, mode: DiffMode): Promise<string | null> {
  const wt = knownWorktree(wtPath);
  const repo = cachedRepoFor(wtPath);
  if (!wt || !repo) return null;
  return fileDiffAsync(wt.path, file, mode, repo.base);
}

/* ---------------------------------------------------------------- removal */

export interface RemoveOutcome {
  ok: boolean;
  removed: { name: string; path: string; branchDeleted: boolean }[];
  refused: { name: string; path: string; reason: string }[];
  failed: { name: string; path: string; detail: string }[];
}

/**
 * Destructive. Rescans first and re-derives permission from that fresh state, so
 * a tab left open since before an agent started editing cannot remove a worktree
 * that has since picked up work.
 */
export async function removeWorktrees(input: ScanInput, paths: string[]): Promise<RemoveOutcome> {
  await getTrees(input, { force: true });

  const outcome: RemoveOutcome = { ok: true, removed: [], refused: [], failed: [] };
  const byRepo = new Map<string, WorktreeState[]>();

  const plan = removalPlan(cachedWorktrees(), paths);
  outcome.refused = plan.refused.map((r) => ({ name: r.name, path: r.path, reason: r.reason }));

  for (const state of plan.approved) {
    const repo = cachedRepoFor(state.path);
    if (!repo) {
      outcome.refused.push({ name: state.name, path: state.path, reason: 'repository no longer known' });
      continue;
    }
    const list = byRepo.get(repo.root) ?? [];
    list.push(state);
    byRepo.set(repo.root, list);
  }

  for (const [root, states] of byRepo) {
    for (const state of states) {
      const r = removeWorktree(root, state);
      if (r.ok) outcome.removed.push({ name: r.name, path: r.path, branchDeleted: r.branchDeleted });
      else {
        outcome.failed.push({ name: r.name, path: r.path, detail: r.detail });
        outcome.ok = false;
      }
    }
  }

  invalidate();
  return outcome;
}
