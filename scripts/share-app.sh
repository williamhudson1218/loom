#!/bin/bash
# Zip a built Loom.app to hand to someone else.
#
#   scripts/share-app.sh [path/to/Loom.app] [out.zip]
#
# Loom is not signed with a Developer ID or notarized. It is ad-hoc signed with
# a valid seal (app/afterpack.cjs), so on the other Mac a downloaded copy gets
# the ordinary "Apple could not verify" warning, which Privacy & Security ›
# Open Anyway gets past, rather than "Loom is damaged". See SETUP.md, "Sharing
# Loom". ditto (not zip) keeps the bundle exactly as signed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-}"
if [ -z "$SRC" ]; then
  SRC="$ROOT/app/release/mac-arm64/Loom.app"
  [ -d "$SRC" ] || SRC="$ROOT/app/release/mac/Loom.app"
fi
[ -d "$SRC" ] || { echo "share-app: no built app at $SRC (run yarn dist in app/)" >&2; exit 1; }

# Refuse to ship a bundle Gatekeeper would call damaged.
codesign --verify --deep --strict "$SRC" || { echo "share-app: $SRC does not pass codesign --verify; rebuild with yarn dist" >&2; exit 1; }

VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$SRC/Contents/Info.plist")"
ARCH="$(lipo -archs "$SRC/Contents/MacOS/Loom" | tr ' ' '-')"
OUT="${2:-$ROOT/app/release/Loom-$VERSION-$ARCH.zip}"
rm -f "$OUT"
ditto -c -k --keepParent "$SRC" "$OUT"
echo "$OUT"
