"""Shared helpers for the Loom plugin hooks and the `loom` CLI. Python 3.9+, stdlib only.

Resolution order for Loom's data dir matches src/paths.ts:
  1. $LOOM_HOME
  2. the plugin's own location: $CLAUDE_PLUGIN_ROOT is <LOOM_HOME>/plugin-marketplace/loom
  3. ~/.claude/tools/chat-manager when it exists (legacy installs)
  4. ~/.loom

Writes are one atomic JSON file per call in <LOOM_HOME>/events/, so they survive Loom being
down. Reads and Slack actions go over HTTP to 127.0.0.1 with the CLI token. The Slack token
never reaches this process.
"""
import json
import os
import random
import re
import time
from datetime import datetime
from urllib.parse import parse_qs

DEFAULT_PORT = 4317

URL_RE = re.compile(
    r"https://[\w.-]+\.slack\.com/archives/([A-Z0-9]+)/p(\d{10})(\d{6})(\?[^\s>)\]|]*)?"
)


# ---------- paths and gates ----------

def loom_home():
    env = (os.environ.get("LOOM_HOME") or "").strip()
    if env:
        return os.path.abspath(os.path.expanduser(env))
    root = (os.environ.get("CLAUDE_PLUGIN_ROOT") or "").strip()
    if root:
        market = os.path.dirname(os.path.abspath(root))
        if os.path.basename(market) == "plugin-marketplace":
            return os.path.dirname(market)
    legacy = os.path.expanduser("~/.claude/tools/chat-manager")
    if os.path.isdir(legacy):
        return legacy
    return os.path.expanduser("~/.loom")


def events_dir():
    return os.path.join(loom_home(), "events")


DEFAULT_STATE = {
    "slack_mode": "skip",          # direct | mcp | skip
    "outbox_chat_drafts": False,   # record drafts shown in chat
    "ship": {"repos": [], "label_required": [], "lock": []},
}


def read_plugin_state():
    """$LOOM_HOME/plugin-state.json, merged over defaults. Missing or corrupt means everything off."""
    state = json.loads(json.dumps(DEFAULT_STATE))
    try:
        with open(os.path.join(loom_home(), "plugin-state.json")) as f:
            data = json.load(f)
    except (OSError, ValueError):
        return state
    if not isinstance(data, dict):
        return state
    for k in ("slack_mode", "outbox_chat_drafts"):
        if k in data:
            state[k] = data[k]
    ship = data.get("ship")
    if isinstance(ship, dict):
        for k in ("repos", "label_required", "lock"):
            if isinstance(ship.get(k), list):
                state["ship"][k] = [str(x) for x in ship[k]]
        if "label_required" not in ship:
            state["ship"]["label_required"] = list(state["ship"]["repos"])
        # A Loom that predates the per-repo ship lock: every ship repo takes it.
        if "lock" not in ship:
            state["ship"]["lock"] = list(state["ship"]["repos"])
    return state


def slack_on(state):
    return state.get("slack_mode") in ("direct", "mcp")


def log(msg):
    try:
        os.makedirs(loom_home(), exist_ok=True)
        with open(os.path.join(loom_home(), "plugin-hooks.log"), "a") as f:
            f.write("%s %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    except OSError:
        pass


def session_id():
    return os.environ.get("CLAUDE_CODE_SESSION_ID") or os.environ.get("CODEX_THREAD_ID") or ""


# ---------- events (writes) ----------

def write_event(kind, **fields):
    """Atomically drop one event file for Loom to ingest. Returns the path."""
    d = events_dir()
    os.makedirs(d, mode=0o700, exist_ok=True)
    ms = int(time.time() * 1000)
    name = "%d-%06x.json" % (ms, random.randrange(1 << 24))
    body = {"v": 1, "kind": kind, "at": ms}
    body.update(fields)
    final = os.path.join(d, name)
    tmp = os.path.join(d, "." + name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(body, f)
    os.replace(tmp, final)
    return final


def pending_events(kind=None):
    """Events Loom has not ingested yet (it removes a file once read)."""
    out = []
    try:
        names = sorted(os.listdir(events_dir()))
    except OSError:
        return out
    for n in names:
        if n.startswith(".") or not n.endswith(".json"):
            continue
        try:
            with open(os.path.join(events_dir(), n)) as f:
                e = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(e, dict) and (kind is None or e.get("kind") == kind):
            out.append(e)
    return out


# ---------- http (reads and Slack actions) ----------

class LoomUnavailable(Exception):
    pass


class LoomError(Exception):
    def __init__(self, status, body):
        Exception.__init__(self, "HTTP %s: %s" % (status, body))
        self.status = status
        self.body = body


def _pid_alive(pid):
    try:
        os.kill(pid, 0)
    except OSError:
        # ESRCH: gone. EPERM: it exists but is another user's, so not this user's Loom.
        return False
    return True


def loom_port():
    """The port this user's Loom serves on: $LOOM_PORT, then server.json (its pid alive), then 4317.

    localhost is shared by every macOS user, so Loom may have moved off 4317 to the next free
    port; server.json (in the per-user data folder) says where it went.
    """
    env = (os.environ.get("LOOM_PORT") or "").strip()
    if env.isdigit() and 0 < int(env) <= 65535:
        return int(env)
    try:
        with open(os.path.join(loom_home(), "server.json")) as f:
            info = json.load(f)
        port, pid = info.get("port"), info.get("pid")
        if isinstance(port, int) and isinstance(pid, int) and 0 < port <= 65535 and _pid_alive(pid):
            return port
    except (OSError, ValueError, AttributeError):
        pass
    return DEFAULT_PORT


def cli_token():
    try:
        with open(os.path.join(loom_home(), "cli-token")) as f:
            return f.read().strip()
    except OSError:
        return ""


def http(method, path, body=None, timeout=3.0):
    """JSON request to Loom. Raises LoomUnavailable (down, no token) or LoomError (non-2xx)."""
    import urllib.error
    import urllib.request

    token = cli_token()
    if not token:
        raise LoomUnavailable("no cli-token in %s" % loom_home())
    url = "http://127.0.0.1:%d%s" % (loom_port(), path)
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-loom-cli-token", token)
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        raise LoomError(e.code, e.read().decode("utf-8", "replace"))
    except (urllib.error.URLError, OSError) as e:
        raise LoomUnavailable(str(e))
    try:
        return json.loads(raw) if raw else {}
    except ValueError:
        return {"raw": raw}


# ---------- slack urls ----------

def thread_keys(text):
    """Thread-root keys (`C123/1791838480.328439`) in order, deduped, with a canonical URL.

    A reply link carries the root in ?thread_ts=; the root's own link is p<ts>.
    """
    keys = {}
    for m in URL_RE.finditer(text or ""):
        channel, sec, frac, query = m.groups()
        ts = "%s.%s" % (sec, frac)
        if query:
            root = parse_qs(query.lstrip("?")).get("thread_ts")
            if root and re.fullmatch(r"\d{10}\.\d{6}", root[0]):
                ts = root[0]
        base = m.group(0).split("/archives/")[0]
        keys.setdefault("%s/%s" % (channel, ts), "%s/archives/%s/p%s" % (base, channel, ts.replace(".", "")))
    return keys


def top_level_keys(text):
    """Keys pasted as a channel's top-level post: not a DM (D...), not a reply link."""
    keys = set()
    for m in URL_RE.finditer(text or ""):
        channel, sec, frac, query = m.groups()
        root = parse_qs((query or "").lstrip("?")).get("thread_ts")
        if not channel.startswith("D") and (not root or root[0] == "%s.%s" % (sec, frac)):
            keys.add("%s/%s.%s" % (channel, sec, frac))
    return keys


# ---------- transcripts ----------

def records(path):
    out = []
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            for line in f:
                try:
                    out.append(json.loads(line))
                except ValueError:
                    pass
    except OSError:
        pass
    return out


def blocks(r):
    c = (r.get("message") or {}).get("content")
    if isinstance(c, str):
        return [{"type": "text", "text": c}]
    return [b for b in c or [] if isinstance(b, dict)]


def is_prompt(r):
    if r.get("type") != "user" or r.get("isSidechain"):
        return False
    bs = blocks(r)
    return bool(bs) and not all(b.get("type") == "tool_result" for b in bs)


def epoch_ms(r):
    ts = r.get("timestamp")
    if isinstance(ts, (int, float)):
        return int(ts)
    if isinstance(ts, str):
        try:
            return int(datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            pass
    return None


def user_prompts(path):
    """Typed user prompts in a transcript, oldest first."""
    out = []
    for e in records(path):
        if e.get("type") != "user" or e.get("isMeta") or e.get("isSidechain"):
            continue
        if e.get("entrypoint", "cli") != "cli":
            continue
        c = (e.get("message") or {}).get("content")
        if isinstance(c, list):
            if any(i.get("type") == "tool_result" for i in c if isinstance(i, dict)):
                continue
            c = " ".join(i.get("text", "") for i in c if isinstance(i, dict))
        if not isinstance(c, str) or c.startswith(("<command-", "<local-command", "<system-reminder")):
            continue
        out.append(c)
    return out


def is_first_prompt(transcript_path, prompt):
    prior = user_prompts(transcript_path or "")
    return not prior or (len(prior) == 1 and prior[0].strip() == prompt.strip())


# ---------- ship labels ----------

def ship_labels(session):
    """{session: {label, repo, at}} for one session: Loom's copy, overlaid by events not yet ingested."""
    labels = {}
    try:
        r = http("GET", "/api/cli/ship-labels?session=" + session)
        if isinstance(r, dict) and isinstance(r.get("labels"), dict):
            labels.update(r["labels"])
    except (LoomUnavailable, LoomError):
        pass
    for e in pending_events("ship.label"):
        if e.get("session") != session:
            continue
        if e.get("clear"):
            labels.pop(session, None)
        else:
            labels[session] = {"label": e.get("label"), "repo": e.get("repo"), "at": e.get("at")}
    return labels
