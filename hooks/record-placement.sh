#!/bin/bash
# Loom placement hook — runs on SessionStart and UserPromptSubmit.
# Records which tmux pane this Claude session lives in, so Loom can mark the chat
# "live" and jump Ghostty to it. Fast, best-effort, never blocks the session.
[ -z "$TMUX" ] && exit 0
[ -z "$TMUX_PANE" ] && exit 0

INPUT=$(cat)
SID=$(printf '%s' "$INPUT" | python3 -c 'import sys,json
try:
    print(json.load(sys.stdin).get("session_id",""))
except Exception:
    print("")' 2>/dev/null)
[ -z "$SID" ] && exit 0

INFO=$(tmux display-message -p -t "$TMUX_PANE" \
  '#{session_name}	#{window_index}	#{pane_index}	#{pane_current_path}' 2>/dev/null)
IFS=$'\t' read -r TS WI PI CWD <<< "$INFO"

OUT="$HOME/.claude/tools/chat-manager/placements.jsonl"
python3 -c 'import json,sys,time
print(json.dumps({"session_id":sys.argv[1],"pane_id":sys.argv[2],"tmux_session":sys.argv[3],
  "window_index":sys.argv[4],"pane_index":sys.argv[5],"cwd":sys.argv[6],"ts":int(time.time())}))' \
  "$SID" "$TMUX_PANE" "$TS" "$WI" "$PI" "$CWD" >> "$OUT" 2>/dev/null

exit 0
