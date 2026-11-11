#!/bin/bash
# loom-port.sh: print the port this user's Loom serves on. Source it for loom_port().
#
# localhost is shared by every macOS user on the Mac, so Loom moves off 4317 when
# something else holds it. Order: $LOOM_PORT, then $LOOM_HOME/server.json when its
# process is alive, then 4317. Needs only sed and kill.

loom_port() {
  local p home f pid
  p="${LOOM_PORT:-}"
  if [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -gt 0 ] && [ "$p" -le 65535 ]; then echo "$p"; return; fi
  home="${LOOM_HOME:-}"
  if [ -z "$home" ]; then
    if [ -d "$HOME/.claude/tools/chat-manager" ]; then home="$HOME/.claude/tools/chat-manager"; else home="$HOME/.loom"; fi
  fi
  f="$home/server.json"
  if [ -r "$f" ]; then
    p=$(sed -n 's/.*"port"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)
    pid=$(sed -n 's/.*"pid"[^0-9]*\([0-9][0-9]*\).*/\1/p' "$f" | head -1)
    if [ -n "$p" ] && [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then echo "$p"; return; fi
  fi
  echo 4317
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then loom_port; fi
