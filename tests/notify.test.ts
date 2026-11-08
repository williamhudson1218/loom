import { describe, it, expect, afterEach } from 'vitest';
import { notifyUser, setAppNotifier } from '../src/notify.ts';
import { renderDashboard } from '../src/dashboard.ts';

afterEach(() => setAppNotifier(null));

describe('notifyUser', () => {
  it('uses the app notifier with the target and sound when one is registered', () => {
    const got: unknown[] = [];
    setAppNotifier((n) => got.push(n));
    notifyUser({ title: 'T', body: 'B', target: { agent: 'claude', sid: 's1' } }, { sound: 'Hero' });
    expect(got).toEqual([{ title: 'T', body: 'B', target: { agent: 'claude', sid: 's1' }, sound: 'Hero' }]);
  });

  it('falls back to osascript without an app notifier, silent when sound is off', () => {
    const calls: string[][] = [];
    const run = ((cmd: string, args: string[]) => calls.push([cmd, ...args])) as never;
    notifyUser({ title: 'T', body: 'B' }, { sound: 'off', run });
    expect(calls).toEqual([['osascript', '-e', 'display notification "B" with title "T"']]);
  });

  it('falls back when the app notifier throws', () => {
    const calls: string[][] = [];
    setAppNotifier(() => { throw new Error('unsupported'); });
    notifyUser({ title: 'T', body: 'B' }, { sound: 'system', run: ((c: string, a: string[]) => calls.push([c, ...a])) as never });
    expect(calls).toHaveLength(1);
  });
});

describe('window.loomOpenChat', () => {
  const load = () => {
    const html = renderDashboard([], Date.now(), {}, 'claude', [], [], 'tok');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    const src = scripts.find((s) => s.includes('window.loomOpenChat='))!;
    const a = src.indexOf('window.loomOpenChat=');
    const body = src.slice(a, src.indexOf('};', a) + 2);
    const log: string[] = [];
    const st = { chats: [{ agent: 'claude', session_id: 's1' }] as { agent: string; session_id: string }[] };
    const win: Record<string, unknown> = {};
    const q = { value: 'stale filter' };
    const run = new Function(
      'window', 'DATA', 'toast', 'refresh', '$', 'openInBoard', 'renderMain', 'TERM_TOKEN', 'document', 'setTimeout', 'log',
      `var onlyGroup='x',mtab='';${body}; return { open: window.loomOpenChat, state: () => ({ onlyGroup, mtab }) };`,
    );
    const api = run(
      win, st, (m: string) => log.push('toast:' + m), () => log.push('refresh'), () => q,
      (sid: string, agent: string) => log.push('open:' + agent + ':' + sid), () => log.push('render'), 'tok',
      { querySelector: () => null }, (f: () => void) => { f(); return 0; }, log,
    ) as { open: (a: string, s: string, r?: boolean) => void; state: () => { onlyGroup: string; mtab: string } };
    return { api, log, q, st };
  };

  it('opens a known chat on the board, clears filters and shows its terminal', () => {
    const { api, log, q } = load();
    api.open('claude', 's1');
    expect(log).toEqual(['open:claude:s1', 'render']);
    expect(q.value).toBe('');
    expect(api.state()).toEqual({ onlyGroup: null, mtab: 'terminal' });
  });

  it('retries once after a refresh for an unknown chat, then toasts', () => {
    const { api, log } = load();
    api.open('claude', 'nope');
    expect(log).toEqual(['refresh', 'toast:that chat is not on the board']);
  });
});
