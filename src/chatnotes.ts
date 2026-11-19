import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';
import type { Draft } from './outbox.ts';
import { reviewSummary } from './outboxreview.ts';
import { emailSummary } from './outboxemail.ts';

// Notes for a chat about things Loom did on its behalf, delivered by the plugin's
// chat-notes hook (plugin/loom/hooks/chat-notes.py) as context on the chat's next
// prompt or tool call. Nothing is typed into the pane: a typed note would start a
// turn on every send and could answer an open permission prompt. A parked or
// closed chat gets its notes when it is resumed.
//
// One JSONL file per session, $LOOM_HOME/chat-notes/<session>.jsonl. Loom appends;
// the hook renames the file away, reads it and deletes it, so a note is delivered once.

export const CHAT_NOTES_DIR = path.join(TOOL_DIR, 'chat-notes');

const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;

export function addChatNote(sessionId: string, text: string, dir: string = CHAT_NOTES_DIR, now: number = Date.now()): boolean {
  if (!SID_RE.test(sessionId) || !text.trim()) return false;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, `${sessionId}.jsonl`), JSON.stringify({ at: now, text }) + '\n', { mode: 0o600 });
  return true;
}

const MAX_QUOTE = 1500;
const quote = (t: string) => (t.length > MAX_QUOTE ? t.slice(0, MAX_QUOTE) + '…' : t).split('\n').map((l) => '> ' + l).join('\n');

/** What the chat is told when Loom sends one of its drafts. `label` names the Slack destination (#name / @dm). */
export function sentNote(d: Draft, sent: string[], permalink: string, label = ''): string {
  const where: string[] = [];
  if (d.review) where.push('the PR review (' + reviewSummary(d.review) + ')');
  if (d.email) where.push('the email (' + emailSummary(d.email) + ')');
  const texts = d.email ? [] : sent;
  if (texts.length) {
    const dest = label || d.channel;
    where.push(
      d.thread_ts
        ? `${texts.length === 1 ? 'a reply' : texts.length + ' replies'} in the thread in ${dest}`
        : texts.length > 1 && !/^[D@]/.test(d.channel)
          ? `a new post in ${dest} (message 1 top-level, the other ${texts.length - 1} as replies in its thread)`
          : `${texts.length === 1 ? 'a message' : texts.length + ' messages'} to ${dest}`,
    );
  }
  const edited = d.email ? sent[0] !== d.email.body : JSON.stringify(sent) !== JSON.stringify(d.messages ?? []);
  const lines = [
    `Loom outbox: the user sent your draft ${d.id} from Loom: ${where.join(', then ') || 'it'}.` + (permalink ? ` Link: ${permalink}` : ''),
    'It is posted. Do not send, re-record or show it again as a draft; treat it as what was said.',
    `\`loom outbox show ${d.id}\` shows it in full.`,
  ];
  if (edited && sent.length) lines.push('The user edited it before sending. What went out:\n' + sent.map(quote).join('\n\n'));
  return lines.join('\n');
}

/** Is a note still waiting for this chat (the hook has not taken it yet)? */
export function hasChatNote(sessionId: string, dir: string = CHAT_NOTES_DIR): boolean {
  return SID_RE.test(sessionId) && fs.existsSync(path.join(dir, `${sessionId}.jsonl`));
}

/** Take a chat's waiting notes directly (for a chat with no hook to take them, e.g. Codex). Oldest first. */
export function takeChatNotes(sessionId: string, dir: string = CHAT_NOTES_DIR): string[] {
  if (!SID_RE.test(sessionId)) return [];
  const file = path.join(dir, `${sessionId}.jsonl`);
  const claimed = `${file}.${process.pid}.taking`;
  try {
    fs.renameSync(file, claimed);
  } catch {
    return [];
  }
  try {
    return fs.readFileSync(claimed, 'utf8').split('\n').flatMap((l) => {
      try {
        const n = JSON.parse(l) as { text?: unknown };
        return typeof n?.text === 'string' && n.text.trim() ? [n.text] : [];
      } catch {
        return [];
      }
    });
  } finally {
    fs.rmSync(claimed, { force: true });
  }
}


const NUDGE_MAX = 2500;

/**
 * The line Loom types into an idle chat: the waiting notes themselves, flattened to one line
 * (a typed Enter submits). Typed in full, not as a pointer for the hook to fill in: a Claude
 * process started before the plugin had the chat-notes hook never runs it, even after /clear.
 */
export function nudgeLine(notes: string[]): string {
  const flat = notes.map((n) => n.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' | ');
  if (!flat) return '';
  const line = '[Loom outbox] ' + flat;
  return line.length > NUDGE_MAX ? line.slice(0, NUDGE_MAX - 13).trimEnd() + ' …(cut short)' : line;
}

export type NudgeState = 'gone' | 'not-live' | 'hold' | 'ready';
export interface NudgeIo {
  hasNote: () => boolean;
  /** 'not-live' (no pane), 'hold' (working, focused, or at a prompt or menu), else 'ready'. */
  pane: () => Exclude<NudgeState, 'gone'>;
  type: () => boolean;
  later: (fn: () => void, ms: number) => void;
}

export const NUDGE_EVERY_MS = 15_000;
export const NUDGE_TRIES = 120; // half an hour of 15 s looks

/**
 * Nudge the chat once its pane is free. A chat that is working takes the note on its next Bash
 * call or prompt by itself, so each look first checks the note is still there. A chat with no
 * live pane keeps the note for when it is resumed. Gives up quietly after NUDGE_TRIES looks.
 */
export function nudgeWhenFree(io: NudgeIo, tries: number = NUDGE_TRIES, every: number = NUDGE_EVERY_MS): void {
  const look = (left: number) => {
    try {
      if (!io.hasNote()) return;
      const s = io.pane();
      if (s === 'not-live') return;
      if (s === 'ready' && io.type()) return;
    } catch {
      /* a nudge is a nicety; try again */
    }
    if (left > 1) io.later(() => look(left - 1), every);
  };
  look(tries);
}
