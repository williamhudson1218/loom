import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { TOOL_DIR } from './paths.ts';
import { addDraft, closeDraft, updateDraft, type StoreOpts } from './outbox.ts';
import { claimForChat, recordAck, releaseThread, setThreadStage, syncLegacyThreads, type ClaimMode, type LegacyThreadRec } from './slackowner.ts';
import { addTestLink, clearTestLinks } from './testlinks.ts';
import { parseSlackThread, type ThreadRef } from './slackref.ts';

// The plugin's writes (§4.3). The `loom` CLI and its hooks never talk to Loom to
// change anything: each write is one JSON file in $LOOM_HOME/events/
// (`<ms>-<rand>.json`, 0600, written as a dot-tmp and renamed), so a draft or a
// claim made while Loom is down is applied when it comes back. Loom reads them in
// name (= time) order, applies each, then deletes it.
//
// Every event applies idempotently: an add for an id Loom holds is a no-op, a
// claim the chat already has changes nothing, a label is an upsert. So an event
// file read twice (Loom quit between applying it and deleting it) changes nothing
// the second time. A file that cannot be applied is moved to events/bad/, never
// deleted, so a draft can not be lost to a parse error.

export const EVENTS_DIR = path.join(TOOL_DIR, 'events');

export interface LoomEvent {
  v?: number;
  kind: string;
  at?: number;
  [k: string]: unknown;
}

export interface IngestOpts {
  dir?: string;
  outbox?: StoreOpts;
  now?: () => number;
  /** The old hook's thread state, mirrored in before the events (src/slack.ts readThreads). */
  legacyThreads?: () => Record<string, LegacyThreadRec>;
}

export interface Applied {
  ok: boolean;
  detail: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const KEY_RE = /^[A-Z0-9]+\/\d{10}\.\d{6}$/;

function refOf(e: LoomEvent): ThreadRef | null {
  const key = str(e.key);
  const url = str(e.url);
  const parsed = url ? parseSlackThread(url) : null;
  if (parsed && (!key || parsed.key === key)) return parsed;
  if (!KEY_RE.test(key)) return null;
  const [channel, ts] = key.split('/');
  return { key, url: url || `https://app.slack.com/archives/${channel}/p${ts.replace('.', '')}`, channel, ts, linkTs: ts };
}

/** Apply one event. Pure apart from the DB and the outbox file. */
export function applyEvent(db: Database.Database, e: LoomEvent, opts: IngestOpts = {}): Applied {
  const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : (opts.now ?? Date.now)();
  switch (e.kind) {
    case 'outbox.add':
      return addDraft(
        {
          id: str(e.id),
          session_id: str(e.session),
          channel: str(e.channel),
          thread_ts: str(e.thread_ts) || undefined,
          thread_url: str(e.thread_url) || undefined,
          messages: Array.isArray(e.messages) ? (e.messages as string[]) : [],
          ...(Array.isArray(e.files) ? { files: e.files as string[][] } : {}),
          at,
        },
        opts.outbox,
      );
    case 'outbox.update': {
      const r = updateDraft(str(e.id), Array.isArray(e.messages) ? (e.messages as string[]) : [], opts.outbox, at, Array.isArray(e.files) ? (e.files as string[][]) : undefined);
      // A revision of a draft that has since been sent or replaced has nothing to change: done, not bad.
      return r.ok || r.detail.startsWith('already') ? { ok: true, detail: r.detail } : r;
    }
    case 'outbox.supersede': {
      const r = closeDraft(str(e.id), 'superseded', { at }, opts.outbox);
      return r.ok || r.detail.startsWith('already') ? { ok: true, detail: r.detail } : r;
    }
    case 'thread.claim': {
      const ref = refOf(e);
      if (!ref) return { ok: false, detail: 'not a Slack thread' };
      const mode = (['if_unowned', 'takeover', 'force'].includes(str(e.mode)) ? str(e.mode) : 'if_unowned') as ClaimMode;
      const r = claimForChat(db, ref, { sessionId: str(e.session), cwd: str(e.cwd), mode, started: e.started === true, now: at });
      return { ok: true, detail: r.changed ? 'claimed' : 'unchanged' };
    }
    case 'thread.release': {
      const ref = refOf(e);
      if (!ref) return { ok: false, detail: 'not a Slack thread' };
      return { ok: true, detail: releaseThread(db, ref.key) ? 'released' : 'not owned' };
    }
    case 'thread.stage': {
      const ref = refOf(e);
      const stage = str(e.stage);
      if (!ref || !['looking', 'blocked', 'done'].includes(stage)) return { ok: false, detail: 'bad stage event' };
      setThreadStage(db, ref.key, { stage, note: str(e.note) || null, react: typeof e.react === 'boolean' ? e.react : undefined, now: at });
      return { ok: true, detail: 'staged' };
    }
    case 'thread.ack': {
      const ref = refOf(e);
      const text = str(e.text).trim();
      if (!ref || !text) return { ok: false, detail: 'bad ack event' };
      return { ok: true, detail: recordAck(db, ref.key, text.slice(0, 500), at) ? 'acked' : 'already acked' };
    }
    case 'ship.label': {
      const sid = str(e.session);
      if (!sid) return { ok: false, detail: 'session is required' };
      if (e.clear === true) {
        db.prepare(`DELETE FROM ship_labels WHERE session_id = ?`).run(sid);
        return { ok: true, detail: 'cleared' };
      }
      const label = str(e.label).trim().slice(0, 200);
      const repo = str(e.repo).replace(/\/+$/, '');
      if (!label || !repo) return { ok: false, detail: 'label and repo are required' };
      db.prepare(
        `INSERT INTO ship_labels (session_id, repo, label, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(session_id, repo) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
      ).run(sid, repo, label, at);
      return { ok: true, detail: 'labelled' };
    }
    case 'testlinks.add':
      return addTestLink(db, str(e.session), e.url, e.label, at);
    case 'testlinks.clear':
      return clearTestLinks(db, str(e.session), e.url);
    default:
      return { ok: false, detail: `unknown kind ${JSON.stringify(e.kind)}` };
  }
}

/** A file named like an event the CLI wrote: not a dot-tmp, not in a subdir. */
const isEventFile = (n: string) => !n.startsWith('.') && n.endsWith('.json');

/** How long a file that does not parse is left alone before it counts as bad (a writer mid-rename). */
const UNPARSED_GRACE_MS = 10_000;

export interface IngestReport {
  applied: number;
  bad: string[];
  details: { file: string; kind: string; detail: string }[];
}

function quarantine(dir: string, name: string): void {
  const bad = path.join(dir, 'bad');
  fs.mkdirSync(bad, { recursive: true, mode: 0o700 });
  fs.renameSync(path.join(dir, name), path.join(bad, name));
}

/** One pass over the events dir. Safe to call at any rate; a pass never overlaps itself. */
export function ingestEvents(db: Database.Database, opts: IngestOpts = {}): IngestReport {
  const dir = opts.dir ?? EVENTS_DIR;
  const now = (opts.now ?? Date.now)();
  const report: IngestReport = { applied: 0, bad: [], details: [] };
  if (opts.legacyThreads) {
    try {
      syncLegacyThreads(db, opts.legacyThreads(), now);
    } catch (e) {
      console.error('[loom] legacy thread sync failed:', (e as Error).message);
    }
  }
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter(isEventFile).sort();
  } catch {
    return report; // no events dir yet
  }
  for (const name of names) {
    const file = path.join(dir, name);
    let e: LoomEvent;
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
      if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') throw new Error('not an event');
      e = raw as LoomEvent;
    } catch (err) {
      let age = Infinity;
      try {
        age = now - fs.statSync(file).mtimeMs;
      } catch {
        continue; // gone already
      }
      if (age < UNPARSED_GRACE_MS) continue;
      try {
        quarantine(dir, name);
      } catch {
        /* next pass */
      }
      report.bad.push(name);
      report.details.push({ file: name, kind: '?', detail: (err as Error).message });
      continue;
    }
    let r: Applied;
    try {
      r = applyEvent(db, e, opts);
    } catch (err) {
      // A DB or disk error: leave the file for the next pass rather than lose it.
      report.details.push({ file: name, kind: e.kind, detail: 'error: ' + (err as Error).message });
      break; // keep order: nothing later applies before this one does
    }
    report.details.push({ file: name, kind: e.kind, detail: r.detail });
    try {
      if (r.ok) {
        fs.rmSync(file, { force: true });
        report.applied++;
      } else {
        quarantine(dir, name);
        report.bad.push(name);
      }
    } catch {
      /* the next pass re-applies it, which is a no-op */
    }
  }
  return report;
}

/**
 * Ingest on every change to the events dir and every `everyMs` regardless (fs.watch
 * misses events on some filesystems). Returns a stop function.
 */
export function startEventIngest(openDb: () => Database.Database, opts: IngestOpts & { everyMs?: number } = {}): () => void {
  const dir = opts.dir ?? EVENTS_DIR;
  // The legacy thread file only needs mirroring when it changed: readThreads is
  // mtime-memoised, so an unchanged file comes back as the same object.
  let lastLegacy: unknown = null;
  const legacyThreads = opts.legacyThreads
    ? () => {
        const t = opts.legacyThreads!();
        if (t === lastLegacy) return {};
        lastLegacy = t;
        return t;
      }
    : undefined;
  const passOpts: IngestOpts = { ...opts, legacyThreads };
  let busy = false;
  let again = false;
  const run = () => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    try {
      const db = openDb();
      try {
        const r = ingestEvents(db, passOpts);
        if (r.bad.length) console.error('[loom] events: set aside', r.bad.join(', '), r.details.filter((d) => r.bad.includes(d.file)).map((d) => d.detail).join('; '));
      } finally {
        db.close();
      }
    } catch (e) {
      console.error('[loom] event ingest failed:', (e as Error).message);
    } finally {
      busy = false;
      if (again) {
        again = false;
        setTimeout(run, 50);
      }
    }
  };
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    /* the timer still runs; the CLI creates the dir */
  }
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, { persistent: false }, () => run());
  } catch {
    /* polling alone */
  }
  const timer = setInterval(run, opts.everyMs ?? 2000);
  timer.unref?.();
  setTimeout(run, 0);
  return () => {
    clearInterval(timer);
    watcher?.close();
  };
}
