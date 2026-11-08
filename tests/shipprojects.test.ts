import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { addShipProject, checkShipCommand, detectBaseBranch, detectRepoSlug, gitRepoRoot, listShipProjects, removeShipProject, updateShipProject } from '../src/projects.ts';
import { buildShipBoard, findShipCandidates, shipConfigFor, shipConfigs, shipPluginState, shipRepos } from '../src/ships.ts';
import { buildShipDetail, mergeLabel, shipDisabledReason } from '../src/shipview.ts';
import { startShipSession } from '../src/shipdetail.ts';
import { migrateShip } from '../src/migrations/ship.ts';
import { routes, addHandler, updateHandler, removeHandler } from '../src/routes/ship.ts';
import { pluginStatePath } from '../src/pluginmgr.ts';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

let tmp: string;
let db: Database.Database;
const mkRepo = (name: string, opts: { remote?: string; base?: string } = {}) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(tmp, name + '-')));
  git(dir, 'init', '-q', '-b', 'main');
  if (opts.remote) git(dir, 'remote', 'add', 'origin', opts.remote);
  if (opts.base) git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${opts.base}`);
  return dir;
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-shipproj-'));
  db = new Database(':memory:');
  applySchema(db);
  delete process.env.LOOM_SHIP_REPOS;
});
afterEach(() => {
  delete process.env.LOOM_SHIP_REPOS;
  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a new database', () => {
  it('has no ship rows, so no repo, no board and no plugin gate', () => {
    expect(listShipProjects(db, { includeDisabled: true })).toEqual([]);
    expect(shipRepos(db)).toEqual([]);
    expect(shipConfigs(db)).toEqual([]);
    expect(shipPluginState(db)).toEqual({ repos: [], label_required: [] });
  });
});

describe('git probes', () => {
  it('detects the base branch from origin/HEAD, else main', () => {
    expect(detectBaseBranch(mkRepo('a', { remote: 'https://github.com/o/a.git', base: 'trunk' }))).toBe('trunk');
    expect(detectBaseBranch(mkRepo('b'))).toBe('main');
    expect(detectBaseBranch(path.join(tmp, 'nope'))).toBe('main');
  });
  it('reads the GitHub slug, and nothing for another host or no remote', () => {
    expect(detectRepoSlug(mkRepo('c', { remote: 'git@github.com:owner/name.git' }))).toBe('owner/name');
    expect(detectRepoSlug(mkRepo('d', { remote: 'https://gitlab.com/o/n.git' }))).toBe('');
    expect(detectRepoSlug(mkRepo('e'))).toBe('');
  });
  it('resolves a subfolder and a worktree to the primary checkout', () => {
    const dir = mkRepo('f');
    git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x');
    fs.mkdirSync(path.join(dir, 'sub'));
    expect(gitRepoRoot(path.join(dir, 'sub'))).toBe(dir);
    const wt = path.join(tmp, 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'w', wt);
    expect(gitRepoRoot(wt)).toBe(dir);
    expect(gitRepoRoot(tmp)).toBe('');
  });
});

describe('ship command', () => {
  it('defaults to /loom:ship and accepts a slash command with arguments', () => {
    expect(checkShipCommand('')).toEqual({ ok: true, command: '/loom:ship' });
    expect(checkShipCommand('  /ship ')).toEqual({ ok: true, command: '/ship' });
    expect(checkShipCommand('/team:release main')).toEqual({ ok: true, command: '/team:release main' });
  });
  it('refuses a non-slash command, a multi-line one, an over-long one and a forced landing', () => {
    expect(checkShipCommand('ship it').ok).toBe(false);
    expect(checkShipCommand('/ship\nrm -rf /').ok).toBe(false);
    expect(checkShipCommand('/' + 'x'.repeat(250)).ok).toBe(false);
    expect(checkShipCommand('/ship ' + '--' + 'force').ok).toBe(false);
    expect(checkShipCommand('/ship -' + 'force').ok).toBe(false);
  });
});

describe('Add repo to Ship', () => {
  it('adds a git project by any folder inside it, detecting slug and base branch', () => {
    const dir = mkRepo('g', { remote: 'https://github.com/o/g.git', base: 'develop' });
    fs.mkdirSync(path.join(dir, 'pkg'));
    const r = addShipProject(db, path.join(dir, 'pkg'), {}, undefined, 5);
    expect(r).toMatchObject({ ok: true, project: { project_dir: dir, repo_slug: 'o/g', base_branch: 'develop', ship_command: '/loom:ship', label_required: false, enabled: true, added_at: 5 } });
    expect(shipRepos(db)).toEqual([dir]);
    expect(shipConfigFor(dir, db)).toMatchObject({ base: 'develop', command: '/loom:ship' });
  });
  it('refuses a folder that is not a git repo, a missing one, and a bad command', () => {
    expect(addShipProject(db, tmp)).toMatchObject({ ok: false, detail: 'That folder is not a git repository.' });
    expect(addShipProject(db, path.join(tmp, 'nope')).ok).toBe(false);
    expect(addShipProject(db, mkRepo('h'), { command: 'rm' }).ok).toBe(false);
    expect(listShipProjects(db, { includeDisabled: true })).toEqual([]);
  });
  it('re-adding re-enables the row and keeps its settings', () => {
    const dir = mkRepo('i');
    addShipProject(db, dir, { command: '/ship', labelRequired: true });
    updateShipProject(db, dir, { enabled: false });
    expect(shipRepos(db)).toEqual([]);
    const r = addShipProject(db, dir);
    expect(r).toMatchObject({ ok: true, project: { enabled: true, ship_command: '/ship', label_required: true } });
  });
  it('updates and removes a row; disabled rows leave the list but stay in Settings', () => {
    const dir = mkRepo('j');
    addShipProject(db, dir);
    expect(updateShipProject(db, dir, { ship_command: '/ship', base_branch: 'trunk', label_required: true })).toMatchObject({ ok: true, project: { ship_command: '/ship', base_branch: 'trunk', label_required: true } });
    expect(updateShipProject(db, dir, { ship_command: 'nope' }).ok).toBe(false);
    expect(updateShipProject(db, '/nowhere', { enabled: true })).toEqual({ ok: false, detail: 'unknown repo' });
    expect(shipPluginState(db)).toEqual({ repos: [dir], label_required: [dir] });
    updateShipProject(db, dir, { enabled: false });
    expect(listShipProjects(db)).toEqual([]);
    expect(listShipProjects(db, { includeDisabled: true })).toHaveLength(1);
    expect(removeShipProject(db, dir)).toBe(true);
    expect(removeShipProject(db, dir)).toBe(false);
  });
  it('$LOOM_SHIP_REPOS overrides the list; a listed row keeps its own settings', () => {
    const a = mkRepo('k');
    const b = mkRepo('l');
    addShipProject(db, a, { command: '/ship' });
    process.env.LOOM_SHIP_REPOS = `${a}:${b}:${path.join(tmp, 'gone')}`;
    expect(shipConfigs(db).map((c) => [c.repo, c.command])).toEqual([[a, '/ship'], [b, '/loom:ship']]);
  });
  it('offers a repo with staged files, a GitHub remote and no row; not one already on Ship', async () => {
    const dir = mkRepo('m', { remote: 'https://github.com/o/m.git' });
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
    git(dir, 'add', 'a.txt');
    const views = [{ agent: 'claude', session_id: 'S1', project_dir: dir }] as any;
    const live = { 'claude:S1': {} } as any;
    const asyncGit = async (args: string[], cwd: string) => git(cwd, ...args);
    expect(await findShipCandidates(views, live, [], asyncGit)).toMatchObject([{ repo: dir, slug: 'o/m', staged: 1, chats: ['claude:S1'] }]);
    expect(await findShipCandidates(views, live, [dir], asyncGit)).toEqual([]);
    expect(await findShipCandidates(views, {}, [], asyncGit)).toEqual([]);
  });
});

describe('the board and the Ship button follow the row', () => {
  const fakeGit = (branch: string) => async (args: string[]) => (args[0] === 'rev-parse' && args.includes('--abbrev-ref') ? branch + '\n' : '');
  const gh = async () => '[]';
  it('onMain means on the row base branch, and the board carries the command', async () => {
    const cfg = { base: 'trunk', command: '/team:ship' };
    const on = await buildShipBoard('/r', [], {}, fakeGit('trunk'), gh, 1, [], cfg);
    expect(on).toMatchObject({ onMain: true, base: 'trunk', command: '/team:ship' });
    expect((await buildShipBoard('/r', [], {}, fakeGit('main'), gh, 1, [], cfg)).onMain).toBe(false);
    expect((await buildShipBoard('/r', [], {}, fakeGit('master'), gh, 1)).onMain).toBe(true); // no row: main or master
  });
  it('the gate names the base branch', () => {
    expect(shipDisabledReason({ onMain: false, staged: 2, lock: null, base: 'trunk' }).reason).toBe('The checkout is not on trunk.');
  });
  it('the launch sends the row command as the prompt', async () => {
    const board = await buildShipBoard('/r', [], {}, fakeGit('main'), gh, 1, [], { base: 'main', command: '/team:ship' });
    const detail = buildShipDetail({ board, staged: [], unstaged: [], titles: {}, labels: {}, guesses: {} });
    expect(detail.command).toBe('/team:ship');
    expect(detail.confirm).toContain('running /team:ship.');
    const calls: any[] = [];
    const start = ((i: any) => (calls.push(i), { ok: true, detail: '', pane_id: '%1', where: 'x' })) as any;
    const r = startShipSession({ ...detail, onMain: true, totals: { ...detail.totals, staged: 1 } }, { start });
    expect(r).toMatchObject({ ok: true, prompt: '/team:ship' });
    expect(calls[0]).toMatchObject({ prompt: '/team:ship', projectDir: '/r' });
  });
});

describe('labels', () => {
  it('come from the table; the legacy file only fills in; a title is the last resort', () => {
    db.prepare(`INSERT INTO ship_labels (session_id, repo, label, updated_at) VALUES ('S', '/r', 'from db', 1)`).run();
    const file = { S: { label: 'from file', repo: '/r', at: 1 }, T: { label: 'file only', repo: '', at: 1 } };
    expect(mergeLabel(db, file, 'S', '/r', 'title')).toEqual({ label: 'from db', source: 'db' });
    expect(mergeLabel(db, file, 'T', '/r', 'title')).toEqual({ label: 'file only', source: 'file' });
    expect(mergeLabel(db, file, 'U', '/r', 'title')).toEqual({ label: 'title', source: 'title' });
  });
});

describe('migration (legacy install)', () => {
  it('ships the legacy repo with /ship and labels required; Loom is added disabled', () => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    const legacy = path.join(home, 'dev', 'tax-pilot-app');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    fs.mkdirSync(legacy);
    git(legacy, 'init', '-q', '-b', 'main');
    git(legacy, 'remote', 'add', 'origin', 'https://github.com/o/tp.git');
    const loom = mkRepo('loomrepo');
    const labelsFile = path.join(tmp, 'ship-labels.json');
    fs.writeFileSync(labelsFile, JSON.stringify({ A: { label: 'one', repo: legacy + '/', at: 7 }, B: { label: 'two', repo: '', at: 8 }, C: { label: '  ', repo: '', at: 9 } }));
    const r = migrateShip(db, { home, envRepos: '', loomRepoDir: loom, labelsFile, now: 100 });
    expect(r).toEqual({ repos: [legacy], loomAdded: true, labels: 2 });
    const rows = listShipProjects(db, { includeDisabled: true });
    expect(rows.find((x) => x.project_dir === legacy)).toMatchObject({ ship_command: '/ship', label_required: true, enabled: true, repo_slug: 'o/tp', base_branch: 'main' });
    expect(rows.find((x) => x.project_dir === loom)).toMatchObject({ ship_command: '/loom:ship', enabled: false });
    expect(shipRepos(db)).toEqual([legacy]);
    expect(shipPluginState(db)).toEqual({ repos: [legacy], label_required: [legacy] });
    expect(mergeLabel(db, {}, 'A', legacy, '')).toEqual({ label: 'one', source: 'db' });
    expect(mergeLabel(db, {}, 'B', legacy, '')).toEqual({ label: 'two', source: 'db' });
    // idempotent, and never overwrites an edited row
    updateShipProject(db, legacy, { ship_command: '/mine' });
    expect(migrateShip(db, { home, envRepos: '', loomRepoDir: loom, labelsFile, now: 200 })).toEqual({ repos: [legacy], loomAdded: false, labels: 0 });
    expect(listShipProjects(db).find((x) => x.project_dir === legacy)?.ship_command).toBe('/mine');
  });
  it('honours $LOOM_SHIP_REPOS and skips paths that are not git repos', () => {
    const a = mkRepo('envA');
    const r = migrateShip(db, { envRepos: `${a}:${path.join(tmp, 'gone')}`, loomRepoDir: '', labelsFile: path.join(tmp, 'none.json') });
    expect(r.repos).toEqual([a]);
  });
});

describe('routes', () => {
  it('every write is a browser-guarded POST; the two GETs are plain reads', () => {
    expect(routes.map((r) => `${r.method} ${r.path} ${r.kind}`)).toEqual([
      'GET /api/ship/projects read',
      'GET /api/ship/candidates read',
      'POST /api/ship/projects browser',
      'POST /api/ship/projects/update browser',
      'POST /api/ship/projects/remove browser',
    ]);
  });
});

describe('plugin-state.json follows ship_projects', () => {
  const call = async (h: (c: any) => Promise<void>, body: unknown) => {
    let out: any;
    await h({ json: (code: number, b: unknown) => (out = { code, b }), body: async () => body });
    return out;
  };
  const state = () => JSON.parse(fs.readFileSync(pluginStatePath(), 'utf-8')).ship;
  it('is rewritten on add, update and remove', async () => {
    const dir = mkRepo('ps');
    const add = await call(addHandler, { path: dir, ship_command: '/ship', label_required: true });
    expect(add.code).toBe(200);
    expect(state()).toEqual({ repos: [dir], label_required: [dir] });
    await call(updateHandler, { project_dir: dir, label_required: false });
    expect(state().label_required ?? []).toEqual([]);
    await call(updateHandler, { project_dir: dir, enabled: false });
    expect(state().repos).toEqual([]);
    await call(updateHandler, { project_dir: dir, enabled: true });
    expect(state().repos).toEqual([dir]);
    expect((await call(removeHandler, { project_dir: dir })).code).toBe(200);
    expect(state().repos).toEqual([]);
  });
});
