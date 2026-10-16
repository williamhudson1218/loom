import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetPipelineStore,
  assemblePipeline,
  cachedPipeline,
  latestChecks,
  pickDeployRun,
  rollUp,
  stateOf,
  tickPipelines,
  transitions,
  wantPipeline,
  type RunRow,
} from '../src/pipeline.ts';

const T = (m: number) => new Date(Date.UTC(2026, 9, 16, 19, m)).toISOString();
const run = (id: number, sha: string, m: number, status = 'completed', conclusion = 'success'): RunRow => ({ databaseId: id, headSha: sha, status, conclusion, createdAt: T(m), url: `https://x/runs/${id}` });
const check = (workflowName: string, name: string, status: string, conclusion: string, m: number) => ({
  __typename: 'CheckRun', workflowName, name, status, conclusion, startedAt: T(m), completedAt: conclusion ? T(m + 1) : null, detailsUrl: `https://x/${name}`,
});

const openPr = (over: any = {}) => ({
  number: 7, title: 'feat: x', url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, reviewDecision: '', mergedAt: null, mergeCommit: null,
  reviews: [],
  statusCheckRollup: [
    check('PR Checks', 'Lint', 'COMPLETED', 'SUCCESS', 1),
    check('PR Checks', 'Unit Tests', 'IN_PROGRESS', '', 1),
    check('Claude PR Review', 'review', 'COMPLETED', 'SUCCESS', 2),
    { __typename: 'StatusContext', context: 'merge-policy', state: 'PENDING', startedAt: T(2) },
  ],
  ...over,
});

describe('stateOf / rollUp', () => {
  it('maps check and job vocabularies', () => {
    expect(stateOf('COMPLETED', 'SUCCESS')).toBe('pass');
    expect(stateOf('completed', 'failure')).toBe('fail');
    expect(stateOf('completed', 'skipped')).toBe('skipped');
    expect(stateOf('in_progress', '')).toBe('running');
    expect(stateOf('queued', '')).toBe('waiting');
    expect(stateOf('', 'PENDING')).toBe('running');
  });
  it('red wins, then moving, and all-skipped stays skipped (not failed)', () => {
    expect(rollUp(['pass', 'fail', 'running'])).toBe('fail');
    expect(rollUp(['pass', 'running'])).toBe('running');
    expect(rollUp(['pass', 'waiting'])).toBe('running');
    expect(rollUp(['waiting'])).toBe('waiting');
    expect(rollUp(['skipped', 'skipped'])).toBe('skipped');
    expect(rollUp(['pass', 'skipped'])).toBe('pass');
  });
});

describe('latestChecks', () => {
  it('keeps the newest run per check and drops post-merge runs', () => {
    const rows = latestChecks([
      check('Claude PR Review', 'review', 'COMPLETED', 'FAILURE', 1),
      check('Claude PR Review', 'review', 'COMPLETED', 'SUCCESS', 5),
      check('Otto (Unstick)', 'unstick', 'COMPLETED', 'SUCCESS', 30),
    ], Date.parse(T(20)));
    expect(rows.map((r) => [r.name, r.state])).toEqual([['review', 'pass']]);
  });
});

describe('pickDeployRun', () => {
  const runs = [run(3, 'ccc', 30), run(2, 'bbb', 20, 'completed', 'cancelled'), run(1, 'aaa', 10)];
  it('finds the run for the merge commit', () => {
    expect(pickDeployRun('aaa', runs)).toEqual({ run: runs[2], via: 'own' });
    expect(pickDeployRun('zzz', runs)).toBeNull();
  });
  it('follows the newest later run when ours was cancelled with no jobs', () => {
    expect(pickDeployRun('bbb', runs, () => 0)).toEqual({ run: runs[0], via: 'newer' });
  });
  it('keeps a cancelled run that actually ran jobs', () => {
    expect(pickDeployRun('bbb', runs, () => 4)).toEqual({ run: runs[1], via: 'own' });
  });
});

describe('assemblePipeline', () => {
  it('an open PR mid-CI: checks running, review gate out of checks, nothing after', () => {
    const p = assemblePipeline({ repo: 'o/r', pr: openPr() });
    expect(p.steps.map((s) => [s.key, s.state])).toEqual([
      ['checks', 'running'], ['review', 'waiting'], ['merged', 'waiting'], ['deploy', 'waiting'], ['done', 'waiting'],
    ]);
    expect(p.steps[0].children!.map((c) => c.label)).toEqual(['PR Checks / Lint', 'PR Checks / Unit Tests']);
    expect(p.steps[1].children!.map((c) => c.label)).toContain('merge-policy');
    expect(p.inFlight).toBe(true);
    expect(p.final).toBe(false);
  });

  it("reads Claude's latest review verdict", () => {
    const approved = assemblePipeline({ repo: 'o/r', pr: openPr({ reviews: [
      { author: { login: 'claude' }, state: 'CHANGES_REQUESTED', submittedAt: T(3) },
      { author: { login: 'claude' }, state: 'APPROVED', submittedAt: T(9) },
    ] }) });
    expect(approved.steps[1]).toMatchObject({ state: 'pass', detail: 'approved' });
    const red = assemblePipeline({ repo: 'o/r', pr: openPr({ reviews: [{ author: { login: 'claude' }, state: 'CHANGES_REQUESTED', submittedAt: T(3) }] }) });
    expect(red.steps[1].state).toBe('fail');
  });

  it('a merged PR deploying: per-job steps, skipped jobs stay skipped', () => {
    const pr = openPr({ state: 'MERGED', mergedAt: T(10), mergeCommit: { oid: 'aaa' }, statusCheckRollup: [check('PR Checks', 'Lint', 'COMPLETED', 'SUCCESS', 1)] });
    const jobs = [
      { name: 'migrate', status: 'completed', conclusion: 'success', startedAt: T(11), completedAt: T(12), url: 'j1', steps: [{ name: 'Set up job', number: 1, status: 'completed', conclusion: 'success' }] },
      { name: 'Deploy ${{ matrix.app }}', status: 'completed', conclusion: 'skipped', startedAt: T(12), completedAt: T(12), url: 'j2', steps: [] },
      { name: 'deploy', status: 'in_progress', conclusion: '', startedAt: T(12), url: 'j3', steps: [] },
    ];
    const p = assemblePipeline({ repo: 'o/r', pr, run: { run: run(1, 'aaa', 10, 'in_progress', ''), via: 'own' }, jobs });
    const deploy = p.steps[3];
    expect(deploy.state).toBe('running');
    expect(deploy.children!.map((j) => j.state)).toEqual(['pass', 'skipped', 'running']);
    expect(deploy.children![0].children![0].label).toBe('Set up job');
    expect(p.steps[1]).toMatchObject({ state: 'skipped' }); // merged, no review on record
    expect(p.inFlight).toBe(true);
  });

  it('says when the deploy rides a newer run', () => {
    const pr = openPr({ state: 'MERGED', mergedAt: T(10), mergeCommit: { oid: 'bbb' } });
    const p = assemblePipeline({ repo: 'o/r', pr, run: { run: run(3, 'ccc', 30), via: 'newer' }, jobs: [] });
    expect(p.steps[3]).toMatchObject({ state: 'pass', detail: 'deploying via newer run #3' });
    expect(p.steps[4].state).toBe('pass');
    expect(p.final).toBe(true);
  });

  it('a merged PR with no deploy run yet is waiting and in flight', () => {
    const p = assemblePipeline({ repo: 'o/r', pr: openPr({ state: 'MERGED', mergedAt: T(10), mergeCommit: { oid: 'q' } }), run: null }, Date.parse(T(12)));
    expect(p.steps[3].state).toBe('waiting');
    expect(p.inFlight).toBe(true);
  });

  it('a merge long past with no run was path-filtered: skipped, and done', () => {
    const pr = openPr({ state: 'MERGED', mergedAt: T(10), mergeCommit: { oid: 'q' } });
    const p = assemblePipeline({ repo: 'o/r', pr, run: null }, Date.parse(T(40)));
    expect(p.steps[3].state).toBe('skipped');
    expect(p.steps[4].state).toBe('pass');
    expect(p.final).toBe(true);
  });

  it('a closed PR is final and skips the deploy', () => {
    const p = assemblePipeline({ repo: 'o/r', pr: openPr({ state: 'CLOSED' }) });
    expect(p.steps[2].state).toBe('fail');
    expect(p.steps[3].state).toBe('skipped');
    expect(p.final).toBe(true);
  });
});

describe('transitions', () => {
  it('reports checks going red, the review landing, and the deploy finishing', () => {
    const a = assemblePipeline({ repo: 'o/r', pr: openPr() }, 1);
    const b = assemblePipeline({ repo: 'o/r', pr: openPr({
      statusCheckRollup: [check('PR Checks', 'Unit Tests', 'COMPLETED', 'FAILURE', 1)],
      reviews: [{ author: { login: 'claude' }, state: 'APPROVED', submittedAt: T(9) }],
    }) }, 2);
    expect(transitions(a, b, 5).map((e) => e.text)).toEqual(['checks failed', 'review approved']);
    expect(transitions(null, b)).toEqual([]);
  });
});

describe('store', () => {
  beforeEach(() => _resetPipelineStore());
  it('fetches on the tick, not on want, and backs off on errors', async () => {
    const calls: string[][] = [];
    let fail = false;
    const gh = async (args: string[]) => {
      calls.push(args);
      if (fail) throw new Error('rate limited');
      return JSON.stringify(openPr());
    };
    expect(wantPipeline('o/r', 7, true, 0)).toBeNull();
    expect(calls).toHaveLength(0);
    await tickPipelines(new Set(['o/r#7']), gh, 0);
    expect(calls).toHaveLength(1);
    expect(cachedPipeline('o/r', 7)?.steps[0].state).toBe('running');
    // Not due yet: no second call.
    await tickPipelines(new Set(['o/r#7']), gh, 1000);
    expect(calls).toHaveLength(1);
    fail = true;
    wantPipeline('o/r', 7, true, 30_000);
    await tickPipelines(new Set(['o/r#7']), gh, 30_000);
    expect(calls).toHaveLength(2);
    expect(cachedPipeline('o/r', 7)).not.toBeNull(); // the last good value survives an error
    await tickPipelines(new Set(['o/r#7']), gh, 31_000 + 20_000); // backed off past the fast interval
    expect(calls).toHaveLength(2);
  });
});
