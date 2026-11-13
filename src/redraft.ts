import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';
import type { FreshItem } from './outboxfresh.ts';

// "Redraft": the Outbox card's button for a draft whose thread got new messages
// after it was written. Loom types a prompt into the chat that owns the draft
// (or resumes the chat with it) asking it to re-read the thread and either
// replace the draft in place (`loom outbox update <id>`) or keep it
// (`loom outbox keep <id>`). The state lives in $LOOM_HOME/outbox-redraft.json so
// a reload, or a restart of Loom, keeps the card in its "Redrafting" state.

export const REDRAFT_PATH = path.join(TOOL_DIR, 'outbox-redraft.json');

/** A redraft the chat has not answered stops holding Send after this long. */
export const REDRAFT_TTL_MS = 15 * 60_000;

const MAX_ITEMS = 6;
const MAX_SNIPPET = 300;

export interface RedraftMark {
  /** ms: when the prompt was delivered. */
  at: number;
  /** How many new messages the prompt carried. */
  n: number;
  /** The draft's revised_at when asked ('' if never revised): a change means the chat replaced it. */
  revised_at: string;
  /** Ids of the messages the prompt carried: a card only offers Redraft again for others. */
  ids: string[];
  /** 'kept' once the chat ran `loom outbox keep`. */
  state?: 'kept';
}

/** What the card needs. */
export interface RedraftView {
  active: boolean;
  at: number;
  n: number;
  ids: string[];
  kept?: boolean;
}

export interface DraftLite {
  status: string;
  revised_at?: string;
}

/** The redraft still holding this draft's Send: asked recently, not replaced, not kept. */
export function redraftActive(m: RedraftMark | undefined, d: DraftLite, now: number): boolean {
  if (!m || m.state === 'kept') return false;
  if (d.status !== 'pending') return false;
  if ((d.revised_at ?? '') !== m.revised_at) return false;
  return now - m.at < REDRAFT_TTL_MS;
}

export function redraftView(m: RedraftMark | undefined, d: DraftLite, now: number): RedraftView | undefined {
  if (!m) return undefined;
  const active = redraftActive(m, d, now);
  // Asked, never answered, and timed out: as if never asked, so the card offers Redraft again.
  if (!active && m.state !== 'kept' && d.status === 'pending' && (d.revised_at ?? '') === m.revised_at) return undefined;
  return { active, at: m.at, n: m.n, ids: m.ids, ...(m.state === 'kept' ? { kept: true } : {}) };
}

export function newMark(d: DraftLite, items: Pick<FreshItem, 'id'>[], now: number): RedraftMark {
  return { at: now, n: items.length, revised_at: d.revised_at ?? '', ids: items.map((i) => i.id) };
}

const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

function quote(i: Pick<FreshItem, 'author' | 'snippet'>): string {
  let t = oneLine(i.snippet ?? '').replace(/"/g, "'");
  if (t.length > MAX_SNIPPET) t = t.slice(0, MAX_SNIPPET - 1) + '…';
  return `${oneLine(i.author || 'someone')}: "${t}"`;
}

export interface PromptInput {
  id: string;
  /** The thread's permalink (Slack thread, Gmail thread or PR). */
  url: string;
  items: Pick<FreshItem, 'author' | 'snippet'>[];
}

/**
 * The user message typed into the chat. One line (sendToPane flattens newlines
 * anyway), and the same text is the first prompt of a resumed chat.
 */
export function buildRedraftPrompt(p: PromptInput): string {
  const n = p.items.length;
  const shown = p.items.slice(0, MAX_ITEMS).map((i, k) => `[${k + 1}] ${quote(i)}`).join(' ');
  const more = n > MAX_ITEMS ? ` (+${n - MAX_ITEMS} more, read the thread)` : '';
  const where = p.url ? `the thread ${p.url}` : 'the thread this draft replies to';
  return (
    `redraft ${p.id}: ${where} has ${n} new message${n === 1 ? '' : 's'} since you drafted this reply: ${shown}${more}. ` +
    'Re-read the whole thread first, research whatever the new messages raise (PRs, issues, deploys, code they mention), then decide. ' +
    `If the draft needs changing, replace draft ${p.id} with the updated one: \`loom outbox update ${p.id} --text-file <file>\` ` +
    '(same card and id; add --file <image> for attachments, or --review-file / --reactions-file / --email-file if it carries those). ' +
    `If it still stands, run \`loom outbox keep ${p.id}\` and say why in one line.`
  );
}

/* ------------------------------------------------------------------ the file */

export function readMarks(file: string = REDRAFT_PATH): Record<string, RedraftMark> {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<string, RedraftMark>;
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch {
    return {};
  }
}

function writeMarks(marks: Record<string, RedraftMark>, file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(marks, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Record a redraft; marks of drafts that are gone (`livePending` given) are dropped with it. */
export function setMark(id: string, m: RedraftMark, file: string = REDRAFT_PATH, livePending?: Set<string>): void {
  const marks = readMarks(file);
  if (livePending) for (const k of Object.keys(marks)) if (!livePending.has(k)) delete marks[k];
  marks[id] = m;
  writeMarks(marks, file);
}

/** Cancel a redraft (the card may offer it again). Returns true when there was one. */
export function clearMark(id: string, file: string = REDRAFT_PATH): boolean {
  const marks = readMarks(file);
  if (!marks[id]) return false;
  delete marks[id];
  writeMarks(marks, file);
  return true;
}

/** The chat said the draft stands. Returns true when a redraft was waiting on it. */
export function keepMark(id: string, file: string = REDRAFT_PATH): boolean {
  const marks = readMarks(file);
  const m = marks[id];
  if (!m || m.state === 'kept') return false;
  marks[id] = { ...m, state: 'kept' };
  writeMarks(marks, file);
  return true;
}
