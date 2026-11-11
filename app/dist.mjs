// electron-builder, with the version from version.mjs stamped in: it becomes the
// asar's package.json version (app.getVersion()) and the bundle's
// CFBundleShortVersionString / CFBundleVersion, which the updater compares.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInfo } from './version.mjs';

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const info = buildInfo(path.resolve(APP_DIR, '..'));
const bin = path.join(APP_DIR, 'node_modules', '.bin', 'electron-builder');
execFileSync(
  bin,
  [
    `-c.extraMetadata.version=${info.version}`,
    `-c.buildVersion=${info.version}`,
    `-c.mac.extendInfo.LoomCommit=${info.commit}`,
    `-c.mac.extendInfo.LoomChannel=${info.channel}`,
    ...process.argv.slice(2),
  ],
  { cwd: APP_DIR, stdio: 'inherit' },
);
console.log(`packaged Loom ${info.version} (${info.channel})`);
