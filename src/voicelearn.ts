import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Learn from Outbox edits (voice_learn_from_edits). When the person edits a draft
// before sending it, the difference between what Claude wrote and what went out is
// the best evidence there is about their voice. Append it, dated, to the active
// voice skill's corrections.md in the format the voice-tuning skill writes:
//
//   ## YYYY-MM-DD — <where>: edited before sending
//   Before: "<what Claude drafted>"
//   After: "<what was sent>"
//   Note: recorded from an Outbox edit; add the lesson when you next tune.
//
// New entries go at the top, right under the header's `---` line. Nothing is
// written when the setting is off, no voice skill is set, the skill has no
// corrections.md, or the edit only changed whitespace.

export const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

/** ~/.claude/skills/<skill>/corrections.md, or null for an empty or plugin-scoped (`plugin:skill`) name. */
export function correctionsPath(skill: string, skillsDir: string = SKILLS_DIR): string | null {
  const s = skill.trim();
  if (!s || s === 'none' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s)) return null;
  return path.join(skillsDir, s, 'corrections.md');
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/** True when the edit changed more than whitespace. */
export function isRealEdit(before: string[], after: string[]): boolean {
  return squash(before.join('\n')) !== squash(after.join('\n'));
}

const quote = (msgs: string[]) => msgs.map((m) => '"' + m.trim().replace(/\n+/g, ' / ') + '"').join(' + ');

function ymd(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function correctionEntry(p: { before: string[]; after: string[]; where: string; at: number }): string {
  const where = squash(p.where) || 'Outbox';
  return [
    `## ${ymd(p.at)} — ${where}: edited before sending`,
    `Before: ${quote(p.before)}`,
    `After: ${quote(p.after)}`,
    'Note: recorded from an Outbox edit; add the lesson when you next tune.',
    '',
  ].join('\n');
}

/** Insert an entry under the header: after the first `---` line, else after the opening paragraph block. */
export function insertEntry(file: string, entry: string): string {
  const lines = file.split('\n');
  let at = lines.findIndex((l) => l.trim() === '---');
  if (at >= 0) {
    at += 1;
  } else {
    // No separator: after the title and the paragraph under it.
    const title = lines.findIndex((l) => /^#\s/.test(l));
    at = title < 0 ? 0 : title + 1;
    while (at < lines.length && lines[at].trim() === '') at++;
    while (at < lines.length && lines[at].trim() !== '' && !/^##\s/.test(lines[at])) at++;
  }
  const head = lines.slice(0, at).join('\n').replace(/\n*$/, '');
  const tail = lines.slice(at).join('\n').replace(/^\n*/, '');
  return (head ? head + '\n\n' : '') + entry + (tail ? '\n' + tail : '');
}

export interface LearnInput {
  enabled: boolean;
  skill: string;
  before: string[];
  after: string[];
  where: string;
  at?: number;
  skillsDir?: string;
}

/** Append the edit to corrections.md. Returns what happened, for the log; never throws. */
export function learnFromEdit(p: LearnInput): { written: boolean; reason: string; file?: string } {
  if (!p.enabled) return { written: false, reason: 'off' };
  const file = correctionsPath(p.skill, p.skillsDir);
  if (!file) return { written: false, reason: 'no voice skill' };
  if (!p.before.length || !p.after.length || !isRealEdit(p.before, p.after)) return { written: false, reason: 'no real edit' };
  try {
    if (!fs.existsSync(file)) return { written: false, reason: 'no corrections.md', file };
    const cur = fs.readFileSync(file, 'utf8');
    const next = insertEntry(cur, correctionEntry({ before: p.before, after: p.after, where: p.where, at: p.at ?? Date.now() }));
    const tmp = file + '.loom-tmp';
    fs.writeFileSync(tmp, next);
    fs.renameSync(tmp, file);
    return { written: true, reason: 'written', file };
  } catch (e) {
    return { written: false, reason: 'write failed: ' + (e as Error).message, file };
  }
}
