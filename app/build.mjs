import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
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
  // node-pty is native like better-sqlite3 (loaded from app/node_modules at
  // runtime by ptybridge.ts). bufferutil / utf-8-validate are ws's optional
  // native speedups; ws falls back to JS when they are absent.
  external: ['electron', 'better-sqlite3', 'node-pty', 'bufferutil', 'utf-8-validate'],
  define: {
    'import.meta.url': '"loom-bundled"',
    __LOOM_REPO_DIR__: JSON.stringify(REPO_ROOT),
  },
  logLevel: 'info',
});
console.log('built dist/main.js');

// The orchestrator's MCP server (src/orchmcp-main.ts): a separate stdio process
// Claude Code spawns, run by the app binary with ELECTRON_RUN_AS_NODE=1. It only
// talks HTTP to Loom, so it bundles with no native externals.
await build({
  entryPoints: ['../src/orchmcp-main.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/orchmcp.js',
  logLevel: 'info',
});
console.log('built dist/orchmcp.js');

// The window's preload: exposes webUtils.getPathForFile (File.path is gone in
// Electron 32+) so a file dropped on the terminal can be typed as its path.
await build({
  entryPoints: ['preload.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: 'dist/preload.js',
  external: ['electron'],
  logLevel: 'info',
});
console.log('built dist/preload.js');

// The embedded terminal's browser libraries. The server serves /vendor/* from
// dist/vendor in the bundle (only dist/** and app/node_modules ship), so copy
// them in from the repo root's node_modules.
const VENDOR = {
  'xterm.js': '@xterm/xterm/lib/xterm.js',
  'xterm.css': '@xterm/xterm/css/xterm.css',
  'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js',
  'addon-webgl.js': '@xterm/addon-webgl/lib/addon-webgl.js',
  'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js',
};
fs.mkdirSync('dist/vendor', { recursive: true });
for (const [name, spec] of Object.entries(VENDOR)) {
  fs.copyFileSync(path.join(REPO_ROOT, 'node_modules', spec), path.join('dist/vendor', name));
}
console.log('copied dist/vendor (xterm)');

// slack-ax, the Accessibility helper the Slack pick overlay hit-tests through
// (see native/slack-ax.swift). electron-builder ships it as an extraResource,
// outside the asar, so it can be executed. Needs the Xcode command line tools.
fs.mkdirSync('build-native', { recursive: true });
execFileSync('swiftc', ['-O', 'native/slack-ax.swift', '-o', 'build-native/slack-ax'], { stdio: 'inherit' });
console.log('built build-native/slack-ax');

// loom-keychain, the Keychain helper that holds the Slack token (see
// native/loom-keychain.swift and src/secrets.ts). The secret only crosses its
// stdin/stdout. Shipped as an extraResource beside slack-ax; the standalone
// server finds the same binary in build-native/.
execFileSync('swiftc', ['-O', 'native/loom-keychain.swift', '-o', 'build-native/loom-keychain'], { stdio: 'inherit' });
console.log('built build-native/loom-keychain');

// The Claude Code plugin (plugin/, see src/pluginmgr.ts). Staged into
// build-plugin/ without its tests or bytecode, then shipped as an extraResource
// at <Resources>/plugin. Settings › Helpers copies it to $LOOM_HOME/plugin-marketplace.
const PLUGIN_SRC = path.join(REPO_ROOT, 'plugin');
const PLUGIN_OUT = 'build-plugin';
const PLUGIN_SKIP = new Set(['tests', '__pycache__', '.DS_Store', 'node_modules']);
function stagePlugin(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (PLUGIN_SKIP.has(ent.name) || ent.name.endsWith('.pyc')) continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) stagePlugin(src, dst);
    else if (ent.isFile()) fs.copyFileSync(src, dst); // copyFileSync keeps the exec bit
  }
}
fs.rmSync(PLUGIN_OUT, { recursive: true, force: true });
stagePlugin(PLUGIN_SRC, PLUGIN_OUT);
console.log('staged build-plugin (plugin/ without tests)');
