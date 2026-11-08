// The prune-trees tables (src/prune.ts). Its own module so src/schema.ts can
// import it without pulling prune.ts's dependencies into the schema's import graph.

export const PRUNE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS tree_prune_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  repo         TEXT NOT NULL,
  trigger      TEXT NOT NULL,
  started_at   INTEGER NOT NULL,
  finished_at  INTEGER NOT NULL,
  removed      TEXT NOT NULL DEFAULT '[]',
  skipped      TEXT NOT NULL DEFAULT '[]',
  error        TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tree_prune_ships (
  repo       TEXT NOT NULL,
  pr_number  INTEGER NOT NULL,
  merged_at  INTEGER NOT NULL DEFAULT 0,
  seen_at    INTEGER NOT NULL,
  status     TEXT NOT NULL,
  PRIMARY KEY (repo, pr_number)
);
`;
