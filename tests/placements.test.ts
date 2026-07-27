import { describe, it, expect, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { agentPaneIds, agentSessionKey, liveSessionsFrom, readPlacements, cleanPaneTitle, readingOrder, type TmuxPane } from '../src/placements.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

describe('cleanPaneTitle', () => {
  it('strips leading spinner/status glyphs Claude prepends', () => {
    expect(cleanPaneTitle('✳ Fix the bug')).toBe('Fix the bug');
    expect(cleanPaneTitle('⠂ Build local chat management agent')).toBe('Build local chat management agent');
    expect(cleanPaneTitle('Claude Code')).toBe('Claude Code');
  });
});

describe('readPlacements', () => {
  it('returns last record per session (append-only log, last wins)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pl-'));
    const file = path.join(dir, 'placements.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ session_id: 's1', pane_id: '%1', tmux_session: 'a', window_index: '1', pane_index: '0', cwd: '/x', ts: 1 }),
        JSON.stringify({ session_id: 's2', pane_id: '%2', tmux_session: 'b', window_index: '1', pane_index: '0', cwd: '/y', ts: 2 }),
        '', // blank line tolerated
        'not json', // malformed tolerated
        JSON.stringify({ session_id: 's1', pane_id: '%9', tmux_session: 'a', window_index: '1', pane_index: '3', cwd: '/x', ts: 3 }),
      ].join('\n'),
    );
    const map = readPlacements(file);
    expect(map.size).toBe(2);
    expect(map.get('?:s1')?.pane_id).toBe('%9'); // last wins
    expect(map.get('?:s2')?.pane_id).toBe('%2');
    // The pre-multi-agent hook wrote no agent; such a row stays unattributed rather
    // than being assumed to be Claude (it fired for Codex sessions too).
    expect(map.get('?:s1')?.agent).toBeNull();
    expect(map.get('?:s2')?.agent).toBeNull();
  });

  it('keeps an agent-tagged row separate from a legacy row for the same id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pl-'));
    const file = path.join(dir, 'placements.jsonl');
    fs.writeFileSync(
      file,
      [
        JSON.stringify({ session_id: 's1', pane_id: '%1', tmux_session: 'a', window_index: '1', pane_index: '0', cwd: '/x', ts: 1 }),
        JSON.stringify({ agent: 'codex', session_id: 's1', pane_id: '%2', tmux_session: 'a', window_index: '1', pane_index: '1', cwd: '/x', ts: 2 }),
      ].join('\n'),
    );
    const map = readPlacements(file);

    expect(map.size).toBe(2);
    expect(map.get('?:s1')?.pane_id).toBe('%1');
    expect(map.get(agentSessionKey('codex', 's1'))?.pane_id).toBe('%2');
  });

  it('returns an empty map when the file is missing', () => {
    expect(readPlacements('/no/such/placements.jsonl').size).toBe(0);
  });
});

describe('liveSessionsFrom', () => {
  it('keeps same session ids from Claude and Codex in separate live entries', () => {
    const panes: TmuxPane[] = [
      { pane_id: '%1', tmux_session: 'loom-a', window_index: '0', pane_index: '0', pane_pid: '1', command: 'claude', cwd: '/a', left: 0, top: 0, title: '' },
      { pane_id: '%2', tmux_session: 'loom-b', window_index: '0', pane_index: '0', pane_pid: '2', command: 'codex', cwd: '/b', left: 0, top: 0, title: '' },
    ];
    const placements = new Map([
      [agentSessionKey('claude', 'same-id'), { agent: 'claude' as const, session_id: 'same-id', pane_id: '%1', tmux_session: 'loom-a', window_index: '0', pane_index: '0', cwd: '/a', ts: 1 }],
      [agentSessionKey('codex', 'same-id'), { agent: 'codex' as const, session_id: 'same-id', pane_id: '%2', tmux_session: 'loom-b', window_index: '0', pane_index: '0', cwd: '/b', ts: 2 }],
    ]);

    const live = liveSessionsFrom(panes, new Map([['%1', 'claude'], ['%2', 'codex']]), placements);

    expect(live.get(agentSessionKey('claude', 'same-id'))?.pane_id).toBe('%1');
    expect(live.get(agentSessionKey('codex', 'same-id'))?.pane_id).toBe('%2');
  });

  // The bug this fixes: the shared hook recorded Codex sessions with no agent field,
  // those rows read back as Claude, and every Codex chat therefore showed as stale
  // even though its pane was right there. A row with no agent must take the agent
  // the pane is actually running.
  it('binds an agent-less legacy row to the agent running in its pane', () => {
    const panes: TmuxPane[] = [
      { pane_id: '%10', tmux_session: 'loom-tp-2', window_index: '1', pane_index: '1', pane_pid: '10', command: 'codex', cwd: '/tp', left: 0, top: 0, title: 'tax-pilot-app' },
    ];
    const placements = new Map([
      ['?:019f9db7-6176', { agent: null, session_id: '019f9db7-6176', pane_id: '%10', tmux_session: 'loom-tp-2', window_index: '1', pane_index: '1', cwd: '/tp', ts: 1 }],
    ]);

    const live = liveSessionsFrom(panes, new Map([['%10', 'codex']]), placements);

    expect(live.get(agentSessionKey('codex', '019f9db7-6176'))?.pane_id).toBe('%10');
    expect(live.has(agentSessionKey('claude', '019f9db7-6176'))).toBe(false);
  });

  it('leaves a pane unclaimed when its newest row belongs to the other agent', () => {
    const panes: TmuxPane[] = [
      { pane_id: '%3', tmux_session: 'loom-a', window_index: '0', pane_index: '0', pane_pid: '3', command: 'codex', cwd: '/a', left: 0, top: 0, title: '' },
    ];
    const placements = new Map([
      [agentSessionKey('claude', 'claude-id'), { agent: 'claude' as const, session_id: 'claude-id', pane_id: '%3', tmux_session: 'loom-a', window_index: '0', pane_index: '0', cwd: '/a', ts: 1 }],
    ]);

    expect(liveSessionsFrom(panes, new Map([['%3', 'codex']]), placements).size).toBe(0);
  });
});

describe('agentPaneIds', () => {
  it('recognizes Claude and Codex descendants of tmux panes', () => {
    vi.mocked(execFileSync).mockReturnValueOnce([
      '100 1 -zsh',
      '101 100 /usr/local/bin/claude --resume claude-session',
      '200 1 -zsh',
      '201 200 /usr/local/bin/codex resume codex-session',
    ].join('\n'));
    const panes: TmuxPane[] = [
      { pane_id: '%1', tmux_session: 'loom-a', window_index: '0', pane_index: '0', pane_pid: '100', command: 'zsh', cwd: '/a', left: 0, top: 0, title: '' },
      { pane_id: '%2', tmux_session: 'loom-b', window_index: '0', pane_index: '0', pane_pid: '200', command: 'zsh', cwd: '/b', left: 0, top: 0, title: '' },
    ];

    expect(agentPaneIds(panes)).toEqual(new Map([['%1', 'claude'], ['%2', 'codex']]));
  });
});

describe('readingOrder', () => {
  it('numbers panes top-to-bottom, left-to-right within each window', () => {
    const mk = (id: string, left: number, top: number): TmuxPane => ({
      pane_id: id, tmux_session: 's', window_index: '1', pane_index: '0', pane_pid: '1',
      command: 'zsh', cwd: '/x', left, top, title: '',
    });
    // visual: TL=%a(0,0) TR=%b(80,0) BL=%c(0,24) BR=%d(80,24)
    const pos = readingOrder([mk('%d', 80, 24), mk('%b', 80, 0), mk('%c', 0, 24), mk('%a', 0, 0)]);
    expect(pos.get('%a')).toBe(1);
    expect(pos.get('%b')).toBe(2);
    expect(pos.get('%c')).toBe(3);
    expect(pos.get('%d')).toBe(4);
  });
});
