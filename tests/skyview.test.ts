import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { SKY_JS } from '../src/skyview.ts';
import { WIZARD_VIEW_JS, WIZARD_VIEW_HTML } from '../src/wizardview.ts';
import { renderDashboard } from '../src/dashboard.ts';

// A fake page: a canvas whose 2D context records nothing, a manual frame queue,
// and listener bookkeeping, so the loop's lifecycle can be stepped by hand.
function page(o: { reduce?: boolean } = {}) {
  const listeners = new Map<string, Set<unknown>>();
  const target = (name: string) => ({
    addEventListener: (t: string, f: unknown) => { const k = name + ':' + t; if (!listeners.has(k)) listeners.set(k, new Set()); listeners.get(k)!.add(f); },
    removeEventListener: (t: string, f: unknown) => { listeners.get(name + ':' + t)?.delete(f); },
  });
  const ctx2d = new Proxy({}, { get: (_t, k) => (k === 'createRadialGradient' || k === 'createLinearGradient' ? () => ({ addColorStop() {} }) : () => {}), set: () => true });
  const mkCanvas = () => ({ width: 0, height: 0, clientWidth: 800, clientHeight: 500, getContext: () => ctx2d });
  let queue: Array<(t: number) => void> = [];
  let cancelled = 0;
  const doc = { ...target('document'), hidden: false, createElement: () => mkCanvas() };
  const win = { ...target('window'), devicePixelRatio: 3, innerWidth: 800, innerHeight: 500, matchMedia: () => ({ matches: !!o.reduce }) };
  const g: any = {
    window: win, document: doc, performance: { now: () => 0 },
    requestAnimationFrame: (f: (t: number) => void) => { queue.push(f); return queue.length; },
    cancelAnimationFrame: () => { cancelled++; queue = []; },
    Math,
  };
  vm.createContext(g);
  vm.runInContext(SKY_JS, g);
  const count = () => [...listeners.values()].reduce((a, s) => a + s.size, 0);
  const tick = (t: number) => { const q = queue; queue = []; q.forEach((f) => f(t)); };
  const fire = (k: string) => listeners.get(k)?.forEach((f) => (f as () => void)());
  return { g, doc, mkCanvas, tick, fire, count, pending: () => queue.length, cancelled: () => cancelled };
}

describe('loomSky', () => {
  it('runs a frame loop and stop() cancels it and removes every listener', () => {
    const p = page();
    const h = p.g.loomSky(p.mkCanvas(), { nebula: [] });
    expect(p.pending()).toBe(1);
    expect(p.count()).toBeGreaterThan(0);
    p.tick(16); p.tick(32);
    expect(h.stats().frames).toBe(2);
    h.stop();
    expect(p.pending()).toBe(0);
    expect(p.count()).toBe(0);
    expect(h.running()).toBe(false);
  });
  it('pauses while the page is hidden and resumes when it is visible', () => {
    const p = page();
    p.g.loomSky(p.mkCanvas(), {});
    p.doc.hidden = true; p.fire('document:visibilitychange');
    expect(p.pending()).toBe(0);
    p.doc.hidden = false; p.fire('document:visibilitychange');
    expect(p.pending()).toBe(1);
  });
  it('stops for good once alive() turns false', () => {
    const p = page();
    let alive = true;
    const h = p.g.loomSky(p.mkCanvas(), { alive: () => alive });
    p.tick(16);
    alive = false; p.tick(32);
    expect(p.pending()).toBe(0);
    expect(p.count()).toBe(0);
    expect(h.running()).toBe(false);
  });
  it('draws one still frame under reduced motion', () => {
    const p = page({ reduce: true });
    const h = p.g.loomSky(p.mkCanvas(), { parallax: true });
    p.tick(16);
    expect(h.stats().frames).toBe(1);
    expect(p.pending()).toBe(0);
  });
  it('caps the pixel ratio and the star count, and ambient uses run at 30 fps', () => {
    const p = page();
    const c = p.mkCanvas(); c.clientWidth = 4000; c.clientHeight = 3000;
    const h = p.g.loomSky(c, { dpr: 1, maxStars: 400, fps: 30 });
    expect(c.width).toBe(4000);
    expect(h.stats().stars).toBeLessThanOrEqual(400);
    p.tick(1000); p.tick(1016); p.tick(1033); p.tick(1050);
    expect(h.stats().frames).toBe(2);
  });
});

describe('who uses it', () => {
  it('the wizard backdrop starts on open and stops on close and finish', () => {
    expect(WIZARD_VIEW_HTML).toContain('id="wz-sky"');
    expect(WIZARD_VIEW_JS).toMatch(/function wzOpen\(\)[\s\S]*?wzSkyStart\(\);/);
    expect((WIZARD_VIEW_JS.match(/wzSkyStop\(\);/g) || []).length).toBe(2);
    expect(WIZARD_VIEW_JS).toContain('alive: function () { return WZ.open; }');
  });
  it('the dashboard carries the sky once and the empty board uses it', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html.split('function loomSky(').length).toBe(2);
    expect(html).toContain('id="mhero"');
    expect(html).toContain('alive:heroOn');
    for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(m[1])).not.toThrow();
  });
  it('has no backtick, dollar-brace or backslash', () => {
    expect(SKY_JS).not.toContain('`');
    expect(SKY_JS).not.toContain('${');
    expect(SKY_JS).not.toContain('\\');
  });
});
