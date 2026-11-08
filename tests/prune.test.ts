import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { setSetting } from '../src/settingsSchema.ts';
import {
  listRuns,
  parseLsofCwds,
  parsePorcelainTrees,
  processCwds,
  pruneAfterShips,
  pruneMergedWorktrees,
  supersetWorkspaces,
  tmuxPaneDirs,
  type LiveDir,
} from '../src/prune.ts';
import { pruneCliHandler, setPruneRouteDeps } from '../src/routes/trees.ts';
import { PRUNE_VIEW_JS } from '../src/pruneview.ts';
import { renderDashboard } from '../src/dashboard.ts';
import { defaultGitAsync } from '../src/git.ts';

// Every repo here is a throwaway under the OS temp dir, with a bare "origin" so
// the base resolves the way it does on a real clone (origin/HEAD -> origin/main).

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};
const saved: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const [k, v] of Object.entries(GIT_ENV)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
});
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const tmps: string[] = [];
afterAll(() => {
  for (const t of tmps) fs.rmSync(t, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (p: string, s: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, s);
};

interface Fixture {
  dir: string;
  repo: string;
  origin: string;
  wt(name: string): string;
  /** A worktree on its own branch with one commit of its own. */
  add(name: string, file?: string): string;
  mergeNoFf(name: string): void;
  squash(name: string): void;
}

function fixture(): Fixture {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prune-')));
  tmps.push(dir);
  const repo = path.join(dir, 'repo');
  const origin = path.join(dir, 'origin.git');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(path.join(repo, '.gitignore'), 'node_modules/\n');
  write(path.join(repo, 'README'), 'hi\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'init');
  git(dir, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const wt = (name: string) => path.join(repo, '.worktrees', name);
  return {
    dir,
    repo,
    origin,
    wt,
    add(name, file = `${name}.txt`) {
      git(repo, 'worktree', 'add', '-q', wt(name), '-b', name);
      write(path.join(wt(name), file), `${name}\n`);
      git(wt(name), 'add', '.');
      git(wt(name), 'commit', '-q', '-m', `work on ${name}`);
      return wt(name);
    },
    mergeNoFf(name) {
      git(repo, 'merge', '-q', '--no-ff', '-m', `merge ${name}`, name);
      git(repo, 'push', '-q', 'origin', 'main');
    },
    squash(name) {
      git(repo, 'merge', '-q', '--squash', name);
      git(repo, 'commit', '-q', '-m', `squash ${name}`);
      git(repo, 'push', '-q', 'origin', 'main');
      // The local main now has the squash, so `branch -d` compares against something real.
    },
  };
}

const none = async () => new Map<string, string>();
const noLive = { liveDirs: async (): Promise<LiveDir[]> => [], managedElsewhere: none };
const branches = (repo: string) => git(repo, 'branch', '--format=%(refname:short)').split('\n').filter(Boolean).sort();
const reasonFor = (r: { skipped: { path: string; reason: string }[] }, p: string) => r.skipped.find((s) => s.path === p)?.reason ?? '';

describe('prune: what goes and what stays', () => {
  it('removes a merged, clean worktree and deletes its branch with -d', async () => {
    const f = fixture();
    const p = f.add('done');
    f.mergeNoFf('done');
    const r = await pruneMergedWorktrees(f.repo, { deps: noLive });
    expect(r.error).toBeUndefined();
    expect(r.base).toBe('origin/main');
    expect(r.removed.map((w) => [w.path, w.branchDeleted])).toEqual([[p, true]]);
    expect(fs.existsSync(p)).toBe(false);
    expect(branches(f.repo)).toEqual(['main']);
    expect(reasonFor(r, f.repo)).toBe('the primary checkout');
  });

  it('allows ignored files, refuses tracked edits and untracked files', async () => {
    const f = fixture();
    const ign = f.add('ignored');
    const mod = f.add('modified');
    const unt = f.add('untracked');
    for (const n of ['ignored', 'modified', 'untracked']) f.mergeNoFf(n);
    write(path.join(ign, 'node_modules', 'x', 'index.js'), 'x');
    write(path.join(mod, 'modified.txt'), 'changed\n');
    write(path.join(unt, 'new-file.txt'), 'new\n');
    const r = await pruneMergedWorktrees(f.repo, { deps: noLive });
    expect(r.removed.map((w) => w.path)).toEqual([ign]);
    expect(reasonFor(r, mod)).toMatch(/^not clean: 1 changed or untracked path$/);
    expect(reasonFor(r, unt)).toMatch(/^not clean/);
    expect(fs.existsSync(mod) && fs.existsSync(unt)).toBe(true);
  });

  it('skips unmerged work, stashes on the branch, and branches with no commits', async () => {
    const f = fixture();
    const open = f.add('open');
    const stashed = f.add('stashed');
    f.mergeNoFf('stashed');
    write(path.join(stashed, 'stashed.txt'), 'wip\n');
    git(stashed, 'stash', '-q');
    git(f.repo, 'worktree', 'add', '-q', f.wt('fresh'), '-b', 'fresh');
    const r = await pruneMergedWorktrees(f.repo, { deps: noLive });
    expect(r.removed).toEqual([]);
    expect(reasonFor(r, open)).toBe('not merged into origin/main');
    expect(reasonFor(r, stashed)).toBe('1 stash entry on stashed');
    expect(reasonFor(r, f.wt('fresh'))).toBe('no commits of its own (never worked in)');
  });

  it('skips locked, detached and missing worktrees', async () => {
    const f = fixture();
    const locked = f.add('locked');
    f.mergeNoFf('locked');
    git(f.repo, 'worktree', 'lock', locked);
    git(f.repo, 'worktree', 'add', '-q', '--detach', f.wt('detached'), 'main');
    const gone = f.add('gone');
    f.mergeNoFf('gone');
    fs.rmSync(gone, { recursive: true, force: true });
    const r = await pruneMergedWorktrees(f.repo, { deps: noLive });
    expect(r.removed).toEqual([]);
    expect(reasonFor(r, locked)).toBe('locked (git worktree lock)');
    expect(reasonFor(r, f.wt('detached'))).toBe('detached HEAD: no branch to test');
    expect(reasonFor(r, gone)).toMatch(/^directory is missing/);
  });

  it('a squash-merged branch: the worktree goes, git branch -d refuses and the branch is kept', async () => {
    const f = fixture();
    const p = f.add('sq');
    // A second commit, so `git cherry` alone cannot match it.
    write(path.join(p, 'more.txt'), 'more\n');
    git(p, 'add', '.');
    git(p, 'commit', '-q', '-m', 'more');
    f.squash('sq');
    const dry = await pruneMergedWorktrees(f.repo, { dryRun: true, deps: noLive });
    expect(dry.removed).toHaveLength(1);
    expect(dry.removed[0]).toMatchObject({ path: p, merge: 'squash-merged', branchDeleted: false });
    expect(dry.removed[0].branchNote).toMatch(/^branch kept: git branch -d refuses/);
    const r = await pruneMergedWorktrees(f.repo, { deps: noLive });
    expect(r.removed[0]).toMatchObject({ path: p, merge: 'squash-merged', branchDeleted: false });
    expect(r.removed[0].branchNote).toMatch(/^branch kept: git branch -d refused/);
    expect(fs.existsSync(p)).toBe(false);
    expect(branches(f.repo)).toEqual(['main', 'sq']);
  });

  it('a dry run reports exactly what the real run then does, and changes nothing', async () => {
    const f = fixture();
    const a = f.add('a');
    const b = f.add('b');
    f.add('c');
    f.mergeNoFf('a');
    f.mergeNoFf('b');
    const before = git(f.repo, 'worktree', 'list', '--porcelain');
    const dry = await pruneMergedWorktrees(f.repo, { dryRun: true, deps: noLive });
    expect(git(f.repo, 'worktree', 'list', '--porcelain')).toBe(before);
    const real = await pruneMergedWorktrees(f.repo, { deps: noLive });
    const shape = (r: typeof dry) => ({ removed: r.removed.map((w) => [w.path, w.branchDeleted]), skipped: r.skipped.map((s) => [s.path, s.reason]) });
    expect(shape(dry)).toEqual(shape(real));
    expect(real.removed.map((w) => w.path).sort()).toEqual([a, b].sort());
  });

  it('re-checks each tree at removal time, not from the first pass', async () => {
    const f = fixture();
    const a = f.add('a');
    const b = f.add('b');
    f.mergeNoFf('a');
    f.mergeNoFf('b');
    let statusOfB = 0;
    // Someone starts editing b after the first pass cleared it.
    const git2 = async (args: string[], cwd: string) => {
      if (args[0] === 'status' && cwd === b && ++statusOfB === 2) write(path.join(b, 'late.txt'), 'late\n');
      return defaultGitAsync(args, cwd);
    };
    const r = await pruneMergedWorktrees(f.repo, { deps: { ...noLive, git: git2 } });
    expect(statusOfB).toBe(2);
    expect(r.removed.map((w) => w.path)).toEqual([a]);
    expect(reasonFor(r, b)).toMatch(/^not clean/);
    expect(fs.existsSync(path.join(b, 'late.txt'))).toBe(true);
  });

  it('`only` limits a real run to the confirmed list', async () => {
    const f = fixture();
    const a = f.add('a');
    const b = f.add('b');
    f.mergeNoFf('a');
    f.mergeNoFf('b');
    const r = await pruneMergedWorktrees(f.repo, { only: [a], deps: noLive });
    expect(r.removed.map((w) => w.path)).toEqual([a]);
    expect(reasonFor(r, b)).toBe('not in the confirmed list');
    expect(fs.existsSync(b)).toBe(true);
  });

  it('is idempotent, and two runs at once are serialised', async () => {
    const f = fixture();
    const a = f.add('a');
    const b = f.add('b');
    f.mergeNoFf('a');
    f.mergeNoFf('b');
    const [one, two] = await Promise.all([pruneMergedWorktrees(f.repo, { deps: noLive }), pruneMergedWorktrees(path.join(f.repo, '.worktrees'), { deps: noLive })]);
    expect(one.removed.map((w) => w.path).sort()).toEqual([a, b].sort());
    expect(two.removed).toEqual([]);
    expect(two.skipped.filter((s) => s.reason.includes('refused'))).toEqual([]);
    const three = await pruneMergedWorktrees(f.repo, { deps: noLive });
    expect(three.removed).toEqual([]);
    expect(three.skipped.map((s) => s.reason)).toEqual(['the primary checkout']);
  });

  it('never touches anything outside `git worktree list`', async () => {
    const f = fixture();
    f.add('real');
    f.mergeNoFf('real');
    const imposter = f.wt('imposter');
    write(path.join(imposter, 'keep.txt'), 'not a worktree\n');
    const sibling = path.join(f.dir, 'sibling');
    write(path.join(sibling, 'keep.txt'), 'x\n');
    const r = await pruneMergedWorktrees(f.repo, { deps: noLive });
    expect(r.removed.map((w) => w.name)).toEqual(['real']);
    expect(fs.readFileSync(path.join(imposter, 'keep.txt'), 'utf-8')).toBe('not a worktree\n');
    expect(fs.existsSync(path.join(sibling, 'keep.txt'))).toBe(true);
    expect([...r.removed, ...r.skipped].some((x) => x.path === imposter || x.path === sibling)).toBe(false);
  });

  it('refuses without a base branch rather than comparing against HEAD', async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prune-')));
    tmps.push(dir);
    git(dir, 'init', '-q', '-b', 'trunk');
    write(path.join(dir, 'a'), 'a');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'a');
    const r = await pruneMergedWorktrees(dir, { deps: noLive });
    expect(r.error).toMatch(/^no base branch/);
    expect(r.removed).toEqual([]);
  });

  it('uses the Ship base branch when the repo has one', async () => {
    const f = fixture();
    git(f.repo, 'checkout', '-q', '-b', 'develop');
    git(f.repo, 'push', '-q', 'origin', 'develop');
    const p = f.add('feat');
    git(f.repo, 'merge', '-q', '--no-ff', '-m', 'm', 'feat');
    git(f.repo, 'push', '-q', 'origin', 'develop');
    const db = new Database(':memory:');
    applySchema(db);
    db.prepare(`INSERT INTO ship_projects (project_dir, repo_slug, base_branch, ship_command, label_required, enabled, added_at) VALUES (?, '', 'develop', '/ship', 0, 1, 0)`).run(f.repo);
    const r = await pruneMergedWorktrees(f.repo, { deps: noLive, db });
    expect(r.base).toBe('origin/develop');
    expect(r.removed.map((w) => w.path)).toEqual([p]);
    expect(listRuns(db)).toHaveLength(1);
  });
});

describe('prune: things running inside a worktree', () => {
  let child: ChildProcess | null = null;
  const SOCK = `loomtest-prune-${process.pid}`;
  const tmuxRun = (args: string[]) => execFileSync('tmux', ['-L', SOCK, '-f', path.join(__dirname, 'fixtures', 'tmux-test.conf'), ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  afterAll(() => {
    child?.kill('SIGKILL');
    try {
      tmuxRun(['kill-server']);
    } catch {
      /* not started */
    }
  });

  it('a running process with its cwd inside is skipped (real lsof)', async () => {
    const f = fixture();
    const p = f.add('busy');
    f.mergeNoFf('busy');
    fs.mkdirSync(path.join(p, 'sub'));
    child = spawn('sleep', ['60'], { cwd: path.join(p, 'sub'), stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 200));
    const cwds = await processCwds();
    expect(cwds.some((d) => d.what.startsWith(`process ${child!.pid}`))).toBe(true);
    const r = await pruneMergedWorktrees(f.repo, { deps: { liveDirs: processCwds, managedElsewhere: none } });
    expect(r.removed).toEqual([]);
    expect(reasonFor(r, p)).toMatch(new RegExp(`^in use: process ${child.pid} \\(sleep\\)`));
    child.kill('SIGKILL');
    await new Promise((res) => child!.once('exit', res));
    child = null;
    const again = await pruneMergedWorktrees(f.repo, { deps: { liveDirs: processCwds, managedElsewhere: none } });
    expect(again.removed.map((w) => w.path)).toEqual([p]);
  });

  it('a tmux pane sitting in it is skipped (throwaway tmux server)', async () => {
    const f = fixture();
    const p = f.add('pane');
    f.mergeNoFf('pane');
    tmuxRun(['new-session', '-d', '-s', 'prune-test', '-c', p, '-x', '80', '-y', '24']);
    const dirs = tmuxPaneDirs(tmuxRun);
    expect(dirs.some((d) => d.dir === p)).toBe(true);
    const r = await pruneMergedWorktrees(f.repo, { deps: { liveDirs: async () => tmuxPaneDirs(tmuxRun), managedElsewhere: none } });
    expect(r.removed).toEqual([]);
    expect(reasonFor(r, p)).toMatch(/^in use: tmux pane %\d+ \(prune-test\)/);
  });

  it('a live check that fails skips the tree instead of assuming it is free', async () => {
    const f = fixture();
    const p = f.add('x');
    f.mergeNoFf('x');
    const r = await pruneMergedWorktrees(f.repo, { deps: { liveDirs: async () => { throw new Error('lsof missing'); }, managedElsewhere: none } });
    expect(r.removed).toEqual([]);
    expect(reasonFor(r, p)).toMatch(/^could not check for running processes/);
  });
});

describe('prune: worktrees another tool still manages', () => {
  function fakeHome(rows: [string, number | null][], schema = true): string {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prune-home-')));
    tmps.push(home);
    const dir = path.join(home, '.superset', 'host', 'abc-123');
    fs.mkdirSync(dir, { recursive: true });
    const db = new Database(path.join(dir, 'host.db'));
    if (schema) {
      db.exec(`CREATE TABLE workspaces (id TEXT PRIMARY KEY, worktree_path TEXT NOT NULL, branch TEXT NOT NULL, archived_at INTEGER)`);
      rows.forEach(([p, a], i) => db.prepare(`INSERT INTO workspaces VALUES (?, ?, 'b', ?)`).run(String(i), p, a));
    } else db.exec(`CREATE TABLE other (x)`);
    db.close();
    return home;
  }

  it('reads active workspaces only, and is a no-op without Superset or with an unreadable db', () => {
    const home = fakeHome([['/w/active', null], ['/w/archived', 123]]);
    expect([...supersetWorkspaces(home).entries()]).toEqual([['/w/active', 'Superset workspace']]);
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prune-home-')));
    tmps.push(empty);
    expect(supersetWorkspaces(empty).size).toBe(0);
    expect(supersetWorkspaces(fakeHome([], false)).size).toBe(0);
    const garbage = fakeHome([]);
    fs.writeFileSync(path.join(garbage, '.superset', 'host', 'abc-123', 'host.db'), 'not a database');
    expect(supersetWorkspaces(garbage).size).toBe(0);
  });

  it('skips a merged, clean worktree Superset still tracks; an archived one is pruned', async () => {
    const f = fixture();
    const tracked = f.add('tracked');
    const archived = f.add('archived');
    f.mergeNoFf('tracked');
    f.mergeNoFf('archived');
    const home = fakeHome([[tracked, null], [archived, 99]]);
    const r = await pruneMergedWorktrees(f.repo, { deps: { liveDirs: async () => [], managedElsewhere: async () => supersetWorkspaces(home) } });
    expect(r.removed.map((w) => w.path)).toEqual([archived]);
    expect(reasonFor(r, tracked)).toBe('Superset workspace');
    expect(fs.existsSync(tracked)).toBe(true);
  });
});

describe('prune: parsers', () => {
  it('reads lsof cwd records', () => {
    expect(parseLsofCwds('p12\ncnode\nfcwd\nn/a/b\np13\ncsh\nfcwd\nn/c\n')).toEqual([
      { dir: '/a/b', what: 'process 12 (node)' },
      { dir: '/c', what: 'process 13 (sh)' },
    ]);
  });
  it('keeps locked and prunable flags and skips a bare entry', () => {
    const out = 'worktree /r\nbare\n\nworktree /r/a\nHEAD 1\nbranch refs/heads/a\nlocked\n\nworktree /r/b\nHEAD 2\ndetached\nprunable gitdir file points to non-existent location\n\n';
    expect(parsePorcelainTrees(out)).toEqual([
      { path: '/r/a', name: 'a', branch: 'a', primary: false, locked: true, prunable: false },
      { path: '/r/b', name: 'b', branch: null, primary: false, locked: false, prunable: true },
    ]);
  });
});

describe('prune after ship', () => {
  let db: Database.Database;
  let calls: [string, string][];
  const prune = async (repo: string, trigger: string) => { calls.push([repo, trigger]); };
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
    calls = [];
  });
  const board = (...ships: [number, number][]) => [{ repo: '/r', shipped: ships.map(([number, mergedAt]) => ({ number, mergedAt })) }];
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('the first sighting seeds history and does not fire', async () => {
    expect(pruneAfterShips(db, board([10, 500], [11, 0]), { now: 1000, prune })).toEqual([]);
    await flush();
    expect(calls).toEqual([]);
  });

  it('fires once per ship merged after the seed, never for an unmerged one', async () => {
    pruneAfterShips(db, board([10, 500]), { now: 1000, prune });
    expect(pruneAfterShips(db, board([10, 500], [12, 0]), { now: 2000, prune })).toEqual([]);
    expect(pruneAfterShips(db, board([10, 500], [12, 1500]), { now: 3000, prune })).toEqual([{ repo: '/r', ships: [12] }]);
    expect(pruneAfterShips(db, board([10, 500], [12, 1500]), { now: 4000, prune })).toEqual([]);
    await flush();
    expect(calls).toEqual([['/r', 'ship #12']]);
  });

  it('several new ships in one pass make one run', async () => {
    pruneAfterShips(db, board(), { now: 1000, prune });
    pruneAfterShips(db, board([20, 2000], [21, 2100]), { now: 3000, prune });
    await flush();
    expect(calls).toEqual([['/r', 'ship #20 #21']]);
  });

  it('respects the setting, and a ship seen while it was off never fires later', async () => {
    pruneAfterShips(db, board(), { now: 1000, prune });
    setSetting(db, 'trees_prune_after_ship', false);
    expect(pruneAfterShips(db, board([30, 2000]), { now: 3000, prune })).toEqual([]);
    setSetting(db, 'trees_prune_after_ship', true);
    expect(pruneAfterShips(db, board([30, 2000]), { now: 4000, prune })).toEqual([]);
    expect(pruneAfterShips(db, board([30, 2000], [31, 3500]), { now: 5000, prune })).toEqual([{ repo: '/r', ships: [31] }]);
    await flush();
    expect(calls).toEqual([['/r', 'ship #31']]);
  });

  it('defaults on for a new install and for a migrated one', () => {
    for (const schema of ['2', '1']) {
      const d = new Database(':memory:');
      applySchema(d);
      d.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('settings_schema', ?)`).run(schema);
      pruneAfterShips(d, board(), { now: 1, prune });
      expect(pruneAfterShips(d, board([1, 5]), { now: 10, prune })).toEqual([{ repo: '/r', ships: [1] }]);
    }
  });

  it('a real after-ship run prunes the repo and lands in history', async () => {
    const f = fixture();
    const p = f.add('shipped');
    f.mergeNoFf('shipped');
    pruneAfterShips(db, [{ repo: f.repo, shipped: [] }], { now: 1 });
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    pruneAfterShips(db, [{ repo: f.repo, shipped: [{ number: 7, mergedAt: 5 }] }], {
      now: 10,
      prune: (repo, trigger) => pruneMergedWorktrees(repo, { trigger, db, deps: noLive }).finally(done),
    });
    await finished;
    const [run] = listRuns(db);
    expect(run.trigger).toBe('ship #7');
    expect(run.removed.map((w) => w.path)).toEqual([p]);
  });
});

describe('prune routes and page', () => {
  it('the CLI route dry-runs any repo and refuses a relative or non-repo path', async () => {
    const f = fixture();
    const p = f.add('x');
    f.mergeNoFf('x');
    setPruneRouteDeps({ openDb: () => { const d = new Database(':memory:'); applySchema(d); return d; }, prune: noLive });
    const call = async (b: unknown) => {
      let got: { code: number; body: any } = { code: 0, body: null };
      await pruneCliHandler({ body: async () => b as any, json: (code: number, body: unknown) => { got = { code, body }; } } as any);
      return got;
    };
    expect((await call({ repo: 'rel/path' })).code).toBe(400);
    expect((await call({ repo: f.dir })).code).toBe(404);
    const r = await call({ repo: p, dry_run: true });
    expect(r.code).toBe(200);
    expect(r.body.results[0].removed.map((w: any) => w.path)).toEqual([p]);
    expect(r.body.results[0].summary).toBe('repo: would remove 1 worktree, kept 0');
    expect(fs.existsSync(p)).toBe(true);
  });

  it('the page script compiles and the dashboard carries the prune controls', () => {
    expect(() => new vm.Script(PRUNE_VIEW_JS)).not.toThrow();
    const html = String(renderDashboard([], Date.now(), {}, 'claude'));
    expect(html).toContain('id="tree-prune"');
    expect(html).toContain('id="tree-prune-hist"');
    expect(html).toContain("sxKey('trees_prune_after_ship'");
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1])).not.toThrow();
  });
});
