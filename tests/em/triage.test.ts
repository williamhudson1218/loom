import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBlockedTriage, parseFastFollows, buildBlockedPrompt, buildFastFollowPrompt,
  buildHandoffPrompt, lastAssistantText,
} from '../../src/em/triage.ts';

describe('parseBlockedTriage', () => {
  it('parses an answer with its citation', () => {
    const r = parseBlockedTriage('{"decision":"answer","answer":"Use the Dropdown component.","citation":"AGENTS.md"}');
    expect(r).toEqual({ decision: 'answer', answer: 'Use the Dropdown component.', citation: 'AGENTS.md' });
  });

  it('parses an escalation with its reason', () => {
    const r = parseBlockedTriage('{"decision":"escalate","reason":"Pricing is a product call."}');
    expect(r).toEqual({ decision: 'escalate', reason: 'Pricing is a product call.' });
  });

  it('tolerates prose and fences around the JSON', () => {
    const r = parseBlockedTriage('Sure!\n```json\n{"decision":"escalate","reason":"needs Will"}\n```\nHope that helps.');
    expect(r.decision).toBe('escalate');
  });

  it('escalates when the response is unparseable — a wrong auto-answer is worse than a slow one', () => {
    const r = parseBlockedTriage('I could not determine an answer.');
    expect(r.decision).toBe('escalate');
  });

  it('escalates an answer that arrives with no citation', () => {
    // Uncited means underived, which is exactly what must not be auto-sent.
    const r = parseBlockedTriage('{"decision":"answer","answer":"probably yes","citation":""}');
    expect(r.decision).toBe('escalate');
  });

  it('escalates an answer whose text is empty', () => {
    expect(parseBlockedTriage('{"decision":"answer","answer":"   ","citation":"AGENTS.md"}').decision).toBe('escalate');
  });
});

describe('parseFastFollows', () => {
  it('parses a list of follow-ups', () => {
    const r = parseFastFollows('{"fast_follows":[{"title":"Add a test","body":"The retry path is uncovered."}]}');
    expect(r).toEqual([{ title: 'Add a test', body: 'The retry path is uncovered.' }]);
  });

  it('returns an empty list when the session genuinely left nothing behind', () => {
    expect(parseFastFollows('{"fast_follows":[]}')).toEqual([]);
  });

  it('returns an empty list rather than throwing on a malformed response', () => {
    expect(parseFastFollows('no json here')).toEqual([]);
  });

  it('drops entries missing a title', () => {
    expect(parseFastFollows('{"fast_follows":[{"body":"orphan"},{"title":"keep","body":"b"}]}')).toEqual([{ title: 'keep', body: 'b' }]);
  });
});

describe('prompt builders', () => {
  it('tells the blocked triage to read the conventions itself and to default to escalating', () => {
    const p = buildBlockedPrompt('Which dropdown should I use?', '/repo', 'USER: hi');
    expect(p).toContain('AGENTS.md');
    expect(p).toContain('escalate');
    expect(p).toContain('Which dropdown should I use?');
  });

  it('instructs the fast-follow extractor to return an empty list when nothing is outstanding', () => {
    const p = buildFastFollowPrompt('USER: hi\nASSISTANT: done');
    expect(p).toContain('fast_follows');
    expect(p).toContain('empty');
  });

  it('asks the handoff brief for prose, not JSON, since it is sent verbatim', () => {
    const p = buildHandoffPrompt('USER: hi');
    expect(p.toLowerCase()).toContain('no json');
  });
});

describe('lastAssistantText', () => {
  it('returns the final assistant turn — the question actually being asked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-last-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Which approach do you want?' }] } }),
    ].join('\n'));
    expect(lastAssistantText('claude', f)).toBe('Which approach do you want?');
  });

  it('returns an empty string when there is no assistant turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-last2-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
    expect(lastAssistantText('claude', f)).toBe('');
  });
});
