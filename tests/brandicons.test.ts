import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { BRAND_SVG, BRAND_ICONS_JS } from '../src/brandicons.ts';
import { renderDashboard } from '../src/dashboard.ts';

describe('brand icons', () => {
  it('every mark is one well-formed, decorative, self-contained svg', () => {
    for (const [k, s] of Object.entries(BRAND_SVG)) {
      expect(s.startsWith('<svg '), k).toBe(true);
      expect(s.endsWith('</svg>'), k).toBe(true);
      expect(s).toContain('aria-hidden="true"');
      expect(s).toContain('width="14"');
      expect(s.match(/<svg/g)?.length).toBe(1);
      expect(s.match(/<\/svg>/g)?.length).toBe(1);
      // No external references: no urls, hrefs, images, scripts or handlers.
      expect(s.replace(' xmlns="http://www.w3.org/2000/svg"', '')).not.toMatch(/https?:|href=|<image|<script|<use|url\(|\bon\w+=/i);
      // Every tag closes: paths are self-closed.
      expect((s.match(/<path /g) || []).length).toBe((s.match(/\/>/g) || []).length);
      expect(s).not.toMatch(/\$\{|`/);
    }
    expect(BRAND_SVG.github).toContain('currentColor');
    expect(BRAND_SVG.slack).toContain('#36C5F0');
    expect(BRAND_SVG.gmail).toContain('#EA4335');
  });

  it('the page helper returns markup for a known key and nothing otherwise', () => {
    const ctx: Record<string, unknown> = {};
    vm.runInNewContext(BRAND_ICONS_JS, ctx);
    const f = ctx.brandIcon as (k: string) => string;
    expect(f('slack')).toBe(BRAND_SVG.slack);
    expect(f('nope')).toBe('');
  });

  it('the dashboard page script still parses and carries the helper', () => {
    const html = renderDashboard([], 1);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.some((s) => s.includes('function brandIcon('))).toBe(true);
    for (const s of scripts) expect(() => new vm.Script(s)).not.toThrow();
  });
});
