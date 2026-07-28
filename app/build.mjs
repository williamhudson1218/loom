import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Bundle the Electron main process + all imported ../src/*.ts into one CJS file.
// better-sqlite3 stays external (native, loaded from node_modules at runtime).
// The src auto-run guards use import.meta.url; define it to a sentinel so those
// `=== file://...` checks are false in the bundle (we drive everything from main).
//
// That sentinel is NOT a valid file:// URL, so no bundled src module may call
// fileURLToPath(import.meta.url) — it throws at load and takes the whole app
// down before anything listens. __LOOM_REPO_DIR__ is stamped in here instead:
// the packaged app lives in /Applications and has no module path pointing back
// at this source tree, so the EM cannot otherwise tell which chats are its own.
await build({
  entryPoints: ['main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/main.js',
  external: ['electron', 'better-sqlite3'],
  define: {
    'import.meta.url': '"loom-bundled"',
    __LOOM_REPO_DIR__: JSON.stringify(REPO_ROOT),
  },
  logLevel: 'info',
});
console.log('built dist/main.js');
