import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { openDb } from './db.ts';
import { defaultGitAsync, type AsyncGitRunner } from './git.ts';
import { defaultGh, type GhRunner } from './detail.ts';
import { buildShipBoard, chatEditsFor, shipConfigFor, shipRepos } from './ships.ts';
import type { ChatView, LiveLoc } from './dashboard.ts';
import {
  buildShipDetail, guessOwner, loadAllOverrides, mergeLabel, parseNumstatZ, readLabelsFile, shipDisabledReason, shipPrompt,
  type Guess, type MergedLabel, type ShipDetail,
} from './shipview.ts';
import type { startThread } from './newthread.ts';

const execFileAsync = promisify(execFile);
const GUESS_WINDOW_MS = 14 * 24 * 3_600_000;

/** Read-only git for the modal. GIT_OPTIONAL_LOCKS=0 keeps `diff`/`status` from taking index.lock. */
export const readOnlyGit: AsyncGitRunner = async (args, cwd) => {
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf-8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
  return stdout;
};

const keySession = (k: string) => k.slice(k.indexOf(':') + 1);

export interface DetailDeps {
  git?: AsyncGitRunner;
  gh?: GhRunner;
  views: ChatView[];
  live: Record<string, LiveLoc>;
  now?: number;
  labelsFile?: string;
}

export function isShipRepo(repo: string): boolean {
  return shipRepos().includes(repo);
}

async function q(git: AsyncGitRunner, args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

export async function gatherShipDetail(repo: string, d: DetailDeps): Promise<ShipDetail> {
  const git = d.git ?? readOnlyGit;
  const now = d.now ?? Date.now();
  const db = openDb();
  try {
    const board = await buildShipBoard(repo, d.views, d.live, git, d.gh ?? defaultGh, now, loadAllOverrides(db), shipConfigFor(repo, db));
    const [stagedOut, unstagedOut] = await Promise.all([
      q(git, ['diff', '--cached', '--numstat', '-z', '--no-renames'], repo),
      q(git, ['diff', '--numstat', '-z', '--no-renames'], repo),
    ]);
    const guesses: Record<string, Guess | null> = {};
    if (board.next.unattributed.length) {
      // A wider window than the board's: the chat that wrote it may be days old.
      const wide = await chatEditsFor(repo, d.views, d.live, now, GUESS_WINDOW_MS);
      for (const f of board.next.unattributed) guesses[f.path] = guessOwner(f.path, wide);
    }
    const file = readLabelsFile(d.labelsFile);
    const titles: Record<string, string> = {};
    const labels: Record<string, MergedLabel> = {};
    for (const c of board.next.chats) {
      const v = d.views.find((x) => `${x.agent}:${x.session_id}` === c.key);
      titles[c.key] = (v?.title || v?.claude_auto_title || v?.overview || v?.first_message || '').split('\n')[0].slice(0, 160);
      labels[c.key] = mergeLabel(db, file, keySession(c.key), repo, titles[c.key]);
    }
    return buildShipDetail({ board, staged: parseNumstatZ(stagedOut), unstaged: parseNumstatZ(unstagedOut), titles, labels, guesses });
  } finally {
    db.close();
  }
}

/** The staged (or working-tree) diff of one file, capped. Paths are validated, never passed as options. */
export const MAX_DIFF_BYTES = 400_000;
export function safeRepoPath(p: string): boolean {
  return !!p && !p.startsWith('/') && !p.startsWith('-') && !p.split('/').includes('..') && !p.includes('\0');
}
export async function shipFileDiff(repo: string, filePath: string, which: 'staged' | 'unstaged', git: AsyncGitRunner = readOnlyGit): Promise<{ diff: string; truncated: boolean }> {
  if (!safeRepoPath(filePath)) throw new Error('bad path');
  const args = ['--no-pager', 'diff', '--no-color', '--no-ext-diff', '--no-renames', ...(which === 'staged' ? ['--cached'] : []), '--', filePath];
  const out = await git(args, repo);
  return out.length > MAX_DIFF_BYTES ? { diff: out.slice(0, MAX_DIFF_BYTES), truncated: true } : { diff: out, truncated: false };
}

/* -------------------------------------------------------------- the launch */

export interface ShipStartDeps {
  start: typeof startThread;
}

export type ShipStartResult = { ok: true; paneId: string; where: string; prompt: string } | { ok: false; status: number; detail: string };

/**
 * Start the ship session through the same managed-window path New thread uses.
 * Re-checks the gate against the detail it is given so a stale modal cannot ship nothing.
 */
export function startShipSession(detail: Pick<ShipDetail, 'repo' | 'onMain' | 'totals' | 'lock'> & { base?: string; command?: string }, deps: ShipStartDeps): ShipStartResult {
  const gate = shipDisabledReason({ onMain: detail.onMain, staged: detail.totals.staged, lock: detail.lock, base: detail.base });
  if (!gate.ok) return { ok: false, status: 409, detail: gate.reason };
  const prompt = shipPrompt(detail.command);
  const r = deps.start({ prompt, projectDir: detail.repo, agent: 'claude', lane: '', focus: false });
  if (!r.ok) return { ok: false, status: 409, detail: r.detail };
  return { ok: true, paneId: r.pane_id ?? '', where: r.where ?? '', prompt };
}
