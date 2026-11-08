#!/usr/bin/env python3
"""PreToolUse hook: a chat may post to Slack only a draft that is already in the Loom outbox.

The Stop hook (outbox-recording.py) runs after the turn, so it can only nag about a draft
that was shown; it cannot stop a post that already went out. A chat that skips the draft
step and sends on "send" (2026-11-06: a revised draft shown only in chat, then posted with
the Slack CLI on "yep send" and recorded in the outbox after the fact) gets past it. This
hook runs before the tool call instead and denies a Slack post unless THIS session has a
pending outbox draft for the same destination whose text matches what is being sent.

What counts as a post (mirrors src/outboxwatch.ts isBashSend / postsDraft):
  - Bash: the Slack CLI's `send` (slack.mjs send, `slack send`), `slack-threads send`,
    or any chat.postMessage / chat.scheduleMessage call. `preview`, `draft`, reads and
    reactions are not posts.
  - MCP: a tool whose name has slack + send|post|schedule and not draft.

Never blocked: Loom's own Send button and its in-process sender (no tool call), and every
non-posting Slack call. Gate: on only when Slack is connected (slack_mode direct|mcp) and
`outbox_chat_drafts` is on, unless `outbox_guard` is set explicitly in plugin-state.json.

Matching a draft: same session, status pending (drafts Loom has not ingested yet count, from
<LOOM_HOME>/events). A known thread_ts must equal the draft's; a known channel id must equal
the draft's when both are ids; the opening of each message sent must appear in the draft.
When the call's payload cannot be read (a --file written by the same command), whatever
destination it does show must match, and with nothing readable at all any pending draft of
this session is accepted rather than blocking a send the hook cannot see into.
"""
import json
import os
import re
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as c  # noqa: E402

SEGMENT = re.compile(r"\|\||&&|[;|&\n]")
# slack.mjs anywhere in the segment; a bare `slack` binary only in command position (not prose in a -m).
CLI_SEND = re.compile(r"slack\.mjs\s+(?:send|post)\b|^\s*(?:\w+=\S*\s+)*(?:\S*/)?slack\s+(?:send|post)\b", re.I)
THREADS_SEND = re.compile(r"slack-threads\S*\s+send\b")
# The Web API by URL (curl, a urllib one-liner), or chat.postMessage handed to curl/wget. A bare
# `chat.postMessage` in a grep or a code edit is not a post.
API_POST = re.compile(r"slack\.com/api/chat\.(?:postMessage|scheduleMessage)\b|\b(?:curl|wget)\b.*\bchat\.(?:postMessage|scheduleMessage)\b")
NOT_POST = re.compile(r"\bpreview\b|--dry-run\b")
MCP_SEND = re.compile(r"slack.*(send|post|schedule)", re.I)
SLACK_ID = re.compile(r"^[CDGU][A-Z0-9]{6,}$")
TS = re.compile(r"^\d{10}\.\d{6}$")


HEREDOC = re.compile(r"(<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n)(.*?\n)(\s*\2\b)", re.S)


def without_heredocs(cmd):
    """The command with heredoc bodies dropped: a body is data (a payload, a file being written, a test
    that mentions `slack.mjs send`), not a command that runs. Payloads are still read from it by extract()."""
    return HEREDOC.sub(lambda m: m.group(1) + m.group(4), cmd or "")


def is_bash_send(cmd):
    """True when any segment of the command posts to Slack (a preview segment beside it does not hide it)."""
    cmd = without_heredocs(cmd)
    # S=~/.claude/tools/slack/slack.mjs; node $S send ...  (the overnight-slack form)
    aliases = re.findall(r"\b(\w+)=['\"]?\S*slack\.mjs\b", cmd)
    via_alias = re.compile(r"\$\{?(?:%s)\}?['\"]?\s+(?:send|post)\b" % "|".join(map(re.escape, aliases))) if aliases else None
    for seg in SEGMENT.split(cmd or ""):
        if NOT_POST.search(seg):
            continue
        if CLI_SEND.search(seg) or THREADS_SEND.search(seg) or API_POST.search(seg):
            return True
        if via_alias and via_alias.search(seg):
            return True
    return False


def is_send_call(name, inp):
    if name == "Bash":
        return is_bash_send(str((inp or {}).get("command") or ""))
    return bool(MCP_SEND.search(name or "")) and "draft" not in (name or "").lower()


# ---------- what the call is sending ----------

def _payload_texts(p):
    if not isinstance(p, dict):
        return []
    if isinstance(p.get("messages"), list):
        return [str(m) for m in p["messages"] if isinstance(m, str)]
    for k in ("text", "message"):
        if isinstance(p.get(k), str):
            return [p[k]]
    return []


def _from_payload(p, out):
    if not isinstance(p, dict) or not (p.get("channel") or p.get("channel_id")):
        return False
    out["channel"] = out["channel"] or str(p.get("channel") or p.get("channel_id"))
    if p.get("thread_ts") and not out["thread_ts"]:
        out["thread_ts"] = str(p["thread_ts"])
    out["texts"] = out["texts"] or _payload_texts(p)
    return True


def _json_objects(cmd):
    """JSON objects embedded in a command: heredoc bodies, then any balanced {...} that parses."""
    found = []
    for m in re.finditer(r"<<-?\s*['\"]?(\w+)['\"]?[^\n]*\n(.*?)\n\s*\1\b", cmd, re.S):
        found.append(m.group(2))
    for n, m in enumerate(re.finditer(r"\{", cmd)):
        if n >= 50:
            break
        depth, i = 0, m.start()
        for j in range(i, min(len(cmd), i + 200000)):
            ch = cmd[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    found.append(cmd[i:j + 1])
                    break
    out = []
    for s in found:
        try:
            o = json.loads(s)
        except ValueError:
            continue
        if isinstance(o, dict):
            out.append(o)
    return out


def extract(name, inp, cwd=None):
    """{channel, thread_ts, texts} for a posting call; any field may be empty (unknown)."""
    inp = inp or {}
    out = {"channel": "", "thread_ts": "", "texts": [], "parsed": False}
    if name != "Bash":
        out["parsed"] = _from_payload(inp, out)
        return out
    cmd = str(inp.get("command") or "")
    for o in _json_objects(cmd):
        if _from_payload(o, out):
            out["parsed"] = True
            break
    m = re.search(r"--file\s+(['\"]?)([^\s'\"]+)\1", cmd)
    if m and not out["channel"]:
        path = os.path.expanduser(m.group(2))
        if not os.path.isabs(path):
            # `cd <dir> && node slack.mjs send --file x.json`: resolve against the last cd.
            cds = re.findall(r"\bcd\s+(['\"]?)([^\s;&|'\"]+)\1", cmd)
            base = os.path.expanduser(cds[-1][1]) if cds else (cwd or os.getcwd())
            path = os.path.join(base, path)
        try:
            with open(path) as f:
                out["parsed"] = _from_payload(json.load(f), out)
        except (OSError, ValueError):
            pass
    if not out["channel"]:
        m = re.search(r"""['"\\]*channel(?:_id)?['"\\]*\s*[:=]\s*['"\\]*([#@]?[\w.-]+)""", cmd)
        if m:
            out["channel"] = m.group(1)
    if not out["thread_ts"]:
        m = re.search(r"""thread_ts['"\\]*\s*[:=]\s*['"\\]*(\d{10}\.\d{6})""", cmd)
        if m:
            out["thread_ts"] = m.group(1)
    return out


# ---------- the outbox ----------

def load_drafts(home=None):
    """{id: draft} from <LOOM_HOME>/outbox.json with not-yet-ingested outbox events applied on top."""
    home = home or c.loom_home()
    drafts = {}
    path = os.path.join(home, "outbox.json")
    for attempt in (0, 1):
        try:
            with open(path) as f:
                data = json.load(f)
            raw = data.get("drafts") if isinstance(data, dict) else None
            drafts = {k: dict(v) for k, v in (raw or {}).items() if isinstance(v, dict)}
            break
        except OSError:
            break
        except ValueError:
            if attempt == 0:
                time.sleep(0.2)
    for e in c.pending_events():
        kind, did = e.get("kind"), e.get("id")
        if not did:
            continue
        if kind == "outbox.add":
            for d in drafts.values():
                if (d.get("status") == "pending" and d.get("session_id") == e.get("session")
                        and d.get("channel") == e.get("channel") and d.get("thread_ts") == e.get("thread_ts")):
                    d["status"] = "superseded"
            drafts[did] = {"id": did, "session_id": e.get("session"), "channel": e.get("channel"),
                           "thread_ts": e.get("thread_ts"), "messages": e.get("messages") or [],
                           "status": "pending"}
        elif kind == "outbox.update" and did in drafts and drafts[did].get("status") == "pending":
            drafts[did]["messages"] = e.get("messages") or drafts[did].get("messages") or []
        elif kind == "outbox.supersede" and did in drafts and drafts[did].get("status") == "pending":
            drafts[did]["status"] = "superseded"
    return drafts


# ---------- matching ----------

def norm(s):
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def _text_ok(texts, d):
    if not texts:
        return None
    hay = norm(" ".join(str(m) for m in d.get("messages") or []))
    for t in texts:
        head = norm(t)[:40]
        if head and head not in hay:
            return False
    return True


def draft_matches(call, d):
    """True / False, or None when the call shows nothing to compare against."""
    checks = []
    ch, dch = call.get("channel") or "", str(d.get("channel") or "")
    if ch and SLACK_ID.match(ch) and SLACK_ID.match(dch):
        checks.append(ch == dch)
    elif ch and dch and not SLACK_ID.match(ch) and not SLACK_ID.match(dch):
        checks.append(ch.lstrip("#@").lower() == dch.lstrip("#@").lower())
    th = call.get("thread_ts") or ""
    if th and TS.match(th):
        checks.append(th == (d.get("thread_ts") or ""))
    elif call.get("parsed") and ch and not th and SLACK_ID.match(ch) and SLACK_ID.match(dch):
        # A parsed payload with no thread_ts posts top-level: a thread draft is not this message.
        checks.append(not d.get("thread_ts"))
    t = _text_ok(call.get("texts"), d)
    if t is not None:
        checks.append(t)
    if not checks:
        return None
    return all(checks)


RECENT_CHAT_SENT_S = 30 * 60


def _epoch(stamp):
    """A store stamp (local 'YYYY-MM-DDTHH:MM:SS') as epoch seconds, or None."""
    try:
        return time.mktime(time.strptime(str(stamp)[:19], "%Y-%m-%dT%H:%M:%S"))
    except (ValueError, OverflowError):
        return None


def _covers(d, now):
    if d.get("status") == "pending":
        return True
    # A draft the CHAT was marked as having sent, in the last half hour, still covers the post: Loom's
    # transcript watcher has marked drafts sent the moment they were recorded (a read of the thread
    # looked like a send), and the chat's own send that follows is the real one. Older marks do not:
    # an unreadable payload must not ride on a days-old draft to the same thread.
    if d.get("status") == "sent" and d.get("sent_by") != "loom":
        t = _epoch(d.get("closed_at") or d.get("created_at"))
        return t is not None and now - t <= RECENT_CHAT_SENT_S
    return False


def decide(call, drafts, session, now=None):
    """None to allow, else the reason to deny with."""
    now = time.time() if now is None else now
    mine = [d for d in drafts.values() if d.get("session_id") == session]
    pending = [d for d in mine if _covers(d, now)]
    hits = [draft_matches(call, d) for d in pending]
    if any(h is True for h in hits):
        return None
    if pending and all(h is None for h in hits):
        return None  # nothing readable in the call to compare; a draft is on record
    dest = call.get("channel") or "this destination"
    if call.get("thread_ts"):
        dest += " thread " + call["thread_ts"]
    sent = [d for d in mine if d.get("status") == "sent" and d.get("sent_by") == "loom" and draft_matches(call, d)]
    if sent:
        return ("Blocked: this Slack post matches outbox draft %s, which is already %s%s. Do not send it "
                "again. Read the thread to see what was posted." % (
                    sent[-1].get("id"), "sent" + (" from Loom" if sent[-1].get("sent_by") == "loom" else ""),
                    (" (" + sent[-1]["permalink"] + ")") if sent[-1].get("permalink") else ""))
    near = [d for d in pending if d.get("status") == "pending" and draft_matches(dict(call, texts=[]), d)]
    if near:
        return ("Blocked: the text of this Slack post does not match outbox draft %s for %s. Record the text "
                "you are sending first (`loom outbox update %s --text-file m1.md`), show it to the user, and "
                "send only once they approve it." % (near[-1].get("id"), dest, near[-1].get("id")))
    return ("Blocked: no Loom outbox draft from this chat matches this Slack post to %s. Every message is "
            "recorded before it is sent: write it to a file, run `loom outbox add --thread <url> (or --channel "
            "<id>) --text-file m1.md`, show the user the draft and its id, and send only after they approve "
            "it (or they send it from Loom)." % dest)


def main():
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    name = str(payload.get("tool_name") or "")
    inp = payload.get("tool_input") or {}
    if not is_send_call(name, inp):
        return 0
    state = c.read_plugin_state()
    try:
        with open(os.path.join(c.loom_home(), "plugin-state.json")) as f:
            explicit = json.load(f).get("outbox_guard")
    except (OSError, ValueError, AttributeError):
        explicit = None
    on = explicit if isinstance(explicit, bool) else (c.slack_on(state) and bool(state.get("outbox_chat_drafts")))
    if not on:
        return 0
    session = str(payload.get("session_id") or c.session_id())
    call = extract(name, inp, payload.get("cwd"))
    reason = decide(call, load_drafts(), session)
    c.log("outbox-guard %s %s %s" % (session[:8], "deny" if reason else "allow", call.get("channel") or "?"))
    if reason:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": reason}}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
