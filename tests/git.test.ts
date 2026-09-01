import { describe, it, expect } from 'vitest';
import {
  parseWorktreeList,
  parseStatus,
  parseAheadBehind,
  countUnmergedPatches,
  parseNumstat,
  assignPanesToWorktrees,
  classify,
  removalPlan,
  type WorktreeState,
} from '../src/git.ts';

// Fixtures below are real output captured from tax-pilot-app, which is the repo
// this feature exists to survive: 44 worktrees, squash-merged branches, and one
// worktree holding uncommitted work that every merge-based test calls disposable.

const PORCELAIN = `worktree /Users/w/dev/tax-pilot-app
HEAD d9e02686209c2ee5ff6b206d6b3f0f39697f3e07
branch refs/heads/main

worktree /Users/w/dev/tax-pilot-app/.worktrees/filing-mn-mnwh
HEAD 3f5dfe686f0f73685b7b43c67b8eee1ebc50e7ff
branch refs/heads/fix/mnwh-nullable-company

worktree /Users/w/dev/tax-pilot-app/.worktrees/detached-one
HEAD 1bc474df30530d3dbfaba5ba6e9bbdc83abb7d93
detached

`;

describe('parseWorktreeList', () => {
  it('parses path, head and branch for each worktree', () => {
    const wts = parseWorktreeList(PORCELAIN);
    expect(wts).toHaveLength(3);
    expect(wts[0]).toMatchObject({
      path: '/Users/w/dev/tax-pilot-app',
      name: 'tax-pilot-app',
      branch: 'main',
      primary: true,
    });
  });

  it('keeps the branch name, not the ref path', () => {
    const wts = parseWorktreeList(PORCELAIN);
    expect(wts[1].branch).toBe('fix/mnwh-nullable-company');
  });

  it('distinguishes the directory name from the branch name', () => {
    // Nine of the 44 real worktrees disagree; the rail shows both for this reason.
    const wt = parseWorktreeList(PORCELAIN)[1];
    expect(wt.name).toBe('filing-mn-mnwh');
    expect(wt.branch).not.toBe(wt.name);
  });

  it('marks only the first worktree as primary', () => {
    const wts = parseWorktreeList(PORCELAIN);
    expect(wts.filter((w) => w.primary)).toHaveLength(1);
  });

  it('reports a detached worktree with a null branch', () => {
    expect(parseWorktreeList(PORCELAIN)[2].branch).toBeNull();
  });

  it('ignores a bare repository entry', () => {
    const out = 'worktree /repo/.bare\nbare\n\nworktree /repo/main\nHEAD abc\nbranch refs/heads/main\n\n';
    const wts = parseWorktreeList(out);
    expect(wts.map((w) => w.path)).toEqual(['/repo/main']);
  });

  it('returns nothing for empty output', () => {
    expect(parseWorktreeList('')).toEqual([]);
  });
});

describe('parseStatus', () => {
  it('separates tracked modifications from untracked files', () => {
    const out = ' M apps/admin-app/src/app/AuthContext.tsx\n M packages/db/index.ts\n?? OTTO-DRY-RUN.md\n';
    expect(parseStatus(out)).toEqual({
      trackedModified: 2,
      untracked: 1,
      untrackedPaths: ['OTTO-DRY-RUN.md'],
    });
  });

  it('counts staged, deleted and renamed entries as tracked', () => {
    const out = 'M  a.ts\nD  b.ts\nR  c.ts -> d.ts\nA  e.ts\n';
    expect(parseStatus(out).trackedModified).toBe(4);
  });

  it('treats an untracked-only worktree as having no tracked work', () => {
    // The real issue-1201 worktree: two Otto scratch files and nothing else.
    const out = '?? OTTO-DRY-RUN.md\n?? OTTO-PR-BODY.md\n';
    expect(parseStatus(out)).toMatchObject({ trackedModified: 0, untracked: 2 });
  });

  it('caps the untracked path list so a 3907-file worktree cannot flood the payload', () => {
    const out = Array.from({ length: 3907 }, (_, i) => `?? file-${i}.ts`).join('\n');
    const r = parseStatus(out);
    expect(r.untracked).toBe(3907);
    expect(r.untrackedPaths).toHaveLength(20);
  });

  it('returns zeroes for a clean worktree', () => {
    expect(parseStatus('')).toEqual({ trackedModified: 0, untracked: 0, untrackedPaths: [] });
  });
});

describe('parseAheadBehind', () => {
  it('reads left as behind and right as ahead', () => {
    // `rev-list --left-right --count origin/main...HEAD` on the real ach-preflight.
    expect(parseAheadBehind('35\t7\n')).toEqual({ behind: 35, ahead: 7 });
  });

  it('falls back to zeroes when the upstream ref is missing', () => {
    expect(parseAheadBehind('')).toEqual({ behind: 0, ahead: 0 });
  });
});

describe('countUnmergedPatches', () => {
  it('counts only the + lines', () => {
    expect(countUnmergedPatches('+ aaa\n- bbb\n+ ccc\n')).toBe(2);
  });

  it('returns zero for a squash-merged branch', () => {
    // The whole reason `ahead` cannot be the test: fix-eslint-db-scripts reads as
    // 1 commit ahead of main forever, yet git cherry finds no unmerged patch.
    expect(countUnmergedPatches('- 4f2a91c\n')).toBe(0);
  });
});

describe('parseNumstat', () => {
  it('parses additions, deletions and path', () => {
    const out = '12\t2\tapps/client-app/src/app/api/payroll-connections/[id]/route.ts\n51\t1\tpackages/services/demoVideo/localPipelineRunner.ts\n';
    expect(parseNumstat(out)).toEqual([
      { added: 12, deleted: 2, path: 'apps/client-app/src/app/api/payroll-connections/[id]/route.ts' },
      { added: 51, deleted: 1, path: 'packages/services/demoVideo/localPipelineRunner.ts' },
    ]);
  });

  it('reports a binary file as zero rather than NaN', () => {
    expect(parseNumstat('-\t-\tassets/logo.png\n')).toEqual([
      { added: 0, deleted: 0, path: 'assets/logo.png', binary: true },
    ]);
  });
});

describe('assignPanesToWorktrees', () => {
  const REPO = '/Users/w/dev/tax-pilot-app';
  const WT = REPO + '/.worktrees/feature-demo-editor';
  const paths = [REPO, WT, REPO + '/.worktrees/filing-or-132'];
  const pane = (cwd: string, session = 'loom-tp-4', id = '%7') => ({ tmux_session: session, pane_id: id, cwd });

  it('assigns a pane sitting exactly in a worktree', () => {
    expect(assignPanesToWorktrees(paths, [pane(WT)])[WT]).toHaveLength(1);
  });

  it('assigns a pane in a subdirectory to the worktree, not the repo root', () => {
    // The original bug in miniature: every worktree path also has the repo root
    // as a prefix, so a first- or shortest-match badges the repository instead.
    const r = assignPanesToWorktrees(paths, [pane(WT + '/packages/services/demoVideo')]);
    expect(r[WT]).toHaveLength(1);
    expect(r[REPO]).toBeUndefined();
  });

  it('still assigns a pane in the repo root to the repo', () => {
    const r = assignPanesToWorktrees(paths, [pane(REPO + '/apps/client-app')]);
    expect(r[REPO]).toHaveLength(1);
  });

  it('does not let a sibling directory match on a shared prefix', () => {
    // `/w/.worktrees/filing-or-1320` must not land in `/w/.worktrees/filing-or-132`.
    const r = assignPanesToWorktrees(paths, [pane(REPO + '/.worktrees/filing-or-1320')]);
    expect(Object.keys(r)).toEqual([REPO]);
  });

  it('ignores a pane outside every known worktree', () => {
    expect(assignPanesToWorktrees(paths, [pane('/Users/w/.superbot2/spaces/x')])).toEqual({});
  });

  it('ignores a pane with no recorded cwd', () => {
    expect(assignPanesToWorktrees(paths, [pane('')])).toEqual({});
  });

  it('falls back to the launch dir when the pane sits at the repo root', () => {
    // The common real case: a session started inside a worktree, whose pane cwd
    // still reads as the repository. Every one of Will's 38 panes looks like this.
    const r = assignPanesToWorktrees(paths, [{ tmux_session: 'loom-tp-4', pane_id: '%7', cwd: REPO, launchDir: WT }]);
    expect(r[WT]).toHaveLength(1);
    expect(r[REPO]).toBeUndefined();
  });

  it('prefers whichever of the two directories is more specific', () => {
    // Launched at the root, then moved into a worktree — the worktree wins.
    const r = assignPanesToWorktrees(paths, [{ tmux_session: 'loom-tp-4', pane_id: '%7', cwd: WT + '/apps', launchDir: REPO }]);
    expect(r[WT]).toHaveLength(1);
  });

  it('collects multiple panes in the same worktree', () => {
    const r = assignPanesToWorktrees(paths, [pane(WT, 'loom-tp-4', '%7'), pane(WT + '/apps', 'loom-tp-2', '%9')]);
    expect(r[WT].map((p) => p.tmux_session)).toEqual(['loom-tp-4', 'loom-tp-2']);
  });
});

const base = {
  path: '/w/x',
  name: 'x',
  head: 'abc',
  branch: 'x',
  primary: false,
  behind: 10,
  ahead: 0,
  trackedModified: 0,
  untracked: 0,
  untrackedPaths: [],
  unmergedPatches: 0,
  livePanes: [],
};

describe('classify', () => {
  it('calls a merged, clean, unoccupied worktree safe', () => {
    expect(classify({ ...base, ahead: 1 }).verdict).toBe('safe');
  });

  it('refuses to call the primary worktree removable', () => {
    expect(classify({ ...base, primary: true }).verdict).toBe('primary');
  });

  it('calls a worktree with unmerged patches active', () => {
    expect(classify({ ...base, ahead: 95, unmergedPatches: 83 }).verdict).toBe('active');
  });

  it('flags a merged worktree that still holds untracked files', () => {
    const r = classify({ ...base, ahead: 1, untracked: 2, untrackedPaths: ['OTTO-DRY-RUN.md', 'OTTO-PR-BODY.md'] });
    expect(r.verdict).toBe('untracked-only');
    expect(r.reason).toContain('OTTO-DRY-RUN.md');
  });

  it('lets uncommitted tracked work veto a clean merge verdict', () => {
    // session-lifecycle-revocation: 0 ahead, 0 unmerged patches, 20 modified files.
    // Every merge-based rule says "delete me"; the working tree is the only thing
    // standing between that worktree and 20 files of unrecoverable work.
    const r = classify({ ...base, ahead: 0, unmergedPatches: 0, trackedModified: 20 });
    expect(r.verdict).toBe('uncommitted');
    expect(r.removable).toBe(false);
  });

  it('lets uncommitted tracked work outrank an active verdict too', () => {
    const r = classify({ ...base, unmergedPatches: 83, trackedModified: 4 });
    expect(r.verdict).toBe('uncommitted');
  });

  it('never marks a worktree with a live Loom session removable', () => {
    const r = classify({ ...base, ahead: 1, livePanes: [{ tmux_session: 'loom-tp-4', pane_id: '%7', cwd: '/w/x' }] });
    expect(r.removable).toBe(false);
    expect(r.reason).toContain('loom-tp-4');
  });

  it('marks only the safe verdict removable', () => {
    expect(classify({ ...base, ahead: 1 }).removable).toBe(true);
    expect(classify({ ...base, untracked: 1 }).removable).toBe(false);
    expect(classify({ ...base, unmergedPatches: 1 }).removable).toBe(false);
    expect(classify({ ...base, primary: true }).removable).toBe(false);
  });
});

describe('removalPlan', () => {
  const safe = classify({ ...base, path: '/w/safe', name: 'fix-eslint-db-scripts', ahead: 1 }) as WorktreeState;
  const risky = classify({ ...base, path: '/w/risky', name: 'session-lifecycle-revocation', trackedModified: 20 }) as WorktreeState;

  it('plans removal for a safe worktree', () => {
    const plan = removalPlan([safe], [safe.path]);
    expect(plan.approved.map((w) => w.name)).toEqual(['fix-eslint-db-scripts']);
    expect(plan.refused).toEqual([]);
  });

  it('refuses a requested worktree that is not removable', () => {
    const plan = removalPlan([safe, risky], [safe.path, risky.path]);
    expect(plan.approved.map((w) => w.name)).toEqual(['fix-eslint-db-scripts']);
    expect(plan.refused[0]).toMatchObject({ name: 'session-lifecycle-revocation' });
  });

  it('refuses a path that is not a known worktree', () => {
    // Guards the destructive route against an arbitrary path arriving over HTTP.
    const plan = removalPlan([safe], ['/etc']);
    expect(plan.approved).toEqual([]);
    expect(plan.refused[0]).toMatchObject({ path: '/etc', reason: expect.stringContaining('not a worktree') });
  });

  it('never plans removal of the primary worktree even when asked directly', () => {
    const primary = classify({ ...base, name: 'tax-pilot-app', primary: true }) as WorktreeState;
    expect(removalPlan([primary], [primary.path]).approved).toEqual([]);
  });

  it('approves a repeated path once, so a double-submit cannot remove twice', () => {
    const plan = removalPlan([safe], [safe.path, safe.path]);
    expect(plan.approved).toHaveLength(1);
  });
});
