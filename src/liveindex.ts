// Index live sessions as soon as they appear, instead of waiting for the 10-minute
// full pass. A live pane whose session has no `chats` row is invisible in the
// sidebar (it renders indexed chats only), so the fast tick feeds the live map in
// here: an unknown session is indexed at once, an indexed one is re-indexed when
// its transcript moves past what the row holds (throttled per chat). One parse at a
// time, async, so a burst of new sessions never blocks the main process.
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { CLAUDE_PROJECTS_DIR, encodeProjectDir } from './paths.ts';
import { openDb } from './db.ts';
import { upsertChat } from './indexer.ts';
import { parseJsonlFile } from './parser.ts';
import type { ChatView } from './dashboard.ts';
import type { ParsedChat } from './types.ts';

export const REINDEX_THROTTLE_MS = 30_000;

export interface LiveRef {
  agent: string;
  session_id: string;
  pane_id?: string;
  cwd?: string;
  name?: string;
}

/** Where a Claude transcript lives: the cwd's project dir first, else any project dir. */
export function locateTranscript(sessionId: string, cwd = '', root = CLAUDE_PROJECTS_DIR): string | null {
  const file = `${sessionId}.jsonl`;
  if (cwd) {
    const p = path.join(root, encodeProjectDir(cwd), file);
    if (fs.existsSync(p)) return p;
  }
  try {
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, file);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* no projects dir */
  }
  return null;
}

export interface LiveIndexerDeps {
  locate: (sessionId: string, cwd: string) => string | null;
  mtimeOf: (file: string) => number | null;
  index: (file: string, mtime: number, now: number) => Promise<void>;
}

const realDeps: LiveIndexerDeps = {
  locate: (sid, cwd) => locateTranscript(sid, cwd),
  mtimeOf: (f) => {
    try {
      return Math.floor(fs.statSync(f).mtimeMs);
    } catch {
      return null;
    }
  },
  index: async (file, mtime, now) => {
    const parsed: ParsedChat = await parseJsonlFile(file);
    if (!parsed.session_id) return;
    const db = openDb();
    try {
      upsertChat(db, parsed, mtime, now);
    } finally {
      db.close();
    }
  },
};

export class LiveIndexer {
  private busy = false;
  private lastTry = new Map<string, number>();
  constructor(private deps: LiveIndexerDeps = realDeps) {}

  /**
   * Decide what needs indexing and index at most ONE transcript (the oldest unknown
   * first). Returns the session key it started, or null. `indexed` maps
   * agent:session_id to the indexed jsonl_mtime.
   */
  tick(live: LiveRef[], indexed: Map<string, number>, now = Date.now(), exclude: (l: LiveRef) => boolean = () => false): { key: string; done: Promise<void> } | null {
    if (this.busy) return null;
    const candidates: { key: string; file: string; mtime: number; unknown: boolean }[] = [];
    for (const l of live) {
      if (l.agent !== 'claude' || exclude(l)) continue; // codex transcripts are dated paths; the full pass takes them
      const key = `${l.agent}:${l.session_id}`;
      const have = indexed.get(key);
      const last = this.lastTry.get(key) ?? -Infinity;
      // An unknown session retries every 5s tick only after a short back-off, so a
      // transcript that does not exist yet (or fails to parse) is not hammered.
      if (now - last < (have === undefined ? 4_000 : REINDEX_THROTTLE_MS)) continue;
      const file = this.deps.locate(l.session_id, l.cwd ?? '');
      if (!file) continue;
      const mtime = this.deps.mtimeOf(file);
      if (mtime === null) continue;
      if (have !== undefined && mtime <= have) continue;
      candidates.push({ key, file, mtime, unknown: have === undefined });
    }
    if (!candidates.length) return null;
    candidates.sort((a, b) => Number(b.unknown) - Number(a.unknown));
    const c = candidates[0];
    this.busy = true;
    this.lastTry.set(c.key, now);
    const done = this.deps
      .index(c.file, c.mtime, now)
      .catch(() => {})
      .finally(() => {
        this.busy = false;
      });
    return { key: c.key, done };
  }
}

/** The indexed mtime per agent:session_id. */
export function indexedMtimes(db: Database.Database): Map<string, number> {
  const rows = db.prepare(`SELECT agent, session_id, jsonl_mtime FROM chats`).all() as { agent: string; session_id: string; jsonl_mtime: number }[];
  return new Map(rows.map((r) => [`${r.agent}:${r.session_id}`, r.jsonl_mtime]));
}

// ---- provisional rows ---------------------------------------------------------

/** The first real user prompt in the head of a transcript, '' if none. */
export function firstPromptOf(file: string): string {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    for (const line of buf.toString('utf-8', 0, n).split('\n')) {
      if (!line.startsWith('{')) continue;
      let o: { type?: string; isMeta?: boolean; message?: { content?: unknown } };
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o.type !== 'user' || o.isMeta) continue;
      const c = o.message?.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((p) => p?.type === 'text')?.text ?? '') : '';
      if (text && !text.startsWith('<')) return String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
    }
  } catch {
    /* unreadable */
  }
  return '';
}

export interface SpawnTitle {
  pane_id: string;
  title: string;
  spawned_at: number;
}

export function spawnTitles(db: Database.Database): SpawnTitle[] {
  try {
    return db.prepare(`SELECT pane_id, title, spawned_at FROM watcher_spawns WHERE status = 'spawned' AND pane_id != '' ORDER BY spawned_at DESC LIMIT 100`).all() as SpawnTitle[];
  } catch {
    return [];
  }
}

export type ProvisionalView = ChatView & { provisional: true };

/**
 * A row for each live session with no chat row yet, so it shows in the sidebar
 * the moment its pane is up. Replaced by the real row once indexed.
 */
export function provisionalViews(
  views: Pick<ChatView, 'agent' | 'session_id'>[],
  live: Record<string, LiveRef>,
  spawns: SpawnTitle[],
  now: number,
  opts: { exclude?: (l: LiveRef) => boolean; locate?: (sid: string, cwd: string) => string | null; firstPrompt?: (f: string) => string; mtimeOf?: (f: string) => number | null } = {},
): ProvisionalView[] {
  const locate = opts.locate ?? ((sid, cwd) => locateTranscript(sid, cwd));
  const prompt = opts.firstPrompt ?? firstPromptOf;
  const mtimeOf = opts.mtimeOf ?? realDeps.mtimeOf;
  const have = new Set(views.map((v) => `${v.agent}:${v.session_id}`));
  const out: ProvisionalView[] = [];
  for (const [key, l] of Object.entries(live)) {
    if (have.has(key) || opts.exclude?.(l)) continue;
    const file = l.agent === 'claude' ? locate(l.session_id, l.cwd ?? '') : null;
    const spawn = l.pane_id ? spawns.find((s) => s.pane_id === l.pane_id) : undefined;
    const first = file ? prompt(file) : '';
    const mt = (file && mtimeOf(file)) || now;
    out.push({
      provisional: true,
      agent: l.agent as ChatView['agent'],
      session_id: l.session_id,
      project: path.basename(l.cwd || 'unknown'),
      project_dir: l.cwd ?? '',
      jsonl_path: file ?? '',
      title: spawn?.title || first || l.name || 'New session',
      claude_auto_title: '',
      pr_url: '',
      overview: '',
      state: '',
      breakdown: [],
      first_message: first,
      message_count: 0,
      started_at: spawn?.spawned_at || mt,
      last_active_at: mt,
      last_turn_at: mt,
      activity: {},
      summary_pending: true,
      saved: false,
      saved_at: 0,
      tags: [],
    });
  }
  return out;
}
