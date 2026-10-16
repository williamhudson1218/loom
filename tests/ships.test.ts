import { describe, expect, it } from 'vitest';
import { parsePorcelainZ } from '../src/detail.ts';
import { byChatIndex, fileState, groupNextShip, parseLock, shippedMembership, slugFromRemote, toShipPr, type ChatEdits, type ShipPr } from '../src/ships.ts';
import { emptyScan, scanLines } from '../src/sessionscan.ts';

const status = parsePorcelainZ(['M  a.ts', ' M b.ts', 'MM c.ts', '?? d.ts', 'M  e.ts', ''].join('\0'));
const edits = (key: string, files: Record<string, [number, number]>, shipCmds: number[] = []): ChatEdits => ({
  key,
  edits: Object.fromEntries(Object.entries(files).map(([p, [first, last]]) => [p, { first, last }])),
  shipCmds,
});

describe('fileState', () => {
  it('reads the index and worktree columns', () => {
    expect(fileState({ x: 'M', y: ' ' })).toBe('staged');
    expect(fileState({ x: ' ', y: 'M' })).toBe('unstaged');
    expect(fileState({ x: 'M', y: 'M' })).toBe('partial');
    expect(fileState({ x: '?', y: '?' })).toBe('untracked');
  });
});

describe('groupNextShip', () => {
  it('groups changed files by the chats that edited them, flags shared files, and keeps the rest unattributed', () => {
    const n = groupNextShip(status, [
      edits('claude:A', { 'a.ts': [1, 2], 'c.ts': [1, 2], 'zzz.ts': [1, 1] }),
      edits('claude:B', { 'b.ts': [1, 2], 'c.ts': [3, 4] }),
      edits('claude:C', { 'nothing.ts': [1, 1] }),
    ]);
    expect(n.chats.map((c) => [c.key, c.staged, c.unstaged])).toEqual([
      ['claude:A', 2, 0], // a staged, c partial (rides)
      ['claude:B', 1, 1],
    ]);
    expect(n.shared).toEqual(['c.ts']);
    expect(n.chats[1].files.find((f) => f.path === 'c.ts')).toMatchObject({ state: 'partial', shared: true });
    expect(n.unattributed.map((f) => f.path)).toEqual(['e.ts', 'd.ts']);
    expect([n.staged, n.unstaged]).toEqual([3, 2]);
    expect(byChatIndex(n, [])).toEqual({ 'claude:A': { next: 'staged', ships: [] }, 'claude:B': { next: 'both', ships: [] } });
  });
});

describe('shippedMembership', () => {
  const ship = (number: number, headAt: number, files: string[], createdAt = headAt): ShipPr => ({
    number, title: '', url: '', state: 'MERGED', branch: `ship/${number}`, createdAt, mergedAt: createdAt + 5, headAt, files,
  });
  it('a chat rides the ships after its first edit, up to the first ship after its last edit', () => {
    const ships = [ship(1, 100, ['a.ts']), ship(2, 200, ['a.ts']), ship(3, 300, ['a.ts', 'b.ts'])];
    const g = shippedMembership(ships, [
      edits('claude:A', { 'a.ts': [50, 150] }), // rides 1 and 2, not 3
      edits('claude:B', { 'a.ts': [250, 260] }), // rides 3 only
      edits('claude:C', { 'b.ts': [350, 360] }), // after every ship
    ]);
    expect(Object.fromEntries(g.map((s) => [s.number, s.members]))).toEqual({ 1: ['claude:A'], 2: ['claude:A'], 3: ['claude:B'] });
    expect(byChatIndex({ chats: [], unattributed: [], shared: [], staged: 0, unstaged: 0 }, g)['claude:A'].ships).toEqual([2, 1]);
  });
  it('the runner is the chat that typed /ship just before the PR opened, and is a member', () => {
    const g = shippedMembership([ship(9, 1_000_000, ['x.ts'], 1_000_000)], [edits('claude:R', {}, [999_000]), edits('claude:Old', {}, [1])]);
    expect(g[0].runner).toBe('claude:R');
    expect(g[0].members).toEqual(['claude:R']);
  });
});

describe('parsing', () => {
  it('reads the ship lock and marks it stale past the TTL', () => {
    const l = parseLock('{"session_id":"abc","tmux_pane":"loom-tp-2:1.0","acquired_at":1000}', 1_100_000);
    expect(l).toEqual({ sessionId: 'abc', pane: 'loom-tp-2:1.0', acquiredAt: 1_000_000, stale: false });
    expect(parseLock('{"session_id":"abc","acquired_at":1000}', 1_400_000)?.stale).toBe(true);
    expect(parseLock('garbage')).toBeNull();
  });
  it('turns gh pr list rows into ships timed by their last commit', () => {
    const s = toShipPr({ number: 5, headRefName: 'ship/x', state: 'OPEN', createdAt: '2026-10-16T19:00:00Z', commits: [{ committedDate: '2026-10-16T18:59:00Z' }, { committedDate: '2026-10-16T19:10:00Z' }], files: [{ path: 'a.ts' }] });
    expect(s).toMatchObject({ number: 5, branch: 'ship/x', headAt: Date.parse('2026-10-16T19:10:00Z'), files: ['a.ts'] });
  });
  it('reads the repo slug off either remote form', () => {
    expect(slugFromRemote('git@github.com:tax-pilot-org/tax-pilot-app.git')).toBe('tax-pilot-org/tax-pilot-app');
    expect(slugFromRemote('https://github.com/o/r\n')).toBe('o/r');
  });
  it('the transcript scan records first edits and /ship runs', () => {
    const line = (o: object) => JSON.stringify(o);
    const s = scanLines([
      line({ type: 'assistant', timestamp: '2026-10-16T19:00:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/r/a.ts' } }] } }),
      line({ type: 'assistant', timestamp: '2026-10-16T19:05:00Z', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/r/a.ts' } }] } }),
      line({ type: 'user', timestamp: '2026-10-16T19:06:00Z', message: { role: 'user', content: '<command-message>ship</command-message>\n<command-name>/ship</command-name>' } }),
    ], emptyScan());
    expect(s.editedFirst['/r/a.ts']).toBe(Date.parse('2026-10-16T19:00:00Z'));
    expect(s.editedFiles['/r/a.ts']).toBe(Date.parse('2026-10-16T19:05:00Z'));
    expect(s.shipCmds).toEqual([Date.parse('2026-10-16T19:06:00Z')]);
  });
});
