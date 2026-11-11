import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { moduleDirOf } from '../src/moduledir.ts';

// The app bundle defines import.meta.url to a sentinel that is not a URL
// (app/build.mjs). Under vitest import.meta.url is a real file:// URL, so code
// that parses it passes every source-level test and then throws "Invalid URL" in
// the shipped app. That is how "Install Loom plugin" failed on a fresh install
// (0.1.99): bundledPluginDir() ran `new URL(import.meta.url)` and every
// /api/plugin/* route threw before it did anything.

const ROOT = path.resolve(__dirname, '..');
const SENTINEL = /'import\.meta\.url':\s*'("[^"]+")'/.exec(fs.readFileSync(path.join(ROOT, 'app', 'build.mjs'), 'utf8'))?.[1];

describe('the bundle import.meta.url sentinel', () => {
  it('app/build.mjs still defines one, and it is not a URL', () => {
    expect(SENTINEL).toBeTruthy();
    expect(() => new URL(JSON.parse(SENTINEL!))).toThrow();
  });

  it('moduleDirOf says null for it and a directory for a file URL', () => {
    expect(moduleDirOf(JSON.parse(SENTINEL!))).toBeNull();
    expect(moduleDirOf(undefined)).toBeNull();
    expect(moduleDirOf('file:///a/b/c.ts')).toBe('/a/b');
  });

  it('no src module parses import.meta.url outside moduledir.ts or a try', () => {
    const bad: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !p.endsWith('moduledir.ts')) {
          const lines = fs.readFileSync(p, 'utf8').split('\n');
          lines.forEach((l, i) => {
            if (!/(new URL|fileURLToPath)\(import\.meta\.url\)/.test(l) || l.trim().startsWith('//')) return;
            // Allowed only inside a try block a few lines up (chatSignals.ts does this).
            const above = lines.slice(Math.max(0, i - 4), i).join('\n');
            if (!/\btry\s*\{/.test(above)) bad.push(`${path.relative(ROOT, p)}:${i + 1}`);
          });
        }
      }
    };
    walk(path.join(ROOT, 'src'));
    expect(bad).toEqual([]);
  });

  it('bundledPluginDir() works when bundled the way the app is', async () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-bundle-'));
    const file = path.join(out, 'pluginmgr.cjs');
    await build({
      entryPoints: [path.join(ROOT, 'src', 'pluginmgr.ts')],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node20',
      outfile: file,
      external: ['better-sqlite3', 'node-pty'],
      define: { 'import.meta.url': SENTINEL!, __LOOM_REPO_DIR__: '""' },
      logLevel: 'silent',
    });
    const mod = createRequire(file)(file) as typeof import('../src/pluginmgr.ts');
    const prev = process.env.LOOM_PLUGIN_SRC;
    const res = (process as { resourcesPath?: string }).resourcesPath;
    // Like the packaged app: the plugin sits at Resources/plugin.
    const resources = path.join(out, 'Resources');
    fs.cpSync(path.join(ROOT, 'plugin'), path.join(resources, 'plugin'), { recursive: true });
    try {
      delete process.env.LOOM_PLUGIN_SRC;
      (process as { resourcesPath?: string }).resourcesPath = resources;
      expect(mod.bundledPluginDir()).toBe(path.join(resources, 'plugin'));
    } finally {
      if (prev === undefined) delete process.env.LOOM_PLUGIN_SRC;
      else process.env.LOOM_PLUGIN_SRC = prev;
      (process as { resourcesPath?: string }).resourcesPath = res;
      fs.rmSync(out, { recursive: true, force: true });
    }
  }, 30_000);
});
