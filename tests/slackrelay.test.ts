import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { LOOM_SLACK_CLIENT_ID } from '../src/settingsSchema.ts';
import { SLACK_RELAY_URL, beginAuth, buildState, redirectFor, resetOAuthState, statePort, takeState } from '../src/slackoauth.ts';
import { buildSharedManifest } from '../src/slackmanifest.ts';

// The HTTPS relay for the built-in Slack app (site/slack-callback/index.html),
// run in a vm with a stub location and document. No browser, no Slack.

const html = fs.readFileSync(path.join(__dirname, '..', 'site', 'slack-callback', 'index.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)![1];
const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1];

function runRelay(search: string) {
  const replaced: string[] = [];
  const els: Record<string, { textContent: string; hidden: boolean; attrs: Record<string, string>; setAttribute(k: string, v: string): void }> = {};
  const el = (id: string) =>
    (els[id] ??= { textContent: '', hidden: id === 'fallback', attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const location = { search, replace: (u: string) => void replaced.push(u), set href(u: string) { replaced.push(u); } };
  vm.runInNewContext(script, { location, document: { getElementById: el }, URLSearchParams });
  return { replaced, els };
}

describe('Slack relay page', () => {
  it('forwards a valid port to 127.0.0.1 with the same code, state and error fields', () => {
    const { replaced, els } = runRelay('?code=abc.123&state=4319.Zz_-9');
    expect(replaced).toEqual(['http://127.0.0.1:4319/slack/callback?code=abc.123&state=4319.Zz_-9']);
    expect(els.link.attrs.href).toBe(replaced[0]);
    expect(els.fallback.hidden).toBe(false);
    const err = runRelay('?error=access_denied&error_description=no+thanks&state=4317.x');
    expect(err.replaced).toEqual(['http://127.0.0.1:4317/slack/callback?state=4317.x&error=access_denied&error_description=no+thanks']);
  });

  it('accepts both ends of 4317-4326', () => {
    expect(runRelay('?code=c&state=4317.a').replaced).toHaveLength(1);
    expect(runRelay('?code=c&state=4326.a').replaced).toHaveLength(1);
  });

  it.each([
    ['port 80', '?code=c&state=80.abc'],
    ['port 4327', '?code=c&state=4327.abc'],
    ['port 4316', '?code=c&state=4316.abc'],
    ['a non-numeric port', '?code=c&state=evil.abc'],
    ['a host in the state', '?code=c&state=evil.example:4317.abc'],
    ['a port with a sign', '?code=c&state=+4317.abc'],
    ['a fractional port', '?code=c&state=4317.5.abc'],
    ['no state', '?code=c'],
    ['nothing at all', ''],
  ])('refuses %s and never redirects', (_label, q) => {
    const { replaced, els } = runRelay(q);
    expect(replaced).toEqual([]);
    expect(els.fallback?.hidden ?? true).toBe(true);
    expect(els.msg.textContent).toMatch(/Start Connect Slack again/);
  });

  it('only ever redirects to 127.0.0.1 on the callback path, whatever else the query carries', () => {
    const tries = ['?state=4320.a&code=c&redirect=https://evil.example', '?state=4320.a&code=//evil.example', '?state=4320.a%2F%2Fevil.example&code=c', '?state=4320.a&next=http://x'];
    for (const q of tries) {
      for (const u of runRelay(q).replaced) {
        const url = new URL(u);
        expect(url.origin).toBe('http://127.0.0.1:4320');
        expect(url.pathname).toBe('/slack/callback');
        expect([...url.searchParams.keys()].every((k) => ['code', 'state', 'error', 'error_description'].includes(k))).toBe(true);
      }
    }
  });

  it('loads nothing external, and its CSP hashes match the inline script and style', () => {
    expect(html).not.toMatch(/\b(src|href)=["']https?:/);
    const sha = (s: string) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src ${sha(script)}`);
    expect(csp).toContain(`style-src ${sha(style)}`);
    expect(/<main>[\s\S]*<\/main>/.exec(html)![0]).not.toContain('!');
    expect(script).not.toMatch(/textContent = '[^']*!/);
  });
});

describe('relay state and redirect', () => {
  it('builds <port>.<random> and reads the port back only inside the range', () => {
    expect(buildState(4321, 'abc_-9')).toBe('4321.abc_-9');
    expect(statePort(buildState(4321))).toBe(4321);
    expect(statePort('4327.abc')).toBeNull();
    expect(statePort('80.abc')).toBeNull();
    expect(statePort('abcd.abc')).toBeNull();
    expect(statePort('4317.')).toBeNull();
    expect(statePort('4317.a.b')).toBeNull();
  });

  it('the built-in app uses the relay in the authorize URL and the stored flow (which the exchange sends)', () => {
    resetOAuthState();
    const { state, url } = beginAuth({ clientId: LOOM_SLACK_CLIENT_ID, port: 4318, scopes: ['users:read'], readonly: false });
    expect(state).toMatch(/^4318\.[A-Za-z0-9_-]{32}$/);
    expect(statePort(state)).toBe(4318);
    const authorizeRedirect = new URL(url).searchParams.get('redirect_uri');
    expect(authorizeRedirect).toBe(SLACK_RELAY_URL);
    expect(takeState(state)!.redirectUri).toBe(authorizeRedirect);
  });

  it('an app of your own keeps the direct localhost redirect', () => {
    expect(redirectFor('1111111111.2222222222', 4320)).toBe('http://localhost:4320/slack/callback');
    expect(redirectFor(LOOM_SLACK_CLIENT_ID, 4320)).toBe(SLACK_RELAY_URL);
  });

  it('the shared manifest lists only the HTTPS relay', () => {
    expect(buildSharedManifest({ port: 4317 }).oauth_config.redirect_urls).toEqual(['https://williamhudson1218.github.io/loom/slack-callback/']);
  });
});
