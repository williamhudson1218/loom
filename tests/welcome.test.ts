import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import { showWelcome } from '../src/welcome.ts';
import { WELCOME_VIEW_CSS, WELCOME_VIEW_HTML, WELCOME_VIEW_JS } from '../src/welcomeview.ts';
import { renderDashboard } from '../src/dashboard.ts';

describe('showWelcome', () => {
  it('a first run shows it', () => {
    expect(showWelcome({ setupShow: true, seenAt: 0 })).toBe(true);
  });
  it('once Enter was pressed, it is skipped', () => {
    expect(showWelcome({ setupShow: true, seenAt: 1_700_000_000_000 })).toBe(false);
  });
  it('a finished or migrated setup skips it, seen or not', () => {
    expect(showWelcome({ setupShow: false, seenAt: 0 })).toBe(false);
    expect(showWelcome({ setupShow: false, seenAt: 5 })).toBe(false);
  });
  it('a replay from Settings shows it whatever the state', () => {
    expect(showWelcome({ setupShow: false, seenAt: 5, replay: true })).toBe(true);
    expect(showWelcome({ setupShow: true, seenAt: 0, replay: true })).toBe(true);
  });
  it('a bad stored time counts as never seen', () => {
    expect(showWelcome({ setupShow: true, seenAt: Number.NaN })).toBe(true);
  });
});

describe('welcome page script', () => {
  it('has no backtick, dollar-brace or backslash (spliced into template strings)', () => {
    for (const s of [WELCOME_VIEW_CSS, WELCOME_VIEW_HTML, WELCOME_VIEW_JS]) {
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
      expect(s).not.toContain('\\');
    }
  });
  it('parses on its own and inside the dashboard', () => {
    expect(() => new vm.Script(WELCOME_VIEW_JS)).not.toThrow();
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('id="lw"');
    expect(html).toContain('function showWelcome(');
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1])).not.toThrow();
  });
  it('loads nothing from the network', () => {
    for (const s of [WELCOME_VIEW_CSS, WELCOME_VIEW_HTML, WELCOME_VIEW_JS]) expect(s.replace(/xmlns="[^"]*"/g, '')).not.toMatch(/https?:/);
  });
  it('uses the shipped logo strokes', () => {
    const icon = fs.readFileSync(new URL('../app/assets/icon.svg', import.meta.url), 'utf8');
    for (const d of icon.matchAll(/ d="([^"]+)"/g)) expect(WELCOME_VIEW_HTML).toContain(d[1]);
  });
  it('says what Loom is, plainly', () => {
    expect(WELCOME_VIEW_HTML).toContain('Claude Code meets Slack, GitHub and Gmail.');
    expect(WELCOME_VIEW_HTML).toContain('Every thread, in one loom.');
    expect(WELCOME_VIEW_HTML.replace(/<[^>]*>/g, '')).not.toContain('!');
  });
  it('stops its loop and drops its listeners on Enter', () => {
    // The sky is the shared renderer (tests/skyview.test.ts covers its lifecycle).
    expect(WELCOME_VIEW_JS).toContain("loomSky(document.getElementById('lw-sky')");
    expect(WELCOME_VIEW_JS).toContain('function lwHalt() { if (LW.sky) { LW.sky.stop(); LW.sky = null; } }');
    expect(WELCOME_VIEW_JS).toMatch(/function lwEnter\(\)[\s\S]*lwHalt\(\); lwOffAll\(\);/);
    expect(WELCOME_VIEW_JS).not.toContain('requestAnimationFrame');
    expect(WELCOME_VIEW_JS).toContain('/api/wizard/welcome');
  });
});

describe('first paint on a first launch', () => {
  const first = renderDashboard([], Date.now(), {}, 'claude', [], [], '', null, [], { welcome: true });
  const later = renderDashboard([], Date.now(), {}, 'claude');

  it('is served with the welcome screen open, ahead of the board markup', () => {
    expect(first).toMatch(/<html lang="en" class="lw-first">/);
    const lw = first.indexOf('<div id="lw" class="open run"');
    expect(lw).toBeGreaterThan(-1);
    expect(lw).toBeLessThan(first.indexOf('<header>'));
    expect(first.match(/id="lw"/g)).toHaveLength(1);
    expect(first).toMatch(/<div id="lw" class="open run"[^>]*aria-hidden="false"/);
  });

  it('hides everything but the welcome screen and the wizard before any script runs', () => {
    const head = first.slice(0, first.indexOf('</head>'));
    // The rule is in the head's first style block, so it applies from the first frame.
    expect(head.indexOf('html.lw-first body > :not(#lw):not(#wz)')).toBeLessThan(head.indexOf(':root { color-scheme'));
    expect(head).toContain('visibility:hidden');
  });

  it('a later launch is the plain board with the welcome screen closed', () => {
    expect(later).not.toContain('class="lw-first"');
    expect(later).toMatch(/<div id="lw" role="dialog"[^>]*aria-hidden="true"/);
    expect(later.match(/id="lw"/g)).toHaveLength(1);
  });

  it('Enter lifts the gate (lwReveal) and the boot path starts the screen without waiting on the wizard view', () => {
    expect(WELCOME_VIEW_JS).toContain("function lwReveal() { document.documentElement.classList.remove('lw-first'); }");
    expect(first).toContain("var pre = document.documentElement.classList.contains('lw-first');");
    expect(first).toContain('if (pre && typeof showWelcome === ');
  });
});
