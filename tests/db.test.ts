import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { applySchema } from '../src/schema.ts';

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
});
