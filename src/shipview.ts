import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { ChatEdits, ShipBoard, ShipFile, ShipLock } from './ships.ts';
import { DEFAULT_SHIP_COMMAND } from './projects.ts';

// The pure half of the "View staged work" modal: numstat parsing, the label
// merge, attribution overrides, the unattributed guess, the Ship button's
// rules and the detail payload. The runners that touch git and tmux live in
// shipdetail.ts.

/* ------------------------------------------------------------------ numstat */

export interface NumstatRow {
  path: string;
  added: number;
  deleted: number;
  binary: boolean;
}

/** `git diff --numstat -z --no-renames`: "<added>\t<deleted>\t<path>\0" per file; "-" counts mean binary. */
export function parseNumstatZ(out: string): NumstatRow[] {
  const rows: NumstatRow[] = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const m = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(rec.replace(/^\n/, ''));
    if (!m) continue;
    const binary = m[1] === '-' || m[2] === '-';
    rows.push({ path: m[3], added: binary ? 0 : Number(m[1]), deleted: binary ? 0 : Number(m[2]), binary });
  }
  return rows;
}

/* ------------------------------------------------------------------- labels */

export type LabelSource = 'db' | 'file' | 'title' | 'none';
export interface MergedLabel {
  label: string;
  source: LabelSource;
}
export interface FileLabel {
  label: string;
  repo: string;
  at: number;
}

export const SHIP_LABELS_FILE = process.env.LOOM_SHIP_LABELS_FILE || path.join(os.homedir(), '.claude', 'state', 'ship-labels.json');
export const MAX_LABEL = 200;

const sameRepo = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** The toolbox hook's file: { "<session_id>": { label, repo, at } }. Missing or malformed reads as empty. */
export function readLabelsFile(file: string = SHIP_LABELS_FILE): Record<string, FileLabel> {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const out: Record<string, FileLabel> = {};
    for (const [sid, v] of Object.entries(o as Record<string, any>)) {
      if (v && typeof v.label === 'string' && v.label.trim()) out[sid] = { label: v.label.trim(), repo: typeof v.repo === 'string' ? v.repo : '', at: Number(v.at) || 0 };
    }
    return out;
  } catch {
    return {};
  }
}

export function setShipLabel(db: Database.Database, sessionId: string, repo: string, label: string, now: number = Date.now()): void {
  const l = label.trim().slice(0, MAX_LABEL);
  if (!l) {
    db.prepare(`DELETE FROM ship_labels WHERE session_id = ? AND repo = ?`).run(sessionId, repo);
    return;
  }
  db.prepare(
    `INSERT INTO ship_labels (session_id, repo, label, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, repo) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at`,
  ).run(sessionId, repo, l, now);
}

/** DB label over the hook file's over the chat's own title. A file entry for another repo does not apply. */
export function mergeLabel(
  db: Database.Database | null,
  file: Record<string, FileLabel>,
  sessionId: string,
  repo: string,
  title: string,
): MergedLabel {
  if (db) {
    const row = db.prepare(`SELECT label FROM ship_labels WHERE session_id = ? AND repo = ?`).get(sessionId, repo) as { label: string } | undefined;
    if (row?.label.trim()) return { label: row.label.trim(), source: 'db' };
  }
  const f = file[sessionId];
  if (f && (!f.repo || sameRepo(f.repo, repo))) return { label: f.label, source: 'file' };
  const t = title.trim();
  return t ? { label: t, source: 'title' } : { label: '', source: 'none' };
}

/* ---------------------------------------------------------------- overrides */

export interface AttrOverride {
  repo: string;
  path: string;
  key: string; // agent:session_id
}

export function setOverride(db: Database.Database, repo: string, filePath: string, key: string, now: number = Date.now()): void {
  if (!key) {
    db.prepare(`DELETE FROM ship_attr_overrides WHERE repo = ? AND path = ?`).run(repo, filePath);
    return;
  }
  db.prepare(
    `INSERT INTO ship_attr_overrides (repo, path, chat_key, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(repo, path) DO UPDATE SET chat_key = excluded.chat_key, updated_at = excluded.updated_at`,
  ).run(repo, filePath, key, now);
}

export function loadAllOverrides(db: Database.Database): AttrOverride[] {
  return (db.prepare(`SELECT repo, path, chat_key FROM ship_attr_overrides`).all() as { repo: string; path: string; chat_key: string }[]).map((r) => ({ repo: r.repo, path: r.path, key: r.chat_key }));
}

/**
 * A by-hand assignment beats whatever the transcripts say: the path leaves every
 * other chat's edits and lands in the assigned chat's, stamped now. Pure — returns new objects.
 */
export function applyOverrides(chats: ChatEdits[], overrides: AttrOverride[], now: number): ChatEdits[] {
  if (!overrides.length) return chats;
  const out = chats.map((c) => ({ ...c, edits: { ...c.edits } }));
  for (const o of overrides) {
    for (const c of out) delete c.edits[o.path];
    let target = out.find((c) => c.key === o.key);
    if (!target) out.push((target = { key: o.key, edits: {}, shipCmds: [] }));
    target.edits[o.path] = { first: now, last: now };
  }
  return out;
}

/* ------------------------------------------------------------------- guess */

export interface Guess {
  key: string;
  at: number;
}

/** The chat whose transcript most recently edited or wrote `filePath`, if any. Ties go to the lower key. */
export function guessOwner(filePath: string, chats: ChatEdits[]): Guess | null {
  let best: Guess | null = null;
  for (const c of chats) {
    const e = c.edits[filePath];
    if (!e) continue;
    if (!best || e.last > best.at || (e.last === best.at && c.key < best.key)) best = { key: c.key, at: e.last };
  }
  return best;
}

/* -------------------------------------------------------------- ship rules */

// The prompt is the repo's ship_command, verbatim. Loom never adds a flag: a forced landing is a decision to make by hand, not a checkbox.
export const shipPrompt = (command: string = DEFAULT_SHIP_COMMAND): string => command;

export const shipConfirmText = (repo: string, staged: number, command: string = DEFAULT_SHIP_COMMAND): string =>
  `Starts a new Claude session in ${repo} running ${command}. It commits the ${staged} staged ${staged === 1 ? 'file' : 'files'} as one batch, opens a ship/ PR and merges it when CI and review are green.`;

export interface ShipGate {
  ok: boolean;
  reason: string; // '' when ok
  holder?: { key: string; pane: string; sessionId: string };
}

/** Ship is off when the checkout is not on its base branch, nothing is staged, or a live (not stale) lock is held. */
export function shipDisabledReason(input: { onMain: boolean; staged: number; lock: Pick<ShipLock, 'stale' | 'holderKey' | 'pane' | 'sessionId'> | null; base?: string }): ShipGate {
  const { onMain, staged, lock } = input;
  if (lock && !lock.stale) {
    return { ok: false, reason: 'A ship is already in progress.', holder: { key: lock.holderKey, pane: lock.pane, sessionId: lock.sessionId } };
  }
  if (!onMain) return { ok: false, reason: `The checkout is not on ${input.base || 'main'}.` };
  if (staged <= 0) return { ok: false, reason: 'Nothing is staged.' };
  return { ok: true, reason: '' };
}

/* ------------------------------------------------------------------ detail */

export interface DetailFile {
  path: string;
  state: ShipFile['state'];
  added: number;
  deleted: number;
  binary: boolean;
  shared?: boolean;
}

export interface DetailChat {
  key: string;
  title: string;
  label: string;
  labelSource: LabelSource;
  staged: DetailFile[];
  unstaged: DetailFile[];
}

export interface DetailUnattributed extends DetailFile {
  guess: Guess | null;
}

export interface ShipDetail {
  repo: string;
  slug: string;
  base: string;
  command: string; // the repo's ship_command
  labelRequired: boolean;
  onMain: boolean;
  generatedAt: number;
  totals: { staged: number; added: number; deleted: number; unstaged: number };
  lock: { sessionId: string; pane: string; holderKey: string; stale: boolean; acquiredAt: number; batch: number } | null;
  chats: DetailChat[];
  onlyUnstagedChats: number;
  unattributed: DetailUnattributed[];
  gate: ShipGate;
  confirm: string; // the sentence the Ship confirm step shows
  commands: { plain: string };
}

const rides = (s: ShipFile['state']) => s === 'staged' || s === 'partial';

export interface DetailInput {
  board: ShipBoard;
  staged: NumstatRow[];
  unstaged: NumstatRow[];
  titles: Record<string, string>; // chat key -> title fallback
  labels: Record<string, MergedLabel>; // chat key -> merged label
  guesses: Record<string, Guess | null>; // path -> guess
}

export function buildShipDetail(i: DetailInput): ShipDetail {
  const { board } = i;
  const st = new Map(i.staged.map((r) => [r.path, r]));
  const un = new Map(i.unstaged.map((r) => [r.path, r]));
  const row = (f: ShipFile, side: 'staged' | 'unstaged'): DetailFile => {
    const n = (side === 'staged' ? st : un).get(f.path);
    return { path: f.path, state: f.state, added: n?.added ?? 0, deleted: n?.deleted ?? 0, binary: n?.binary ?? false, ...(f.shared ? { shared: true } : {}) };
  };
  const chats: DetailChat[] = [];
  let onlyUnstagedChats = 0;
  for (const c of board.next.chats) {
    const staged = c.files.filter((f) => rides(f.state)).map((f) => row(f, 'staged'));
    if (!staged.length) {
      onlyUnstagedChats++;
      continue;
    }
    const lab = i.labels[c.key] ?? { label: '', source: 'none' as const };
    chats.push({
      key: c.key,
      title: i.titles[c.key] ?? '',
      label: lab.label,
      labelSource: lab.source,
      staged,
      unstaged: c.files.filter((f) => f.state !== 'staged').map((f) => row(f, 'unstaged')),
    });
  }
  const totals = { staged: i.staged.length, added: i.staged.reduce((a, r) => a + r.added, 0), deleted: i.staged.reduce((a, r) => a + r.deleted, 0), unstaged: board.next.unstaged };
  const l = board.lock;
  return {
    repo: board.repo,
    slug: board.slug,
    base: board.base,
    command: board.command,
    labelRequired: !!board.labelRequired,
    onMain: board.onMain,
    generatedAt: board.generatedAt,
    totals,
    lock: l ? { sessionId: l.sessionId, pane: l.pane, holderKey: l.holderKey, stale: l.stale, acquiredAt: l.acquiredAt, batch: l.batch.length } : null,
    chats,
    onlyUnstagedChats,
    unattributed: board.next.unattributed.map((f) => ({ ...row(f, rides(f.state) ? 'staged' : 'unstaged'), guess: i.guesses[f.path] ?? null })),
    gate: shipDisabledReason({ onMain: board.onMain, staged: totals.staged, lock: l, base: board.base }),
    confirm: shipConfirmText(board.repo, totals.staged, board.command),
    commands: { plain: shipPrompt(board.command) },
  };
}
