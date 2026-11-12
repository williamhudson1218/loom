import { describe, it, expect } from 'vitest';
import { CLOSENAV_JS } from '../src/closenav.ts';

const pick = new Function(`${CLOSENAV_JS}; return closeNavPick;`)() as (k: string[], key: string) => string | null;

describe('close navigation', () => {
  const keys = ['a:1', 'a:2', 'a:3'];
  it('takes the next chat down from the middle', () => expect(pick(keys, 'a:2')).toBe('a:3'));
  it('takes the next chat down from the top', () => expect(pick(keys, 'a:1')).toBe('a:2'));
  it('falls back to the one above when it was last', () => expect(pick(keys, 'a:3')).toBe('a:2'));
  it('returns null when it was the only chat (orchestrator)', () => expect(pick(['a:1'], 'a:1')).toBeNull());
  it('uses the filtered list it is given', () => expect(pick(['a:1', 'a:3'], 'a:1')).toBe('a:3'));
  it('returns null when the chat is not in the list', () => expect(pick(keys, 'a:9')).toBeNull());
  it('treats a chat listed under two tag groups as one row', () => {
    expect(pick(['a:1', 'a:2', 'a:1'], 'a:1')).toBe('a:2');
    expect(pick(['a:2', 'a:1', 'a:1'], 'a:1')).toBe('a:2');
  });
});
