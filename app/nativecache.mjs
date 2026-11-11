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
