#!/usr/bin/env bash
# Loom one-shot setup: checks prerequisites, installs deps, and builds the macOS
# app. Safe to re-run. Works from any clone location (it self-locates).
#
#   ./setup.sh          build everything
#   ./setup.sh --install  also copy Loom.app into /Applications
#
# See SETUP.md for the full guide (permissions, the placement hook, gotchas).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

INSTALL=0
[ "${1:-}" = "--install" ] && INSTALL=1

say()  { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

# ── Prerequisite checks ────────────────────────────────────────────────
say "Checking prerequisites"

[ "$(uname -s)" = "Darwin" ] || die "Loom is macOS-only (needs osascript / Ghostty / System Events)."

command -v node >/dev/null || die "node not found. Install Node 20+ (see .nvmrc)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $((NODE_MAJOR)) is too old — Loom needs Node >=20 (see .nvmrc)."
echo "  node $(node -v)"

command -v yarn >/dev/null || die "yarn not found. Install it: npm i -g yarn (or corepack enable)."
echo "  yarn $(yarn -v)"

command -v claude >/dev/null || warn "claude CLI not on PATH — Loom needs it (logged in) to summarize and resume sessions."
command -v tmux   >/dev/null || warn "tmux not found — live detection, jump, resume, branch and restore all need tmux."
command -v ghostty >/dev/null 2>&1 || warn "Ghostty not found — click-to-focus needs it; the rest works in any terminal."

# ── Install + test the CLI/backend ─────────────────────────────────────
say "Installing backend dependencies (root)"
yarn install

say "Running tests"
yarn test

# ── Build the macOS app ────────────────────────────────────────────────
say "Installing app dependencies"
( cd app && yarn install )

say "Building the app (esbuild bundle + native rebuild for Electron)"
( cd app && yarn build && yarn rebuild && yarn dist )

APP="$ROOT/app/release/mac-arm64/Loom.app"
[ -d "$APP" ] || APP="$ROOT/app/release/mac/Loom.app"   # x64 build output dir
[ -d "$APP" ] || die "Build finished but Loom.app was not found under app/release/."
say "Built $APP"

if [ "$INSTALL" = "1" ]; then
  say "Installing to /Applications"
  rm -rf "/Applications/Loom.app"
  cp -R "$APP" "/Applications/Loom.app"
  echo "  copied to /Applications/Loom.app"
fi

# ── Next steps ─────────────────────────────────────────────────────────
say "Done. Remaining manual steps (see SETUP.md):"
cat <<EOF
  1. Register the placement hook in ~/.claude/settings.json under BOTH
     SessionStart and UserPromptSubmit:

       { "type": "command", "command": "$ROOT/hooks/record-placement.sh", "timeout": 5 }

  2. Launch Loom.app. On first run, grant macOS permissions when prompted
     (System Settings › Privacy & Security):
       • Accessibility  — for Ghostty tab focus / pane jumping
       • Automation     — to let Loom control Ghostty & System Events

  3. Data lives in ~/.loom by default (override with \$LOOM_HOME). Nothing is
     written into this repo. Port 4317 must be free.
EOF
