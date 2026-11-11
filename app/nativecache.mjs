// The native helper bundles' build cache (see build.mjs).
//
// macOS keys an ad-hoc signed app's Accessibility, Automation and Keychain grants
// to its code hash. swiftc output is deterministic for a given toolchain, but a
// new Swift toolchain produces different bytes, and any difference silently
// revokes every grant the user gave the helper. So a helper is only rebuilt
// when something that goes into it changed: its Swift source, its Info.plist,
// its icon, or CACHE_VERSION (bump it to force a rebuild on every machine).
// Not when the toolchain updates: the old binary still runs. Pure: no I/O, so
// the decision is unit-tested.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CACHE_VERSION = 1;

/** One key over everything that goes into a helper bundle. Order matters. */
export function helperCacheKey(parts) {
  const h = crypto.createHash('sha256');
  h.update(`loom-helper-cache:${CACHE_VERSION}\n`);
  for (const p of parts) {
    const buf = Buffer.isBuffer(p) ? p : Buffer.from(String(p), 'utf8');
    // Length-prefixed, so ["ab","c"] and ["a","bc"] cannot collide.
    h.update(`${buf.length}:`);
    h.update(buf);
  }
  return h.digest('hex');
}

/**
 * Whether to rebuild. The cached bundle is reused only when it exists, still
 * passes `codesign --verify`, and was built from exactly these inputs.
 */
export function shouldRebuild({ key, storedKey, bundleValid }) {
  if (!bundleValid) return true;
  if (!storedKey) return true;
  return storedKey.trim() !== key;
}

/** The helper bundle's Info.plist. CFBundleName/DisplayName are what Privacy & Security and Keychain prompts show. */
export function helperInfoPlist({ id, exe, version }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>${id}</string>
  <key>CFBundleName</key><string>Loom</string>
  <key>CFBundleDisplayName</key><string>Loom</string>
  <key>CFBundleExecutable</key><string>${exe}</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
  <key>LSBackgroundOnly</key><true/>
</dict>
</plist>
`;
}

/** The helper bundles (see build.mjs). `src` is relative to app/. */
export const HELPERS = [
  { dir: 'ax', exe: 'loom-ax', id: 'com.loom.app.ax', src: 'native/loom-ax.swift' },
  { dir: 'keychain', exe: 'loom-keychain', id: 'com.loom.app.keychain', src: 'native/loom-keychain.swift' },
];

/**
 * A helper's cache key from the files in `appDir`. The release workflow keys the
 * shared helper cache by it (app/helperkeys.mjs), so a CI build reuses the exact
 * bytes of the last helper built from the same inputs.
 */
export function helperKeyFor(h, appDir) {
  const plist = helperInfoPlist({ id: h.id, exe: h.exe, version: String(CACHE_VERSION) });
  const icon = fs.readFileSync(path.join(appDir, 'assets', 'icon.icns'));
  // Not the compiler version: a Command Line Tools update would otherwise rebuild
  // every helper and revoke every grant, for no change a user could see.
  return helperCacheKey([fs.readFileSync(path.join(appDir, h.src)), plist, icon, h.id, h.exe]);
}
