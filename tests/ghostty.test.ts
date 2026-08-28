import { describe, it, expect } from 'vitest';
import {
  attachGhosttyTabs,
  buildAttachScript,
  orderSessionsByTabs,
  parseTabs,
  planTabAttach,
  type GhosttyTab,
} from '../src/ghostty.ts';

function tab(title: string, tab_index: number, window_index = 1): GhosttyTab {
  return { window_index, tab_index, title, tabbed: true };
}

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
    const s = buildAttachScript(planTabAttach({ sessions: ['loom-a'], tabs, attached: [] }), tabs);
    expect(s).toContain('tell application "Ghostty" to activate');
    expect(s).toContain('click radio button 1 of tab group 1 of window 1');
    expect(s).toContain('keystroke "ta loom-a"');
    expect(s).not.toContain('keystroke "t" using command down');
  });

  it('selects the last tab before opening new ones so they append in order', () => {
    const tabs = [tab('loom-a', 1)];
    const plan = planTabAttach({ sessions: ['loom-a', 'loom-b', 'loom-c'], tabs, attached: [] });
    const s = buildAttachScript(plan, tabs);
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
    expect(buildAttachScript(plan, [])).toContain('keystroke "ta loom-a\\"b\\\\c"');
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
