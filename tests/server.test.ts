import { describe, expect, it } from 'vitest';
import { archiveExcludeSessionIds } from '../src/server.ts';

describe('archiveExcludeSessionIds', () => {
  it('does not exclude a Claude archive hit for a same-id Codex board chat', () => {
    expect(archiveExcludeSessionIds([
      { agent: 'codex', session_id: 'same-id' },
      { agent: 'claude', session_id: 'claude-board-id' },
    ])).toEqual(['claude-board-id']);
  });
});
