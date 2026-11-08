import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { TOUR_FIXTURE_JS } from '../src/tourfixture.ts';
import { TOUR_VIEW_CSS, TOUR_VIEW_HTML, TOUR_VIEW_JS } from '../src/tourview.ts';
import { renderDashboard } from '../src/dashboard.ts';

const load = () => {
  const ctx: any = {};
  vm.createContext(ctx);
  vm.runInContext(TOUR_FIXTURE_JS + '\nthis.tourFixture=tourFixture;', ctx);
  return ctx.tourFixture as (now: number, o: any) => any;
};

describe('tour page script rules', () => {
  it('has no backtick, dollar-brace or backslash (spliced into template strings)', () => {
    for (const s of [TOUR_FIXTURE_JS, TOUR_VIEW_JS, TOUR_VIEW_CSS, TOUR_VIEW_HTML]) {
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
      expect(s).not.toContain('\\');
    }
  });
  it('names no person, vendor or personal path', () => {
    for (const s of [TOUR_FIXTURE_JS, TOUR_VIEW_JS]) expect(s).not.toMatch(/Will|Tax Pilot|Superset|loom-tp|\/Users\//);
  });
  it('is spliced into the dashboard and the whole page script parses', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('function startTour(');
    expect(html).toContain('id="tour"');
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1])).not.toThrow();
  });
  it('is the entry point the wizard, settings and event all use', () => {
    expect(TOUR_VIEW_JS).toContain('window.startTour=startTour');
    expect(TOUR_VIEW_JS).toContain("'loom:start-tour'");
    expect(TOUR_VIEW_JS).toContain('/api/wizard/tour');
  });
  it('every stop says what the thing is for, and Slack stops are gated on Slack', () => {
    for (const w of ['so one list answers', 'needs you', 'Nothing reaches Slack until you press Send', 'one pull request']) expect(TOUR_VIEW_JS).toContain(w);
    expect(TOUR_VIEW_JS).toMatch(/id:'outbox',requires:TOUR\.slackOn/);
    expect(TOUR_VIEW_JS).toMatch(/id:'slack',requires:TOUR\.slackOn/);
  });
  it('refuses every write while it runs, and restores fetch on exit', () => {
    expect(TOUR_VIEW_JS).toContain("if(method!=='GET')return tourJson");
    expect(TOUR_VIEW_JS).toContain('window.fetch=TOUR.prevFetch');
  });
});

describe('tourFixture', () => {
  const fx = load();
  const now = 1_700_000_000_000;
  it('builds three chats, one draft, one thread and one ship line with Slack and Ship on', () => {
    const f = fx(now, { slack: true, ship: true });
    expect(f.chats).toHaveLength(3);
    expect(f.drafts).toHaveLength(1);
    expect(f.slackOwners).toEqual(['sample-1']);
    expect(f.ships).toHaveLength(1);
    expect(f.detail('sample-1').slack).toHaveLength(1);
    expect(f.shipDetail.totals.staged).toBe(3);
  });
  it('leaves out Slack and Ship things when they are off', () => {
    const f = fx(now, { slack: false, ship: false });
    expect(f.drafts).toEqual([]);
    expect(f.slackOwners).toEqual([]);
    expect(f.ships).toEqual([]);
    expect(f.detail('sample-1').slack).toEqual([]);
  });
  it('marks every chat as sample and never gives it a pane or a real path', () => {
    const f = fx(now, { slack: true, ship: true });
    for (const c of f.chats) { expect(c.session_id).toMatch(/^sample-/); expect(c.project_dir).toBe('/sample/example-app'); }
    for (const l of Object.values<any>(f.live)) expect(l.pane_id).toBe('');
    expect(f.detail('nope').ok).toBe(false);
  });
});
