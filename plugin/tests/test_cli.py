"""The loom CLI: event writes, plugin-state gates, atomicity, permissions, ship-lock, HTTP failure modes."""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest

from helpers import LOOM_BIN, HomeCase

URL = "https://acme.slack.com/archives/CTEST12345/p1793990180251589"


class Cli(HomeCase):
    def run_cli(self, *args, cwd=None, env=None):
        return subprocess.run([sys.executable, LOOM_BIN] + list(args), capture_output=True, text=True,
                              env=env or os.environ, cwd=cwd)

    def text_file(self, body="Hello there", name="m.md"):
        p = os.path.join(self.home, name)
        with open(p, "w") as f:
            f.write(body)
        return p

    def test_outbox_add_thread(self):
        r = self.run_cli("outbox", "add", "--thread", URL, "--text-file", self.text_file("one", "a.md"), "--text-file", self.text_file("two", "b.md"))
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = self.events()[0]
        self.assertEqual(ev["kind"], "outbox.add")
        self.assertEqual(ev["id"], r.stdout.strip())
        self.assertEqual((ev["channel"], ev["thread_ts"]), ("CTEST12345", "1793990180.251589"))
        self.assertEqual(ev["messages"], ["one", "two"])
        self.assertEqual(ev["session"], "sess-1")

    def test_outbox_add_requires_exactly_one_destination(self):
        f = self.text_file()
        self.assertEqual(self.run_cli("outbox", "add", "--text-file", f).returncode, 2)
        self.assertEqual(self.run_cli("outbox", "add", "--thread", URL, "--channel", "C1", "--text-file", f).returncode, 2)

    def review_file(self, **over):
        r = {"repo": "acme/app", "pr": 12, "commit_id": "abc1234def5678", "event": "REQUEST_CHANGES", "body": "Two blockers.",
             "comments": [{"path": "src/a.ts", "line": 10, "body": "This drops the filter."}]}
        r.update(over)
        return self.text_file(json.dumps(r), "review.json")

    def run_review(self, *args):
        env = dict(os.environ, LOOM_NO_GH="1")
        return self.run_cli(*args, env=env)

    def test_outbox_add_review_bundle(self):
        rx = self.text_file(json.dumps([{"url": URL, "add": ["large_orange_circle"], "remove": [":eyes:"]}]), "rx.json")
        r = self.run_review("outbox", "add", "--review-file", self.review_file(), "--reactions-file", rx,
                            "--thread", URL, "--text-file", self.text_file("Left two blockers."))
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = self.events()[0]
        self.assertEqual(ev["review"]["event"], "REQUEST_CHANGES")
        self.assertEqual(ev["review"]["comments"][0]["path"], "src/a.ts")
        self.assertEqual(ev["reactions"], [{"channel": "CTEST12345", "ts": "1793990180.251589", "add": ["large_orange_circle"], "remove": ["eyes"]}])
        self.assertEqual((ev["channel"], ev["messages"]), ("CTEST12345", ["Left two blockers."]))

    def test_outbox_add_review_only(self):
        r = self.run_review("outbox", "add", "--review-file", self.review_file(event="approve", body="", comments=[]))
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = self.events()[0]
        self.assertEqual((ev["channel"], ev["messages"], ev["review"]["event"]), ("", [], "APPROVE"))

    def test_outbox_add_review_validation(self):
        for over in ({"event": "MERGE"}, {"repo": "nope"}, {"commit_id": ""}, {"pr": "x"},
                     {"comments": [{"path": "a.ts", "body": "no line"}]}, {"comments": [{"line": 3, "body": "no path"}]},
                     {"comments": [{"path": "a.ts", "line": 3, "body": ""}]}, {"body": "", "event": "COMMENT"}):
            r = self.run_review("outbox", "add", "--review-file", self.review_file(**over))
            self.assertEqual(r.returncode, 2, (over, r.stderr))
        # Slack text without a destination is still refused alongside a review.
        self.assertEqual(self.run_review("outbox", "add", "--review-file", self.review_file(), "--text-file", self.text_file()).returncode, 2)
        self.assertEqual(self.events(), [])

    def test_outbox_update_review_only(self):
        r = self.run_review("outbox", "update", "d1", "--review-file", self.review_file(event="APPROVE"))
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = self.events()[0]
        self.assertEqual(ev["review"]["event"], "APPROVE")
        self.assertNotIn("messages", ev)

    def test_outbox_add_rejects_empty_file(self):
        self.assertEqual(self.run_cli("outbox", "add", "--channel", "#ops", "--text-file", self.text_file("  \n")).returncode, 2)
        self.assertEqual(self.events(), [])

    def test_outbox_update_and_supersede(self):
        self.run_cli("outbox", "update", "d1", "--text-file", self.text_file("new"))
        self.run_cli("outbox", "supersede", "d1")
        self.assertEqual([(e["kind"], e["id"]) for e in self.events()], [("outbox.update", "d1"), ("outbox.supersede", "d1")])

    def test_ids_are_unique(self):
        f = self.text_file()
        ids = {self.run_cli("outbox", "add", "--channel", "#a", "--text-file", f).stdout.strip() for _ in range(4)}
        self.assertEqual(len(ids), 4)

    def test_event_files_are_0600_and_leave_no_temp(self):
        self.run_cli("ship-label", "Thing")
        d = os.path.join(self.home, "events")
        names = os.listdir(d)
        self.assertEqual(len(names), 1)
        self.assertFalse(names[0].startswith("."))
        self.assertEqual(stat.S_IMODE(os.stat(os.path.join(d, names[0])).st_mode), 0o600)

    def test_ship_label_event_and_trim(self):
        self.run_cli("ship-label", "x" * 200, "--repo", self.home)
        ev = self.events()[0]
        self.assertEqual(ev["kind"], "ship.label")
        self.assertEqual(len(ev["label"]), 80)

    def test_ship_label_show_reads_pending_event(self):
        self.run_cli("ship-label", "Retry padding")
        r = self.run_cli("ship-label", "--show")
        self.assertEqual((r.returncode, r.stdout.strip()), (0, "Retry padding"))

    def test_ship_label_clear_hides_it(self):
        self.run_cli("ship-label", "Retry padding")
        self.run_cli("ship-label", "--clear")
        self.assertEqual(self.run_cli("ship-label", "--show").returncode, 1)

    def test_thread_stage_done_no_reaction_when_not_direct(self):
        self.write_state(slack_mode="mcp")
        r = self.run_cli("thread", "stage", URL, "done")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("(no reaction)", r.stdout)
        ev = self.events()[0]
        self.assertEqual((ev["kind"], ev["stage"], ev["react"]), ("thread.stage", "done", True))

    def test_thread_stage_done_on_reply_link_defaults_to_no_react(self):
        reply = URL.replace("1793990180251589", "1793990999000100") + "?thread_ts=1793990180.251589"
        self.run_cli("thread", "stage", reply, "done")
        self.assertFalse(self.events()[0]["react"])
        self.run_cli("thread", "stage", reply, "done", "--react")
        self.assertTrue(self.events()[1]["react"])

    def test_thread_stage_rejects_unknown_stage(self):
        self.assertEqual(self.run_cli("thread", "stage", URL, "finished").returncode, 2)

    def test_thread_open_records_looking(self):
        r = self.run_cli("thread", "open", URL)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.events()[0]["stage"], "looking")

    def test_reads_fail_cleanly_when_loom_is_down(self):
        r = self.run_cli("outbox", "list")
        self.assertEqual(r.returncode, 3)
        self.assertIn("not reachable", r.stderr)

    def test_unknown_command(self):
        self.assertEqual(self.run_cli("nope").returncode, 2)

    def test_writes_do_not_need_loom_or_token(self):
        self.assertFalse(os.path.exists(os.path.join(self.home, "cli-token")))
        self.assertEqual(self.run_cli("thread", "release", URL).returncode, 0)


class ShipLock(HomeCase):
    def setUp(self):
        HomeCase.setUp(self)
        self.repo = tempfile.mkdtemp()
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        self.addCleanup(lambda: __import__("shutil").rmtree(self.repo, ignore_errors=True))

    def lock(self, sub, sid="sess-1", repo=None, cwd=None):
        env = dict(os.environ, CLAUDE_CODE_SESSION_ID=sid)
        argv = [sys.executable, LOOM_BIN, "ship-lock", sub] + ([repo] if repo else [])
        return subprocess.run(argv, capture_output=True, text=True, cwd=cwd or self.repo, env=env)

    def test_repo_argument_picks_that_repos_lock(self):
        other = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(other, ignore_errors=True))
        self.assertEqual(self.lock("acquire", repo=self.repo, cwd=other).returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.repo, ".git", "ship.lock")))
        self.assertIn("held by sess-1", self.lock("status", repo=self.repo, cwd=other).stdout)

    def test_one_lock_per_repo(self):
        b = tempfile.mkdtemp()
        self.addCleanup(lambda: __import__("shutil").rmtree(b, ignore_errors=True))
        subprocess.run(["git", "init", "-q", b], check=True)
        self.lock("acquire")
        self.assertEqual(self.lock("acquire", sid="sess-2", repo=b).returncode, 0)
        self.assertIn("sess-1", open(os.path.join(self.repo, ".git", "ship.lock")).read())
        self.assertIn("sess-2", open(os.path.join(b, ".git", "ship.lock")).read())

    def test_acquire_is_a_noop_when_loom_has_the_lock_off(self):
        root = os.path.realpath(self.repo)
        self.write_state(ship={"repos": [root], "label_required": [], "lock": []})
        r = self.lock("acquire")
        self.assertEqual(r.returncode, 0)
        self.assertIn("off for", r.stdout)
        self.assertFalse(os.path.exists(os.path.join(self.repo, ".git", "ship.lock")))

    def test_acquire_when_loom_predates_the_lock_setting(self):
        self.write_state(ship={"repos": [os.path.realpath(self.repo)], "label_required": []})
        self.assertEqual(self.lock("acquire").returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.repo, ".git", "ship.lock")))

    def test_acquire_status_release(self):
        self.assertEqual(self.lock("acquire").returncode, 0)
        self.assertTrue(os.path.exists(os.path.join(self.repo, ".git", "ship.lock")))
        self.assertIn("held by sess-1", self.lock("status").stdout)
        self.assertEqual(self.lock("release").returncode, 0)
        self.assertIn("unlocked", self.lock("status").stdout)

    def test_other_session_cannot_acquire_or_release(self):
        self.lock("acquire")
        r = self.lock("acquire", sid="sess-2")
        self.assertEqual(r.returncode, 1)
        self.assertIn("held by another session", r.stderr)
        self.assertEqual(self.lock("release", sid="sess-2").returncode, 1)
        self.assertTrue(os.path.exists(os.path.join(self.repo, ".git", "ship.lock")))

    def test_same_session_can_restamp(self):
        self.lock("acquire")
        self.assertEqual(self.lock("acquire").returncode, 0)

    def test_stale_lock_is_taken_over(self):
        p = os.path.join(self.repo, ".git", "ship.lock")
        with open(p, "w") as f:
            json.dump({"session_id": "dead", "acquired_at": 1, "tmux_pane": ""}, f)
        self.assertEqual(self.lock("acquire", sid="sess-2").returncode, 0)
        self.assertIn("held by sess-2", self.lock("status", sid="sess-2").stdout)


class Common(HomeCase):
    def test_loom_home_from_plugin_root(self):
        import _common as c
        del os.environ["LOOM_HOME"]
        os.environ["CLAUDE_PLUGIN_ROOT"] = "/data/.loom/plugin-marketplace/loom"
        self.assertEqual(c.loom_home(), "/data/.loom")

    def test_loom_home_env_wins(self):
        import _common as c
        os.environ["CLAUDE_PLUGIN_ROOT"] = "/data/.loom/plugin-marketplace/loom"
        self.assertEqual(c.loom_home(), self.home)

    def test_corrupt_state_means_off(self):
        import _common as c
        with open(os.path.join(self.home, "plugin-state.json"), "w") as f:
            f.write("{nope")
        st = c.read_plugin_state()
        self.assertFalse(c.slack_on(st))
        self.assertEqual(st["ship"]["label_required"], [])


if __name__ == "__main__":
    unittest.main()
