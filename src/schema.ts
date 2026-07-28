import type Database from 'better-sqlite3';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  agent             TEXT NOT NULL DEFAULT 'claude',
  session_id        TEXT NOT NULL,
  project_dir       TEXT NOT NULL,
  jsonl_path        TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL,
  message_count     INTEGER NOT NULL,
  activity_json     TEXT NOT NULL DEFAULT '{}',
  files_touched     TEXT NOT NULL DEFAULT '',
  files_written     TEXT NOT NULL DEFAULT '',
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
  saved             INTEGER NOT NULL DEFAULT 0,
  saved_at          INTEGER NOT NULL DEFAULT 0,
  jsonl_mtime       INTEGER NOT NULL,
  last_indexed_at   INTEGER NOT NULL,
  PRIMARY KEY (agent, session_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO settings(key, value) VALUES ('default_agent', 'claude');

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
  if (!have.has('saved')) {
    db.exec(`ALTER TABLE chats ADD COLUMN saved INTEGER NOT NULL DEFAULT 0`);
  }
  if (!have.has('saved_at')) {
    db.exec(`ALTER TABLE chats ADD COLUMN saved_at INTEGER NOT NULL DEFAULT 0`);
  }
  if (!have.has('activity_json')) {
    db.exec(`ALTER TABLE chats ADD COLUMN activity_json TEXT NOT NULL DEFAULT '{}'`);
  }
  if (!have.has('files_touched')) {
    db.exec(`ALTER TABLE chats ADD COLUMN files_touched TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('files_written')) {
    db.exec(`ALTER TABLE chats ADD COLUMN files_written TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('first_message')) {
    db.exec(`ALTER TABLE chats ADD COLUMN first_message TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('claude_auto_title')) {
    db.exec(`ALTER TABLE chats ADD COLUMN claude_auto_title TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('title')) {
    db.exec(`ALTER TABLE chats ADD COLUMN title TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('overview')) {
    db.exec(`ALTER TABLE chats ADD COLUMN overview TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('breakdown_json')) {
    db.exec(`ALTER TABLE chats ADD COLUMN breakdown_json TEXT NOT NULL DEFAULT '[]'`);
  }
  if (!have.has('summary_model')) {
    db.exec(`ALTER TABLE chats ADD COLUMN summary_model TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('summary_at')) {
    db.exec(`ALTER TABLE chats ADD COLUMN summary_at INTEGER NOT NULL DEFAULT 0`);
  }
  if (!have.has('last_tmux_session')) {
    db.exec(`ALTER TABLE chats ADD COLUMN last_tmux_session TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('last_pane_id')) {
    db.exec(`ALTER TABLE chats ADD COLUMN last_pane_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!have.has('agent')) {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE chats_v2 (
          agent             TEXT NOT NULL DEFAULT 'claude',
          session_id        TEXT NOT NULL,
          project_dir       TEXT NOT NULL,
          jsonl_path        TEXT NOT NULL,
          started_at        INTEGER NOT NULL,
          ended_at          INTEGER NOT NULL,
          last_active_at    INTEGER NOT NULL,
          message_count     INTEGER NOT NULL,
          activity_json     TEXT NOT NULL DEFAULT '{}',
          files_touched     TEXT NOT NULL DEFAULT '',
          files_written     TEXT NOT NULL DEFAULT '',
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
          saved             INTEGER NOT NULL DEFAULT 0,
          saved_at          INTEGER NOT NULL DEFAULT 0,
          jsonl_mtime       INTEGER NOT NULL,
          last_indexed_at   INTEGER NOT NULL,
          PRIMARY KEY (agent, session_id)
        );

        INSERT INTO chats_v2 (
          agent, session_id, project_dir, jsonl_path, started_at, ended_at,
          last_active_at, message_count, activity_json, files_touched, files_written,
          first_message, claude_auto_title, pr_url, title, overview, state,
          breakdown_json, summary_dirty, summary_model, summary_at,
          last_tmux_session, last_pane_id, saved, saved_at, jsonl_mtime,
          last_indexed_at
        )
        SELECT
          'claude', session_id, project_dir, jsonl_path, started_at, ended_at,
          last_active_at, message_count, activity_json, files_touched, files_written,
          first_message, claude_auto_title, pr_url, title, overview, state,
          breakdown_json, summary_dirty, summary_model, summary_at,
          last_tmux_session, last_pane_id, saved, saved_at, jsonl_mtime,
          last_indexed_at
        FROM chats;

        DROP TABLE chats;
        ALTER TABLE chats_v2 RENAME TO chats;
        CREATE INDEX chats_last_active_idx ON chats(last_active_at);
        CREATE INDEX chats_dirty_idx ON chats(summary_dirty);
        CREATE INDEX chats_saved_idx ON chats(saved);
      `);
    })();
  }
  // Created after the ALTERs above: on a pre-existing DB the `saved` column only
  // exists once the migration has added it, so this index can't live in the
  // CREATE-TABLE block (which is a no-op when the table already exists).
  db.exec(`CREATE INDEX IF NOT EXISTS chats_saved_idx ON chats(saved)`);
}
