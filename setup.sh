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

[ "$(uname -s)" = "Darwin" ] || die "Loom is macOS-only (needs osascript / System Events)."

command -v node >/dev/null || die "node not found. Install Node 20+ (see .nvmrc)."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $((NODE_MAJOR)) is too old — Loom needs Node >=20 (see .nvmrc)."
echo "  node $(node -v)"

command -v yarn >/dev/null || die "yarn not found. Install it: npm i -g yarn (or corepack enable)."
echo "  yarn $(yarn -v)"

command -v claude >/dev/null || warn "claude CLI not on PATH — Loom needs it (logged in) to summarize and resume sessions."
# tmux is required: it is what keeps chats alive when Loom quits, and what Loom
# types into. Install it with Homebrew if it is missing.
if ! command -v tmux >/dev/null; then
  if command -v brew >/dev/null; then
    say "Installing tmux (Homebrew)"
    brew install tmux
  else
    die "tmux not found and Homebrew isn't installed. Install tmux (https://github.com/tmux/tmux/wiki/Installing) and re-run."
  fi
fi
TMUX_VERSION="$(tmux -V | awk '{print $2}')"
echo "  tmux $TMUX_VERSION"
# 3.6a's server aborts (SIGABRT) in copy-mode, and with mouse on every scroll
# goes through copy-mode: one crash takes every session with it.
[ "$TMUX_VERSION" = "3.6a" ] && warn "tmux 3.6a crashes in copy-mode and takes every session down. Upgrade: brew upgrade tmux"

# ── Install + test the CLI/backend ─────────────────────────────────────
say "Installing backend dependencies (root)"
yarn install

say "Running tests"
yarn test

# ── Loom's tmux ────────────────────────────────────────────────────────
# Loom's data dir, resolved exactly as src/paths.ts and the placement hook do.
if [ -n "${LOOM_HOME:-}" ]; then LOOM_DIR="$LOOM_HOME"
elif [ -d "$HOME/.claude/tools/chat-manager" ]; then LOOM_DIR="$HOME/.claude/tools/chat-manager"
else LOOM_DIR="$HOME/.loom"; fi
mkdir -p "$LOOM_DIR"

say "Installing Loom's tmux config"
# Only the server on Loom's own socket loads this; your ~/.tmux.conf is untouched.
# An existing copy is yours to edit, so it is never overwritten.
if [ -f "$LOOM_DIR/tmux.conf" ]; then
  echo "  kept existing $LOOM_DIR/tmux.conf"
else
  cp "$ROOT/app/assets/tmux.conf" "$LOOM_DIR/tmux.conf"
  echo "  wrote $LOOM_DIR/tmux.conf"
fi

# Loom's settings: nothing is written here. The first time Loom opens its
# database it decides (src/migrate.ts): a brand-new install gets the new-user
# defaults and the setup wizard (Loom's own tmux server, normal permissions, the
# orchestrator and watchers off); an existing install keeps every value it has,
# written out explicitly, with a backup of manager.db made first.
#
# The orchestrator's folder is NOT pre-trusted in ~/.claude.json any more: the
# wizard's orchestrator step (or Settings › Orchestrator) asks first.
#
# The placement hook: Claude Code gets it from the Loom plugin, installed from
# the wizard or Settings › Helpers, so ~/.claude/settings.json is never edited.
# Codex has no plugin, so it gets the hook in ~/.codex/hooks.json, and only after
# you have seen the exact change and said yes.
say "Codex placement hook"
if [ ! -d "$HOME/.codex" ]; then
  echo "  Codex is not installed: skipped"
else
  node "$ROOT/scripts/install-hook.mjs" "$ROOT/hooks/record-placement.sh"
  if [ -t 0 ] && ! node -e "process.exit(require('fs').readFileSync(process.env.HOME + '/.codex/hooks.json', 'utf-8').includes('record-placement.sh') ? 0 : 1)" 2>/dev/null; then
    read -r -p "  Make this change to ~/.codex/hooks.json? [y/N] " ANSWER
    case "$ANSWER" in
      [yY]*) node "$ROOT/scripts/install-hook.mjs" "$ROOT/hooks/record-placement.sh" --yes ;;
      *) echo "  left ~/.codex/hooks.json unchanged (Settings › Helpers can add it later)" ;;
    esac
  fi
fi

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
  # Never rm -rf + cp over a live bundle: a Loom launched mid-copy crashes (see the script).
  "$ROOT/scripts/install-app.sh" "$APP" --no-open
fi

# ── Next steps ─────────────────────────────────────────────────────────
say "Done. Remaining manual steps (see SETUP.md):"
cat <<EOF
  1. Launch Loom.app. On first run, grant macOS permissions when prompted
     (System Settings > Privacy & Security):
       - Accessibility: only for the Slack hotkey (reads the message under the
         cursor) and for Ghostty tab focus, if you use Ghostty
       - Automation: only if you jump into Ghostty, iTerm2 or Terminal.app

  2. Loom opens its setup wizard on first launch: it installs the Loom plugin
     (the placement hook and helpers) and asks before changing anything outside
     Loom's own data folder.

  3. Data lives in ~/.loom by default (override with \$LOOM_HOME). Nothing is
     written into this repo. Loom serves on port 4317, or the next free port up to 4326.
EOF
