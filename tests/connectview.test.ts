import { describe, expect, it } from 'vitest';
import { BRAND_ICONS_JS } from '../src/brandicons.ts';
import vm from 'node:vm';
import { CONNECT_VIEW_CSS, CONNECT_VIEW_JS } from '../src/connectview.ts';
import { WIZARD_VIEW_JS } from '../src/wizardview.ts';
import { SETTINGS_VIEW_JS } from '../src/settingsview.ts';
import { stepMeta } from '../src/wizard.ts';

// The Connect GitHub / Connect Gmail page code, run in a bare VM with a stub DOM.
// fetch never resolves, so nothing reaches a network; each test sets CN.gh / CN.gm.

function page() {
  const opened: string[] = [];
  const ctx: Record<string, any> = {
    window: { open: (u: string) => (opened.push(u), null), confirm: () => true },
    document: { readyState: 'complete', getElementById: () => null, addEventListener() {}, activeElement: null },
    navigator: {},
    fetch: () => new Promise(() => {}),
    setTimeout: () => 0,
    setInterval: () => 1,
    clearInterval() {},
    console,
    opened,
  };
  vm.createContext(ctx);
  vm.runInContext(BRAND_ICONS_JS + CONNECT_VIEW_JS, ctx);
  vm.runInContext(WIZARD_VIEW_JS, ctx);
  return ctx;
}
const K = (p: Record<string, any>) => p.CN_K_WZ;

describe('connect view source', () => {
  it('has no backslash, backtick or dollar-brace (it is spliced into a template string)', () => {
    for (const part of [CONNECT_VIEW_CSS, CONNECT_VIEW_JS]) {
      expect(part).not.toContain('\\');
      expect(part).not.toContain('`');
      expect(part).not.toContain('${');
    }
  });
  it('parses on its own and together with the wizard and settings scripts', () => {
    expect(() => new vm.Script(CONNECT_VIEW_JS)).not.toThrow();
    expect(() => new vm.Script(CONNECT_VIEW_JS + WIZARD_VIEW_JS + SETTINGS_VIEW_JS.split('__SX_KEYMAP__').join('[]'))).not.toThrow();
  });
  it('uses plain copy: no exclamation marks in what it shows', () => {
    const strings = CONNECT_VIEW_JS.match(/'[^']*'/g) ?? [];
    expect(strings.filter((s) => /[A-Za-z]!/.test(s) && !s.includes('!=='))).toEqual([]);
  });
});

describe('the GitHub panel', () => {
  const states: [string, unknown, string[]][] = [
    ['checking', null, ['Checking']],
    ['missing with brew', { ok: true, state: 'missing', gh: null, brew: true, job: null }, ['Install with Homebrew', 'data-cn="ghinstall"']],
    ['missing without brew', { ok: true, state: 'missing', gh: null, brew: false, job: null }, ['https://cli.github.com']],
    ['installing', { ok: true, state: 'unknown', gh: null, brew: true, job: { id: 1, kind: 'install', state: 'running', log: ['==> Pouring gh'] } }, ['Installing gh with Homebrew', '==&gt; Pouring gh', 'data-cn="ghcancel"']],
    ['not signed in', { ok: true, state: 'unauth', gh: '/opt/homebrew/bin/gh', brew: true, job: null }, ['Connect GitHub', 'data-cn="ghlogin"']],
    ['starting', { ok: true, state: 'unknown', gh: '/x', job: { id: 2, kind: 'login', state: 'running', code: '', url: 'https://github.com/login/device', log: [] } }, ['Starting gh', 'Cancel']],
    ['code shown', { ok: true, state: 'unknown', gh: '/x', job: { id: 2, kind: 'login', state: 'running', code: 'AB12-CD34', url: 'https://github.com/login/device', log: [] } }, ['AB12-CD34', 'Copy code', 'github.com/login/device', 'Cancel']],
    ['signed in', { ok: true, state: 'ok', login: 'octo-cat', gh: '/x', job: null }, ['Found an existing gh sign-in as <b>octo-cat</b>', 'Use a different account']],
  ];
  for (const [name, st, want] of states) {
    it(`renders ${name}`, () => {
      const p = page();
      p.CN.gh = st;
      const h = p.cnGhHtml(K(p));
      for (const w of want) expect(h).toContain(w);
    });
  }
  it('a gh sign-in Loom found says so, and offers a different account through the device flow with again', () => {
    const p = page();
    p.CN.gh = { ok: true, state: 'ok', login: 'octo-cat', gh: '/x', job: null, origin: 'found' };
    const h = p.cnGhHtml(K(p));
    expect(h).toContain('Found an existing gh sign-in as <b>octo-cat</b>.');
    expect(h).not.toContain('Connected through Loom');
    expect(h).toMatch(/data-cn="ghagainyes">Use a different account/);
    expect(h).toContain('GitHub account');
    expect(p.cnGhView(p.CN.gh).pill).toEqual(['ok', 'Found gh sign-in as octo-cat']);
    // Loom ran the sign-in: then, and only then, it says connected.
    p.CN.gh = { ...p.CN.gh, origin: 'loom' };
    expect(p.cnGhHtml(K(p))).toContain('Connected through Loom as <b>octo-cat</b>.');
    expect(p.cnGhView(p.CN.gh).pill).toEqual(['ok', 'Connected as octo-cat']);
  });
  it('opens the device page once the code shows', () => {
    const p = page();
    p.CN.gh = { ok: true, job: { id: 7, kind: 'login', state: 'running', code: 'AB12-CD34', url: 'https://github.com/login/device' } };
    p.cnGhTick(() => {});
    p.cnGhTick(() => {});
    expect(p.opened).toEqual(['https://github.com/login/device']);
  });
  it('words a failed, cancelled and finished login', () => {
    const p = page();
    p.cnGhEnded({ kind: 'login', state: 'error', error: 'expired' });
    expect(p.CN.ghMsg.text).toBe('The GitHub sign-in did not finish: expired');
    p.cnGhEnded({ kind: 'login', state: 'cancelled' });
    expect(p.CN.ghMsg.text).toContain('Nothing changed');
    p.cnGhEnded({ kind: 'install', state: 'ok' });
    expect(p.CN.ghMsg.text).toContain('gh is installed');
  });
});

describe('the Gmail panel', () => {
  const two = [
    { email: 'alex@example.com', label: 'alex@example.com', isDefault: true, reconnect: null },
    { email: 'alex@work.example.com', label: 'work', isDefault: false, reconnect: 'invalid_grant' },
  ];
  it('without a client asks for one and keeps Connect disabled', () => {
    const p = page();
    p.CN.gm = { ok: true, clientId: null, accounts: [], route: null };
    const h = p.cnGmHtml(K(p), { fields: true });
    expect(h).toContain('id="cn-gcid"');
    expect(h).toContain('How to create the Google client');
    expect(h).toContain('Desktop app');
    expect(h).toContain('hasn’t verified this app');
    expect(h).toMatch(/data-cn="gmconnect" disabled/);
    expect(p.cnGmView(p.CN.gm).kind).toBe('noclient');
  });
  it('with a client offers Connect Gmail; with the CLI route says so', () => {
    const p = page();
    p.CN.gm = { ok: true, clientId: 'x.apps.googleusercontent.com', accounts: [], route: null };
    expect(p.cnGmHtml(K(p))).toMatch(/data-cn="gmconnect">(<svg[^>]*>.*?<\/svg>)?Connect Gmail/);
    expect(p.cnGmView(p.CN.gm).kind).toBe('ready');
    p.CN.gm = { ok: true, clientId: null, accounts: [], route: 'cli', cli: '/Users/x/.claude/tools/gmail/gmail.mjs', cliDisplay: '~/.claude/tools/gmail/gmail.mjs' };
    let h = p.cnGmHtml(K(p));
    expect(h).toContain('Found an email CLI at <code>~/.claude/tools/gmail/gmail.mjs</code>.');
    expect(h).toContain('Loom did not set it up.');
    expect(h).not.toContain('Connect Gmail directly instead'); // no Google client yet
    expect(h).toContain('To connect Gmail directly instead, add a Google client below.');
    expect(p.cnGmView(p.CN.gm).pill[1]).toBe('Found an email CLI');
    p.CN.gm = { ...p.CN.gm, clientId: 'x.apps.googleusercontent.com' };
    h = p.cnGmHtml(K(p));
    expect(h).toMatch(/data-cn="gmconnect">(<svg[^>]*>.*?<\/svg>)?Connect Gmail directly instead/);
  });
  it('lists accounts with labels, default, reconnect and disconnect', () => {
    const p = page();
    p.CN.gm = { ok: true, clientId: 'x.apps.googleusercontent.com', accounts: two, route: 'gmail' };
    const h = p.cnGmHtml(K(p));
    expect(h).toContain('alex@work.example.com');
    expect(h).toContain('data-cn-label="alex@work.example.com"');
    expect(h).toContain('value="work"');
    expect(h).toContain('Default');
    expect(h).toContain('data-cn="gmdefault" data-arg="alex@work.example.com"');
    expect(h).toContain('data-cn="gmreconnect" data-arg="alex@work.example.com"');
    expect(h).toContain('data-cn="gmdisc"');
    expect(h).toContain('Add another account');
    expect(h).toContain('Gmail connected through Loom as <b>alex@example.com, alex@work.example.com</b>.');
    expect(h).toContain('How Loom sends email');
    expect(p.cnGmView(p.CN.gm)).toMatchObject({ kind: 'reconnect', pill: ['warn', 'An account needs reconnecting'] });
  });
  it('shows the wait while Google is open', () => {
    const p = page();
    p.CN.gm = { ok: true, clientId: 'x.apps.googleusercontent.com', accounts: [], route: null };
    p.CN.gmO = { state: 's', url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' };
    const h = p.cnGmHtml(K(p));
    expect(h).toContain('Waiting for you to approve in Google');
    expect(h).toContain('data-cn="gmcancel"');
  });
});

describe('the wizard Connections step', () => {
  it('is the old Slack step, retitled, still optional and skippable', () => {
    expect(stepMeta('slack')).toMatchObject({ title: 'Connections', optional: true, skippable: true });
  });
  it('renders Slack, GitHub and Gmail side by side with live status, in every state', () => {
    const p = page();
    p.WZ.v = { current: 'slack' };
    p.WZ.S = { slackChoice: 'direct', readonly: false };
    const c = { innerHTML: '' };
    // Nothing loaded yet: every card says Checking.
    p.WZ_STEPS.slack(c);
    expect((c.innerHTML.match(/data-wz-cntab=/g) ?? []).length).toBe(3);
    for (const name of ['Slack', 'GitHub', 'Gmail']) expect(c.innerHTML).toMatch(new RegExp('<b class="cn-tb">(<svg[^>]*>.*?</svg>)?' + name + '</b>'));
    expect((c.innerHTML.match(/Checking/g) ?? []).length).toBe(3);
    expect(c.innerHTML).toContain('id="wz-slack"');
    // Loaded: each card carries its own state.
    p.WZ.slack = { connected: true, mode: 'direct', origin: 'connect', identity: { team: 'Acme' } };
    p.CN.gh = { ok: true, state: 'unauth', gh: '/x', job: null };
    p.CN.gm = { ok: true, clientId: null, accounts: [{ email: 'alex@example.com', label: 'alex@example.com', isDefault: true }], route: 'gmail' };
    const tabs = p.wzConnTabsHtml();
    expect(tabs).toContain('Connected to Acme');
    expect(tabs).toContain('Not signed in');
    expect(tabs).toContain('Connected as alex@example.com');
    // A token Loom did not connect says it was found, not connected.
    expect(p.wzConnTabsHtml.call(null) && (p.WZ.slack.origin = 'earlier', p.wzConnTabsHtml())).toContain('Found a token for Acme');
    p.WZ.slack.origin = 'pasted';
    expect(p.wzConnTabsHtml()).toContain('Pasted token for Acme');
    p.WZ.slack.origin = 'connect';
    // Each tab is a section: name and icon, a status line, then its options nested under it.
    p.WZ.cnTab = 'slack';
    p.WZ_STEPS.slack(c);
    expect(c.innerHTML).toContain('<section class="cn-panel"');
    // Slack's modes sit inside the Slack section, under "How Loom uses Slack", as a radio group.
    expect(p.wzSlackStatus()).toContain('Connected through Connect Slack');
    p.WZ.slack.origin = 'earlier';
    expect(p.wzSlackStatus()).toContain('Found a Slack token stored earlier');
    p.WZ.slack.origin = 'connect';
    p.WZ.cnTab = 'github';
    p.WZ_STEPS.slack(c);
    expect(c.innerHTML).toContain('data-cn="ghlogin"');
    p.WZ.cnTab = 'gmail';
    p.WZ_STEPS.slack(c);
    expect(c.innerHTML).toContain('id="cn-gcid"');
    p.WZ.slack = { mode: 'off', reconnect: 'invalid_refresh_token' };
    p.CN.gh = { ok: true, state: 'missing', gh: null, brew: false, job: null };
    p.CN.gm = null;
    const t2 = p.wzConnTabsHtml();
    expect(t2).toContain('Reconnect Slack');
    expect(t2).toContain('gh not installed');
    expect(t2).toContain('Checking');
  });
});
