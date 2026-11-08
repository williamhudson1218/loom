import type { Pipeline } from '../../pipeline.ts';
import type { Agent } from '../../types.ts';
import type { Match, Watcher } from '../model.ts';

// The PRs source: Loom's cached PR pipelines (gh, refreshed by the board's
// pipeline tick). No gh call of its own. The cache only holds PRs some chat
// links, so "mine" means a PR a chat of yours owns.
//
// The pipeline has no head sha, so a run is identified by the checks' start
// time (a push restarts every check) and a review verdict by its submit time:
// event_key = <repo>#<n>@<that>:<trigger>.

export interface PrState {
  repo: string;
  number: number;
  title: string;
  url: string;
  checks: string; // pass | fail | running | waiting | skipped | ''
  checksDetail: string;
  checksSig: string;
  review: string;
  reviewDetail: string;
  reviewSig: string;
  final: boolean;
  /** The chat that links this PR, when one does. */
  chat: { agent: Agent; session_id: string } | null;
}

export function prStateFrom(p: Pipeline, chat: PrState['chat']): PrState {
  const step = (k: string) => p.steps.find((s) => s.key === k);
  const checks = step('checks');
  const review = step('review');
  return {
    repo: p.repo,
    number: p.number,
    title: p.title,
    url: p.url,
    checks: checks?.state ?? '',
    checksDetail: checks?.detail ?? '',
    checksSig: String(checks?.startedAt ?? ''),
    review: review?.state ?? '',
    reviewDetail: review?.detail ?? '',
    reviewSig: String(review?.completedAt ?? ''),
    final: p.final,
    chat,
  };
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

export function evaluatePrs(w: Watcher, prs: PrState[]): Match[] {
  const repos = list(w.source.params.repos);
  const mineOnly = w.source.params.mine_only !== false;
  const out: Match[] = [];
  for (const pr of prs) {
    if (pr.final) continue;
    if (repos.length && !repos.includes(pr.repo)) continue;
    if (mineOnly && !pr.chat) continue;
    let sig: string | null = null;
    let check = '';
    switch (w.trigger.kind) {
      case 'checks_red':
        if (pr.checks === 'fail') [sig, check] = [pr.checksSig, pr.checksDetail || 'checks failed'];
        break;
      case 'changes_requested':
        if (pr.review === 'fail') [sig, check] = [pr.reviewSig, pr.reviewDetail || 'changes requested'];
        break;
      case 'approved_green':
        if (pr.review === 'pass' && pr.checks === 'pass') [sig, check] = [`${pr.reviewSig}/${pr.checksSig}`, 'approved, checks green'];
        break;
    }
    if (sig === null) continue;
    const ref = `${pr.repo}#${pr.number}`;
    const title = `${ref} ${pr.title}`.trim();
    out.push({
      key: `${ref}@${sig}:${w.trigger.kind}`,
      subject: `pr:${ref}`,
      title,
      permalink: pr.url,
      chat: pr.chat,
      vars: { TITLE: title, PR: ref, PR_TITLE: pr.title, URL: pr.url, PERMALINK: pr.url, CHECK: check },
    });
  }
  return out;
}
