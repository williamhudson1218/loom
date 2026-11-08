import os from 'node:os';
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { SESSION_PREFIX } from './paths.ts';
import { defaultRun, parseLane, readWorld, trackIdle, type LanePane, type TmuxRunner, type WorldState } from './compact.ts';
import { assignNames, type PaneNameRow } from './panenames.ts';
import { isViewSession } from './tmux.ts';
import { openDb } from './db.ts';
import { getSetting } from './settingsSchema.ts';

// Loom-managed panes (design §4). When there are no `loom-<lane>-<n>` sessions,
// Loom keeps its chats in ONE tmux session of its own, one window per chat,
// each window named with its pane's @name. Loom creates the window in the
// chat's project directory, and reaps it once the agent has exited and the
// shell has sat idle for a while. A lane workspace keeps its own strategy
// (acquirePane in newthread.ts); this file is only used when no lanes exist.

export const MANAGED_SESSION = `${SESSION_PREFIX}managed`;
export const REAP_AFTER_MS = 10 * 60_000;

const SHELL = /^(zsh|bash|fish|sh)$/;
const SEP = '~|LOOM|~';

/* ------------------------------------------------------------ strategy */

export type Strategy = 'lanes' | 'managed';

// The `launch_target` setting: where New thread / Resume / Branch / Slack
// auto-start put a chat.
//   managed  always a loom-managed window, even when lane sessions exist
//            (setup.sh writes this on a new install)
//   lanes    the lane workspace when one exists, else managed
//   unset    same as lanes: an existing install keeps today's behaviour
export const LAUNCH_TARGETS: Strategy[] = ['lanes', 'managed'];
export const parseLaunchTarget = (v: unknown): Strategy | null => (v === 'lanes' || v === 'managed' ? v : null);

export function getLaunchTarget(db: Database.Database): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'launch_target'`).get() as { value: string } | undefined;
  return row?.value?.trim() ?? '';
}

export function setLaunchTarget(db: Database.Database, t: Strategy): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('launch_target', ?)`).run(t);
  launchMemo = null;
}

let launchMemo: { at: number; v: string } | null = null;

/** The stored launch_target, briefly cached ('' when unset or unreadable). Never throws. */
export function launchTargetSetting(now: number = Date.now()): string {
  if (launchMemo && now - launchMemo.at < 3000) return launchMemo.v;
  let v = '';
  try {
    const db = openDb();
    try {
      v = getLaunchTarget(db);
    } finally {
      db.close();
    }
  } catch {
    /* no db: today's rule */
  }
  launchMemo = { at: now, v };
  return v;
}

/**
 * Where a new chat goes. launch_target=managed: always a managed window.
 * Otherwise any lane session (`loom-<lane>-<n>`) means the owner's workflow:
 * keep today's lane logic untouched, and no lanes at all means managed windows.
 * The managed session itself is never a lane (no numeric suffix).
 */
export function pickStrategy(world: Pick<WorldState, 'panes'>, stored: string = launchTargetSetting()): Strategy {
  if (parseLaunchTarget(stored) === 'managed') return 'managed';
  return world.panes.some((p) => parseLane(p.tmux_session) !== null) ? 'lanes' : 'managed';
}

/* ------------------------------------------------------------ cap */

export interface Resources {
  freeMem: number; // bytes
  totalMem: number; // bytes
  load1: number;
  cpus: number;
}

export interface CapacityLimits {
  minFreeFraction: number; // of total memory
  minFreeBytes: number;
  maxLoadPerCpu: number;
}

// The floor is low on purpose: this refuses a machine that is actually out of
// memory or thrashing, not one that is merely using its RAM. "Free" is the
// reclaimable total (see parseVmStat), not os.freemem()'s free pages alone.
export const DEFAULT_LIMITS: CapacityLimits = {
  minFreeFraction: 0.02,
  minFreeBytes: 300 * 1024 * 1024,
  maxLoadPerCpu: 2,
};

export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): CapacityLimits {
  const mb = Number(env.LOOM_MIN_FREE_MB);
  const load = Number(env.LOOM_MAX_LOAD_PER_CPU);
  return {
    ...DEFAULT_LIMITS,
    // An explicit floor replaces the percentage rule rather than adding to it.
    ...(Number.isFinite(mb) && mb > 0 ? { minFreeBytes: mb * 1024 * 1024, minFreeFraction: 0 } : {}),
    ...(Number.isFinite(load) && load > 0 ? { maxLoadPerCpu: load } : {}),
  };
}

/** Capacity limits from the settings registry (env still wins inside getSetting). 0 MB = the built-in rule. */
export function limitsFromSettings(db: Database.Database, env: NodeJS.ProcessEnv = process.env): CapacityLimits {
  const mb = getSetting(db, 'min_free_mb', { env });
  const load = getSetting(db, 'max_load_per_cpu', { env });
  return {
    ...DEFAULT_LIMITS,
    ...(mb > 0 ? { minFreeBytes: mb * 1024 * 1024, minFreeFraction: 0 } : {}),
    ...(load > 0 ? { maxLoadPerCpu: load } : {}),
  };
}

// The limits for a new managed chat: the settings when the DB opens, else the env.
function currentLimits(): CapacityLimits {
  try {
    const db = openDb();
    try {
      return limitsFromSettings(db);
    } finally {
      db.close();
    }
  } catch {
    return limitsFromEnv();
  }
}

/** The idle time before a finished managed window closes, from `reap_idle_min`. */
export function reapTtlMs(db: Database.Database): number {
  return getSetting(db, 'reap_idle_min') * 60_000;
}

/**
 * Memory the system can hand out without swapping, from `vm_stat`: free, inactive
 * (cached, reclaimable), speculative and purgeable pages. os.freemem() counts
 * only the free pages, which on a Mac in daily use is a small fraction of what
 * is really available. null when the text is not vm_stat's.
 */
export function parseVmStat(text: string): number | null {
  const size = Number(/page size of (\d+) bytes/.exec(text)?.[1]);
  if (!size) return null;
  const pages = (label: string): number => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(text)?.[1] ?? 0);
  const n = pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
  return n > 0 ? n * size : null;
}

function availableMem(): number {
  if (process.platform === 'darwin') {
    try {
      const v = parseVmStat(execFileSync('vm_stat', { encoding: 'utf-8', timeout: 2000 }));
      if (v) return v;
    } catch {
      /* fall back */
    }
  }
  return os.freemem();
}

export function readResources(): Resources {
  return { freeMem: availableMem(), totalMem: os.totalmem(), load1: os.loadavg()[0] ?? 0, cpus: os.cpus().length || 1 };
}

const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

/** Pure: may another agent be started on this machine right now? */
export function capacityVerdict(r: Resources, limits: CapacityLimits = DEFAULT_LIMITS): { ok: true } | { ok: false; detail: string } {
  const floor = Math.max(limits.minFreeBytes, r.totalMem * limits.minFreeFraction);
  if (r.freeMem < floor) {
    return { ok: false, detail: `Not starting a new chat: only ${gb(r.freeMem)} GB of memory is free (needs ${gb(floor)} GB). Close a chat or an app and try again.` };
  }
  const perCpu = r.load1 / Math.max(1, r.cpus);
  if (perCpu > limits.maxLoadPerCpu) {
    return { ok: false, detail: `Not starting a new chat: the machine is overloaded (load ${r.load1.toFixed(1)} on ${r.cpus} cores). Try again in a minute.` };
  }
  return { ok: true };
}

/* ------------------------------------------------------------ create */

function quiet(run: TmuxRunner, args: string[]): boolean {
  try {
    run(args);
    return true;
  } catch {
    return false;
  }
}

function paneNameRows(run: TmuxRunner): PaneNameRow[] {
  try {
    return run(['list-panes', '-a', '-F', `#{pane_id}${SEP}#{session_name}${SEP}#{@name}`])
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const p = l.split(SEP);
        return { pane_id: p[0], session_name: p[1] ?? '', name: (p[2] ?? '').trim() };
      })
      .filter((r) => !isViewSession(r.session_name));
  } catch {
    return [];
  }
}

/** Give one pane its @name (reusing the workspace vocabulary) and return it. */
export function namePane(paneId: string, run: TmuxRunner = defaultRun, rand: () => number = Math.random): string {
  const rows = paneNameRows(run);
  const mine = rows.find((r) => r.pane_id === paneId);
  if (mine?.name) return mine.name;
  const name = assignNames(rows.filter((r) => r.pane_id === paneId || r.name), SESSION_PREFIX, rand).get(paneId) ?? '';
  if (name) quiet(run, ['set-option', '-p', '-t', paneId, '@name', name]);
  return name;
}

export type ManagedPaneResult = { ok: true; paneId: string; name: string; where: string } | { ok: false; detail: string };

export interface CreateOpts {
  run?: TmuxRunner;
  /** Block until the new shell can take typed input (newthread.waitForShellReady). */
  ready?: (paneId: string) => boolean;
  resources?: () => Resources;
  limits?: CapacityLimits;
  rand?: () => number;
}

/**
 * A fresh managed window in `projectDir`, named after its pane. Creates the
 * managed session on first use. Refuses (with a message the UI can show) when
 * the machine is short of memory or overloaded.
 */
export function acquireManagedPane(projectDir: string, opts: CreateOpts = {}): ManagedPaneResult {
  const run = opts.run ?? defaultRun;
  const cap = capacityVerdict((opts.resources ?? readResources)(), opts.limits ?? currentLimits());
  if (!cap.ok) return cap;
  let paneId: string;
  try {
    if (quiet(run, ['has-session', '-t', `=${MANAGED_SESSION}`])) {
      paneId = run(['new-window', '-d', '-t', `=${MANAGED_SESSION}:`, '-c', projectDir, '-P', '-F', '#{pane_id}']).trim();
    } else {
      paneId = run(['new-session', '-d', '-s', MANAGED_SESSION, '-c', projectDir, '-P', '-F', '#{pane_id}']).trim();
    }
  } catch (e) {
    return { ok: false, detail: 'could not create a window: ' + (e as Error).message };
  }
  if (!/^%\d+$/.test(paneId)) return { ok: false, detail: 'tmux did not return a pane id' };
  const name = namePane(paneId, run, opts.rand);
  if (name) quiet(run, ['rename-window', '-t', paneId, name]);
  opts.ready?.(paneId);
  return { ok: true, paneId, name, where: `${MANAGED_SESSION} · ${name || paneId}` };
}

/* ------------------------------------------------------------ reap */

export interface ReapOpts {
  now: number;
  ttlMs?: number;
  /** Pane ids whose chat is saved for later: never reaped. */
  saved?: ReadonlySet<string>;
  /** The pane someone is looking at right now. */
  focused?: string | null;
}

/**
 * Windows to kill, as one pane id each. A window goes only when EVERY pane in it
 * is an idle shell with no agent under it, has been seen idle for the ttl, and
 * is not saved or focused. `idleSince` is trackIdle's first-seen-idle stamps.
 */
export function planReap(panes: LanePane[], idleSince: ReadonlyMap<string, number>, opts: ReapOpts): string[] {
  const ttl = opts.ttlMs ?? REAP_AFTER_MS;
  const windows = new Map<string, LanePane[]>();
  for (const p of panes) (windows.get(`${p.tmux_session}:${p.window_index}`) ?? windows.set(`${p.tmux_session}:${p.window_index}`, []).get(`${p.tmux_session}:${p.window_index}`)!).push(p);
  const out: string[] = [];
  for (const members of windows.values()) {
    const done = members.every((p) => {
      if (p.agent || !SHELL.test(p.command)) return false;
      if (opts.saved?.has(p.pane_id) || p.pane_id === opts.focused) return false;
      const since = idleSince.get(p.pane_id);
      return since !== undefined && opts.now - since >= ttl;
    });
    if (done) out.push(members[0].pane_id);
  }
  return out;
}

export function savedPaneIds(db: Database.Database): Set<string> {
  const rows = db
    .prepare(`SELECT last_pane_id FROM chats WHERE saved = 1 AND last_pane_id != '' AND last_tmux_session = ?`)
    .all(MANAGED_SESSION) as { last_pane_id: string }[];
  const out = new Set(rows.map((r) => r.last_pane_id));
  // The orchestrator's window is never reaped: its supervisor relaunches the
  // agent there instead (src/orchsession.ts).
  const orch = db.prepare(`SELECT value FROM settings WHERE key = 'orchestrator_pane_id'`).get() as { value: string } | undefined;
  if (orch?.value) out.add(orch.value);
  return out;
}

const idleSince = new Map<string, number>();

/** One reap pass. Returns the panes whose windows it killed. Never throws. */
export function reapManaged(
  deps: { run?: TmuxRunner; saved: () => Set<string>; now?: number; idle?: Map<string, number>; ttlMs?: number },
): string[] {
  const run = deps.run ?? defaultRun;
  const idle = deps.idle ?? idleSince;
  const now = deps.now ?? Date.now();
  try {
    if (!quiet(run, ['has-session', '-t', `=${MANAGED_SESSION}`])) {
      idle.clear();
      return [];
    }
    const world = readWorld(run);
    const mine = world.panes.filter((p) => p.tmux_session === MANAGED_SESSION);
    trackIdle(mine, idle, now);
    const doomed = planReap(mine, idle, { now, ttlMs: deps.ttlMs, saved: deps.saved(), focused: world.focused });
    return doomed.filter((id) => quiet(run, ['kill-window', '-t', id]));
  } catch {
    return [];
  }
}

// The saved panes and the reap ttl, read together so a settings change applies on the next tick.
const reapStateFromDb = (): { saved: Set<string>; ttlMs: number } => {
  const db = openDb();
  try {
    return { saved: savedPaneIds(db), ttlMs: reapTtlMs(db) };
  } finally {
    db.close();
  }
};

const savedFromDb = (): Set<string> => {
  const db = openDb();
  try {
    return savedPaneIds(db);
  } finally {
    db.close();
  }
};

/** Periodic reap, off the request path. A failed pass is silent: the next one retries. */
export function startManagedTicks(everyMs = 60_000, saved: () => Set<string> = savedFromDb): void {
  setInterval(() => {
    // The default reads reap_idle_min each tick; a caller-supplied `saved` keeps the built-in ttl.
    let ttlMs: number | undefined;
    let ids: () => Set<string> = saved;
    if (saved === savedFromDb) {
      try {
        const st = reapStateFromDb();
        ttlMs = st.ttlMs;
        ids = () => st.saved;
      } catch {
        /* settings unreadable: reap with the built-in ttl */
      }
    }
    reapManaged({ saved: ids, ttlMs });
  }, everyMs);
}
