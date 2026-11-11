import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DONE_SCRIPT, DONE_STYLE, connectDonePage, parseLoomUrl, raiseLoom, returnToLoom, returnUrl, setConnectRaiser, type ConnectKind } from '../src/connectreturn.ts';
import vm from 'node:vm';
import { raiseAfterGhJob } from '../src/routes/github.ts';

afterEach(() => setConnectRaiser(null));

describe('return to Loom after a sign-in', () => {
  it('calls the registered raiser with the service, and never throws', () => {
    const seen: ConnectKind[] = [];
    setConnectRaiser((k) => void seen.push(k));
    returnToLoom('slack');
    returnToLoom('google');
    expect(seen).toEqual(['slack', 'google']);
    setConnectRaiser(() => {
      throw new Error('no window');
    });
    expect(() => returnToLoom('github')).not.toThrow();
    setConnectRaiser(null);
    expect(() => returnToLoom('github')).not.toThrow();
  });

  it('the done page is dark, self-contained, closes itself only on success, and its CSP matches', () => {
    const ok = connectDonePage({ service: 'Slack', kind: 'slack', ok: true, text: 'Slack connected as <ada>.' });
    expect(ok).toContain('<h1>Slack connected</h1>');
    expect(ok).toContain('&lt;ada&gt;');
    expect(ok).toContain('background:#17171b');
    expect(ok).toContain('window.close()');
    expect(ok).not.toMatch(/\b(src|href)=["']https?:/);
    const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    expect(ok).toContain(`script-src ${sha(DONE_SCRIPT)}`);
    expect(ok).toContain(`style-src ${sha(DONE_STYLE)}`);
    const bad = connectDonePage({ service: 'Gmail', kind: 'google', ok: false, text: 'Expired.' });
    expect(bad).toContain('<h1>Gmail not connected</h1>');
    expect(bad).not.toContain('<script>');
    // A failed sign-in still offers the way back, but does not open it by itself.
    expect(bad).toContain('href="loom://connected/google">Return to Loom</a>');
    expect(bad).not.toContain('id="back"');
    expect(bad.replace('<!doctype', '')).not.toContain('!');
  });

  it('a finished GitHub login raises Loom; a failed or cancelled one and an install do not', () => {
    const seen: ConnectKind[] = [];
    setConnectRaiser((k) => void seen.push(k));
    raiseAfterGhJob({ kind: 'login', state: 'error' });
    raiseAfterGhJob({ kind: 'login', state: 'cancelled' });
    raiseAfterGhJob({ kind: 'install', state: 'ok' });
    expect(seen).toEqual([]);
    raiseAfterGhJob({ kind: 'login', state: 'ok' });
    expect(seen).toEqual(['github']);
  });

  it('the success page has a Return to Loom button and opens loom:// on load, then tries to close', () => {
    const ok = connectDonePage({ service: 'Slack', kind: 'slack', ok: true, text: 'Slack connected.' });
    expect(ok).toContain('<a class="btn" id="back" href="loom://connected/slack">Return to Loom</a>');
    const script = /<script>([\s\S]*?)<\/script>/.exec(ok)![1];
    const nav: string[] = [];
    let closed = 0;
    const timers: (() => void)[] = [];
    const location = { set href(u: string) { nav.push(u); } };
    vm.runInNewContext(script, {
      location,
      document: { getElementById: (id: string) => (id === 'back' ? { getAttribute: () => 'loom://connected/slack' } : null) },
      window: { close: () => void closed++ },
      setTimeout: (f: () => void) => void timers.push(f),
    });
    expect(nav).toEqual(['loom://connected/slack']);
    timers.forEach((f) => f());
    expect(closed).toBe(1);
  });

  it('parses loom:// URLs: the service, a bare one, and refuses other schemes', () => {
    expect(returnUrl('github')).toBe('loom://connected/github');
    expect(parseLoomUrl('loom://connected/slack')).toBe('slack');
    expect(parseLoomUrl('loom://connected/google')).toBe('google');
    expect(parseLoomUrl('loom://')).toBe('');
    expect(parseLoomUrl('loom://connected/evil')).toBe('');
    expect(parseLoomUrl('https://connected/slack')).toBeNull();
    expect(parseLoomUrl('not a url')).toBeNull();
  });
});

describe('raiseLoom (the main-process seam)', () => {
  function fake(opts: { minimized?: boolean; noWindow?: boolean } = {}) {
    const calls: string[] = [];
    const w = {
      isMinimized: () => !!opts.minimized,
      restore: () => void calls.push('restore'),
      show: () => void calls.push('show'),
      moveTop: () => void calls.push('moveTop'),
      focus: () => void calls.push('focus'),
    };
    const t = {
      window: () => (opts.noWindow ? null : w),
      createWindow: () => void calls.push('createWindow'),
      showApp: () => void calls.push('app.show'),
      focusApp: () => void calls.push('app.focus(steal)'),
    };
    return { calls, t };
  }

  it('un-hides the app, shows and focuses the window, then asks macOS to activate', () => {
    const { calls, t } = fake();
    raiseLoom(t);
    expect(calls).toEqual(['app.show', 'show', 'moveTop', 'focus', 'app.focus(steal)']);
  });

  it('restores a minimised window first, and creates one when it was destroyed', () => {
    const a = fake({ minimized: true });
    raiseLoom(a.t);
    expect(a.calls).toEqual(['app.show', 'restore', 'show', 'moveTop', 'focus', 'app.focus(steal)']);
    const b = fake({ noWindow: true });
    raiseLoom(b.t);
    expect(b.calls).toEqual(['app.show', 'createWindow', 'app.focus(steal)']);
  });

  it('a successful callback reaches the seam through the registered raiser, for Connect again too', () => {
    const { calls, t } = fake();
    setConnectRaiser(() => raiseLoom(t));
    returnToLoom('slack');
    returnToLoom('slack');
    expect(calls.filter((c) => c === 'app.focus(steal)')).toHaveLength(2);
  });
});
