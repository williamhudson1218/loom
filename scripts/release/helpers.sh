#!/bin/bash
# The native helpers' shared cache: the `helpers` release on GitHub.
#
#   scripts/release/helpers.sh fetch     restore app/build-native/<dir>/Loom.app for
#                                        each helper whose inputs match a cached one
#   scripts/release/helpers.sh publish   upload any helper not cached yet
#
# macOS keys the helpers' Accessibility, Automation and Keychain grants to their
# code hash, so every release must ship the SAME bytes for a helper whose inputs
# (Swift source, Info.plist, icon, CACHE_VERSION; app/nativecache.mjs) did not
# change. CI's swiftc is not trusted to reproduce them: instead each helper ever
# shipped is a `helpers` release asset named by its input key, restored before
# build.mjs runs, and build.mjs keeps a restored bundle whose key matches. Only a
# real input change builds a new one, and that is the one time users re-grant.
#
# The `helpers` release is a prerelease, so /releases/latest (what the updater
# reads) never points at it. Needs gh with a token that can write releases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="${LOOM_REPO:-williamhudson1218/loom}"
TAG=helpers
NATIVE="$ROOT/app/build-native"
cmd="${1:?usage: helpers.sh fetch|publish}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/loom-helpers.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

assets() { gh release view "$TAG" -R "$REPO" --json assets --jq '.assets[].name' 2>/dev/null || true; }
have="$(assets)"

node "$ROOT/app/helperkeys.mjs" | while read -r dir key; do
  name="loom-helper-$dir-$key.zip"
  case "$cmd" in
    fetch)
      if ! grep -qx "$name" <<< "$have"; then echo "helpers: no cached $dir helper for these inputs; build.mjs will build one"; continue; fi
      gh release download "$TAG" -R "$REPO" -p "$name" -D "$TMP"
      rm -rf "${NATIVE:?}/$dir"
      mkdir -p "$NATIVE/$dir"
      ditto -x -k "$TMP/$name" "$NATIVE/$dir"
      codesign --verify --strict "$NATIVE/$dir/Loom.app"
      printf '%s\n' "$key" > "$NATIVE/$dir/Loom.app.key"
      echo "helpers: restored $dir ($(codesign -dvvv "$NATIVE/$dir/Loom.app" 2>&1 | sed -n 's/^CDHash=//p'))"
      ;;
    publish)
      if grep -qx "$name" <<< "$have"; then echo "helpers: $dir already cached"; continue; fi
      [ -d "$NATIVE/$dir/Loom.app" ] || { echo "helpers: no built $dir helper to publish" >&2; exit 1; }
      [ "$(cat "$NATIVE/$dir/Loom.app.key" 2>/dev/null)" = "$key" ] || { echo "helpers: built $dir helper does not match its inputs" >&2; exit 1; }
      if ! gh release view "$TAG" -R "$REPO" > /dev/null 2>&1; then
        gh release create "$TAG" -R "$REPO" --prerelease --title "Helper cache (not a Loom release)" \
          --notes "Native helper bundles keyed by their build inputs, reused by every release so macOS grants survive updates. See scripts/release/helpers.sh. Download Loom from the latest release instead."
      fi
      ditto -c -k --keepParent "$NATIVE/$dir/Loom.app" "$TMP/$name"
      gh release upload "$TAG" -R "$REPO" "$TMP/$name"
      echo "helpers: published $name"
      ;;
    *) echo "usage: helpers.sh fetch|publish" >&2; exit 2 ;;
  esac
done
