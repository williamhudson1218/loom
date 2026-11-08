import type Database from 'better-sqlite3';
import type { Agent } from './types.ts';
import {
  isItemKind,
  isRefType,
  listItems,
  resolveItem,
  startOfDay,
  upsertItem,
  type OrchItem,
  type RelayResult,
} from './orchestrator.ts';
import type { ToolOutcome } from './orchmcp.ts';

export type { ToolOutcome };

// The Loom MCP tools' handlers. The MCP process forwards each call to Loom's
// server (POST /api/orch/tool), which runs it here with the real deps; the tests
// run it with stubs. Every handler returns plain JSON-able data.

export type ChatState = 'working' | 'your_turn' | 'not_running';

export interface ChatInfo {
  chat: string; // agent:session_id
  agent: Agent;
  session_id: string;
  title: string;
  state: ChatState;
  summary: string;
  project: string;
  pane: string; // pane name ('' when not running)
  tmux: string; // session:window.pane ('' when not running)
  stage: string;
  pr: string;
  slack: string[];
  tags: string[];
  last_active_at: number;
  jsonl_path: string;
}

export interface OrchToolDeps {
  chats: () => ChatInfo[];
  tail: (c: ChatInfo, turns: number) => { role: string; text: string }[];
  /** `gh` with these args; rejects when gh is missing or fails. */
  gh: (args: string[]) => Promise<string>;
  /** Loom's cached pipeline for a PR, if it tracks one. */
  cachedPr: (url: string) => unknown;
  slackForChat: (sessionId: string) => { key: string; url: string }[];
  slackOwner: (url: string) => { key: string; url: string; chat: string } | null;
  relay: (agent: Agent, sessionId: string, text: string) => RelayResult;
  withDb: <T>(fn: (db: Database.Database) => T) => T;
  notify: (item: OrchItem) => void;
  now: () => number;
}


type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const fail = (error: string): ToolOutcome => ({ ok: false, error });

function findChat(deps: OrchToolDeps, key: string): ChatInfo | null {
  if (!key) return null;
  const all = deps.chats();
  // Tolerate a bare session id: agents often drop the prefix.
  return all.find((c) => c.chat === key) ?? all.find((c) => c.session_id === key) ?? null;
}

const PR_URL = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/;
const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup';

function rollupChecks(rollup: unknown): { state: string; failing: string[]; pending: number; total: number } {
  const rows = Array.isArray(rollup) ? (rollup as Record<string, unknown>[]) : [];
  const failing: string[] = [];
  let pending = 0;
  for (const r of rows) {
    const c = String(r.conclusion ?? r.state ?? '').toUpperCase();
    const s = String(r.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(c)) failing.push(String(r.name ?? r.context ?? '?'));
    else if (s && s !== 'COMPLETED') pending++;
    else if (c === 'PENDING' || c === 'EXPECTED') pending++;
  }
  const state = failing.length ? 'red' : pending ? 'pending' : rows.length ? 'green' : 'none';
  return { state, failing, pending, total: rows.length };
}

async function prStatus(deps: OrchToolDeps, ref: string): Promise<ToolOutcome> {
  let url = ref;
  if (!PR_URL.test(url)) {
    const c = findChat(deps, ref);
    if (!c) return fail('give a PR URL or a chat key from list_chats');
    if (!c.pr) return fail(`chat ${c.chat} has no PR`);
    url = c.pr;
  }
  url = url.match(PR_URL)![0];
  try {
    const raw = JSON.parse(await deps.gh(['pr', 'view', url, '--json', PR_FIELDS])) as Record<string, unknown>;
    const checks = rollupChecks(raw.statusCheckRollup);
    return {
      ok: true,
      result: {
        url: raw.url ?? url, number: raw.number, title: raw.title,
        state: raw.isDraft ? 'DRAFT' : raw.state, review: raw.reviewDecision || 'NONE', merge: raw.mergeStateStatus,
        checks,
        source: 'gh',
      },
    };
  } catch (e) {
    // No gh, no auth, no network: say so, and give whatever Loom has cached.
    const cached = deps.cachedPr(url);
    return { ok: true, result: { url, source: cached ? 'loom-cache' : 'none', gh_error: (e as Error).message.split('\n')[0].slice(0, 200), cached: cached ?? null } };
  }
}

export async function callOrchTool(deps: OrchToolDeps, name: string, args: Args = {}): Promise<ToolOutcome> {
  switch (name) {
    case 'list_chats': {
      const all = deps.chats();
      const since = deps.now() - 24 * 3_600_000;
      const tag = str(args.tag).toLowerCase();
      const rows = all
        .filter((c) => c.state !== 'not_running' || (args.include_stopped === true && c.last_active_at >= since))
        .filter((c) => !tag || c.tags.some((t) => t.toLowerCase() === tag))
        .map(({ jsonl_path: _j, agent: _a, session_id: _s, ...rest }) => rest);
      return { ok: true, result: { chats: rows, count: rows.length } };
    }
    case 'chat_tail': {
      const c = findChat(deps, str(args.chat));
      if (!c) return fail('unknown chat; use a key from list_chats');
      const n = Math.max(1, Math.min(40, Number(args.turns) || 8));
      const msgs = deps.tail(c, n).map((m) => ({ role: m.role, text: m.text.length > 4000 ? m.text.slice(0, 4000) + '…' : m.text }));
      return { ok: true, result: { chat: c.chat, title: c.title, state: c.state, messages: msgs } };
    }
    case 'pr_status':
      return prStatus(deps, str(args.pr));
    case 'slack_thread': {
      const url = str(args.url);
      if (url) {
        const o = deps.slackOwner(url);
        return { ok: true, result: o ? { owned: true, ...o } : { owned: false, url } };
      }
      const c = findChat(deps, str(args.chat));
      if (!c) return fail('give a chat key or a thread url');
      return { ok: true, result: { chat: c.chat, threads: deps.slackForChat(c.session_id) } };
    }
    case 'send_to_chat': {
      const c = findChat(deps, str(args.chat));
      const text = str(args.text);
      if (!c) return fail('unknown chat; use a key from list_chats');
      if (!text) return fail('text is required');
      const r = deps.relay(c.agent, c.session_id, text);
      return r.status === 'failed' ? fail(r.detail) : { ok: true, result: r };
    }
    case 'list_items': {
      const since = args.include_done === true ? startOfDay(deps.now()) : 0;
      return { ok: true, result: { items: deps.withDb((db) => listItems(db, since)) } };
    }
    case 'upsert_item': {
      if (!isItemKind(args.kind)) return fail('kind must be needs_you, blocked, moving or done');
      if (args.ref_type !== undefined && !isRefType(args.ref_type)) return fail('ref_type must be chat, pr, slack or empty');
      const id = args.id === undefined ? undefined : Number(args.id);
      if (id !== undefined && !Number.isInteger(id)) return fail('id must be an integer');
      const title = str(args.title);
      if (!title && id === undefined) return fail('title is required');
      try {
        const out = deps.withDb((db) =>
          upsertItem(db, {
            id, kind: args.kind as never, title,
            ...(args.ref_type !== undefined ? { ref_type: args.ref_type as never } : {}),
            ...(args.ref_id !== undefined ? { ref_id: str(args.ref_id) } : {}),
            why: str(args.why), who: str(args.who),
          }, deps.now()),
        );
        if (out.becameNeedsYou) deps.notify(out.item);
        return { ok: true, result: { item: out.item, created: out.created } };
      } catch (e) {
        return fail((e as Error).message);
      }
    }
    case 'resolve_item': {
      const id = Number(args.id);
      if (!Number.isInteger(id)) return fail('id must be an integer');
      const item = deps.withDb((db) => resolveItem(db, id, deps.now()));
      return item ? { ok: true, result: { item } } : fail(`no open item ${id}`);
    }
    default:
      return fail(`unknown tool ${name}`);
  }
}
