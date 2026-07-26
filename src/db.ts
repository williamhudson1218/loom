import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './paths.ts';
import { applySchema } from './schema.ts';
import type { Agent } from './types.ts';

export function openDb(dbPath: string = DB_PATH): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  applySchema(db);
  return db;
}

export function getDefaultAgent(db: Database.Database): Agent {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'default_agent'`).get() as { value: string } | undefined;
  return row?.value === 'codex' ? 'codex' : 'claude';
}

export function setDefaultAgent(db: Database.Database, agent: Agent): void {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES ('default_agent', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(agent);
}
