#!/usr/bin/env python3
"""UserPromptSubmit hook: a pasted Slack thread URL is owned by one chat.

  - unowned thread                     -> this chat claims it (a chat may own many)
  - owned by this chat                 -> nothing
  - owned by another chat, and this is this chat's FIRST prompt
                                       -> this chat takes the thread over; the old transcript path is injected
  - owned by another chat, mid-conversation -> context note only, never moved

Ownership lives in Loom. The hook asks Loom who owns each thread (GET /api/cli/threads) and
records claims as events, so a claim made while Loom is down is applied when it comes back.
The hook posts and reacts nothing; whether a paste is a ticket is the chat's call.

Gate: off unless Slack is connected (slack_mode direct or mcp in plugin-state.json).
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as c  # noqa: E402


def owners(keys):
    """{key: owner dict} for threads another source already knows. Empty when Loom is unreachable."""
    out = {}
    for key in keys:
        try:
            r = c.http("GET", "/api/cli/threads?key=" + key.replace("/", "%2F"))
        except (c.LoomUnavailable, c.LoomError):
            return {}
        t = (r.get("threads") or [None])[0] if isinstance(r, dict) else None
        if t and t.get("session_id"):
            out[key] = t
    return out


def context(text):
    print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": text}}))


def label(owner):
    return owner.get("title") or os.path.basename(owner.get("cwd") or "") or (owner.get("session_id") or "")[:8]


def handle(keys, sid, cwd, first, owned):
    claimed = [k for k in keys if k not in owned]
    foreign = {k: o for k, o in owned.items() if o.get("session_id") != sid}
    for k in claimed:
        c.write_event("thread.claim", session=sid, key=k, url=keys[k], cwd=cwd, mode="if_unowned")
    if claimed:
        c.log("claim %s %s" % (sid[:8], claimed))
    if claimed and not foreign:
        context(
            "Slack thread (from the Loom plugin): this chat now owns " + ", ".join(keys[k] for k in claimed)
            + ". Nothing has been posted or reacted yet. Load the loom:handling-slack-threads skill and decide "
            "what this paste is. Default: a ticket to work (`loom thread open <url> [--ack]` for the eyes reaction "
            "and an optional short in-thread ack). Only when it is clearly context or a reference, leave the "
            "thread untouched."
        )
        return
    if not foreign:
        return
    if first:
        lines = []
        for k, o in foreign.items():
            c.write_event("thread.claim", session=sid, key=k, url=keys[k], cwd=cwd, mode="takeover")
            lines.append("- %s was owned by chat “%s”; transcript: %s" % (
                keys[k], label(o), o.get("transcript_path") or "not found"))
        c.log("takeover %s %s" % (sid[:8], list(foreign)))
        context(
            "Slack thread ownership (from the Loom plugin): this chat now owns these threads, taken over from an "
            "earlier chat:\n" + "\n".join(lines)
            + "\nRead the earlier transcript (user prompts and final answers, not tool output) if you need the "
            "history before answering."
        )
        return
    lines = ["- %s is owned by chat “%s” (session %s)" % (keys[k], label(o), o.get("session_id"))
             for k, o in foreign.items()]
    context(
        "Slack thread ownership (from the Loom plugin): these threads already belong to another chat:\n"
        + "\n".join(lines)
        + "\nTreat this as a reference unless the user says to take the thread over; then run "
        "`loom thread claim <url>` to move it to this chat."
    )


def main():
    if os.environ.get("LOOM_THREADS_DISABLE"):
        return 0
    # Headless `claude -p` helper runs (namers, summarizers) paste the same prompt; they must not claim.
    if os.environ.get("CLAUDE_CODE_ENTRYPOINT", "cli") != "cli":
        return 0
    if not c.slack_on(c.read_plugin_state()):
        return 0
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return 0
    prompt = data.get("prompt") or ""
    sid = data.get("session_id") or ""
    keys = c.thread_keys(prompt) if sid else {}
    if not keys:
        return 0
    cwd = data.get("cwd") or os.getcwd()
    first = c.is_first_prompt(data.get("transcript_path"), prompt)
    handle(keys, sid, cwd, first, owners(keys))
    return 0


if __name__ == "__main__":
    sys.exit(main())
