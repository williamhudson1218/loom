import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { CLAUDE_PROJECTS_DIR, TOOL_DIR, encodeProjectDir } from './paths.ts';
import { openDb } from './db.ts';
import { parseJsonlFile } from './parser.ts';
import { upsertChat } from './indexer.ts';
import { defaultRun, laneTargets, nextOpenPane, parseLane, readWorld, type TmuxRunner, type WorldState } from './compact.ts';
import { launchInPane, type GotoResult } from './goto.ts';
import { nameNewPanes } from './panenames.ts';
import { isValidProjectDir } from './findchat.ts';
import type { Agent } from './types.ts';

// The board's "New thread" composer: start a fresh agent session in a pane with
// a first prompt, plus any pasted or dropped images saved where the agent can
// read them. The prompt rides the agent's CLI argument (ansi-quoted by
// buildLaunchCommand), so it is never typed into a composer.

export const INBOX_DIR = path.join(TOOL_DIR, 'inbox');
const MAX_IMAGES = 12;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/heic': 'heic',
};

export interface ImageIn {
  name?: string;
  type: string;
  data: string; // base64, no data: prefix
}

export interface NewThreadInput {
  prompt: string;
  projectDir: string;
  agent: Agent;
  lane?: string; // '' = next open pane anywhere
  prefer?: string; // the lane the composer used last; tried first for 'next'
  focus?: boolean;
  images?: ImageIn[];
}

/** Save images to ~/.loom/inbox/<id>/ and return their absolute paths. */
export function saveImages(images: ImageIn[], dir: string = INBOX_DIR, id: string = newId()): string[] {
  if (!images.length) return [];
  const target = path.join(dir, id);
  fs.mkdirSync(target, { recursive: true });
  return images.slice(0, MAX_IMAGES).map((img, i) => {
    const ext = IMAGE_EXT[img.type];
    if (!ext) throw new Error(`unsupported image type ${img.type}`);
    const buf = Buffer.from(img.data, 'base64');
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error('image too large or empty');
    const stem = (img.name || '').replace(/\.[^.]*$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'image';
    const file = path.join(target, `${String(i + 1).padStart(2, '0')}-${stem}.${ext}`);
    fs.writeFileSync(file, buf);
    return file;
  });
}

export function newId(): string {
  return Date.now().toString(36) + '-' + randomBytes(3).toString('hex');
}

/** The prompt the agent receives: the typed text, then one absolute path per image. */
export function promptWithImages(prompt: string, paths: string[]): string {
  const p = prompt.trim();
  if (!paths.length) return p;
  return (p ? p + '\n\n' : '') + paths.join('\n');
}

export type Target = { pane_id: string; split: false } | { split: true; session: string; from: string; horizontal: boolean };

export interface PaneGeom {
  pane_id: string;
  session: string;
  width: number;
  height: number;
}

/**
 * Where a new thread lands. An open pane when there is one: the requested
 * lane's, or for "next", the preferred lane's and then any lane's. Otherwise a
 * split in the session with the most room — fewest panes, then the largest pane
 * — within the requested lane (or any lane for "next"). Split along the pane's
 * long side; terminal cells are about twice as tall as they are wide.
 */
export function chooseTarget(world: WorldState, geom: PaneGeom[], lane: string, prefer = ''): Target | null {
  if (lane) {
    const p = nextOpenPane(lane, world);
    if (p) return { pane_id: p.pane_id, split: false };
  } else {
    const p = (prefer && nextOpenPane(prefer, world)) || null;
    if (p) return { pane_id: p.pane_id, split: false };
    const any = laneTargets(world)[0];
    if (any) return { pane_id: any.pane_id, split: false };
  }
  const bySession = new Map<string, PaneGeom[]>();
  for (const g of geom) {
    const l = parseLane(g.session);
    if (!l || (lane && l.lane !== lane)) continue;
    (bySession.get(g.session) ?? bySession.set(g.session, []).get(g.session)!).push(g);
  }
  const area = (g: PaneGeom) => g.width * g.height;
  const best = [...bySession.entries()]
    .map(([session, panes]) => ({ session, panes, big: [...panes].sort((a, b) => area(b) - area(a))[0] }))
    .sort((a, b) => a.panes.length - b.panes.length || area(b.big) - area(a.big) || a.session.localeCompare(b.session, undefined, { numeric: true }))[0];
  if (!best) return null;
  return { split: true, session: best.session, from: best.big.pane_id, horizontal: best.big.width > best.big.height * 2.2 };
}

export function readGeometry(run: TmuxRunner = defaultRun): PaneGeom[] {
  try {
    return run(['list-panes', '-a', '-F', '#{pane_id} #{session_name} #{pane_width} #{pane_height}'])
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [pane_id, session, w, h] = l.split(' ');
        return { pane_id, session, width: Number(w), height: Number(h) };
      });
  } catch {
    return [];
  }
}

export interface Launched {
  id: string;
  pane_id: string;
  where: string;
  project: string;
  projectDir: string;
  agent: Agent;
  prompt: string;
  at: number;
}

// Launches the board has not yet seen a chat for. The card appears the moment
// the launch returns, as a placeholder, and gives way to the real card once the
// chat in that pane is indexed.
const recent: Launched[] = [];
const LAUNCH_TTL_MS = 5 * 60_000;
export function recentLaunches(now: number = Date.now()): Launched[] {
  while (recent.length && now - recent[0].at > LAUNCH_TTL_MS) recent.shift();
  return [...recent];
}

/**
 * The summarizer pass that indexes chats runs every ten minutes, far too late
 * for a thread just launched from the board. Once the placement hook has tied
 * a launch's pane to its new session, index that one transcript now, so the
 * real card replaces the placeholder within a poll or two.
 */
const indexing = new Set<string>();
export function indexFreshLaunches(
  launches: Launched[],
  live: Record<string, { agent: string; session_id: string; pane_id: string }>,
  known: (agent: string, sid: string) => boolean,
): void {
  for (const g of launches) {
    if (g.agent !== 'claude') continue; // Codex transcripts are dated paths; the pass picks them up
    const hit = Object.values(live).find((l) => l.pane_id === g.pane_id && l.agent === g.agent && !known(l.agent, l.session_id));
    if (!hit || indexing.has(hit.session_id)) continue;
    const file = path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(g.projectDir), `${hit.session_id}.jsonl`);
    let mtime: number;
    try {
      mtime = Math.floor(fs.statSync(file).mtimeMs);
    } catch {
      continue;
    }
    indexing.add(hit.session_id);
    parseJsonlFile(file)
      .then((parsed) => {
        if (!parsed.session_id) return;
        const db = openDb();
        try {
          upsertChat(db, parsed, mtime, Date.now());
        } finally {
          db.close();
        }
      })
      .catch(() => {})
      .finally(() => indexing.delete(hit.session_id));
  }
}

/**
 * A shell pane to launch into: an open one per chooseTarget, or a fresh split
 * (named, and given a beat for its shell to start reading the tty) when the
 * lanes are full. Shared by the composer and the Slack-thread hotkey's resume.
 */
export function acquirePane(
  projectDir: string,
  lane: string,
  prefer: string,
  run: TmuxRunner = defaultRun,
): { ok: true; paneId: string; split: boolean } | { ok: false; detail: string } {
  const target = chooseTarget(readWorld(run), readGeometry(run), lane, prefer);
  if (!target) return { ok: false, detail: lane ? `no loom-${lane}-N session to split` : 'no lane sessions found' };
  if (!target.split) return { ok: true, paneId: target.pane_id, split: false };
  let paneId: string;
  try {
    paneId = run(['split-window', '-d', target.horizontal ? '-h' : '-v', '-t', target.from, '-c', projectDir, '-P', '-F', '#{pane_id}']).trim();
  } catch (e) {
    return { ok: false, detail: 'split failed: ' + (e as Error).message };
  }
  nameNewPanes();
  // Give the new shell a beat to start reading its tty before the launch is typed.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  return { ok: true, paneId, split: true };
}

export function startThread(input: NewThreadInput, run: TmuxRunner = defaultRun): GotoResult & { pane_id?: string; where?: string; images?: string[] } {
  if (!isValidProjectDir(input.projectDir)) return { ok: false, detail: 'invalid project dir' };
  if (!input.prompt.trim() && !input.images?.length) return { ok: false, detail: 'empty prompt' };
  const id = newId();
  let images: string[] = [];
  try {
    images = saveImages(input.images ?? [], INBOX_DIR, id);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  const pane = acquirePane(input.projectDir, input.lane ?? '', input.prefer ?? '', run);
  if (!pane.ok) return pane;
  const { paneId, split } = pane;
  const prompt = promptWithImages(input.prompt, images);
  const r = launchInPane({
    paneId,
    projectDir: input.projectDir,
    sessionId: '',
    sourceAgent: input.agent,
    selectedAgent: input.agent,
    fresh: true,
    prompt,
    focus: !!input.focus,
  });
  if (!r.ok) return r;
  let where = paneId;
  try {
    where = run(['display-message', '-p', '-t', paneId, '#{session_name} · pane #{pane_index}']).trim();
  } catch {
    /* the id is still a usable address */
  }
  recent.push({ id, pane_id: paneId, where, project: path.basename(input.projectDir), projectDir: input.projectDir, agent: input.agent, prompt: prompt.slice(0, 200), at: Date.now() });
  return { ...r, pane_id: paneId, where, images, detail: r.detail + (split ? ' (split a new pane)' : '') };
}
