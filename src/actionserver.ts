import type Database from 'better-sqlite3';
import { openDb } from './db.ts';
import { openChains, setStep } from './actions.ts';
import { evaluateChain, type ActionFacts } from './actioneval.ts';
import { logOrch } from './orchestrator.ts';
import type { Snap } from './orchserver.ts';
import { readOutbox } from './outbox.ts';
import { pipelineHealth, prFactOf, wantPipeline } from './pipeline.ts';

// The server half of action items: facts from the live world, and the 15s tick
// that applies the evaluator's decisions. server.ts calls actionTick right
// after orchTick on the same snapshot.

export interface ActionIo {
  facts?: (snap: Snap, now: number) => ActionFacts;
  withDb?: <T>(fn: (db: Database.Database) => T) => T;
}

function realWithDb<T>(fn: (db: Database.Database) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function logAction(db: Database.Database, target: string, text: string, now: number): void {
  logOrch(db, 'action', target, text, now);
}

export function actionFacts(_snap: Snap, now: number): ActionFacts {
  let drafts: ReturnType<typeof readOutbox> | null = null;
  return {
    pr: (repo, n) => {
      // Register interest so the pipeline tick fetches a PR no chat is showing.
      const p = wantPipeline(repo, n, false, now);
      if (p) return prFactOf(p);
      const h = pipelineHealth(repo, n);
      return h && h.errors > 0 ? { error: h.lastError || 'could not read the PR' } : null;
    },
    draft: (id) => {
      try {
        drafts ??= readOutbox();
      } catch {
        drafts = {};
      }
      const d = drafts[id];
      if (!d) return null;
      return { status: d.status, kind: d.review ? 'review' : d.kind === 'email' ? 'email' : 'slack', revised_at: d.revised_at ?? '' };
    },
  };
}

let busy = false;

/** One pass over every open chain. Never throws; a second overlapping call returns at once. */
export async function actionTick(snap: Snap, now: number = Date.now(), io: ActionIo = {}): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    const facts = (io.facts ?? actionFacts)(snap, now);
    (io.withDb ?? realWithDb)((db) => {
      for (const [sid, chain] of openChains(db)) {
        for (const d of evaluateChain(chain, facts, now)) {
          setStep(db, d.id, d.patch);
          if (d.log) logAction(db, sid, d.log, now);
        }
      }
    });
  } catch (e) {
    console.error('[loom] action tick failed:', (e as Error).message);
  } finally {
    busy = false;
  }
}
