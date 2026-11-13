import type Database from 'better-sqlite3';
import { PARKED_SCHEMA_SQL } from './parked.ts';
import { TEST_LINKS_SCHEMA_SQL, ensureTestLinkColumns } from './testlinks.ts';
import { PRUNE_SCHEMA_SQL } from './prunesql.ts';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chats (
  agent             TEXT NOT NULL DEFAULT 'claude',
  session_id        TEXT NOT NULL,
  project_dir       TEXT NOT NULL,
  jsonl_path        TEXT NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER NOT NULL,
  last_active_at    INTEGER NOT NULL,
  last_turn_at      INTEGER NOT NULL DEFAULT 0,
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

// Watchers (src/watchers/): Source -> Trigger -> Action, Shadow or Live (§9).
// The legacy Slack-only columns (channel, rule_kind, rule_params, brief_path,
// project_dir, workspace) are kept for one release, so the previous build can
// still read a migrated DB; new code reads source_/trigger_/action_ only. The
// Slack poll state (baselined .. next_poll_at) is shared by both.
// watcher_seen is the Slack dedupe set (every matched message ts, baseline
// included). watcher_events is one row per thing a watcher noticed and what it
// decided (fired / would_fire / held_*), replacing watcher_spawns for new data.
// watcher_spawns stays (read by the migration only) until a later build drops it.
export const WATCHERS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS watchers (
  id           TEXT PRIMARY KEY,
  label        TEXT NOT NULL,
  channel      TEXT NOT NULL DEFAULT '',
  rule_kind    TEXT NOT NULL DEFAULT '',
  rule_params  TEXT NOT NULL DEFAULT '{}',
  brief_path   TEXT NOT NULL DEFAULT '',
  project_dir  TEXT NOT NULL DEFAULT '',
  workspace    TEXT NOT NULL DEFAULT '',
  enabled      INTEGER NOT NULL DEFAULT 0,
  baselined    INTEGER NOT NULL DEFAULT 0,
  watermark    TEXT NOT NULL DEFAULT '',
  last_poll_at INTEGER NOT NULL DEFAULT 0,
  last_ok_at   INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT NOT NULL DEFAULT '',
  error_count  INTEGER NOT NULL DEFAULT 0,
  next_poll_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS watcher_seen (
  watcher_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  seen_at    INTEGER NOT NULL,
  baseline   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (watcher_id, ts)
);

CREATE TABLE IF NOT EXISTS watcher_spawns (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id TEXT NOT NULL,
  ts         TEXT NOT NULL,
  title      TEXT NOT NULL,
  permalink  TEXT NOT NULL,
  status     TEXT NOT NULL,
  pane_id    TEXT NOT NULL DEFAULT '',
  pane_name  TEXT NOT NULL DEFAULT '',
  pane_where TEXT NOT NULL DEFAULT '',
  brief_path TEXT NOT NULL DEFAULT '',
  queued_at  INTEGER NOT NULL,
  spawned_at INTEGER NOT NULL DEFAULT 0,
  detail     TEXT NOT NULL DEFAULT '',
  UNIQUE (watcher_id, ts)
);

CREATE INDEX IF NOT EXISTS watcher_spawns_status_idx ON watcher_spawns(watcher_id, status);

CREATE TABLE IF NOT EXISTS watcher_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  watcher_id  TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  subject     TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL DEFAULT '',
  permalink   TEXT NOT NULL DEFAULT '',
  detected_at INTEGER NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'live',
  decision    TEXT NOT NULL,
  result      TEXT NOT NULL DEFAULT '',
  detail      TEXT NOT NULL DEFAULT '',
  pane_id     TEXT NOT NULL DEFAULT '',
  pane_name   TEXT NOT NULL DEFAULT '',
  pane_where  TEXT NOT NULL DEFAULT '',
  brief_path  TEXT NOT NULL DEFAULT '',
  acted_at    INTEGER NOT NULL DEFAULT 0,
  reviewed_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE (watcher_id, event_key)
);

CREATE INDEX IF NOT EXISTS watcher_events_recent_idx ON watcher_events(watcher_id, detected_at);
CREATE INDEX IF NOT EXISTS watcher_events_queue_idx ON watcher_events(result, watcher_id);
`;

/** v2 columns added to an existing watchers table (§9.1). name -> column definition. */
export const WATCHERS_V2_COLUMNS: [string, string][] = [
  ['run_mode', `TEXT NOT NULL DEFAULT 'live'`],
  ['source_kind', `TEXT NOT NULL DEFAULT 'slack'`],
  ['source_params', `TEXT NOT NULL DEFAULT '{}'`],
  ['trigger_kind', `TEXT NOT NULL DEFAULT ''`],
  ['trigger_params', `TEXT NOT NULL DEFAULT '{}'`],
  ['action_kind', `TEXT NOT NULL DEFAULT 'start_chat'`],
  ['action_params', `TEXT NOT NULL DEFAULT '{}'`],
  ['max_per_hour', `INTEGER NOT NULL DEFAULT 6`],
  ['cooldown_min', `INTEGER NOT NULL DEFAULT 60`],
  ['quiet_start', `TEXT NOT NULL DEFAULT ''`],
  ['quiet_end', `TEXT NOT NULL DEFAULT ''`],
  ['template_id', `TEXT NOT NULL DEFAULT ''`],
  ['created_at', `INTEGER NOT NULL DEFAULT 0`],
  ['updated_at', `INTEGER NOT NULL DEFAULT 0`],
];

/** Add any missing v2 column. ALTER ADD COLUMN keeps every existing row and value. */
export function ensureWatcherColumns(db: Database.Database): void {
  const have = new Set((db.prepare(`PRAGMA table_info(watchers)`).all() as { name: string }[]).map((c) => c.name));
  for (const [name, def] of WATCHERS_V2_COLUMNS) {
    if (!have.has(name)) db.exec(`ALTER TABLE watchers ADD COLUMN ${name} ${def}`);
  }
}

// Per-chat user edits that must survive the indexer and the summarizer, which
// rewrite the chats row: a title override (Rename) and a board hide (Remove from
// board). A hidden chat returns on its own once it is active again.
// Slack thread ownership (src/slackowner.ts): thread parent -> the chat that owns
// it. First claim wins (INSERT OR IGNORE), so a later chat that merely pastes the
// link cannot steal a thread. `source` is how Loom learned of it: 'start' (Loom
// started the chat for the thread), 'index' (a transcript's first prompt held the
// link), 'pending' (started for a thread, session id not known yet).
export const SLACK_THREADS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS slack_threads (
  thread_key  TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  agent       TEXT NOT NULL DEFAULT 'claude',
  session_id  TEXT NOT NULL DEFAULT '',
  project_dir TEXT NOT NULL DEFAULT '',
  pane_id     TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'index',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS slack_threads_session_idx ON slack_threads(session_id);
`;

export const CHAT_EDITS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_titles (
  agent       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  title       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (agent, session_id)
);
CREATE TABLE IF NOT EXISTS tags (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
  color       TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_tags (
  agent       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  tag_id      INTEGER NOT NULL,
  PRIMARY KEY (agent, session_id, tag_id)
);
CREATE INDEX IF NOT EXISTS chat_tags_tag_idx ON chat_tags(tag_id);
CREATE TABLE IF NOT EXISTS chat_hidden (
  agent       TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  hidden_at   INTEGER NOT NULL,
  via         TEXT NOT NULL DEFAULT '',   -- '' = Remove from board (gone everywhere); 'close' = Send & close (off the board, still in All history)
  PRIMARY KEY (agent, session_id)
);
`;

// The orchestrator (src/orchestrator.ts). orchestrator_items is the status rail:
// what needs Will, what waits on someone else, what is moving, what is done. It
// lives here rather than in the orchestrator's context so compaction or a restart
// loses nothing. ref_type + ref_id point at a chat ('claude:<session>'), a PR (its
// URL) or a Slack thread (its permalink); one OPEN item per ref (resolved_at = 0).
// orchestrator_log is what Loom did on its behalf (relays, queued relays, event
// batches), echoed in its conversation. orchestrator_outbox holds relays to a chat
// Will was looking at, delivered once he leaves it. orchestrator_verdicts caches
// the model's read of an ended chat against an item (src/orchjudge.ts).
/** resolved_why came after the table: an existing install gets it here. */
function ensureOrchestratorColumns(db: Database.Database): void {
  const have = new Set((db.prepare(`PRAGMA table_info(orchestrator_items)`).all() as { name: string }[]).map((c) => c.name));
  if (!have.has('resolved_why')) db.exec(`ALTER TABLE orchestrator_items ADD COLUMN resolved_why TEXT NOT NULL DEFAULT ''`);
}

export const ORCHESTRATOR_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS orchestrator_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,
  ref_type    TEXT NOT NULL DEFAULT '',
  ref_id      TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  why         TEXT NOT NULL DEFAULT '',
  who         TEXT NOT NULL DEFAULT '',
  opened_at   INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  resolved_at INTEGER NOT NULL DEFAULT 0,
  resolved_why TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS orchestrator_items_open_idx ON orchestrator_items(resolved_at, kind);
CREATE TABLE IF NOT EXISTS orchestrator_verdicts (
  key             TEXT PRIMARY KEY,
  activity_at     INTEGER NOT NULL,
  item_updated_at INTEGER NOT NULL,
  state           TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  at              INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestrator_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  text   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS orchestrator_outbox (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  text         TEXT NOT NULL,
  queued_at    INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'queued',
  detail       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS orchestrator_outbox_status_idx ON orchestrator_outbox(status);
`;

// Ship modal (src/shipview.ts). ship_projects: the repos Ship works on, one row
// each (src/projects.ts; an empty table means no ship line at all). ship_labels: a one-line "what this chat is
// shipping", written through POST /api/ship/label (it wins over the toolbox
// hook's ~/.claude/state/ship-labels.json). ship_attr_overrides: a file the
// person assigned to a chat by hand; the ship board honours it over the
// transcript-derived attribution.
export const SHIP_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ship_labels (
  session_id  TEXT NOT NULL,
  repo        TEXT NOT NULL,
  label       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (session_id, repo)
);
CREATE TABLE IF NOT EXISTS ship_projects (
  project_dir    TEXT PRIMARY KEY,
  repo_slug      TEXT NOT NULL DEFAULT '',
  base_branch    TEXT NOT NULL DEFAULT 'main',
  ship_command   TEXT NOT NULL DEFAULT '/loom:ship',
  label_required INTEGER NOT NULL DEFAULT 0,
  ship_lock      INTEGER NOT NULL DEFAULT 1,
  enabled        INTEGER NOT NULL DEFAULT 1,
  added_at       INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ship_attr_overrides (
  repo        TEXT NOT NULL,
  path        TEXT NOT NULL,
  chat_key    TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  PRIMARY KEY (repo, path)
);
`;

/**
 * Columns ship_projects gained after it shipped. ADD COLUMN backfills every
 * existing row with the default, so the ship lock is on for repos already on Ship.
 */
export function ensureShipColumns(db: Database.Database): void {
  const have = new Set((db.prepare(`PRAGMA table_info(ship_projects)`).all() as { name: string }[]).map((c) => c.name));
  if (!have.has('ship_lock')) db.exec(`ALTER TABLE ship_projects ADD COLUMN ship_lock INTEGER NOT NULL DEFAULT 1`);
}

// Projects (src/projects.ts): the folders a chat can be started in. Seeded from
// indexed chats' project dirs (insert-if-missing), then edited by the person.
export const PROJECTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  path         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  color        TEXT NOT NULL DEFAULT '',
  hidden       INTEGER NOT NULL DEFAULT 0,
  added_at     INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL DEFAULT 0
);
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
  const hiddenCols = db.prepare(`PRAGMA table_info(chat_hidden)`).all() as { name: string }[];
  if (hiddenCols.length && !hiddenCols.some((c) => c.name === 'via')) {
    db.exec(`ALTER TABLE chat_hidden ADD COLUMN via TEXT NOT NULL DEFAULT ''`);
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
          last_turn_at      INTEGER NOT NULL DEFAULT 0,
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
  // last_turn_at (2026-10-20) arrived after the v2 rebuild, so it is checked
  // against the table as it stands now. Existing rows get 0 and the index pass
  // only re-reads a file whose mtime changed, so zero every mtime once: the
  // next pass re-parses what is inside the window and fills the column, and
  // until then the board falls back to last_active_at for those rows.
  const cols2 = db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[];
  if (!cols2.some((c) => c.name === 'last_turn_at')) {
    db.exec(`ALTER TABLE chats ADD COLUMN last_turn_at INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE chats SET jsonl_mtime = 0`);
  }
  // last_pane_name: the tmux pane's @name last seen for this chat, so search can
  // find a chat by its pane name after the pane is gone.
  if (!cols2.some((c) => c.name === 'last_pane_name')) {
    db.exec(`ALTER TABLE chats ADD COLUMN last_pane_name TEXT NOT NULL DEFAULT ''`);
  }
  // Created after the ALTERs above: on a pre-existing DB the `saved` column only
  // exists once the migration has added it, so this index can't live in the
  // CREATE-TABLE block (which is a no-op when the table already exists).
  db.exec(`CREATE INDEX IF NOT EXISTS chats_saved_idx ON chats(saved)`);
  // The EM's em_findings/em_actions are no longer created: a migrated install
  // keeps its old tables (archived by src/migrations/watchers.ts, unread), and a
  // new one never has them.
  db.exec(WATCHERS_SCHEMA_SQL);
  ensureWatcherColumns(db);
  db.exec(CHAT_EDITS_SCHEMA_SQL);
  db.exec(SHIP_SCHEMA_SQL);
  ensureShipColumns(db);
  db.exec(PROJECTS_SCHEMA_SQL);
  db.exec(SLACK_THREADS_SCHEMA_SQL);
  db.exec(ORCHESTRATOR_SCHEMA_SQL);
  ensureOrchestratorColumns(db);
  db.exec(PARKED_SCHEMA_SQL);
  db.exec(TEST_LINKS_SCHEMA_SQL);
  ensureTestLinkColumns(db);
  db.exec(PRUNE_SCHEMA_SQL);
}
