import { describe, expect, it } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readPlacements } from '../src/placements.ts';

const HOOK = path.join(import.meta.dirname, '..', 'hooks', 'record-placement.sh');

// The hook is the only writer of placements.jsonl and is shared by both agents —
// Claude runs it from ~/.claude/settings.json, Codex from ~/.codex/hooks.json.
// Recording the wrong agent (or none) is invisible until every session of one
// agent silently reads as stale, which is exactly what happened, so drive the real
// script with each agent's real payload shape.
function runHook(payload: unknown, env: Record<string, string> = {}): ReturnType<typeof readPlacements> {
  const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-hook-'));
  execFileSync(HOOK, {
    input: JSON.stringify(payload),
    env: { ...process.env, LOOM_HOME: loomHome, TMUX: '/tmp/tmux-501/default,1,0', TMUX_PANE: '%42', ...env },
    encoding: 'utf-8',
  });
  return readPlacements(path.join(loomHome, 'placements.jsonl'));
}

describe('record-placement hook', () => {
  it('tags a Codex session from its rollout transcript path', () => {
    const placements = runHook({
      session_id: '019fa287-85f0-79f2-ab4d-cdd802d3c852',
      transcript_path: '/Users/x/.codex/sessions/2026/07/26/rollout-2026-07-26T21-43-38-019fa287-85f0-79f2-ab4d-cdd802d3c852.jsonl',
      cwd: '/Users/x/dev/loom',
      hook_event_name: 'SessionStart',
      source: 'startup',
    });

    expect(placements.get('codex:019fa287-85f0-79f2-ab4d-cdd802d3c852')).toMatchObject({
      agent: 'codex',
      session_id: '019fa287-85f0-79f2-ab4d-cdd802d3c852',
      pane_id: '%42',
    });
  });

  it('tags a Claude session from its projects transcript path', () => {
    const placements = runHook({
      session_id: '7246d48c-6c01-4d0b-b3f8-c3e12881b5b9',
      transcript_path: '/Users/x/.claude/projects/-Users-x-dev-loom/7246d48c-6c01-4d0b-b3f8-c3e12881b5b9.jsonl',
      cwd: '/Users/x/dev/loom',
      hook_event_name: 'UserPromptSubmit',
    });

    expect(placements.get('claude:7246d48c-6c01-4d0b-b3f8-c3e12881b5b9')?.agent).toBe('claude');
  });

  it('falls back to $CODEX_HOME when no transcript path is supplied', () => {
    const placements = runHook({ session_id: 'no-transcript', cwd: '/x' }, { CODEX_HOME: '/Users/x/.codex' });

    expect(placements.get('codex:no-transcript')?.agent).toBe('codex');
  });

  it('writes nothing outside tmux, where there is no pane to record', () => {
    const loomHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-hook-'));
    const env: NodeJS.ProcessEnv = { ...process.env, LOOM_HOME: loomHome };
    delete env.TMUX;
    delete env.TMUX_PANE;
    execFileSync(HOOK, { input: JSON.stringify({ session_id: 's' }), env, encoding: 'utf-8' });

    expect(fs.existsSync(path.join(loomHome, 'placements.jsonl'))).toBe(false);
  });
});
