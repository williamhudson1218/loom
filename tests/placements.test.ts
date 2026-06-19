import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { readPlacements, cleanPaneTitle, readingOrder, type TmuxPane } from '../src/placements.ts';

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
    expect(map.get('s1')?.pane_id).toBe('%9'); // last wins
    expect(map.get('s2')?.pane_id).toBe('%2');
  });

  it('returns an empty map when the file is missing', () => {
    expect(readPlacements('/no/such/placements.jsonl').size).toBe(0);
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
