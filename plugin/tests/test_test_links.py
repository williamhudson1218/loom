"""loom test-links: event writes, URL validation, session resolution, list failure mode."""
import os
import subprocess
import sys
import unittest

from helpers import LOOM_BIN, HomeCase


class TestLinks(HomeCase):
    def run_cli(self, *args, env=None):
        return subprocess.run([sys.executable, LOOM_BIN] + list(args), capture_output=True, text=True, env=env or os.environ)

    def test_add_writes_one_event(self):
        r = self.run_cli("test-links", "add", "http://localhost:3000/orders/42", "--label", "Order detail")
        self.assertEqual(r.returncode, 0, r.stderr)
        (ev,) = self.events()
        self.assertEqual(ev["kind"], "testlinks.add")
        self.assertEqual((ev["session"], ev["url"], ev["label"]), ("sess-1", "http://localhost:3000/orders/42", "Order detail"))

    def test_label_is_optional(self):
        self.assertEqual(self.run_cli("test-links", "add", "https://example.com/a").returncode, 0)
        self.assertEqual(self.events()[0]["label"], "")

    def test_rejects_non_http_schemes(self):
        for bad in ("javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://host/x", "localhost:3000", "/relative"):
            r = self.run_cli("test-links", "add", bad)
            self.assertEqual(r.returncode, 2, bad)
        self.assertEqual(self.events(), [])

    def test_add_needs_exactly_one_url(self):
        self.assertEqual(self.run_cli("test-links", "add").returncode, 2)
        self.assertEqual(self.run_cli("test-links", "add", "http://a/", "http://b/").returncode, 2)

    def test_clear_all_and_one(self):
        self.assertEqual(self.run_cli("test-links", "clear").returncode, 0)
        self.assertEqual(self.run_cli("test-links", "clear", "http://localhost:3000/a").returncode, 0)
        a, b = self.events()
        self.assertEqual((a["kind"], "url" in a), ("testlinks.clear", False))
        self.assertEqual(b["url"], "http://localhost:3000/a")

    def test_session_override_and_missing_session(self):
        self.run_cli("test-links", "add", "http://localhost:3000/a", "--session", "other")
        self.assertEqual(self.events()[0]["session"], "other")
        env = dict(os.environ)
        env.pop("CLAUDE_CODE_SESSION_ID", None)
        self.assertEqual(self.run_cli("test-links", "add", "http://localhost:3000/a", env=env).returncode, 2)

    def test_list_without_loom_fails_cleanly(self):
        self.assertEqual(self.run_cli("test-links", "list").returncode, 3)

    def test_unknown_subcommand(self):
        self.assertEqual(self.run_cli("test-links", "frob").returncode, 2)


if __name__ == "__main__":
    unittest.main()
