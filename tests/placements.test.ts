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

  it('reads only what was appended since the last call, and the result matches a fresh parse', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pl-'));
    const file = path.join(dir, 'placements.jsonl');
    const row = (sid: string, pane: string, ts: number) => JSON.stringify({ agent: 'claude', session_id: sid, pane_id: pane, tmux_session: 'a', window_index: '1', pane_index: '0', cwd: '/x', ts }) + '\n';
    fs.writeFileSync(file, row('s1', '%1', 1) + row('s2', '%2', 2));
    expect(readPlacements(file).size).toBe(2);

    const reads = vi.spyOn(fs, 'readSync');
    expect(readPlacements(file).size).toBe(2); // unchanged: no read at all
    expect(reads).not.toHaveBeenCalled();

    const before = fs.statSync(file).size;
    fs.appendFileSync(file, row('s1', '%7', 3) + row('s3', '%3', 4));
    const map = readPlacements(file);
    // Only the appended bytes were read.
    const asked = reads.mock.calls.reduce((n, c) => n + Number((c as unknown[])[3] ?? 0), 0);
    expect(asked).toBe(fs.statSync(file).size - before);
    reads.mockRestore();
    expect(map.get(agentSessionKey('claude', 's1'))?.pane_id).toBe('%7');
    expect(map.get(agentSessionKey('claude', 's3'))?.pane_id).toBe('%3');
    expect(map.size).toBe(3);
  });

  it('leaves a half-written last line for the next call', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pl-'));
    const file = path.join(dir, 'placements.jsonl');
    const line = JSON.stringify({ agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'a', window_index: '1', pane_index: '0', cwd: '/x', ts: 1 });
    fs.writeFileSync(file, line.slice(0, 20));
    expect(readPlacements(file).size).toBe(0);
    fs.appendFileSync(file, line.slice(20) + '\n');
    expect(readPlacements(file).get(agentSessionKey('claude', 's1'))?.pane_id).toBe('%1');
  });

  it('starts over when the file is replaced or shrinks', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pl-'));
    const file = path.join(dir, 'placements.jsonl');
    const row = (sid: string, pane: string) => JSON.stringify({ agent: 'claude', session_id: sid, pane_id: pane, tmux_session: 'a', window_index: '1', pane_index: '0', cwd: '/x', ts: 1 }) + '\n';
    fs.writeFileSync(file, row('s1', '%1') + row('s2', '%2'));
    expect(readPlacements(file).size).toBe(2);
    fs.writeFileSync(file + '.new', row('s9', '%9'));
    fs.renameSync(file + '.new', file);
    const map = readPlacements(file);
    expect([...map.keys()]).toEqual([agentSessionKey('claude', 's9')]);
  });

  it('hands out a copy, so a caller cannot change the cached map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pl-'));
    const file = path.join(dir, 'placements.jsonl');
    fs.writeFileSync(file, JSON.stringify({ agent: 'claude', session_id: 's1', pane_id: '%1', ts: 1 }) + '\n');
    readPlacements(file).clear();
    expect(readPlacements(file).size).toBe(1);
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
      { pane_id: '%10', tmux_session: 'loom-tp-2', window_index: '1', pane_index: '1', pane_pid: '10', command: 'codex', cwd: '/tp', left: 0, top: 0, title: 'acme-app' },
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
