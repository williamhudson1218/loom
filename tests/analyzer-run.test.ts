import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { parseCodexJsonlFile } from '../src/codexParser.ts';
import { upsertChat } from '../src/indexer.ts';
import { summarizeDirty, transcriptToText } from '../src/analyzer.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');
const CODEX_FIX = path.join(__dirname, 'fixtures', 'codex-chat.jsonl');
const validSummaryJson =
  `{"title":"Sample work","overview":"Did some sample things.","breakdown":["a","b","left off here"]}`;

async function seed(db: any) {
  const parsed = await parseJsonlFile(FIX);
  upsertChat(db, parsed, 1000, 5000);
}

function row(db: any, agent: 'claude' | 'codex', sessionId: string) {
  return db.prepare(
    `SELECT title, summary_dirty, summary_model FROM chats WHERE agent=? AND session_id=?`,
  ).get(agent, sessionId) as any;
}

describe('summarizeDirty', () => {
  it('normalizes Codex user and assistant prose for a summary', async () => {
    await expect(transcriptToText('codex', CODEX_FIX)).resolves.toBe(
      'USER: fix the deployment\nASSISTANT: I will inspect the deployment configuration.',
    );
  });

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

  it('updates summaries independently for identical agent-qualified IDs', async () => {
    const db = openDb(':memory:');
    await seed(db);
    const codex = await parseCodexJsonlFile(CODEX_FIX);
    upsertChat(db, codex, 1000, 5000);
    db.prepare(`UPDATE chats SET session_id='same-id'`).run();

    await summarizeDirty(db, async () => validSummaryJson, { now: 9000 });

    expect(row(db, 'claude', 'same-id').summary_dirty).toBe(0);
    expect(row(db, 'codex', 'same-id').summary_dirty).toBe(0);
    expect(row(db, 'claude', 'same-id').title).toBe('Sample work');
    expect(row(db, 'codex', 'same-id').title).toBe('fix the deployment');
    expect(row(db, 'codex', 'same-id').summary_model).toBe('heuristic');
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
