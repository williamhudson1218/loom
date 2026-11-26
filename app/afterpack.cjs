// electron-builder afterPack hook: give Loom.app a valid signature.
//
// Releases are signed with Loom's own self-signed certificate (LOOM_SIGN_IDENTITY,
// the certificate's SHA-1, imported by release.yml from the LOOM_SIGN_P12 secret).
// That makes the designated requirement `identifier "com.loom.app" and
// certificate root = H"…"`, the same for every build, so macOS keeps the Files
// and Folders grants (Documents, Downloads, Pictures, …) across updates. Ad-hoc,
// the requirement is the build's cdhash and every update re-asks for all of them.
// Local builds without the variable are still ad-hoc.
//
// Loom has no Developer ID ("identity": null keeps electron-builder out of it), and electron-builder
// renames Electron.app and edits its Info.plist and resources, which leaves the
// Electron binary's linker signature claiming resources that are no longer
// sealed. A downloaded copy in that state fails Gatekeeper as "Loom is damaged
// and can't be opened", with no way through. Re-signing (inside out:
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

const IDENTITY = process.env.LOOM_SIGN_IDENTITY || '-';
const KEYCHAIN = process.env.LOOM_SIGN_KEYCHAIN ? ['--keychain', process.env.LOOM_SIGN_KEYCHAIN] : [];
const sign = (target, extra = []) => execFileSync('codesign', ['--force', '--sign', IDENTITY, ...KEYCHAIN, ...extra, target], { stdio: 'inherit' });
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
  console.log(`  • ${IDENTITY === '-' ? 'ad-hoc' : 'certificate'} sealed ${path.basename(app)}; helpers unchanged: ${[...before.values()].join(', ') || 'none'}`);
};
