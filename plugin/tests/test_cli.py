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

    def lock(self, sub, sid="sess-1"):
        env = dict(os.environ, CLAUDE_CODE_SESSION_ID=sid)
        return subprocess.run([sys.executable, LOOM_BIN, "ship-lock", sub], capture_output=True, text=True, cwd=self.repo, env=env)

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
