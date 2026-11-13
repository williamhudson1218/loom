import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
describe('pane name never truncates in a sidebar row', () => {
  it('the name and separator do not shrink; repo gives way first; chips column can shrink', () => {
    expect(src).toContain('.ssub.named .ssp, .ssub.named .cname { flex:none; white-space:pre; }');
    expect(src).toContain('.ssub.named .ssr { flex:0 100 auto; }');
    expect(src).toMatch(/\.sright \{ flex:0 1 auto; min-width:0;/);
  });
  it('the row body reserves room for the whole name', () => {
    expect(src).toContain('function bodyW(c)');
    expect(src).toContain("'<span class=\"sbody\"'+bodyW(c)+'>");
  });
  it('rows without a pane name keep the plain ellipsis line', () => {
    expect(src).toContain("return '<span class=\"ssub\">'+st+rowSub(c)+'</span>';");
  });
});
