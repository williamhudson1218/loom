import type Database from 'better-sqlite3';
import { openDb } from './db.ts';
import { refresh } from './indexer.ts';
import { summarizeDirty, defaultRunner, type ClaudeRunner } from './analyzer.ts';
import { writeDashboard } from './dashboard.ts';
import { restore } from './restore.ts';
import { writeLayout } from './snapshot.ts';
import { DASHBOARD_PATH } from './paths.ts';

export async function runPass(
  db: Database.Database,
  runner: ClaudeRunner = defaultRunner,
  opts: { now?: number; projectsDir?: string; dashboardPath?: string } = {},
) {
  const now = opts.now ?? Date.now();
  const idx = await refresh(db, { projectsDir: opts.projectsDir, now });
  const analyze = await summarizeDirty(db, runner, { now });
  const dashboard = writeDashboard(db, opts.dashboardPath ?? DASHBOARD_PATH, now);
  return { scanned: idx.scanned, changed: idx.changed, pruned: idx.pruned, analyze, dashboard };
}

async function main() {
  const cmd = process.argv[2] ?? 'run';

  if (cmd === 'restore') {
    const dryRun = process.argv.includes('--dry-run');
    const r = restore({ dryRun });
    if (dryRun) {
      console.log(r.log.join('\n'));
      console.log(`\n[dry-run] would restore ${r.restored.length} sessions: ${r.restored.join(', ') || '(none)'}`);
      if (r.skipped.length) console.log(`[dry-run] skipped (already running): ${r.skipped.join(', ')}`);
    } else {
      console.log(`[loom] restored ${r.restored.length} session(s): ${r.restored.join(', ') || '(none)'}`);
      if (r.skipped.length) console.log(`  skipped (already running): ${r.skipped.join(', ')}`);
      if (r.attach.length) {
        console.log('\nOpen a Ghostty tab per session and attach:');
        for (const s of r.attach) console.log(`  ta ${s}`);
      }
    }
    return;
  }

  if (cmd === 'snapshot') {
    const l = writeLayout(Date.now());
    console.log(l ? `[loom] snapshot saved: ${l.sessions.length} sessions` : '[loom] no tmux sessions — snapshot skipped');
    return;
  }

  if (cmd !== 'run') {
    console.error(`unknown command: ${cmd}. Usage: chat-manager run | snapshot | restore [--dry-run]`);
    process.exit(1);
  }
  const db = openDb();
  const res = await runPass(db);
  db.close();
  console.log(
    `[chat-manager] scanned ${res.scanned}, changed ${res.changed}, pruned ${res.pruned}; ` +
      `summarized ${res.analyze.succeeded} (${res.analyze.heuristic} heuristic, ${res.analyze.failed} failed); ` +
      `dashboard ${res.dashboard.count} chats -> ${res.dashboard.path}`,
  );
}

// Run main only when invoked directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
