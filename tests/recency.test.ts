import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseJsonlFile, isTurnRecord, lastTurnAtFromTail } from '../src/parser.ts';

const FIX = path.join(__dirname, 'fixtures', 'recency-chat.jsonl');
const T = (s: string) => Date.parse(s);

describe('last_turn_at', () => {
  it('is the last real turn, not the last thing written to the file', async () => {
    // Claude Code keeps writing to a transcript after the conversation stops:
    // title rewrites, system records, attachments, late tool results. Those
    // move last_active_at (the file is busy) but not last_turn_at (nobody said
    // anything), which is what the board sorts by.
    const c = await parseJsonlFile(FIX);
    expect(c.last_turn_at).toBe(T('2026-06-15T12:05:00.000Z'));
    expect(c.last_active_at).toBe(T('2026-06-15T12:31:00.000Z'));
  });

  it('counts a user prompt and an assistant message as turns, nothing else', () => {
    const user = (content: unknown, extra: object = {}) => ({ type: 'user', message: { role: 'user', content }, ...extra });
    expect(isTurnRecord(user('hello'))).toBe(true);
    expect(isTurnRecord(user([{ type: 'text', text: 'hello' }]))).toBe(true);
    expect(isTurnRecord(user([{ type: 'tool_result', content: 'x' }]))).toBe(false);
    expect(isTurnRecord(user('reminder', { isMeta: true }))).toBe(false);
    expect(isTurnRecord({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } })).toBe(true);
    expect(isTurnRecord({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash' }] } })).toBe(true);
    for (const type of ['system', 'ai-title', 'attachment', 'queue-operation', 'file-history-snapshot', 'api-request'])
      expect(isTurnRecord({ type, timestamp: '2026-06-15T12:00:00.000Z' })).toBe(false);
  });

  it('reads the last turn off the tail of a live transcript without parsing it all', () => {
    expect(lastTurnAtFromTail(FIX)).toBe(T('2026-06-15T12:05:00.000Z'));
  });

  it('returns 0 when no turn is in the tail, so the caller keeps what it had', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-recency-'));
    const file = path.join(dir, 'x.jsonl');
    const turn = JSON.stringify({ type: 'assistant', timestamp: '2026-06-15T12:05:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'early' }] } });
    const noise = JSON.stringify({ type: 'system', timestamp: '2026-06-15T12:06:00.000Z', content: 'x'.repeat(2000) });
    // ~200KB of noise after the one turn: a 64KB tail misses it, the default 256KB tail still covers the whole file.
    fs.writeFileSync(file, [turn, ...Array(100).fill(noise)].join('\n') + '\n');
    expect(lastTurnAtFromTail(file, 64 * 1024)).toBe(0);
    expect(lastTurnAtFromTail(file)).toBe(T('2026-06-15T12:05:00.000Z'));
    expect(lastTurnAtFromTail(path.join(dir, 'missing.jsonl'))).toBe(0);
  });
});
