"""`loom watcher`: each subcommand's request (path, body, CLI token, no Origin) and its output."""
import json
import os
import subprocess
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from helpers import LOOM_BIN, HomeCase

TOKEN = "t" * 43


class FakeLoom(BaseHTTPRequestHandler):
    seen = []
    replies = {}

    def log_message(self, *_a):
        pass

    def _answer(self, body=None):
        FakeLoom.seen.append({"method": self.command, "path": self.path, "body": body, "token": self.headers.get("x-loom-cli-token"),
                              "origin": self.headers.get("origin")})
        status, out = FakeLoom.replies.get(self.path, (200, {"ok": True}))
        raw = json.dumps(out).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self._answer()

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        self._answer(json.loads(self.rfile.read(n) or b"{}"))


class WatcherCli(HomeCase):
    def setUp(self):
        HomeCase.setUp(self)
        FakeLoom.seen, FakeLoom.replies = [], {}
        self.srv = HTTPServer(("127.0.0.1", 0), FakeLoom)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        os.environ["LOOM_PORT"] = str(self.srv.server_address[1])
        with open(os.path.join(self.home, "cli-token"), "w") as f:
            f.write(TOKEN + "\n")
        self.draft = {"label": "T", "source": {"kind": "chats", "params": {}}, "trigger": {"kind": "became_your_turn", "params": {}},
                      "action": {"kind": "notify", "params": {"template": ""}}}

    def run_cli(self, *args):
        return subprocess.run([sys.executable, LOOM_BIN, "watcher"] + list(args), capture_output=True, text=True, env=os.environ)

    def draft_file(self, wrap=False):
        p = os.path.join(self.home, "draft.json")
        with open(p, "w") as f:
            json.dump({"watcher": self.draft} if wrap else self.draft, f)
        return p

    def test_create_posts_the_draft_with_the_cli_token_and_prints_the_id(self):
        FakeLoom.replies["/api/watchers/create"] = (200, {"ok": True, "watcher": {"id": "w123"}})
        for wrap in (False, True):
            r = self.run_cli("create", "--file", self.draft_file(wrap))
            self.assertEqual((r.returncode, r.stdout.strip()), (0, "w123"), r.stderr)
        for s in FakeLoom.seen:
            self.assertEqual((s["method"], s["path"], s["token"], s["origin"]), ("POST", "/api/watchers/create", TOKEN, None))
            self.assertEqual(s["body"], {"watcher": self.draft})
        self.run_cli("create", "--file", self.draft_file(), "--confirm-skip")
        self.assertIs(FakeLoom.seen[-1]["body"]["confirm_skip"], True)

    def test_test_by_file_or_id_prints_compact_json(self):
        FakeLoom.replies["/api/watchers/test"] = (200, {"ok": True, "scanned": 2, "rows": []})
        r = self.run_cli("test", "--file", self.draft_file())
        self.assertEqual((r.returncode, r.stdout.strip()), (0, '{"ok":true,"scanned":2,"rows":[]}'), r.stderr)
        self.assertEqual(FakeLoom.seen[-1]["body"], {"watcher": self.draft})
        self.assertEqual(self.run_cli("test", "--id", "w1").returncode, 0)
        self.assertEqual(FakeLoom.seen[-1]["body"], {"id": "w1"})
        self.assertEqual(self.run_cli("test").returncode, 2)
        self.assertEqual(self.run_cli("test", "--id", "w1", "--file", self.draft_file()).returncode, 2)

    def test_enable_disable_mode_delete(self):
        self.assertEqual(self.run_cli("enable", "w1").returncode, 0)
        self.assertEqual(self.run_cli("disable", "w1").returncode, 0)
        self.assertEqual(self.run_cli("mode", "w1", "live").returncode, 0)
        self.assertEqual(self.run_cli("delete", "w1").returncode, 0)
        self.assertEqual([(s["path"], s["body"]) for s in FakeLoom.seen], [
            ("/api/watchers/toggle", {"id": "w1", "enabled": True}),
            ("/api/watchers/toggle", {"id": "w1", "enabled": False}),
            ("/api/watchers/run-mode", {"id": "w1", "mode": "live"}),
            ("/api/watchers/delete", {"id": "w1"}),
        ])
        self.assertEqual(self.run_cli("mode", "w1", "loud").returncode, 2)

    def test_list_and_server_refusals(self):
        FakeLoom.replies["/api/watchers"] = (200, {"ok": True, "watchers": [{"id": "w1", "enabled": True, "run_mode": "shadow", "label": "PRs"}]})
        r = self.run_cli("list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("w1", r.stdout)
        self.assertIn("shadow", r.stdout)
        FakeLoom.replies["/api/watchers/toggle"] = (400, {"ok": False, "detail": "action.params.project_dir is required"})
        r = self.run_cli("enable", "w1")
        self.assertEqual(r.returncode, 4)
        self.assertIn("project_dir is required", r.stderr)

    def test_unknown_subcommand(self):
        self.assertEqual(self.run_cli("nope").returncode, 2)


if __name__ == "__main__":
    unittest.main()
