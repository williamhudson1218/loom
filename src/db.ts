import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './paths.ts';
import { applySchema } from './schema.ts';
import { isLaunchPreference, type LaunchPreference } from './types.ts';

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

// The stored value is the launch preference: an agent, or 'ask' for no default.
// Anything unrecognised (or unset) reads as Claude, the original behaviour.
export function getDefaultAgent(db: Database.Database): LaunchPreference {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'default_agent'`).get() as { value: string } | undefined;
  return isLaunchPreference(row?.value) ? row.value : 'claude';
}

export function setDefaultAgent(db: Database.Database, agent: LaunchPreference): void {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES ('default_agent', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(agent);
}
