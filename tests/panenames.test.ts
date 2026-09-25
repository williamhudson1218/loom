import { describe, it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { ADJECTIVES, NOUNS, assignNames, nameNewPanes, readPaneNames, type PaneNameRow } from '../src/panenames.ts';
import { restore } from '../src/restore.ts';
import { captureLayoutFrom, type Layout } from '../src/snapshot.ts';
import type { TmuxPane } from '../src/placements.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

// Deterministic RNG: replays the given sequence, then repeats its last value.
const seq = (...xs: number[]) => {
  let i = 0;
  return () => xs[Math.min(i++, xs.length - 1)];
};
const row = (pane_id: string, session_name: string, name = ''): PaneNameRow => ({ pane_id, session_name, name });

describe('word lists', () => {
  it('are lowercase single words with no duplicates', () => {
    for (const w of [...ADJECTIVES, ...NOUNS]) expect(w).toMatch(/^[a-z]+$/);
    expect(new Set(ADJECTIVES).size).toBe(ADJECTIVES.length);
    expect(new Set(NOUNS).size).toBe(NOUNS.length);
    expect(ADJECTIVES.length).toBeGreaterThanOrEqual(50);
    expect(NOUNS.length).toBeGreaterThanOrEqual(50);
  });
});

describe('assignNames', () => {
  it('produces adjective-noun names', () => {
    const out = assignNames([row('%1', 'loom-a')], 'loom-');
    const [adj, noun] = out.get('%1')!.split('-');
    expect(out.get('%1')).toMatch(/^[a-z]+-[a-z]+$/);
    expect(ADJECTIVES).toContain(adj);
    expect(NOUNS).toContain(noun);
  });

  it('only names panes in prefixed sessions', () => {
    const out = assignNames([row('%1', 'loom-a'), row('%2', 'scratch')], 'loom-');
    expect([...out.keys()]).toEqual(['%1']);
  });

  it('never renames a pane that already has a name', () => {
    const out = assignNames([row('%1', 'loom-a', 'blue-otter'), row('%2', 'loom-a')], 'loom-');
    expect(out.has('%1')).toBe(false);
    expect(out.has('%2')).toBe(true);
  });

  it('avoids names already held, including by non-prefixed panes', () => {
    const first = `${ADJECTIVES[0]}-${NOUNS[0]}`;
    // The RNG keeps landing on the taken name, then moves on.
    const rand = seq(0, 0, 0, 0, 0.5, 0.5);
    const out = assignNames([row('%9', 'scratch', first), row('%1', 'loom-a')], 'loom-', rand);
    expect(out.get('%1')).not.toBe(first);
  });

  it('never reuses either word of a held name', () => {
    const held = [row('%a', 'loom-a', 'polar-badger'), row('%b', 'scratch', 'sunny-taco')];
    for (let t = 0; t < 50; t++) {
      const [adj, noun] = assignNames([...held, row('%1', 'loom-a')], 'loom-').get('%1')!.split('-');
      expect(['polar', 'sunny']).not.toContain(adj);
      expect(['badger', 'taco']).not.toContain(noun);
    }
  });

  it('keeps every word unique across a single call while words last', () => {
    const n = Math.min(ADJECTIVES.length, NOUNS.length);
    const out = assignNames(Array.from({ length: n }, (_, i) => row(`%${i}`, 'loom-a')), 'loom-');
    const words = [...out.values()].map((v) => v.split('-'));
    expect(new Set(words.map((w) => w[0])).size).toBe(n);
    expect(new Set(words.map((w) => w[1])).size).toBe(n);
  });

  it('relaxes to whole-name uniqueness once the words run out', () => {
    const n = Math.max(ADJECTIVES.length, NOUNS.length) + 10;
    const out = assignNames(Array.from({ length: n }, (_, i) => row(`%${i}`, 'loom-a')), 'loom-');
    expect(out.size).toBe(n);
    expect(new Set(out.values()).size).toBe(n);
  });

  it('keeps names unique within a single call', () => {
    const panes = Array.from({ length: 40 }, (_, i) => row(`%${i}`, 'loom-a'));
    const out = assignNames(panes, 'loom-', () => 0); // worst case: RNG always collides
    expect(out.size).toBe(40);
    expect(new Set(out.values()).size).toBe(40);
  });
});

describe('tmux side', () => {
  it('reads @name per pane and names only the unnamed prefixed ones', () => {
    const SEP = '~|LOOM|~';
    const calls: string[][] = [];
    vi.mocked(execFileSync).mockReset().mockImplementation((_cmd, args) => {
      calls.push(args as string[]);
      if ((args as string[])[0] === 'list-panes') {
        return [`%1${SEP}loom-a${SEP}happy-otter`, `%2${SEP}loom-a${SEP}`, `%3${SEP}scratch${SEP}`].join('\n') + '\n';
      }
      return '';
    });
    expect(readPaneNames()).toEqual([row('%1', 'loom-a', 'happy-otter'), row('%2', 'loom-a'), row('%3', 'scratch')]);
    calls.length = 0;
    expect(nameNewPanes('loom-')).toBe(1);
    const sets = calls.filter((a) => a[0] === 'set-option');
    expect(sets).toHaveLength(1);
    expect(sets[0].slice(0, 5)).toEqual(['set-option', '-p', '-t', '%2', '@name']);
  });

  it('is a no-op when tmux is not running', () => {
    vi.mocked(execFileSync).mockReset().mockImplementation(() => {
      throw new Error('no server running');
    });
    expect(readPaneNames()).toEqual([]);
    expect(nameNewPanes('loom-')).toBe(0);
  });
});

describe('snapshot + restore carry the name', () => {
  const pane: TmuxPane = {
    pane_id: '%7', tmux_session: 'loom-a', window_index: '1', pane_index: '0', pane_pid: '7',
    command: 'zsh', cwd: '/work', left: 0, top: 0, title: '',
  };

  it('captures the name and restores it onto the recreated pane', () => {
    const snap = captureLayoutFrom({
      now: 0, panes: [pane], agentPanes: new Map(), live: new Map(), names: new Map([['%7', 'blue-vanilla']]),
    });
    expect(snap.sessions[0].windows[0].panes[0].name).toBe('blue-vanilla');
    const log = restore({ dryRun: true, layout: snap, existing: new Set(), attached: new Set() }).log.join('\n');
    expect(log).toContain('tmux set-option -p -t %win0p0 @name blue-vanilla');
  });

  it('strips a restored name from any other pane already holding it', () => {
    const snap = captureLayoutFrom({
      now: 0, panes: [pane], agentPanes: new Map(), live: new Map(), names: new Map([['%7', 'blue-vanilla']]),
    });
    const log = restore({
      dryRun: true, layout: snap, existing: new Set(), attached: new Set(),
      liveNames: new Map([['%3', 'blue-vanilla'], ['%4', 'red-otter']]),
    }).log;
    const unset = log.findIndex((l) => l === 'tmux set-option -pu -t %3 @name');
    const set = log.findIndex((l) => l === 'tmux set-option -p -t %win0p0 @name blue-vanilla');
    expect(unset).toBeGreaterThanOrEqual(0);
    expect(set).toBeGreaterThan(unset);
    expect(log.join('\n')).not.toContain('%4');
  });

  it('omits the field for an unnamed pane', () => {
    const snap = captureLayoutFrom({ now: 0, panes: [pane], agentPanes: new Map(), live: new Map() });
    expect('name' in snap.sessions[0].windows[0].panes[0]).toBe(false);
  });

  it('restores a legacy layout with no names, setting none', () => {
    const legacy: Layout = {
      taken_at: 0,
      sessions: [{ name: 'loom-a', windows: [{ window_index: '1', window_layout: '', panes: [
        { pane_index: '0', cwd: '/work', command: 'zsh', full_command: '', title: '', kind: 'shell' },
      ] }] }],
    };
    const r = restore({ dryRun: true, layout: legacy, existing: new Set(), attached: new Set() });
    expect(r.restored).toEqual(['loom-a']);
    expect(r.log.join('\n')).not.toContain('@name');
  });
});
