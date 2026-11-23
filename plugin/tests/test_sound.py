"""The sound hook: Stop -> done, Notification -> blocked, silent when told to or when Loom is down."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

from helpers import HOOKS, HomeCase, load

hook = load("sound_hook", "sound.py")


class Recorder(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        Recorder.seen.append((self.path, self.headers.get("x-loom-cli-token"), json.loads(self.rfile.read(n))))
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok": true}')

    def log_message(self, *a):
        pass


def user(ts, text="go"):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": text}}


def tool_result(ts):
    return {"type": "user", "timestamp": ts, "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}


def write_transcript(recs, pad=0):
    f = tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False)
    if pad:
        f.write('{"type":"assistant","x":"%s"}\n' % ("a" * pad))
    for r in recs:
        f.write(json.dumps(r) + "\n")
    f.close()
    return f.name


class TurnStart(unittest.TestCase):
    def test_last_real_prompt_wins_over_tool_results(self):
        p = write_transcript([user("2026-11-06T10:00:00.000Z"), user("2026-11-06T10:05:00.000Z"), tool_result("2026-11-06T10:06:00.000Z")])
        self.addCleanup(os.unlink, p)
        self.assertEqual(hook.turn_started_at(p), hook.c.epoch_ms({"timestamp": "2026-11-06T10:05:00.000Z"}))

    def test_meta_prompts_are_skipped(self):
        meta = dict(user("2026-11-06T10:09:00.000Z"), isMeta=True)
        p = write_transcript([user("2026-11-06T10:00:00.000Z"), meta])
        self.addCleanup(os.unlink, p)
        self.assertEqual(hook.turn_started_at(p), hook.c.epoch_ms({"timestamp": "2026-11-06T10:00:00.000Z"}))

    def test_missing_or_empty_transcript_is_none(self):
        self.assertIsNone(hook.turn_started_at("/no/such/file.jsonl"))
        self.assertIsNone(hook.turn_started_at(""))

    def test_large_transcript_only_reads_the_tail(self):
        p = write_transcript([user("2026-11-06T10:00:00.000Z")], pad=hook.TAIL_BYTES + 10)
        self.addCleanup(os.unlink, p)
        self.assertIsNotNone(hook.turn_started_at(p))


class EventMapping(unittest.TestCase):
    def test_stop_is_done_and_notification_is_blocked(self):
        self.assertEqual(hook.event_for({"hook_event_name": "Stop"}), "done")
        self.assertEqual(hook.event_for({"hook_event_name": "Notification", "message": "Claude needs your permission to use Bash"}), "blocked")

    def test_a_stop_that_continues_is_not_done(self):
        self.assertIsNone(hook.event_for({"hook_event_name": "Stop", "stop_hook_active": True}))

    def test_the_idle_reminder_is_not_blocked(self):
        self.assertIsNone(hook.event_for({"hook_event_name": "Notification", "message": "Claude is waiting for your input"}))
        self.assertIsNone(hook.event_for({"hook_event_name": "Notification", "notification_type": "idle_prompt"}))

    def test_other_events_are_ignored(self):
        self.assertIsNone(hook.event_for({"hook_event_name": "PreToolUse"}))
        self.assertIsNone(hook.event_for({}))


class RunHook(HomeCase):
    def setUp(self):
        HomeCase.setUp(self)
        Recorder.seen = []
        self.srv = HTTPServer(("127.0.0.1", 0), Recorder)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.addCleanup(self.srv.server_close)
        self.addCleanup(self.srv.shutdown)
        with open(os.path.join(self.home, "cli-token"), "w") as f:
            f.write("tok")

    def run_hook(self, payload, port=None, **env):
        e = dict(os.environ, LOOM_PORT=str(port or self.srv.server_address[1]), TMUX_PANE="%7")
        e.update(env)
        return subprocess.run([sys.executable, os.path.join(HOOKS, "sound.py")], input=json.dumps(payload),
                              capture_output=True, text=True, env=e, timeout=15)

    def test_stop_posts_done_with_pane_session_and_turn_start(self):
        p = write_transcript([user("2026-11-06T10:00:00.000Z")])
        self.addCleanup(os.unlink, p)
        r = self.run_hook({"hook_event_name": "Stop", "session_id": "s-1", "transcript_path": p})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        path, token, body = Recorder.seen[0]
        self.assertEqual((path, token), ("/api/cli/sound-event", "tok"))
        self.assertEqual((body["event"], body["session_id"], body["pane"]), ("done", "s-1", "%7"))
        self.assertEqual(body["turn_started_at"], hook.c.epoch_ms({"timestamp": "2026-11-06T10:00:00.000Z"}))

    def test_notification_posts_blocked_without_a_turn_start(self):
        r = self.run_hook({"hook_event_name": "Notification", "session_id": "s-1", "message": "needs permission"})
        self.assertEqual(r.returncode, 0)
        self.assertEqual(Recorder.seen[0][2]["event"], "blocked")
        self.assertNotIn("turn_started_at", Recorder.seen[0][2])

    def test_loom_silent_posts_nothing(self):
        r = self.run_hook({"hook_event_name": "Stop", "session_id": "s-1"}, LOOM_SILENT="1")
        self.assertEqual((r.returncode, r.stdout), (0, ""))
        self.assertEqual(Recorder.seen, [])

    def test_loom_down_is_silent_and_exits_zero(self):
        r = self.run_hook({"hook_event_name": "Stop", "session_id": "s-1"}, port=1)
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))

    def test_no_token_is_silent_and_exits_zero(self):
        os.unlink(os.path.join(self.home, "cli-token"))
        r = self.run_hook({"hook_event_name": "Stop", "session_id": "s-1"})
        self.assertEqual((r.returncode, r.stdout, r.stderr), (0, "", ""))
        self.assertEqual(Recorder.seen, [])

    def test_garbage_stdin_exits_zero(self):
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "sound.py")], input="not json", capture_output=True, text=True, env=os.environ)
        self.assertEqual((r.returncode, r.stdout), (0, ""))


if __name__ == "__main__":
    unittest.main()
