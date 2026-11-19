import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addChatNote, hasChatNote, nudgeWhenFree, sentNote, takeChatNotes } from '../src/chatnotes.ts';
import type { Draft } from '../src/outbox.ts';

const base = { id: 'd1', session_id: 's', status: 'pending', created_at: '2026-11-18T10:00:00' } as Draft;

describe('chat notes', () => {
  it('appends one JSON line per note, per session, and refuses a bad session id', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-notes-'));
    expect(addChatNote('sess-1', 'a', dir, 1)).toBe(true);
    expect(addChatNote('sess-1', 'b', dir, 2)).toBe(true);
    expect(addChatNote('../x', 'c', dir)).toBe(false);
    expect(addChatNote('sess-1', '  ', dir)).toBe(false);
    const lines = fs.readFileSync(path.join(dir, 'sess-1.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([{ at: 1, text: 'a' }, { at: 2, text: 'b' }]);
  });

  it('says where a new channel post went and that it must not be sent again', () => {
    const n = sentNote({ ...base, channel: 'C1', messages: ['top', 'more'] }, ['top', 'more'], 'https://x/p1', '#eng');
    expect(n).toContain('your draft d1');
    expect(n).toContain('a new post in #eng (message 1 top-level, the other 1 as replies in its thread)');
    expect(n).toContain('Link: https://x/p1');
    expect(n).toContain('Do not send');
    expect(n).not.toContain('edited');
  });

  it('quotes what went out when the user edited it', () => {
    const n = sentNote({ ...base, channel: 'C1', thread_ts: '1.2', messages: ['old'] }, ['new text'], '', '#eng');
    expect(n).toContain('a reply in the thread in #eng');
    expect(n).toContain('The user edited it before sending. What went out:\n> new text');
  });
});

describe('nudgeWhenFree', () => {
  const run = (states: string[], note = () => true, typeOk = true) => {
    const typed: number[] = [];
    let i = 0;
    const queue: (() => void)[] = [];
    nudgeWhenFree({
      hasNote: note,
      pane: () => (states[Math.min(i++, states.length - 1)] as 'ready' | 'hold' | 'not-live'),
      type: () => (typed.push(i), typeOk),
      later: (fn) => void queue.push(fn),
    }, 5, 1);
    while (queue.length) queue.shift()!();
    return { typed, looks: i };
  };
  it('types once the chat is free, not while it is held', () => {
    expect(run(['hold', 'hold', 'ready'])).toEqual({ typed: [3], looks: 3 });
  });
  it('never types into a chat with no live pane', () => {
    expect(run(['not-live']).typed).toEqual([]);
  });
  it('stops when the hook already took the note', () => {
    expect(run(['ready'], () => false)).toEqual({ typed: [], looks: 0 });
  });
  it('gives up after its tries', () => {
    expect(run(['hold'])).toEqual({ typed: [], looks: 5 });
  });
  it('retries a failed type', () => {
    expect(run(['ready'], () => true, false).typed.length).toBe(5);
  });
});

describe('takeChatNotes / hasChatNote', () => {
  it('takes notes once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cn-'));
    addChatNote('s1', 'one', dir);
    addChatNote('s1', 'two', dir);
    expect(hasChatNote('s1', dir)).toBe(true);
    expect(takeChatNotes('s1', dir)).toEqual(['one', 'two']);
    expect(hasChatNote('s1', dir)).toBe(false);
    expect(takeChatNotes('s1', dir)).toEqual([]);
  });
});
