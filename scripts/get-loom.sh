#!/bin/bash
# Install or update Loom from the latest GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/williamhudson1218/loom/main/scripts/get-loom.sh | bash
#
# Downloads the release zip named in latest.json, checks its sha256 and code
# signature, and puts Loom.app in /Applications (or ~/Applications when
# /Applications is not writable). A file fetched with curl is not quarantined,
# so macOS does not show the "could not verify" prompt on first open.
set -euo pipefail

REPO="williamhudson1218/loom"
FEED="https://github.com/$REPO/releases/latest/download/latest.json"

[ "$(uname -s)" = Darwin ] || { echo "Loom runs on macOS only." >&2; exit 1; }
[ "$(uname -m)" = arm64 ] || { echo "Loom is built for Apple Silicon Macs only." >&2; exit 1; }

if pgrep -xq Loom; then
  echo "Loom is running. Quit it first (Loom menu > Quit), then run this again." >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "Checking the latest release..."
curl -fsSL "$FEED" -o "$TMP/latest.json"
field() { /usr/bin/plutil -extract "$1" raw -o - "$TMP/latest.json"; }
VERSION="$(field version)"
ZIP_URL="$(field zip)"
SHA="$(field sha256)"
case "$ZIP_URL" in
  "https://github.com/$REPO/releases/download/"*) ;;
  *) echo "Unexpected download URL: $ZIP_URL" >&2; exit 1 ;;
esac

echo "Downloading Loom $VERSION..."
curl -fL --progress-bar "$ZIP_URL" -o "$TMP/Loom.zip"
echo "$SHA  $TMP/Loom.zip" | shasum -a 256 -c - >/dev/null || { echo "Checksum mismatch; not installing." >&2; exit 1; }

ditto -x -k "$TMP/Loom.zip" "$TMP/x"
codesign --verify --deep --strict "$TMP/x/Loom.app" || { echo "Signature check failed; not installing." >&2; exit 1; }

DEST="${LOOM_DEST:-/Applications}"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }
if [ -d "$DEST/Loom.app" ]; then
  mv "$DEST/Loom.app" "$TMP/Loom.old.app"
fi
ditto "$TMP/x/Loom.app" "$DEST/Loom.app"
xattr -dr com.apple.quarantine "$DEST/Loom.app" 2>/dev/null || true

if [ -n "${LOOM_NO_OPEN:-}" ]; then echo "Installed Loom $VERSION in $DEST."; exit 0; fi
echo "Installed Loom $VERSION in $DEST. Opening it."
open "$DEST/Loom.app"
