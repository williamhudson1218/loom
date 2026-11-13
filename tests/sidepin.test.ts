import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/dashboard.ts', import.meta.url), 'utf8');
describe('pinned Orchestrator row and ship card', () => {
  it('sit in a block outside the scrolling list, capped at 45%, opaque', () => {
    expect(src).toContain('<div id="sidepin"><div id="orchpin"></div><div id="shippin"></div></div>\n  <div id="sidelist">');
    expect(src).toMatch(/#sidepin \{ flex:none; max-height:45%;[^}]*background:#0f1218;/);
    expect(src).toMatch(/#sidepin > #shippin \{[^}]*overflow-y:auto;/);
  });
  it('the ship strip renders into the pin, not the list, and wires there', () => {
    expect(src).toContain("sp.innerHTML=shipStrip();wireShips(sp);list.innerHTML=(searching?");
  });
  it('a divider and shadow appear once the list is scrolled', () => {
    expect(src).toContain("classList.toggle('listscrolled',sl.scrollTop>2)");
    expect(src).toContain('#side.listscrolled #sidepin');
  });
  it('the pin hides on tabs that replace the list', () => {
    expect(src).toContain("$('#sidepin').style.display=other||tk?'none':''");
  });
});
