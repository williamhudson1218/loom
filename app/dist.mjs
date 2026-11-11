// electron-builder, with the version from version.mjs stamped in: it becomes the
// asar's package.json version (app.getVersion()) and the bundle's
// CFBundleShortVersionString / CFBundleVersion, which the updater compares.
//
// It also leaves out what can never run in this build, through the files filter
// (so it never enters the asar's index; deleting it after packing leaves the
// index pointing at missing unpacked files): node-pty's prebuilds for other
// platforms and arches, and node-gyp's build/node_gyp_bins (a python3 symlink
// to the build machine's interpreter). An x86_64 Mach-O in an arm64 app is what
// macOS's Rosetta deprecation scan flags; scripts/release/check-arch.sh checks.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo } from './version.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const info = buildInfo(path.resolve(APP_DIR, '..'));
const arch = process.env.LOOM_ARCH || process.arch; // arm64 | x64
const PREBUILDS = ['darwin-arm64', 'darwin-x64', 'win32-arm64', 'win32-x64', 'linux-arm64', 'linux-x64'];
const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const config = {
  ...pkg.build,
  files: [
    ...pkg.build.files,
    '!**/build/node_gyp_bins/**',
    ...PREBUILDS.filter((p) => p !== `darwin-${arch}`).map((p) => `!node_modules/node-pty/prebuilds/${p}/**`),
  ],
  extraMetadata: { version: info.version },
  buildVersion: info.version,
  mac: { ...pkg.build.mac, extendInfo: { ...(pkg.build.mac?.extendInfo ?? {}), LoomCommit: info.commit, LoomChannel: info.channel } },
};
const cfgFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dist-')), 'electron-builder.json');
fs.writeFileSync(cfgFile, JSON.stringify(config, null, 2));
const bin = path.join(APP_DIR, 'node_modules', '.bin', 'electron-builder');
try {
  execFileSync(bin, ['--config', cfgFile, `--${arch}`, ...process.argv.slice(2)], { cwd: APP_DIR, stdio: 'inherit' });
} finally {
  fs.rmSync(path.dirname(cfgFile), { recursive: true, force: true });
}
console.log(`packaged Loom ${info.version} (${info.channel}, ${arch})`);
