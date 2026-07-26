import { describe, expect, it } from 'vitest';
import { buildLaunchCommand, launchInPane } from '../src/goto.ts';

describe('buildLaunchCommand', () => {
  it('uses native resume only for a matching source and selected agent', () => {
    expect(buildLaunchCommand({ sourceAgent: 'codex', selectedAgent: 'codex', sessionId: 's', projectDir: '/p' }))
      .toContain("cd '/p' && codex resume 's'");
  });

  it('starts a fresh alternate agent without a source id', () => {
    expect(buildLaunchCommand({ sourceAgent: 'claude', selectedAgent: 'codex', sessionId: 'old', projectDir: '/p' }))
      .toBe("cd '/p' && codex");
  });
});

describe('launchInPane', () => {
  it('rejects branches unless both source and selected agents are Claude', () => {
    expect(launchInPane({
      paneId: '%1', projectDir: '/p', sessionId: 's', sourceAgent: 'codex', selectedAgent: 'codex', fork: true,
    })).toEqual({ ok: false, detail: 'branching is only supported for Claude sessions' });
  });
});
