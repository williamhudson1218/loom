#!/bin/bash
# Fail when any Mach-O in a Loom.app is not exactly the expected arch, so an
# arm64 release never carries an Intel binary (macOS's Rosetta deprecation scan
# would flag the app for it).
#
#   scripts/release/check-arch.sh path/to/Loom.app [arch]   (default arm64)
set -euo pipefail
APP="${1:?usage: check-arch.sh path/to/Loom.app [arch]}"
WANT="${2:-arm64}"
bad=0; n=0
while IFS= read -r -d '' f; do
  file -b "$f" | grep -q 'Mach-O' || continue
  n=$((n + 1))
  a="$(lipo -archs "$f" 2>/dev/null || echo unknown)"
  if [ "$a" != "$WANT" ]; then echo "check-arch: $a ${f#"$APP"/}" >&2; bad=1; fi
done < <(find "$APP" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -print0)
[ "$bad" = 0 ] || { echo "check-arch: $APP has Mach-O files that are not $WANT" >&2; exit 1; }
echo "check-arch: all $n Mach-O files in $APP are $WANT"
