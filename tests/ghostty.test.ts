import { describe, it, expect } from 'vitest';
import { buildOpenTabsScript, openGhosttyTabs } from '../src/ghostty.ts';

describe('buildOpenTabsScript', () => {
  it('opens a new tab per session and attaches via the ta alias', () => {
    const s = buildOpenTabsScript(['loom-a', 'loom-b'], false);
    expect(s).toContain('tell application "Ghostty" to activate');
    // one cmd+t per session when not reusing the first tab
    expect(s.match(/keystroke "t" using command down/g)?.length).toBe(2);
    expect(s).toContain('keystroke "ta loom-a"');
    expect(s).toContain('keystroke "ta loom-b"');
    // Return (key code 36) after each attach command
    expect(s.match(/key code 36/g)?.length).toBe(2);
  });

  it('reuses the first (empty) tab when Ghostty was just launched', () => {
    const s = buildOpenTabsScript(['loom-a', 'loom-b', 'loom-c'], true);
    // first session reuses the initial tab -> one fewer cmd+t than sessions
    expect(s.match(/keystroke "t" using command down/g)?.length).toBe(2);
    expect(s.match(/key code 36/g)?.length).toBe(3);
  });

  it('escapes double quotes and backslashes in session names', () => {
    const s = buildOpenTabsScript(['loom-a"b\\c'], false);
    expect(s).toContain('keystroke "ta loom-a\\"b\\\\c"');
  });
});

describe('openGhosttyTabs', () => {
  it('no-ops with no sessions', () => {
    const r = openGhosttyTabs([], { dryRun: true });
    expect(r).toMatchObject({ ok: true, opened: 0, script: '' });
  });

  it('dry-run returns the script without running osascript', () => {
    const r = openGhosttyTabs(['loom-x'], { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.opened).toBe(1);
    expect(r.script).toContain('keystroke "ta loom-x"');
  });
});
