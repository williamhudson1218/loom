#!/usr/bin/env python3
"""Stop and Notification hook: tell Loom a chat finished or is blocked, so it can play a sound.

Loom decides whether the sound is worth making (a chat you are not looking at, a turn that ran
long enough, not in quiet hours); this hook only reports. Stop -> `done`, Notification ->
`blocked`. It always exits 0 and never prints, so Loom being down means no sound and no error.

Skips: LOOM_SILENT=1 (workers that should never make noise), a Stop that is about to continue
(stop_hook_active), and Claude Code's "waiting for your input" idle notification, which only
repeats the Stop sound that already played.
"""
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as c  # noqa: E402

EVENTS = {"Stop": "done", "Notification": "blocked"}
TAIL_BYTES = 2 * 1024 * 1024
HTTP_TIMEOUT = 1.0


def turn_started_at(path):
    """Epoch ms of the last real user prompt in the transcript's tail, or None."""
    if not path:
        return None
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            size = f.tell()
            f.seek(max(0, size - TAIL_BYTES))
            raw = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    lines = raw.split("\n")
    if size > TAIL_BYTES:
        lines = lines[1:]  # the first line is cut mid-record
    for line in reversed(lines):
        if not line.startswith("{"):
            continue
        try:
            r = json.loads(line)
        except ValueError:
            continue
        if isinstance(r, dict) and not r.get("isMeta") and c.is_prompt(r):
            return c.epoch_ms(r)
    return None


def event_for(payload):
    """'done', 'blocked' or None for a hook payload."""
    kind = EVENTS.get(payload.get("hook_event_name") or "")
    if kind == "done" and payload.get("stop_hook_active"):
        return None
    if kind == "blocked":
        message = (payload.get("message") or "").lower()
        if payload.get("notification_type") == "idle_prompt" or "waiting for your input" in message:
            return None
    return kind


def main():
    if os.environ.get("LOOM_SILENT") == "1":
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if not isinstance(payload, dict):
        return 0
    kind = event_for(payload)
    if not kind:
        return 0
    body = {
        "event": kind,
        "session_id": payload.get("session_id") or c.session_id(),
        "pane": os.environ.get("TMUX_PANE", ""),
        "transcript_path": payload.get("transcript_path") or "",
    }
    if kind == "done":
        started = turn_started_at(payload.get("transcript_path"))
        if started:
            body["turn_started_at"] = started
    try:
        c.http("POST", "/api/cli/sound-event", body, timeout=HTTP_TIMEOUT)
    except Exception:  # Loom down, no token, a refusal: no sound, no error
        pass
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        sys.exit(0)
