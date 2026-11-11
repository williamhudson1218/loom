import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { appLog, diagnosticsText, installAppLog, redact, tailLog, type DiagEnv } from '../src/diagnostics.ts';
import { ERROR_VIEW_CSS, ERROR_VIEW_JS } from '../src/errorview.ts';
import { renderDashboard } from '../src/dashboard.ts';
import { ROUTES } from '../src/routes/index.ts';

const HOME = '/Users/somebody';
const env = (over: Partial<DiagEnv> = {}): DiagEnv => ({
  build: { version: '0.1.99', commit: 'abcdef0123456789', channel: 'release' },
  os: 'macOS 15.1 (24B83)',
  arch: 'arm64',
  claudeVersion: '2.1.322',
  log: ['2026-11-11T00:00:00.000Z info server listening on 4317'],
  home: HOME,
  now: new Date('2026-11-11T12:00:00Z'),
  ...over,
});

describe('redact', () => {
  it('removes tokens, emails and the home folder', () => {
    const raw = [
      'slack xoxb-1234567890-abcdefghijkl and xoxp-11-22-33-abcdef',
      'gh ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 and github_pat_11ABCDEFG0123456789_abcdefghijklmnop',
      'Authorization: Bearer abc.def.ghi-jkl_123456',
      'client_secret=GOCSPX-supersecretvalue1',
      '{"access_token":"ya29.a0AfH6SMBlongtokenvalue"}',
      'mail jane.doe@example.com',
      `path ${HOME}/dev/loom/src and /Users/other/x`,
    ].join('\n');
    const r = redact(raw, HOME);
    for (const leak of ['xoxb-', 'xoxp-11', 'ghp_', 'github_pat_', 'abc.def.ghi', 'GOCSPX', 'ya29.', 'jane.doe', '@example.com', '/Users/']) expect(r).not.toContain(leak);
    expect(r).toContain('~/dev/loom/src');
    expect(r).toContain('Bearer [redacted]');
  });
  it('leaves ordinary words alone', () => {
    expect(redact('the token expired; claude plugin marketplace add failed (exit 1)', HOME)).toBe('the token expired; claude plugin marketplace add failed (exit 1)');
  });
});

describe('diagnosticsText', () => {
  it('carries what failed, the output, versions, arch, claude and the log', () => {
    const t = diagnosticsText({ what: 'Install the Loom plugin', message: 'Invalid URL', output: `$ claude plugin marketplace add ${HOME}/.loom/plugin-marketplace\nexit 1` }, env());
    expect(t).toContain('Loom error: Install the Loom plugin');
    expect(t).toContain('Message: Invalid URL');
    expect(t).toContain('$ claude plugin marketplace add ~/.loom/plugin-marketplace');
    expect(t).toContain('Loom: 0.1.99 (abcdef012345), release');
    expect(t).toContain('OS: macOS 15.1 (24B83)');
    expect(t).toContain('Arch: arm64');
    expect(t).toContain('Claude Code: 2.1.322');
    expect(t).toContain('server listening on 4317');
    expect(t).not.toContain('/Users/');
    expect(t).not.toContain('!');
  });
  it('without an error it is plain diagnostics', () => {
    const t = diagnosticsText({}, env({ claudeVersion: null, log: [] }));
    expect(t.startsWith('Loom diagnostics')).toBe(true);
    expect(t).not.toContain('## What failed');
    expect(t).toContain('Claude Code: unknown');
    expect(t).toContain('(empty)');
  });
  it('redacts secrets that reach it through the log', () => {
    const t = diagnosticsText({}, env({ log: ['error slack said invalid_auth for xoxb-999-888-abcdefabcdef'] }));
    expect(t).not.toContain('xoxb-999');
  });
});

describe('the Loom log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-applog-'));
  afterEach(() => {});
  it('tees console output to the file and tails it', () => {
    const file = path.join(dir, 'loom.log');
    installAppLog(file);
    for (let i = 0; i < 150; i++) appLog('info', `line ${i}`);
    console.warn('a warning from the console');
    const tail = tailLog(100, file);
    expect(tail).toHaveLength(100);
    expect(tail[tail.length - 1]).toContain('warn a warning from the console');
    expect(tail[0]).toContain('line 51');
  });
});

describe('error component', () => {
  it('is safe to splice and parses', () => {
    for (const s of [ERROR_VIEW_CSS, ERROR_VIEW_JS]) {
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
      expect(s).not.toContain('\\');
    }
    expect(() => new vm.Script(ERROR_VIEW_JS)).not.toThrow();
  });

  it('renders the card with Copy details and posts the error to /api/diagnostics', async () => {
    const posted: any[] = [];
    const listeners: any[] = [];
    const ctx: any = {
      document: { addEventListener: (_t: string, fn: any) => listeners.push(fn), createElement: () => ({}) },
      navigator: { clipboard: { writeText: async (t: string) => { ctx.copied = t; } }, userAgent: 'test' },
      fetch: async (url: string, o: any) => { posted.push({ url, body: JSON.parse(o.body) }); return { json: async () => ({ ok: true, text: 'BUNDLE' }) }; },
      setTimeout: () => 0,
      window: {} as any,
      JSON, String, Array, Promise,
    };
    vm.createContext(ctx);
    vm.runInContext(ERROR_VIEW_JS, ctx);
    const html = ctx.loomErrorHtml({ what: 'Install the Loom plugin', message: 'Invalid <URL>', output: [{ display: 'claude plugin install loom@loom-local', code: 1, output: 'boom' }] });
    expect(html).toContain('Copy details');
    expect(html).toContain('Invalid &lt;URL&gt;');
    expect(html).toContain('claude plugin install loom@loom-local');
    const id = /data-lerr="([^"]+)"/.exec(html)![1];
    const btn: any = { textContent: 'Copy details', disabled: false, classList: { add() {}, remove() {} }, getAttribute: () => id, closest: () => btn };
    listeners[0]({ target: btn, preventDefault() {}, stopPropagation() {} });
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(posted[0].url).toBe('/api/diagnostics');
    expect(posted[0].body.what).toBe('Install the Loom plugin');
    expect(posted[0].body.message).toBe('Invalid <URL>');
    expect(posted[0].body.output).toContain('exit 1');
    expect(ctx.copied).toBe('BUNDLE');
    expect(btn.textContent).toBe('Copied');
  });

  it('is on the page, red toasts carry it, and Settings has About > Copy diagnostics', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('function loomErrorHtml(');
    expect(html).toContain('function toastIsErr(');
    expect(html).toContain("id:'about',label:'About'");
    expect(html).toContain("sxBtn('aboutdiag','Copy diagnostics'");
    // The error component loads ahead of every view that calls it.
    expect(html.indexOf('function loomErrorHtml(')).toBeLessThan(html.indexOf('function wzErrHtml('));
  });

  it('/api/diagnostics is a gated write route', () => {
    const r = ROUTES.find((x) => x.path === '/api/diagnostics');
    expect(r?.method).toBe('POST');
    expect(r?.kind).toBe('browser');
  });
});
