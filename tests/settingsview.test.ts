import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { SETTINGS_VIEW_CSS, SETTINGS_VIEW_HTML, SETTINGS_VIEW_JS } from '../src/settingsview.ts';
import { SETTINGS } from '../src/settingsSchema.ts';
import { renderDashboard } from '../src/dashboard.ts';

// Watchers keys belong to the Watchers editor (T20), which has its own view.
const OTHER_VIEW = new Set(['watchers_enabled', 'watcher_brief_prune_days', 'watchers_ignore_self']);

// Loom's own bookkeeping (ids it wrote itself); nothing a person could act on.
// slack_reconnect is written by a refused token refresh and reaches the page as
// /api/slack/status `reconnect` (the Reconnect Slack button and note).
const BOOKKEEPING = new Set(['orchestrator_session_id', 'orchestrator_pane_id', 'plugin_state', 'last_project_dir', 'slack_reconnect']);

describe('settings view', () => {
  it('has no backslash, backtick or dollar-brace (it is spliced into a template string)', () => {
    for (const part of [SETTINGS_VIEW_CSS, SETTINGS_VIEW_HTML, SETTINGS_VIEW_JS]) {
      expect(part).not.toContain('\\');
      expect(part).not.toContain('`');
      expect(part).not.toContain('${');
    }
  });

  it('is valid script', () => {
    expect(() => new vm.Script(SETTINGS_VIEW_JS.split('__SX_KEYMAP__').join('[]'))).not.toThrow();
    expect(SETTINGS_VIEW_JS).not.toContain('__SX_KEYMAP__');
  });

  it('shows or edits every registry key outside Watchers', () => {
    const missing = SETTINGS.map((d) => d.key).filter((k) => !OTHER_VIEW.has(k) && !BOOKKEEPING.has(k) && k !== 'watcher_default_target' && !SETTINGS_VIEW_JS.includes("'" + k + "'"));
    expect(missing).toEqual([]);
    expect(SETTINGS_VIEW_JS).toContain("'watcher_default_target'");
  });

  it('names no person, company or personal path', () => {
    expect(SETTINGS_VIEW_JS).not.toMatch(/Will|Tax Pilot|Superset|willhudson|loom-tp/);
  });

  it('is spliced into the page with its sections', () => {
    const html = String((renderDashboard as any)({ chats: [], live: [] }));
    expect(html).toContain('id="settings-section"');
    expect(html).toContain("id:'helpers'");
    expect(html).toContain('DATA.archiveSearch');
  });
});
