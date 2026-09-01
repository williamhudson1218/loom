import { execFile, execFileSync } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Git plumbing for the Trees tab.
 *
 * Everything here is a pure parser plus a thin runner, following the injectable
 * `GhRunner` shape in src/em/actions.ts, so the classification rules can be
 * tested without a repo on disk. That matters more here than elsewhere in Loom:
 * this module is the only thing that ever deletes a directory, and the rule it
 * gets wrong is the rule that loses somebody's afternoon.
 */

export type GitRunner = (args: string[], cwd: string) => string;

// A worktree mid-`yarn install` can hold thousands of untracked files, so the
// status buffer has to be generous or the read throws instead of reporting.
const MAX_BUFFER = 64 * 1024 * 1024;

export const defaultGit: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 20_000, maxBuffer: MAX_BUFFER });

// Enough untracked names to judge whether the files matter, not enough to ship a
// 3907-entry array to the browser.
const MAX_UNTRACKED_PATHS = 20;

export interface Worktree {
  path: string;
  name: string;
  head: string;
  branch: string | null;
  primary: boolean;
}

export interface StatusCounts {
  trackedModified: number;
  untracked: number;
  untrackedPaths: string[];
}

export interface ChangedFile {
  added: number;
  deleted: number;
  path: string;
  binary?: boolean;
}

export type Verdict = 'primary' | 'safe' | 'untracked-only' | 'uncommitted' | 'active';

export interface WorktreeFacts extends Worktree, StatusCounts {
  behind: number;
  ahead: number;
  unmergedPatches: number;
  liveSessions: string[];
}

export interface WorktreeState extends WorktreeFacts {
  verdict: Verdict;
  removable: boolean;
  reason: string;
}

/* ------------------------------------------------------------------ parsers */

export function parseWorktreeList(out: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let cur: Partial<Worktree> & { bare?: boolean } = {};

  const flush = () => {
    if (cur.path && !cur.bare) {
      worktrees.push({
        path: cur.path,
        name: path.basename(cur.path),
        head: cur.head ?? '',
        branch: cur.branch ?? null,
        primary: worktrees.length === 0,
      });
    }
    cur = {};
  };

  for (const line of out.split('\n')) {
    if (line === '') { flush(); continue; }
    const sep = line.indexOf(' ');
    const key = sep === -1 ? line : line.slice(0, sep);
    const value = sep === -1 ? '' : line.slice(sep + 1);
    if (key === 'worktree') cur.path = value;
    else if (key === 'HEAD') cur.head = value;
    else if (key === 'branch') cur.branch = value.replace(/^refs\/heads\//, '');
    else if (key === 'bare') cur.bare = true;
    // `detached`, `locked`, `prunable` need no field — branch simply stays null.
  }
  flush();

  return worktrees;
}

export function parseStatus(out: string): StatusCounts {
  let trackedModified = 0;
  let untracked = 0;
  const untrackedPaths: string[] = [];

  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const code = line.slice(0, 2);
    if (code === '!!') continue; // ignored; only present with --ignored
    if (code === '??') {
      untracked += 1;
      if (untrackedPaths.length < MAX_UNTRACKED_PATHS) untrackedPaths.push(line.slice(3));
      continue;
    }
    trackedModified += 1;
  }

  return { trackedModified, untracked, untrackedPaths };
}

/** `rev-list --left-right --count <base>...HEAD` prints "<behind>\t<ahead>". */
export function parseAheadBehind(out: string): { behind: number; ahead: number } {
  const [behind, ahead] = out.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
  return {
    behind: Number.isFinite(behind) ? behind : 0,
    ahead: Number.isFinite(ahead) ? ahead : 0,
  };
}

/**
 * `git cherry <base> <branch>` marks each commit `+` (no equivalent upstream) or
 * `-` (already applied). Under squash-merge a merged branch keeps its commits, so
 * "commits ahead" never returns to zero and cannot be the removal test — patch
 * equivalence can.
 */
export function countUnmergedPatches(out: string): number {
  return out.split('\n').filter((l) => l.startsWith('+')).length;
}

export function parseNumstat(out: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const [a, d, ...rest] = line.split('\t');
    const filePath = rest.join('\t');
    if (!filePath) continue;
    if (a === '-' || d === '-') {
      files.push({ added: 0, deleted: 0, path: filePath, binary: true });
      continue;
    }
    files.push({ added: Number.parseInt(a, 10) || 0, deleted: Number.parseInt(d, 10) || 0, path: filePath });
  }
  return files;
}

/* ----------------------------------------------------------- classification */

/**
 * Verdict priority is deliberate and not reorderable: uncommitted tracked work
 * outranks every merge-based signal. The real `session-lifecycle-revocation`
 * worktree has zero commits and zero unmerged patches — every merge test calls it
 * disposable — while holding 20 modified files that exist nowhere else.
 */
export function classify(facts: WorktreeFacts): WorktreeState {
  const state = (verdict: Verdict, removable: boolean, reason: string): WorktreeState =>
    ({ ...facts, verdict, removable, reason });

  const live = facts.liveSessions.length
    ? `live in ${facts.liveSessions.join(', ')}`
    : null;

  if (facts.primary) return state('primary', false, 'the repository itself');

  if (facts.trackedModified > 0) {
    return state('uncommitted', false, `${facts.trackedModified} modified file${facts.trackedModified === 1 ? '' : 's'} not committed anywhere`);
  }

  if (facts.unmergedPatches > 0) {
    const why = `${facts.unmergedPatches} unmerged patch${facts.unmergedPatches === 1 ? '' : 'es'}`;
    return state('active', false, live ? `${why} · ${live}` : why);
  }

  if (facts.untracked > 0) {
    const shown = facts.untrackedPaths.slice(0, 3).join(', ');
    const more = facts.untracked > facts.untrackedPaths.slice(0, 3).length
      ? ` +${facts.untracked - Math.min(3, facts.untrackedPaths.length)} more`
      : '';
    return state('untracked-only', false, `merged, but ${facts.untracked} untracked file${facts.untracked === 1 ? '' : 's'} would be lost: ${shown}${more}`);
  }

  // Merged and clean — but a session living here is still using the directory.
  if (live) return state('safe', false, `merged and clean, but ${live}`);

  return state('safe', true, 'merged, clean, no live session');
}

export interface RemovalPlan {
  approved: WorktreeState[];
  refused: { path: string; name: string; reason: string }[];
}

/**
 * The destructive route's guard. Re-derives permission from freshly-read state
 * rather than trusting whatever the browser posted, so a stale tab cannot remove
 * a worktree that picked up changes since it rendered.
 */
export function removalPlan(states: WorktreeState[], requested: string[]): RemovalPlan {
  const plan: RemovalPlan = { approved: [], refused: [] };
  for (const wantPath of [...new Set(requested)]) {
    const state = states.find((s) => s.path === wantPath);
    if (!state) {
      plan.refused.push({ path: wantPath, name: path.basename(wantPath), reason: 'not a worktree of this repository' });
      continue;
    }
    if (!state.removable) {
      plan.refused.push({ path: state.path, name: state.name, reason: state.reason });
      continue;
    }
    plan.approved.push(state);
  }
  return plan;
}

/* --------------------------------------------------------------- git reads */

function quiet(git: GitRunner, args: string[], cwd: string, fallback = ''): string {
  try {
    return git(args, cwd);
  } catch {
    return fallback;
  }
}

/**
 * The comparison base. `origin/HEAD` is the honest answer where it is set; the
 * fallbacks cover clones that never had it written.
 */
export function resolveBaseRef(repoRoot: string, git: GitRunner = defaultGit): string {
  const head = quiet(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot).trim();
  if (head) return head.replace(/^refs\//, '').replace(/^remotes\//, '');
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if (quiet(git, ['rev-parse', '--verify', '--quiet', ref], repoRoot).trim()) return ref;
  }
  return 'HEAD';
}

export function listWorktrees(repoRoot: string, git: GitRunner = defaultGit): Worktree[] {
  return parseWorktreeList(quiet(git, ['worktree', 'list', '--porcelain'], repoRoot));
}

export interface InspectOptions {
  git?: GitRunner;
  base?: string;
  /** worktree path -> tmux session names currently living there */
  liveByPath?: Record<string, string[]>;
}

export function inspectWorktree(
  repoRoot: string,
  wt: Worktree,
  base: string,
  git: GitRunner,
  liveSessions: string[],
): WorktreeState {
  const status = parseStatus(quiet(git, ['status', '--porcelain'], wt.path));
  const { behind, ahead } = parseAheadBehind(
    quiet(git, ['rev-list', '--left-right', '--count', `${base}...HEAD`], wt.path),
  );
  // `git cherry` is skipped for the primary worktree: it is never removable, and
  // the call is the expensive one.
  const unmergedPatches = wt.primary
    ? 0
    : countUnmergedPatches(quiet(git, ['cherry', base, wt.branch ?? wt.head], repoRoot));

  return classify({ ...wt, ...status, behind, ahead, unmergedPatches, liveSessions });
}

export function inspectWorktrees(repoRoot: string, opts: InspectOptions = {}): WorktreeState[] {
  const git = opts.git ?? defaultGit;
  const base = opts.base ?? resolveBaseRef(repoRoot, git);
  const live = opts.liveByPath ?? {};
  return listWorktrees(repoRoot, git).map((wt) =>
    inspectWorktree(repoRoot, wt, base, git, live[wt.path] ?? []),
  );
}

/* ------------------------------------------------------- parallel inspection */

export type AsyncGitRunner = (args: string[], cwd: string) => Promise<string>;

export const defaultGitAsync: AsyncGitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', timeout: 20_000, maxBuffer: MAX_BUFFER });
  return stdout;
};

async function quietAsync(git: AsyncGitRunner, args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

/**
 * Bounded-concurrency map. No single git call here is slow — a full scan of 44
 * worktrees is ~220 invocations at roughly 30ms of process spawn each, so running
 * them serially costs about seven seconds and running eight at a time costs under
 * one. The limit exists because Will's laptop is usually hosting a dozen agent
 * sessions already; an unbounded fan-out would spawn 220 processes at once.
 */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

const SCAN_CONCURRENCY = 8;

export interface AsyncInspectOptions {
  git?: AsyncGitRunner;
  base?: string;
  liveByPath?: Record<string, string[]>;
}

export async function resolveBaseRefAsync(repoRoot: string, git: AsyncGitRunner = defaultGitAsync): Promise<string> {
  const head = (await quietAsync(git, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoRoot)).trim();
  if (head) return head.replace(/^refs\//, '').replace(/^remotes\//, '');
  for (const ref of ['origin/main', 'origin/master', 'main', 'master']) {
    if ((await quietAsync(git, ['rev-parse', '--verify', '--quiet', ref], repoRoot)).trim()) return ref;
  }
  return 'HEAD';
}

/** The server's read path. Same parsers and same `classify` as the sync version. */
export async function inspectWorktreesAsync(
  repoRoot: string,
  opts: AsyncInspectOptions = {},
): Promise<WorktreeState[]> {
  const git = opts.git ?? defaultGitAsync;
  const base = opts.base ?? (await resolveBaseRefAsync(repoRoot, git));
  const live = opts.liveByPath ?? {};
  const worktrees = parseWorktreeList(await quietAsync(git, ['worktree', 'list', '--porcelain'], repoRoot));

  return pool(worktrees, SCAN_CONCURRENCY, async (wt) => {
    const [statusOut, countOut, cherryOut] = await Promise.all([
      quietAsync(git, ['status', '--porcelain'], wt.path),
      quietAsync(git, ['rev-list', '--left-right', '--count', `${base}...HEAD`], wt.path),
      wt.primary ? Promise.resolve('') : quietAsync(git, ['cherry', base, wt.branch ?? wt.head], repoRoot),
    ]);
    return classify({
      ...wt,
      ...parseStatus(statusOut),
      ...parseAheadBehind(countOut),
      unmergedPatches: countUnmergedPatches(cherryOut),
      liveSessions: live[wt.path] ?? [],
    });
  });
}

export async function changedFilesAsync(
  wtPath: string,
  mode: DiffMode,
  base: string,
  git: AsyncGitRunner = defaultGitAsync,
): Promise<ChangedFile[]> {
  return parseNumstat(await quietAsync(git, ['diff', '--numstat', ...diffArgs(mode, base)], wtPath));
}

export async function fileDiffAsync(
  wtPath: string,
  file: string,
  mode: DiffMode,
  base: string,
  git: AsyncGitRunner = defaultGitAsync,
): Promise<string> {
  return quietAsync(git, ['diff', '--no-color', ...diffArgs(mode, base), '--', file], wtPath);
}

export type DiffMode = 'branch' | 'worktree';

function diffArgs(mode: DiffMode, base: string): string[] {
  // `base...HEAD` is the branch's own work, excluding whatever landed on main
  // since it forked — the question "what did this agent do", which survives the
  // agent committing. Worktree mode is the uncommitted edits only.
  return mode === 'branch' ? [`${base}...HEAD`] : [];
}

export function changedFiles(
  wtPath: string,
  mode: DiffMode,
  base: string,
  git: GitRunner = defaultGit,
): ChangedFile[] {
  return parseNumstat(quiet(git, ['diff', '--numstat', ...diffArgs(mode, base)], wtPath));
}

export function fileDiff(
  wtPath: string,
  file: string,
  mode: DiffMode,
  base: string,
  git: GitRunner = defaultGit,
): string {
  return quiet(git, ['diff', '--no-color', ...diffArgs(mode, base), '--', file], wtPath);
}

export interface RemovalResult {
  path: string;
  name: string;
  ok: boolean;
  detail: string;
  branchDeleted: boolean;
}

/**
 * Loom's first destructive on-disk action. No `--force`: if git has any objection
 * the removal fails loudly rather than being overridden, and the branch is only
 * deleted with `-d`, which itself refuses anything unmerged.
 */
export function removeWorktree(
  repoRoot: string,
  state: WorktreeState,
  git: GitRunner = defaultGit,
): RemovalResult {
  try {
    git(['worktree', 'remove', state.path], repoRoot);
  } catch (e) {
    return { path: state.path, name: state.name, ok: false, detail: (e as Error).message, branchDeleted: false };
  }

  let branchDeleted = false;
  if (state.branch) {
    try {
      git(['branch', '-d', state.branch], repoRoot);
      branchDeleted = true;
    } catch {
      /**
       * `-d` tests ancestry, and a squash-merged branch is not an ancestor of
       * main — so it refuses precisely the branches this feature exists to clean
       * up. Fall through to `-D` only when our own patch-equivalence check found
       * nothing unmerged, which is a stronger guarantee than the one `-d` just
       * failed: `git cherry` compares patch content, so it sees the squash that
       * ancestry cannot. Anything with unmerged patches keeps its branch, and in
       * either case the commits stay recoverable through the reflog.
       */
      if (state.unmergedPatches === 0) {
        try {
          git(['branch', '-D', state.branch], repoRoot);
          branchDeleted = true;
        } catch {
          branchDeleted = false;
        }
      }
    }
  }

  return { path: state.path, name: state.name, ok: true, detail: 'removed', branchDeleted };
}
