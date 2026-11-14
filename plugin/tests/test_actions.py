"""loom action: event writes, --when/--then prefix checks, session resolution, list failure mode."""
import os
import re
import subprocess
import sys
import unittest

from helpers import LOOM_BIN, HomeCase


class Actions(HomeCase):
    def run_cli(self, *args, env=None):
        return subprocess.run([sys.executable, LOOM_BIN] + list(args), capture_output=True, text=True, env=env or os.environ)

    def test_add_writes_one_event_and_prints_the_id(self):
        r = self.run_cli("action", "add", "--title", "T", "--when", "now", "--then", "none")
        self.assertEqual(r.returncode, 0, r.stderr)
        (ev,) = self.events()
        self.assertEqual(ev["kind"], "action.add")
        self.assertRegex(ev["id"], r"^a[0-9a-f]{12}$")
        self.assertEqual((ev["session"], ev["title"], ev["when"], ev["then"], ev["ask_first"]), ("sess-1", "T", "now", "none", False))
        self.assertIn(ev["id"], r.stdout)

    def test_ask_first_flag(self):
        self.run_cli("action", "add", "--title", "T", "--when", "manual", "--then", "wake:go", "--ask-first")
        self.assertTrue(self.events()[0]["ask_first"])

    def test_unknown_prefix_exits_2_and_writes_nothing(self):
        for when, then in (("tomorrow", "none"), ("now", "email:x"), ("pr-merged", "none")):
            r = self.run_cli("action", "add", "--title", "T", "--when", when, "--then", then)
            self.assertEqual(r.returncode, 2, (when, then))
        self.assertEqual(self.run_cli("action", "add", "--when", "now", "--then", "none").returncode, 2)
        self.assertEqual(self.events(), [])

    def test_done_fail_remove(self):
        self.assertEqual(self.run_cli("action", "done", "a0123456789ab").returncode, 0)
        self.assertEqual(self.run_cli("action", "fail", "a0123456789ab", "--why", "no access").returncode, 0)
        self.assertEqual(self.run_cli("action", "fail", "a0123456789ab").returncode, 2)
        self.assertEqual(self.run_cli("action", "remove", "a0123456789ab").returncode, 0)
        done, fail, rem = self.events()
        self.assertEqual((done["kind"], done["id"], done["session"]), ("action.done", "a0123456789ab", "sess-1"))
        self.assertEqual((fail["kind"], fail["why"]), ("action.fail", "no access"))
        self.assertEqual(rem["kind"], "action.remove")

    def test_close_when_done(self):
        self.assertEqual(self.run_cli("action", "close-when-done", "on").returncode, 0)
        self.assertEqual(self.run_cli("action", "close-when-done", "off").returncode, 0)
        self.assertEqual(self.run_cli("action", "close-when-done", "maybe").returncode, 2)
        a, b = self.events()
        self.assertEqual((a["kind"], a["on"]), ("action.close_when_done", True))
        self.assertEqual(b["on"], False)

    def test_missing_session(self):
        env = dict(os.environ)
        env.pop("CLAUDE_CODE_SESSION_ID", None)
        self.assertEqual(self.run_cli("action", "done", "a0123456789ab", env=env).returncode, 2)

    def test_list_without_loom_fails_cleanly(self):
        self.assertEqual(self.run_cli("action", "list").returncode, 3)

    def test_unknown_subcommand(self):
        self.assertEqual(self.run_cli("action", "frob").returncode, 2)


if __name__ == "__main__":
    unittest.main()
