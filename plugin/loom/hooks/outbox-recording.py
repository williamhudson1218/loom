#!/usr/bin/env python3
"""Stop hook: a Slack draft shown in chat for approval must be recorded in the Loom outbox.

Every draft shown for approval is recorded with `loom outbox add`, so the user can send it from
Loom. On Stop, read the last assistant turn (everything after the last real user prompt). If its
closing text looks like a Slack draft (draft cue + blockquote or numbered message block) and the
turn made no `loom outbox add|update|supersede` call, block once.

Skips: stop_hook_active (no loops), turns that report a send, and drafts whose text already
appears in an earlier tool call this session (recorded before, unchanged).

Gate: off unless Slack is connected and `outbox_chat_drafts` is on in plugin-state.json.
The payload's `last_assistant_message` wins over the transcript, which may not be flushed yet.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as c  # noqa: E402

records, blocks, is_prompt = c.records, c.blocks, c.is_prompt

STRONG = re.compile(
    r"OK to send|okay to send|ready to send|send it\?|say\s+[\"“']?send|"
    r"what to send\s+\w+|go-ahead to send|"
    r"\bsend (it|this|that|these|them|all|both|the (reply|draft|set|message))\b[^\n.]{0,40}\?|"
    r"\bshould i (send|post)\b",
    re.I,
)
WEAK = re.compile(r"\bdraft(ed)?\s+(reply|to|for|message|post|dm|response)\b|\bdraft:", re.I)
SENT = re.compile(r"\b(i\s+)?(sent|posted)\b|\bhas been (sent|posted)\b|\bit('s| is) (sent|posted|live)\b", re.I)
QUOTE = re.compile(r"^\s*>\s?(.*)$", re.M)
NUMBERED = re.compile(r"^\s*(?:>\s*)?(\d+)[.)]\s+\S", re.M)
# `slack-threads outbox …` is an older CLI some setups forward to `loom`; count it too.
OUTBOX_CALL = re.compile(r"\b(?:loom|slack-threads)\b[^\n]*\boutbox\s+(add|update|supersede)\b")

REASON = (
    "You showed a Slack draft but did not record it in the Loom outbox. Write each message to a file and run "
    "`loom outbox add --thread <url> (or --channel <id|#name|@user>) --text-file m1.md [--text-file m2.md ...]`, "
    "then mention the draft id in one line under the draft. When the draft REPLIES in a thread, pass "
    "`--thread <url>` (not --channel): Loom needs it to watch that thread for the answer. Revise a recorded "
    "draft with `loom outbox update <id> --text-file m1.md`, or record the new text with `loom outbox add` "
    "(it supersedes the old one). Re-record after every redraft."
)


def norm(s):
    return re.sub(r"\s+", " ", s).strip().lower()


def analyse(recs, final_override=None):
    """Return the reason string to block with, or None."""
    start = 0
    for i, r in enumerate(recs):
        if is_prompt(r):
            start = i + 1
    turn = [r for r in recs[start:] if r.get("type") == "assistant"]
    texts, calls = [], []
    for r in turn:
        for b in blocks(r):
            if b.get("type") == "text":
                texts.append(b.get("text") or "")
            elif b.get("type") == "tool_use":
                calls.append(json.dumps(b.get("input") or {}))
    # Final message only: the closing text is what the user reads and answers.
    final = final_override or ""
    for t in reversed(texts if not final else []):
        if t.strip():
            final = t
            break
    if not final:
        return None
    quote = "\n".join(m.group(1) for m in QUOTE.finditer(final)).strip()
    numbered = len(NUMBERED.findall(final)) >= 2
    if not (len(quote) >= 12 or numbered):
        return None
    strong = bool(STRONG.search(final))
    if not (strong or (WEAK.search(final) and not SENT.search(final))):
        return None
    if any(OUTBOX_CALL.search(x) for x in calls):
        return None
    body = norm(quote) if len(quote) >= 12 else ""
    if body:
        for r in recs[:start]:
            if r.get("type") != "assistant":
                continue
            for b in blocks(r):
                if b.get("type") == "tool_use" and body in norm(json.dumps(b.get("input") or {}).replace("\\n", " ")):
                    return None
    return REASON


def _ends_with_text(recs):
    for r in reversed(recs):
        if r.get("type") == "assistant":
            return any(b.get("type") == "text" and (b.get("text") or "").strip() for b in blocks(r))
        if is_prompt(r):
            return False
    return False


def main():
    state = c.read_plugin_state()
    if not (c.slack_on(state) and state.get("outbox_chat_drafts")):
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if payload.get("stop_hook_active"):
        return 0
    path = payload.get("transcript_path") or ""
    if not path:
        return 0
    last = payload.get("last_assistant_message")
    last = last if isinstance(last, str) and last.strip() else None
    recs = records(path)
    if last is None and not _ends_with_text(recs):
        time.sleep(0.5)
        recs = records(path)
    reason = analyse(recs, last)
    c.log("outbox %s %s final=%s" % (str(payload.get("session_id") or "")[:8], "block" if reason else "pass",
                                      "payload" if last else "transcript"))
    if reason:
        print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
