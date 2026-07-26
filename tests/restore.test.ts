import { describe, it, expect } from 'vitest';
import { restore } from '../src/restore.ts';
import { captureLayoutFrom, type Layout } from '../src/snapshot.ts';
import { agentSessionKey, liveSessionsFrom, type TmuxPane } from '../src/placements.ts';

const layout: Layout = {
  taken_at: 0,
  sessions: [
    {
      name: 'taxpilot',
      windows: [
        {
          window_index: '1',
          window_layout: 'aec1,215x55,0,0[215x25,0,0,8,215x29,0,26,9]',
          panes: [
            { pane_index: '0', cwd: '/work', command: 'zsh', full_command: '', title: '', kind: 'claude', session_id: 'sess-1' },
            { pane_index: '1', cwd: '/work', command: 'nvim', full_command: '', title: '', kind: 'nvim' },
            { pane_index: '2', cwd: '/work', command: 'node', full_command: 'node server.js', title: '', kind: 'other' },
          ],
        },
      ],
    },
  ],
};

const codexLayout: Layout = {
  taken_at: 0,
  sessions: [{
    name: 'codex-work',
    windows: [{
      window_index: '1',
      window_layout: '',
      panes: [{ pane_index: '0', cwd: '/work', command: 'zsh', full_command: '', title: '', kind: 'claude', agent: 'codex', session_id: 'codex-session' }],
    }],
  }],
};

describe('restore (dry-run)', () => {
  it('emits new-session, geometry, and per-kind launch commands', () => {
    const r = restore({ dryRun: true, layout, existing: new Set() });
    const log = r.log.join('\n');
    expect(r.restored).toEqual(['taxpilot']);
    expect(log).toContain('tmux new-session -d -s taxpilot');
    expect(log).toContain('select-layout -t taxpilot ' /* geometry follows */);
    expect(log).toContain('aec1,215x55'); // exact captured geometry replayed
    expect(log).toContain('claude --resume'); // claude pane resumed
    expect(log).toContain('nvim'); // nvim relaunched
    expect(log).toContain('node server.js'); // other pre-typed
    // claude + nvim auto-run (Enter); the "other" command is pre-typed only.
    expect(log.match(/send-keys -t \S+ Enter/g)?.length).toBe(2);
  });

  it('skips sessions that already exist', () => {
    const r = restore({ dryRun: true, layout, existing: new Set(['taxpilot']) });
    expect(r.restored).toEqual([]);
    expect(r.skipped).toEqual(['taxpilot']);
  });

  it('restores Codex panes with codex resume', () => {
    expect(restore({ dryRun: true, layout: codexLayout, existing: new Set() }).log.join('\n')).toContain('codex resume');
  });

  it('snapshots a recorded Codex launch and restores its native session', () => {
    const pane: TmuxPane = { pane_id: '%9', tmux_session: 'loom-work', window_index: '0', pane_index: '0', pane_pid: '9', command: 'codex', cwd: '/work', left: 0, top: 0, title: '' };
    const placements = new Map([
      [agentSessionKey('codex', 'codex-session'), { agent: 'codex' as const, session_id: 'codex-session', pane_id: '%9', tmux_session: 'loom-work', window_index: '0', pane_index: '0', cwd: '/work', ts: 1 }],
    ]);
    const live = liveSessionsFrom([pane], new Map([['%9', 'codex']]), placements);
    const snap = captureLayoutFrom({ now: 0, panes: [pane], agentPanes: new Map([['%9', 'codex']]), live });

    expect(snap.sessions[0].windows[0].panes[0]).toMatchObject({ agent: 'codex', session_id: 'codex-session' });
    expect(restore({ dryRun: true, layout: snap, existing: new Set() }).log.join('\n')).toContain('codex resume');
  });

  it('restores every session when no prefix is given', () => {
    const mixed: Layout = { taken_at: 0, sessions: [{ name: 'scratch', windows: [] }, { name: 'loom-work', windows: [] }] };
    const r = restore({ dryRun: true, layout: mixed, existing: new Set() });
    expect(r.restored).toEqual(['scratch', 'loom-work']);
  });

  it('restores only prefix-matched sessions when a prefix is given', () => {
    const mixed: Layout = { taken_at: 0, sessions: [{ name: 'scratch', windows: [] }, { name: 'loom-work', windows: [] }] };
    const r = restore({ dryRun: true, layout: mixed, existing: new Set(), prefix: 'loom-' });
    expect(r.restored).toEqual(['loom-work']);
  });
});
