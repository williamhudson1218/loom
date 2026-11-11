// electron-builder afterPack hook: give Loom.app a valid ad-hoc signature.
//
// Loom ships unsigned (no Developer ID, "identity": null), and electron-builder
// renames Electron.app and edits its Info.plist and resources, which leaves the
// Electron binary's linker signature claiming resources that are no longer
// sealed. A downloaded copy in that state fails Gatekeeper as "Loom is damaged
// and can't be opened", with no way through. Re-signing ad-hoc (inside out:
// each framework and Electron helper, then the app) makes the seal valid, so a
// quarantined copy gets the ordinary "could not verify" path that System
// Settings › Privacy & Security › Open Anyway lets through.
//
// The Loom helpers under Contents/Helpers are NOT re-signed: they were signed at
// build time and their code hash is what the user's Accessibility, Automation
// and Keychain grants are keyed to (see build.mjs). The check at the end proves
// they came through byte-identical.
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const sign = (target, extra = []) => execFileSync('codesign', ['--force', '--sign', '-', ...extra, target], { stdio: 'inherit' });
/** The code hash a grant is keyed to, or null when the target is unsigned. codesign -d writes to stderr. */
function cdhashOf(target) {
  const r = spawnSync('codesign', ['-dvvv', target], { encoding: 'utf8' });
  const m = /^CDHash=([0-9a-f]+)$/m.exec(r.stderr || '');
  return r.status === 0 && m ? m[1] : null;
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const contents = path.join(app, 'Contents');

  const helpersDir = path.join(contents, 'Helpers');
  const helpers = fs.existsSync(helpersDir) ? fs.readdirSync(helpersDir).map((d) => path.join(helpersDir, d, 'Loom.app')).filter((p) => fs.existsSync(p)) : [];
  const before = new Map(helpers.map((h) => [h, cdhashOf(h)]));

  // node-pty ships prebuilds for every platform; only this build's arch can ever
  // load. The others are dead weight, and an x86_64 Mach-O in an arm64 app is what
  // macOS's Rosetta deprecation scan flags. Removed before signing, so the seal
  // covers the trimmed bundle. (Arch enum from builder-util: 1 x64, 3 arm64.)
  const archName = { 1: 'x64', 3: 'arm64' }[context.arch] || 'arm64';
  const prebuilds = path.join(contents, 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty', 'prebuilds');
  if (fs.existsSync(prebuilds)) {
    for (const d of fs.readdirSync(prebuilds)) if (d !== `darwin-${archName}`) fs.rmSync(path.join(prebuilds, d), { recursive: true, force: true });
  }

  // node-gyp's build/node_gyp_bins (a python3 symlink to the build machine's
  // interpreter) is a build artifact; package.json's files filter drops it, and
  // this catches any copy that slips through, before the seal is made.
  const unpacked = path.join(contents, 'Resources', 'app.asar.unpacked', 'node_modules');
  if (fs.existsSync(unpacked)) {
    for (const m of fs.readdirSync(unpacked)) fs.rmSync(path.join(unpacked, m, 'build', 'node_gyp_bins'), { recursive: true, force: true });
  }

  const frameworks = path.join(contents, 'Frameworks');
  for (const f of fs.readdirSync(frameworks)) sign(path.join(frameworks, f), ['--deep']);
  // node-pty's spawn-helper and the native .node addons are Mach-O files outside
  // the standard nested-code places; the app seal covers them as resources.
  sign(app);

  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
  for (const [h, hash] of before) {
    const now = cdhashOf(h);
    if (!hash || now !== hash) throw new Error(`afterPack: ${h} changed code hash (${hash} -> ${now}); its grants would reset`);
  }
  console.log(`  • ad-hoc sealed ${path.basename(app)}; helpers unchanged: ${[...before.values()].join(', ') || 'none'}`);
};
