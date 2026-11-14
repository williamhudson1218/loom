import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { addStep, getStep } from '../src/actions.ts';
import { _resetPipelineStore, pipelineHealth, tickPipelines } from '../src/pipeline.ts';
import { actionFacts, actionTick } from '../src/actionserver.ts';

const seed = () => {
  const db = new Database(':memory:');
  applySchema(db);
  addStep(db, { id: 'a00000000001', session_id: 's1', title: 'T', when: 'now', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
  return db;
};
const ioFor = (db: Database.Database) => ({ facts: () => ({ pr: () => null, draft: () => null }), withDb: <T,>(fn: (d: Database.Database) => T) => fn(db) });
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
      facts: () => ({ pr: () => null, draft: () => { throw new Error('boom'); } }),
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
