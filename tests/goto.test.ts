import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLaunchCommand, launchInPane } from '../src/goto.ts';
import { agentSessionKey, liveSessionsFrom, readPlacements, type TmuxPane } from '../src/placements.ts';
import { captureLayoutFrom } from '../src/snapshot.ts';
import { restore } from '../src/restore.ts';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

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

  it('records a native Codex resume in Loom placements', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-goto-'));
    const placementFile = path.join(dir, 'placements.jsonl');
    vi.mocked(execFileSync).mockImplementation((command, args) => {
      if (command === 'tmux' && args?.[0] === 'display-message') {
        return 'loom-work~|LOOM|~2~|LOOM|~1~|LOOM|~/work';
      }
      return '';
    });

    expect(launchInPane({
      paneId: '%9', projectDir: '/work', sessionId: 'codex-session', sourceAgent: 'codex', selectedAgent: 'codex', placementFile,
    }).ok).toBe(true);

    const placements = readPlacements(placementFile);
    expect(placements.get(agentSessionKey('codex', 'codex-session'))).toMatchObject({
      agent: 'codex', session_id: 'codex-session', pane_id: '%9', tmux_session: 'loom-work', window_index: '2', pane_index: '1', cwd: '/work',
    });
    const pane: TmuxPane = { pane_id: '%9', tmux_session: 'loom-work', window_index: '2', pane_index: '1', pane_pid: '9', command: 'codex', cwd: '/work', left: 0, top: 0, title: '' };
    const agentPanes = new Map([['%9', 'codex' as const]]);
    const live = liveSessionsFrom([pane], agentPanes, placements);
    const snapshot = captureLayoutFrom({ now: 0, panes: [pane], agentPanes, live });

    expect(live.get(agentSessionKey('codex', 'codex-session'))?.pane_id).toBe('%9');
    expect(snapshot.sessions[0].windows[0].panes[0]).toMatchObject({ agent: 'codex', session_id: 'codex-session' });
    expect(restore({ dryRun: true, layout: snapshot, existing: new Set() }).log.join('\n')).toContain('codex resume');
  });
});
