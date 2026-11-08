import vm from 'node:vm';
import { describe, it, expect } from 'vitest';
import { renderDashboard } from '../src/dashboard.ts';

const html = String(renderDashboard([], Date.now(), {}, 'claude'));
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');

describe('copyable chat names', () => {
  it('the page script parses and wires the copy handlers', () => {
    expect(() => new vm.Script(script)).not.toThrow();
    expect(script).toContain("e.target.closest('[data-copyname]')");
    expect(script).toContain("copyText(n,'Copied')");
    // The click returns before the row would be selected or opened.
    const i = script.indexOf("const cn=e.target.closest('[data-copyname]');if(cn){e.stopPropagation();copyName(cn.dataset.copyname);return;}const r=e.target.closest('.srow[data-sid]')");
    expect(i).toBeGreaterThan(0);
  });
  it('rows and the header render the name as a copy target', () => {
    expect(script).toContain('data-copyname="');
    expect(script).toContain('class="cname"');
    // Only the icon button copies; the name text itself is not a copy target.
    expect(html).toContain('.srow:hover .cname .cpi');
    expect(script).toContain('<button type="button" class="cpi" data-copyname="');
    expect(script).not.toContain('<span class="cname" data-copyname=');
  });
  it('copyText prefers navigator.clipboard', () => {
    expect(script).toContain('navigator.clipboard');
  });
});
