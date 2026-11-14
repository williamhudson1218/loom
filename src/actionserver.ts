import type Database from 'better-sqlite3';
import { openDb } from './db.ts';
import { chatFlags, getStep, listSteps, openChains, setStep, stepSummary, type ActionItem } from './actions.ts';
import { closeDecision, evaluateChain, type ActionFacts, type Decision } from './actioneval.ts';
import { buildWakePrompt, type PreSendWork } from './actionsend.ts';
import { logOrch } from './orchestrator.ts';
import type { Snap } from './orchserver.ts';
import { pendingDrafts, readOutbox, type Draft, type SendResult } from './outbox.ts';
import { closeChatDone, restoreChat } from './parked.ts';
import { agentSessionKey } from './placements.ts';
import type { Agent } from './types.ts';
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
  /** Close a chat's pane the Save-for-later way (server.ts: closeChatPane). Absent: close-when-done never closes. */
  closePane?: (agent: string, sid: string) => { found: boolean; ok: boolean };
  /** The outbox's pending drafts. Absent: the real outbox. A throw reads as unknown, which never closes. */
  pendingDrafts?: () => { session_id: string }[];
  /**
   * The board as it is right now (server.ts: snapshot(), what closeChatPane reads). The close path re-checks the
   * chat on it just before closing, since the tick's snapshot can be seconds old. Absent: the tick's snapshot.
   */
  liveSnap?: () => Snap;
  /**
   * Put a wake_chat step's prompt in front of its chat (server.ts: deliverToChat, typed into a live pane or
   * resuming an ended chat). Called at most once per firing. Absent: the step fails, nothing is woken.
   */
  deliver?: (sid: string, prompt: string) => Promise<{ ok: boolean; detail: string }>;
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

/** The agent a session runs under, from the board ('claude' when the board does not know it). */
export function agentOf(snap: Snap, sid: string): string {
  return snap.views.find((v) => v.session_id === sid)?.agent ?? Object.values(snap.live).find((l) => l.session_id === sid)?.agent ?? 'claude';
}

/**
 * What close-when-done needs to know about a chat, or null when Loom cannot tell:
 * a board that has not indexed yet, a pane whose working state was not read, an
 * outbox that could not be read. Null never closes.
 */
export function closeChatFact(snap: Snap, sid: string, drafts: { session_id: string }[] | null): { working: boolean; pendingDrafts: number } | null {
  if (!snap.views.length || !drafts) return null;
  const L = snap.live[agentSessionKey(agentOf(snap, sid) as Agent, sid)];
  // Neither on the board nor in a pane: Loom cannot see this chat, so it cannot say it is idle.
  if (!L && !snap.views.some((v) => v.session_id === sid)) return null;
  if (L && typeof L.working !== 'boolean') return null;
  return { working: !!L?.working, pendingDrafts: drafts.filter((d) => d.session_id === sid).length };
}

/** A step that holds or fails puts its chat back on the board (only a close mark: a plain Remove stays). */
function restoreOnAttention(db: Database.Database, agent: string, sid: string, title: string, status: string | undefined, now: number): void {
  if (status !== 'held' && status !== 'failed') return;
  if (restoreChat(db, agent, sid)) logAction(db, sid, `${title}: ${status}; the chat is back on the board`, now);
}

/** Close when done: every chat with the flag on and not yet closed, closed once its chain is done and it is idle. */
function closeDoneChats(db: Database.Database, snap: Snap, now: number, io: ActionIo): void {
  const closePane = io.closePane;
  if (!closePane) return;
  const sids = (db.prepare(`SELECT session_id FROM action_chats WHERE close_when_done = 1 AND closed_at = 0`).all() as { session_id: string }[]).map((r) => r.session_id);
  if (!sids.length) return;
  let drafts: { session_id: string }[] | null;
  try {
    drafts = (io.pendingDrafts ?? pendingDrafts)();
  } catch {
    drafts = null;
  }
  for (const sid of sids) {
    try {
      const chain = listSteps(db, sid);
      // A send this process started is in flight whatever the row says.
      if (chain.some((s) => sending.has(s.id))) continue;
      const d = closeDecision(chain, chatFlags(db, sid), closeChatFact(snap, sid, drafts));
      if (!d.close) continue;
      // Claim the close first: only the write that flips closed_at from 0 closes the chat.
      if (db.prepare(`UPDATE action_chats SET closed_at = ? WHERE session_id = ? AND closed_at = 0`).run(now, sid).changes !== 1) continue;
      // Re-check on the board as it is now, right before closing: a chat that started a turn or wrote a draft
      // since the tick's snapshot keeps its pane, and the claim is released so the next tick checks again.
      if (!stillIdle(sid, snap, io)) {
        db.prepare(`UPDATE action_chats SET closed_at = 0 WHERE session_id = ? AND closed_at = ?`).run(sid, now);
        continue;
      }
      closeChatDone(db, agentOf(snap, sid), sid, closePane, now);
      logAction(db, sid, 'closed: every step done', now);
    } catch (e) {
      console.error(`[loom] close when done ${sid} failed:`, (e as Error).message);
    }
  }
}

function stillIdle(sid: string, tickSnap: Snap, io: ActionIo): boolean {
  let fresh: Snap;
  let drafts: { session_id: string }[] | null;
  try {
    fresh = io.liveSnap ? io.liveSnap() : tickSnap;
  } catch {
    return false;
  }
  try {
    drafts = (io.pendingDrafts ?? pendingDrafts)();
  } catch {
    drafts = null;
  }
  const c = closeChatFact(fresh, sid, drafts);
  return !!c && !c.working && c.pendingDrafts === 0;
}

type Job =
  | { kind: 'send'; stepId: string; sid: string; agent: string; title: string; draftId: string; ack: string[]; rev: string }
  | { kind: 'redraft'; stepId: string; sid: string; title: string; draftId: string }
  | { kind: 'wake'; stepId: string; sid: string; agent: string; title: string; prompt: string; firedAt: number };

/** Wakes this process is delivering right now. */
const waking = new Set<string>();

function jobOf(d: Decision, sid: string, agent: string, title: string, draftId: string, rev: string): Job | null {
  if (d.effect === 'send' || d.effect === 'send_kept') return { kind: 'send', stepId: d.id, sid, agent, title, draftId, ack: d.ack ?? [], rev };
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
      restoreOnAttention(db, job.agent, job.sid, job.title, 'held', now);
    });
  } catch (e) {
    console.error('[loom] action send bookkeeping failed:', (e as Error).message);
  } finally {
    // Only now: a tick between the send and the write above must still see it in flight.
    sending.delete(job.stepId);
  }
}

async function runWake(job: Extract<Job, { kind: 'wake' }>, io: ActionIo, withDb: NonNullable<ActionIo['withDb']>): Promise<void> {
  try {
    let r: { ok: boolean; detail: string };
    try {
      r = io.deliver ? await io.deliver(job.sid, job.prompt) : { ok: false, detail: 'waking is not available' };
    } catch (e) {
      r = { ok: false, detail: (e as Error).message };
    }
    const now = Date.now();
    withDb((db) => {
      if (r.ok) return logAction(db, job.sid, `${job.title}: woke the chat (${r.detail})`, now);
      // Only this firing's row fails: a step settled or removed meanwhile keeps what it says now.
      const cur = getStep(db, job.stepId);
      if (!cur || cur.status !== 'running' || cur.fired_at !== job.firedAt) {
        logAction(db, job.sid, `${job.title}: couldn't reach the chat after the step left running: ${r.detail}`, now);
        return;
      }
      setStep(db, job.stepId, { status: 'failed', status_why: `couldn't reach the chat: ${r.detail}` });
      logAction(db, job.sid, `${job.title}: couldn't reach the chat: ${r.detail}`, now);
      restoreOnAttention(db, job.agent, job.sid, job.title, 'failed', now);
    });
  } catch (e) {
    console.error('[loom] action wake bookkeeping failed:', (e as Error).message);
  } finally {
    waking.delete(job.stepId);
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

/**
 * Start one wake. The row is claimed from the status the evaluator read (waiting) to running in one conditional
 * write, so a step removed, Run or settled between the read and here is not woken, and a step already running
 * never is: whatever happens after this (a restart mid-delivery, a lost reply), it is delivered at most once.
 */
function wakeStep(db: Database.Database, s: ActionItem, d: Decision, sid: string, agent: string, now: number, jobs: Job[]): void {
  if (waking.has(s.id)) return;
  const p = d.patch;
  const claimed = db
    .prepare(`UPDATE action_items SET status = 'running', fired_at = ?, status_why = ? WHERE id = ? AND status = 'waiting' AND fired_at = ?`)
    .run(p.fired_at ?? now, p.status_why ?? '', s.id, s.fired_at).changes === 1;
  if (!claimed) return;
  waking.add(s.id);
  if (d.log) logAction(db, sid, d.log, now);
  jobs.push({ kind: 'wake', stepId: s.id, sid, agent, title: s.title, prompt: buildWakePrompt(s, d.why ?? ''), firedAt: p.fired_at ?? now });
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
            const job = s ? jobOf(d, sid, agentOf(snap, sid), s.title, draftId, draftId ? facts.draft(draftId)?.revised_at ?? '' : '') : null;
            if (d.effect === 'wake') {
              if (s) wakeStep(db, s, d, sid, agentOf(snap, sid), now, jobs);
              continue;
            }
            // The 2 h timeout never lands on a wake still being delivered.
            if (waking.has(d.id) && d.patch.status === 'failed') continue;
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
            restoreOnAttention(db, agentOf(snap, sid), sid, s?.title ?? d.id, d.patch.status, now);
            if (job) jobs.push(job);
          }
        } catch (e) {
          console.error(`[loom] action chain ${sid} failed:`, (e as Error).message);
        }
      }
      // After the chains, so a step finished this tick is seen done and one that started sending is seen running.
      closeDoneChats(db, snap, now, io);
    });
  } catch (e) {
    console.error('[loom] action tick failed:', (e as Error).message);
    // The rows may not say running: drop the claims and start nothing. A claimed wake row stays running and
    // times out rather than being woken twice.
    for (const j of jobs) if (j.kind === 'send') sending.delete(j.stepId);
    for (const j of jobs) if (j.kind === 'wake') waking.delete(j.stepId);
    jobs.length = 0;
  } finally {
    busy = false;
  }
  for (const j of jobs) void (j.kind === 'send' ? runSend(j, io, withDb) : j.kind === 'wake' ? runWake(j, io, withDb) : runRedraft(j, io, withDb));
}
