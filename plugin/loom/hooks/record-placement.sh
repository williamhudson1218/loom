#!/bin/bash
# Loom placement hook — runs on SessionStart and UserPromptSubmit.
# Records which tmux pane this agent session lives in, so Loom can mark the chat
# "live" and jump Ghostty to it. Fast, best-effort, never blocks the session.
#
# Installed for BOTH agents: Claude reads it from ~/.claude/settings.json, Codex
# from ~/.codex/hooks.json. Codex's hook payload is Claude-compatible (same
# session_id / transcript_path / cwd / hook_event_name keys), so one script serves
# both — it just has to record WHICH agent it was, since a session id alone is
# ambiguous across the two.
[ -z "$TMUX" ] && exit 0
[ -z "$TMUX_PANE" ] && exit 0

INPUT=$(cat)
# Emit "<session_id> <agent>". The agent is read off transcript_path: Codex writes
# ~/.codex/sessions/<date>/rollout-<ts>-<id>.jsonl, Claude writes
# ~/.claude/projects/<enc-cwd>/<id>.jsonl. The rollout- basename is Codex-specific,
# and $CODEX_HOME (exported into Codex hook processes) is a second signal.
read -r SID AGENT <<< "$(printf '%s' "$INPUT" | python3 -c 'import sys,json,os
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
sid = d.get("session_id") or ""
if not sid:
    sys.exit(0)
tp = d.get("transcript_path") or ""
base = os.path.basename(tp)
codex = base.startswith("rollout-") or "/.codex/" in tp or bool(os.environ.get("CODEX_HOME"))
print(sid, "codex" if codex else "claude")' 2>/dev/null)"
[ -z "$SID" ] && exit 0
[ -z "$AGENT" ] && AGENT=claude

INFO=$(tmux display-message -p -t "$TMUX_PANE" \
  '#{session_name}	#{window_index}	#{pane_index}	#{pane_current_path}' 2>/dev/null)
IFS=$'\t' read -r TS WI PI CWD <<< "$INFO"

# Resolve Loom's data dir the SAME way src/paths.ts does, so the hook and the app
# always agree without any env passing between them (the Finder-launched app can't
# see this shell's env): $LOOM_HOME, else the legacy dir if it exists, else ~/.loom.
if [ -n "$LOOM_HOME" ]; then
  LOOM_DIR="$LOOM_HOME"
elif [ -d "$HOME/.claude/tools/chat-manager" ]; then
  # Legacy single-machine install, where the repo was also the data dir. Kept as a
  # back-compat fallback only; this repo now lives at ~/dev/loom and its data in ~/.loom.
  LOOM_DIR="$HOME/.claude/tools/chat-manager"
else
  LOOM_DIR="$HOME/.loom"
fi
mkdir -p "$LOOM_DIR" 2>/dev/null
OUT="$LOOM_DIR/placements.jsonl"
python3 -c 'import json,sys,time
print(json.dumps({"agent":sys.argv[7],"session_id":sys.argv[1],"pane_id":sys.argv[2],"tmux_session":sys.argv[3],
  "window_index":sys.argv[4],"pane_index":sys.argv[5],"cwd":sys.argv[6],"ts":int(time.time())}))' \
  "$SID" "$TMUX_PANE" "$TS" "$WI" "$PI" "$CWD" "$AGENT" >> "$OUT" 2>/dev/null

exit 0
