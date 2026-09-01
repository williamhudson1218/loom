import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectWorktrees, removalPlan, removeWorktree, resolveBaseRef } from '../src/git.ts';

/**
 * Exercises the destructive path against a throwaway repository.
 *
 * The parser tests cover the rules; this covers the thing those rules protect —
 * that a squash-merged worktree really is removed, and that one holding
 * uncommitted work really is not, with git itself in the loop rather than a stub.
 */

let tmp: string;
let repo: string;

const git = (args: string[], cwd: string) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8' });

const wtPath = (name: string) => path.join(repo, '.worktrees', name);

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-git-removal-'));
  repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);

  git(['init', '-b', 'main'], repo);
  git(['config', 'user.email', 'test@example.com'], repo);
  git(['config', 'user.name', 'Test'], repo);
  git(['config', 'commit.gpgsign', 'false'], repo);
  fs.writeFileSync(path.join(repo, 'README.md'), 'base\n');
  git(['add', '.'], repo);
  git(['commit', '-m', 'base'], repo);

  // 1. A branch whose work is squash-merged into main — the case an "ahead > 0"
  //    rule gets wrong, since the branch keeps its own commit forever.
  git(['worktree', 'add', wtPath('merged'), '-b', 'feature-merged'], repo);
  fs.writeFileSync(path.join(wtPath('merged'), 'feature.txt'), 'done\n');
  git(['add', '.'], wtPath('merged'));
  git(['commit', '-m', 'feature work'], wtPath('merged'));
  git(['merge', '--squash', 'feature-merged'], repo);
  git(['commit', '-m', 'squash: feature work (#1)'], repo);

  // 2. A branch with genuinely unmerged work.
  git(['worktree', 'add', wtPath('active'), '-b', 'feature-active'], repo);
  fs.writeFileSync(path.join(wtPath('active'), 'wip.txt'), 'wip\n');
  git(['add', '.'], wtPath('active'));
  git(['commit', '-m', 'wip'], wtPath('active'));

  // 3. The dangerous one: nothing committed, but real edits on disk.
  git(['worktree', 'add', wtPath('dirty'), '-b', 'feature-dirty'], repo);
  fs.writeFileSync(path.join(wtPath('dirty'), 'README.md'), 'edited but never committed\n');

  // 4. Merged and clean apart from an untracked scratch file.
  git(['worktree', 'add', wtPath('scratch'), '-b', 'feature-scratch'], repo);
  fs.writeFileSync(path.join(wtPath('scratch'), 'NOTES.md'), 'scratch\n');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const states = () => inspectWorktrees(repo, { base: resolveBaseRef(repo) });
const named = (name: string) => states().find((s) => s.name === name)!;

describe('inspectWorktrees against a real repository', () => {
  it('resolves a base ref with no remote configured', () => {
    expect(resolveBaseRef(repo)).toBe('main');
  });

  it('finds every worktree including the primary', () => {
    expect(states().map((s) => s.name).sort()).toEqual(['active', 'dirty', 'merged', 'repo', 'scratch']);
  });

  it('calls a squash-merged worktree safe even though it is a commit ahead', () => {
    const w = named('merged');
    expect(w.ahead).toBe(1);
    expect(w.unmergedPatches).toBe(0);
    expect(w.verdict).toBe('safe');
    expect(w.removable).toBe(true);
  });

  it('calls a worktree with unmerged patches active', () => {
    const w = named('active');
    expect(w.unmergedPatches).toBe(1);
    expect(w.verdict).toBe('active');
    expect(w.removable).toBe(false);
  });

  it('protects a worktree whose only work is uncommitted', () => {
    const w = named('dirty');
    expect(w.trackedModified).toBe(1);
    expect(w.verdict).toBe('uncommitted');
    expect(w.removable).toBe(false);
  });

  it('flags a merged worktree holding an untracked file', () => {
    const w = named('scratch');
    expect(w.untracked).toBe(1);
    expect(w.verdict).toBe('untracked-only');
    expect(w.removable).toBe(false);
  });
});

describe('removeWorktree', () => {
  it('refuses everything the classifier did not clear', () => {
    const all = states();
    const plan = removalPlan(all, all.map((s) => s.path));
    expect(plan.approved.map((w) => w.name)).toEqual(['merged']);
    expect(plan.refused.map((r) => r.name).sort()).toEqual(['active', 'dirty', 'repo', 'scratch']);
  });

  it('removes the directory and deletes the local branch', () => {
    const target = named('merged');
    expect(fs.existsSync(target.path)).toBe(true);

    const result = removeWorktree(repo, target, git);
    expect(result.ok).toBe(true);
    expect(result.branchDeleted).toBe(true);

    expect(fs.existsSync(target.path)).toBe(false);
    expect(git(['branch', '--list', 'feature-merged'], repo).trim()).toBe('');
    expect(states().map((s) => s.name)).not.toContain('merged');
  });

  it('leaves every protected worktree untouched afterwards', () => {
    for (const name of ['active', 'dirty', 'scratch']) {
      expect(fs.existsSync(named(name).path)).toBe(true);
    }
    // The uncommitted edit is still on disk, unread by anything that ran above.
    expect(fs.readFileSync(path.join(wtPath('dirty'), 'README.md'), 'utf-8'))
      .toBe('edited but never committed\n');
  });

  it('keeps the branch when patches are genuinely unmerged', () => {
    // The escalation to `-D` is gated on our own patch check, so a worktree that
    // somehow reached removal with unmerged work still keeps its commits.
    const forced = { ...named('active'), removable: true };
    const result = removeWorktree(repo, forced, git);
    expect(result.ok).toBe(true);
    expect(result.branchDeleted).toBe(false);
    expect(git(['branch', '--list', 'feature-active'], repo).trim()).toContain('feature-active');
  });

  it('reports failure rather than throwing when git refuses', () => {
    const gone = { ...named('active'), path: path.join(repo, '.worktrees', 'never-existed'), removable: true };
    const result = removeWorktree(repo, gone, git);
    expect(result.ok).toBe(false);
    expect(result.detail).toBeTruthy();
  });
});
