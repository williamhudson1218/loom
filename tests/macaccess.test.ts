import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { helperCacheKey, helperInfoPlist, shouldRebuild } from '../app/nativecache.mjs';
import { helperExe, osascriptCommand, packagedHelper } from '../src/nativehelpers.ts';
import { AX_GRANT_HINT, AX_ROW_NAME } from '../src/axcopy.ts';
import { WIZARD_VIEW_JS } from '../src/wizardview.ts';
import { STEP_IDS, stepMeta } from '../src/wizard.ts';

const ROOT = path.join(__dirname, '..');

describe('helper build cache', () => {
  const parts = ['swift source', '<plist/>', Buffer.from([1, 2, 3]), 'swiftc 6.1', 'com.loom.app.ax', 'loom-ax'];

  it('gives the same key for the same inputs', () => {
    expect(helperCacheKey(parts)).toBe(helperCacheKey([...parts]));
  });

  it('changes the key when any input changes', () => {
    const base = helperCacheKey(parts);
    for (let i = 0; i < parts.length; i++) {
      const p = [...parts];
      p[i] = Buffer.isBuffer(p[i]) ? Buffer.from([9]) : String(p[i]) + 'x';
      expect(helperCacheKey(p), `part ${i}`).not.toBe(base);
    }
  });

  it('cannot be fooled by moving bytes between inputs', () => {
    expect(helperCacheKey(['ab', 'c'])).not.toBe(helperCacheKey(['a', 'bc']));
  });

  it('reuses a valid bundle built from the same inputs, and only then', () => {
    const key = helperCacheKey(parts);
    expect(shouldRebuild({ key, storedKey: key + '\n', bundleValid: true })).toBe(false);
    expect(shouldRebuild({ key, storedKey: key, bundleValid: false })).toBe(true); // missing or broken signature
    expect(shouldRebuild({ key, storedKey: '', bundleValid: true })).toBe(true); // built before the cache existed
    expect(shouldRebuild({ key, storedKey: 'other', bundleValid: true })).toBe(true); // source changed
  });

  it('names the helper bundle Loom, keeps it out of the Dock, and is a valid plist', () => {
    const plist = helperInfoPlist({ id: 'com.loom.app.ax', exe: 'loom-ax', version: '1' });
    expect(plist).toContain('<key>CFBundleName</key><string>Loom</string>');
    expect(plist).toContain('<key>CFBundleDisplayName</key><string>Loom</string>');
    expect(plist).toContain('<key>CFBundleIdentifier</key><string>com.loom.app.ax</string>');
    expect(plist).toContain('<key>LSUIElement</key><true/>');
    if (process.platform === 'darwin') {
      const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-plist-')), 'Info.plist');
      fs.writeFileSync(f, plist);
      expect(execFileSync('plutil', ['-lint', f], { encoding: 'utf8' })).toContain('OK');
    }
  });
});

describe('native helper paths and the osascript route', () => {
  it('puts each helper inside its own Loom.app', () => {
    expect(helperExe('/X/Contents/Helpers', 'ax')).toBe('/X/Contents/Helpers/ax/Loom.app/Contents/MacOS/loom-ax');
    expect(helperExe('/X/Contents/Helpers', 'keychain')).toBe('/X/Contents/Helpers/keychain/Loom.app/Contents/MacOS/loom-keychain');
  });

  it('finds no packaged helper outside the app', () => {
    expect(packagedHelper('ax', undefined)).toBeNull();
    expect(packagedHelper('ax', '/nonexistent/Contents/Resources')).toBeNull();
  });

  it('finds the packaged helper beside Resources', () => {
    const app = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-app-'));
    const exe = helperExe(path.join(app, 'Contents', 'Helpers'), 'ax');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '#!/bin/sh\n', { mode: 0o755 });
    expect(packagedHelper('ax', path.join(app, 'Contents', 'Resources'))).toBe(path.join(app, 'Contents', 'Resources', '..', 'Helpers', 'ax', 'Loom.app', 'Contents', 'MacOS', 'loom-ax'));
  });

  it('runs AppleScript through the helper inside the app, plain osascript elsewhere', () => {
    expect(osascriptCommand('return 1', ['a'], '/H/loom-ax')).toEqual({ cmd: '/H/loom-ax', args: ['osascript', '-e', 'return 1', 'a'] });
    expect(osascriptCommand('return 1', ['a'], null)).toEqual({ cmd: 'osascript', args: ['-e', 'return 1', 'a'] });
  });
});

describe('what users are told', () => {
  it('names the row macOS shows', () => {
    expect(AX_ROW_NAME).toBe('Loom');
    expect(AX_GRANT_HINT).toBe('Switch on "Loom" in System Settings › Privacy & Security › Accessibility.');
  });

  it('never names a helper binary in anything a user reads', () => {
    const userFacing = ['src/axcopy.ts', 'src/wizard.ts', 'src/wizardview.ts', 'src/settingsview.ts', 'app/picker.ts', 'src/ghostty.ts', 'src/terminal.ts', 'README.md', 'SETUP.md'];
    for (const f of userFacing) {
      const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      expect(text, f).not.toMatch(/slack-ax/);
      if (f.endsWith('view.ts') || f === 'src/wizard.ts' || f.endsWith('.md')) expect(text, f).not.toMatch(/loom-ax|loom-keychain/);
    }
    // The shortcut's notifications are the one place picker.ts talks to the user.
    const picker = fs.readFileSync(path.join(ROOT, 'app/picker.ts'), 'utf8');
    for (const m of picker.matchAll(/notify\((['`])(.*?)\1/g)) expect(m[2]).not.toMatch(/loom-ax|loom-keychain|helper/);
  });
});

describe('the wizard macOS access step', () => {
  it('sits right after Terminal and is not the Agent permissions step', () => {
    expect(STEP_IDS.indexOf('macos')).toBe(STEP_IDS.indexOf('terminal') + 1);
    expect(stepMeta('macos').title).toBe('macOS access');
    expect(stepMeta('permissions').title).toBe('Agent permissions');
    expect(stepMeta('macos').skippable).toBe(true);
    expect(stepMeta('macos').blocking).toBe(false);
  });

  // The page script, run against just enough of a DOM to call the step.
  function page(native?: object) {
    const ctx: Record<string, unknown> = {
      window: { loomNative: native },
      document: { readyState: 'complete', getElementById: () => null, addEventListener() {} },
      setTimeout: () => 0,
      setInterval: () => 0,
      clearInterval() {},
      console,
    };
    vm.createContext(ctx);
    vm.runInContext(WIZARD_VIEW_JS, ctx);
    return ctx as Record<string, any>;
  }

  it('renders Accessibility with a Grant button, and Automation as asked on first use', () => {
    const p = page();
    p.WZ.S = { terminal: 'ghostty' };
    const c = { innerHTML: '' };
    p.WZ_STEPS.macos(c);
    expect(c.innerHTML).toContain('Accessibility access');
    expect(c.innerHTML).toContain('data-wz-grantax');
    expect(c.innerHTML).toContain('Automation');
    expect(c.innerHTML).toContain('Asked on first use');
    expect(c.innerHTML).toContain('<b>Loom</b>');
    p.WZ.S = { terminal: 'inside' };
    p.WZ_STEPS.macos(c);
    expect(c.innerHTML).toContain('Not needed while chats open inside Loom.');
  });

  it('shows each status state', () => {
    const v = page().wzAxView;
    expect(v(null, false, false)).toMatchObject({ label: 'Not checked', btn: '' });
    expect(v(null, true, false)).toMatchObject({ label: 'Checking', btn: '' });
    expect(v({ trusted: true, helperDown: false }, true, false)).toMatchObject({ label: 'Granted', pill: 'ok', btn: '' });
    expect(v({ trusted: false, helperDown: true }, true, false)).toMatchObject({ label: 'Helper not running', btn: '' });
    expect(v({ trusted: false, helperDown: false }, true, false)).toMatchObject({ label: 'Not granted', btn: 'grant' });
    // After Grant was pressed the row exists; the button takes you to it instead.
    expect(v({ trusted: false, helperDown: false }, true, true)).toMatchObject({ label: 'Not granted', btn: 'open' });
    expect(v({ trusted: false, helperDown: false }, true, true).text).toContain('Switch on "Loom"');
  });
});
