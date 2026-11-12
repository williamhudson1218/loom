import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Start-state helpers for the orchestrator: read what a stuck pane is asking
// (read-only, from a capture-pane dump) and pre-trust its folder so Claude Code's
// first-run "do you trust this folder" dialog never blocks an unattended start.

export type OrchStartState = 'disabled' | 'running' | 'starting' | 'prompt' | 'exited';

export interface FirstRunPrompt {
  /** First line of the question, as the pane shows it. */
  question: string;
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');

const KNOWN: RegExp[] = [
  /Is this a project you created or one you trust/i,
  /Do you want to use this API key/i,
  /Choose the text style|Choose a theme|Select login method|Select your login|Paste code here/i,
  /Do you trust the files in this folder/i,
];

/**
 * Is this pane sitting on a first-run question? Matches Claude's trust dialog, the
 * API-key prompt, theme and login prompts, and any selection menu that has a "❯"
 * cursor and an "Enter to confirm" footer. Returns the question's first line.
 */
export function detectFirstRunPrompt(screen: string): FirstRunPrompt | null {
  const lines = strip(screen).split('\n').map((l) => l.replace(/\s+$/, ''));
  const text = lines.join('\n');
  const known = KNOWN.find((r) => r.test(text));
  const menu = /❯/.test(text) && /Enter to confirm/i.test(text);
  if (!known && !menu) return null;
  let question = '';
  if (known) {
    const hit = lines.find((l) => known.test(l));
    question = hit ?? '';
  }
  if (!question) {
    // Generic menu: the first meaningful line above the first "❯" option.
    const at = lines.findIndex((l) => /❯/.test(l));
    for (let i = at - 1; i >= 0; i--) {
      const t = lines[i]!.replace(/[│╭╮╰╯─]/g, '').trim();
      if (t && !/^\d+\.\s/.test(t)) question = t;
      else if (question) break;
    }
    if (!question) question = lines.find((l) => l.trim()) ?? 'A selection menu is waiting';
  }
  return { question: question.replace(/[│╭╮╰╯─]/g, '').trim().slice(0, 200) };
}

/**
 * Set projects["<dir>"].hasTrustDialogAccepted = true in ~/.claude.json. Read-modify-
 * write right now (other sessions write the file concurrently), atomic rename with
 * the file's mode kept, only that one key touched, silent no-op when the file is
 * missing or does not parse, and no write at all when the value is already true.
 */
export function pretrustFolder(dir: string, home: string = os.homedir()): 'written' | 'already' | 'skipped' {
  const file = path.join(home, '.claude.json');
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return 'skipped';
    const key = path.resolve(dir);
    const projects = (data.projects && typeof data.projects === 'object' ? data.projects : {}) as Record<string, Record<string, unknown>>;
    if (projects[key]?.hasTrustDialogAccepted === true) return 'already';
    // Edit the parsed tree, but only write if the one key is the sole difference.
    const next = { ...data, projects: { ...projects, [key]: { ...(projects[key] ?? {}), hasTrustDialogAccepted: true } } };
    const mode = fs.statSync(file).mode & 0o777;
    const tmp = `${file}.loom-${process.pid}-${Date.now()}.tmp`;
    const indent = /^\{\n( +)"/.exec(raw)?.[1]?.length ?? 2;
    fs.writeFileSync(tmp, JSON.stringify(next, null, indent) + (raw.endsWith('\n') ? '\n' : ''), { mode });
    fs.renameSync(tmp, file);
    return 'written';
  } catch {
    return 'skipped';
  }
}

let trustCache: { file: string; mtimeMs: number; set: Set<string> } | null = null;

/**
 * The folders ~/.claude.json marks as trusted (hasTrustDialogAccepted). Cached on
 * the file's mtime: the board asks on every poll and the file is a few hundred KB.
 * Empty when the file is missing or does not parse.
 */
export function trustedFolders(home: string = os.homedir()): Set<string> {
  const file = path.join(home, '.claude.json');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return new Set();
  }
  if (trustCache && trustCache.file === file && trustCache.mtimeMs === mtimeMs) return trustCache.set;
  const set = new Set<string>();
  try {
    const projects = (JSON.parse(fs.readFileSync(file, 'utf-8')) as { projects?: Record<string, { hasTrustDialogAccepted?: unknown }> }).projects ?? {};
    for (const [k, v] of Object.entries(projects)) if (v && v.hasTrustDialogAccepted === true) set.add(k);
  } catch {
    /* unreadable: nothing trusted */
  }
  trustCache = { file, mtimeMs, set };
  return set;
}

/** Has Claude Code's "do you trust this folder" dialog been accepted for `dir`? */
export function isFolderTrusted(dir: string, home: string = os.homedir()): boolean {
  return trustedFolders(home).has(path.resolve(dir));
}
