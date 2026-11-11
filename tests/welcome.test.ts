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
    expect(WELCOME_VIEW_JS).toContain('cancelAnimationFrame');
    expect(WELCOME_VIEW_JS).toMatch(/function lwEnter\(\)[\s\S]*lwHalt\(\); lwOffAll\(\);/);
    expect(WELCOME_VIEW_JS).toContain("'visibilitychange'");
    expect(WELCOME_VIEW_JS).toContain('/api/wizard/welcome');
  });
});
