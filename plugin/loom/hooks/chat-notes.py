#!/usr/bin/env python3
"""UserPromptSubmit / PostToolUse hook: hand this chat the notes Loom left for it.

Loom writes $LOOM_HOME/chat-notes/<session>.jsonl when it does something on the chat's
behalf, such as sending one of its outbox drafts (src/chatnotes.ts). This hook claims
the file (rename, so a note is delivered once), deletes it and passes the notes on as
additionalContext. No file, no output: the common case costs one stat.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as c  # noqa: E402

SID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


def take(sid):
    """The notes waiting for this session, oldest first; [] when there are none."""
    path = os.path.join(c.loom_home(), "chat-notes", sid + ".jsonl")
    if not os.path.exists(path):
        return []
    claimed = "%s.%d.taking" % (path, os.getpid())
    try:
        os.rename(path, claimed)
    except OSError:
        return []
    notes = []
    try:
        with open(claimed) as f:
            for line in f:
                try:
                    n = json.loads(line)
                except ValueError:
                    continue
                if isinstance(n, dict) and str(n.get("text") or "").strip():
                    notes.append(str(n["text"]))
    except OSError:
        pass
    finally:
        try:
            os.remove(claimed)
        except OSError:
            pass
    return notes


def main():
    if os.environ.get("CLAUDE_CODE_ENTRYPOINT", "cli") != "cli":
        return 0
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    sid = data.get("session_id") or ""
    if not SID.match(sid):
        return 0
    notes = take(sid)
    if not notes:
        return 0
    event = data.get("hook_event_name") or "UserPromptSubmit"
    print(json.dumps({"hookSpecificOutput": {"hookEventName": event, "additionalContext": "\n\n".join(notes)}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
