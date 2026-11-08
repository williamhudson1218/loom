"""Port of the toolbox ship-label hook tests; repos now come from plugin-state.json."""
import json
import os
import subprocess
import sys
import unittest

from helpers import HOOKS, HomeCase, load

hook = load("ship_hook", "ship-labels.py")

REPO = "/work/example-repo"
REPOS = [REPO]
SID = "sess-1"


def user(text, ts="2026-11-06T10:00:00.000Z"):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}


def asst(*blocks, cwd=REPO, ts="2026-11-06T10:05:00.000Z"):
    return {"type": "assistant", "cwd": cwd, "timestamp": ts, "message": {"role": "assistant", "content": list(blocks)}}


def text(t):
    return {"type": "text", "text": t}


def bash(cmd):
    return {"type": "tool_use", "name": "Bash", "input": {"command": cmd}}


def result():
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}


def ms(iso):
    return hook.epoch_ms({"timestamp": iso})


def label(repo=REPO, at="2026-11-06T10:06:00.000Z"):
    return {SID: {"label": "Retry padding", "repo": repo, "at": ms(at)}}


ADD = "git add apps/web/src/foo.ts packages/core/bar.ts"


class Analyse(unittest.TestCase):
    def go(self, recs, labels, repos=REPOS):
        return hook.analyse(recs, SID, labels, repos)

    def test_add_without_label_blocks(self):
        self.assertTrue(self.go([user("go"), asst(bash(ADD)), result(), asst(text("staged"))], {}))

    def test_chained_add_blocks(self):
        self.assertTrue(self.go([user("go"), asst(bash("yarn lint && git add a.ts")), result(), asst(text("done"))], {}))

    def test_git_dash_c_add_blocks(self):
        recs = [user("go"), asst(bash("git -C %s add a.ts" % REPO), cwd="/elsewhere"), asst(text("done"))]
        self.assertTrue(self.go(recs, {}))

    def test_worktree_add_blocks_and_matches_worktree_label(self):
        wt = REPO + "/.worktrees/feat"
        recs = [user("go"), asst(bash("git add a.ts"), cwd=wt), asst(text("done"))]
        self.assertTrue(self.go(recs, {}))
        self.assertIsNone(self.go(recs, label(repo=wt)))

    def test_label_call_in_turn_ok(self):
        recs = [user("go"), asst(bash(ADD)), result(), asst(bash('loom ship-label "Retry padding"')), asst(text("done"))]
        self.assertIsNone(self.go(recs, {}))

    def test_other_script_named_ship_label_does_not_count(self):
        recs = [user("go"), asst(bash(ADD)), asst(bash('~/bin/ship-label "x"')), asst(text("done"))]
        self.assertTrue(self.go(recs, {}))

    def test_fresh_label_ok(self):
        self.assertIsNone(self.go([user("go"), asst(bash(ADD)), asst(text("done"))], label()))

    def test_stale_label_blocks(self):
        recs = [user("go"), asst(bash(ADD)), asst(text("done"))]
        self.assertTrue(self.go(recs, label(at="2026-11-06T09:00:00.000Z")))

    def test_label_from_earlier_turn_still_counts(self):
        recs = [user("a"), asst(bash(ADD), ts="2026-11-06T10:01:00.000Z"), asst(text("staged")),
                user("b", ts="2026-11-06T11:00:00.000Z"),
                asst(bash("git add c.ts"), ts="2026-11-06T11:05:00.000Z"), asst(text("again"))]
        self.assertIsNone(self.go(recs, label(at="2026-11-06T10:02:00.000Z")))

    def test_add_outside_ship_repos_ok(self):
        recs = [user("go"), asst(bash("git add notes.md"), cwd="/work/scratch"), asst(text("done"))]
        self.assertIsNone(self.go(recs, {}))

    def test_no_repos_configured_never_blocks(self):
        self.assertIsNone(self.go([user("go"), asst(bash(ADD)), asst(text("done"))], {}, repos=[]))

    def test_no_add_ok(self):
        self.assertIsNone(self.go([user("go"), asst(bash("git status")), asst(text("done"))], {}))

    def test_add_before_last_prompt_ignored(self):
        recs = [user("a"), asst(bash(ADD)), user("b"), asst(text("hi"))]
        self.assertIsNone(self.go(recs, {}))


class Process(HomeCase):
    def run_hook(self, recs):
        path = os.path.join(self.home, "t.jsonl")
        with open(path, "w") as f:
            f.write("\n".join(json.dumps(r) for r in recs))
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "ship-labels.py")],
                           input=json.dumps({"transcript_path": path, "session_id": SID}),
                           capture_output=True, text=True, env=os.environ)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    RECS = [user("go"), asst(bash(ADD)), asst(text("done"))]

    def test_off_without_state(self):
        self.assertEqual(self.run_hook(self.RECS), "")

    def test_blocks_when_repo_listed(self):
        self.write_state(ship={"repos": [REPO], "label_required": [REPO]})
        self.assertEqual(json.loads(self.run_hook(self.RECS))["decision"], "block")

    def test_label_required_defaults_to_repos(self):
        self.write_state(ship={"repos": [REPO]})
        self.assertEqual(json.loads(self.run_hook(self.RECS))["decision"], "block")

    def test_explicitly_empty_label_required_is_off(self):
        self.write_state(ship={"repos": [REPO], "label_required": []})
        self.assertEqual(self.run_hook(self.RECS), "")

    def test_pending_label_event_satisfies_hook(self):
        self.write_state(ship={"repos": [REPO], "label_required": [REPO]})
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "..", "bin", "loom"), "ship-label", "Retry padding", "--repo", REPO],
                           capture_output=True, text=True, env=os.environ)
        self.assertEqual(r.returncode, 0, r.stderr)
        # the event's `at` is now, later than the transcript's first add (2026) only if clock is past it
        self.assertEqual(self.run_hook(self.RECS), "")


if __name__ == "__main__":
    unittest.main()
