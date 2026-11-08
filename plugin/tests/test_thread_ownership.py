"""Thread ownership: claim / takeover / note, and the CLI's `thread started` rules."""
import io
import json
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from unittest import mock

from helpers import HOOKS, LOOM_BIN, HomeCase, load

hook = load("own_hook", "thread-ownership.py")

URL = "https://acme.slack.com/archives/CTEST12345/p1793990180251589"
KEY = "CTEST12345/1793990180.251589"
REPLY = URL.replace("p1793990180251589", "p1793990999000100") + "?thread_ts=1793990180.251589&cid=CTEST12345"


class Keys(unittest.TestCase):
    def test_top_level_post(self):
        import _common as c
        self.assertEqual(list(c.thread_keys(URL)), [KEY])
        self.assertEqual(c.top_level_keys(URL), {KEY})

    def test_reply_link_resolves_to_root_and_is_not_top_level(self):
        import _common as c
        self.assertEqual(list(c.thread_keys(REPLY)), [KEY])
        self.assertEqual(c.top_level_keys(REPLY), set())

    def test_dm_is_never_top_level(self):
        import _common as c
        self.assertEqual(c.top_level_keys("https://acme.slack.com/archives/DTEST12345/p1793990180251589"), set())


class Handle(HomeCase):
    def run_handle(self, owned, first=True, sid="sess-1"):
        buf = io.StringIO()
        with redirect_stdout(buf):
            hook.handle({KEY: URL}, sid, "/work/proj", first, owned)
        out = buf.getvalue().strip()
        return json.loads(out)["hookSpecificOutput"]["additionalContext"] if out else ""

    def test_unowned_is_claimed_with_ticket_prompt(self):
        ctx = self.run_handle({})
        self.assertIn("loom:handling-slack-threads", ctx)
        ev = self.events()
        self.assertEqual([(e["kind"], e["mode"]) for e in ev], [("thread.claim", "if_unowned")])
        self.assertEqual(ev[0]["key"], KEY)

    def test_owned_by_me_is_silent(self):
        self.assertEqual(self.run_handle({KEY: {"session_id": "sess-1"}}), "")
        self.assertEqual(self.events(), [])

    def test_first_prompt_takes_over_and_names_transcript(self):
        ctx = self.run_handle({KEY: {"session_id": "other", "title": "Old chat", "transcript_path": "/t/other.jsonl"}})
        self.assertIn("/t/other.jsonl", ctx)
        self.assertEqual([e["mode"] for e in self.events()], ["takeover"])

    def test_mid_conversation_only_a_note(self):
        ctx = self.run_handle({KEY: {"session_id": "other", "title": "Old chat"}}, first=False)
        self.assertIn("already belong to another chat", ctx)
        self.assertEqual(self.events(), [])


class Process(HomeCase):
    def run_hook(self, prompt, env=None):
        e = dict(os.environ, **(env or {}))
        e.pop("CLAUDE_CODE_ENTRYPOINT", None)
        e.update(env or {})
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "thread-ownership.py")],
                           input=json.dumps({"prompt": prompt, "session_id": "sess-1", "cwd": "/w", "transcript_path": ""}),
                           capture_output=True, text=True, env=e)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_off_when_slack_skipped(self):
        self.write_state(slack_mode="skip")
        self.assertEqual(self.run_hook("see " + URL), "")
        self.assertEqual(self.events(), [])

    def test_loom_down_still_claims_when_on(self):
        self.write_state(slack_mode="direct")
        out = self.run_hook("see " + URL)
        self.assertIn("this chat now owns", out)
        self.assertEqual(len(self.events()), 1)

    def test_no_url_no_output(self):
        self.write_state(slack_mode="direct")
        self.assertEqual(self.run_hook("hello"), "")

    def test_headless_entrypoint_never_claims(self):
        self.write_state(slack_mode="direct")
        self.assertEqual(self.run_hook("see " + URL, env={"CLAUDE_CODE_ENTRYPOINT": "sdk-cli"}), "")
        self.assertEqual(self.events(), [])


class CliStarted(HomeCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, LOOM_BIN] + list(args), capture_output=True, text=True, env=os.environ)

    def test_started_writes_if_unowned_claim(self):
        r = self.run_cli("thread", "started", URL)
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = self.events()
        self.assertEqual((ev[0]["kind"], ev[0]["mode"], ev[0]["started"]), ("thread.claim", "if_unowned", True))
        self.assertEqual(ev[0]["session"], "sess-1")

    def test_started_accepts_bare_key(self):
        self.run_cli("thread", "started", KEY)
        self.assertEqual(self.events()[0]["key"], KEY)

    def test_started_skips_dms(self):
        r = self.run_cli("thread", "started", "DTEST12345/1793990180.251589")
        self.assertEqual(self.events(), [])
        self.assertIn("nothing to claim", r.stdout)

    def test_started_needs_a_session(self):
        env = dict(os.environ)
        env.pop("CLAUDE_CODE_SESSION_ID")
        env.pop("CODEX_THREAD_ID", None)
        r = subprocess.run([sys.executable, LOOM_BIN, "thread", "started", URL], capture_output=True, text=True, env=env)
        self.assertEqual(r.returncode, 2)


if __name__ == "__main__":
    unittest.main()
