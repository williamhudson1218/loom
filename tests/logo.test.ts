import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { LOGO_SVG, logoSvg, threadMark } from '../src/logo.ts';
import { WIZARD_VIEW_CSS, WIZARD_VIEW_JS } from '../src/wizardview.ts';
import { SETTINGS_VIEW_JS } from '../src/settingsview.ts';

const icon = fs.readFileSync(path.resolve(__dirname, '..', 'app', 'assets', 'icon.svg'), 'utf8');

describe('the Loom mark', () => {
  it('draws the strokes of app/assets/icon.svg', () => {
    for (const d of icon.matchAll(/ d="([^"]+)"/g)) expect(LOGO_SVG).toContain(d[1]);
  });
  it('gets ids of its own per use, so a hidden copy cannot blank a visible one', () => {
    const a = logoSvg(22, 'wz');
    expect(a).toContain('id="loom-bg-wz"');
    expect(a).toContain('url(#loom-bg-wz)');
    expect(a).not.toMatch(/id="loom-bg"|#loom-x\)/);
    expect(a).toMatch(/^<svg width="22" height="22" aria-hidden="true"/);
  });
  it('the tileless mark keeps the welcome screen ids and takes its own elsewhere', () => {
    expect(threadMark('lw-mark', 'lw')).toContain('<mask id="lw-m"');
    expect(threadMark('x', 'wz-mk', 22)).toMatch(/^<svg class="x" width="22" height="22" viewBox/);
    for (const d of icon.matchAll(/ d="([^"]+)"/g)) expect(threadMark('x', 'y')).toContain(d[1]);
  });
  it('replaces the gradient square in the setup wizard, and Settings > About shows it', () => {
    expect(WIZARD_VIEW_CSS).not.toContain('linear-gradient(135deg,#6ea2ff,#c9b4ff)');
    expect(WIZARD_VIEW_JS).toContain("var WZ_LOGO = '<svg class=\"wz-mark\" width=\"22\"");
    expect(WIZARD_VIEW_JS).toContain('mask="url(#wz-mk-m)"');
    expect(SETTINGS_VIEW_JS).toContain("var SX_LOGO='<svg width=\"40\"");
  });
});
