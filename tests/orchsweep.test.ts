import { describe, expect, it } from 'vitest';
import { openDb } from '../src/db.ts';
import { listItems, needsYouCount, recentLog, upsertItem, type OrchItem } from '../src/orchestrator.ts';
import { SWEEP, draftIdsIn, duplicates, staleWhy, sweepItems, type ChatFact, type SweepFacts } from '../src/orchsweep.ts';
import { sweepFacts, sweepRail } from '../src/orchserver.ts';
import type { ChatView, LiveLoc } from '../src/dashboard.ts';

const H = 3_600_000;
const T0 = 1_700_000_000_000;
const NOW = T0 + 10 * H;

let nextId = 1;
const item = (over: Partial<OrchItem> = {}): OrchItem => ({
  id: nextId++,
  kind: 'needs_you',
  ref_type: 'chat',
  ref_id: 'claude:s1',
  title: 'Approve the thing',
  why: '',
  who: '',
  opened_at: T0,
  updated_at: NOW - H,
  resolved_at: 0,
  resolved_why: '',
  ...over,
});

const chat = (over: Partial<ChatFact> = {}): ChatFact => ({
  onBoard: true,
  closed: false,
  live: true,
  working: false,
  lastTurnAt: NOW - H,
  lastActiveAt: NOW - H,
  ...over,
});

const facts = (over: Partial<SweepFacts> = {}): SweepFacts => ({
  chat: () => null,
  pr: () => null,
  draft: () => null,
  slack: () => null,
  ...over,
});

describe('staleWhy: chats', () => {
  it('keeps an item when Loom has no data on its chat', () => {
    expect(staleWhy(item(), facts(), NOW)).toBe('');
  });

  it('clears an archived or closed chat', () => {
    expect(staleWhy(item(), facts({ chat: () => chat({ onBoard: false }) }), NOW)).toBe('chat archived');
    expect(staleWhy(item(), facts({ chat: () => chat({ closed: true }) }), NOW)).toBe('chat closed');
  });

  it('clears needs-you and moving once the chat has had no pane for the ended window', () => {
    const ended = facts({ chat: () => chat({ live: false, lastActiveAt: NOW - SWEEP.endedMs }) });
    expect(staleWhy(item(), ended, NOW)).toBe('chat ended');
    expect(staleWhy(item({ kind: 'moving' }), ended, NOW)).toBe('chat ended');
    // A pane that closed a minute ago is not "ended" yet.
    expect(staleWhy(item(), facts({ chat: () => chat({ live: false, lastActiveAt: NOW - 60_000 }) }), NOW)).toBe('');
  });

  it('keeps a needs-you item on an ended chat while a draft it quotes is still pending', () => {
    const d = item({ title: 'send d0a0b0c0d0e0f0' });
    expect(staleWhy(d, facts({ chat: () => chat({ live: false, lastActiveAt: NOW - 5 * H }), draft: () => 'pending' }), NOW)).toBe('');
  });

  it('keeps a blocked item on an ended chat: it waits on someone else, not the pane', () => {
    expect(staleWhy(item({ kind: 'blocked' }), facts({ chat: () => chat({ live: false, lastActiveAt: NOW - 5 * H }) }), NOW)).toBe('');
  });

  it('clears needs-you once the chat is working again after the item, past the grace', () => {
    const it0 = item({ updated_at: NOW - H });
    expect(staleWhy(it0, facts({ chat: () => chat({ working: true, lastTurnAt: NOW - H + SWEEP.resumeGraceMs + 1 }) }), NOW)).toBe('chat picked back up');
    expect(staleWhy(it0, facts({ chat: () => chat({ working: true, lastTurnAt: NOW - H + 1000 }) }), NOW)).toBe('');
    // Idle with a newer turn is the chat asking again: keep it.
    expect(staleWhy(it0, facts({ chat: () => chat({ working: false, lastTurnAt: NOW }) }), NOW)).toBe('');
  });
});

describe('staleWhy: PRs, Slack, drafts', () => {
  const prItem = (over: Partial<OrchItem> = {}) => item({ ref_type: 'pr', ref_id: 'https://github.com/o/r/pull/7', ...over });

  it('clears a closed PR, and a merged one once its deploy landed', () => {
    expect(staleWhy(prItem(), facts({ pr: () => ({ state: 'closed', deploy: 'skipped' }) }), NOW)).toBe('PR closed');
    expect(staleWhy(prItem({ kind: 'blocked' }), facts({ pr: () => ({ state: 'merged', deploy: 'pass' }) }), NOW)).toBe('PR merged');
    expect(staleWhy(prItem(), facts({ pr: () => ({ state: 'merged', deploy: 'waiting' }) }), NOW)).toBe('PR merged');
  });

  it('keeps a merged PR whose deploy is red or still running', () => {
    expect(staleWhy(prItem(), facts({ pr: () => ({ state: 'merged', deploy: 'fail' }) }), NOW)).toBe('');
    expect(staleWhy(prItem({ kind: 'moving' }), facts({ pr: () => ({ state: 'merged', deploy: 'running' }) }), NOW)).toBe('');
    expect(staleWhy(prItem({ kind: 'blocked' }), facts({ pr: () => ({ state: 'merged', deploy: 'waiting' }) }), NOW)).toBe('');
    expect(staleWhy(prItem(), facts({ pr: () => ({ state: 'open', deploy: 'waiting' }) }), NOW)).toBe('');
  });

  it('clears a Slack item once its thread is done', () => {
    const s = item({ ref_type: 'slack', ref_id: 'https://x.slack.com/archives/C1/p1' });
    expect(staleWhy(s, facts({ slack: () => 'done' }), NOW)).toBe('Slack thread done');
    expect(staleWhy(s, facts({ slack: () => 'looking' }), NOW)).toBe('');
  });

  it('finds draft ids in the text', () => {
    expect(draftIdsIn('press Send on d0a0b0c0d0e0f0, or d0f0e0d0c0b0 and d0f0e0d0c0b0')).toEqual(['d0a0b0c0d0e0f0', 'd0f0e0d0c0b0']);
    expect(draftIdsIn('deadbeef d12 #4207')).toEqual([]);
  });

  it('clears a needs-you item once every draft it quotes is sent or discarded', () => {
    const d = item({ ref_type: '', ref_id: '', title: 'press Send on d0a0b0c0d0e0f0', why: 'and d0f0e0d0c0b0' });
    const st: Record<string, string> = { d0a0b0c0d0e0f0: 'sent', d0f0e0d0c0b0: 'discarded' };
    expect(staleWhy(d, facts({ draft: (id) => st[id] ?? null }), NOW)).toBe('draft sent');
    expect(staleWhy(d, facts({ draft: () => 'discarded' }), NOW)).toBe('draft discarded');
    st.d0f0e0d0c0b0 = 'pending';
    expect(staleWhy(d, facts({ draft: (id) => st[id] ?? null }), NOW)).toBe('');
    // Ids the outbox has never heard of are ignored.
    expect(staleWhy(d, facts({ draft: () => null }), NOW)).toBe('');
  });
});

describe('staleWhy: the age cap', () => {
  const old = (kind: OrchItem['kind'], ms: number) => item({ kind, ref_type: '', ref_id: '', updated_at: NOW - ms });

  it('expires each kind after its window', () => {
    expect(staleWhy(old('needs_you', SWEEP.needsYouMaxMs - 1), facts(), NOW)).toBe('');
    expect(staleWhy(old('needs_you', SWEEP.needsYouMaxMs), facts(), NOW)).toBe('no update in 3 days');
    expect(staleWhy(old('blocked', SWEEP.needsYouMaxMs), facts(), NOW)).toBe('');
    expect(staleWhy(old('blocked', SWEEP.blockedMaxMs), facts(), NOW)).toBe('no update in 7 days');
    expect(staleWhy(old('moving', SWEEP.movingMaxMs), facts(), NOW)).toBe('no update in 24 h');
  });

  it('keeps an old item something still vouches for', () => {
    const waiting = item({ updated_at: NOW - 5 * 24 * H });
    expect(staleWhy(waiting, facts({ chat: () => chat({ live: true, working: false, lastTurnAt: NOW - 5 * 24 * H, lastActiveAt: NOW - 5 * 24 * H }) }), NOW)).toBe('');
    const draft = item({ ref_type: '', ref_id: '', title: 'send d0a0b0c0d0e0f0', updated_at: NOW - 5 * 24 * H });
    expect(staleWhy(draft, facts({ draft: () => 'pending' }), NOW)).toBe('');
    const moving = item({ kind: 'moving', updated_at: NOW - 3 * 24 * H });
    expect(staleWhy(moving, facts({ chat: () => chat({ working: true, lastTurnAt: NOW - 3 * 24 * H }) }), NOW)).toBe('');
  });

  it('never touches resolved or done items', () => {
    expect(staleWhy(item({ resolved_at: NOW, updated_at: 0 }), facts(), NOW)).toBe('');
    expect(staleWhy(item({ kind: 'done', updated_at: 0 }), facts(), NOW)).toBe('');
  });
});

describe('duplicates + sweepItems', () => {
  it('keeps the newest of the same ref or the same title', () => {
    const a = item({ id: 101, ref_id: 'claude:a', title: 'Send the vendor the reply', updated_at: NOW - 3 * H });
    const b = item({ id: 102, ref_id: 'claude:b', title: 'send the vendor the reply!', updated_at: NOW - H });
    const c = item({ id: 103, ref_id: 'claude:b', title: 'Other', updated_at: NOW - 2 * H });
    const d = item({ id: 104, ref_type: '', ref_id: '', title: 'Unrelated' });
    const dup = duplicates([a, b, c, d]);
    expect([...dup.entries()].sort()).toEqual([[101, 102], [103, 102]]);
  });

  it('reports each cleared item with its reason, duplicates first', () => {
    const a = item({ id: 201, title: 'Same', updated_at: NOW - 2 * H, ref_type: '', ref_id: '' });
    const b = item({ id: 202, title: 'Same', updated_at: NOW - H, ref_type: '', ref_id: '' });
    const c = item({ id: 203, ref_id: 'claude:gone', title: 'Gone' });
    const out = sweepItems([a, b, c], facts({ chat: (r) => (r === 'claude:gone' ? chat({ onBoard: false }) : null) }), NOW);
    expect(out).toEqual([
      { id: 201, title: 'Same', why: 'duplicate of #202' },
      { id: 203, title: 'Gone', why: 'chat archived' },
    ]);
  });
});

describe('sweepRail + sweepFacts (db)', () => {
  const view = (sid: string, over: Partial<ChatView> = {}): ChatView =>
    ({ agent: 'claude', session_id: sid, last_turn_at: NOW - H, last_active_at: NOW - H, ...over }) as ChatView;
  const live = (sid: string, working = false): LiveLoc => ({ agent: 'claude', session_id: sid, pane_id: '%1', tmux_session: 'x', window_index: '1', pane_index: '0', running: true, working });

  it('resolves stale items with a reason, drops them from the count and logs one line', () => {
    const db = openDb(':memory:');
    upsertItem(db, { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:closed', title: 'Closed one' }, NOW - H);
    upsertItem(db, { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:waiting', title: 'Still waiting' }, NOW - H);
    upsertItem(db, { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:archived', title: 'Archived one' }, NOW - H);
    upsertItem(db, { kind: 'needs_you', title: 'press Send on d0a0b0c0d0e0f0' }, NOW - H);
    const snap = { views: [view('closed', { done: true }), view('waiting')], live: { 'claude:waiting': live('waiting') } };
    const f = sweepFacts(snap, db, () => ({ d0a0b0c0d0e0f0: { status: 'sent' } }), NOW);
    const cleared = sweepRail(db, f, NOW);
    expect(cleared.map((c) => c.why).sort()).toEqual(['chat archived', 'chat closed', 'draft sent']);
    expect(needsYouCount(db)).toBe(1);
    const all = listItems(db, 1);
    expect(all.find((i) => i.title === 'Closed one')?.resolved_why).toBe('chat closed');
    const log = recentLog(db, 0);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe('cleared');
    expect(log[0].target).toBe('3 items');
    // A second pass finds nothing new.
    expect(sweepRail(db, f, NOW + 60_000)).toEqual([]);
  });

  it('clears nothing on chats before the board has indexed', () => {
    const db = openDb(':memory:');
    upsertItem(db, { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:x', title: 'X' }, NOW - H);
    expect(sweepRail(db, sweepFacts({ views: [], live: {} }, db, () => ({}), NOW), NOW)).toEqual([]);
  });

  it('a re-raised item reopens clean', () => {
    const db = openDb(':memory:');
    const a = upsertItem(db, { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:gone', title: 'Gone' }, NOW - H).item;
    sweepRail(db, sweepFacts({ views: [view('other')], live: {} }, db, () => ({}), NOW), NOW);
    const b = upsertItem(db, { id: a.id, kind: 'needs_you', title: 'Gone' }, NOW + 1).item;
    expect(b.resolved_at).toBe(0);
    expect(b.resolved_why).toBe('');
  });
});
