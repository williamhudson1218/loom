import type Database from 'better-sqlite3';
import type { ChatRow } from '../types.ts';
import type { LiveLoc } from '../dashboard.ts';
import { computeSignals } from './signals.ts';
import { detect } from './detectors.ts';
import {
  getEmMode, recordFinding, newFindings, setFindingStatus, type FindingRow,
} from './ledger.ts';
import {
  makeRunner as defaultMakeRunner, transcriptTail, lastAssistantText, buildBlockedPrompt,
  parseBlockedTriage, buildFastFollowPrompt, parseFastFollows, buildHandoffPrompt,
} from './triage.ts';
import { makeActionCtx, writeToPane, fileIssue, wrapUpSession, type ActionCtx } from './actions.ts';
import type { ClaudeRunner } from '../analyzer.ts';
import { agentSessionKey } from '../placements.ts';

// One intervention per (session, detector) per hour. Without it a stuck session
// is re-detected every 30 seconds forever.
export const COOLDOWN_MS = 3_600_000;

function chatRows(db: Database.Database): ChatRow[] {
  return db.prepare(`SELECT * FROM chats`).all() as ChatRow[];
}

// Fast tick. Pure SQL, one stat and one bounded tail-read per chat. No model.
export function scanTick(
  db: Database.Database,
  live: Record<string, LiveLoc>,
  now: number,
  opts: { selfDir?: string } = {},
): number {
  if (getEmMode(db) === 'off') return 0;
  const signals = computeSignals(chatRows(db), live, now, opts);
  let recorded = 0;
  for (const f of detect(signals, now)) {
    if (recordFinding(db, f, COOLDOWN_MS) !== null) recorded++;
  }
  return recorded;
}

export interface TriageDeps {
  live: Record<string, LiveLoc>;
  makeRunner?: (cwd: string) => ClaudeRunner;
  send?: ActionCtx['send'];
  close?: ActionCtx['close'];
  gh?: ActionCtx['gh'];
}

// Slow tick. One model call per NEW finding — never per session, never per tick.
export async function triageTick(db: Database.Database, now: number, deps: TriageDeps): Promise<number> {
  const mode = getEmMode(db);
  if (mode === 'off') return 0;

  const ctx = makeActionCtx(db, mode, now);
  if (deps.send) ctx.send = deps.send;
  if (deps.close) ctx.close = deps.close;
  if (deps.gh) ctx.gh = deps.gh;
  const makeRunner = deps.makeRunner ?? defaultMakeRunner;

  const pending = newFindings(db);
  let handled = 0;

  for (const f of pending) {
    const chat = db
      .prepare(`SELECT * FROM chats WHERE agent = ? AND session_id = ?`)
      .get(f.agent, f.session_id) as ChatRow | undefined;
    if (!chat) {
      setFindingStatus(db, f.id, 'expired');
      continue;
    }
    const pane = deps.live[agentSessionKey(f.agent, f.session_id)] ?? null;
    try {
      await handleFinding(ctx, f, chat, pane, makeRunner(chat.project_dir));
      handled++;
    } catch {
      // A finding that cannot be triaged now is retried on the next pass only if
      // its cooldown has lapsed; leaving it 'new' forever would re-call the model
      // every 5 minutes for the rest of the session.
      setFindingStatus(db, f.id, 'expired');
    }
  }
  return handled;
}

async function handleFinding(
  ctx: ActionCtx,
  f: FindingRow,
  chat: ChatRow,
  pane: LiveLoc | null,
  runner: ClaudeRunner,
): Promise<void> {
  const tail = transcriptTail(chat.agent, chat.jsonl_path);

  if (f.kind === 'BLOCKED') {
    if (!pane) return setFindingStatus(ctx.db, f.id, 'expired');
    const question = lastAssistantText(chat.agent, chat.jsonl_path);
    if (!question) return setFindingStatus(ctx.db, f.id, 'expired');
    const verdict = parseBlockedTriage(await runner(buildBlockedPrompt(question, chat.project_dir, tail)));
    if (verdict.decision === 'escalate') {
      // Phase 2 adds the notification channels; for now the ledger IS the feed.
      setFindingStatus(ctx.db, f.id, 'escalated');
      return;
    }
    writeToPane(ctx, f.id, 'answer', pane, `${verdict.answer} (per ${verdict.citation})`);
    setFindingStatus(ctx.db, f.id, 'acted');
    return;
  }

  if (f.kind === 'WRAPPABLE') {
    if (!pane) return setFindingStatus(ctx.db, f.id, 'expired');
    const follows = parseFastFollows(await runner(buildFastFollowPrompt(tail)));
    // Nothing is dropped, only deferred: every follow-up is filed BEFORE the
    // session is closed, and a failed filing aborts the wrap-up.
    for (const ff of follows) {
      if (!fileIssue(ctx, f.id, chat.project_dir, ff, chat.session_id).ok) {
        setFindingStatus(ctx.db, f.id, 'expired');
        return;
      }
    }
    wrapUpSession(ctx, f.id, pane, chat.session_id, chat.agent);
    setFindingStatus(ctx.db, f.id, 'acted');
    return;
  }

  if (f.kind === 'BLOATED') {
    if (!pane) return setFindingStatus(ctx.db, f.id, 'expired');
    const brief = (await runner(buildHandoffPrompt(tail))).trim();
    // Phase 1 hands the brief to the session itself rather than restarting it:
    // a restart is destructive and its threshold is still uncalibrated. The
    // ledger records the brief either way, which is what Phase 2 needs to judge
    // whether auto-restart is safe.
    writeToPane(
      ctx, f.id, 'brief', pane,
      `Heads up from Loom: this session is near its context limit. Handoff brief for a fresh session: ${brief}`,
    );
    setFindingStatus(ctx.db, f.id, 'acted');
    return;
  }

  // Phase 2 detectors are declared in DetectorKind but never emitted yet.
  setFindingStatus(ctx.db, f.id, 'expired');
}
