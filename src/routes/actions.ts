import type Database from 'better-sqlite3';
import { openDb as realOpenDb } from '../db.ts';
import { addStep, chatFlags, getStep, listSteps, newStepId, setStep } from '../actions.ts';
import { logAction } from '../actionserver.ts';
import { readOutbox } from '../outbox.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// The Actions panel's routes. The panel reads one chat's steps and makes small
// edits to them (add, check off, remove and undo, ask-first, run, retry). The
// evaluator in src/actionserver.ts owns everything that fires on a trigger;
// nothing here sends or wakes anything. Run on a send_draft step only approves
// it: the next tick runs the pre-send check and sends or holds.

interface ActionsDeps {
  openDb(): Database.Database;
  now(): number;
  /** A draft's current revision and status, for pinning a Run to the text it was clicked on. */
  draft(id: string): { status: string; revised_at: string } | null;
}
let deps: ActionsDeps = {
  openDb: () => realOpenDb(),
  now: () => Date.now(),
  draft: (id) => {
    const d = readOutbox()[id];
    return d ? { status: d.status, revised_at: d.revised_at ?? '' } : null;
  },
};

export function setActionsDeps(over: Partial<ActionsDeps>): ActionsDeps {
  const prev = deps;
  deps = { ...deps, ...over };
  return prev;
}

function withDb<T>(f: (db: Database.Database) => T): T {
  const db = deps.openDb();
  try {
    return f(db);
  } finally {
    db.close();
  }
}

/** `/api/data`'s `actions`: per chat, the steps still open and whether one needs a person. */
export function actionSummary(db: Database.Database): Record<string, { open: number; attention: boolean }> {
  const rows = db
    .prepare(
      `SELECT session_id, COUNT(*) AS open, MAX(status IN ('held', 'failed')) AS attention
       FROM action_items WHERE status NOT IN ('done', 'removed') GROUP BY session_id`,
    )
    .all() as { session_id: string; open: number; attention: number }[];
  const out: Record<string, { open: number; attention: boolean }> = {};
  for (const r of rows) out[r.session_id] = { open: r.open, attention: !!r.attention };
  return out;
}

const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '');
const TITLE_MAX = 300;

function getActions({ url, json }: RouteCtx): void {
  const sid = str(url.searchParams.get('session'), 200);
  if (!sid) return json(400, { ok: false, detail: 'session is required' });
  withDb((db) => json(200, { ok: true, steps: listSteps(db, sid, { all: true }), close_when_done: chatFlags(db, sid).close_when_done }));
}

async function postAdd({ json, body }: RouteCtx): Promise<void> {
  const b = (await body()) ?? {};
  const session = str(b.session, 200);
  const title = str(b.title, TITLE_MAX);
  if (!session) return json(400, { ok: false, detail: 'session is required' });
  if (!title) return json(400, { ok: false, detail: 'title is required' });
  const id = newStepId();
  withDb((db) => addStep(db, { id, session_id: session, title, when: 'manual', then: 'none', ask_first: false, created_by: 'user', at: deps.now() }));
  json(200, { ok: true, id });
}

/** Look the step up, or answer 400 / 404 and return null. */
function target(ctx: RouteCtx, b: Record<string, unknown> | null, db: Database.Database) {
  const id = str(b?.id, 40);
  if (!id) {
    ctx.json(400, { ok: false, detail: 'id is required' });
    return null;
  }
  const s = getStep(db, id);
  if (!s) {
    ctx.json(404, { ok: false, detail: 'no such step' });
    return null;
  }
  return s;
}

const isFinal = (status: string): boolean => status === 'done' || status === 'removed';

async function postCheck(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  withDb((db) => {
    const s = target(ctx, b, db);
    if (!s) return;
    if (isFinal(s.status)) return ctx.json(409, { ok: false, detail: `already ${s.status}` });
    const now = deps.now();
    setStep(db, s.id, { status: 'done', status_why: '', done_at: now });
    logAction(db, s.session_id, `Checked off: ${s.title}`, now);
    ctx.json(200, { ok: true });
  });
}

async function postRemove(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  withDb((db) => {
    const s = target(ctx, b, db);
    if (!s) return;
    if (s.status === 'removed') return ctx.json(409, { ok: false, detail: 'already removed' });
    setStep(db, s.id, { status: 'removed', removed_from: s.status });
    ctx.json(200, { ok: true });
  });
}

async function postUndo(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  withDb((db) => {
    const s = target(ctx, b, db);
    if (!s) return;
    if (s.status !== 'removed') return ctx.json(409, { ok: false, detail: 'not removed' });
    const to = s.removed_from || 'waiting';
    // A send_draft step's Run approval does not survive a remove: back in the chain, it asks again.
    setStep(db, s.id, { status: to, removed_from: '', ...(to === 'waiting' && s.action_type === 'send_draft' ? { fired_at: 0, approved_rev: '' } : {}) });
    ctx.json(200, { ok: true });
  });
}

async function postAskFirst(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  withDb((db) => {
    const s = target(ctx, b, db);
    if (!s) return;
    setStep(db, s.id, { ask_first: b?.on === true });
    ctx.json(200, { ok: true });
  });
}

const NOT_YET = { ok: false, detail: 'not available yet' };

async function postRun(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  withDb((db) => {
    const s = target(ctx, b, db);
    if (!s) return;
    if (s.action_type === 'wake_chat') return ctx.json(409, NOT_YET);
    if (isFinal(s.status)) return ctx.json(409, { ok: false, detail: `already ${s.status}` });
    const now = deps.now();
    if (s.action_type === 'send_draft') {
      // Approve only: the tick checks the thread first, then sends or holds. fired_at on a waiting step is the approval.
      if (s.status !== 'due') return ctx.json(409, { ok: false, detail: `nothing to run: the step is ${s.status}` });
      const d = deps.draft(String(s.action_params.draft_id ?? ''));
      if (!d || d.status !== 'pending') return ctx.json(409, { ok: false, detail: d ? `the draft is ${d.status}` : 'draft not found' });
      setStep(db, s.id, { status: 'waiting', status_why: 'checking the thread before sending', fired_at: now, approved_rev: d.revised_at });
      logAction(db, s.session_id, `Run: ${s.title}`, now);
      return ctx.json(200, { ok: true });
    }
    setStep(db, s.id, { status: 'done', status_why: '', fired_at: now, done_at: now });
    logAction(db, s.session_id, `Done: ${s.title}`, now);
    ctx.json(200, { ok: true });
  });
}

async function postRetry(ctx: RouteCtx): Promise<void> {
  const b = await ctx.body();
  withDb((db) => {
    const s = target(ctx, b, db);
    if (!s) return;
    if (s.action_type === 'wake_chat') return ctx.json(409, NOT_YET);
    if (s.status !== 'failed' && s.status !== 'held') return ctx.json(409, { ok: false, detail: 'nothing to retry' });
    // fired_at back to 0: a retried step fires on its trigger again, and an ask-first step asks for Run again.
    setStep(db, s.id, { status: 'waiting', status_why: '', held_rev: '', held_at: 0, fired_at: 0, approved_rev: '', attempts: s.attempts + 1 });
    ctx.json(200, { ok: true });
  });
}

const post = (p: string, handler: RouteDef['handler']): RouteDef => ({ method: 'POST', path: `/api/actions/${p}`, kind: 'browser', handler });

export const routes: RouteDef[] = [
  { method: 'GET', path: '/api/actions', kind: 'read', handler: getActions },
  post('add', postAdd),
  post('check', postCheck),
  post('remove', postRemove),
  post('undo', postUndo),
  post('ask-first', postAskFirst),
  post('run', postRun),
  post('retry', postRetry),
];
