#!/usr/bin/env python3
"""Stop hook: a chat that stages work in a ship repo must record a ship label.

Loom shows "what this ship contains" per chat from the label set by `loom ship-label`. On Stop,
if the last assistant turn ran a Bash `git add` in a repo that requires labels, and this session
has no label for that repo at least as new as the session's first `git add`, and the turn made no
`loom ship-label` call, block once.

Repos come from plugin-state.json (`ship.label_required`, falling back to `ship.repos`); with
none configured the hook does nothing. Worktrees (<repo>/.worktrees/<name>) count as the repo.
Skips: stop_hook_active (no loops), `git add` outside those repos.
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import _common as c  # noqa: E402

records, blocks, is_prompt, epoch_ms = c.records, c.blocks, c.is_prompt, c.epoch_ms

GIT_ADD = re.compile(r"(?:^|[;&|(\n]\s*)git\b((?:\s+-C\s+\S+|\s+-c\s+\S+)*)\s+add\b(?!\S)")
CD = re.compile(r"(?:^|[;&|(\n]\s*)cd\s+(\"[^\"]+\"|'[^']+'|\S+)")
SHIP_LABEL_CALL = re.compile(r"\bloom\s+ship-label\b")

REASON = (
    "You staged work in a ship repo but did not record what it is. Run "
    '`loom ship-label "<one line: what this change is>"`, e.g. "Retry padding for payment notices". '
    "Loom shows it as what this ship contains."
)


def unquote(s):
    return os.path.expanduser(s.strip("\"'"))


def add_dir(cmd, cwd):
    """Directory a `git add` in `cmd` runs in, or None if the command has none."""
    m = GIT_ADD.search(cmd)
    if not m:
        return None
    cm = re.search(r"-C\s+(\"[^\"]+\"|'[^']+'|\S+)", m.group(1) or "")
    if cm:
        d = unquote(cm.group(1))
    else:
        d = cwd or ""
        for x in CD.finditer(cmd[: m.start() + 1]):
            d = unquote(x.group(1)) if os.path.isabs(unquote(x.group(1))) else os.path.join(d, unquote(x.group(1)))
    return os.path.normpath(d) if d else ""


def ship_root(path, repos):
    """Label-repo key for a path inside a ship repo (repo root or worktree root), else None."""
    for repo in repos:
        repo = os.path.normpath(os.path.expanduser(repo))
        if path == repo or path.startswith(repo + os.sep):
            wt = os.path.join(repo, ".worktrees") + os.sep
            if path.startswith(wt):
                parts = path[len(wt):].split(os.sep)
                # nested worktree names (feature/foo) are allowed: walk down to a .git
                p = wt.rstrip(os.sep)
                for part in parts:
                    p = os.path.join(p, part)
                    if os.path.exists(os.path.join(p, ".git")):
                        return p
                return os.path.join(wt, parts[0]).rstrip(os.sep)
            return repo
    return None


def adds(recs, repos):
    """[(record_index, ship_root, ts_ms)] for every Bash git add in a ship repo."""
    out = []
    for i, r in enumerate(recs):
        if r.get("type") != "assistant":
            continue
        for b in blocks(r):
            if b.get("type") == "tool_use" and b.get("name") == "Bash":
                cmd = (b.get("input") or {}).get("command") or ""
                d = add_dir(cmd, r.get("cwd"))
                root = ship_root(d, repos) if d is not None else None
                if root:
                    out.append((i, root, epoch_ms(r)))
    return out


def analyse(recs, session_id, labels, repos):
    """`labels` is {session_id: {label, repo, at}}. Return the reason string to block with, or None."""
    if not repos:
        return None
    start = 0
    for i, r in enumerate(recs):
        if is_prompt(r):
            start = i + 1
    for r in recs[start:]:
        if r.get("type") != "assistant":
            continue
        for b in blocks(r):
            if b.get("type") == "tool_use" and b.get("name") == "Bash" \
                    and SHIP_LABEL_CALL.search((b.get("input") or {}).get("command") or ""):
                return None
    all_adds = adds(recs, repos)
    turn_adds = [a for a in all_adds if a[0] >= start]
    if not turn_adds:
        return None
    entry = (labels or {}).get(session_id) or {}
    for _, root, _ in turn_adds:
        if entry.get("label") and ship_root(os.path.normpath(entry.get("repo") or ""), repos) == root:
            firsts = [a[2] for a in all_adds if a[1] == root and a[2] is not None]
            if not firsts or (entry.get("at") or 0) >= min(firsts):
                return None
    return REASON


read_labels = c.ship_labels


def main():
    state = c.read_plugin_state()
    repos = state["ship"]["label_required"]
    if not repos:
        return 0
    try:
        payload = json.load(sys.stdin)
    except ValueError:
        return 0
    if payload.get("stop_hook_active"):
        return 0
    path = payload.get("transcript_path") or ""
    sid = payload.get("session_id") or ""
    if not path or not sid:
        return 0
    recs = records(path)
    # Cheap exit before any HTTP: no git add in a ship repo, nothing to check.
    if not adds(recs, repos):
        return 0
    reason = analyse(recs, sid, read_labels(sid), repos)
    if reason:
        print(json.dumps({"decision": "block", "reason": reason}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
