import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DONE_SCRIPT, DONE_STYLE, connectDonePage, returnToLoom, setConnectRaiser, type ConnectKind } from '../src/connectreturn.ts';
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
    const ok = connectDonePage({ service: 'Slack', ok: true, text: 'Slack connected as <ada>.' });
    expect(ok).toContain('<h1>Slack connected</h1>');
    expect(ok).toContain('&lt;ada&gt;');
    expect(ok).toContain('background:#17171b');
    expect(ok).toContain('window.close()');
    expect(ok).not.toMatch(/\b(src|href)=["']https?:/);
    const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    expect(ok).toContain(`script-src ${sha(DONE_SCRIPT)}`);
    expect(ok).toContain(`style-src ${sha(DONE_STYLE)}`);
    const bad = connectDonePage({ service: 'Gmail', ok: false, text: 'Expired.' });
    expect(bad).toContain('<h1>Gmail not connected</h1>');
    expect(bad).not.toContain('<script>');
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
});
