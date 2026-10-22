import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { COMPACT_LOG_PATH, COMPACT_OFF_PATH, SESSION_PREFIX } from './paths.ts';
import { agentPaneIds } from './placements.ts';

// Lane compaction (issue #1). Workspace sessions numbered `loom-<lane>-<N>` form
// a lane, and live agent panes are kept packed to the left of it: when a Claude
// session ends, its pane drops back to a shell (a "hole"), and every agent pane
// after it slides one slot toward it, so the lane keeps its order — a pane only
// ever moves past the holes freed ahead of it, never past another chat. (Until
// 2026-10-20 the LAST pane in the lane jumped into the hole instead, which
// teleported a chat from tp-5 to tp-2 and made the lane impossible to keep in
// one's head.) Everything is a `swap-pane`, never a create or kill, so every
// session keeps its grid and every pane keeps its `%id`, `@name`, `@group` and
// running process — probed against tmux on 2026-09-30.
//
// The planner is pure so it can be tested against fake pane lists; the executor
// and `move`/`ungroup` take an injected tmux runner for the same reason.

export const HOLE_GRACE_MS = 30_000; // room for `claude --resume` in place
export const MAX_SWAPS_PER_TICK = 8;

const SHELL = /^(zsh|bash|fish|sh)$/;
const SEP = '~|LOOM|~';

export type TmuxRunner = (args: string[]) => string;
export type PaneClass = 'claude' | 'hole' | 'pinned';

export interface LanePane {
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  command: string;
  name: string; // @name, '' if unnamed
  group: string; // @group, '' if ungrouped
  agent: boolean; // a claude/codex process is among its descendants
}

export interface WorldState {
  panes: LanePane[];
  focused: string | null;
}

export interface Swap {
  lane: string;
  src: string; // the agent pane moving left
  dst: string; // the hole it lands in
}

export const defaultRun: TmuxRunner = (args) => execFileSync('tmux', args, { encoding: 'utf-8' });

// `loom-tp-forms-8` -> { lane: 'tp-forms', n: 8 }. Sessions without a numeric
// suffix (`loom-tp-terminals`) are in no lane and are never touched.
export function parseLane(session: string, prefix: string = SESSION_PREFIX): { lane: string; n: number } | null {
  if (!session.startsWith(prefix)) return null;
  const m = session.slice(prefix.length).match(/^(.+)-(\d+)$/);
  return m ? { lane: m[1], n: Number(m[2]) } : null;
}

export function classifyPane(
  p: LanePane,
  idleSince: ReadonlyMap<string, number>,
  focused: string | null,
  now: number,
  graceMs: number = HOLE_GRACE_MS,
): PaneClass {
  if (!parseLane(p.tmux_session)) return 'pinned';
  if (p.pane_id === focused || p.group) return 'pinned';
  if (p.agent) return 'claude';
  if (!SHELL.test(p.command)) return 'pinned';
  const since = idleSince.get(p.pane_id);
  return since !== undefined && now - since >= graceMs ? 'hole' : 'pinned';
}

// Keep first-seen-idle stamps: set on a shell's first idle sighting, cleared the
// moment an agent runs in it, dropped when the pane is gone.
export function trackIdle(panes: LanePane[], idleSince: Map<string, number>, now: number): void {
  const seen = new Set<string>();
  for (const p of panes) {
    seen.add(p.pane_id);
    if (!p.agent && SHELL.test(p.command)) {
      if (!idleSince.has(p.pane_id)) idleSince.set(p.pane_id, now);
    } else {
      idleSince.delete(p.pane_id);
    }
  }
  for (const id of [...idleSince.keys()]) if (!seen.has(id)) idleSince.delete(id);
}

function slotOrder(a: LanePane, b: LanePane): number {
  return (
    parseLane(a.tmux_session)!.n - parseLane(b.tmux_session)!.n ||
    Number(a.window_index) - Number(b.window_index) ||
    Number(a.pane_index) - Number(b.pane_index)
  );
}

// Per lane: fill the earliest hole with the NEAREST agent pane after it, update
// the model and go again. The hole lands where that pane was, so the next pass
// pulls the pane behind it one slot too: the whole tail shifts left, each pane
// moving exactly as many slots as there are holes ahead of it. A pinned agent
// pane — one Will is in, or a group member — is a wall: a hole before it fills
// only from the panes between them, so nothing ever changes places with it.
// Lanes never exchange panes. Capped per tick so a big reshuffle is spread out
// (a 24-slot lane with three holes settles in two ticks).
export function planCompaction(
  panes: LanePane[],
  idleSince: ReadonlyMap<string, number>,
  focused: string | null,
  now: number,
): Swap[] {
  const lanes = new Map<string, LanePane[]>();
  for (const p of panes) {
    const l = parseLane(p.tmux_session);
    if (l) (lanes.get(l.lane) ?? lanes.set(l.lane, []).get(l.lane)!).push(p);
  }
  const swaps: Swap[] = [];
  for (const [lane, members] of lanes) {
    const slots = [...members]
      .sort(slotOrder)
      .map((p) => ({ id: p.pane_id, agent: p.agent, cls: classifyPane(p, idleSince, focused, now) }));
    let from = 0; // holes before this index are walled off this tick
    while (swaps.length < MAX_SWAPS_PER_TICK) {
      const h = slots.findIndex((s, i) => i >= from && s.cls === 'hole');
      if (h < 0) break;
      let m = -1;
      for (let i = h + 1; i < slots.length; i++) {
        if (slots[i].cls === 'claude') { m = i; break; }
        if (slots[i].cls === 'pinned' && slots[i].agent) break;
      }
      if (m < 0) { from = h + 1; continue; }
      swaps.push({ lane, src: slots[m].id, dst: slots[h].id });
      [slots[h], slots[m]] = [slots[m], slots[h]];
      from = 0;
    }
  }
  return swaps;
}

export interface CompactLogEntry {
  ts: number;
  event: 'swap' | 'move' | 'ungroup' | 'dissolve';
  result: string; // 'ok', 'skipped: …' or 'error: …'
  [k: string]: unknown;
}

export function appendCompactLog(entry: CompactLogEntry, file: string = COMPACT_LOG_PATH): void {
  try {
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', 'utf-8');
  } catch {
    /* logging must never take the app down */
  }
}

export interface ExecDeps {
  run: TmuxRunner;
  read: () => WorldState;
  log: (e: CompactLogEntry) => void;
}

const where = (p: LanePane | undefined) => (p ? `${p.tmux_session}:${p.window_index}.${p.pane_index}` : '?');

// Run the planned swaps, re-reading tmux before each one: the plan is up to one
// tick old, and a hole that has since had `claude --resume` typed into it, or a
// pane Will has just focused, must not be swapped on stale information.
export function applySwaps(
  swaps: Swap[],
  idleSince: ReadonlyMap<string, number>,
  now: number,
  deps: ExecDeps,
): { applied: number; skipped: number; failed: number } {
  const out = { applied: 0, skipped: 0, failed: 0 };
  for (const s of swaps) {
    const world = deps.read();
    const src = world.panes.find((p) => p.pane_id === s.src);
    const dst = world.panes.find((p) => p.pane_id === s.dst);
    const base = { ts: now, event: 'swap' as const, lane: s.lane, src: s.src, dst: s.dst, srcName: src?.name ?? '', from: where(src), to: where(dst) };
    const srcCls = src && classifyPane(src, idleSince, world.focused, now);
    const dstCls = dst && classifyPane(dst, idleSince, world.focused, now);
    const sameLane = src && dst && parseLane(src.tmux_session)?.lane === s.lane && parseLane(dst.tmux_session)?.lane === s.lane;
    if (srcCls !== 'claude' || dstCls !== 'hole' || !sameLane) {
      out.skipped++;
      deps.log({ ...base, result: `skipped: src=${srcCls ?? 'gone'} dst=${dstCls ?? 'gone'}` });
      continue;
    }
    try {
      deps.run(['swap-pane', '-d', '-s', s.src, '-t', s.dst]);
      out.applied++;
      deps.log({ ...base, result: 'ok' });
    } catch (e) {
      out.failed++;
      deps.log({ ...base, result: `error: ${(e as Error).message.trim()}` });
    }
  }
  return out;
}

// group -> member pane ids, for groups with one or fewer members still running
// an agent. A member at a shell inside the hole grace period still counts, so a
// `claude --resume` in a grouped pane doesn't break the group apart.
export function groupsToDissolve(
  panes: LanePane[],
  idleSince: ReadonlyMap<string, number>,
  now: number,
): Map<string, string[]> {
  const groups = new Map<string, LanePane[]>();
  for (const p of panes) if (p.group) (groups.get(p.group) ?? groups.set(p.group, []).get(p.group)!).push(p);
  const out = new Map<string, string[]>();
  for (const [g, members] of groups) {
    const alive = members.filter((p) => {
      if (p.agent) return true;
      const since = idleSince.get(p.pane_id);
      return SHELL.test(p.command) && since !== undefined && now - since < HOLE_GRACE_MS;
    });
    if (alive.length <= 1) out.set(g, members.map((p) => p.pane_id));
  }
  return out;
}

// The active pane of the session attached to the most recently active client —
// where Will is looking right now.
export function focusedPaneFrom(run: TmuxRunner): string | null {
  try {
    let best: { at: number; session: string } | null = null;
    for (const line of run(['list-clients', '-F', '#{client_activity} #{client_session}']).split('\n')) {
      const m = line.trim().match(/^(\d+) (.+)$/);
      if (m && (!best || Number(m[1]) > best.at)) best = { at: Number(m[1]), session: m[2] };
    }
    if (!best) return null;
    return run(['display-message', '-p', '-t', best.session, '#{pane_id}']).trim() || null;
  } catch {
    return null;
  }
}

export function readWorld(run: TmuxRunner = defaultRun): WorldState {
  let out: string;
  try {
    out = run(['list-panes', '-a', '-F',
      `#{pane_id}${SEP}#{session_name}${SEP}#{window_index}${SEP}#{pane_index}${SEP}#{pane_pid}${SEP}#{pane_current_command}${SEP}#{@name}${SEP}#{@group}`]);
  } catch {
    return { panes: [], focused: null }; // tmux not running
  }
  const rows = out.split('\n').filter(Boolean).map((l) => l.split(SEP));
  const agents = agentPaneIds(rows.map((r) => ({ pane_id: r[0], pane_pid: r[4] ?? '' })));
  return {
    panes: rows.map((r) => ({
      pane_id: r[0],
      tmux_session: r[1] ?? '',
      window_index: r[2] ?? '',
      pane_index: r[3] ?? '',
      command: r[5] ?? '',
      name: (r[6] ?? '').trim(),
      group: (r[7] ?? '').trim(),
      agent: agents.has(r[0]),
    })),
    focused: focusedPaneFrom(run),
  };
}

// ---- Launch targets ----------------------------------------------------------

// Where a Resume/Branch from the dashboard lands: the lane's earliest idle,
// ungrouped shell. No grace period — this is an explicit request, like `move` —
// and taking the earliest slot means compaction has nothing left to fix after.
export function nextOpenPane(lane: string, world: WorldState): LanePane | null {
  return (
    world.panes
      .filter((p) => parseLane(p.tmux_session)?.lane === lane && !p.agent && !p.group && SHELL.test(p.command))
      .sort(slotOrder)[0] ?? null
  );
}

export interface LaneTarget {
  lane: string;
  pane_id: string;
  where: string; // session:window.pane
  name: string;
}

// One launch target per lane that has room, lanes in natural name order.
export function laneTargets(world: WorldState): LaneTarget[] {
  const lanes = new Set<string>();
  for (const p of world.panes) {
    const l = parseLane(p.tmux_session);
    if (l) lanes.add(l.lane);
  }
  const out: LaneTarget[] = [];
  for (const lane of [...lanes].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))) {
    const p = nextOpenPane(lane, world);
    if (p) out.push({ lane, pane_id: p.pane_id, where: where(p), name: p.name });
  }
  return out;
}

// ---- Groups: `move` / `ungroup` -------------------------------------------

// `%7`, `blue-vanilla` or `@blue-vanilla`.
export function resolvePaneRef(panes: LanePane[], ref: string): LanePane | null {
  const r = ref.trim().replace(/^@/, '');
  return panes.find((p) => (r.startsWith('%') ? p.pane_id === r : p.name === r)) ?? null;
}

// The slot a moving pane takes in the target's session: its first idle shell
// (no grace period — this is an explicit request, not a background sweep), else
// its last agent pane that isn't pinned and isn't the target itself.
export function pickMoveSlot(
  panes: LanePane[],
  targetId: string,
  focused: string | null,
): { ok: true; pane_id: string } | { ok: false; detail: string } {
  const target = panes.find((p) => p.pane_id === targetId);
  if (!target) return { ok: false, detail: `unknown pane: ${targetId}` };
  const candidates = panes
    .filter((p) => p.tmux_session === target.tmux_session && p.pane_id !== targetId)
    .sort(slotOrder);
  const noGrace = new Map(candidates.map((p) => [p.pane_id, 0]));
  const cls = (p: LanePane) => classifyPane(p, noGrace, focused, 0, 0);
  const hole = candidates.find((p) => cls(p) === 'hole');
  if (hole) return { ok: true, pane_id: hole.pane_id };
  const agent = [...candidates].reverse().find((p) => cls(p) === 'claude');
  if (agent) return { ok: true, pane_id: agent.pane_id };
  return { ok: false, detail: 'session full' };
}

export interface GroupDeps {
  run: TmuxRunner;
  read: () => WorldState;
  log?: (e: CompactLogEntry) => void;
  now?: () => number;
}

export type MoveResult =
  | { ok: true; pane_id: string; target: string; session: string; swappedWith: string | null; group: string }
  | { ok: false; detail: string };

// Move `ref` into `toRef`'s session and group the two. The pane displaced from
// that session lands in the mover's old slot. Only within a lane.
export function movePane(ref: string, toRef: string, deps: GroupDeps): MoveResult {
  const now = (deps.now ?? Date.now)();
  const world = deps.read();
  const m = resolvePaneRef(world.panes, ref);
  if (!m) return { ok: false, detail: `unknown pane: ${ref}` };
  const t = resolvePaneRef(world.panes, toRef);
  if (!t) return { ok: false, detail: `unknown pane: ${toRef}` };
  if (m.pane_id === t.pane_id) return { ok: false, detail: 'cannot move a pane onto itself' };
  const lm = parseLane(m.tmux_session);
  const lt = parseLane(t.tmux_session);
  if (!lm) return { ok: false, detail: `${m.tmux_session} is not in a lane` };
  if (!lt) return { ok: false, detail: `${t.tmux_session} is not in a lane` };
  if (lm.lane !== lt.lane) return { ok: false, detail: `cross-lane move refused (${lm.lane} -> ${lt.lane})` };

  let swappedWith: string | null = null;
  const from = where(m);
  try {
    if (m.tmux_session !== t.tmux_session) {
      const slot = pickMoveSlot(world.panes, t.pane_id, world.focused);
      if (!slot.ok) return slot;
      deps.run(['swap-pane', '-d', '-s', m.pane_id, '-t', slot.pane_id]);
      swappedWith = slot.pane_id;
    }
    // A target already in a group extends it; otherwise the pair starts one.
    const group = t.group || `g-${now.toString(36)}`;
    deps.run(['set-option', '-p', '-t', m.pane_id, '@group', group]);
    if (t.group !== group) deps.run(['set-option', '-p', '-t', t.pane_id, '@group', group]);
    deps.log?.({ ts: now, event: 'move', result: 'ok', pane: m.pane_id, name: m.name, to: t.pane_id, from, swappedWith, group });
    return { ok: true, pane_id: m.pane_id, target: t.pane_id, session: t.tmux_session, swappedWith, group };
  } catch (e) {
    const detail = (e as Error).message.trim();
    deps.log?.({ ts: now, event: 'move', result: `error: ${detail}`, pane: m.pane_id, to: t.pane_id });
    return { ok: false, detail };
  }
}

export function ungroupPane(
  ref: string,
  deps: GroupDeps,
): { ok: true; pane_id: string } | { ok: false; detail: string } {
  const p = resolvePaneRef(deps.read().panes, ref);
  if (!p) return { ok: false, detail: `unknown pane: ${ref}` };
  try {
    deps.run(['set-option', '-p', '-u', '-t', p.pane_id, '@group']);
  } catch (e) {
    return { ok: false, detail: (e as Error).message.trim() };
  }
  deps.log?.({ ts: (deps.now ?? Date.now)(), event: 'ungroup', result: 'ok', pane: p.pane_id, group: p.group });
  return { ok: true, pane_id: p.pane_id };
}

export const defaultGroupDeps = (): GroupDeps => ({ run: defaultRun, read: () => readWorld(defaultRun), log: appendCompactLog });

// ---- The tick ---------------------------------------------------------------

// Kill switch: a file, so compaction can be turned off without a rebuild.
export function compactEnabled(off: string = COMPACT_OFF_PATH): boolean {
  return !fs.existsSync(off);
}

export function setCompactEnabled(enabled: boolean, off: string = COMPACT_OFF_PATH): void {
  if (enabled) fs.rmSync(off, { force: true });
  else fs.writeFileSync(off, `compaction disabled ${new Date().toISOString()}\n`, 'utf-8');
}

// The periodic entry point. Holds the first-seen-idle stamps across ticks, so
// it has to be made once and called repeatedly. Never throws.
export function makeCompactor(deps: ExecDeps = { run: defaultRun, read: () => readWorld(defaultRun), log: appendCompactLog }) {
  const idleSince = new Map<string, number>();
  return (now: number): { applied: number; dissolved: number } => {
    try {
      const world = deps.read();
      trackIdle(world.panes, idleSince, now);
      if (!compactEnabled()) return { applied: 0, dissolved: 0 };

      // No agent anywhere is far likelier to be a failed `ps` than a real state,
      // and reading it as real would dissolve every group at once.
      let dissolved = 0;
      if (world.panes.some((p) => p.agent)) {
        for (const [group, ids] of groupsToDissolve(world.panes, idleSince, now)) {
          for (const id of ids) {
            try {
              deps.run(['set-option', '-p', '-u', '-t', id, '@group']);
            } catch {
              /* pane vanished */
            }
            const p = world.panes.find((x) => x.pane_id === id);
            if (p) p.group = '';
          }
          dissolved++;
          deps.log({ ts: now, event: 'dissolve', result: 'ok', group, panes: ids });
        }
      }

      const swaps = planCompaction(world.panes, idleSince, world.focused, now);
      const r = swaps.length ? applySwaps(swaps, idleSince, now, deps) : { applied: 0 };
      return { applied: r.applied, dissolved };
    } catch {
      return { applied: 0, dissolved: 0 };
    }
  };
}
