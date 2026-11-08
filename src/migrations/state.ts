import fs from 'node:fs';
import path from 'node:path';
import type { MigrationContext, MigrationStep } from '../migrate.ts';
import { readOutbox } from '../outbox.ts';
import { syncLegacyThreads, type LegacyThreadRec } from '../slackowner.ts';

// Loom-owned state imports (§12 step 5). An older install kept these in files its
// toolbox hooks wrote under ~/.claude/state; Loom now owns its own copies. Every
// import is keyed by id and never overwrites what Loom already has, so running it
// twice changes nothing. The legacy files are only read, here and afterwards (as
// fallbacks while the old hooks may still be writing them).
//
//   slack-threads.json  -> slack_threads rows (source 'legacy') + slack_thread_state
//   slack-outbox.json   -> $LOOM_HOME/outbox.json, ids and fields preserved
//   slack-channels.json -> $LOOM_HOME/slack-cache.json `channels` (labels only)
//
// ship-labels.json is the ship step's (src/migrations/ship.ts).

const readJson = (file: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
};

/** Thread ownership and stages: DB rows, so inside the migration transaction. */
export function importThreads(ctx: Pick<MigrationContext, 'db' | 'legacyStateDir' | 'now' | 'log'>): number {
  const raw = readJson(path.join(ctx.legacyStateDir, 'slack-threads.json')) as { threads?: Record<string, LegacyThreadRec> } | null;
  const threads = raw && typeof raw.threads === 'object' && raw.threads ? raw.threads : {};
  if (!Object.keys(threads).length) return 0;
  const n = syncLegacyThreads(ctx.db, threads, ctx.now);
  if (n) ctx.log(`state: ${n} Slack thread record(s) imported from slack-threads.json`);
  return n;
}

/** Drafts: folded into Loom's outbox file by id (outbox.mergeLegacy). Returns how many Loom now holds. */
export function importOutbox(ctx: Pick<MigrationContext, 'loomHome' | 'legacyStateDir' | 'log'>): number {
  const legacy = path.join(ctx.legacyStateDir, 'slack-outbox.json');
  if (!fs.existsSync(legacy)) return 0;
  const n = Object.keys(readOutbox({ file: path.join(ctx.loomHome, 'outbox.json'), legacy })).length;
  ctx.log(`state: outbox.json holds ${n} draft(s) after importing slack-outbox.json`);
  return n;
}

/** Channel labels: into slack-cache.json, never replacing a label Loom resolved itself. */
export function importChannelLabels(ctx: Pick<MigrationContext, 'loomHome' | 'legacyStateDir' | 'log'>): number {
  const legacy = readJson(path.join(ctx.legacyStateDir, 'slack-channels.json'));
  if (!legacy || typeof legacy !== 'object' || Array.isArray(legacy)) return 0;
  const file = path.join(ctx.loomHome, 'slack-cache.json');
  const cache = (readJson(file) as { channels?: Record<string, string> } | null) ?? {};
  const channels: Record<string, string> = { ...(cache.channels ?? {}) };
  let n = 0;
  for (const [id, label] of Object.entries(legacy as Record<string, unknown>)) {
    if (!/^[A-Z0-9]+$/.test(id) || typeof label !== 'string' || !label || channels[id]) continue;
    channels[id] = label;
    n++;
  }
  if (!n) return 0;
  fs.mkdirSync(ctx.loomHome, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ ...cache, roots: (cache as { roots?: unknown }).roots ?? {}, channels }, null, 2));
  fs.renameSync(tmp, file);
  ctx.log(`state: ${n} channel label(s) imported from slack-channels.json`);
  return n;
}

export const step: MigrationStep = {
  id: 'state',
  run(ctx) {
    importThreads(ctx);
  },
  // Files outside the DB: after the transaction commits. Each is safe to repeat
  // and to skip (the outbox also folds the legacy file in on every read).
  afterCommit(ctx) {
    importOutbox(ctx);
    importChannelLabels(ctx);
  },
};
