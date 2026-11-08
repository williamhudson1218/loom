import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { DB_PATH } from './paths.ts';
import { applySchema } from './schema.ts';
import { isLaunchPreference, type LaunchPreference } from './types.ts';
import { configureTmuxSocket } from './tmux.ts';
import { getSetting, setSetting } from './settingsSchema.ts';
import { runMigration, type MigrateResult } from './migrate.ts';
import './migrations/index.ts';

export interface OpenDbOpts {
  /**
   * Run the settings migration (src/migrate.ts) after the schema. Default: on
   * for a DB file, off for ':memory:' (never an install; tests that want the
   * migration call runMigration or pass true). Cheap once the DB is on
   * settings_schema 2.
   */
  migrate?: boolean;
}

/** The last migration outcome per DB file in this process (diagnostics, Settings › Help). */
export const lastMigration = new Map<string, MigrateResult>();

export function openDb(dbPath: string = DB_PATH, opts: OpenDbOpts = {}): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  applySchema(db);
  if (opts.migrate ?? dbPath !== ':memory:') {
    const r = runMigration(db, { dbPath });
    if (r.outcome !== 'current') lastMigration.set(dbPath, r);
  }
  return db;
}

// The stored value is the launch preference: an agent, or 'ask' for no default.
// Anything unrecognised (or unset) reads as Claude, the original behaviour.
export function getDefaultAgent(db: Database.Database): LaunchPreference {
  const v = getSetting(db, 'default_agent', { env: false });
  return isLaunchPreference(v) ? v : 'claude';
}

export function setDefaultAgent(db: Database.Database, agent: LaunchPreference): void {
  setSetting(db, 'default_agent', agent);
}

// The global "pick a Slack message, open its chat" hotkey, as an Electron
// accelerator. Unset reads as the default; 'off' disables it. Change it in
// Settings (src/settingsSchema.ts) and restart Loom (the shortcut is registered at launch).
export const DEFAULT_SLACK_HOTKEY = 'Command+Shift+L';
export function getSlackHotkey(db: Database.Database): string {
  return getSetting(db, 'slack_goto_hotkey', { env: false }) || DEFAULT_SLACK_HOTKEY;
}

/**
 * The watchers master switch (`watchers_enabled`, which replaces `slack_watchers`).
 * On an unmigrated DB it is off only when `slack_watchers` reads 'off', as before.
 * $LOOM_WATCHERS_OFF is not consulted here: watchers.ts checks it where it starts.
 */
export function watchersFeatureOn(db: Database.Database): boolean {
  return getSetting(db, 'watchers_enabled', { env: false });
}

// Which tmux server Loom drives (see src/tmux.ts): the stored choice, ignoring
// $LOOM_TMUX_SOCKET (tmuxSocket() applies that). Unset reads as 'default' on an
// install from before the settings registry and 'loom' on a new one. Takes
// effect after a restart.
export function getTmuxSocket(db: Database.Database): string {
  return getSetting(db, 'tmux_socket', { env: false });
}

/** Read the stored socket once at launch and hand it to the tmux runner. Never throws. */
export function loadTmuxSocketSetting(dbPath: string = DB_PATH): void {
  try {
    const db = openDb(dbPath);
    try {
      configureTmuxSocket(getTmuxSocket(db));
    } finally {
      db.close();
    }
  } catch {
    /* no db yet: the runner stays on its env/default socket */
  }
}

// How the embedded terminal shows a pane that shares its window with others
// (ptybridge.ts): 'zoom' (default) attaches and zooms the pane, so Loom owns its
// size; 'mirror' streams it without touching the window.
export type LaneView = 'zoom' | 'mirror';
export const LANE_VIEWS: LaneView[] = ['zoom', 'mirror'];
export const parseLaneView = (v: unknown): LaneView | null => (v === 'zoom' || v === 'mirror' ? v : null);
export function getLaneView(db: Database.Database): LaneView {
  return getSetting(db, 'lane_view', { env: false });
}
export function setLaneView(db: Database.Database, v: LaneView): void {
  setSetting(db, 'lane_view', v);
}
