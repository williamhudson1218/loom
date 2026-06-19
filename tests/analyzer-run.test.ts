import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import { summarizeDirty } from '../src/analyzer.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');

async function seed(db: any) {
  const parsed = await parseJsonlFile(FIX);
  upsertChat(db, parsed, 1000, 5000);
}

describe('summarizeDirty', () => {
  it('writes a summary from the stubbed runner and clears dirty', async () => {
    const db = openDb(':memory:');
    await seed(db);
    const runner = async () =>
      `{"title":"Sample work","overview":"Did some sample things.","breakdown":["a","b","left off here"]}`;
    const res = await summarizeDirty(db, runner, { now: 9000 });
    expect(res.succeeded).toBe(1);
    const row = db.prepare(`SELECT title, overview, breakdown_json, summary_dirty, summary_model FROM chats WHERE session_id=?`).get('sess-abc') as any;
    expect(row.title).toBe('Sample work');
    expect(JSON.parse(row.breakdown_json).length).toBe(3);
    expect(row.summary_dirty).toBe(0);
    db.close();
  });

  it('leaves the row dirty and counts failure when the runner returns garbage', async () => {
    const db = openDb(':memory:');
    await seed(db);
    const runner = async () => `not json`;
    const res = await summarizeDirty(db, runner, { now: 9000 });
    expect(res.failed).toBe(1);
    const row = db.prepare(`SELECT summary_dirty FROM chats WHERE session_id=?`).get('sess-abc') as any;
    expect(row.summary_dirty).toBe(1);
    db.close();
  });

  it('uses a heuristic title (no runner call) for tiny chats', async () => {
    const db = openDb(':memory:');
    await seed(db);
    db.prepare(`UPDATE chats SET message_count=1, summary_dirty=1 WHERE session_id=?`).run('sess-abc');
    let called = 0;
    const runner = async () => { called++; return `{}`; };
    const res = await summarizeDirty(db, runner, { now: 9000 });
    expect(called).toBe(0);
    expect(res.heuristic).toBe(1);
    const row = db.prepare(`SELECT title, summary_dirty FROM chats WHERE session_id=?`).get('sess-abc') as any;
    expect(row.title.length).toBeGreaterThan(0);
    expect(row.summary_dirty).toBe(0);
    db.close();
  });
});
