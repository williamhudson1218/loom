import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import {
  DEFAULT_LIMITS,
  MANAGED_SESSION,
  acquireManagedPane,
  capacityVerdict,
  limitsFromEnv,
  parseVmStat,
  getLaunchTarget,
  pickStrategy,
  planReap,
  reapManaged,
  type Resources,
} from '../src/managed.ts';
import type { LanePane } from '../src/compact.ts';
import { getLaneView, openDb } from '../src/db.ts';
import { applySettings } from '../src/settings.ts';

const pane = (pane_id: string, tmux_session: string, extra: Partial<LanePane> = {}): LanePane => ({
  pane_id, tmux_session, window_index: '1', pane_index: '0', command: 'zsh', name: '', group: '', agent: false, ...extra,
});

describe('strategy selection', () => {
  it('uses lanes when any loom-<lane>-<n> session exists, even beside managed windows', () => {
    expect(pickStrategy({ panes: [pane('%1', 'loom-tp-2')] })).toBe('lanes');
    expect(pickStrategy({ panes: [pane('%1', MANAGED_SESSION), pane('%2', 'loom-bugs-1')] })).toBe('lanes');
  });

  it('uses managed windows when there are no lanes', () => {
    expect(pickStrategy({ panes: [] })).toBe('managed');
    expect(pickStrategy({ panes: [pane('%1', MANAGED_SESSION), pane('%2', 'loom-tp-terminals'), pane('%3', 'work')] })).toBe('managed');
  });

  it('never mistakes the managed session itself for a lane', () => {
    expect(MANAGED_SESSION).toBe('loom-managed');
    expect(pickStrategy({ panes: [pane('%1', MANAGED_SESSION)] })).toBe('managed');
  });
});

describe('launch_target', () => {
  const lanes = { panes: [pane('%1', 'loom-tp-2'), pane('%2', MANAGED_SESSION)] };
  it('managed sends every new chat to a managed window, even with lanes', () => {
    expect(pickStrategy(lanes, 'managed')).toBe('managed');
    expect(pickStrategy({ panes: [] }, 'managed')).toBe('managed');
  });

  it('lanes, unset or junk keep today\'s rule: lanes when they exist, else managed', () => {
    for (const stored of ['lanes', '', 'nonsense']) {
      expect(pickStrategy(lanes, stored)).toBe('lanes');
      expect(pickStrategy({ panes: [] }, stored)).toBe('managed');
    }
  });

  it('is stored and read back through the settings API, and rejects bad values', () => {
    const db = openDb(':memory:');
    expect(getLaunchTarget(db)).toBe('');
    expect(applySettings(db, { launch_target: 'managed' })).toEqual({ ok: true, restart: false });
    expect(getLaunchTarget(db)).toBe('managed');
    expect(applySettings(db, { launch_target: 'ghostty' })).toMatchObject({ ok: false });
    expect(getLaunchTarget(db)).toBe('managed');
    expect(getLaneView(db)).toBe('zoom'); // unset reads as zoom
    expect(applySettings(db, { lane_view: 'mirror' })).toMatchObject({ ok: true });
    expect(getLaneView(db)).toBe('mirror');
    expect(applySettings(db, { lane_view: 'zoomed' })).toMatchObject({ ok: false });
    db.close();
  });
});

describe('capacity cap', () => {
  const GB = 1024 ** 3;
  const ok: Resources = { freeMem: 4 * GB, totalMem: 16 * GB, load1: 3, cpus: 8 };

  it('allows a machine with room', () => {
    expect(capacityVerdict(ok)).toEqual({ ok: true });
  });

  it('refuses when free memory is under the floor, saying how much is free', () => {
    const r = capacityVerdict({ ...ok, freeMem: 0.1 * GB });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.detail).toMatch(/0\.1 GB of memory is free/);
  });

  it('scales the floor with total memory', () => {
    expect(capacityVerdict({ freeMem: 0.5 * GB, totalMem: 64 * GB, load1: 0, cpus: 8 }).ok).toBe(false); // 2% of 64 GB = 1.3 GB
    expect(capacityVerdict({ freeMem: 0.5 * GB, totalMem: 16 * GB, load1: 0, cpus: 8 }).ok).toBe(true);
  });

  it('refuses an overloaded machine', () => {
    const r = capacityVerdict({ ...ok, load1: 40 });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.detail).toMatch(/overloaded/);
  });

  it('takes thresholds from the environment, ignoring junk', () => {
    expect(limitsFromEnv({ LOOM_MIN_FREE_MB: '2048', LOOM_MAX_LOAD_PER_CPU: '1' })).toMatchObject({ minFreeBytes: 2048 * 1024 * 1024, minFreeFraction: 0, maxLoadPerCpu: 1 });
    expect(limitsFromEnv({ LOOM_MIN_FREE_MB: 'lots' })).toEqual(DEFAULT_LIMITS);
  });
});

describe('parseVmStat', () => {
  const sample = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               96894.
Pages active:                           1180285.
Pages inactive:                         1197540.
Pages speculative:                        19538.
Pages throttled:                              0.
Pages wired down:                        503163.
Pages purgeable:                          24730.
`;
  it('counts free, inactive, speculative and purgeable pages as available', () => {
    expect(parseVmStat(sample)).toBe((96894 + 1197540 + 19538 + 24730) * 16384);
  });
  it('is null for anything else', () => {
    expect(parseVmStat('')).toBeNull();
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 16384 bytes)\n')).toBeNull();
  });
});

describe('reap rules', () => {
  const MIN = 60_000;
  const now = 1_000_000_000;
  const idleFor = (ms: number, ...ids: string[]) => new Map(ids.map((id) => [id, now - ms]));

  it('reaps a window whose shell has sat idle for 10 minutes', () => {
    expect(planReap([pane('%1', MANAGED_SESSION)], idleFor(10 * MIN, '%1'), { now })).toEqual(['%1']);
  });

  it('leaves a window idle for less than 10 minutes', () => {
    expect(planReap([pane('%1', MANAGED_SESSION)], idleFor(9 * MIN + 59_000, '%1'), { now })).toEqual([]);
  });

  it('leaves a pane never seen idle (no stamp yet)', () => {
    expect(planReap([pane('%1', MANAGED_SESSION)], new Map(), { now })).toEqual([]);
  });

  it('exempts a window whose agent is still running', () => {
    expect(planReap([pane('%1', MANAGED_SESSION, { agent: true, command: '2.1.233' })], idleFor(60 * MIN, '%1'), { now })).toEqual([]);
    // an agent under a shell counts too
    expect(planReap([pane('%1', MANAGED_SESSION, { agent: true })], idleFor(60 * MIN, '%1'), { now })).toEqual([]);
  });

  it('exempts a window running something that is not a shell', () => {
    expect(planReap([pane('%1', MANAGED_SESSION, { command: 'node' })], idleFor(60 * MIN, '%1'), { now })).toEqual([]);
  });

  it('exempts saved chats', () => {
    const idle = idleFor(60 * MIN, '%1', '%2');
    expect(planReap([pane('%1', MANAGED_SESSION), pane('%2', MANAGED_SESSION, { window_index: '2' })], idle, { now, saved: new Set(['%1']) })).toEqual(['%2']);
  });

  it('exempts the pane someone is looking at', () => {
    expect(planReap([pane('%1', MANAGED_SESSION)], idleFor(60 * MIN, '%1'), { now, focused: '%1' })).toEqual([]);
  });

  it('keeps a window if any one of its panes is busy, and kills it once all are idle', () => {
    const win = [pane('%1', MANAGED_SESSION), pane('%2', MANAGED_SESSION, { pane_index: '1', agent: true })];
    expect(planReap(win, idleFor(60 * MIN, '%1', '%2'), { now })).toEqual([]);
    expect(planReap([win[0], { ...win[1], agent: false }], idleFor(60 * MIN, '%1', '%2'), { now })).toEqual(['%1']);
  });

  it('honours a custom ttl', () => {
    expect(planReap([pane('%1', MANAGED_SESSION)], idleFor(2 * MIN, '%1'), { now, ttlMs: MIN })).toEqual(['%1']);
  });
});

// A real tmux server on a throwaway socket. Only that server is ever killed.
const SOCK = `loom-test-${randomBytes(4).toString('hex')}`;
const run = (args: string[]): string => execFileSync('tmux', ['-L', SOCK, '-f', `${__dirname}/fixtures/tmux-test.conf`, ...args], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
const roomy = () => ({ freeMem: 8 * 1024 ** 3, totalMem: 16 * 1024 ** 3, load1: 0, cpus: 8 });

describe('managed windows on a throwaway tmux socket', () => {
  let hasTmux = true;
  let socketPath = '';
  beforeAll(() => {
    try {
      execFileSync('tmux', ['-V']);
    } catch {
      hasTmux = false;
    }
  });
  afterAll(() => {
    try {
      execFileSync('tmux', ['-L', SOCK, 'kill-server'], { stdio: 'ignore' });
    } catch {
      /* never started, or it exited when its last window was reaped */
    }
    // A server that exited on its own leaves its socket file behind.
    if (socketPath) fs.rmSync(socketPath, { force: true });
  });

  it('creates the session on first use, then one named window per chat, in the project dir', () => {
    if (!hasTmux) return;
    const dir = process.cwd();
    const a = acquireManagedPane(dir, { run, resources: roomy });
    socketPath = run(['display-message', '-p', '#{socket_path}']).trim();
    const b = acquireManagedPane(dir, { run, resources: roomy });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.paneId).not.toBe(b.paneId);
    expect(a.name).toMatch(/^[a-z]+-[a-z]+$/);
    expect(b.name).not.toBe(a.name);

    const wins = run(['list-windows', '-t', `=${MANAGED_SESSION}`, '-F', '#{window_name}']).trim().split('\n');
    expect(wins.sort()).toEqual([a.name, b.name].sort());
    // The window is named by the pane's @name, and started in the project dir.
    expect(run(['display-message', '-p', '-t', a.paneId, '#{@name}']).trim()).toBe(a.name);
    expect(run(['display-message', '-p', '-t', a.paneId, '#{pane_current_path}']).trim()).toContain(dir.split('/').pop()!);
    expect(a.where).toBe(`${MANAGED_SESSION} · ${a.name}`);
  });

  it('refuses under the cap and creates nothing', () => {
    if (!hasTmux) return;
    const before = run(['list-windows', '-a']).trim().split('\n').length;
    const r = acquireManagedPane(process.cwd(), { run, resources: () => ({ freeMem: 1024, totalMem: 16 * 1024 ** 3, load1: 0, cpus: 8 }) });
    expect(r.ok).toBe(false);
    expect(run(['list-windows', '-a']).trim().split('\n').length).toBe(before);
  });

  it('reaps idle windows after the ttl, but never saved ones or ones inside it', () => {
    if (!hasTmux) return;
    const ids = run(['list-panes', '-a', '-F', '#{pane_id}']).trim().split('\n');
    expect(ids.length).toBe(2);
    const [saved, other] = ids;
    const idle = new Map<string, number>();
    const t0 = 5_000_000;
    const deps = (now: number, savedIds: string[]) => ({ run, idle, now, saved: () => new Set(savedIds) });

    // First sighting only starts the clock.
    expect(reapManaged(deps(t0, [saved]))).toEqual([]);
    // Inside the ten minutes: nothing.
    expect(reapManaged(deps(t0 + 9 * 60_000, [saved]))).toEqual([]);
    // Past it: the unsaved window goes, the saved one stays.
    expect(reapManaged(deps(t0 + 11 * 60_000, [saved]))).toEqual([other]);
    const left = run(['list-panes', '-a', '-F', '#{pane_id}']).trim().split('\n');
    expect(left).toEqual([saved]);
    // Once it is no longer saved it follows.
    expect(reapManaged(deps(t0 + 12 * 60_000, []))).toEqual([saved]);
  });

  it('reaps nothing, and does not throw, when the managed session does not exist', () => {
    expect(reapManaged({ run: () => { throw new Error('no server'); }, saved: () => new Set(), idle: new Map() })).toEqual([]);
  });
});
