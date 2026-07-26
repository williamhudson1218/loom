import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readTranscript } from '../src/transcript.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');
const CODEX_FIX = path.join(__dirname, 'fixtures', 'codex-chat.jsonl');

describe('readTranscript', () => {
  it('returns only real prompts + prose, dropping tool-only turns', () => {
    const msgs = readTranscript('claude', FIX);
    // fixture has 3 user text messages; both assistant turns are tool_use only.
    expect(msgs.length).toBe(3);
    expect(msgs.every((m) => m.role === 'user')).toBe(true);
    expect(msgs[0].text).toBe('first thing I said');
    expect(msgs.some((m) => m.text.includes('⚙') || m.text.includes('result'))).toBe(false);
  });

  it('reads Codex user and assistant prose', () => {
    expect(readTranscript('codex', CODEX_FIX)).toEqual([
      { role: 'user', text: 'fix the deployment' },
      { role: 'assistant', text: 'I will inspect the deployment configuration.' },
    ]);
  });

  it('returns empty for a missing file', () => {
    expect(readTranscript('claude', '/no/such/file.jsonl')).toEqual([]);
  });
});
