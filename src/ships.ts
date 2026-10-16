import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultGitAsync, type AsyncGitRunner } from './git.ts';
import { defaultGh, parsePorcelainZ, type GhRunner, type PorcelainEntry } from './detail.ts';
import { scanTranscript } from './sessionscan.ts';
import type { ChatView, LiveLoc } from './dashboard.ts';

// Ship groups: which chats ride in the same /ship. On the shared main checkout
// git cannot say which chat wrote what, so a chat's share of a ship is the
// files its own Edit/Write calls touched (the same transcript scan the panel's
// "Files changed" uses), matched against three things:
//   - the next ship: what is changed on main right now, staged (done, will ride)
//     vs unstaged (still in progress, won't);
//   - the ship in flight: the lock holder and the batch it carries;
//   - recent ship/* PRs: their files ∩ each chat's edits, timed against the PR.

export type ShipFileState = 'staged' | 'unstaged' | 'partial' | 'untracked';

export interface ShipFile {
  path: string;
  state: ShipFileState;
  shared?: boolean; // another chat edited it too
}

export interface ChatEdits {
  key: string; // agent:session_id
  edits: Record<string, { first: number; last: number }>; // repo-relative path
  shipCmds: number[];
}

export interface NextShip {
  chats: { key: string; files: ShipFile[]; staged: number; unstaged: number }[];
  unattributed: ShipFile[];
  shared: string[];
  staged: number; // files that will ride
  unstaged: number;
}

export interface ShipLock {
  sessionId: string;
  pane: string;
  acquiredAt: number; // ms
  stale: boolean;
  holderKey: string; // the chat holding it, when on the board
  batch: string[];
}

export interface ShipPr {
  number: number;
  title: string;
  url: string;
  state: string;
  branch: string;
  createdAt: number;
  mergedAt: number;
  headAt: number; // last commit time: edits after this cannot be in it
  files: string[];
}

export interface ShippedGroup extends Omit<ShipPr, 'files'> {
  files: number;
  members: string[];
  runner: string;
}

export interface ShipBoard {
  repo: string; // primary checkout
  slug: string; // owner/name
  generatedAt: number;
  onMain: boolean;
  next: NextShip;
  lock: ShipLock | null;
  shipped: ShippedGroup[];
  // Per chat: its role in the next ship, and the ship PRs it rode (newest first).
  byChat: Record<string, { next?: 'staged' | 'unstaged' | 'both'; ships: number[] }>;
}

/* ------------------------------------------------------------------ pure */

export function fileState(e: PorcelainEntry): ShipFileState {
  if (e.x === '?' && e.y === '?') return 'untracked';
  const staged = e.x !== ' ' && e.x !== '';
  const dirty = e.y !== ' ' && e.y !== '';
  return staged && dirty ? 'partial' : staged ? 'staged' : 'unstaged';
}

const rides = (s: ShipFileState) => s === 'staged' || s === 'partial';
const STATE_ORDER: ShipFileState[] = ['staged', 'partial', 'unstaged', 'untracked'];
const byState = (a: ShipFile, b: ShipFile) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.path.localeCompare(b.path);

/** Group main's changed files by the chats that edited them. */
export function groupNextShip(status: Map<string, PorcelainEntry>, chats: ChatEdits[]): NextShip {
  const owners = new Map<string, string[]>();
  for (const c of chats) for (const p of Object.keys(c.edits)) if (status.has(p)) owners.set(p, [...(owners.get(p) ?? []), c.key]);
  const shared = [...owners].filter(([, o]) => o.length > 1).map(([p]) => p).sort();
  const sharedSet = new Set(shared);
  const rows: NextShip['chats'] = [];
  for (const c of chats) {
    const files: ShipFile[] = Object.keys(c.edits)
      .filter((p) => status.has(p))
      .map((p) => ({ path: p, state: fileState(status.get(p)!), ...(sharedSet.has(p) ? { shared: true } : {}) }))
      .sort(byState);
    if (!files.length) continue;
    const staged = files.filter((f) => rides(f.state)).length;
    rows.push({ key: c.key, files, staged, unstaged: files.length - staged });
  }
  rows.sort((a, b) => b.staged - a.staged || b.files.length - a.files.length || a.key.localeCompare(b.key));
  const unattributed = [...status].filter(([p]) => !owners.has(p)).map(([p, e]) => ({ path: p, state: fileState(e) })).sort(byState);
  let staged = 0;
  for (const e of status.values()) if (rides(fileState(e))) staged++;
  return { chats: rows, unattributed, shared, staged, unstaged: status.size - staged };
}

const RUNNER_WINDOW_MS = 3 * 3_600_000;

/**
 * A chat rode ship S when S changed a file the chat edited, the chat's first
 * edit of it came before S's head commit, and S is no later than the first
 * ship after the chat's LAST edit of it — a file edited once and shipped twice
 * only rode the first time. The runner is the chat that typed /ship just
 * before S's PR was opened.
 */
export function shippedMembership(ships: ShipPr[], chats: ChatEdits[]): ShippedGroup[] {
  const ordered = [...ships].sort((a, b) => a.headAt - b.headAt);
  const members = new Map<number, Set<string>>(ships.map((s) => [s.number, new Set<string>()]));
  for (const c of chats) {
    for (const [p, e] of Object.entries(c.edits)) {
      const touching = ordered.filter((s) => s.files.includes(p));
      const cutoff = touching.find((s) => s.headAt > e.last)?.headAt ?? Infinity;
      for (const s of touching) if (s.headAt > e.first && s.headAt <= cutoff) members.get(s.number)!.add(c.key);
    }
  }
  const runner = new Map<number, string>();
  const byCreated = [...ships].sort((a, b) => a.createdAt - b.createdAt);
  for (const c of chats) {
    for (const t of c.shipCmds) {
      const s = byCreated.find((x) => x.createdAt >= t && x.createdAt - t < RUNNER_WINDOW_MS);
      if (s && !runner.has(s.number)) runner.set(s.number, c.key);
    }
  }
  return ships.map(({ files, ...s }) => {
    const r = runner.get(s.number) ?? '';
    const m = members.get(s.number)!;
    if (r) m.add(r);
    return { ...s, files: files.length, members: [...m].sort(), runner: r };
  });
}

export function byChatIndex(next: NextShip, shipped: ShippedGroup[]): ShipBoard['byChat'] {
  const out: ShipBoard['byChat'] = {};
  const at = (k: string) => (out[k] ??= { ships: [] });
  for (const c of next.chats) at(c.key).next = c.staged && c.unstaged ? 'both' : c.staged ? 'staged' : 'unstaged';
  for (const s of [...shipped].sort((a, b) => b.createdAt - a.createdAt)) for (const k of s.members) at(k).ships.push(s.number);
  return out;
}

export function parseLock(raw: string, now: number = Date.now()): Omit<ShipLock, 'holderKey' | 'batch'> | null {
  try {
    const o = JSON.parse(raw);
    const acquired = Number(o?.acquired_at) || 0;
    return {
      sessionId: String(o?.session_id ?? ''),
      pane: String(o?.tmux_pane ?? ''),
      acquiredAt: acquired * 1000,
      stale: !acquired || now / 1000 - acquired > 300,
    };
  } catch {
    return null;
  }
}

export function toShipPr(raw: any): ShipPr | null {
  if (!raw || typeof raw.number !== 'number') return null;
  const commits: any[] = Array.isArray(raw.commits) ? raw.commits : [];
  const ms = (s: unknown) => (typeof s === 'string' ? Date.parse(s) || 0 : 0);
  const created = ms(raw.createdAt);
  return {
    number: raw.number,
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    state: String(raw.state ?? ''),
    branch: String(raw.headRefName ?? ''),
    createdAt: created,
    mergedAt: ms(raw.mergedAt),
    headAt: Math.max(created, ...commits.map((c) => ms(c?.committedDate))),
    files: (Array.isArray(raw.files) ? raw.files : []).map((f: any) => String(f?.path ?? '')).filter(Boolean),
  };
}

/* --------------------------------------------------------------- gathering */

const HOME = os.homedir();
export function shipRepos(): string[] {
  const env = process.env.LOOM_SHIP_REPOS;
  const list = env ? env.split(':').filter(Boolean) : [path.join(HOME, 'dev', 'tax-pilot-app')];
  return list.filter((d) => fs.existsSync(path.join(d, '.git')));
}

const CHAT_WINDOW_MS = 48 * 3_600_000; // chats this recent can belong to a listed ship
const SHIPS_TTL_MS = 60_000;
const SHIP_LIMIT = 12;

/** Every recent Claude chat's edits inside `repo`, repo-relative. Yields between transcripts. */
export async function chatEditsFor(repo: string, views: ChatView[], live: Record<string, LiveLoc>, now: number = Date.now()): Promise<ChatEdits[]> {
  const out: ChatEdits[] = [];
  const prefix = repo.endsWith('/') ? repo : repo + '/';
  for (const v of views) {
    if (v.agent !== 'claude') continue;
    const key = `${v.agent}:${v.session_id}`;
    if (!live[key] && now - v.last_active_at > CHAT_WINDOW_MS) continue;
    const s = scanTranscript(v.jsonl_path);
    const edits: ChatEdits['edits'] = {};
    for (const [abs, last] of Object.entries(s.editedFiles)) {
      if (!abs.startsWith(prefix)) continue;
      const rel = abs.slice(prefix.length);
      if (rel.startsWith('.worktrees/')) continue; // a worktree's files never ride a main ship
      edits[rel] = { first: s.editedFirst[abs] ?? last, last };
    }
    if (Object.keys(edits).length || s.shipCmds.length) out.push({ key, edits, shipCmds: s.shipCmds });
    await new Promise((r) => setImmediate(r));
  }
  return out;
}

const shipsCache = new Map<string, { at: number; rows: ShipPr[] }>();
async function recentShips(slug: string, gh: GhRunner, now: number): Promise<ShipPr[]> {
  const hit = shipsCache.get(slug);
  if (hit && now - hit.at < SHIPS_TTL_MS) return hit.rows;
  try {
    const out = await gh(['pr', 'list', '--repo', slug, '--search', 'head:ship/', '--state', 'all', '--limit', String(SHIP_LIMIT), '--json', 'number,title,url,state,headRefName,createdAt,mergedAt,files,commits'], HOME);
    const rows = (JSON.parse(out) as any[]).map(toShipPr).filter((x): x is ShipPr => !!x && x.branch.startsWith('ship/'));
    shipsCache.set(slug, { at: now, rows });
    return rows;
  } catch {
    // Keep the last answer through a gh hiccup; retry on the next pass.
    return hit?.rows ?? [];
  }
}

export function slugFromRemote(url: string): string {
  const m = url.trim().match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : '';
}

async function q(git: AsyncGitRunner, args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

export async function buildShipBoard(
  repo: string,
  views: ChatView[],
  live: Record<string, LiveLoc>,
  git: AsyncGitRunner = defaultGitAsync,
  gh: GhRunner = defaultGh,
  now: number = Date.now(),
): Promise<ShipBoard> {
  const slug = slugFromRemote(await q(git, ['remote', 'get-url', 'origin'], repo));
  const branch = (await q(git, ['rev-parse', '--abbrev-ref', 'HEAD'], repo)).trim();
  const onMain = branch === 'main' || branch === 'master';
  const status = onMain ? parsePorcelainZ(await q(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], repo)) : new Map<string, PorcelainEntry>();
  const chats = await chatEditsFor(repo, views, live, now);
  const next = groupNextShip(status, chats);

  let lock: ShipLock | null = null;
  const common = (await q(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], repo)).trim();
  if (common) {
    let raw = '';
    try {
      raw = fs.readFileSync(path.join(common, 'ship.lock'), 'utf-8');
    } catch {
      /* not held */
    }
    const l = raw ? parseLock(raw, now) : null;
    if (l) {
      const holder = views.find((v) => v.session_id === l.sessionId);
      // The batch is the index while it is being built; once committed, it is HEAD.
      let batch = [...status].filter(([, e]) => rides(fileState(e))).map(([p]) => p).sort();
      if (!batch.length) {
        const [at = '', ...files] = (await q(git, ['show', '--name-only', '--format=%ct', 'HEAD'], repo)).split('\n').map((x) => x.trim()).filter(Boolean);
        if (Number(at) * 1000 >= l.acquiredAt) batch = files;
      }
      lock = { ...l, holderKey: holder ? `${holder.agent}:${holder.session_id}` : '', batch };
    }
  }

  const shipped = slug ? shippedMembership(await recentShips(slug, gh, now), chats) : [];
  return { repo, slug, generatedAt: now, onMain, next, lock, shipped, byChat: byChatIndex(next, shipped) };
}

/* ------------------------------------------------------------------- cache */

let boards: ShipBoard[] = [];
let building = false;

export function shipBoards(): ShipBoard[] {
  return boards;
}

/** Rebuild every ship repo's board; overlapping calls collapse into the one running. */
export async function refreshShipBoards(views: ChatView[], live: Record<string, LiveLoc>): Promise<ShipBoard[]> {
  if (building) return boards;
  building = true;
  try {
    const out: ShipBoard[] = [];
    for (const repo of shipRepos()) {
      try {
        out.push(await buildShipBoard(repo, views, live));
      } catch (e) {
        console.error('[loom] ship board failed for', repo, (e as Error).message);
      }
    }
    boards = out;
    return boards;
  } finally {
    building = false;
  }
}
