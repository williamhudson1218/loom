import { describe, expect, it } from 'vitest';
import { renderDashboard } from '../src/dashboard.ts';

// The ship card's actions: Ship is a primary button on the bar (visible collapsed),
// and the body's actions are buttons, not text chips.
describe('ship card actions', () => {
  const html = renderDashboard([], Date.now(), {}, 'claude');
  it('puts a gated Ship button on the bar, next to the staged-work icon', () => {
    expect(html).toContain('<span class="shipacts">\'+shipGoBtn(b)+\'');
    expect(html).toMatch(/function shipGoBtn\(b\)\{const g=shipGate\(b\);/);
    expect(html).toContain('class="shipgo" data-shipgo=');
  });
  it('renders Show these chats and View staged work as secondary buttons with the gate reason', () => {
    expect(html).toMatch(/class="shipbtn'\+\(shipFilter==='next'/);
    expect(html).toContain('class="shipbtn" data-shipview=');
    expect(html).toContain('<div class="shiphint">\'+(shipGate(b)?esc(shipGate(b))');
    expect(html).not.toContain('>show these chats<');
    expect(html).toContain('.shipgo:disabled');
  });
});
