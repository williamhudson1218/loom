#!/bin/bash
# Install a freshly built Loom.app over the running one, without ever pulling the
# bundle out from under a live Loom.
#
#   scripts/install-app.sh [path/to/Loom.app | path/to/Loom-*.zip | --release [version]] [--no-open]
#
# The normal way Loom changes is its own updater (src/updater.ts, GitHub
# Releases). This is the fallback when the updater is broken, and the way to
# install a local build: a built app, a release zip, or `--release` to fetch the
# newest (or a given) GitHub release with gh and verify it against SHA256SUMS.
#
# Why this exists (2026-11-06 08:46 crash): the old recipe was
#   osascript quit; sleep 3; rm -rf /Applications/Loom.app; cp -R …; open …
# Will clicked Loom in the Dock during the `sleep 3` (it had just vanished), so
# LaunchServices started the OLD bundle at 08:46:00.8. The `rm -rf` at 08:46:01.1
# then deleted that bundle while the new process was still loading files from it,
# and the copy rewrote them; V8 hit a fatal CHECK (EXC_BREAKPOINT/SIGTRAP on
# CrBrowserMain) at 08:46:01.28. Any launch inside a quit→delete→copy gap does this.
#
# So the order here is: copy the new bundle to a staging path FIRST (slow part, no
# Loom affected), then quit Loom and poll until its main process has really
# exited, re-quitting if something relaunched it, then swap with two renames (a
# window of microseconds, not seconds), then open. It never kills Loom: if Loom
# will not quit, it gives up and leaves the installed app untouched.
#
# The updater's apply script and this installer take the same lock
# (~/Library/Caches/Loom/updates/swap.lock), so they never swap at once, and this
# drops skip-apply-on-quit there first so the quit it sends does not make Loom
# install a downloaded update over the one being installed here.
#
# Env overrides (tests): LOOM_APP_DEST, LOOM_QUIT_TIMEOUT (s), LOOM_PORT, LOOM_HOME,
# LOOM_INSTALL_TRACE (file the steps are appended to), LOOM_UPDATE_CACHE.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC=""
OPEN=1
RELEASE=""
WANT_RELEASE=0
for a in "$@"; do
  case "$a" in
    --no-open) OPEN=0 ;;
    --release) WANT_RELEASE=1 ;;
    *) if [ "$WANT_RELEASE" = 1 ] && [ -z "$RELEASE" ] && [[ "$a" =~ ^v?[0-9]+(\.[0-9]+)*$ ]]; then RELEASE="$a"; else SRC="$a"; fi ;;
  esac
done
CACHE="${LOOM_UPDATE_CACHE:-$HOME/Library/Caches/Loom/updates}"
UNPACK=""
cleanup_unpack() { [ -n "$UNPACK" ] && rm -rf "$UNPACK"; return 0; }

# --release [version]: download the release zip and SHA256SUMS with gh, check the sum.
if [ "$WANT_RELEASE" = 1 ]; then
  command -v gh > /dev/null || { echo "install-app: --release needs gh" >&2; exit 1; }
  UNPACK="$(mktemp -d "${TMPDIR:-/tmp}/loom-install.XXXXXX")"
  tag=""; [ -n "$RELEASE" ] && tag="v${RELEASE#v}"
  # shellcheck disable=SC2086
  gh release download $tag -R williamhudson1218/loom -p 'Loom-*.zip' -p SHA256SUMS -D "$UNPACK" || { cleanup_unpack; echo "install-app: could not download the release" >&2; exit 1; }
  (cd "$UNPACK" && shasum -a 256 -c SHA256SUMS) || { cleanup_unpack; echo "install-app: the release zip does not match SHA256SUMS" >&2; exit 1; }
  SRC="$(find "$UNPACK" -maxdepth 1 -name 'Loom-*.zip' | head -1)"
fi
# A zip (a release asset, or share-app.sh's output): unpack it with ditto first.
if [ -n "$SRC" ] && [ -f "$SRC" ] && [[ "$SRC" == *.zip ]]; then
  [ -n "$UNPACK" ] || UNPACK="$(mktemp -d "${TMPDIR:-/tmp}/loom-install.XXXXXX")"
  ditto -x -k "$SRC" "$UNPACK/app" || { cleanup_unpack; echo "install-app: could not unpack $SRC" >&2; exit 1; }
  SRC="$UNPACK/app/Loom.app"
  codesign --verify --deep --strict "$SRC" || { cleanup_unpack; echo "install-app: $SRC does not pass codesign --verify" >&2; exit 1; }
fi
if [ -z "$SRC" ]; then
  SRC="$ROOT/app/release/mac-arm64/Loom.app"
  [ -d "$SRC" ] || SRC="$ROOT/app/release/mac/Loom.app"
fi
DEST="${LOOM_APP_DEST:-/Applications/Loom.app}"
EXE="$DEST/Contents/MacOS/Loom"
TIMEOUT="${LOOM_QUIT_TIMEOUT:-20}"
# shellcheck source=loom-port.sh
. "$ROOT/scripts/loom-port.sh"
TRACE="${LOOM_INSTALL_TRACE:-/dev/null}"

trace() { echo "$*" >> "$TRACE"; }
die() { echo "install-app: $*" >&2; trace "abort $*"; exit 1; }

[ -x "$SRC/Contents/MacOS/Loom" ] || die "no built app at $SRC (run yarn dist in app/)"

# The GUI main process only. Its argv is exactly the executable path; the
# ELECTRON_RUN_AS_NODE children Claude sessions run from the bundle (the
# orchestrator MCP server) carry a script argument and are not waited on.
running() { pgrep -xf "$EXE" > /dev/null 2>&1; }

STAGE="$DEST.installing.$$"
OLD="$DEST.replaced.$$"
LOCK="$CACHE/swap.lock"
LOCKED=0
cleanup() { rm -rf "$STAGE"; cleanup_unpack; if [ "$LOCKED" = 1 ]; then rm -f "$CACHE/skip-apply-on-quit"; rmdir "$LOCK" 2>/dev/null; fi; return 0; }
trap cleanup EXIT

# One swap at a time: the updater's apply script takes this lock too. A lock
# older than 10 minutes is left over from a crash.
mkdir -p "$CACHE"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOCK" 2>/dev/null || true; mkdir "$LOCK" 2>/dev/null || die "an update is being installed right now; try again in a minute"
  else die "an update is being installed right now; try again in a minute"; fi
fi
LOCKED=1
# The quit below must not make Loom install a downloaded update of its own.
touch "$CACHE/skip-apply-on-quit"

trace "stage"
rm -rf "$STAGE"
cp -R "$SRC" "$STAGE"
xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true

# Quit, and keep quitting until Loom stays gone. `tell application` would LAUNCH
# a Loom that is not running, so only ever send it to a running one.
deadline=$(( $(date +%s) + TIMEOUT ))
while running; do
  trace "quit"
  osascript -e 'tell application id "com.loom.app" to quit' > /dev/null 2>&1 || true
  while running; do
    [ "$(date +%s)" -lt "$deadline" ] || die "Loom did not quit within ${TIMEOUT}s; left $DEST as it was"
    sleep 0.2
  done
  # A Dock click or login item can relaunch it the instant it exits. Settle, and
  # loop back to quit again if it did.
  sleep 0.5
done

trace "swap"
if [ -e "$DEST" ]; then mv "$DEST" "$OLD"; fi
mv "$STAGE" "$DEST"
rm -rf "$OLD"
echo "installed $DEST ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$DEST/Contents/Info.plist" 2>/dev/null || echo '?'))"

if [ "$OPEN" = "1" ]; then
  trace "open"
  open "$DEST"
  code=000
  PORT=4317
  for _ in $(seq 1 30); do
    # The new Loom may take another port when 4317 is held; it writes server.json once it listens.
    PORT=$(loom_port)
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT/" || true)
    [ "$code" = "200" ] && break
    sleep 1
  done
  echo "localhost:$PORT -> $code"
  [ "$code" = "200" ] || exit 2
fi
