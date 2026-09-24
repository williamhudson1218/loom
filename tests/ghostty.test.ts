import { describe, it, expect } from 'vitest';
import {
  attachGhosttyTabs,
  buildAttachScript,
  orderSessionsByTabs,
  parseTabs,
  parseWindows,
  planTabAttach,
  type GhosttyTab,
  type SavedGhosttyWindow,
} from '../src/ghostty.ts';

function tab(title: string, tab_index: number, window_index = 1): GhosttyTab {
  return { window_index, tab_index, title, tabbed: true };
}

const tabMatches = (title: string, s: string) => title === s || title.endsWith(s);

describe('parseTabs', () => {
  it('reads tabs in on-screen order, tabbed and lone windows alike', () => {
    const raw = [
      '1~|LOOM|~1~|LOOM|~t~|LOOM|~loom-a',
      '1~|LOOM|~2~|LOOM|~t~|LOOM|~loom-b',
      '2~|LOOM|~1~|LOOM|~w~|LOOM|~~/dev/loom',
      '',
    ].join('\n');
    expect(parseTabs(raw)).toEqual([
      { window_index: 1, tab_index: 1, tabbed: true, title: 'loom-a' },
      { window_index: 1, tab_index: 2, tabbed: true, title: 'loom-b' },
      { window_index: 2, tab_index: 1, tabbed: false, title: '~/dev/loom' },
    ]);
  });
});

describe('parseWindows', () => {
  it('groups tabs by window and keeps each window\'s bounds', () => {
    const raw = [
      '1~|LOOM|~0~|LOOM|~b~|LOOM|~0,33,1728,1020',
      '1~|LOOM|~1~|LOOM|~t~|LOOM|~loom-a',
      '1~|LOOM|~2~|LOOM|~t~|LOOM|~loom-b',
      '2~|LOOM|~0~|LOOM|~b~|LOOM|~',
      '2~|LOOM|~1~|LOOM|~w~|LOOM|~loom-c',
    ].join('\n');
    const ws = parseWindows(raw);
    expect(ws.map((w) => [w.window_index, w.tabs.map((t) => t.title), w.bounds])).toEqual([
      [1, ['loom-a', 'loom-b'], { x: 0, y: 33, w: 1728, h: 1020 }],
      [2, ['loom-c'], undefined], // blank bounds line -> no bounds
    ]);
    expect(parseTabs(raw).map((t) => t.title)).toEqual(['loom-a', 'loom-b', 'loom-c']);
  });
});

describe('planTabAttach', () => {
  it('re-homes each session into its own leftover tab instead of opening new ones', () => {
    const tabs = [tab('loom-a', 1), tab('loom-b', 2), tab('loom-c', 3)];
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b', 'loom-c'], tabs, attached: [] });
    expect(plan.assignments.map((a) => a.reuse?.title)).toEqual(['loom-a', 'loom-b', 'loom-c']);
    expect(plan.leftover).toEqual([]);
  });

  it('leaves tabs alone when a tmux client is still attached to their session', () => {
    const tabs = [tab('loom-a', 1), tab('loom-b', 2)];
    const plan = planTabAttach({ sessions: ['loom-b'], tabs, attached: ['loom-a'] });
    expect(plan.assignments[0].reuse?.title).toBe('loom-b');
    // loom-a's tab is in use, so it is neither reused nor offered as spare
    expect(plan.leftover).toEqual([]);
  });

  it('fills untitled free tabs positionally, preserving the requested order', () => {
    const tabs = [tab('~/dev/one', 1), tab('~/dev/two', 2), tab('~/dev/three', 3)];
    const plan = planTabAttach({ sessions: ['loom-x', 'loom-y', 'loom-z'], tabs, attached: [] });
    expect(plan.assignments.map((a) => [a.session, a.reuse?.tab_index])).toEqual([
      ['loom-x', 1],
      ['loom-y', 2],
      ['loom-z', 3],
    ]);
  });

  it('opens a new tab only once the free ones run out', () => {
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b'], tabs: [tab('loom-a', 1)], attached: [] });
    expect(plan.assignments[0].reuse?.title).toBe('loom-a');
    expect(plan.assignments[1].reuse).toBeNull();
  });

  it('reports free tabs nothing was assigned to rather than touching them', () => {
    const tabs = [tab('loom-a', 1), tab('scratch', 2), tab('notes', 3)];
    const plan = planTabAttach({ sessions: ['loom-a'], tabs, attached: [] });
    expect(plan.leftover.map((t) => t.title)).toEqual(['scratch', 'notes']);
  });
});

describe('planTabAttach across windows', () => {
  const saved: SavedGhosttyWindow[] = [
    { tabs: ['loom-a', 'loom-b'], bounds: { x: 0, y: 0, w: 800, h: 600 } },
    { tabs: ['loom-c', 'loom-d'], bounds: { x: 900, y: 0, w: 800, h: 600 } },
  ];

  it('puts each session back in the window it was saved in, not positionally across all', () => {
    // Live z-order has the saved second window in front.
    const tabs = [tab('loom-c', 1, 1), tab('loom-d', 2, 1), tab('loom-a', 1, 2), tab('loom-b', 2, 2)];
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b', 'loom-c', 'loom-d'], tabs, saved, attached: [] });
    expect(plan.windows.map((w) => [w.window?.window_index, w.assignments.map((a) => a.session)])).toEqual([
      [2, ['loom-a', 'loom-b']],
      [1, ['loom-c', 'loom-d']],
    ]);
    expect(plan.assignments.every((a) => a.reuse && tabMatches(a.reuse.title, a.session))).toBe(true);
  });

  it('fills bare-shell tabs of the matched window, never another window\'s', () => {
    // Window 1 still has loom-a attached; window 2 is all bare shells.
    const tabs = [tab('loom-a', 1, 1), tab('~', 2, 1), tab('~', 1, 2), tab('~', 2, 2)];
    const plan = planTabAttach({ sessions: ['loom-b', 'loom-c', 'loom-d'], tabs, saved, attached: ['loom-a'] });
    const [w1, w2] = plan.windows;
    expect(w1.window?.window_index).toBe(1); // matched through the attached loom-a
    expect(w1.assignments.map((a) => [a.session, a.reuse?.window_index, a.reuse?.tab_index])).toEqual([['loom-b', 1, 2]]);
    expect(w2.window?.window_index).toBe(2); // the all-free window
    expect(w2.assignments.map((a) => [a.session, a.reuse?.window_index, a.reuse?.tab_index])).toEqual([
      ['loom-c', 2, 1],
      ['loom-d', 2, 2],
    ]);
    expect(plan.leftover).toEqual([]);
  });

  it('plans a new window at its saved bounds when Ghostty has fewer windows', () => {
    const tabs = [tab('~', 1, 1)];
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b', 'loom-c', 'loom-d'], tabs, saved, attached: [] });
    expect(plan.windows[0].window?.window_index).toBe(1);
    expect(plan.windows[0].assignments.map((a) => a.reuse?.tab_index ?? null)).toEqual([1, null]);
    expect(plan.windows[1].window).toBeNull();
    expect(plan.windows[1].bounds).toEqual({ x: 900, y: 0, w: 800, h: 600 });
    const s = buildAttachScript(plan);
    expect(s).toContain('keystroke "n" using command down');
    expect(s).toContain('set position of window 1 to {900, 0}');
    expect(s).toContain('set size of window 1 to {800, 600}');
  });

  it('does not reuse a window whose tabs are busy with unrelated sessions', () => {
    const tabs = [tab('loom-x', 1, 1)];
    const plan = planTabAttach({ sessions: ['loom-a'], tabs, saved, attached: ['loom-x'] });
    expect(plan.windows[0].window).toBeNull();
  });

  it('sends a session no window remembers to the end of the last window', () => {
    const plan = planTabAttach({ sessions: ['loom-new', 'loom-a', 'loom-c'], tabs: [], saved, attached: [] });
    expect(plan.windows.map((w) => w.assignments.map((a) => a.session))).toEqual([
      ['loom-a'],
      ['loom-c', 'loom-new'],
    ]);
  });

  it('treats no saved windows as one window (legacy flat snapshot)', () => {
    const tabs = [tab('~', 1, 1), tab('~', 2, 1)];
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b', 'loom-c'], tabs, saved: [{ tabs: ['loom-a', 'loom-b', 'loom-c'] }], attached: [] });
    expect(plan.windows).toHaveLength(1);
    expect(plan.windows[0].assignments.map((a) => a.reuse?.tab_index ?? null)).toEqual([1, 2, null]);
  });
});

describe('orderSessionsByTabs', () => {
  it('replays sessions in the order their tabs sat in, not alphabetically', () => {
    expect(orderSessionsByTabs(['loom-a', 'loom-b', 'loom-z'], ['loom-z', 'loom-a', 'loom-b'])).toEqual([
      'loom-z', 'loom-a', 'loom-b',
    ]);
  });

  it('appends sessions with no remembered tab, keeping their relative order', () => {
    expect(orderSessionsByTabs(['loom-new', 'loom-a', 'loom-b'], ['loom-b', 'loom-a'])).toEqual([
      'loom-b', 'loom-a', 'loom-new',
    ]);
  });

  it('falls back to the given order when nothing was remembered', () => {
    expect(orderSessionsByTabs(['loom-b', 'loom-a'], [])).toEqual(['loom-b', 'loom-a']);
  });
});

describe('buildAttachScript', () => {
  it('clicks a reused tab and types its attach command', () => {
    const tabs = [tab('loom-a', 1)];
    const s = buildAttachScript(planTabAttach({ sessions: ['loom-a'], tabs, attached: [] }));
    expect(s).toContain('tell application "Ghostty" to activate');
    expect(s).toContain('click radio button 1 of tab group 1 of window 1');
    expect(s).toContain('keystroke "ta loom-a"');
    expect(s).not.toContain('keystroke "t" using command down');
  });

  it('selects the last tab before opening new ones so they append in order', () => {
    const tabs = [tab('loom-a', 1)];
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b', 'loom-c'], tabs, attached: [] });
    const s = buildAttachScript(plan);
    const lines = s.split('\n');
    const firstNew = lines.findIndex((l) => l.includes('keystroke "t" using command down'));
    expect(lines.slice(0, firstNew).some((l) => l.includes('click radio button 1'))).toBe(true);
    expect(s.match(/keystroke "t" using command down/g)?.length).toBe(2);
    expect(lines.filter((l) => l.includes('keystroke "ta ')).map((l) => l.trim())).toEqual([
      'keystroke "ta loom-a"',
      'keystroke "ta loom-b"',
      'keystroke "ta loom-c"',
    ]);
  });

  it('escapes double quotes and backslashes in session names', () => {
    const plan = planTabAttach({ sessions: ['loom-a"b\\c'], tabs: [], attached: [] });
    expect(buildAttachScript(plan)).toContain('keystroke "ta loom-a\\"b\\\\c"');
  });
});

describe('buildAttachScript window addressing', () => {
  // AXRaise moves a window to AX index 1 and pushes the ones in front of it
  // back, so every window reference after the first raise must be recomputed.
  it('raises each window by its current z-order index and then only talks to window 1', () => {
    const saved: SavedGhosttyWindow[] = [{ tabs: ['loom-a', 'loom-b'] }, { tabs: ['loom-c'] }, { tabs: ['loom-e'] }];
    // Read-time z-order: loom-c's window in front, loom-e's second, loom-a's third.
    const tabs = [tab('loom-c', 1, 1), tab('loom-e', 1, 2), tab('loom-a', 1, 3), tab('~', 2, 3)];
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b', 'loom-c', 'loom-e'], tabs, saved, attached: [] });
    const s = buildAttachScript(plan);
    // [1,2,3] -raise 3-> [3,1,2] -raise live1 (now at 2)-> [1,3,2] -raise live2 (now at 3)-> [2,1,3]
    expect(s.match(/AXRaise" of window \d+/g)).toEqual([
      'AXRaise" of window 3',
      'AXRaise" of window 2',
      'AXRaise" of window 3',
    ]);
    const refs = s.split('\n').filter((l) => /of window \d/.test(l) && !l.includes('AXRaise'));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((l) => l.includes('of window 1'))).toBe(true);
  });

  it('counts a new window as pushing the existing ones back', () => {
    const saved: SavedGhosttyWindow[] = [{ tabs: ['loom-new'] }, { tabs: ['loom-a'] }];
    // One live window: a busy loom-x tab and loom-a's tab.
    const tabs = [tab('loom-x', 1, 1), tab('loom-a', 2, 1)];
    const plan = planTabAttach({ sessions: ['loom-new', 'loom-a'], tabs, saved, attached: ['loom-x'] });
    expect(plan.windows[0].window).toBeNull();
    const s = buildAttachScript(plan);
    // the live window was index 1 at read time; after Cmd-N it is index 2
    expect(s.indexOf('keystroke "n" using command down')).toBeLessThan(s.indexOf('AXRaise'));
    expect(s).toContain('AXRaise" of window 2');
    expect(s).toContain('click radio button 2 of tab group 1 of window 1');
  });
});

describe('attachGhosttyTabs', () => {
  it('no-ops with no sessions', () => {
    expect(attachGhosttyTabs([], { dryRun: true })).toMatchObject({ ok: true, opened: 0, reused: 0, script: '' });
  });

  it('dry-run returns the script and the reuse counts without running osascript', () => {
    const r = attachGhosttyTabs(['loom-x', 'loom-y'], { dryRun: true, tabs: [tab('loom-x', 1)], attached: [] });
    expect(r).toMatchObject({ ok: true, reused: 1, opened: 1, leftover: 0 });
    expect(r.script).toContain('keystroke "ta loom-x"');
  });
});
