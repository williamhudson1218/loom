import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { addStep, chatFlags, getStep, setCloseWhenDone } from '../src/actions.ts';
import { markChatDone } from '../src/parked.ts';
import { _resetPipelineStore, pipelineHealth, tickPipelines } from '../src/pipeline.ts';
import { _resetReplies, actionFacts, actionTick, scheduledDraftIds, scheduledDrafts, sendInFlight } from '../src/actionserver.ts';
import type { Snap } from '../src/orchserver.ts';

const seed = () => {
  const db = new Database(':memory:');
  applySchema(db);
  addStep(db, { id: 'a00000000001', session_id: 's1', title: 'T', when: 'now', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
  return db;
};
const rest = { replies: () => 'pending' as const, answers: () => 'pending' as const, preSend: () => ({ decision: 'pending' as const }), redraftMark: () => undefined, sendInFlight: () => false, slackOff: () => '' };
const ioFor = (db: Database.Database) => ({ facts: () => ({ ...rest, pr: () => null, draft: () => null }), withDb: <T,>(fn: (d: Database.Database) => T) => fn(db) });
const logs = (db: Database.Database) => db.prepare(`SELECT kind, target FROM orchestrator_log`).all();

describe('actionTick', () => {
  it('finishes a now/none step with one action log row, and a second tick adds nothing', async () => {
    const db = seed();
    await actionTick({ views: [], live: {} }, 1000, ioFor(db));
    expect(getStep(db, 'a00000000001')?.status).toBe('done');
    expect(logs(db)).toEqual([{ kind: 'action', target: 's1' }]);
    await actionTick({ views: [], live: {} }, 2000, ioFor(db));
    expect(logs(db)).toHaveLength(1);
  });

  it('a tick that starts while another is mid-chain does nothing', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a00000000001', session_id: 's1', title: 'T', when: 'draft-sent:d0123456789ab', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
    const snap = { views: [], live: {} };
    let inner: Promise<void> | null = null;
    const io = {
      withDb: <T,>(fn: (d: Database.Database) => T) => fn(db),
      // Re-enter once while the outer tick is evaluating the step, before it has applied anything.
      facts: () => ({
        ...rest,
        pr: () => null,
        draft: () => {
          inner ??= actionTick(snap, 1000, io);
          return { status: 'sent', kind: 'slack' as const, revised_at: '' };
        },
      }),
    };
    await actionTick(snap, 1000, io);
    await inner;
    expect(logs(db)).toHaveLength(1);
  });

  it('one chain throwing does not stop the chains after it', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a00000000001', session_id: 's1', title: 'T', when: 'draft-sent:d0123456789ab', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
    addStep(db, { id: 'a00000000002', session_id: 's2', title: 'T', when: 'now', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await actionTick({ views: [], live: {} }, 1000, {
      withDb: (fn) => fn(db),
      facts: () => ({ ...rest, pr: () => null, draft: () => { throw new Error('boom'); } }),
    });
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
    expect(getStep(db, 'a00000000001')?.status).toBe('waiting');
    expect(getStep(db, 'a00000000002')?.status).toBe('done');
  });
});

describe('actionFacts', () => {
  beforeEach(() => _resetPipelineStore());
  const snap = { views: [], live: {} };

  it('registers PR interest on every call', () => {
    const f = actionFacts(snap, 1000);
    expect(pipelineHealth('acme/app', 7)).toBeNull();
    expect(f.pr('acme/app', 7)).toBeNull();
    expect(pipelineHealth('acme/app', 7)).toEqual({ errors: 0, lastError: '' });
  });

  it('returns the fetch error when the PR has failed and nothing is cached', async () => {
    actionFacts(snap, 0).pr('acme/app', 7);
    await tickPipelines(new Set(), async () => { throw new Error('HTTP 404'); }, 0);
    expect(actionFacts(snap, 1000).pr('acme/app', 7)).toEqual({ error: 'HTTP 404' });
  });
});

describe('actionFacts: replies', () => {
  const snap = { views: [], live: {} };
  const TH = { thread_url: 'https://acme.slack.com/archives/C0123456789/p1700000000000100', channel: 'C0123456789', thread_ts: '1700000000.000100' };
  const mkStep = (id: string) => ({ id, current_at: 1_700_000_500_000, trigger_params: TH }) as never;
  const step = mkStep('a00000000077');
  const reply = { id: 'slack:1700000600.000200', kind: 'slack' as const, author: 'the reviewer', at: 1_700_000_600_000, snippet: 'ok' };

  it('off when Slack is off, and the thread is never read', () => {
    const targets: unknown[] = [];
    const f = actionFacts(snap, 1, { slackOff: () => 'off', fresh: async (t) => (targets.push(t), { ok: true, items: [] }) });
    expect(f.replies(step)).toBe('off');
    expect(targets).toHaveLength(0);
  });
  it('reads pending first, never blocking, then the result; the baseline is the step current_at', async () => {
    _resetReplies();
    const targets: Record<string, unknown>[] = [];
    const fresh = async (t: Record<string, unknown>) => (targets.push(t), { ok: true as const, items: [reply] });
    const f = actionFacts(snap, 1, { slackOff: () => '', fresh: fresh as never });
    expect(f.replies(step)).toBe('pending');
    await new Promise((r) => setTimeout(r, 0));
    expect(actionFacts(snap, 2, { slackOff: () => '', fresh: fresh as never }).replies(step)).toEqual({ items: [reply] });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ channel: 'C0123456789', thread_ts: '1700000000.000100', seen: { at: 1_700_000_500_000, slack: '1700000500.000000' } });
  });
  it('a failing read is an error result, not a fire', async () => {
    const step = mkStep('a00000000078');
    const fresh = async () => ({ ok: false as const, error: 'HTTP 500', items: [reply] });
    actionFacts(snap, 1, { slackOff: () => '', fresh: fresh as never }).replies(step);
    await new Promise((r) => setTimeout(r, 0));
    expect(actionFacts(snap, 2, { slackOff: () => '', fresh: fresh as never }).replies(step)).toEqual({ error: 'HTTP 500' });
  });
});

describe('actionTick: slack_reply behind another step', () => {
  const TH = 'https://acme.slack.com/archives/C0123456789/p1700000000000100';
  it('does not count a reply posted before the step became current, and fires on one after', async () => {
    _resetReplies();
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a0000000000a', session_id: 's1', title: 'A', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 100 });
    addStep(db, { id: 'a0000000000b', session_id: 's1', title: 'B', when: `slack-reply:${TH}`, then: 'none', ask_first: false, created_by: 'chat', at: 100 });
    expect(getStep(db, 'a0000000000b')?.current_at).toBe(0);
    const msgs = [{ id: 'slack:1.500000', ts: 1.5 }];
    const fresh = async (t: { seen?: { slack?: string } }) => ({
      ok: true as const,
      items: msgs.filter((m) => m.ts > Number(t.seen?.slack)).map((m) => ({ id: m.id, kind: 'slack' as const, author: 'the reviewer', at: m.ts * 1000, snippet: 'ok' })),
    });
    const io = { withDb: <T,>(fn: (d: Database.Database) => T) => fn(db), facts: (s: Snap, n: number) => actionFacts(s, n, { fresh: fresh as never, slackOff: () => '' }) };
    const snap = { views: [], live: {} };
    const tick = async (at: number) => {
      await actionTick(snap, at, io);
      await new Promise((r) => setTimeout(r, 0));
    };
    await tick(1000); // A is current; the reply at 1.5 s lands while A is open
    expect(getStep(db, 'a0000000000b')?.current_at).toBe(0);
    db.prepare(`UPDATE action_items SET status = 'done' WHERE id = 'a0000000000a'`).run();
    await tick(2000); // B becomes current at 2 s
    await tick(2000 + 61_000);
    await tick(2000 + 122_000);
    expect(getStep(db, 'a0000000000b')?.current_at).toBe(2000);
    expect(getStep(db, 'a0000000000b')?.status).toBe('waiting');
    expect(getStep(db, 'a0000000000b')?.status_why).toBe('waiting for a reply');
    msgs.push({ id: 'slack:3.000000', ts: 3 });
    await tick(2000 + 183_000);
    await tick(2000 + 184_000);
    expect(getStep(db, 'a0000000000b')?.status).toBe('done');
  });
  it('clears the stamp an older row carries on a step that is not current', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a0000000000a', session_id: 's1', title: 'A', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 100 });
    addStep(db, { id: 'a0000000000b', session_id: 's1', title: 'B', when: `slack-reply:${TH}`, then: 'none', ask_first: false, created_by: 'chat', at: 100 });
    db.prepare(`UPDATE action_items SET current_at = 100 WHERE id = 'a0000000000b'`).run();
    await actionTick({ views: [], live: {} }, 1000, { withDb: <T,>(fn: (d: Database.Database) => T) => fn(db) });
    expect(getStep(db, 'a0000000000b')?.current_at).toBe(0);
  });
});

describe('actionTick: send_draft effects', () => {
  const DID = 'd0123456789ab';
  const SID = 'a00000000009';
  const snap = { views: [], live: {} };
  const mk = (then = `send-draft:${DID}`) => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: SID, session_id: 's1', title: 'Send the update', when: 'now', then, ask_first: false, created_by: 'chat', at: 1 });
    return db;
  };
  const baseFacts = (over: Record<string, unknown> = {}) => ({
    pr: () => null,
    draft: () => ({ status: 'pending', kind: 'slack' as const, revised_at: 'R1' }),
    preSend: () => ({ decision: 'send' as const, ack: ['slack:1.2'] }),
    redraftMark: () => undefined,
    sendInFlight,
    slackOff: () => '',
    replies: () => 'pending' as const,
    answers: () => 'pending' as const,
    ...over,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('sends once with the ack and the checked revision, then marks the step done', async () => {
    const db = mk();
    const sends: unknown[][] = [];
    let release!: (r: { ok: boolean; detail: string }) => void;
    const io = {
      withDb: <T,>(fn: (d: Database.Database) => T) => fn(db),
      facts: () => baseFacts(),
      send: (...a: unknown[]) => (sends.push(a), new Promise<{ ok: boolean; detail: string }>((r) => { release = r; })),
    };
    await actionTick(snap, 1000, io);
    expect(getStep(db, SID)?.status).toBe('running');
    // A tick while the send is out: still running, no second send.
    await actionTick(snap, 2000, io);
    expect(getStep(db, SID)?.status).toBe('running');
    expect(sends).toEqual([[DID, ['slack:1.2'], 'R1']]);
    release({ ok: true, detail: 'sent' });
    await flush();
    expect(getStep(db, SID)).toMatchObject({ status: 'done', status_why: 'sent' });
    expect(sendInFlight(SID)).toBe(false);
  });

  it('a refused send holds the step with the outbox reason, pinned to the checked revision', async () => {
    const db = mk();
    await actionTick(snap, 1000, {
      withDb: (fn) => fn(db),
      facts: () => baseFacts(),
      send: async () => ({ ok: false, detail: '1 new message since this was drafted. Nothing was sent.' }),
    });
    await flush();
    expect(getStep(db, SID)).toMatchObject({ status: 'held', status_why: 'held: 1 new message since this was drafted. Nothing was sent.', held_rev: 'R1' });
  });

  it('a send that throws holds; no send wired holds; nothing is retried by the next tick', async () => {
    const db = mk();
    let n = 0;
    const io = { withDb: <T,>(fn: (d: Database.Database) => T) => fn(db), facts: () => baseFacts(), send: async () => { n++; throw new Error('socket hang up'); } };
    await actionTick(snap, 1000, io);
    await flush();
    expect(getStep(db, SID)).toMatchObject({ status: 'held', status_why: 'held: send failed: socket hang up' });
    await actionTick(snap, 2000, io);
    await flush();
    expect(n).toBe(1);
    const db2 = mk();
    await actionTick(snap, 1000, { withDb: (fn) => fn(db2), facts: () => baseFacts() });
    await flush();
    expect(getStep(db2, SID)?.status).toBe('held');
  });

  it('after a restart mid-send (running, nothing in flight) the step fails and nothing is sent', async () => {
    const db = mk();
    db.prepare(`UPDATE action_items SET status = 'running' WHERE id = ?`).run(SID);
    let n = 0;
    await actionTick(snap, 1000, { withDb: (fn) => fn(db), facts: () => baseFacts(), send: async () => (n++, { ok: true, detail: '' }) });
    await flush();
    expect(getStep(db, SID)).toMatchObject({ status: 'failed', status_why: 'Loom restarted mid-send; Retry checks Slack first' });
    expect(n).toBe(0);
  });

  it('a null draft fact never sends', async () => {
    const db = mk();
    let n = 0;
    await actionTick(snap, 1000, { withDb: (fn) => fn(db), facts: () => baseFacts({ draft: () => null }), send: async () => (n++, { ok: true, detail: '' }) });
    await flush();
    expect(n).toBe(0);
    expect(getStep(db, SID)?.status).toBe('waiting');
  });

  it('a hold asks for a redraft; a failed redraft keeps the step held with the reason added', async () => {
    const db = mk();
    const asked: string[] = [];
    await actionTick(snap, 1000, {
      withDb: (fn) => fn(db),
      facts: () => baseFacts({ preSend: () => ({ decision: 'hold', why: 'wait for #130' }) }),
      send: async () => { throw new Error('must not send'); },
      redraft: async (id: string) => (asked.push(id), { ok: false, detail: 'the chat is not running' }),
    });
    await flush();
    expect(asked).toEqual([DID]);
    expect(getStep(db, SID)).toMatchObject({ status: 'held', status_why: 'held: wait for #130; redraft failed: the chat is not running', held_rev: 'R1' });
  });
});

describe('actionTick: a refused send_kept', () => {
  it('stays held across ticks and never re-sends on the same mark', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a00000000010', session_id: 's1', title: 'Send', when: 'now', then: 'send-draft:d0123456789ab', ask_first: false, created_by: 'chat', at: 1 });
    db.prepare(`UPDATE action_items SET status = 'held', held_rev = 'R1', held_at = 100 WHERE id = 'a00000000010'`).run();
    let sends = 0;
    const io = {
      withDb: <T,>(fn: (d: Database.Database) => T) => fn(db),
      facts: () => ({
        pr: () => null,
        draft: () => ({ status: 'pending', kind: 'slack' as const, revised_at: 'R1' }),
        preSend: () => ({ decision: 'pending' as const }),
        redraftMark: () => ({ at: 200, n: 1, revised_at: 'R1', ids: ['slack:1.2'], state: 'kept' as const }),
        sendInFlight,
        slackOff: () => '',
        replies: () => 'pending' as const,
        answers: () => 'pending' as const,
      }),
      send: async () => (sends++, { ok: false, detail: '1 new message since this was drafted. Nothing was sent.' }),
    };
    for (let t = 0; t < 4; t++) {
      await actionTick({ views: [], live: {} }, 1000 + t * 15_000, io);
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(sends).toBe(1);
    expect(getStep(db, 'a00000000010')).toMatchObject({ status: 'held', held_at: 0 });
  });
});

describe('scheduled drafts', () => {
  it('lists the draft of every open send_draft step, with its label', () => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a00000000001', session_id: 's1', title: 'T', when: 'pr-merged:acme/app#123', then: 'send-draft:d0123456789ab', ask_first: false, created_by: 'chat', at: 1 });
    addStep(db, { id: 'a00000000002', session_id: 's1', title: 'T', when: 'now', then: 'send-draft:d0123456789ac', ask_first: false, created_by: 'chat', at: 1 });
    db.prepare(`UPDATE action_items SET status = 'done' WHERE id = 'a00000000002'`).run();
    expect([...scheduledDraftIds(db)]).toEqual(['d0123456789ab']);
    expect(scheduledDrafts(db).get('d0123456789ab')).toEqual({ step_id: 'a00000000001', label: 'Scheduled: sends when PR #123 merges' });
  });
});

describe('action_items columns', () => {
  it('adds held_at and approved_rev to a table created before them', () => {
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE action_items (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, position INTEGER NOT NULL, held_rev TEXT NOT NULL DEFAULT '', removed_from TEXT NOT NULL DEFAULT '')`);
    applySchema(db);
    const cols = (db.prepare(`PRAGMA table_info(action_items)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['held_at', 'approved_rev']));
  });
});

describe('close when done (the tick)', () => {
  const view = (sid: string, over: object = {}) => ({ agent: 'claude', session_id: sid, title: 'chat ' + sid, last_active_at: 1, ...over }) as unknown as Snap['views'][number];
  const loc = (sid: string, working: boolean) => ({ agent: 'claude', session_id: sid, pane_id: '%1', tmux_session: 'loom-x', window_index: '1', pane_index: '0', running: true, working }) as Snap['live'][string];
  const idleSnap: Snap = { views: [view('s1')], live: { 'claude:s1': loc('s1', false) } };
  const setup = (when = 'now') => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a00000000001', session_id: 's1', title: 'T', when, then: 'none', ask_first: false, created_by: 'chat', at: 1 });
    setCloseWhenDone(db, 's1', true, 1);
    const closed: string[] = [];
    let drafts: { session_id: string }[] = [];
    const io = {
      ...ioFor(db),
      closePane: (a: string, s: string) => { closed.push(a + ':' + s); return { found: true, ok: true }; },
      pendingDrafts: () => drafts,
    };
    return { db, io, closed, setDrafts: (d: { session_id: string }[]) => (drafts = d) };
  };
  const hidden = (db: Database.Database) => db.prepare(`SELECT agent, session_id, via FROM chat_hidden`).all();
  const closeLogs = (db: Database.Database) => db.prepare(`SELECT text FROM orchestrator_log WHERE text LIKE 'closed:%'`).all();

  it('closes the chat once every step is done, logs it, and never closes it twice', async () => {
    const { db, io, closed } = setup();
    await actionTick(idleSnap, 1000, io);
    expect(closed).toEqual(['claude:s1']);
    expect(chatFlags(db, 's1')).toEqual({ close_when_done: true, closed_at: 1000 });
    expect(hidden(db)).toEqual([{ agent: 'claude', session_id: 's1', via: 'close' }]);
    expect(closeLogs(db)).toEqual([{ text: 'closed: every step done' }]);
    await actionTick(idleSnap, 2000, io);
    expect(closed).toHaveLength(1);
  });

  it('waits while the chat is working, has a pending draft, or its state is unknown', async () => {
    const { db, io, closed, setDrafts } = setup();
    await actionTick({ views: [view('s1')], live: { 'claude:s1': loc('s1', true) } }, 1000, io);
    expect(closed).toEqual([]);
    setDrafts([{ session_id: 'other' }, { session_id: 's1' }]);
    await actionTick(idleSnap, 2000, io);
    expect(closed).toEqual([]);
    setDrafts([]);
    await actionTick({ views: [], live: {} }, 3000, io); // the board has not indexed yet
    expect(closed).toEqual([]);
    expect(chatFlags(db, 's1').closed_at).toBe(0);
    await actionTick({ views: [view('someone-else')], live: {} }, 3500, io); // this chat is not on the board
    expect(closed).toEqual([]);
    io.pendingDrafts = () => { throw new Error('outbox unreadable'); };
    await actionTick(idleSnap, 4000, io);
    expect(closed).toEqual([]);
    io.pendingDrafts = () => [];
    await actionTick(idleSnap, 5000, io);
    expect(closed).toEqual(['claude:s1']);
  });

  it('re-checks the chat on the live board right before closing, and releases the claim when it started working', async () => {
    const { db, io, closed, setDrafts } = setup();
    let live: Snap = { views: [view('s1')], live: { 'claude:s1': loc('s1', true) } };
    const withLive = { ...io, liveSnap: () => live };
    await actionTick(idleSnap, 1000, withLive);
    expect(closed).toEqual([]);
    expect(chatFlags(db, 's1').closed_at).toBe(0);
    expect(closeLogs(db)).toEqual([]);
    // A draft written since the tick's snapshot also keeps it open.
    live = idleSnap;
    let calls = 0;
    withLive.pendingDrafts = () => (++calls === 1 ? [] : [{ session_id: 's1' }]);
    await actionTick(idleSnap, 2000, withLive);
    expect(closed).toEqual([]);
    expect(chatFlags(db, 's1').closed_at).toBe(0);
    withLive.pendingDrafts = () => [];
    setDrafts([]);
    await actionTick(idleSnap, 3000, withLive);
    expect(closed).toEqual(['claude:s1']);
    // A live board that cannot be read never closes.
    const b = setup();
    await actionTick(idleSnap, 1000, { ...b.io, liveSnap: () => { throw new Error('tmux gone'); } });
    expect(b.closed).toEqual([]);
    expect(chatFlags(b.db, 's1').closed_at).toBe(0);
  });

  it('never closes without a pane closer, or with the flag off', async () => {
    const { db, io, closed } = setup();
    await actionTick(idleSnap, 1000, { ...io, closePane: undefined });
    expect(chatFlags(db, 's1').closed_at).toBe(0);
    setCloseWhenDone(db, 's1', false, 1);
    await actionTick(idleSnap, 2000, io);
    expect(closed).toEqual([]);
  });

  it('adding a step reopens a closed chain', async () => {
    const { db, io, closed } = setup();
    await actionTick(idleSnap, 1000, io);
    addStep(db, { id: 'a00000000002', session_id: 's1', title: 'More', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 2 });
    expect(chatFlags(db, 's1').closed_at).toBe(0);
    db.prepare(`UPDATE action_items SET status = 'done' WHERE id = 'a00000000002'`).run();
    await actionTick(idleSnap, 3000, io);
    expect(closed).toHaveLength(2);
  });

  it('a step that holds or fails puts its closed chat back on the board', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a00000000001', session_id: 's1', title: 'Send', when: 'now', then: 'send-draft:d0123456789ab', ask_first: false, created_by: 'chat', at: 1 });
    markChatDone(db, 'claude', 's1', 1);
    db.prepare(`INSERT INTO chat_hidden (agent, session_id, hidden_at) VALUES ('claude', 's2', 1)`).run(); // a plain Remove stays
    const io = {
      withDb: <T,>(fn: (d: Database.Database) => T) => fn(db),
      facts: () => ({ ...rest, pr: () => null, draft: () => ({ status: 'pending', kind: 'slack' as const, revised_at: 'R1' }), slackOff: () => 'Slack direct mode is off' }),
    };
    await actionTick({ views: [view('s1', { done: true })], live: {} }, 1000, io);
    expect(getStep(db, 'a00000000001')?.status).toBe('held');
    expect(hidden(db)).toEqual([{ agent: 'claude', session_id: 's2', via: '' }]);
  });

  it('a step that fails also puts its closed chat back on the board', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    addStep(db, { id: 'a00000000001', session_id: 's1', title: 'Send', when: 'now', then: 'send-draft:d0123456789ab', ask_first: false, created_by: 'chat', at: 1 });
    db.prepare(`UPDATE action_items SET status = 'running' WHERE id = 'a00000000001'`).run(); // Loom restarted mid-send
    markChatDone(db, 'claude', 's1', 1);
    const io = {
      withDb: <T,>(fn: (d: Database.Database) => T) => fn(db),
      facts: () => ({ ...rest, pr: () => null, draft: () => ({ status: 'pending', kind: 'slack' as const, revised_at: 'R1' }) }),
    };
    await actionTick({ views: [view('s1', { done: true })], live: {} }, 1000, io);
    expect(getStep(db, 'a00000000001')?.status).toBe('failed');
    expect(hidden(db)).toEqual([]);
  });
});
