import { describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildLaunchCommand, closeSession, launchInPane } from '../src/goto.ts';
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

  // Each agent forks through its own flow: Claude via --fork-session, Codex via its
  // `fork` subcommand. Both take the branch seed as a trailing prompt argument.
  it('branches Codex through its fork subcommand, seeded and naming Codex', () => {
    const cmd = buildLaunchCommand({ sourceAgent: 'codex', selectedAgent: 'codex', sessionId: 's', projectDir: '/p', fork: true });

    expect(cmd).toContain("cd '/p' && codex fork 's'");
    expect(cmd).toContain('forked branch of a previous Codex session');
    expect(cmd).not.toContain('--fork-session');
  });

  it('branches Claude through its fork flag, naming Claude Code', () => {
    const cmd = buildLaunchCommand({ sourceAgent: 'claude', selectedAgent: 'claude', sessionId: 's', projectDir: '/p', fork: true });

    expect(cmd).toContain("claude --resume 's' --fork-session");
    expect(cmd).toContain('forked branch of a previous Claude Code session');
  });
});

// Verified against the real TUIs: Codex ignores Ctrl-C as a quit (it only interrupts
// the turn and leaves the composer up), and Claude ignores a typed /exit.
describe('closeSession', () => {
  it('quits Codex with /quit, never Ctrl-C, and a second Enter for its popup', () => {
    vi.mocked(execFileSync).mockClear().mockReturnValue('');

    expect(closeSession('%9', 'codex')).toEqual({ ok: true, detail: 'sent /quit' });

    const sent = vi.mocked(execFileSync).mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(sent).toEqual(['send-keys -t %9 -l /quit', 'send-keys -t %9 Enter', 'send-keys -t %9 Enter']);
    expect(sent.join(' ')).not.toContain('C-c');
  });

  it('quits Claude with Ctrl-C twice', () => {
    vi.mocked(execFileSync).mockClear().mockReturnValue('');

    expect(closeSession('%9', 'claude')).toEqual({ ok: true, detail: 'sent Ctrl-C x2' });

    const sent = vi.mocked(execFileSync).mock.calls.map((c) => (c[1] as string[]).join(' '));
    expect(sent).toEqual(['send-keys -t %9 C-c', 'send-keys -t %9 C-c']);
  });
});

describe('launchInPane', () => {
  it('rejects a branch across agents — neither can read the other transcript', () => {
    expect(launchInPane({
      paneId: '%1', projectDir: '/p', sessionId: 's', sourceAgent: 'codex', selectedAgent: 'claude', fork: true,
    })).toEqual({ ok: false, detail: 'a session can only be branched with its own agent' });
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
