import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as dbModule from '../src/db.ts';
import type { Agent } from '../src/types.ts';
import { applySchema } from '../src/schema.ts';

const { openDb } = dbModule;
const { getDefaultAgent, setDefaultAgent } = dbModule as typeof dbModule & {
  getDefaultAgent(db: Database.Database): Agent;
  setDefaultAgent(db: Database.Database, agent: Agent): void;
};

function openLegacyDbWithChat({ session_id }: { session_id: string }): Database.Database {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE chats (
    session_id TEXT PRIMARY KEY,
    project_dir TEXT NOT NULL DEFAULT '',
    jsonl_path TEXT NOT NULL DEFAULT '',
    started_at INTEGER NOT NULL DEFAULT 0,
    ended_at INTEGER NOT NULL DEFAULT 0,
    last_active_at INTEGER NOT NULL DEFAULT 0,
    message_count INTEGER NOT NULL DEFAULT 0,
    activity_json TEXT NOT NULL DEFAULT '{}',
    files_touched TEXT NOT NULL DEFAULT '',
    first_message TEXT NOT NULL DEFAULT '',
    claude_auto_title TEXT NOT NULL DEFAULT '',
    pr_url TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    overview TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT '',
    breakdown_json TEXT NOT NULL DEFAULT '[]',
    summary_dirty INTEGER NOT NULL DEFAULT 1,
    summary_model TEXT NOT NULL DEFAULT '',
    summary_at INTEGER NOT NULL DEFAULT 0,
    last_tmux_session TEXT NOT NULL DEFAULT '',
    last_pane_id TEXT NOT NULL DEFAULT '',
    saved INTEGER NOT NULL DEFAULT 0,
    saved_at INTEGER NOT NULL DEFAULT 0,
    jsonl_mtime INTEGER NOT NULL DEFAULT 0,
    last_indexed_at INTEGER NOT NULL DEFAULT 0
  )`);
  db.prepare(`INSERT INTO chats (session_id) VALUES (?)`).run(session_id);
  return db;
}

function insertChat(db: Database.Database, { agent, session_id }: { agent: Agent; session_id: string }): void {
  db.prepare(`
    INSERT INTO chats (
      agent, session_id, project_dir, jsonl_path, started_at, ended_at,
      last_active_at, message_count, jsonl_mtime, last_indexed_at
    ) VALUES (?, ?, '', '', 0, 0, 0, 0, 0, 0)
  `).run(agent, session_id);
}

describe('openDb', () => {
  it('creates the chats table with the expected columns', () => {
    const db = openDb(':memory:');
    const cols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('session_id');
    expect(names).toContain('activity_json');
    expect(names).toContain('breakdown_json');
    expect(names).toContain('summary_dirty');
    expect(names).toContain('last_pane_id'); // forward-compat
    expect(names).toContain('saved');
    expect(names).toContain('saved_at');
    db.close();
  });

  it('migrates a legacy DB missing the saved columns without throwing', () => {
    // Reproduces the prod crash: a chats table that predates saved/saved_at.
    // CREATE TABLE IF NOT EXISTS is then a no-op, so the migration (ALTERs +
    // the saved index) must be what adds them — the index cannot reference the
    // column before the ALTER runs.
    const db = new Database(':memory:');
    db.exec(`CREATE TABLE chats (
      session_id TEXT PRIMARY KEY, project_dir TEXT NOT NULL DEFAULT '',
      jsonl_path TEXT NOT NULL DEFAULT '', started_at INTEGER NOT NULL DEFAULT 0,
      ended_at INTEGER NOT NULL DEFAULT 0, last_active_at INTEGER NOT NULL DEFAULT 0,
      message_count INTEGER NOT NULL DEFAULT 0, summary_dirty INTEGER NOT NULL DEFAULT 1,
      jsonl_mtime INTEGER NOT NULL DEFAULT 0, last_indexed_at INTEGER NOT NULL DEFAULT 0
    )`);

    expect(() => applySchema(db)).not.toThrow();

    const names = (db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]).map((c) => c.name);
    expect(names).toContain('saved');
    expect(names).toContain('saved_at');
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='chats_saved_idx'`).get();
    expect(idx).toBeTruthy();
    db.close();
  });

  it('migrates legacy Claude rows and permits the same id for both agents', () => {
    // This catches a migration that adds agent without rebuilding the primary key.
    const db = openLegacyDbWithChat({ session_id: 'same-id' });
    applySchema(db);
    expect(db.prepare('SELECT agent FROM chats WHERE session_id=?').get('same-id')).toEqual({ agent: 'claude' });
    insertChat(db, { agent: 'codex', session_id: 'same-id' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE session_id=?').get('same-id')).toEqual({ n: 2 });
    db.close();
  });

  it('defaults to Claude and persists a chosen default agent', () => {
    // This catches a default preference that is not durable SQLite state.
    const db = openDb(':memory:');
    expect(getDefaultAgent(db)).toBe('claude');
    setDefaultAgent(db, 'codex');
    expect(getDefaultAgent(db)).toBe('codex');
    db.close();
  });
});
