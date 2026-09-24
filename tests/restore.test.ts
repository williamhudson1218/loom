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

  // The tab, not the session, is what dies in the common case: a session that
  // survived detached still needs one, and the ones that already have a client
  // must be left alone or restore doubles the workspace.
  it('asks for a tab for every session without a client, restored or not', () => {
    const mixed: Layout = {
      taken_at: 0,
      sessions: [{ name: 'loom-a', windows: [] }, { name: 'loom-b', windows: [] }, { name: 'loom-c', windows: [] }],
    };
    const r = restore({
      dryRun: true, layout: mixed, prefix: 'loom-',
      existing: new Set(['loom-b', 'loom-c']),
      attached: new Set(['loom-c']),
    });
    expect(r.restored).toEqual(['loom-a']);
    expect(r.attach).toEqual(['loom-a', 'loom-b']); // loom-c already has its tab
  });

  it('replays the workspace in its remembered tab order, not alphabetically', () => {
    const mixed: Layout = {
      taken_at: 0,
      ghostty_tabs: ['loom-c', 'loom-a', 'loom-b'],
      sessions: [{ name: 'loom-a', windows: [] }, { name: 'loom-b', windows: [] }, { name: 'loom-c', windows: [] }],
    };
    const r = restore({ dryRun: true, layout: mixed, prefix: 'loom-', existing: new Set(), attached: new Set() });
    expect(r.attach).toEqual(['loom-c', 'loom-a', 'loom-b']);
  });

  it('suppresses the resume-from-summary prompt on restored Claude panes', () => {
    const log = restore({ dryRun: true, layout, existing: new Set(), attached: new Set() }).log.join('\n');
    expect(log).toContain('CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=99999999');
  });

  it('restores only prefix-matched sessions when a prefix is given', () => {
    const mixed: Layout = { taken_at: 0, sessions: [{ name: 'scratch', windows: [] }, { name: 'loom-work', windows: [] }] };
    const r = restore({ dryRun: true, layout: mixed, existing: new Set(), prefix: 'loom-' });
    expect(r.restored).toEqual(['loom-work']);
  });
});

describe('restore window grouping', () => {
  const sessions = [{ name: 'loom-a', windows: [] }, { name: 'loom-b', windows: [] }, { name: 'loom-c', windows: [] }];

  it('hands back the saved Ghostty windows alongside the attach order', () => {
    const l: Layout = {
      taken_at: 0,
      ghostty_tabs: ['loom-c', 'loom-a', 'loom-b'],
      ghostty_windows: [{ tabs: ['loom-c'], bounds: { x: 0, y: 0, w: 10, h: 10 } }, { tabs: ['loom-a', 'loom-b'] }],
      sessions,
    };
    const r = restore({ dryRun: true, layout: l, prefix: 'loom-', existing: new Set(), attached: new Set() });
    expect(r.attach).toEqual(['loom-c', 'loom-a', 'loom-b']);
    expect(r.windows).toEqual(l.ghostty_windows);
  });

  it('treats a legacy flat snapshot as a single window', () => {
    const l: Layout = { taken_at: 0, ghostty_tabs: ['loom-b', 'loom-a'], sessions };
    const r = restore({ dryRun: true, layout: l, prefix: 'loom-', existing: new Set(), attached: new Set() });
    expect(r.windows).toEqual([{ tabs: ['loom-b', 'loom-a'] }]);
    expect(r.attach).toEqual(['loom-b', 'loom-a', 'loom-c']);
  });

  it('returns no windows when nothing about Ghostty was remembered', () => {
    const r = restore({ dryRun: true, layout: { taken_at: 0, sessions }, existing: new Set(), attached: new Set() });
    expect(r.windows).toEqual([]);
  });
});
