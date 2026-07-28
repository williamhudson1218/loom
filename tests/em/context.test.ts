import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readContextUsage, limitFor } from '../../src/em/context.ts';

function writeJsonl(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ctx-'));
  const f = path.join(dir, 'c.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  return f;
}

function assistant(model: string, usage: Record<string, number>) {
  return { type: 'assistant', message: { role: 'assistant', model, usage, content: [] } };
}

describe('readContextUsage', () => {
  it('sums the three input components of the LAST assistant message', () => {
    const f = writeJsonl([
      assistant('claude-opus-5', { input_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 50 }),
      assistant('claude-opus-5', { input_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_000, output_tokens: 60 }),
    ]);
    const u = readContextUsage(f);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(91_002);
    expect(u!.model).toBe('claude-opus-5');
    expect(u!.limit).toBe(200_000);
    expect(u!.fraction).toBeCloseTo(0.45501, 4);
  });

  it('ignores output_tokens, which do not occupy the window', () => {
    const f = writeJsonl([assistant('claude-opus-5', { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 99_999 })]);
    expect(readContextUsage(f)!.tokens).toBe(5);
  });

  it('returns null when no usage block exists (Codex transcripts)', () => {
    const f = writeJsonl([{ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }]);
    expect(readContextUsage(f)).toBeNull();
  });

  it('returns null for a missing file rather than throwing', () => {
    expect(readContextUsage('/nope/does-not-exist.jsonl')).toBeNull();
  });
});

describe('limitFor', () => {
  it('maps a known model to its standard window', () => {
    expect(limitFor('claude-opus-5', 50_000)).toBe(200_000);
  });

  it('promotes to a larger tier when observed usage exceeds the mapped limit', () => {
    // A 1M-context session records the SAME model id as its 200k sibling, so the
    // id alone cannot identify the window. Without promotion this would report
    // >100% and fire BLOATED on every single turn.
    expect(limitFor('claude-opus-5', 340_000)).toBe(500_000);
    expect(limitFor('claude-opus-5', 700_000)).toBe(1_000_000);
  });

  it('falls back to the default window for an unknown model id', () => {
    expect(limitFor('some-future-model', 10_000)).toBe(200_000);
  });
});
