import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { addStep, getStep } from '../src/actions.ts';
import { actionTick } from '../src/actionserver.ts';

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

  it('applies once when two ticks run at the same time', async () => {
    const db = seed();
    await Promise.all([actionTick({ views: [], live: {} }, 1000, ioFor(db)), actionTick({ views: [], live: {} }, 1000, ioFor(db))]);
    expect(logs(db)).toHaveLength(1);
  });
});
