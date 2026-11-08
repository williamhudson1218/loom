import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { MigrationStep } from '../migrate.ts';
import { DEFAULT_SHIP_COMMAND, defaultSyncGit, detectBaseBranch, detectRepoSlug, type SyncGit } from '../projects.ts';
import { MAX_LABEL, SHIP_LABELS_FILE, readLabelsFile } from '../shipview.ts';

declare const __LOOM_REPO_DIR__: string | undefined;

// Ship, legacy install (§12 step 3 and the ship-labels part of step 5).
//
// Before per-project Ship, the list of ship repos was `$LOOM_SHIP_REPOS` or one
// built-in default, the button sent `/ship`, and a label was required. Carry
// exactly that over as ship_projects rows so an existing install behaves the
// same, then add the Loom repo itself disabled so it is one switch away.
// The legacy labels file is imported into ship_labels once; the file itself is
// left alone and stays a read fallback (src/shipview.ts mergeLabel).

/** The one repo an install from before ship_projects shipped. This is the only place it is named. */
export const LEGACY_SHIP_REPO = path.join('dev', 'tax-pilot-app');
export const LEGACY_SHIP_COMMAND = '/ship';

export interface ShipMigrationOpts {
  /** Home dir the legacy default resolves under. */
  home?: string;
  /** $LOOM_SHIP_REPOS, colon-separated (unset or empty = the legacy default repo). */
  envRepos?: string;
  /** Loom's own checkout, added disabled when it is a git repo. */
  loomRepoDir?: string;
  labelsFile?: string;
  git?: SyncGit;
  now?: number;
}

export interface ShipMigrationResult {
  repos: string[]; // rows written enabled
  loomAdded: boolean;
  labels: number; // labels imported
}

const isGitRepo = (dir: string): boolean => fs.existsSync(path.join(dir, '.git'));

function insertRow(db: Database.Database, dir: string, command: string, labelRequired: boolean, enabled: boolean, git: SyncGit, now: number): boolean {
  return (
    db
      .prepare(`INSERT OR IGNORE INTO ship_projects (project_dir, repo_slug, base_branch, ship_command, label_required, enabled, added_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(dir, detectRepoSlug(dir, git), detectBaseBranch(dir, git), command, labelRequired ? 1 : 0, enabled ? 1 : 0, now).changes > 0
  );
}

/** Idempotent: rows and labels that already exist are never overwritten. */
export function migrateShip(db: Database.Database, opts: ShipMigrationOpts = {}): ShipMigrationResult {
  const git = opts.git ?? defaultSyncGit;
  const now = opts.now ?? Date.now();
  const home = opts.home ?? os.homedir();
  const env = opts.envRepos; // the migration passes ctx.env.LOOM_SHIP_REPOS; never read process.env here
  const list = env ? env.split(':').filter(Boolean) : [path.join(home, LEGACY_SHIP_REPO)];
  const repos: string[] = [];
  for (const dir of list) {
    if (!isGitRepo(dir)) continue; // the old shipRepos() skipped these too
    insertRow(db, dir, LEGACY_SHIP_COMMAND, true, true, git, now);
    repos.push(dir);
  }

  let loomAdded = false;
  const loom = opts.loomRepoDir ?? (typeof __LOOM_REPO_DIR__ === 'string' ? __LOOM_REPO_DIR__ : '');
  if (loom && isGitRepo(loom) && !repos.includes(loom)) loomAdded = insertRow(db, loom, DEFAULT_SHIP_COMMAND, false, false, git, now);

  // A label with no repo of its own belonged to the legacy ship repo.
  const fallbackRepo = repos[0] ?? '';
  let labels = 0;
  const ins = db.prepare(`INSERT OR IGNORE INTO ship_labels (session_id, repo, label, updated_at) VALUES (?, ?, ?, ?)`);
  for (const [sid, l] of Object.entries(readLabelsFile(opts.labelsFile ?? SHIP_LABELS_FILE))) {
    const repo = (l.repo || fallbackRepo).replace(/\/+$/, '');
    if (!repo) continue;
    labels += ins.run(sid, repo, l.label.slice(0, MAX_LABEL), l.at || now).changes;
  }
  return { repos, loomAdded, labels };
}

/** §12 step 3 (+ the ship-labels import of step 5). Runs on the legacy path only: a fresh install gets no ship rows. */
export const step: MigrationStep = {
  id: 'ship',
  run: (ctx) => {
    const r = migrateShip(ctx.db, {
      home: ctx.home,
      envRepos: ctx.env.LOOM_SHIP_REPOS,
      labelsFile: path.join(ctx.legacyStateDir, 'ship-labels.json'),
      now: ctx.now,
    });
    ctx.log(`ship: ${r.repos.length ? r.repos.join(', ') : 'no repos'} enabled${r.loomAdded ? ', Loom added disabled' : ''}; ${r.labels} labels imported`);
  },
};
