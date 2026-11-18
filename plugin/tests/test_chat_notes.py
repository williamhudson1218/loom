"""chat-notes hook: Loom's notes for a chat are handed over once, as additionalContext."""
import json
import os
import subprocess
import sys

from helpers import HOOKS, HomeCase


class ChatNotes(HomeCase):
    def run_hook(self, sid="sess-1", event="UserPromptSubmit", env=None):
        e = dict(os.environ)
        e.pop("CLAUDE_CODE_ENTRYPOINT", None)
        e.update(env or {})
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "chat-notes.py")],
                           input=json.dumps({"session_id": sid, "hook_event_name": event, "prompt": "hi"}),
                           capture_output=True, text=True, env=e)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def note(self, sid, *texts):
        d = os.path.join(self.home, "chat-notes")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, sid + ".jsonl"), "a") as f:
            for t in texts:
                f.write(json.dumps({"at": 1, "text": t}) + "\n")

    def test_no_notes_no_output(self):
        self.assertEqual(self.run_hook(), "")

    def test_delivers_once_in_order(self):
        self.note("sess-1", "first sent", "second sent")
        self.note("other", "not mine")
        out = json.loads(self.run_hook(event="PostToolUse"))
        self.assertEqual(out["hookSpecificOutput"]["hookEventName"], "PostToolUse")
        self.assertEqual(out["hookSpecificOutput"]["additionalContext"], "first sent\n\nsecond sent")
        self.assertEqual(self.run_hook(), "")
        self.assertEqual(os.listdir(os.path.join(self.home, "chat-notes")), ["other.jsonl"])

    def test_headless_runs_are_skipped(self):
        self.note("sess-1", "sent")
        self.assertEqual(self.run_hook(env={"CLAUDE_CODE_ENTRYPOINT": "sdk-cli"}), "")
        self.assertIn("sent", self.run_hook())

    def test_bad_session_id_is_ignored(self):
        self.assertEqual(self.run_hook(sid="../x"), "")
