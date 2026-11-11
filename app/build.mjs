import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperCacheKey, helperInfoPlist, shouldRebuild, CACHE_VERSION } from './nativecache.mjs';

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

// The native helpers, each the main executable of a tiny "Loom" app bundle so
// that Privacy & Security and Keychain prompts name it "Loom" with Loom's icon:
//
//   build-native/ax/Loom.app        loom-ax: the Slack reader and the osascript
//                                   runner (Accessibility + Automation, see
//                                   native/loom-ax.swift)
//   build-native/keychain/Loom.app  loom-keychain: the Slack token in the
//                                   Keychain (native/loom-keychain.swift)
//
// electron-builder ships both under Contents/Helpers (package.json extraFiles).
// They are ad-hoc signed, and macOS keys an ad-hoc grant to the code hash, so a
// helper is only rebuilt when its inputs change (nativecache.mjs): a normal Loom
// update keeps every grant. Two bundles, not one, so editing the Slack reader
// does not also re-prompt for the Keychain. Needs the Xcode command line tools.
const HELPERS = [
  { dir: 'ax', exe: 'loom-ax', id: 'com.loom.app.ax', src: 'native/loom-ax.swift' },
  { dir: 'keychain', exe: 'loom-keychain', id: 'com.loom.app.keychain', src: 'native/loom-keychain.swift' },
];
fs.mkdirSync('build-native', { recursive: true });
// The pre-bundle outputs; nothing reads them any more.
for (const old of ['slack-ax', 'loom-keychain']) fs.rmSync(path.join('build-native', old), { force: true });
const swiftVersion = execFileSync('swiftc', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const icon = fs.readFileSync('assets/icon.icns');
for (const h of HELPERS) {
  const bundle = path.join('build-native', h.dir, 'Loom.app');
  const keyFile = path.join('build-native', h.dir, 'Loom.app.key');
  const plist = helperInfoPlist({ id: h.id, exe: h.exe, version: String(CACHE_VERSION) });
  const key = helperCacheKey([fs.readFileSync(h.src), plist, icon, swiftVersion, h.id, h.exe]);
  let bundleValid = false;
  try {
    execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'ignore' });
    bundleValid = true;
  } catch {
    /* missing or broken: rebuild */
  }
  const storedKey = fs.existsSync(keyFile) ? fs.readFileSync(keyFile, 'utf8') : '';
  if (!shouldRebuild({ key, storedKey, bundleValid })) {
    console.log(`kept ${bundle} (inputs unchanged, grants keep working)`);
    continue;
  }
  fs.rmSync(path.join('build-native', h.dir), { recursive: true, force: true });
  fs.mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), plist);
  fs.writeFileSync(path.join(bundle, 'Contents', 'Resources', 'icon.icns'), icon);
  execFileSync('swiftc', ['-O', h.src, '-o', path.join(bundle, 'Contents', 'MacOS', h.exe)], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', '--identifier', h.id, bundle], { stdio: 'inherit' });
  fs.writeFileSync(keyFile, key + '\n');
  console.log(`built ${bundle} (new code hash: macOS will ask for its grants again)`);
}

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
