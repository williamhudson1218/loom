import type Database from 'better-sqlite3';
import { openDb } from './db.ts';
import { getStep, openChains, setStep, stepSummary } from './actions.ts';
import { evaluateChain, type ActionFacts, type Decision } from './actioneval.ts';
import type { PreSendWork } from './actionsend.ts';
import { logOrch } from './orchestrator.ts';
import type { Snap } from './orchserver.ts';
import { readOutbox, type Draft, type SendResult } from './outbox.ts';
import { pipelineHealth, prFactOf, wantPipeline } from './pipeline.ts';
import { readMarks } from './redraft.ts';
import { FRESH_TTL_MS, type FreshResult, type FreshTarget } from './outboxfresh.ts';
import { stamp } from './outbox.ts';
import { slackFeatureOn, slackOffDetail } from './slackmode.ts';

// The server half of action items: facts from the live world, and the 15s tick
// that applies the evaluator's decisions. server.ts calls actionTick right
// after orchTick on the same snapshot.

export interface ActionIo {
  facts?: (snap: Snap, now: number) => ActionFacts;
  withDb?: <T>(fn: (db: Database.Database) => T) => T;
  /** The pre-send check (server.ts builds the real one). Absent: every check reads pending, so nothing sends. */
  preSend?: PreSendWork;
  /** Read a slack_reply step's thread (server.ts builds the real one). Absent: replies stay pending. */
  fresh?: ActionFactsOpts['fresh'];
  /**
   * Post a draft as the person: the outbox's own send path. `rev` is the revision
   * the pre-send check read; a draft changed since is refused. Absent: refused.
   */
  send?: (draftId: string, ack: string[], rev: string) => Promise<SendResult>;
  /** Ask the chat that owns the draft to redraft it (the outbox card's Redraft). Absent: refused. */
  redraft?: (draftId: string) => Promise<{ ok: boolean; detail: string }>;
  /** The draft as it is now, for the hold after a failed send. */
  readDraft?: (draftId: string) => Draft | undefined;
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

/** Steps whose send this process started and has not finished. Lost on restart, which is the point. */
const sending = new Set<string>();

export const sendInFlight = (stepId: string): boolean => sending.has(stepId);

type RepliesEntry = { at: number; r: FreshResult | null; p: Promise<void> | null };
const repliesByStep = new Map<string, RepliesEntry>();

/** Forget every cached thread read (tests). */
export function _resetReplies(): void {
  repliesByStep.clear();
}

export interface ActionFactsOpts {
  preSend?: PreSendWork;
  slackOff?: () => string;
  /** Read a thread's new messages (server.ts: cachedFresh over the live Slack reads). Absent: a step's replies stay pending. */
  fresh?: (t: FreshTarget, key: string) => Promise<FreshResult>;
}

export function actionFacts(_snap: Snap, now: number, opts: ActionFactsOpts = {}): ActionFacts {
  let drafts: ReturnType<typeof readOutbox> | null = null;
  let marks: ReturnType<typeof readMarks> | null = null;
  let off: string | null = null;
  const all = () => {
    try {
      drafts ??= readOutbox();
    } catch {
      drafts = {};
    }
    return drafts;
  };
  const facts: ActionFacts = {
    pr: (repo, n) => {
      // Register interest so the pipeline tick fetches a PR no chat is showing.
      const p = wantPipeline(repo, n, false, now);
      if (p) return prFactOf(p);
      const h = pipelineHealth(repo, n);
      return h && h.errors > 0 ? { error: h.lastError || 'could not read the PR' } : null;
    },
    draft: (id) => {
      const d = all()[id];
      if (!d) return null;
      return { status: d.status, kind: d.review ? 'review' : d.kind === 'email' ? 'email' : 'slack', revised_at: d.revised_at ?? '' };
    },
    preSend: (id) => {
      const d = all()[id];
      if (!d || d.status !== 'pending' || !opts.preSend) return { decision: 'pending' };
      return opts.preSend.check(d);
    },
    redraftMark: (id) => {
      try {
        marks ??= readMarks();
      } catch {
        marks = {};
      }
      return marks[id];
    },
    sendInFlight,
    replies: (s) => {
      if (facts.slackOff()) return 'off';
      if (!opts.fresh) return 'pending';
      // The baseline is the moment the step became current: a reply before it is never seen.
      const key = `action:${s.id}:${s.current_at}`;
      let e = repliesByStep.get(key);
      if (!e) repliesByStep.set(key, (e = { at: 0, r: null, p: null }));
      if (!e.p && (!e.r || now - e.at >= FRESH_TTL_MS)) {
        const entry = e;
        const t: FreshTarget = {
          channel: String(s.trigger_params.channel ?? ''),
          thread_ts: String(s.trigger_params.thread_ts ?? ''),
          thread_url: String(s.trigger_params.thread_url ?? ''),
          created_at: stamp(s.current_at),
          seen: { at: s.current_at, slack: (s.current_at / 1000).toFixed(6) },
        };
        entry.p = opts
          .fresh(t, key)
          .catch((x: Error): FreshResult => ({ ok: false, error: x?.message || 'unknown error', items: [] }))
          .then((r) => {
            entry.r = r;
            entry.at = now;
          })
          .finally(() => {
            entry.p = null;
          });
      }
      const r = e.r;
      if (!r) return 'pending';
      return r.ok ? { items: r.items } : { error: r.error };
    },
    answers: (s, item) => {
      const q = String(s.trigger_params.answers ?? '');
      return q && opts.preSend ? opts.preSend.answers(s.id, q, item) : 'unavailable';
    },
    slackOff: () => {
      if (off !== null) return off;
      try {
        off = opts.slackOff ? opts.slackOff() : slackFeatureOn('send') ? '' : slackOffDetail();
      } catch (e) {
        // Unknown is off: a step never sends on a setting Loom could not read.
        off = 'could not read the Slack setting: ' + (e as Error).message;
      }
      return off;
    },
  };
  return facts;
}

/** Every draft an open send_draft step refers to: the outbox never supersedes these. */
export function scheduledDraftIds(db: Database.Database): Set<string> {
  const out = new Set<string>();
  for (const chain of openChains(db).values()) {
    for (const s of chain) {
      if (s.action_type === 'send_draft' && s.status !== 'done' && s.status !== 'removed' && s.action_params.draft_id) out.add(String(s.action_params.draft_id));
    }
  }
  return out;
}

/** The outbox card's "Scheduled" line, per pending draft an open send_draft step will send. */
export function scheduledDrafts(db: Database.Database): Map<string, { step_id: string; label: string }> {
  const out = new Map<string, { step_id: string; label: string }>();
  for (const chain of openChains(db).values()) {
    for (const s of chain) {
      if (s.action_type !== 'send_draft' || s.status === 'done' || s.status === 'removed') continue;
      const id = String(s.action_params.draft_id ?? '');
      if (!id || out.has(id)) continue;
      const when = stepSummary(s).split(' → ')[0];
      const phrase = s.trigger_type === 'now' ? 'now' : s.trigger_type === 'manual' ? 'checked off' : when.replace(/^When /, '');
      out.set(id, { step_id: s.id, label: `Scheduled: sends when ${phrase}` });
    }
  }
  return out;
}

type Job = { kind: 'send'; stepId: string; sid: string; title: string; draftId: string; ack: string[]; rev: string } | { kind: 'redraft'; stepId: string; sid: string; title: string; draftId: string };

function jobOf(d: Decision, sid: string, title: string, draftId: string, rev: string): Job | null {
  if (d.effect === 'send' || d.effect === 'send_kept') return { kind: 'send', stepId: d.id, sid, title, draftId, ack: d.ack ?? [], rev };
  if (d.effect === 'redraft') return { kind: 'redraft', stepId: d.id, sid, title, draftId };
  return null;
}

async function runSend(job: Extract<Job, { kind: 'send' }>, io: ActionIo, withDb: NonNullable<ActionIo['withDb']>): Promise<void> {
  try {
    let r: SendResult;
    try {
      r = io.send ? await io.send(job.draftId, job.ack, job.rev) : { ok: false, detail: 'sending is not available' };
    } catch (e) {
      r = { ok: false, detail: 'send failed: ' + (e as Error).message };
    }
    const now = Date.now();
    withDb((db) => {
      const cur = getStep(db, job.stepId);
      if (!cur || cur.status !== 'running') {
        logAction(db, job.sid, `${job.title}: send ${r.ok ? 'finished' : 'failed'} after the step left running`, now);
        return;
      }
      if (r.ok) {
        setStep(db, job.stepId, { status: 'done', status_why: 'sent', done_at: now });
        logAction(db, job.sid, `${job.title}: sent`, now);
        return;
      }
      // Pin the hold to the checked revision, so a draft the chat replaced meanwhile is checked again.
      // A burst that went out part-way changed the revision itself: hold on that, for a person to look.
      let rev = job.rev;
      if (r.partial) {
        try {
          rev = (io.readDraft ?? ((x: string) => readOutbox()[x]))(job.draftId)?.revised_at ?? '';
        } catch {
          rev = job.rev;
        }
      }
      setStep(db, job.stepId, { status: 'held', status_why: `held: ${r.detail}`, held_rev: rev, held_at: 0 });
      logAction(db, job.sid, `${job.title}: send held: ${r.detail}`, now);
    });
  } catch (e) {
    console.error('[loom] action send bookkeeping failed:', (e as Error).message);
  } finally {
    // Only now: a tick between the send and the write above must still see it in flight.
    sending.delete(job.stepId);
  }
}

async function runRedraft(job: Extract<Job, { kind: 'redraft' }>, io: ActionIo, withDb: NonNullable<ActionIo['withDb']>): Promise<void> {
  let r: { ok: boolean; detail: string };
  try {
    r = io.redraft ? await io.redraft(job.draftId) : { ok: false, detail: 'redraft is not available' };
  } catch (e) {
    r = { ok: false, detail: (e as Error).message };
  }
  try {
    const now = Date.now();
    withDb((db) => {
      if (r.ok) return logAction(db, job.sid, `${job.title}: asked the chat to redraft`, now);
      const cur = getStep(db, job.stepId);
      if (cur?.status === 'held') setStep(db, job.stepId, { status_why: `${cur.status_why}; redraft failed: ${r.detail}` });
      logAction(db, job.sid, `${job.title}: redraft failed: ${r.detail}`, now);
    });
  } catch (e) {
    console.error('[loom] action redraft bookkeeping failed:', (e as Error).message);
  }
}

let busy = false;

/** One pass over every open chain. Never throws; a second overlapping call returns at once. Sends and redrafts run after it, unawaited. */
export async function actionTick(snap: Snap, now: number = Date.now(), io: ActionIo = {}): Promise<void> {
  if (busy) return;
  busy = true;
  const withDb = io.withDb ?? realWithDb;
  const jobs: Job[] = [];
  try {
    io.preSend?.beginTick();
    const facts = (io.facts ?? ((s, n) => actionFacts(s, n, { preSend: io.preSend, fresh: io.fresh })))(snap, now);
    withDb((db) => {
      for (const [sid, chain] of openChains(db)) {
        // One bad chain must not stop the ones after it.
        try {
          for (const d of evaluateChain(chain, facts, now)) {
            const s = chain.find((x) => x.id === d.id);
            const draftId = String(s?.action_params.draft_id ?? '');
            // A send claims its step in memory before the row says running, so no tick can read it as interrupted.
            const job = s ? jobOf(d, sid, s.title, draftId, draftId ? facts.draft(draftId)?.revised_at ?? '' : '') : null;
            if (job?.kind === 'send') {
              if (sending.has(job.stepId)) continue; // never two sends for one step
              sending.add(job.stepId);
            }
            try {
              setStep(db, d.id, d.patch);
            } catch (e) {
              if (job?.kind === 'send') sending.delete(job.stepId);
              throw e;
            }
            if (d.log) logAction(db, sid, d.log, now);
            if (job) jobs.push(job);
          }
        } catch (e) {
          console.error(`[loom] action chain ${sid} failed:`, (e as Error).message);
        }
      }
    });
  } catch (e) {
    console.error('[loom] action tick failed:', (e as Error).message);
    // The rows may not say running: drop the claims and start nothing.
    for (const j of jobs) if (j.kind === 'send') sending.delete(j.stepId);
    jobs.length = 0;
  } finally {
    busy = false;
  }
  for (const j of jobs) void (j.kind === 'send' ? runSend(j, io, withDb) : runRedraft(j, io, withDb));
}
