#!/bin/bash
# Refuse to publish a Loom.app that carries personal data from the machine or
# the person that built it. Run by .github/workflows/release.yml on every
# release; runnable by hand on a local build too.
#
#   scripts/release/check-personal-data.sh path/to/Loom.app
#
# Fails on:
#   - any /Users/<name> path in app.asar (Loom's own code and its JS deps)
#   - a /Users/<name> path anywhere in the bundle, except the CI runner's own
#     (/Users/runner, compiled into native modules) and sample paths
#   - an email address in Loom's own code (dist/, the plugin) outside example
#     and noreply domains
#   - anything shaped like a Slack, GitHub or AWS token, anywhere
set -euo pipefail

APP="${1:?usage: check-personal-data.sh path/to/Loom.app}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ASAR="$APP/Contents/Resources/app.asar"
[ -f "$ASAR" ] || { echo "check-personal-data: no app.asar in $APP" >&2; exit 1; }
fail=0
bad() { echo "personal data: $*" >&2; fail=1; }

hits=$(LC_ALL=C grep -aoE '/Users/[A-Za-z0-9._-]+' "$ASAR" | sort | uniq -c || true)
[ -z "$hits" ] || bad "app.asar contains home paths:"$'\n'"$hits"

hits=$(LC_ALL=C grep -raoE '/Users/[A-Za-z0-9._-]+' "$APP" 2>/dev/null | sed 's/^[^:]*://' | sort -u | grep -vE '^/Users/(runner|me|Shared|you|username|USER|name|someone|x)$' || true)
[ -z "$hits" ] || bad "the bundle contains home paths: $(echo "$hits" | tr '\n' ' ')"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/loom-pd.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
"$ROOT/app/node_modules/.bin/asar" extract "$ASAR" "$TMP/asar"
own=("$TMP/asar/dist" "$TMP/asar/package.json")
[ -d "$APP/Contents/Resources/plugin" ] && own+=("$APP/Contents/Resources/plugin")
hits=$(LC_ALL=C grep -rhoE '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}' "${own[@]}" 2>/dev/null \
  | grep -vE '@(([A-Za-z0-9-]+\.)*example\.(com|org|net)|users\.noreply\.github\.com|anthropic\.com|[0-9.]+)$' \
  | grep -vE '^[^@]*@[0-9]' | grep -vE '\.(png|svg|js|css|json|md|ts|woff2?)$' | sort -u || true)
[ -z "$hits" ] || bad "Loom's own code contains email addresses: $(echo "$hits" | tr '\n' ' ')"

hits=$(LC_ALL=C grep -raoE 'xox[abposr]-[0-9]{6,}[A-Za-z0-9-]*|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}' "$APP" "$TMP/asar" 2>/dev/null | sed 's/^[^:]*://' | sort -u || true)
[ -z "$hits" ] || bad "token-shaped strings: $(echo "$hits" | tr '\n' ' ')"

[ "$fail" = 0 ] || exit 1
echo "check-personal-data: $APP is clean"
