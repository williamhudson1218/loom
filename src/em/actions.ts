import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { sendToPane, closeSession, type GotoResult } from '../goto.ts';
import type { LiveLoc } from '../dashboard.ts';
import { recordAction, paneWritesSince, type EmMode } from './ledger.ts';
import type { FastFollow } from './triage.ts';
import type { Agent } from '../types.ts';

// Bounds the blast radius of a miscalibrated detector to something recoverable.
export const RATE_LIMIT_PER_HOUR = 30;
const HOUR = 3_600_000;

export type GhRunner = (args: string[], cwd: string) => string;

export interface ActionCtx {
  db: Database.Database;
  mode: EmMode;
  now: number;
  send: (paneId: string, text: string, agent: Agent) => GotoResult;
  close: (paneId: string, agent: Agent) => GotoResult;
  gh: GhRunner;
}

const defaultGh: GhRunner = (args, cwd) =>
  execFileSync('gh', args, { cwd, encoding: 'utf-8', timeout: 60_000 });

export function makeActionCtx(db: Database.Database, mode: EmMode, now: number): ActionCtx {
  return { db, mode, now, send: sendToPane, close: closeSession, gh: defaultGh };
}

// THE shadow chokepoint. Every intervention routes through here, so shadow mode
// is one branch rather than a rule each action has to remember.
export function perform(
  ctx: ActionCtx,
  findingId: number,
  kind: string,
  payload: string,
  exec: () => string,
): { executed: boolean; result: string } {
  if (ctx.mode === 'off') return { executed: false, result: 'off' };

  if (ctx.mode === 'shadow') {
    recordAction(ctx.db, { finding_id: findingId, kind, payload, shadow: 1, result: 'shadow', taken_at: ctx.now });
    return { executed: false, result: 'shadow' };
  }

  let result: string;
  try {
    result = exec();
  } catch (e) {
    result = 'error: ' + (e as Error).message;
  }
  recordAction(ctx.db, { finding_id: findingId, kind, payload, shadow: 0, result, taken_at: ctx.now });
  return { executed: true, result };
}

export function writeToPane(
  ctx: ActionCtx,
  findingId: number,
  kind: string,
  pane: LiveLoc,
  text: string,
): { executed: boolean; result: string } {
  if (ctx.mode === 'live' && paneWritesSince(ctx.db, ctx.now - HOUR) >= RATE_LIMIT_PER_HOUR) {
    recordAction(ctx.db, {
      finding_id: findingId, kind, payload: text, shadow: 1,
      result: 'suppressed: hourly pane-write limit reached', taken_at: ctx.now,
    });
    return { executed: false, result: 'rate-limited' };
  }
  return perform(ctx, findingId, kind, text, () => {
    const r = ctx.send(pane.pane_id, text, pane.agent);
    if (!r.ok) throw new Error(r.detail);
    return r.detail;
  });
}

export function repoSlug(projectDir: string, gh: GhRunner): string | null {
  try {
    const out = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], projectDir).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Files a fast-follow on the session's OWN repo, linking back to the Loom session
// so the issue can be traced to the conversation that produced it.
export function fileIssue(
  ctx: ActionCtx,
  findingId: number,
  projectDir: string,
  ff: FastFollow,
  sessionId: string,
): { ok: boolean; url: string } {
  const body = [
    ff.body,
    '',
    '---',
    `Filed by the Loom EM from session \`${sessionId}\`.`,
  ].join('\n');

  const args = ['issue', 'create', '--title', ff.title, '--body', body, '--label', 'fast-follow'];
  const r = perform(ctx, findingId, 'issue', `${ff.title}\n\n${body}`, () => ctx.gh(args, projectDir).trim());

  if (!r.executed) return { ok: ctx.mode === 'shadow', url: '' };
  if (r.result.startsWith('error:')) return { ok: false, url: '' };
  return { ok: true, url: r.result };
}

// Wrap up a finished session: mark it saved (exempt from the 7-day prune, pinned
// in the dashboard's Saved section) and free its pane. Callers MUST have filed
// the session's fast-follows first — nothing is dropped, only deferred.
export function wrapUpSession(
  ctx: ActionCtx,
  findingId: number,
  pane: LiveLoc,
  sessionId: string,
  agent: Agent,
): { executed: boolean; result: string } {
  return perform(ctx, findingId, 'wrapup', `save + close ${sessionId}`, () => {
    ctx.db.prepare(`UPDATE chats SET saved = 1, saved_at = ? WHERE agent = ? AND session_id = ?`)
      .run(ctx.now, agent, sessionId);
    const r = ctx.close(pane.pane_id, agent);
    if (!r.ok) throw new Error(r.detail);
    return 'saved and closed';
  });
}
