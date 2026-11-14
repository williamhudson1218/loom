import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { addStep, getStep } from '../src/actions.ts';
import { _resetPipelineStore, pipelineHealth, tickPipelines } from '../src/pipeline.ts';
import { actionFacts, actionTick, scheduledDraftIds, scheduledDrafts, sendInFlight } from '../src/actionserver.ts';

const seed = () => {
  const db = new Database(':memory:');
  applySchema(db);
  addStep(db, { id: 'a00000000001', session_id: 's1', title: 'T', when: 'now', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
  return db;
};
const rest = { preSend: () => ({ decision: 'pending' as const }), redraftMark: () => undefined, sendInFlight: () => false, slackOff: () => '' };
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
