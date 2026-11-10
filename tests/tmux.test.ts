import { afterEach, describe, expect, it } from 'vitest';
import { configureTmuxSocket, isViewSession, paneHome, tmuxArgs, tmuxSocket } from '../src/tmux.ts';

describe('tmux runner', () => {
  const env = process.env.LOOM_TMUX_SOCKET;
  afterEach(() => {
    if (env === undefined) delete process.env.LOOM_TMUX_SOCKET;
    else process.env.LOOM_TMUX_SOCKET = env;
    configureTmuxSocket(null);
  });

  it('adds nothing on the default socket, even for a call that starts a server', () => {
    expect(tmuxArgs(['list-panes', '-a'], { socket: 'default' })).toEqual(['list-panes', '-a']);
    expect(tmuxArgs(['new-session', '-d', '-s', 'x'], { socket: 'default', startsServer: true, config: '/c.conf' }))
      .toEqual(['new-session', '-d', '-s', 'x']);
  });

  it('adds -L on any other socket, and -f only when the call may start the server', () => {
    expect(tmuxArgs(['list-panes', '-a'], { socket: 'loom', config: '/c.conf' })).toEqual(['-L', 'loom', 'list-panes', '-a']);
    expect(tmuxArgs(['new-session', '-d'], { socket: 'loom', startsServer: true, config: '/c.conf' }))
      .toEqual(['-L', 'loom', '-f', '/c.conf', 'new-session', '-d']);
    expect(tmuxArgs(['new-session', '-d'], { socket: 'loom', startsServer: true, config: null })).toEqual(['-L', 'loom', 'new-session', '-d']);
  });

  it('resolves the socket: env, then the stored setting, then default', () => {
    delete process.env.LOOM_TMUX_SOCKET;
    expect(tmuxSocket()).toBe('default');
    expect(tmuxArgs(['ls'])).toEqual(['ls']);
    configureTmuxSocket('loom');
    expect(tmuxSocket()).toBe('loom');
    expect(tmuxArgs(['ls'])).toEqual(['-L', 'loom', 'ls']);
    process.env.LOOM_TMUX_SOCKET = 'mine';
    expect(tmuxSocket()).toBe('mine');
  });

  it('ignores a malformed socket name rather than passing it to tmux', () => {
    delete process.env.LOOM_TMUX_SOCKET;
    configureTmuxSocket('../../etc -x');
    expect(tmuxSocket()).toBe('default');
    process.env.LOOM_TMUX_SOCKET = 'a b';
    expect(tmuxSocket()).toBe('default');
  });

  it('recognises embedded-terminal view sessions', () => {
    expect(isViewSession('loom-view-1a2b3c')).toBe(true);
    expect(isViewSession('loom-tp-2')).toBe(false);
    expect(isViewSession('')).toBe(false);
    expect(isViewSession(undefined)).toBe(false);
  });
});

describe('paneHome', () => {
  it("is the pane's own session and window, skipping the views that repeat it", () => {
    const out = ['%1084\tloom-view-0de2\t@1039\t7', '%1084\tloom-managed\t@1039\t7', '%899\tloom-managed\t@854\t2'].join('\n');
    expect(paneHome('%1084', () => out)).toEqual({ session: 'loom-managed', window: '@1039', windowIndex: '7' });
    expect(paneHome('%5', () => out)).toBeNull();
    expect(paneHome('%1084', () => '%1084\tloom-view-x\t@1\t1')).toBeNull();
    expect(paneHome('%1', () => { throw new Error('no server'); })).toBeNull();
  });
});
