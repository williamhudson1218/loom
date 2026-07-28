import type Database from 'better-sqlite3';
import type { Agent } from '../types.ts';

// All seven detectors are declared so the ledger schema is stable across phases.
// Phase 1 emits only BLOCKED, WRAPPABLE, and BLOATED.
export type DetectorKind =
  | 'BLOCKED' | 'WRAPPABLE' | 'BLOATED'
  | 'STALLED' | 'SPINNING' | 'DRIFTING' | 'CONVERGING';

export type EmMode = 'off' | 'shadow' | 'live';
export type FindingStatus = 'new' | 'triaged' | 'acted' | 'escalated' | 'expired';

export const EM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS em_findings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  detected_at  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new'
);

CREATE TABLE IF NOT EXISTS em_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  taken_at   INTEGER NOT NULL,
  shadow     INTEGER NOT NULL DEFAULT 1,
  result     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS em_findings_cooldown_idx
  ON em_findings(agent, session_id, kind, detected_at);
CREATE INDEX IF NOT EXISTS em_findings_status_idx ON em_findings(status);
CREATE INDEX IF NOT EXISTS em_actions_taken_idx ON em_actions(taken_at);
`;

export interface Finding {
  agent: Agent;
  session_id: string;
  kind: DetectorKind;
  signals: Record<string, unknown>;
  detected_at: number;
}

export interface FindingRow {
  id: number;
  agent: Agent;
  session_id: string;
  kind: DetectorKind;
  signals_json: string;
  detected_at: number;
  status: FindingStatus;
}

export interface ActionInput {
  finding_id: number;
  kind: string;
  payload: string;
  shadow: 0 | 1;
  result: string;
  taken_at: number;
}

export interface ActionRow extends ActionInput {
  id: number;
}

const EM_MODES: readonly EmMode[] = ['off', 'shadow', 'live'];

// Unrecognised or unset reads as… different things in each direction, on purpose:
// unset means a fresh install, which should observe (shadow); a stored value we
// cannot parse means something is wrong, so fail closed (off).
export function getEmMode(db: Database.Database): EmMode {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'em_mode'`).get() as { value: string } | undefined;
  if (!row) return 'shadow';
  return EM_MODES.includes(row.value as EmMode) ? (row.value as EmMode) : 'off';
}

export function setEmMode(db: Database.Database, mode: EmMode): void {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES ('em_mode', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(mode);
}

// Returns the new finding's id, or null when an identical (session, kind) fired
// inside the cooldown. Without this a stuck session is re-detected every tick.
export function recordFinding(db: Database.Database, f: Finding, cooldownMs: number): number | null {
  const last = db
    .prepare(`SELECT MAX(detected_at) AS t FROM em_findings WHERE agent = ? AND session_id = ? AND kind = ?`)
    .get(f.agent, f.session_id, f.kind) as { t: number | null };
  if (last.t !== null && f.detected_at - last.t < cooldownMs) return null;

  const info = db
    .prepare(`INSERT INTO em_findings (agent, session_id, kind, signals_json, detected_at, status)
              VALUES (?, ?, ?, ?, ?, 'new')`)
    .run(f.agent, f.session_id, f.kind, JSON.stringify(f.signals), f.detected_at);
  return Number(info.lastInsertRowid);
}

export function recordAction(db: Database.Database, a: ActionInput): number {
  const info = db
    .prepare(`INSERT INTO em_actions (finding_id, kind, payload, taken_at, shadow, result)
              VALUES (@finding_id, @kind, @payload, @taken_at, @shadow, @result)`)
    .run(a);
  return Number(info.lastInsertRowid);
}

export function setFindingStatus(db: Database.Database, id: number, status: FindingStatus): void {
  db.prepare(`UPDATE em_findings SET status = ? WHERE id = ?`).run(status, id);
}

export function newFindings(db: Database.Database): FindingRow[] {
  return db
    .prepare(`SELECT * FROM em_findings WHERE status = 'new' ORDER BY detected_at ASC`)
    .all() as FindingRow[];
}

// Bounds the blast radius of a miscalibrated detector. Shadow actions send
// nothing, and filing an issue is not a pane write, so neither is counted.
const PANE_WRITE_KINDS = new Set(['answer', 'nudge', 'refocus', 'brief', 'restart']);

export function paneWritesSince(db: Database.Database, since: number): number {
  const rows = db
    .prepare(`SELECT kind FROM em_actions WHERE shadow = 0 AND taken_at >= ?`)
    .all(since) as { kind: string }[];
  return rows.filter((r) => PANE_WRITE_KINDS.has(r.kind)).length;
}

export function recentLedger(
  db: Database.Database,
  since: number,
): { findings: FindingRow[]; actions: ActionRow[] } {
  return {
    findings: db
      .prepare(`SELECT * FROM em_findings WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 200`)
      .all(since) as FindingRow[],
    actions: db
      .prepare(`SELECT * FROM em_actions WHERE taken_at >= ? ORDER BY taken_at DESC LIMIT 200`)
      .all(since) as ActionRow[],
  };
}
