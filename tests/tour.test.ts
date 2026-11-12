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
    expect(TOUR_VIEW_JS).toContain('window.fetch=TOUR.origFetch');
  });
});

describe('tourFixture', () => {
  const fx = load();
  const now = 1_700_000_000_000;
  it('builds four chats (your turn, working, done, parked), a PR with checks, one draft, one thread and one ship line', () => {
    const f = fx(now, { slack: true, ship: true });
    expect(f.chats).toHaveLength(4);
    expect(f.parked).toEqual([expect.objectContaining({ session_id: 'sample-4', state: 'waiting' })]);
    expect(f.chatPr['claude:sample-1']).toBe('acme/web#412');
    expect(f.pipes['acme/web#412'].dots.map((d: any) => d.state)).toEqual(['pass', 'pass', 'running']);
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
    for (const c of f.chats) { expect(c.session_id).toMatch(/^sample-/); expect(c.project_dir).toBe('/sample/acme-web'); }
    for (const l of Object.values<any>(f.live)) expect(l.pane_id).toBe('');
    expect(f.detail('nope').ok).toBe(false);
  });
});

// ---- the tour's page logic, run against a stub page ------------------------------
// startTour sets TOUR.on and then calls tourBegin once its settings fetches land; the
// tests set TOUR.on and call tourBegin directly. The real DOM is exercised by the headless screenshot run; this drives tourBegin and
// tourEnd with every page global they touch stubbed, so the sample swap, the write
// guard and the restore paths are checked on every vitest run.
type Page = { ctx: any; calls: { method: string; url: string }[]; refreshes: () => number };
const page = (chats: any[], extra: Record<string, any> = {}): Page => {
  const calls: { method: string; url: string }[] = [];
  let refreshes = 0;
  const els = new Map<string, any>();
  const el = (k: string) => {
    if (!els.has(k)) els.set(k, {
      hidden: k === '#tour' || k === '#tourribbon', textContent: '', disabled: false, onclick: null, dataset: {}, innerHTML: '', style: {},
      offsetHeight: 160, classList: { add() {}, remove() {}, contains: () => false },
      getBoundingClientRect: () => ({ left: 10, top: 10, right: 60, bottom: 40, width: 50, height: 30 }),
      focus() {}, scrollIntoView() {}, closest: () => null,
    });
    return els.get(k);
  };
  const listeners: Record<string, Function[]> = {};
  const ctx: any = {
    Response, URL, Promise, JSON, Object, Math, Date, String, Array,
    location: { href: 'http://loom.test/', origin: 'http://loom.test' },
    innerWidth: 1440, innerHeight: 900,
    addEventListener: (t: string, f: Function) => { (listeners[t] ||= []).push(f); },
    removeEventListener: (t: string, f: Function) => { listeners[t] = (listeners[t] || []).filter((g) => g !== f); },
    dispatchEvent() {},
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 0,
    document: {
      querySelector: (s: string) => el(s), getElementById: (id: string) => el('#' + id),
      activeElement: null, contains: () => true, addEventListener() {},
    },
    fetch(input: any, init?: any) {
      // Like the native fetch: called as a method of another object (TOUR.prevFetch(...)) it throws.
      if (this && (this as any).DATA === undefined && (this as any).prevFetch !== undefined) throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      calls.push({ method: String(init?.method || 'GET').toUpperCase(), url: String(input) });
      return Promise.resolve(new Response(JSON.stringify({ chats: chats, live: {}, generatedAt: 1 }), { status: 200 }));
    },
    DATA: { chats, live: {}, drafts: [], slackOwners: [], slackCounts: {}, ships: [], parked: [], pipes: {}, chatPr: {}, slackStarts: [], slackMode: 'off' },
    tab: 'trees', sel: null, mtab: 'terminal', stateFilter: 'all', onlyGroup: null, shipFilter: null, shipOpen: true,
    outCollapsed: true, outRailKey: '', draftConfirm: null, draftArmDiscard: null,
    syncControls() {}, liveToggle() {}, chips() {}, render() {}, renderMain() {}, renderOutbox() {},
    selectChat(sid: string, agent: string) { ctx.sel = { sid, agent }; }, deselect() { ctx.sel = null; },
    closeCtx() {}, openCtx() {}, closeShipModal() {}, openShipModal() {},
    hasDrafts: (c: any) => ctx.DATA.drafts.some((d: any) => d.session_id === c.session_id),
    ownsSlack: (c: any) => ctx.DATA.slackOwners.indexOf(c.session_id) >= 0,
    draftsFor: (c: any) => ctx.DATA.drafts.filter((d: any) => d.session_id === c.session_id),
    railCollapsed: () => true, railDrafts: () => [],
    refresh() { refreshes++; return Promise.resolve(); },
    ...extra,
  };
  ctx.window = ctx;
  ctx.__key = (key: string) => (listeners.keydown || []).forEach((f) => f({ key, target: null, preventDefault() {}, stopPropagation() {} }));
  vm.createContext(ctx);
  vm.runInContext(TOUR_VIEW_JS, ctx);
  return { ctx, calls, refreshes: () => refreshes };
};
const realChat = { agent: 'claude', session_id: 'abc', title: 'Real chat', state: 'done', arch: false };
const run = (p: Page, js: string) => vm.runInContext(js, p.ctx);

describe('tour demo mode', () => {
  it('starts on sample data when there are no chats, with every stop and the banner', () => {
    const p = page([]);
    run(p, 'TOUR.on=true;tourBegin(0)');
    expect(run(p, 'TOUR.sample')).toBe(true);
    expect(run(p, 'DATA.chats.map(function(c){return c.session_id;})')).toEqual(['sample-1', 'sample-2', 'sample-3', 'sample-4']);
    expect(run(p, 'TOUR.order.map(function(i){return TOUR.stops[i].id;})')).toEqual(['filters', 'groups', 'tabs', 'outbox', 'ship', 'menu', 'slack', 'gear']);
    expect(p.ctx.document.querySelector('#tourribbon').hidden).toBe(false);
  });

  it('every stop opens and closes in demo mode, and has an anchor', () => {
    const p = page([]);
    run(p, 'TOUR.on=true;tourBegin(0)');
    for (let i = 0; i < 8; i++) {
      expect(() => run(p, 'tourShow(' + i + ')')).not.toThrow();
      expect(run(p, 'tourAnchors(TOUR.stops[TOUR.order[' + i + ']]).length')).toBeGreaterThan(0);
    }
  });

  it('every stop anchor is on the rendered page or in the row and Slack templates', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    for (const a of ['data-tour="filters"', 'data-tour="gear"', 'data-tour="outbox"', 'id="mtabs"', 'id="list"', 'id="shipmodal"', 'class="smbox"', 'data-tour="row"', 'data-tour="slack"'])
      expect(html).toContain(a);
  });

  it('calls no mutating endpoint and serves sample reads locally', async () => {
    const p = page([]);
    run(p, 'TOUR.on=true;tourBegin(0)');
    p.calls.length = 0;
    const f = p.ctx.window.fetch;
    for (const [u, m] of [['/api/outbox/sample-draft-1/send', 'POST'], ['/api/chats/rename', 'PUT'], ['/api/parked', 'DELETE'], ['/api/ship/run', 'POST']]) {
      const j = await (await f(u, { method: m })).json();
      expect(j.ok).toBe(false);
    }
    expect((await (await f('/api/detail?session=sample-1')).json()).ok).toBe(true);
    expect((await (await f('/api/transcript?session=sample-2')).json()).ok).toBe(true);
    const d = await (await f('/api/data')).json();
    expect(d.chats.map((c: any) => c.session_id)).toContain('sample-1');
    expect(p.calls).toEqual([{ method: 'GET', url: '/api/data' }]);
  });

  for (const [how, js] of [
    ['finish', 'for(var i=0;i<TOUR.order.length;i++)tourNext();'],
    ['skip', "document.querySelector('#tourskip').onclick();"],
    ['Exit tour', "document.querySelector('#tourexit').onclick();"],
    ['Escape (close)', "__key('Escape');"],
  ] as const) {
    it('restores the real state on ' + how, () => {
      const real: any[] = [];
      const p = page(real);
      const origFetch = p.ctx.fetch;
      run(p, 'TOUR.on=true;tourBegin(0); tourShow(4);');
      run(p, js);
      expect(run(p, 'TOUR.on')).toBe(false);
      expect(p.ctx.DATA.chats).toBe(real);
      expect(p.ctx.DATA.drafts).toEqual([]);
      expect(p.ctx.DATA.slackMode).toBe('off');
      expect(p.ctx.window.fetch).toBe(origFetch);
      expect(p.ctx.tab).toBe('trees');
      expect(p.ctx.shipOpen).toBe(true);
      expect(p.ctx.document.querySelector('#tour').hidden).toBe(true);
      expect(p.ctx.document.querySelector('#tourribbon').hidden).toBe(true);
      expect(p.refreshes()).toBeGreaterThan(0);
      expect(p.calls.at(-1)).toEqual({ method: 'POST', url: '/api/wizard/tour' });
    });
  }
});

describe('tour on real data', () => {
  it('uses the real chats and skips stops whose subject is missing', () => {
    const p = page([realChat]);
    run(p, 'TOUR.on=true;tourBegin(0)');
    expect(run(p, 'TOUR.sample')).toBe(false);
    expect(p.ctx.document.querySelector('#tourribbon').hidden).toBe(true);
    expect(run(p, 'TOUR.order.map(function(i){return TOUR.stops[i].id;})')).toEqual(['filters', 'groups', 'tabs', 'menu', 'gear']);
  });
  it('includes the Outbox, Slack and Ship stops when the data has them', () => {
    const p = page([{ ...realChat, session_id: 'x1' }]);
    Object.assign(p.ctx.DATA, { slackMode: 'direct', drafts: [{ id: 'd1', session_id: 'x1' }], slackOwners: ['x1'] });
    run(p, "TOUR.shipOk=true;TOUR.shipRepo='/r';TOUR.on=true;tourBegin(0)");
    expect(run(p, 'TOUR.order.map(function(i){return TOUR.stops[i].id;})')).toEqual(['filters', 'groups', 'tabs', 'outbox', 'ship', 'menu', 'slack', 'gear']);
  });
  it('opens a chat for the chat stops and passes real reads through', async () => {
    const p = page([realChat]);
    run(p, 'TOUR.on=true;tourBegin(0); tourShow(2);');
    expect(p.ctx.sel).toEqual({ sid: 'abc', agent: 'claude' });
    p.calls.length = 0;
    await p.ctx.window.fetch('/api/detail?session=abc');
    expect(p.calls).toEqual([{ method: 'GET', url: '/api/detail?session=abc' }]);
    expect((await (await p.ctx.window.fetch('/api/chats/rename', { method: 'POST' })).json()).ok).toBe(false);
    expect(p.calls).toHaveLength(1);
  });
});
