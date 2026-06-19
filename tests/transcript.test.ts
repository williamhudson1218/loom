import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readTranscript } from '../src/transcript.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');

describe('readTranscript', () => {
  it('returns only real prompts + prose, dropping tool-only turns', () => {
    const msgs = readTranscript(FIX);
    // fixture has 3 user text messages; both assistant turns are tool_use only.
    expect(msgs.length).toBe(3);
    expect(msgs.every((m) => m.role === 'user')).toBe(true);
    expect(msgs[0].text).toBe('first thing I said');
    expect(msgs.some((m) => m.text.includes('⚙') || m.text.includes('result'))).toBe(false);
  });

  it('returns empty for a missing file', () => {
    expect(readTranscript('/no/such/file.jsonl')).toEqual([]);
  });
});
