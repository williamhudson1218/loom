import type { ChatSignal } from '../chatSignals.ts';
import type { Match, Watcher } from '../model.ts';

// The chats source: Loom's own live chats, from the board's snapshot. Every
// trigger is evaluated on each tick, and each match's key names one EPISODE
// (anchored on the transcript's last write, or the pending tool call), so a
// chat sitting in the same state for an hour is one event, not 240.

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** Per watcher, the chats that were mid-turn last tick (became_your_turn is an edge). */
export type TurnMemo = Map<string, Map<string, boolean>>;
export const newTurnMemo = (): TurnMemo => new Map();

/** projects: basename or full path; tags: any of. Empty lists match everything. */
export function chatInScope(w: Watcher, s: ChatSignal): boolean {
  const projects = list(w.source.params.projects);
  const tags = list(w.source.params.tags);
  if (projects.length && !projects.some((p) => p === s.project || p === s.project_dir)) return false;
  if (tags.length && !tags.some((t) => s.tags.includes(t))) return false;
  return true;
}

function match(w: Watcher, s: ChatSignal, episode: string, extra: Record<string, string> = {}): Match {
  const title = s.title || 'untitled';
  return {
    key: `${s.key}@${episode}`,
    subject: `chat:${s.agent}:${s.session_id}`,
    title,
    permalink: '',
    chat: { agent: s.agent, session_id: s.session_id },
    vars: {
      TITLE: title,
      CHAT_TITLE: title,
      PROJECT: s.project,
      PANE: s.pane?.name ?? '',
      IDLE_MIN: String(Math.round(s.idleMs / 60_000)),
      ...extra,
    },
  };
}

/**
 * The matches for one chats watcher this tick. `test` evaluates the edge
 * trigger on current state instead (Test has no previous tick to compare with).
 */
export function evaluateChats(w: Watcher, signals: ChatSignal[], now: number, memo: TurnMemo, opts: { test?: boolean } = {}): Match[] {
  const p = w.trigger.params;
  const out: Match[] = [];
  let prev = memo.get(w.id);
  const first = !prev;
  if (!prev) {
    prev = new Map();
    if (!opts.test) memo.set(w.id, prev);
  }
  const next = new Map<string, boolean>();
  for (const s of signals) {
    if (!s.live || !chatInScope(w, s)) continue;
    const idle = s.live && !s.working;
    switch (w.trigger.kind) {
      case 'blocked_on_tool': {
        const min = num(p.min, 5) * 60_000;
        if (s.pendingToolSince > 0 && now - s.pendingToolSince >= min) out.push(match(w, s, `tool${s.pendingToolSince}`, { WAITING_MIN: String(Math.round((now - s.pendingToolSince) / 60_000)) }));
        break;
      }
      case 'waiting_on_user': {
        // A pane waiting for days is abandoned, not blocked: max_h bounds it.
        if (idle && s.state === 'waiting_on_user' && s.idleMs > num(p.min_sec, 90) * 1000 && s.idleMs < num(p.max_h, 24) * 3_600_000) out.push(match(w, s, `wait${s.lastActive}`));
        break;
      }
      case 'done_idle': {
        if (idle && s.state === 'done' && s.idleMs > num(p.min, 10) * 60_000) out.push(match(w, s, `done${s.lastActive}`));
        break;
      }
      case 'context_over': {
        // Fires while working too: context only grows, so waiting for idle means
        // waiting through the degraded turns this exists to prevent.
        if (s.context && s.context.fraction >= num(p.fraction, 0.85)) {
          out.push(match(w, s, 'ctx', { PERCENT: String(Math.round(s.context.fraction * 100)), TOKENS: String(s.context.tokens), LIMIT: String(s.context.limit) }));
        }
        break;
      }
      case 'silent_mid_turn': {
        if (s.working && s.idleMs >= num(p.min, 10) * 60_000) out.push(match(w, s, `silent${s.lastActive}`, { SILENT_MIN: String(Math.round(s.idleMs / 60_000)) }));
        break;
      }
      case 'became_your_turn': {
        next.set(s.key, s.working);
        // The first sighting only records: an event is a change Loom saw, never a state it found on startup.
        const was = prev.get(s.key);
        if (opts.test ? idle && !!s.state : !first && was === true && idle) out.push(match(w, s, `turn${s.lastActive}`));
        break;
      }
    }
  }
  if (w.trigger.kind === 'became_your_turn' && !opts.test) memo.set(w.id, next);
  return out;
}
