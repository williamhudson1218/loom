import { defaultGitAsync, type AsyncGitRunner } from './git.ts';
import { parsePorcelainZ, type PorcelainEntry } from './detail.ts';
import { chatEditsFor, fileState, groupNextShip, type NextShip, type ShipBoard, type ShipFileState } from './ships.ts';
import type { ChatView, LiveLoc } from './dashboard.ts';

// One git mark per chat on the chat list: is this chat's work done and staged?
//
// Which files are "the chat's":
//   - a linked worktree (git-dir differs from git-common-dir) belongs to the chat
//     working in it, so its whole `git status` is the chat's;
//   - on a shared checkout git cannot say who wrote what, so a chat's files are the
//     ones its own Edit/Write calls touched (the ship board's attribution,
//     groupNextShip). A Ship repo reuses the board's grouping; any other shared
//     checkout runs the same scan here.
// Precedence when mixed: untracked > unstaged (partial counts as unstaged) > staged > clean.

export type GitMarkState = 'clean' | 'staged' | 'unstaged' | 'untracked';

export interface GitMark {
  state: GitMarkState;
  staged: number;
  unstaged: number;
  untracked: number;
  worktree?: boolean;
}

/* ------------------------------------------------------------------ pure */

export function markFromStates(states: ShipFileState[], worktree = false): GitMark {
  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const s of states) {
    if (s === 'staged') staged++;
    else if (s === 'untracked') untracked++;
    else unstaged++; // unstaged, and partial (staged with further edits on top)
  }
  const state: GitMarkState = untracked ? 'untracked' : unstaged ? 'unstaged' : staged ? 'staged' : 'clean';
  return { state, staged, unstaged, untracked, ...(worktree ? { worktree: true } : {}) };
}

/** A worktree: everything changed in it is the chat's. */
export function markFromStatus(status: Map<string, PorcelainEntry>): GitMark {
  return markFromStates([...status.values()].map(fileState), true);
}

/** A shared checkout: each chat's own edited files, as the ship grouping matched them. A chat with none is clean. */
export function marksFromNext(next: NextShip, keys: string[]): Record<string, GitMark> {
  const out: Record<string, GitMark> = {};
  const rows = new Map(next.chats.map((c) => [c.key, c]));
  for (const k of keys) out[k] = markFromStates((rows.get(k)?.files ?? []).map((f) => f.state));
  return out;
}

export interface RepoLoc {
  top: string; // the checkout's toplevel
  worktree: boolean; // a linked worktree, not the primary checkout
}

/** `git rev-parse --path-format=absolute --show-toplevel --git-dir --git-common-dir` output. */
export function parseRevParse(out: string): RepoLoc | null {
  const [top, gitDir, common] = out.split('\n').map((x) => x.trim());
  if (!top || !gitDir || !common) return null;
  return { top, worktree: gitDir.replace(/\/$/, '') !== common.replace(/\/$/, '') };
}

/* --------------------------------------------------------------- refresh */

const CHAT_WINDOW_MS = 48 * 3_600_000; // same window the ship board attributes over
const LOC_TTL_MS = 5 * 60_000;
const STATUS_TTL_MS = 30_000; // worktrees and non-Ship shared checkouts

const locCache = new Map<string, { at: number; loc: RepoLoc | null }>();
const statusCache = new Map<string, { at: number; status: Map<string, PorcelainEntry> }>();

async function locFor(dir: string, git: AsyncGitRunner, now: number): Promise<RepoLoc | null> {
  const hit = locCache.get(dir);
  if (hit && now - hit.at < LOC_TTL_MS) return hit.loc;
  let loc: RepoLoc | null = null;
  try {
    loc = parseRevParse(await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-dir', '--git-common-dir'], dir));
  } catch {
    loc = null; // gone, or not a repo
  }
  locCache.set(dir, { at: now, loc });
  return loc;
}

async function statusFor(top: string, git: AsyncGitRunner, now: number): Promise<Map<string, PorcelainEntry> | null> {
  const hit = statusCache.get(top);
  if (hit && now - hit.at < STATUS_TTL_MS) return hit.status;
  try {
    const status = parsePorcelainZ(await git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], top));
    statusCache.set(top, { at: now, status });
    return status;
  } catch {
    return hit?.status ?? null;
  }
}

/** Every recent chat's git mark, keyed agent:session_id. One `git status` per checkout, at most. */
export async function buildGitMarks(
  views: ChatView[],
  live: Record<string, LiveLoc>,
  boards: ShipBoard[],
  git: AsyncGitRunner = defaultGitAsync,
  now: number = Date.now(),
): Promise<Record<string, GitMark>> {
  const out: Record<string, GitMark> = {};
  const worktrees = new Map<string, string[]>(); // top -> chat keys
  const shared = new Map<string, ChatView[]>();
  for (const v of views) {
    const key = `${v.agent}:${v.session_id}`;
    if (!v.project_dir || (!live[key] && now - v.last_active_at > CHAT_WINDOW_MS)) continue;
    const loc = await locFor(v.project_dir, git, now);
    if (!loc) continue;
    if (loc.worktree) worktrees.set(loc.top, [...(worktrees.get(loc.top) ?? []), key]);
    // Attribution on a shared checkout reads Claude transcripts; other agents get no mark there.
    else if (v.agent === 'claude') shared.set(loc.top, [...(shared.get(loc.top) ?? []), v]);
  }
  for (const [top, keys] of worktrees) {
    const status = await statusFor(top, git, now);
    if (!status) continue;
    const m = markFromStatus(status);
    for (const k of keys) out[k] = m;
  }
  for (const [top, vs] of shared) {
    const keys = vs.map((v) => `${v.agent}:${v.session_id}`);
    const board = boards.find((b) => b.repo === top && b.onMain);
    let next: NextShip;
    if (board) next = board.next;
    else {
      const status = await statusFor(top, git, now);
      if (!status) continue;
      next = groupNextShip(status, await chatEditsFor(top, vs, live, now));
    }
    Object.assign(out, marksFromNext(next, keys));
  }
  return out;
}

let marks: Record<string, GitMark> = {};
let building = false;

export function gitMarks(): Record<string, GitMark> {
  return marks;
}

/** Rebuild the marks after a ship-board pass; overlapping calls collapse into the one running. */
export async function refreshGitMarks(views: ChatView[], live: Record<string, LiveLoc>, boards: ShipBoard[]): Promise<Record<string, GitMark>> {
  if (building) return marks;
  building = true;
  try {
    marks = await buildGitMarks(views, live, boards);
    return marks;
  } finally {
    building = false;
  }
}
