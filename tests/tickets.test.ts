import { beforeEach, describe, expect, it } from 'vitest';
import {
  _resetTicketStore,
  buildTickets,
  chatIssueRefs,
  markTicketsRequested,
  orderTickets,
  prIssueRefs,
  refreshTickets,
  repoSlug,
  ticketsDue,
  ticketsSnapshot,
  toIssueRow,
  toPrRow,
  type BuildInput,
  type ChatInput,
  type IssueRow,
  type PrRow,
} from '../src/tickets.ts';
import type { Pipeline, StepState } from '../src/pipeline.ts';

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse('2026-10-20T18:00:00Z');

const issue = (n: number, over: Partial<IssueRow> = {}): IssueRow => ({
  repo: 'o/r', number: n, title: `Issue ${n}`, url: `https://github.com/o/r/issues/${n}`, labels: [], state: 'open', author: 'will',
  createdAt: NOW - 5 * D, updatedAt: NOW - 2 * D, ...over,
});
const pr = (n: number, over: Partial<PrRow> = {}): PrRow => ({
  repo: 'o/r', number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, state: 'open', isDraft: false, body: '', headRefName: 'x',
  createdAt: NOW - D, ...over,
});
const chat = (key: string, over: Partial<ChatInput> = {}): ChatInput => ({
  key, repo: 'o/r', title: '', firstMessage: '', state: 'idle', since: NOW - 3 * H, lastActive: NOW - H, ...over,
});
type States = Partial<Record<'checks' | 'review' | 'merged' | 'deploy' | 'done', StepState>>;
const pipe = (states: States, over: Partial<Pipeline> = {}): Pipeline => ({
  repo: 'o/r', number: 1, title: '', url: '', fetchedAt: NOW, events: [], final: false, inFlight: false,
  steps: (['checks', 'review', 'merged', 'deploy', 'done'] as const).map((key) => ({ key, label: key, state: states[key] ?? 'waiting' })),
  ...over,
});
const build = (over: Partial<BuildInput>) => buildTickets({ issues: [], prs: [], chats: [], pipeline: () => null, now: NOW, ...over });
const one = (over: Partial<BuildInput>) => {
  const { tickets } = build(over);
  expect(tickets).toHaveLength(1);
  return tickets[0];
};

describe('prIssueRefs', () => {
  const known = new Set([12, 13, 14, 15, 16, 2026]);
  it('reads closing keywords in the body and #N in the title', () => {
    expect(prIssueRefs({ body: 'Closes #12\nfixes: #13, RESOLVED #14 and #77', title: 'feat: thing (#15)', headRefName: 'x' }, known)).toEqual([12, 13, 14, 15]);
  });
  it('reads a branch number only when it is a known issue', () => {
    expect(prIssueRefs({ body: '', title: 'feat', headRefName: 'otto/16-foo' }, known)).toEqual([16]);
    expect(prIssueRefs({ body: '', title: 'feat', headRefName: 'claude/issue-16-foo' }, known)).toEqual([16]);
    expect(prIssueRefs({ body: '', title: 'feat', headRefName: 'fix-99' }, known)).toEqual([]);
    // A ship bundles many chats' work; its date segments are not issue numbers.
    expect(prIssueRefs({ body: '', title: 'ship', headRefName: 'ship/2026-10-20a' }, known)).toEqual([]);
  });
});

describe('chatIssueRefs', () => {
  it('reads #N and issue URLs for the chat’s own repo', () => {
    expect(chatIssueRefs('Work on o/r#3208: windows\nhttps://github.com/o/r/issues/3208', 'o/r')).toEqual([3208]);
    expect(chatIssueRefs('see https://github.com/other/repo/issues/5', 'o/r')).toEqual([]);
    expect(chatIssueRefs('nothing here', 'o/r')).toEqual([]);
  });
});

describe('gh rows', () => {
  it('maps gh issue and pr JSON', () => {
    expect(toIssueRow('o/r', { number: 3, title: 't', url: 'u', labels: [{ name: 'bug' }, { name: 'agent:ready' }], state: 'OPEN', author: { login: 'will' }, createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z' }))
      .toMatchObject({ repo: 'o/r', number: 3, labels: ['bug', 'agent:ready'], state: 'open', author: 'will', createdAt: Date.parse('2026-10-01T00:00:00Z') });
    expect(toIssueRow('o/r', { number: 4, state: 'CLOSED', closedAt: '2026-10-19T00:00:00Z' })).toMatchObject({ state: 'closed', closedAt: Date.parse('2026-10-19T00:00:00Z') });
    expect(toPrRow('o/r', { number: 9, state: 'MERGED', isDraft: false, headRefName: 'b', mergedAt: '2026-10-19T00:00:00Z' })).toMatchObject({ state: 'merged', mergedAt: Date.parse('2026-10-19T00:00:00Z') });
    expect(toPrRow('o/r', { number: 9, state: 'CLOSED' })?.state).toBe('closed');
    expect(toPrRow('o/r', {})).toBeNull();
  });
});

describe('which issues appear', () => {
  it('counts an unlabelled, unlinked open issue as backlog, not a card', () => {
    const { tickets, backlog } = build({ issues: [issue(1)] });
    expect(tickets).toEqual([]);
    expect(backlog).toEqual({ 'o/r': 1 });
  });
  it('shows agent-labelled, chat-linked, PR-linked and recently closed issues', () => {
    const { tickets, backlog } = build({
      issues: [issue(1, { labels: ['agent:proposed'] }), issue(2), issue(3), issue(4, { state: 'closed', closedAt: NOW - D }), issue(5), issue(6)],
      prs: [pr(30, { body: 'closes #3' }), pr(31, { body: 'closes #5', state: 'merged', mergedAt: NOW - 2 * D })],
      chats: [chat('claude:a', { title: 'fix #2' })],
    });
    expect(tickets.map((t) => t.number).sort()).toEqual([1, 2, 3, 4, 5]);
    expect(backlog).toEqual({ 'o/r': 1 });
  });
  it('drops an issue closed more than 7 days ago', () => {
    const { tickets, backlog } = build({ issues: [issue(1, { state: 'closed', closedAt: NOW - 8 * D })] });
    expect(tickets).toEqual([]);
    expect(backlog).toEqual({ 'o/r': 0 });
  });
});

describe('stage', () => {
  it('1: closed → done', () => {
    expect(one({ issues: [issue(1, { state: 'closed', closedAt: NOW - D })], prs: [pr(2, { body: 'closes #1' })] }).stage).toBe('done');
  });
  it('2: merged PR with a final pipeline → done', () => {
    const t = one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', state: 'merged', mergedAt: NOW - 2 * H })], pipeline: () => pipe({ checks: 'pass', review: 'pass', merged: 'pass', deploy: 'pass', done: 'pass' }, { final: true }) });
    expect(t.stage).toBe('done');
  });
  it('3: merged PR still deploying → shipping; a chat in the ship lock → shipping', () => {
    expect(one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', state: 'merged', mergedAt: NOW - H })], pipeline: () => pipe({ checks: 'pass', merged: 'pass', deploy: 'running' }, { inFlight: true }) }).stage).toBe('shipping');
    expect(one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', state: 'merged', mergedAt: NOW - H })] }).stage).toBe('shipping'); // pipeline not fetched yet
    expect(one({ issues: [issue(1)], chats: [chat('claude:a', { title: '#1', state: 'working', shipping: true, shipAt: NOW - 10 * 60_000 })] }).stage).toBe('shipping');
  });
  it('4: an open PR → review, even with a live chat', () => {
    expect(one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', isDraft: true })], chats: [chat('claude:a', { title: '#1', state: 'working' })] }).stage).toBe('review');
  });
  it('5: agent:claimed or a live chat → progress', () => {
    expect(one({ issues: [issue(1, { labels: ['agent:claimed'] })] }).stage).toBe('progress');
    expect(one({ issues: [issue(1)], chats: [chat('claude:a', { title: '#1', state: 'idle' })] }).stage).toBe('progress');
  });
  it('6: agent:ready, or unlabelled but linked to an ended chat or closed PR → ready', () => {
    expect(one({ issues: [issue(1, { labels: ['agent:ready'] })] }).stage).toBe('ready');
    expect(one({ issues: [issue(1)], chats: [chat('claude:a', { title: '#1', state: 'ended' })] }).stage).toBe('ready');
    expect(one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', state: 'closed', closedAt: NOW - D })] }).stage).toBe('ready');
  });
  it('7: agent:proposed → proposed', () => {
    expect(one({ issues: [issue(1, { labels: ['agent:proposed'] })] }).stage).toBe('proposed');
  });
  it('8: any other agent label → ready', () => {
    expect(one({ issues: [issue(1, { labels: ['agent:blocked'] })] }).stage).toBe('ready');
  });
});

describe('links', () => {
  it('links a chat through its PR, and a chat’s ship PR when it has nothing left unshipped', () => {
    const t = one({
      issues: [issue(1)],
      prs: [pr(2, { body: 'closes #1' })],
      chats: [chat('claude:a', { prKey: 'o/r#2' }), chat('claude:b', { title: '#1', shipPrs: [pr(40, { state: 'merged', mergedAt: NOW - H, headRefName: 'ship/2026-10-20a' })] })],
    });
    expect(t.chats.map((c) => c.key)).toEqual(['claude:a', 'claude:b']);
    expect(t.prs.map((p) => p.number).sort()).toEqual([2, 40]);
    const u = one({ issues: [issue(1)], chats: [chat('claude:b', { title: '#1', shipNext: 'unstaged', shipPrs: [pr(40, { state: 'merged', mergedAt: NOW - H })] })] });
    expect(u.prs).toEqual([]);
    expect(u.stage).toBe('progress');
  });
});

describe('flags', () => {
  const linked = (over: Partial<BuildInput>) => one({ issues: [issue(1)], ...over });
  it('needsYou: a your_turn chat, an approved PR waiting on a human merge, or agent:blocked', () => {
    expect(linked({ chats: [chat('claude:a', { title: '#1', state: 'your_turn' })] })).toMatchObject({ needsYou: true, tone: 'needsYou' });
    expect(linked({ prs: [pr(2, { body: 'closes #1' })], pipeline: () => pipe({ checks: 'pass', review: 'pass', merged: 'waiting' }) }).needsYou).toBe(true);
    expect(linked({ prs: [pr(2, { body: 'closes #1' })], pipeline: () => pipe({ checks: 'pass', review: 'waiting' }) }).needsYou).toBe(false);
    expect(linked({ issues: [issue(1, { labels: ['agent:blocked'] })] }).needsYou).toBe(true);
  });
  it('working: a working chat or a pipeline in flight', () => {
    expect(linked({ chats: [chat('claude:a', { title: '#1', state: 'working' })] })).toMatchObject({ working: true, tone: 'working' });
    expect(linked({ prs: [pr(2, { body: 'closes #1' })], pipeline: () => pipe({ checks: 'running' }, { inFlight: true }) }).working).toBe(true);
  });
  it('failing: a red step on an open PR, or agent:needs-rerun; a closed PR does not count', () => {
    expect(linked({ prs: [pr(2, { body: 'closes #1' })], pipeline: () => pipe({ checks: 'fail' }) })).toMatchObject({ failing: true, tone: 'failing' });
    expect(linked({ prs: [pr(2, { body: 'closes #1', state: 'closed', closedAt: NOW - H })], pipeline: () => pipe({ merged: 'fail' }, { final: true }) }).failing).toBe(false);
    expect(linked({ issues: [issue(1, { labels: ['agent:needs-rerun'] })] }).failing).toBe(true);
  });
  it('stale: nothing moved for 3 days and nobody is working', () => {
    expect(linked({ issues: [issue(1, { labels: ['agent:ready'], updatedAt: NOW - 4 * D })] })).toMatchObject({ stale: true, tone: 'stale' });
    expect(linked({ issues: [issue(1, { labels: ['agent:ready'], updatedAt: NOW - 4 * D })], chats: [chat('claude:a', { title: '#1', state: 'ended', lastActive: NOW - D })] }).stale).toBe(false);
    expect(linked({ issues: [issue(1, { updatedAt: NOW - 4 * D })], chats: [chat('claude:a', { title: '#1', state: 'working', lastActive: NOW - 4 * D })] }).stale).toBe(false);
    expect(linked({ issues: [issue(1, { state: 'closed', closedAt: NOW - 4 * D, updatedAt: NOW - 4 * D })] }).stale).toBe(false);
  });
  it('otto: agent:claimed / agent:in-review, or an /orchestrate chat', () => {
    expect(linked({ issues: [issue(1, { labels: ['agent:in-review'] })] }).otto).toBe(true);
    expect(linked({ chats: [chat('claude:a', { title: '#1', firstMessage: '/orchestrate tick' })] }).otto).toBe(true);
    expect(linked({ chats: [chat('claude:a', { title: '#1' })] }).otto).toBe(false);
  });
  it('tone priority: failing over needsYou over working over stale', () => {
    expect(linked({ chats: [chat('claude:a', { title: '#1', state: 'your_turn' })], prs: [pr(2, { body: 'closes #1' })], pipeline: () => pipe({ checks: 'fail' }) }).tone).toBe('failing');
    expect(linked({ chats: [chat('claude:a', { title: '#1', state: 'your_turn' }), chat('claude:b', { title: '#1', state: 'working' })] }).tone).toBe('needsYou');
    expect(linked({ issues: [issue(1, { labels: ['agent:ready'] })] }).tone).toBe('none');
  });
});

describe('stageSince', () => {
  it('per stage: closedAt, deploy completion, mergedAt, PR createdAt, chat start, issue updatedAt', () => {
    expect(one({ issues: [issue(1, { state: 'closed', closedAt: NOW - D })] }).stageSince).toBe(NOW - D);
    const deployed = pipe({ checks: 'pass', review: 'pass', merged: 'pass', deploy: 'pass', done: 'pass' }, { final: true });
    deployed.steps[4].completedAt = NOW - 3 * H;
    expect(one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', state: 'merged', mergedAt: NOW - 5 * H })], pipeline: () => deployed }).stageSince).toBe(NOW - 3 * H);
    expect(one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', state: 'merged', mergedAt: NOW - 5 * H })] }).stageSince).toBe(NOW - 5 * H);
    expect(one({ issues: [issue(1)], prs: [pr(2, { body: 'closes #1', createdAt: NOW - 6 * H }), pr(3, { body: 'closes #1', createdAt: NOW - 2 * H })] }).stageSince).toBe(NOW - 6 * H);
    expect(one({ issues: [issue(1)], chats: [chat('claude:a', { title: '#1', since: NOW - 9 * H }), chat('claude:b', { title: '#1', since: NOW - 4 * H })] }).stageSince).toBe(NOW - 9 * H);
    expect(one({ issues: [issue(1, { labels: ['agent:ready'], updatedAt: NOW - 2 * D })] }).stageSince).toBe(NOW - 2 * D);
  });
});

describe('history', () => {
  it('marks passed, current and future stages, naming the chats and PRs', () => {
    const t = one({
      issues: [issue(1, { labels: ['agent:ready'] })],
      prs: [pr(2, { body: 'closes #1', createdAt: NOW - H })],
      chats: [chat('claude:a', { title: '#1', name: 'crisp-yodel', since: NOW - 9 * H, state: 'ended' }), chat('claude:b', { title: '#1', name: 'saffron-leopard', since: NOW - 4 * H, state: 'working' })],
    });
    expect(t.history.map((h) => [h.stage, h.done, h.now])).toEqual([
      ['proposed', true, false], ['ready', true, false], ['progress', true, false], ['review', false, true], ['shipping', false, false], ['done', false, false],
    ]);
    expect(t.history[0]).toMatchObject({ at: t.createdAt, detail: 'opened by will' });
    expect(t.history[1].detail).toBe('agent:ready');
    expect(t.history[2]).toMatchObject({ at: NOW - 9 * H, detail: 'crisp-yodel, then saffron-leopard' });
    expect(t.history[3]).toMatchObject({ at: NOW - H, detail: 'PR #2' });
    expect(t.history[4].detail).toBe('merge + deploy');
    expect(t.history[5].detail).toBe('deployed to prod');
  });
});

describe('waiting columns', () => {
  const linked = (over: Partial<BuildInput>) => one({ issues: [issue(1)], me: 'will', ...over });
  const review = (reviewRequests: string[]) => ({ prs: [pr(2, { body: 'closes #1', reviewRequests })], pipeline: () => pipe({ checks: 'pass', review: 'pass', merged: 'waiting' }) });

  it('Needs you: your move, wherever the ticket is in its life', () => {
    expect(linked({ chats: [chat('claude:a', { title: '#1', state: 'your_turn' })] })).toMatchObject({ stage: 'progress', column: 'needsYou', blocked: false });
    expect(linked({ issues: [issue(1, { labels: ['agent:blocked'] })] })).toMatchObject({ column: 'needsYou', blocked: false });
    expect(linked(review([]))).toMatchObject({ stage: 'review', column: 'needsYou' });
    expect(linked(review(['will']))).toMatchObject({ column: 'needsYou', blocked: false });
    // merge-policy asks both maintainers; either can approve, so it is Will's move and not blocked on the other.
    expect(linked(review(['will', 'mike']))).toMatchObject({ column: 'needsYou', blocked: false });
    expect(linked({ prs: [pr(2, { body: 'closes #1', reviewRequests: ['mike', 'will'] })] })).toMatchObject({ column: 'needsYou', blocked: false });
  });

  it('Blocked: a review asked of someone else, a waiting label, or a chat parked on someone', () => {
    expect(linked(review(['mike']))).toMatchObject({ stage: 'review', column: 'blocked', needsYou: false, blockedOn: 'review from mike' });
    for (const l of ['question', 'blocked', 'on-hold', 'waiting', 'waiting-on-agency', 'filing:blocked-data-gap']) {
      expect(linked({ issues: [issue(1, { labels: [l] })], chats: [chat('claude:a', { title: '#1' })] })).toMatchObject({ column: 'blocked', blockedOn: `label ${l}` });
    }
    expect(linked({ chats: [chat('claude:a', { title: '#1', name: 'cozy-donut', state: 'your_turn', waitingOnOthers: true })] }))
      .toMatchObject({ column: 'blocked', needsYou: false, blockedOn: 'cozy-donut waiting on someone' });
  });

  it('ignores bots, agent:blocked, and a chat that has moved on', () => {
    expect(linked({ prs: [pr(2, { body: 'closes #1', reviewRequests: ['claude[bot]', 'copilot'] })] }).blocked).toBe(false);
    expect(linked({ issues: [issue(1, { labels: ['agent:blocked'] })] }).blocked).toBe(false);
    expect(linked({ chats: [chat('claude:a', { title: '#1', state: 'working', waitingOnOthers: true })] })).toMatchObject({ column: 'progress', blocked: false });
    expect(linked({ chats: [chat('claude:a', { title: '#1', state: 'ended', waitingOnOthers: true })] }).blocked).toBe(false);
  });

  it('Needs you beats Blocked, and the note survives the precedence', () => {
    const t = linked({ issues: [issue(1, { labels: ['question'] })], chats: [chat('claude:a', { title: '#1', state: 'your_turn' })] });
    expect(t).toMatchObject({ column: 'needsYou', needsYou: true, blocked: true, blockedOn: 'label question' });
  });

  it('the rails keep their own: Proposed and Done never move to a waiting column', () => {
    expect(linked({ issues: [issue(1, { labels: ['agent:proposed', 'question'] })] })).toMatchObject({ stage: 'proposed', column: 'proposed' });
    expect(linked({ issues: [issue(1, { state: 'closed', closedAt: NOW - H, labels: ['question'] })] })).toMatchObject({ column: 'done' });
  });

  it('reads requested reviewers off the gh row, users and teams', () => {
    expect(toPrRow('o/r', { number: 2, state: 'OPEN', reviewRequests: [{ login: 'mike' }, { name: 'Platform', slug: 'platform' }] })?.reviewRequests).toEqual(['mike', 'platform']);
    expect(toPrRow('o/r', { number: 2, state: 'OPEN', reviewRequests: [] })?.reviewRequests).toBeUndefined();
  });

  it('orders waiting columns ahead of the stages', () => {
    const { tickets } = build({
      me: 'will',
      issues: [issue(1), issue(2, { labels: ['question'] }), issue(3, { labels: ['agent:blocked'] })],
      chats: [chat('claude:a', { title: '#1' }), chat('claude:b', { title: '#2' }), chat('claude:c', { title: '#3' })],
    });
    expect(tickets.map((t) => [t.number, t.column])).toEqual([[3, 'needsYou'], [2, 'blocked'], [1, 'progress']]);
  });
});

describe('orderTickets', () => {
  it('needs-you, then failing, then working, then the rest, longest in stage first; rails newest first', () => {
    // Every open one has a chat, so they share the In progress column.
    const { tickets } = build({
      issues: [
        issue(1), // plain, longest in stage
        issue(2, { labels: ['agent:needs-rerun'] }), // failing
        issue(3, { labels: ['agent:blocked'] }), // needs you
        issue(4), // working
        issue(7), // plain, newer
        issue(5, { labels: ['agent:proposed'], updatedAt: NOW - 2 * D }),
        issue(6, { labels: ['agent:proposed'], updatedAt: NOW - D }),
      ],
      chats: [
        chat('claude:a', { title: '#1', since: NOW - 3 * D }),
        chat('claude:b', { title: '#2', since: NOW - D }),
        chat('claude:c', { title: '#3', since: NOW - H }),
        chat('claude:d', { title: '#4', state: 'working', since: NOW - 2 * D }),
        chat('claude:e', { title: '#7', since: NOW - 2 * D }),
      ],
    });
    const ordered = orderTickets(tickets);
    expect(ordered.filter((t) => t.stage === 'progress').map((t) => t.number)).toEqual([3, 2, 4, 1, 7]);
    expect(ordered.filter((t) => t.stage === 'proposed').map((t) => t.number)).toEqual([6, 5]);
  });
});

describe('store', () => {
  beforeEach(() => _resetTicketStore());
  const rows = (issues: unknown[], prs: unknown[] = []) => async (args: string[]) => {
    if (args[0] === 'api') return 'will\n';
    if (args[0] === 'issue') return JSON.stringify(args.includes('closed') ? [] : issues);
    return JSON.stringify(prs);
  };
  it('is due at boot, keeps the last good result through a gh failure, and reports the error', async () => {
    expect(ticketsDue(0)).toBe(true); // due at boot, before anyone has asked
    markTicketsRequested(1000);
    expect(ticketsDue(1000)).toBe(true);
    const calls: string[][] = [];
    const good = rows([{ number: 1, title: 'a', state: 'OPEN', labels: [{ name: 'agent:ready' }], createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' }]);
    await refreshTickets(['o/r'], async (args) => { calls.push(args); return good(args); }, 1000);
    expect(calls.map((c) => c[0])).toEqual(['api', 'issue', 'issue', 'pr']); // who am I (once), open issues, recently closed issues, PRs
    expect(calls[2]).toContain('--search');
    let s = ticketsSnapshot(1000);
    expect(s.me).toBe('will');
    expect(s.byRepo.get('o/r')?.issues.map((i) => i.number)).toEqual([1]);
    expect(s.error).toBe('');
    // While someone is looking: 60s cadence.
    expect(ticketsDue(30_000)).toBe(false);
    expect(ticketsDue(61_000)).toBe(true);
    await refreshTickets(['o/r'], async () => { throw new Error('rate limited'); }, 61_000);
    s = ticketsSnapshot(61_000);
    expect(s.byRepo.get('o/r')?.issues).toHaveLength(1);
    expect(s.error).toContain('o/r');
    expect(s.fetchedAt).toBe(1000);
    // Nobody has looked for 10 minutes by the next pass: it schedules the slow cadence.
    const later = 1000 + 11 * 60_000;
    await refreshTickets(['o/r'], good, later);
    expect(ticketsDue(later + 2 * 60_000)).toBe(false);
    expect(ticketsDue(later + 10 * 60_000)).toBe(true);
    // Looking again after the quiet spell pulls the next fetch forward.
    markTicketsRequested(later + 3 * 60_000);
    expect(ticketsDue(later + 3 * 60_000)).toBe(true);
  });
  it('says it is refreshing until the first fetch lands, even before anyone looks', async () => {
    expect(ticketsSnapshot(5).refreshing).toBe(true);
    await refreshTickets(['o/r'], rows([]), 5);
    expect(ticketsSnapshot(6).refreshing).toBe(false);
  });
  it('runs the boot fetch at the slow cadence until someone looks', async () => {
    await refreshTickets(['o/r'], rows([]), 1000);
    expect(ticketsDue(1000 + 5 * 60_000)).toBe(false);
    expect(ticketsDue(1000 + 10 * 60_000)).toBe(true);
    // The first look pulls the next fetch forward.
    markTicketsRequested(1000 + 2 * 60_000);
    expect(ticketsDue(1000 + 2 * 60_000)).toBe(true);
  });
});

describe('repoSlug', () => {
  it('parses ssh and https remotes and caches by directory', async () => {
    const calls: string[] = [];
    const git = async (_args: string[], cwd: string) => { calls.push(cwd); return cwd.includes('ssh') ? 'git@github.com:o/r.git\n' : 'https://github.com/o/r2\n'; };
    expect(await repoSlug('/p/ssh', git)).toBe('o/r');
    expect(await repoSlug('/p/https', git)).toBe('o/r2');
    expect(await repoSlug('/p/ssh', git)).toBe('o/r');
    expect(calls).toEqual(['/p/ssh', '/p/https']);
    expect(await repoSlug('/p/none', async () => { throw new Error('not a repo'); })).toBe('');
  });
});
