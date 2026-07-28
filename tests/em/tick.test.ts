import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db.ts';
import { scanTick, triageTick } from '../../src/em/index.ts';
import { newFindings, setEmMode } from '../../src/em/ledger.ts';
import type { LiveLoc } from '../../src/dashboard.ts';

const NOW = 2_000_000_000_000;

const PANE: LiveLoc = {
  agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a',
  window_index: '0', pane_index: '0', running: true, working: false,
};

function seed(db: any, over: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tick-'));
  const jsonl = path.join(dir, 's1.jsonl');
  fs.writeFileSync(jsonl, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Which approach do you want?' }] } }));
  // 12 minutes, not 10: computeSignals takes max(last_active_at, mtime), and
  // WRAPPABLE needs idleMs STRICTLY GREATER than its 10-minute threshold. Both
  // values must clear it or the wrap-up cases silently detect nothing.
  const idle = 12 * 60_000;
  const old = new Date(NOW - idle);
  fs.utimesSync(jsonl, old, old);
  db.prepare(`INSERT INTO chats (agent, session_id, project_dir, jsonl_path, started_at, ended_at,
    last_active_at, message_count, first_message, state, title, jsonl_mtime, last_indexed_at, summary_dirty)
    VALUES ('claude','s1',@project_dir,@jsonl_path,@started,@ended,@ended,12,'do it',@state,'t',0,0,0)`)
    .run({ project_dir: dir, jsonl_path: jsonl, started: NOW - 3_600_000, ended: NOW - idle, state: 'waiting_on_user', ...over });
  return { dir, jsonl };
}

describe('scanTick', () => {
  it('records a finding for a blocked session and costs no model call', () => {
    const db = openDb(':memory:');
    seed(db);
    const n = scanTick(db, { 'claude:s1': PANE }, NOW);
    expect(n).toBe(1);
    expect(newFindings(db)[0].kind).toBe('BLOCKED');
    db.close();
  });

  it('does not re-record the same finding on the next tick', () => {
    const db = openDb(':memory:');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    expect(scanTick(db, { 'claude:s1': PANE }, NOW + 30_000)).toBe(0);
    db.close();
  });

  it('records nothing when the mode is off', () => {
    const db = openDb(':memory:');
    setEmMode(db, 'off');
    seed(db);
    expect(scanTick(db, { 'claude:s1': PANE }, NOW)).toBe(0);
    db.close();
  });
});

describe('triageTick', () => {
  it('answers a blocked session in shadow mode without touching the pane', async () => {
    const db = openDb(':memory:'); // defaults to shadow
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const send = vi.fn();
    const runner = vi.fn(async () => '{"decision":"answer","answer":"Use the Dropdown.","citation":"AGENTS.md"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send });
    expect(runner).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    const row = db.prepare(`SELECT * FROM em_actions`).get() as any;
    expect(row.kind).toBe('answer');
    expect(row.shadow).toBe(1);
    expect(row.payload).toContain('Use the Dropdown.');
    db.close();
  });

  it('sends the answer to the pane in live mode', async () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const send = vi.fn(() => ({ ok: true, detail: 'sent' }));
    const runner = vi.fn(async () => '{"decision":"answer","answer":"Use the Dropdown.","citation":"AGENTS.md"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send });
    expect(send).toHaveBeenCalledOnce();
    expect((send as any).mock.calls[0][1]).toContain('Use the Dropdown.');
    db.close();
  });

  it('marks an escalated finding as escalated and never writes to the pane', async () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const send = vi.fn(() => ({ ok: true, detail: 'sent' }));
    const runner = vi.fn(async () => '{"decision":"escalate","reason":"pricing is a product call"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send });
    const f = db.prepare(`SELECT status FROM em_findings`).get() as any;
    expect(f.status).toBe('escalated');
    expect(send).not.toHaveBeenCalled();
    expect(newFindings(db).length).toBe(0);
    db.close();
  });

  it('leaves no finding in "new" after a pass, so nothing is triaged twice', async () => {
    const db = openDb(':memory:');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const runner = vi.fn(async () => '{"decision":"escalate","reason":"x"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send: vi.fn() });
    expect(newFindings(db).length).toBe(0);
    db.close();
  });

  it('files fast-follows BEFORE wrapping up, so nothing is dropped', async () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    seed(db, { state: 'done' });
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const order: string[] = [];
    const gh = vi.fn(() => { order.push('issue'); return 'https://github.com/o/r/issues/9'; });
    const close = vi.fn(() => { order.push('close'); return { ok: true, detail: 'closed' }; });
    const runner = vi.fn(async () => '{"fast_follows":[{"title":"Add a test","body":"uncovered"}]}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, gh, close });
    expect(order).toEqual(['issue', 'close']);
    db.close();
  });

  it('does NOT close the session when filing its fast-follow fails', async () => {
    // Nothing is dropped, only deferred: a failed filing must abort the wrap-up.
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    seed(db, { state: 'done' });
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const gh = vi.fn(() => { throw new Error('gh: not authenticated'); });
    const close = vi.fn(() => ({ ok: true, detail: 'closed' }));
    const runner = vi.fn(async () => '{"fast_follows":[{"title":"Add a test","body":"uncovered"}]}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, gh, close });
    expect(close).not.toHaveBeenCalled();
    db.close();
  });
});
