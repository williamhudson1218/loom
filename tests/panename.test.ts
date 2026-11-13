import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
describe('pane name never truncates in a sidebar row', () => {
  it('the name and separator do not shrink; repo gives way first; chips column can shrink', () => {
    expect(src).toContain('.ssub.named .ssp, .ssub.named .cname { flex:none; white-space:pre; }');
    expect(src).toContain('.ssub.named .ssr { flex:0 100 auto; }');
  });
  it('chips sit on one full-width wrapping line under the sub line, not in a right column', () => {
    expect(src).toContain('.sline > .ssub { flex:1 1 auto; min-width:0; }');
    expect(src).toContain('.schips > * { margin-left:0 !important; }');
    expect(src).toContain("'<span class=\"sline\">'+subLine(c)+(chips?'<span class=\"schips\">'+chips+'</span>':'')");
    expect(src).toContain('<span class="shead">');
  });
  it('rows without a pane name keep the plain ellipsis line', () => {
    expect(src).toContain("return '<span class=\"ssub\">'+st+rowSub(c)+'</span>';");
  });
});
