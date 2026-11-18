import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../src/dashboard.ts';

// The dashboard concatenates many modules' client JS into one page scope, where
// a second `function x(` silently replaces the first. That shipped once:
// the outbox's filesHtml (draft image thumbnails) was shadowed by the detail
// pane's filesHtml (git changed files), so drafts showed empty file rows.
describe('dashboard page scope', () => {
  it('declares every top-level function name once', () => {
    const html = String(renderDashboard([], Date.now(), {}, 'claude'));
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
    const counts = new Map<string, number>();
    for (const m of scripts.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) counts.set(m[1], (counts.get(m[1]) ?? 0) + 1);
    const dupes = [...counts].filter(([, n]) => n > 1).map(([k]) => k);
    expect(dupes).toEqual([]);
  });
});
