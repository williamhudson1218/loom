import os from 'node:os';
import { defaultGh, type GhRunner } from './detail.ts';

// A PR's whole road to prod, as steps: checks → review → merged → deploy (per
// job) → done. Built from three gh calls — the PR, the Deploy Production run
// list, and the chosen run's jobs — and cached here so neither the board poll
// nor the detail panel ever waits on GitHub. A background tick (server.ts)
// refreshes what the board can see: fast while something is in flight on a
// live chat, slowly otherwise, and almost never once the PR is deployed.

export type StepState = 'pass' | 'fail' | 'running' | 'waiting' | 'skipped';

export interface Step {
  key: string;
  label: string;
  state: StepState;
  detail?: string;
  url?: string;
  startedAt?: number;
  completedAt?: number;
  children?: Step[];
}

export interface PipelineEvent {
  at: number;
  text: string;
  tone: 'good' | 'bad' | 'info';
}

export interface Pipeline {
  repo: string;
  number: number;
  title: string;
  url: string;
  steps: Step[];
  // Nothing left to change: deployed, or closed unmerged.
  final: boolean;
  // Something is moving right now (checks, review or deploy).
  inFlight: boolean;
  fetchedAt: number;
  events: PipelineEvent[];
}

export const DEPLOY_WORKFLOW = 'deploy-production.yml';
// A push starts its run within seconds; a merge this old with no run was path-filtered out.
const NO_RUN_MS = 10 * 60_000;

const ts = (s: unknown): number | undefined => {
  const n = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

const FAIL = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE']);
const SKIP = new Set(['SKIPPED', 'NEUTRAL']);

/** One check run or commit status, or one Actions job/step, as a step state. */
export function stateOf(status: unknown, conclusion: unknown): StepState {
  const c = String(conclusion ?? '').toUpperCase();
  const s = String(status ?? '').toUpperCase();
  if (FAIL.has(c)) return 'fail';
  if (SKIP.has(c)) return 'skipped';
  if (c === 'SUCCESS') return 'pass';
  if (s === 'IN_PROGRESS') return 'running';
  if (c === 'PENDING' || c === 'EXPECTED') return 'running'; // a commit status still out
  return 'waiting'; // queued, waiting, requested, or nothing reported yet
}

/** A parent from its children: any red is red, then anything moving, then anything not started. */
export function rollUp(children: StepState[]): StepState {
  if (!children.length) return 'waiting';
  if (children.includes('fail')) return 'fail';
  if (children.includes('running')) return 'running';
  if (children.includes('waiting')) return children.some((c) => c === 'pass') ? 'running' : 'waiting';
  if (children.every((c) => c === 'skipped')) return 'skipped';
  return 'pass';
}

// The review is its own step, so the workflows that ARE the review — and the
// required status that turns it into a merge gate — come out of "checks".
const REVIEW_WORKFLOWS = new Set(['Claude PR Review', 'Merge Policy']);
const REVIEW_STATUS = new Set(['merge-policy']);
const REVIEW_BOTS = /^(claude|claude\[bot\]|github-actions|github-actions\[bot\])$/i;

interface Check {
  name: string;
  workflow: string;
  state: StepState;
  url: string;
  startedAt?: number;
  completedAt?: number;
}

/**
 * statusCheckRollup lists every RUN of a check, so a re-run review shows up twice.
 * Keep the newest per workflow+name, and drop what ran after the merge (post-merge
 * housekeeping workflows attach to the same commit and are not the PR's checks).
 */
export function latestChecks(rollup: unknown, mergedAt?: number): Check[] {
  if (!Array.isArray(rollup)) return [];
  const by = new Map<string, Check>();
  for (const c of rollup as any[]) {
    const name = String(c?.name ?? c?.context ?? '');
    if (!name) continue;
    const workflow = String(c?.workflowName ?? '');
    const startedAt = ts(c?.startedAt);
    if (mergedAt && startedAt && startedAt > mergedAt) continue;
    const check: Check = {
      name,
      workflow,
      state: c?.__typename === 'StatusContext' ? stateOf('', c?.state) : stateOf(c?.status, c?.conclusion),
      url: String(c?.detailsUrl ?? c?.targetUrl ?? ''),
      startedAt,
      completedAt: ts(c?.completedAt),
    };
    const key = `${workflow}/${name}`;
    const prev = by.get(key);
    if (!prev || (check.startedAt ?? 0) >= (prev.startedAt ?? 0)) by.set(key, check);
  }
  return [...by.values()];
}

const checkStep = (c: Check): Step => ({
  key: `check:${c.workflow}/${c.name}`,
  label: c.workflow ? `${c.workflow} / ${c.name}` : c.name,
  state: c.state,
  url: c.url || undefined,
  startedAt: c.startedAt,
  completedAt: c.completedAt,
});

const span = (steps: Step[]): { startedAt?: number; completedAt?: number } => {
  const starts = steps.map((s) => s.startedAt).filter((n): n is number => !!n);
  const ends = steps.map((s) => s.completedAt).filter((n): n is number => !!n);
  return { startedAt: starts.length ? Math.min(...starts) : undefined, completedAt: ends.length ? Math.max(...ends) : undefined };
};

export interface RunRow {
  databaseId: number;
  headSha: string;
  status: string;
  conclusion: string;
  createdAt: string;
  url?: string;
}

/**
 * The Deploy Production run that carries a merge commit. A pending run is
 * cancelled when a newer push to main takes its queue slot; then the newest
 * later run deploys our commit too, and that is the one to follow.
 */
export function pickDeployRun(sha: string, runs: RunRow[], jobCount?: (id: number) => number | undefined): { run: RunRow; via: 'own' | 'newer' } | null {
  const own = runs.find((r) => r.headSha === sha);
  if (!own) return null;
  const cancelledEmpty = String(own.conclusion).toLowerCase() === 'cancelled' && (jobCount?.(own.databaseId) ?? 0) === 0;
  if (!cancelledEmpty) return { run: own, via: 'own' };
  const at = Date.parse(own.createdAt);
  const later = runs.filter((r) => Date.parse(r.createdAt) > at).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return later.length ? { run: later[0], via: 'newer' } : { run: own, via: 'own' };
}

export interface PipelineInputs {
  repo: string;
  pr: any; // gh pr view --json (PR_FIELDS)
  run?: { run: RunRow; via: 'own' | 'newer' } | null;
  jobs?: any[]; // gh run view --json jobs → .jobs
}

export function assemblePipeline({ repo, pr, run, jobs }: PipelineInputs, now: number = Date.now()): Pipeline {
  const mergedAt = ts(pr?.mergedAt);
  const merged = String(pr?.state) === 'MERGED';
  const closed = String(pr?.state) === 'CLOSED';
  const all = latestChecks(pr?.statusCheckRollup, mergedAt);
  const isReview = (c: Check) => REVIEW_WORKFLOWS.has(c.workflow) || (!c.workflow && REVIEW_STATUS.has(c.name));

  // Checks
  const checkKids = all.filter((c) => !isReview(c)).map(checkStep).sort((a, b) => a.label.localeCompare(b.label));
  const checks: Step = { key: 'checks', label: 'Checks', state: rollUp(checkKids.map((s) => s.state)), children: checkKids, ...span(checkKids) };
  if (!checkKids.length) checks.state = merged ? 'skipped' : 'waiting';
  const failed = checkKids.filter((s) => s.state === 'fail');
  const done = checkKids.filter((s) => s.state === 'pass' || s.state === 'skipped').length;
  checks.detail = failed.length ? `${failed.length} failed: ${failed.map((s) => s.label.split(' / ').pop()).join(', ')}` : checkKids.length ? `${done}/${checkKids.length}` : undefined;

  // Review: the bot's latest verdict, the review workflow while it runs, and the merge gate.
  const reviewKids = all.filter(isReview).map(checkStep);
  const reviews = (Array.isArray(pr?.reviews) ? pr.reviews : [])
    .filter((r: any) => REVIEW_BOTS.test(String(r?.author?.login ?? '')))
    .sort((a: any, b: any) => (ts(a.submittedAt) ?? 0) - (ts(b.submittedAt) ?? 0));
  const verdict = reviews.length ? String(reviews[reviews.length - 1].state) : '';
  const verdictAt = reviews.length ? ts(reviews[reviews.length - 1].submittedAt) : undefined;
  const decision = String(pr?.reviewDecision ?? '');
  const reviewRunning = reviewKids.some((k) => k.state === 'running' && /review/i.test(k.label));
  let rstate: StepState;
  let rdetail: string;
  if (reviewRunning) [rstate, rdetail] = ['running', 'reviewing'];
  else if (verdict === 'CHANGES_REQUESTED' || decision === 'CHANGES_REQUESTED') [rstate, rdetail] = ['fail', 'changes requested'];
  else if (verdict === 'APPROVED' || decision === 'APPROVED') [rstate, rdetail] = ['pass', 'approved'];
  else if (verdict === 'COMMENTED') [rstate, rdetail] = ['waiting', 'commented'];
  else if (merged) [rstate, rdetail] = ['skipped', 'merged without review'];
  else [rstate, rdetail] = ['waiting', pr?.isDraft ? 'draft — not reviewed yet' : 'waiting for review'];
  const gate = reviewKids.find((k) => /merge-policy/i.test(k.label));
  if (rstate === 'pass' && gate && gate.state === 'fail') [rstate, rdetail] = ['fail', 'merge-policy failed'];
  const rspan = span(reviewKids);
  const review: Step = { key: 'review', label: 'Review', state: rstate, detail: rdetail, children: reviewKids, startedAt: rspan.startedAt, completedAt: Math.max(verdictAt ?? 0, rspan.completedAt ?? 0) || undefined };

  // Merged
  const mergedStep: Step = merged
    ? { key: 'merged', label: 'Merged', state: 'pass', completedAt: mergedAt, url: String(pr?.url ?? '') || undefined, detail: String(pr?.mergeCommit?.oid ?? '').slice(0, 9) }
    : closed
      ? { key: 'merged', label: 'Merged', state: 'fail', detail: 'closed without merging' }
      : { key: 'merged', label: 'Merged', state: 'waiting', detail: pr?.isDraft ? 'draft' : undefined };

  // Deploy
  let deploy: Step;
  if (!merged) deploy = { key: 'deploy', label: 'Deploy', state: closed ? 'skipped' : 'waiting' };
  else if (!run && mergedAt && now - mergedAt > NO_RUN_MS) {
    // Deploy Production is path-filtered: a merge touching nothing it deploys never starts a run.
    deploy = { key: 'deploy', label: 'Deploy', state: 'skipped', detail: 'no deploy run — nothing under a deploy path changed' };
  } else if (!run) deploy = { key: 'deploy', label: 'Deploy', state: 'waiting', detail: 'no Deploy Production run yet' };
  else {
    const jobKids: Step[] = (jobs ?? []).map((j: any) => {
      const steps: Step[] = (Array.isArray(j?.steps) ? j.steps : []).map((s: any) => ({
        key: `step:${j?.name}/${s?.number}`,
        label: String(s?.name ?? ''),
        state: stateOf(s?.status, s?.conclusion),
        startedAt: ts(s?.startedAt),
        completedAt: ts(s?.completedAt),
      }));
      return {
        key: `job:${j?.name}`,
        label: String(j?.name ?? ''),
        state: stateOf(j?.status, j?.conclusion),
        url: String(j?.url ?? '') || undefined,
        startedAt: ts(j?.startedAt),
        completedAt: String(j?.status).toLowerCase() === 'completed' ? ts(j?.completedAt) : undefined,
        children: steps,
      };
    });
    const runState = stateOf(run.run.status, run.run.conclusion);
    deploy = {
      key: 'deploy',
      label: 'Deploy',
      // The run's own conclusion is the truth once it has one; jobs fill in while it runs.
      state: runState === 'waiting' && jobKids.length ? rollUp(jobKids.map((k) => k.state)) : runState,
      url: run.run.url || undefined,
      detail: run.via === 'newer' ? `deploying via newer run #${run.run.databaseId}` : `run #${run.run.databaseId}`,
      children: jobKids,
      ...span(jobKids),
    };
  }

  const finalStep: Step = { key: 'done', label: 'Done', state: deploy.state === 'pass' || (merged && deploy.state === 'skipped') ? 'pass' : deploy.state === 'fail' ? 'fail' : closed ? 'skipped' : 'waiting', completedAt: deploy.state === 'pass' ? deploy.completedAt : undefined };

  const steps = [checks, review, mergedStep, deploy, finalStep];
  return {
    repo,
    number: Number(pr?.number ?? 0),
    title: String(pr?.title ?? ''),
    url: String(pr?.url ?? ''),
    steps,
    final: closed || deploy.state === 'pass' || (merged && deploy.state === 'skipped') || (merged && deploy.state === 'fail' && run?.run.status === 'completed'),
    inFlight: steps.some((s) => s.state === 'running') || (merged && deploy.state === 'waiting'),
    fetchedAt: now,
    events: [],
  };
}

/** What changed between two fetches that is worth a badge on the card. */
export function transitions(prev: Pipeline | null, next: Pipeline, now: number = Date.now()): PipelineEvent[] {
  if (!prev) return [];
  const st = (p: Pipeline, k: string) => p.steps.find((s) => s.key === k)?.state;
  const out: PipelineEvent[] = [];
  if (st(next, 'checks') === 'fail' && st(prev, 'checks') !== 'fail') out.push({ at: now, text: 'checks failed', tone: 'bad' });
  const rp = st(prev, 'review');
  const rn = st(next, 'review');
  if (rn !== rp && (rn === 'pass' || rn === 'fail')) out.push({ at: now, text: rn === 'pass' ? 'review approved' : 'changes requested', tone: rn === 'pass' ? 'good' : 'bad' });
  const dp = st(prev, 'deploy');
  const dn = st(next, 'deploy');
  if (dn !== dp && dn === 'pass') out.push({ at: now, text: 'deployed', tone: 'good' });
  if (dn !== dp && dn === 'fail') out.push({ at: now, text: 'deploy failed', tone: 'bad' });
  return out;
}

/** The board's dot strip: one dot per top-level step. */
export function dots(p: Pipeline): { key: string; label: string; state: StepState; detail?: string }[] {
  return p.steps.map((s) => ({ key: s.key, label: s.label, state: s.state, ...(s.detail ? { detail: s.detail } : {}) }));
}

/* ------------------------------------------------------------------ the store */

const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,mergeCommit,mergedAt,reviews';
const FAST_MS = 20_000; // in flight on a live chat
const SLOW_MS = 180_000; // open, nothing moving, or not live
const FINAL_MS = 30 * 60_000; // deployed or closed: barely changes
const RUNS_TTL_MS = 15_000;
const MAX_BACKOFF_MS = 15 * 60_000;
const MAX_EVENTS = 6;

interface Entry {
  repo: string;
  number: number;
  value: Pipeline | null;
  nextAt: number;
  errors: number;
  inflight?: Promise<void>;
  wantedAt: number; // last time anything asked for it
  live: boolean;
}

const store = new Map<string, Entry>();
const runsCache = new Map<string, { at: number; rows: RunRow[]; inflight?: Promise<RunRow[]> }>();
const jobsCache = new Map<number, any[]>(); // completed runs only: their jobs never change

export const pipelineKey = (repo: string, number: number) => `${repo}#${number}`;

export function parsePrRef(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/** Register interest, and answer from cache. Never fetches; the tick does. */
export function wantPipeline(repo: string, number: number, live: boolean, now: number = Date.now()): Pipeline | null {
  const key = pipelineKey(repo, number);
  let e = store.get(key);
  if (!e) {
    e = { repo, number, value: null, nextAt: 0, errors: 0, wantedAt: now, live };
    store.set(key, e);
  }
  e.wantedAt = now;
  // A chat that just went live with something in flight shouldn't wait out the slow interval.
  if (live && !e.live && e.value?.inFlight) e.nextAt = Math.min(e.nextAt, now);
  e.live = live || e.live;
  return e.value;
}

export function cachedPipeline(repo: string, number: number): Pipeline | null {
  return store.get(pipelineKey(repo, number))?.value ?? null;
}

export function allPipelines(): Record<string, Pipeline> {
  const out: Record<string, Pipeline> = {};
  for (const [k, e] of store) if (e.value) out[k] = e.value;
  return out;
}

async function deployRuns(repo: string, gh: GhRunner, now: number): Promise<RunRow[]> {
  let c = runsCache.get(repo);
  if (c && now - c.at < RUNS_TTL_MS) return c.rows;
  if (c?.inflight) return c.inflight;
  if (!c) runsCache.set(repo, (c = { at: 0, rows: [] }));
  const entry = c;
  entry.inflight = gh(['run', 'list', '--repo', repo, '--workflow', DEPLOY_WORKFLOW, '--branch', 'main', '--limit', '40', '--json', 'databaseId,headSha,status,conclusion,createdAt,url'], os.homedir())
    .then((out) => {
      entry.rows = JSON.parse(out) as RunRow[];
      entry.at = Date.now();
      return entry.rows;
    })
    .finally(() => { entry.inflight = undefined; });
  return entry.inflight;
}

async function runJobs(repo: string, run: RunRow, gh: GhRunner): Promise<any[]> {
  const hit = jobsCache.get(run.databaseId);
  if (hit) return hit;
  const out = JSON.parse(await gh(['run', 'view', String(run.databaseId), '--repo', repo, '--json', 'jobs'], os.homedir()));
  const jobs = Array.isArray(out?.jobs) ? out.jobs : [];
  if (String(run.status).toLowerCase() === 'completed') jobsCache.set(run.databaseId, jobs);
  return jobs;
}

export async function fetchPipeline(repo: string, number: number, gh: GhRunner = defaultGh, now: number = Date.now()): Promise<Pipeline> {
  const pr = JSON.parse(await gh(['pr', 'view', String(number), '--repo', repo, '--json', PR_FIELDS], os.homedir()));
  let run: PipelineInputs['run'] = null;
  let jobs: any[] | undefined;
  const sha = String(pr?.mergeCommit?.oid ?? '');
  if (pr?.state === 'MERGED' && sha) {
    let runs = await deployRuns(repo, gh, now);
    // An older merge has scrolled off the recent list: ask for its commit directly,
    // plus the recent list, which is where any newer run that replaced it lives.
    if (!runs.some((r) => r.headSha === sha)) {
      const own = JSON.parse(await gh(['run', 'list', '--repo', repo, '--workflow', DEPLOY_WORKFLOW, '--commit', sha, '--json', 'databaseId,headSha,status,conclusion,createdAt,url'], os.homedir())) as RunRow[];
      runs = [...own, ...runs];
    }
    let picked = pickDeployRun(sha, runs);
    if (picked && String(picked.run.conclusion).toLowerCase() === 'cancelled') {
      // Only a cancelled run with NO jobs was replaced; one that ran jobs was cancelled for real.
      const ownJobs = await runJobs(repo, picked.run, gh);
      picked = pickDeployRun(sha, runs, () => ownJobs.length);
    }
    if (picked) {
      run = picked;
      jobs = await runJobs(repo, picked.run, gh);
    }
  }
  return assemblePipeline({ repo, pr, run, jobs }, now);
}

function interval(e: Entry): number {
  const p = e.value;
  if (!p) return SLOW_MS;
  if (p.final) return FINAL_MS;
  return p.inFlight && e.live ? FAST_MS : SLOW_MS;
}

/**
 * One background pass: refresh whatever is due, a couple at a time. Entries
 * nobody has asked about for a while are dropped. `live` re-marks which PRs
 * belong to a live chat this pass.
 */
export async function tickPipelines(liveKeys: Set<string>, gh: GhRunner = defaultGh, now: number = Date.now(), concurrency = 2): Promise<number> {
  for (const [k, e] of store) {
    if (now - e.wantedAt > 30 * 60_000) store.delete(k);
    else e.live = liveKeys.has(k);
  }
  const due = [...store.values()].filter((e) => !e.inflight && e.nextAt <= now).sort((a, b) => Number(b.live) - Number(a.live) || a.nextAt - b.nextAt);
  let i = 0;
  let done = 0;
  const worker = async () => {
    while (i < due.length) {
      const e = due[i++];
      e.inflight = fetchPipeline(e.repo, e.number, gh)
        .then((p) => {
          const ev = transitions(e.value, p);
          p.events = [...(e.value?.events ?? []), ...ev].slice(-MAX_EVENTS);
          e.value = p;
          e.errors = 0;
          e.nextAt = now + interval(e);
          done++;
        })
        .catch(() => {
          // Rate limit, network, a deleted PR: back off, and keep serving the last value.
          e.errors++;
          e.nextAt = now + Math.min(MAX_BACKOFF_MS, SLOW_MS * 2 ** (e.errors - 1));
        })
        .finally(() => { e.inflight = undefined; });
      await e.inflight;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker));
  return done;
}

/** Ask for a refresh soon (e.g. the panel just opened on it). */
export function nudgePipeline(repo: string, number: number, now: number = Date.now()): void {
  const e = store.get(pipelineKey(repo, number));
  if (e && !e.value) e.nextAt = Math.min(e.nextAt, now);
}

export function _resetPipelineStore(): void {
  store.clear();
  runsCache.clear();
  jobsCache.clear();
}
