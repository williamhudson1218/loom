import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defaultGitAsync, parseAheadBehind, resolveBaseRefAsync, type AsyncGitRunner } from './git.ts';
import { repoRootFor } from './trees.ts';
import { renderMarkdown } from './markdown.ts';
import { runningBackground, scanTranscript, type BackgroundTask, type Todo } from './sessionscan.ts';
import { readTranscript } from './transcript.ts';
import type { ChatView, LiveLoc } from './dashboard.ts';
import { threadsFor, type OwnedThread } from './slack.ts';
import { nudgePipeline, parsePrRef, wantPipeline, type Pipeline } from './pipeline.ts';

// The board's detail panel: everything about ONE chat that is too expensive for
// the 4s board poll — git, gh, and a transcript scan. Fetched per selection by
// /api/detail and cached, so clicking around the board never stalls it.

const SEP = '~|LOOM|~';

export type WhereKind = 'main' | 'worktree' | 'branch' | 'none';

export interface Where {
  kind: WhereKind;
  cwd: string;
  top: string; // this checkout's root
  repo: string; // the primary checkout's root
  branch: string;
  base: string;
  ahead: number;
  behind: number;
}

export type FileState = 'committed' | 'staged' | 'uncommitted' | 'untracked' | 'unchanged' | 'ignored' | 'outside';

export interface DetailFile {
  path: string; // relative to the checkout when inside it, else absolute
  status: string; // git letter (A/M/D/R/?) where known
  state: FileState;
}

export interface PrInfo {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft: boolean;
  reviewDecision: string;
  ci: 'pass' | 'fail' | 'pending' | 'none';
}

export interface PaneLabels {
  topic: string;
  stage: string;
  name: string;
}

export interface Detail {
  ok: true;
  agent: string;
  session_id: string;
  labels: PaneLabels;
  where: Where;
  filesMode: 'branch' | 'session';
  files: DetailFile[];
  last: { html: string; at: number } | null;
  pr: (PrInfo & { loading?: false }) | { loading: true; ref: string } | null;
  todos: Todo[];
  background: BackgroundTask[];
  slack: OwnedThread[];
  // The PR's road to prod. Served from the pipeline store; null until its first fetch lands.
  pipeline: Pipeline | null;
  pipelineRef: { repo: string; number: number } | null;
  // Something is still being fetched in the background (gh, Slack); ask again shortly.
  pending: boolean;
}

/* ------------------------------------------------------------------ parsers */

export function parseNameStatus(out: string): { status: string; path: string }[] {
  const rows: { status: string; path: string }[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    // A rename/copy is `R100<TAB>old<TAB>new`; the new path is the one that exists.
    rows.push({ status: parts[0].charAt(0), path: parts[parts.length - 1] });
  }
  return rows;
}

export interface PorcelainEntry {
  x: string; // index (staged) column
  y: string; // worktree column
}

// `git status --porcelain=v1 -z`: `XY path\0`, with a rename's original path in
// the NEXT NUL field. -z so paths with spaces or quotes arrive verbatim.
export function parsePorcelainZ(out: string): Map<string, PorcelainEntry> {
  const m = new Map<string, PorcelainEntry>();
  const fields = out.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    const x = f.charAt(0);
    const y = f.charAt(1);
    m.set(f.slice(3), { x, y });
    if (x === 'R' || x === 'C') i++;
  }
  return m;
}

function porcelainState(e: PorcelainEntry): { status: string; state: FileState } {
  if (e.x === '?' && e.y === '?') return { status: '?', state: 'untracked' };
  // Anything still modified in the worktree is the more urgent truth, even if part is staged.
  if (e.y !== ' ' && e.y !== '') return { status: e.y === 'D' ? 'D' : e.x !== ' ' ? e.x : 'M', state: 'uncommitted' };
  return { status: e.x, state: 'staged' };
}

/**
 * The files THIS session edited, each marked against git. On a shared checkout
 * git cannot say who changed what, so the session's own Edit/Write calls are the
 * list and git only supplies each file's state.
 */
export function sessionFileStates(
  edited: string[],
  top: string,
  status: Map<string, PorcelainEntry>,
  committed: Set<string>,
  ignored: Set<string> = new Set(),
): DetailFile[] {
  const out: DetailFile[] = [];
  for (const abs of edited) {
    const rel = top ? path.relative(top, abs) : '';
    if (!top || !rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      out.push({ path: abs, status: '', state: 'outside' });
      continue;
    }
    const e = status.get(rel);
    if (e) out.push({ path: rel, ...porcelainState(e) });
    else if (committed.has(rel)) out.push({ path: rel, status: 'M', state: 'committed' });
    else if (ignored.has(rel)) out.push({ path: rel, status: '', state: 'ignored' });
    else out.push({ path: rel, status: '', state: 'unchanged' });
  }
  return sortFiles(out);
}

/** A branch's files: its commits since the base, overlaid with what is still uncommitted. */
export function branchFileStates(nameStatus: { status: string; path: string }[], status: Map<string, PorcelainEntry>): DetailFile[] {
  const by = new Map<string, DetailFile>();
  for (const r of nameStatus) by.set(r.path, { path: r.path, status: r.status, state: 'committed' });
  for (const [p, e] of status) by.set(p, { path: p, ...porcelainState(e) });
  return sortFiles([...by.values()]);
}

const STATE_ORDER: FileState[] = ['uncommitted', 'untracked', 'staged', 'committed', 'unchanged', 'ignored', 'outside'];
function sortFiles(files: DetailFile[]): DetailFile[] {
  return files.sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.path.localeCompare(b.path));
}

export function ciState(rollup: unknown): PrInfo['ci'] {
  if (!Array.isArray(rollup) || !rollup.length) return 'none';
  let pending = false;
  for (const c of rollup as any[]) {
    const conclusion = String(c?.conclusion ?? c?.state ?? '').toUpperCase();
    const status = String(c?.status ?? '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(conclusion)) return 'fail';
    if (['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING'].includes(conclusion) || (status && status !== 'COMPLETED') || (!conclusion && !status)) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

/* ---------------------------------------------------------------- gathering */

export function paneLabels(paneId: string): PaneLabels {
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '-t', paneId, `#{@topic}${SEP}#{@stage}${SEP}#{@name}`], {
      encoding: 'utf-8',
      timeout: 1000,
    }).trim();
    const [topic = '', stage = '', name = ''] = out.split(SEP);
    return { topic, stage, name };
  } catch {
    return { topic: '', stage: '', name: '' };
  }
}

async function q(git: AsyncGitRunner, args: string[], cwd: string): Promise<string> {
  try {
    return await git(args, cwd);
  } catch {
    return '';
  }
}

const BASE_BRANCHES = new Set(['main', 'master']);

export async function whereFor(cwd: string, git: AsyncGitRunner = defaultGitAsync, root: (d: string) => string | null = repoRootFor): Promise<Where> {
  const none: Where = { kind: 'none', cwd, top: '', repo: '', branch: '', base: '', ahead: 0, behind: 0 };
  if (!cwd || !fs.existsSync(cwd)) return none;
  const [top, branch] = (await q(git, ['rev-parse', '--show-toplevel', '--abbrev-ref', 'HEAD'], cwd)).trim().split('\n');
  if (!top) return none;
  const repo = root(top) ?? top;
  const base = await resolveBaseRefAsync(top, git);
  const isMain = BASE_BRANCHES.has(branch);
  const { ahead, behind } = isMain ? { ahead: 0, behind: 0 } : parseAheadBehind(await q(git, ['rev-list', '--left-right', '--count', `${base}...HEAD`], top));
  const kind: WhereKind = isMain ? 'main' : top !== repo ? 'worktree' : 'branch';
  return { kind, cwd, top, repo, branch, base, ahead, behind };
}

export async function filesFor(
  where: Where,
  edited: string[],
  sinceMs: number,
  git: AsyncGitRunner = defaultGitAsync,
): Promise<{ mode: 'branch' | 'session'; files: DetailFile[] }> {
  if (where.kind === 'none') return { mode: 'session', files: sessionFileStates(edited, '', new Map(), new Set()) };
  const status = parsePorcelainZ(await q(git, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], where.top));
  if (where.kind !== 'main') {
    const ns = parseNameStatus(await q(git, ['diff', '--name-status', `${where.base}...HEAD`], where.top));
    return { mode: 'branch', files: branchFileStates(ns, status) };
  }
  // The shared checkout: only this session's own files, and only the uncommitted
  // ones are in `status`. A clean file is "committed" if a commit since the
  // session began touched it — on ANY ref, since a ship lands through a branch
  // and a PR, and local main may not have pulled it yet.
  const committed = new Set<string>();
  if (sinceMs && edited.length) {
    const since = new Date(sinceMs).toISOString();
    for (const l of (await q(git, ['log', '--all', `--since=${since}`, '--format=', '--name-only', '-n', '2000'], where.top)).split('\n')) {
      if (l.trim()) committed.add(l.trim());
    }
  }
  // Gitignored files (scripts/local, scratch) never show in status; say so rather than "unchanged".
  const inside = edited.map((f) => path.relative(where.top, f)).filter((r) => r && !r.startsWith('..') && !path.isAbsolute(r));
  const ignored = new Set(inside.length ? (await q(git, ['check-ignore', '--', ...inside], where.top)).split('\n').map((l) => l.trim()).filter(Boolean) : []);
  return { mode: 'session', files: sessionFileStates(edited, where.top, status, committed, ignored) };
}

/* ------------------------------------------------------------------ gh cache */

export type GhRunner = (args: string[], cwd: string) => Promise<string>;
export const defaultGh: GhRunner = (args, cwd) =>
  new Promise((resolve, reject) =>
    execFile('gh', args, { cwd, encoding: 'utf-8', timeout: 20_000 }, (err, out) => (err ? reject(err) : resolve(out))),
  );

const PR_TTL_MS = 60_000;
const PR_FIELDS = 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup';
const prCache = new Map<string, { at: number; value: PrInfo | null; inflight?: Promise<void> }>();

export function toPrInfo(raw: any): PrInfo | null {
  if (!raw || typeof raw.number !== 'number') return null;
  return {
    number: raw.number,
    title: String(raw.title ?? ''),
    url: String(raw.url ?? ''),
    state: String(raw.state ?? ''),
    isDraft: !!raw.isDraft,
    reviewDecision: String(raw.reviewDecision ?? ''),
    ci: ciState(raw.statusCheckRollup),
  };
}

/**
 * Never blocks: answers from cache, and on a miss starts the gh call and says
 * so. The panel re-asks a few seconds later. A stale entry is still served
 * while it refreshes, so a PR that showed once never blinks back to "loading".
 */
export function prLookup(ref: string, cwd: string, repo: string, gh: GhRunner = defaultGh, now: number = Date.now()): Detail['pr'] {
  const key = `${repo || cwd}#${ref}`;
  const hit = prCache.get(key);
  if (!hit || (now - hit.at > PR_TTL_MS && !hit.inflight)) {
    const entry = hit ?? { at: 0, value: null };
    const args = ['pr', 'view', ref, '--json', PR_FIELDS, ...(repo ? ['--repo', repo] : [])];
    entry.inflight = gh(args, cwd)
      .then((out) => { entry.value = toPrInfo(JSON.parse(out)); })
      .catch(() => { entry.value = null; })
      .finally(() => { entry.at = Date.now(); entry.inflight = undefined; });
    prCache.set(key, entry);
  }
  const e = prCache.get(key)!;
  if (e.at === 0) return { loading: true, ref };
  return e.value;
}

/* ------------------------------------------------------------------ assembly */

const LAST_CHARS = 6000; // the TAIL of a long reply is the part that asks the question

export async function buildDetail(view: ChatView, live: LiveLoc | undefined, git: AsyncGitRunner = defaultGitAsync, gh: GhRunner = defaultGh): Promise<Detail> {
  const scan = view.agent === 'claude' ? scanTranscript(view.jsonl_path) : null;
  const labels = live ? paneLabels(live.pane_id) : { topic: '', stage: '', name: '' };
  if (live?.name && !labels.name) labels.name = live.name;
  const where = await whereFor(live?.cwd || view.project_dir, git);
  const edited = scan ? Object.keys(scan.editedFiles) : [];
  const { mode, files } = await filesFor(where, edited, scan?.firstAt ?? 0, git);

  let pr: Detail['pr'] = null;
  const fromUrl = view.pr_url ? parsePrUrl(view.pr_url) : null;
  if (fromUrl) pr = prLookup(String(fromUrl.number), where.top || view.project_dir, fromUrl.repo, gh);
  else if (where.kind === 'worktree' || where.kind === 'branch') pr = prLookup(where.branch, where.top, '', gh);

  let last: Detail['last'] = null;
  const lastMsg = scan ? scan.lastAssistant : codexLast(view);
  if (lastMsg) {
    const t = lastMsg.text;
    const tail = t.length > LAST_CHARS ? '…' + t.slice(t.length - LAST_CHARS) : t;
    last = { html: renderMarkdown(tail), at: lastMsg.at };
  }

  // The pipeline is keyed by repo + number; a branch-resolved PR only learns them from its url.
  const pipelineRef = fromUrl ?? (pr && !pr.loading && pr.url ? parsePrRef(pr.url) : null);
  const pipeline = pipelineRef ? wantPipeline(pipelineRef.repo, pipelineRef.number, !!live) : null;
  if (pipelineRef && !pipeline) nudgePipeline(pipelineRef.repo, pipelineRef.number);

  const slack = threadsFor(view.session_id);
  return {
    ok: true,
    agent: view.agent,
    session_id: view.session_id,
    labels,
    where,
    filesMode: mode,
    files,
    last,
    pr,
    todos: scan?.todos ?? [],
    background: scan ? runningBackground(scan) : [],
    slack,
    pipeline,
    pipelineRef,
    pending: !!(pr && pr.loading) || (!!pipelineRef && !pipeline) || slack.some((t) => t.preview === null),
  };
}

// Codex transcripts are a different format; the existing reader already parses them.
function codexLast(view: ChatView): { text: string; at: number } | null {
  const msgs = readTranscript(view.agent, view.jsonl_path, { limit: 40 }).filter((m) => m.role === 'assistant');
  return msgs.length ? { text: msgs[msgs.length - 1].text, at: view.last_active_at } : null;
}

/** Just the tail of the last assistant message, for the "Waiting on you" list. */
export function lastMessageTail(view: ChatView, chars = 280): string {
  const t = (view.agent === 'claude' ? scanTranscript(view.jsonl_path).lastAssistant : codexLast(view))?.text ?? '';
  const flat = t.replace(/\s+/g, ' ').trim();
  return flat.length > chars ? '…' + flat.slice(flat.length - chars) : flat;
}
