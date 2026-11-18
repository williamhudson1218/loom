import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.ts';
import { defaultProjectDir } from '../src/projects.ts';
import { applySettingsPatch } from '../src/settingsSchema.ts';
import { renderDashboard } from '../src/dashboard.ts';

describe('default project (new_thread_dir)', () => {
  it('is none for last, the home folder for home, and a fixed folder as set', () => {
    const db = openDb(':memory:');
    expect(defaultProjectDir(db, '/home/x')).toBeNull();
    expect(applySettingsPatch(db, { new_thread_dir: 'home' }).ok).toBe(true);
    expect(defaultProjectDir(db, '/home/x')).toBe('/home/x');
    expect(applySettingsPatch(db, { new_thread_dir: '~/dev/app' }).ok).toBe(true);
    expect(defaultProjectDir(db, '/home/x')).toBe('/home/x/dev/app');
    expect(applySettingsPatch(db, { new_thread_dir: '/srv/app' }).ok).toBe(true);
    expect(defaultProjectDir(db, '/home/x')).toBe('/srv/app');
    expect(applySettingsPatch(db, { new_thread_dir: 'last' }).ok).toBe(true);
    expect(defaultProjectDir(db, '/home/x')).toBeNull();
    db.close();
  });

  it('the composer preselects the default and offers Make default', () => {
    const html = String(renderDashboard([], Date.now(), {}, 'claude'));
    expect(html).toContain('id="cprojdef"');
    expect(html).toContain("const dp=DATA.defaultProject;");
    expect(html).toContain('JSON.stringify({new_thread_dir:v})');
  });
});
