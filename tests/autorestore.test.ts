import { describe, it, expect } from 'vitest';
import { AUTO_RESTORE_COOLDOWN_MS, autoRestoreGate, sessionsToRestore } from '../src/autorestore.ts';
import type { Layout } from '../src/snapshot.ts';

const layout = (...names: string[]): Layout => ({ sessions: names.map((name) => ({ name })) }) as unknown as Layout;
const P = 'loom-';

describe('sessionsToRestore', () => {
  it('at startup brings back every saved session that is not running (a reboot or a quit)', () => {
    expect(sessionsToRestore(layout('loom-a', 'loom-b', 'loom-c'), new Set(), 'startup', P)).toEqual(['loom-a', 'loom-b', 'loom-c']);
    expect(sessionsToRestore(layout('loom-a', 'loom-b'), new Set(['loom-a']), 'startup', P)).toEqual(['loom-b']);
    expect(sessionsToRestore(layout('loom-a'), new Set(['loom-a']), 'startup', P)).toEqual([]);
  });

  it('while running only acts when every workspace session is gone (tmux died), not when one was closed', () => {
    expect(sessionsToRestore(layout('loom-a', 'loom-b'), new Set(['loom-a']), 'running', P)).toEqual([]);
    expect(sessionsToRestore(layout('loom-a', 'loom-b'), new Set(['scratch']), 'running', P)).toEqual(['loom-a', 'loom-b']);
  });

  it("ignores Loom's own terminal views, non-workspace sessions and a missing snapshot", () => {
    expect(sessionsToRestore(layout('loom-a', 'loom-view-abc', 'scratch'), new Set(), 'startup', P)).toEqual(['loom-a']);
    expect(sessionsToRestore(layout('loom-a'), new Set(['loom-view-abc']), 'running', P)).toEqual(['loom-a']);
    expect(sessionsToRestore(null, new Set(), 'startup', P)).toEqual([]);
  });
});

describe('autoRestoreGate', () => {
  it('restores, then holds a second one inside the cooldown so a crash loop needs a person', () => {
    expect(autoRestoreGate([], 0, 1000)).toBe('none');
    expect(autoRestoreGate(['loom-a'], 0, 1000)).toBe('go');
    expect(autoRestoreGate(['loom-a'], 1000, 1000 + AUTO_RESTORE_COOLDOWN_MS - 1)).toBe('held');
    expect(autoRestoreGate(['loom-a'], 1000, 1000 + AUTO_RESTORE_COOLDOWN_MS)).toBe('go');
  });
});
