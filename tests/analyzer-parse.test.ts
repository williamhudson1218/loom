import { describe, it, expect } from 'vitest';
import { parseSummary, buildPrompt } from '../src/analyzer.ts';

describe('parseSummary', () => {
  it('parses a clean JSON object', () => {
    const raw = `{"title":"Fix dropdown","overview":"Fixed the size regression.","breakdown":["found bug","patched","left off at lint"]}`;
    const s = parseSummary(raw);
    expect(s.title).toBe('Fix dropdown');
    expect(s.breakdown.length).toBe(3);
  });

  it('extracts JSON even with surrounding prose', () => {
    const raw = `Here you go:\n{"title":"T","overview":"O","breakdown":["a"]}\nHope that helps!`;
    const s = parseSummary(raw);
    expect(s.title).toBe('T');
    expect(s.overview).toBe('O');
  });

  it('throws on missing fields', () => {
    expect(() => parseSummary(`{"title":"only"}`)).toThrow();
  });

  it('throws on no JSON', () => {
    expect(() => parseSummary(`no json here`)).toThrow();
  });

  it('parses state and key_moments, defaulting an unknown state to done', () => {
    const s = parseSummary(`{"title":"T","overview":"O","state":"waiting_on_user","key_moments":["a","b"]}`);
    expect(s.state).toBe('waiting_on_user');
    expect(s.breakdown).toEqual(['a', 'b']);

    const d = parseSummary(`{"title":"T","overview":"O","state":"bogus","breakdown":["x"]}`);
    expect(d.state).toBe('done'); // unknown -> done
  });
});

describe('buildPrompt', () => {
  it('embeds the transcript and asks for strict JSON', () => {
    const p = buildPrompt('USER: hi\nASSISTANT: hello');
    expect(p).toContain('USER: hi');
    expect(p).toContain('JSON');
  });
});
