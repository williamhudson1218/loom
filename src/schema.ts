import type Database from 'better-sqlite3';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  session_id        TEXT PRIMARY KEY,
  project_dir       TEXT NOT NULL,
  jsonl_path        TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL,
  message_count     INTEGER NOT NULL,
  activity_json     TEXT NOT NULL DEFAULT '{}',
  files_touched     TEXT NOT NULL DEFAULT '',
  first_message     TEXT NOT NULL DEFAULT '',
  claude_auto_title TEXT NOT NULL DEFAULT '',
  pr_url            TEXT NOT NULL DEFAULT '',
  title             TEXT NOT NULL DEFAULT '',
  overview          TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL DEFAULT '',
  breakdown_json    TEXT NOT NULL DEFAULT '[]',
  summary_dirty     INTEGER NOT NULL DEFAULT 1,
  summary_model     TEXT NOT NULL DEFAULT '',
  summary_at        INTEGER NOT NULL DEFAULT 0,
  last_tmux_session TEXT NOT NULL DEFAULT '',
  last_pane_id      TEXT NOT NULL DEFAULT '',
  jsonl_mtime       INTEGER NOT NULL,
  last_indexed_at   INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS chats_last_active_idx ON chats(last_active_at);
CREATE INDEX IF NOT EXISTS chats_dirty_idx ON chats(summary_dirty);
`;

export function applySchema(db: Database.Database): void {
  db.exec(SCHEMA_SQL);
  // Migrate DBs created before a column existed (CREATE TABLE IF NOT EXISTS
  // won't add columns to an existing table).
  const cols = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('state')) {
    db.exec(`ALTER TABLE chats ADD COLUMN state TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('pr_url')) {
    db.exec(`ALTER TABLE chats ADD COLUMN pr_url TEXT NOT NULL DEFAULT ''`);
  }
}
