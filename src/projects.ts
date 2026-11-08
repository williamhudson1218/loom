import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

// The folders a chat can be started in. The table is seeded from the project
// dirs of indexed chats (insert-if-missing, so a rename or hide survives a
// restart), then managed from the New thread dialog and the Settings tab.
// Removing a row never touches the folder.

export interface Project {
  id: number;
  path: string;
  name: string;
  color: string;
  hidden: boolean;
  added_at: number;
  last_used_at: number;
}

const PALETTE = ['#6ea2ff', '#56d364', '#e8b84b', '#d787d7', '#ff875f', '#5ec8ff', '#ff5f8f', '#9be8b4'];
export const colorFor = (p: string): string => PALETTE[[...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % PALETTE.length];

type Row = Omit<Project, 'hidden'> & { hidden: number };
const toProject = (r: Row): Project => ({ ...r, hidden: r.hidden === 1 });

/** An absolute, existing directory's real path, or an error message. */
export function checkProjectPath(raw: string): { ok: true; path: string } | { ok: false; detail: string } {
  const p = (raw ?? '').trim();
  if (!p) return { ok: false, detail: 'Enter a folder path.' };
  if (!path.isAbsolute(p)) return { ok: false, detail: 'The path must be absolute.' };
  try {
    if (!fs.statSync(p).isDirectory()) return { ok: false, detail: 'That path is not a folder.' };
    return { ok: true, path: fs.realpathSync(p) };
  } catch {
    return { ok: false, detail: 'That folder does not exist.' };
  }
}

/** Insert every indexed chat's project dir that is not a row yet. Never updates an existing row. Returns how many were added. */
export function seedProjects(db: Database.Database, now: number = Date.now()): number {
  const dirs = (db.prepare(`SELECT DISTINCT project_dir FROM chats WHERE project_dir != ''`).all() as { project_dir: string }[]).map((r) => r.project_dir);
  const ins = db.prepare(`INSERT OR IGNORE INTO projects (path, name, color, added_at) VALUES (?, ?, ?, ?)`);
  let added = 0;
  for (const d of dirs) {
    if (d.includes('/.worktrees/')) continue; // a worktree is a branch of a project, not one itself
    const c = checkProjectPath(d);
    if (!c.ok) continue;
    added += ins.run(c.path, path.basename(c.path), colorFor(c.path), now).changes;
  }
  return added;
}

export function addProject(db: Database.Database, raw: string, now: number = Date.now()): { ok: true; project: Project } | { ok: false; detail: string } {
  const c = checkProjectPath(raw);
  if (!c.ok) return c;
  db.prepare(`INSERT INTO projects (path, name, color, added_at) VALUES (?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET hidden = 0`).run(c.path, path.basename(c.path), colorFor(c.path), now);
  return { ok: true, project: toProject(db.prepare(`SELECT * FROM projects WHERE path = ?`).get(c.path) as Row) };
}

/** Most recently used first (never-used last, newest added first), then name. Hidden ones only when asked. */
export function listProjects(db: Database.Database, opts: { includeHidden?: boolean } = {}): Project[] {
  return (db.prepare(`SELECT * FROM projects ${opts.includeHidden ? '' : 'WHERE hidden = 0'} ORDER BY last_used_at DESC, added_at DESC, name COLLATE NOCASE`).all() as Row[]).map(toProject);
}

export function updateProject(db: Database.Database, id: number, patch: { name?: string; color?: string; hidden?: boolean }): Project | null {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row | undefined;
  if (!row) return null;
  const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 80) : row.name;
  const color = typeof patch.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(patch.color) ? patch.color : row.color;
  const hidden = typeof patch.hidden === 'boolean' ? (patch.hidden ? 1 : 0) : row.hidden;
  db.prepare(`UPDATE projects SET name = ?, color = ?, hidden = ? WHERE id = ?`).run(name, color, hidden, id);
  return toProject(db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as Row);
}

/** Deletes the row only. */
export function removeProject(db: Database.Database, id: number): boolean {
  return db.prepare(`DELETE FROM projects WHERE id = ?`).run(id).changes > 0;
}

/** A chat was started in `dir`: bump it, adding the row if the folder is new. */
export function touchProject(db: Database.Database, dir: string, now: number = Date.now()): void {
  try {
    const c = checkProjectPath(dir);
    const p = c.ok ? c.path : dir;
    const r = db.prepare(`UPDATE projects SET last_used_at = ? WHERE path = ?`).run(now, p);
    if (!r.changes && c.ok) db.prepare(`INSERT INTO projects (path, name, color, added_at, last_used_at) VALUES (?, ?, ?, ?, ?)`).run(p, path.basename(p), colorFor(p), now, now);
  } catch {
    /* bookkeeping only */
  }
}

/** The visible project a chat was last started in, if any. */
export function lastUsedProject(db: Database.Database): string | null {
  try {
    return (db.prepare(`SELECT path FROM projects WHERE hidden = 0 AND last_used_at > 0 ORDER BY last_used_at DESC LIMIT 1`).get() as { path: string } | undefined)?.path ?? null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------- Ship projects */
// The repos Ship works on (ship_projects). An empty table means no Ship line.
// Per row: the base branch a ship targets, the command the Ship button sends
// into a new chat in the repo, whether a chat must carry a "what I'm shipping"
// label (the plugin's label hook), and an enabled switch.

export const DEFAULT_SHIP_COMMAND = '/loom:ship';
const MAX_SHIP_COMMAND = 200;

export interface ShipProject {
  project_dir: string;
  repo_slug: string;
  base_branch: string;
  ship_command: string;
  label_required: boolean;
  enabled: boolean;
  added_at: number;
}

type ShipRow = Omit<ShipProject, 'label_required' | 'enabled'> & { label_required: number; enabled: number };
const toShip = (r: ShipRow): ShipProject => ({ ...r, label_required: r.label_required === 1, enabled: r.enabled === 1 });

/** Sync git for the small probes below. Throws on a non-zero exit. */
export type SyncGit = (args: string[], cwd: string) => string;
export const defaultSyncGit: SyncGit = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });

function tryGit(git: SyncGit, args: string[], cwd: string): string {
  try {
    return git(args, cwd).trim();
  } catch {
    return '';
  }
}

/** The branch ships target: origin's HEAD when the clone knows it, else `main`. */
export function detectBaseBranch(repo: string, git: SyncGit = defaultSyncGit): string {
  const ref = tryGit(git, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo); // origin/main
  const m = /^origin\/(.+)$/.exec(ref);
  return m && /^[A-Za-z0-9._\/-]+$/.test(m[1]) ? m[1] : 'main';
}

/** owner/name of origin when it is a GitHub remote, else ''. */
export function detectRepoSlug(repo: string, git: SyncGit = defaultSyncGit): string {
  const m = tryGit(git, ['remote', 'get-url', 'origin'], repo).match(/github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  return m ? m[1] : '';
}

/** The root of the primary checkout that contains `dir` (a worktree resolves to its main checkout), or ''. */
export function gitRepoRoot(dir: string, git: SyncGit = defaultSyncGit): string {
  const common = tryGit(git, ['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  if (!common) return '';
  const top = path.basename(common) === '.git' ? path.dirname(common) : tryGit(git, ['rev-parse', '--show-toplevel'], dir);
  try {
    return top ? fs.realpathSync(top) : '';
  } catch {
    return '';
  }
}

/** A ship command is a slash command line: `/ship`, `/loom:ship`, `/team:release main`. Forced landings are never configurable here. */
export function checkShipCommand(raw: unknown): { ok: true; command: string } | { ok: false; detail: string } {
  const c = typeof raw === 'string' ? raw.trim() : '';
  if (!c) return { ok: true, command: DEFAULT_SHIP_COMMAND };
  if (c.length > MAX_SHIP_COMMAND) return { ok: false, detail: 'The ship command is too long.' };
  if (!c.startsWith('/') || /[\r\n\0]/.test(c)) return { ok: false, detail: 'The ship command must be one line starting with /.' };
  if (/(^|\s)--?force\b/i.test(c)) return { ok: false, detail: 'Loom does not send forced landings. Run that by hand.' };
  return { ok: true, command: c };
}

export function listShipProjects(db: Database.Database, opts: { includeDisabled?: boolean } = {}): ShipProject[] {
  return (db.prepare(`SELECT * FROM ship_projects ${opts.includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY added_at, project_dir`).all() as ShipRow[]).map(toShip);
}

export function getShipProject(db: Database.Database, dir: string): ShipProject | null {
  const r = db.prepare(`SELECT * FROM ship_projects WHERE project_dir = ?`).get(dir) as ShipRow | undefined;
  return r ? toShip(r) : null;
}

export interface AddShipInput {
  command?: unknown;
  labelRequired?: boolean;
  baseBranch?: string;
  enabled?: boolean;
}

/**
 * Put a git project on Ship. The path may be any folder inside the checkout: the
 * row is keyed by the primary checkout's root. Re-adding re-enables the row and
 * keeps its settings unless new ones are given.
 */
export function addShipProject(
  db: Database.Database,
  raw: string,
  input: AddShipInput = {},
  git: SyncGit = defaultSyncGit,
  now: number = Date.now(),
): { ok: true; project: ShipProject } | { ok: false; detail: string } {
  const c = checkProjectPath(raw);
  if (!c.ok) return c;
  const root = gitRepoRoot(c.path, git);
  if (!root) return { ok: false, detail: 'That folder is not a git repository.' };
  const cmd = checkShipCommand(input.command);
  if (!cmd.ok) return cmd;
  const base = (input.baseBranch ?? '').trim();
  if (base && !/^[A-Za-z0-9._\/-]{1,100}$/.test(base)) return { ok: false, detail: 'That is not a valid branch name.' };
  const existing = getShipProject(db, root);
  if (existing) {
    return updateShipProject(db, root, {
      enabled: input.enabled ?? true,
      ...(input.command !== undefined ? { ship_command: cmd.command } : {}),
      ...(input.labelRequired !== undefined ? { label_required: input.labelRequired } : {}),
      ...(base ? { base_branch: base } : {}),
    });
  }
  db.prepare(
    `INSERT INTO ship_projects (project_dir, repo_slug, base_branch, ship_command, label_required, enabled, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(root, detectRepoSlug(root, git), base || detectBaseBranch(root, git), cmd.command, input.labelRequired ? 1 : 0, input.enabled === false ? 0 : 1, now);
  return { ok: true, project: getShipProject(db, root)! };
}

export function updateShipProject(
  db: Database.Database,
  dir: string,
  patch: { ship_command?: unknown; base_branch?: string; label_required?: boolean; enabled?: boolean },
): { ok: true; project: ShipProject } | { ok: false; detail: string } {
  const row = getShipProject(db, dir);
  if (!row) return { ok: false, detail: 'unknown repo' };
  let command = row.ship_command;
  if (patch.ship_command !== undefined) {
    const c = checkShipCommand(patch.ship_command);
    if (!c.ok) return c;
    command = c.command;
  }
  let base = row.base_branch;
  if (patch.base_branch !== undefined) {
    const b = patch.base_branch.trim();
    if (b && !/^[A-Za-z0-9._\/-]{1,100}$/.test(b)) return { ok: false, detail: 'That is not a valid branch name.' };
    if (b) base = b;
  }
  const label = typeof patch.label_required === 'boolean' ? patch.label_required : row.label_required;
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : row.enabled;
  db.prepare(`UPDATE ship_projects SET ship_command = ?, base_branch = ?, label_required = ?, enabled = ? WHERE project_dir = ?`).run(command, base, label ? 1 : 0, enabled ? 1 : 0, dir);
  return { ok: true, project: getShipProject(db, dir)! };
}

/** Deletes the row only; labels and the folder stay. */
export function removeShipProject(db: Database.Database, dir: string): boolean {
  return db.prepare(`DELETE FROM ship_projects WHERE project_dir = ?`).run(dir).changes > 0;
}
