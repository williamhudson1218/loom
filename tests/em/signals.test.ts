import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSignals } from '../../src/em/signals.ts';
import type { ChatRow } from '../../src/types.ts';
import type { LiveLoc } from '../../src/dashboard.ts';

const NOW = 2_000_000_000_000;

function chatRow(over: Partial<ChatRow> = {}): ChatRow {
  return {
    agent: 'claude', session_id: 's1', project_dir: '/repo', jsonl_path: '/nope.jsonl',
    started_at: NOW - 600_000, ended_at: NOW, last_active_at: NOW, message_count: 12,
    activity_json: '{}', files_touched: '', files_written: '', first_message: 'do the thing',
    claude_auto_title: '', pr_url: '', title: 't', overview: 'o', state: 'waiting_on_user',
    breakdown_json: '[]', summary_dirty: 0, summary_model: '', summary_at: 0,
    last_tmux_session: '', last_pane_id: '', saved: 0, saved_at: 0,
    jsonl_mtime: NOW, last_indexed_at: NOW, ...over,
  };
}

function liveLoc(over: Partial<LiveLoc> = {}): LiveLoc {
  return {
    agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a',
    window_index: '0', pane_index: '0', running: true, working: false, ...over,
  };
}

describe('computeSignals', () => {
  it('marks a chat with no live pane as not live, with no pane id', () => {
    const [s] = computeSignals([chatRow()], {}, NOW);
    expect(s.live).toBe(false);
    expect(s.pane).toBeNull();
  });

  it('carries live and working through from the live map', () => {
    const [s] = computeSignals([chatRow()], { 'claude:s1': liveLoc({ working: true }) }, NOW);
    expect(s.live).toBe(true);
    expect(s.working).toBe(true);
    expect(s.pane!.pane_id).toBe('%1');
  });

  it('derives idleMs from the transcript mtime, not the indexed last_active_at', () => {
    // last_active_at only refreshes on a summarizer pass (minutes of lag); the
    // file's mtime is the true last-activity time.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sig-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, '');
    const mtime = new Date(NOW - 300_000);
    fs.utimesSync(f, mtime, mtime);
    const [s] = computeSignals([chatRow({ jsonl_path: f, last_active_at: NOW - 900_000 })], {}, NOW);
    expect(s.idleMs).toBeGreaterThanOrEqual(299_000);
    expect(s.idleMs).toBeLessThanOrEqual(301_000);
  });

  it('falls back to last_active_at when the transcript is gone', () => {
    const [s] = computeSignals([chatRow({ jsonl_path: '/gone.jsonl', last_active_at: NOW - 60_000 })], {}, NOW);
    expect(s.idleMs).toBe(60_000);
  });

  it('splits files_written on newlines and drops blanks', () => {
    const [s] = computeSignals([chatRow({ files_written: '/repo/a.ts\n/repo/b.ts\n' })], {}, NOW);
    expect(s.filesWritten).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });

  it('excludes chats whose project_dir is the Loom repo itself', () => {
    // Otherwise the EM manages the session implementing the EM.
    const rows = [chatRow({ session_id: 'other', project_dir: '/repo' }), chatRow({ session_id: 'self', project_dir: '/loom' })];
    const out = computeSignals(rows, {}, NOW, { selfDir: '/loom' });
    expect(out.map((s) => s.session_id)).toEqual(['other']);
  });

  it('excludes chats nested inside the Loom repo, not just an exact match', () => {
    const rows = [chatRow({ session_id: 'wt', project_dir: '/loom/.worktrees/x' })];
    expect(computeSignals(rows, {}, NOW, { selfDir: '/loom' }).length).toBe(0);
  });
});
