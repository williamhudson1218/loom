import { describe, it, expect } from 'vitest';
import { KEYMAP, pageBindings, menuAccelerators, formatAccelerator, keymapForPage } from '../src/keymap.ts';
import { renderDashboard } from '../src/dashboard.ts';

describe('keymap registry', () => {
  const html = renderDashboard([], Date.now(), {}, 'claude');
  const actionsBlock = html.slice(html.indexOf('const KEY_ACTIONS={'), html.indexOf('function keyMatches'));
  const boundActions = [...actionsBlock.matchAll(/^\s{2}(\w+):function\(e\)/gm)].map((m) => m[1]);

  it('every page-bound entry has a handler in the dashboard, and every handler has an entry', () => {
    const registry = pageBindings().map((k) => k.action).sort();
    expect(boundActions.sort()).toEqual(registry);
    expect(registry.length).toBeGreaterThan(0);
  });

  it('embeds exactly the page-bound entries as the page keymap', () => {
    const m = html.match(/const KEYMAP=(\[.*?\]);\n/);
    expect(m).toBeTruthy();
    const page = JSON.parse(m![1]);
    expect(page.map((k: { action: string }) => k.action)).toEqual(pageBindings().map((k) => k.action));
  });

  it('actions are unique and every page entry carries a match rule', () => {
    const names = KEYMAP.map((k) => k.action);
    expect(new Set(names).size).toBe(names.length);
    for (const k of KEYMAP) if (k.bound === 'page') expect(k.match).toBeTruthy();
  });

  it('exports menu accelerators for the Electron menu', () => {
    expect(menuAccelerators()).toEqual([
      { action: 'settings', accelerator: 'Command+,', label: 'Open Settings' },
      { action: 'newThread', accelerator: 'Command+N', label: 'New thread' },
    ]);
  });

  it('formats accelerators and resolves setting-driven keys for the Help list', () => {
    expect(formatAccelerator('Command+Shift+L')).toBe('⌘⇧L');
    expect(keymapForPage({}).some((k) => k.label.startsWith('Pick a Slack'))).toBe(false);
    expect(keymapForPage({ slack_goto_hotkey: 'Command+Shift+L' }).find((k) => k.label.startsWith('Pick a Slack'))!.keys).toBe('⌘⇧L');
  });
});
