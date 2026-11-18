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
  ];
  if (edited && sent.length) lines.push('The user edited it before sending. What went out:\n' + sent.map(quote).join('\n\n'));
  return lines.join('\n');
}
