import { describe, expect, it, vi } from 'vitest';
import { openDb } from '../src/db.ts';
import {
  DEFAULT_BATCH,
  EVENTS_PREFIX,
  EventBatcher,
  OUTBOX_TTL_MS,
  RELAY_PREFIX,
  SILENT_MS,
  deliverQueued,
  detectEvents,
  formatEventBatch,
  listItems,
  needsYouCount,
  newObsState,
  notifyNeedsYou,
  orchSettings,
  queuedRelays,
  recentLog,
  relayToChat,
  resolveItem,
  setOrchNotifier,
  upsertItem,
  type ChatObs,
  type OrchEvent,
  type RelayDeps,
} from '../src/orchestrator.ts';

const T0 = 1_700_000_000_000;

describe('orchestrator items', () => {
  it('creates, then updates the one open item per ref in place', () => {
    const db = openDb(':memory:');
    const a = upsertItem(db, { kind: 'moving', ref_type: 'chat', ref_id: 'claude:s1', title: 'R03 retry', why: 'tests green', who: 'blue-vanilla' }, T0);
    expect(a.created).toBe(true);
    expect(a.becameNeedsYou).toBe(false);
    const b = upsertItem(db, { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:s1', title: 'R03 retry', why: 'asks which bank' }, T0 + 1000);
    expect(b.created).toBe(false);
    expect(b.item.id).toBe(a.item.id);
    expect(b.becameNeedsYou).toBe(true);
    expect(b.item).toMatchObject({ kind: 'needs_you', why: 'asks which bank', opened_at: T0, updated_at: T0 + 1000 });
    // Still needs you: an update, not a new notification.
    expect(upsertItem(db, { kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:s1', title: 'R03 retry', why: 'still asking' }, T0 + 2000).becameNeedsYou).toBe(false);
    expect(listItems(db)).toHaveLength(1);
    expect(needsYouCount(db)).toBe(1);
    db.close();
  });

  it('keeps items for different refs apart and lets an item without a ref stand alone', () => {
    const db = openDb(':memory:');
    upsertItem(db, { kind: 'blocked', ref_type: 'pr', ref_id: 'https://github.com/o/r/pull/1', title: 'PR 1', who: 'CI' }, T0);
    upsertItem(db, { kind: 'blocked', ref_type: 'pr', ref_id: 'https://github.com/o/r/pull/2', title: 'PR 2', who: 'Alex' }, T0);
    upsertItem(db, { kind: 'needs_you', title: 'Approve the budget' }, T0);
    upsertItem(db, { kind: 'needs_you', title: 'Approve the budget' }, T0);
    expect(listItems(db)).toHaveLength(4);
    expect(needsYouCount(db)).toBe(2);
    db.close();
  });

  it("resolves an item written as 'done' into Done today, and resolveItem closes one without changing its kind", () => {
    const db = openDb(':memory:');
    const m = upsertItem(db, { kind: 'moving', ref_type: 'chat', ref_id: 'claude:s1', title: 'help center' }, T0).item;
    const d = upsertItem(db, { kind: 'done', ref_type: 'chat', ref_id: 'claude:s1', title: 'help center merged' }, T0 + 5).item;
    expect(d.id).toBe(m.id);
    expect(d.resolved_at).toBe(T0 + 5);
    const n = upsertItem(db, { kind: 'needs_you', ref_type: 'slack', ref_id: 'https://x.slack.com/archives/C1/p1', title: 'WV SIT' }, T0).item;
    expect(resolveItem(db, n.id, T0 + 9)).toMatchObject({ kind: 'needs_you', resolved_at: T0 + 9 });
    expect(resolveItem(db, n.id, T0 + 10)).toBeNull(); // already closed
    expect(listItems(db)).toHaveLength(0);
    expect(listItems(db, T0).map((i) => i.kind).sort()).toEqual(['done', 'needs_you']);
    expect(needsYouCount(db)).toBe(0);
    // A ref whose item was resolved gets a fresh row next time.
    expect(upsertItem(db, { kind: 'moving', ref_type: 'chat', ref_id: 'claude:s1', title: 'again' }, T0 + 20).created).toBe(true);
    db.close();
  });

  it('updates by id, and refuses an id that does not exist', () => {
    const db = openDb(':memory:');
    const a = upsertItem(db, { kind: 'blocked', title: 'NE 501N', who: 'Alex' }, T0).item;
    expect(upsertItem(db, { id: a.id, kind: 'needs_you', title: '' }, T0 + 1)).toMatchObject({ created: false, becameNeedsYou: true, item: { title: 'NE 501N' } });
    expect(() => upsertItem(db, { id: 999, kind: 'done', title: 'x' }, T0)).toThrow('no item 999');
    db.close();
  });

  it('notifies for a new needs_you item unless notifications are off', () => {
    const db = openDb(':memory:');
    const seen = vi.fn();
    setOrchNotifier(seen);
    const item = upsertItem(db, { kind: 'needs_you', title: 'x' }, T0).item;
    expect(notifyNeedsYou(db, item)).toBe(true);
    orchSettings.setNotify(db, 'off');
    expect(notifyNeedsYou(db, item)).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1);
    setOrchNotifier(() => {});
    db.close();
  });
});

describe('relays and the focused-pane guard', () => {
  const setup = (focused: string | null) => {
    const db = openDb(':memory:');
    const state = { focused, live: true };
    const send = vi.fn(() => ({ ok: true, detail: 'sent' }));
    let now = T0;
    const deps: RelayDeps = {
      focused: () => state.focused,
      resolve: (agent, sid) => (state.live ? { agent, session_id: sid, pane_id: '%7', label: 'cozy-donut' } : null),
      send,
      now: () => now,
    };
    return { db, state, send, deps, tick: (ms: number) => { now += ms; } };
  };

  it('sends straight away when the user is elsewhere, and logs the relay', () => {
    const { db, send, deps } = setup('%3');
    expect(relayToChat(db, deps, 'claude', 's1', 'keep them per company')).toEqual({ status: 'sent', detail: 'sent to cozy-donut' });
    expect(send).toHaveBeenCalledWith('%7', `${RELAY_PREFIX} keep them per company`, 'claude');
    expect(recentLog(db, 0)).toMatchObject([{ kind: 'relay', target: 'cozy-donut', text: 'keep them per company' }]);
    db.close();
  });

  it('refuses to type into the focused pane: queues, then delivers once focus leaves', () => {
    const { db, state, send, deps, tick } = setup('%7');
    const r = relayToChat(db, deps, 'claude', 's1', 'file per company');
    expect(r.status).toBe('queued');
    expect(send).not.toHaveBeenCalled();
    expect(queuedRelays(db)).toHaveLength(1);
    // Still looking at it: nothing goes out.
    tick(15_000);
    expect(deliverQueued(db, deps)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    // Focus leaves: delivered exactly once.
    state.focused = '%3';
    expect(deliverQueued(db, deps)).toBe(1);
    expect(deliverQueued(db, deps)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('%7', `${RELAY_PREFIX} file per company`, 'claude');
    expect(recentLog(db, 0).map((l) => l.kind)).toEqual(['queued', 'delivered']);
    db.close();
  });

  it('fails a relay to a chat that is not running, and drops a queued one whose chat stopped or went stale', () => {
    const { db, state, send, deps, tick } = setup('%7');
    state.live = false;
    expect(relayToChat(db, deps, 'claude', 's1', 'x').status).toBe('failed');
    state.live = true;
    relayToChat(db, deps, 'claude', 's1', 'one');
    state.live = false;
    state.focused = null;
    deliverQueued(db, deps);
    expect(queuedRelays(db)).toHaveLength(0);
    state.live = true;
    state.focused = '%7';
    relayToChat(db, deps, 'claude', 's1', 'two');
    state.focused = null;
    tick(OUTBOX_TTL_MS + 1);
    expect(deliverQueued(db, deps)).toBe(0);
    expect(send).not.toHaveBeenCalled();
    db.close();
  });

  it('refuses an empty message', () => {
    const { db, deps } = setup(null);
    expect(relayToChat(db, deps, 'claude', 's1', '   ').status).toBe('failed');
    db.close();
  });
});

describe('event detection', () => {
  const chat = (over: Partial<ChatObs> = {}): ChatObs => ({
    key: 'claude:s1', title: 'R03 retry', name: 'blue-vanilla', project: 'acme-app', live: true, working: true, lastWriteAt: T0, ...over,
  });

  it('records the first sighting without an event, then reports a finished turn', () => {
    const st = newObsState();
    expect(detectEvents(st, [chat()], T0).events).toEqual([]);
    const { events } = detectEvents(st, [chat({ working: false })], T0 + 15_000);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: 'your_turn', key: 'your_turn:claude:s1', chat: 'claude:s1' });
    expect(events[0].text).toContain('blue-vanilla');
  });

  it('cancels a pending your-turn when the chat goes back to work', () => {
    const st = newObsState();
    detectEvents(st, [chat()], T0);
    detectEvents(st, [chat({ working: false })], T0 + 1);
    expect(detectEvents(st, [chat({ working: true })], T0 + 2).cancel).toEqual(['your_turn:claude:s1']);
  });

  it('a chat that stops running is not "your turn"', () => {
    const st = newObsState();
    detectEvents(st, [chat()], T0);
    expect(detectEvents(st, [chat({ live: false, working: false })], T0 + 1).events).toEqual([]);
  });

  it('reports a chat silent mid-turn once per stretch, and again after it writes and goes quiet again', () => {
    const st = newObsState();
    detectEvents(st, [chat({ lastWriteAt: T0 })], T0);
    expect(detectEvents(st, [chat({ lastWriteAt: T0 })], T0 + SILENT_MS - 1).events).toEqual([]);
    const fired = detectEvents(st, [chat({ lastWriteAt: T0 })], T0 + SILENT_MS).events;
    expect(fired.map((e) => e.kind)).toEqual(['silent']);
    expect(detectEvents(st, [chat({ lastWriteAt: T0 })], T0 + SILENT_MS + 60_000).events).toEqual([]);
    const later = T0 + SILENT_MS + 120_000;
    detectEvents(st, [chat({ lastWriteAt: later })], later);
    expect(detectEvents(st, [chat({ lastWriteAt: later })], later + SILENT_MS).events.map((e) => e.kind)).toEqual(['silent']);
  });

  it('reports PR checks going red or green and a review landing, never on the first sighting', () => {
    const st = newObsState();
    const pr = (checks: string, review: string) => chat({ working: false, pr: { ref: 'o/r#4231', checks, review } });
    expect(detectEvents(st, [pr('fail', 'waiting')], T0).events).toEqual([]);
    expect(detectEvents(st, [pr('running', 'waiting')], T0 + 1).events).toEqual([]);
    const ev = detectEvents(st, [pr('pass', 'pass')], T0 + 2).events;
    expect(ev.map((e) => e.kind)).toEqual(['pr_checks', 'pr_review']);
    expect(ev[0].text).toContain('went green');
    expect(ev[1].text).toContain('approved');
    expect(detectEvents(st, [pr('fail', 'fail')], T0 + 3).events.map((e) => e.text)).toEqual([
      expect.stringContaining('went red'),
      expect.stringContaining('changes requested'),
    ]);
  });

  it('forgets chats that disappeared', () => {
    const st = newObsState();
    detectEvents(st, [chat()], T0);
    detectEvents(st, [], T0 + 1);
    expect(st.chats.size).toBe(0);
    expect(detectEvents(st, [chat({ working: false })], T0 + 2).events).toEqual([]);
  });
});

describe('event batching', () => {
  const ev = (key: string, at = T0): OrchEvent => ({ key, kind: 'your_turn', chat: key, text: key, at });

  it('waits for the quiet window, folds repeats of a key into one line, and drains on take', () => {
    const b = new EventBatcher({ quietMs: 20_000, maxWaitMs: 90_000, maxPending: 40 });
    expect(b.due(T0)).toBe(false);
    b.add(ev('a'), T0);
    b.add(ev('b'), T0 + 5_000);
    b.add(ev('a'), T0 + 10_000);
    expect(b.size()).toBe(2);
    expect(b.due(T0 + 29_999)).toBe(false);
    expect(b.due(T0 + 30_000)).toBe(true);
    expect(b.take().map((e) => e.key)).toEqual(['b', 'a']);
    expect(b.size()).toBe(0);
  });

  it('flushes at the max wait even when events keep arriving', () => {
    const b = new EventBatcher({ quietMs: 20_000, maxWaitMs: 60_000, maxPending: 40 });
    for (let t = 0; t <= 60_000; t += 10_000) b.add(ev('k' + t), T0 + t);
    expect(b.due(T0 + 60_000)).toBe(true);
  });

  it('drops a cancelled event and caps what it holds', () => {
    const b = new EventBatcher({ ...DEFAULT_BATCH, maxPending: 2 });
    b.add(ev('a'), T0);
    b.cancel('a');
    expect(b.size()).toBe(0);
    for (const k of ['x', 'y', 'z']) b.add(ev(k), T0);
    expect(b.take().map((e) => e.key)).toEqual(['y', 'z']);
  });

  it('formats one line for the orchestrator', () => {
    const text = formatEventBatch([ev('one'), ev('two')], T0);
    expect(text.startsWith(EVENTS_PREFIX)).toBe(true);
    expect(text).toContain('2 changes: (1) one (2) two');
    expect(text).not.toContain('\n');
  });
});
