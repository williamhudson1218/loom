"""Port of the toolbox outbox-hook tests, against the generic plugin hook."""
import json
import os
import subprocess
import sys
import unittest

from helpers import HOOKS, HomeCase, load

hook = load("outbox_hook", "outbox-recording.py")


def user(text):
    return {"type": "user", "message": {"role": "user", "content": text}}


def asst(*blocks):
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks), "stop_reason": "end_turn"}}


def text(t):
    return {"type": "text", "text": t}


def bash(cmd):
    return {"type": "tool_use", "name": "Bash", "input": {"command": cmd}}


def result():
    return {"type": "user", "message": {"role": "user", "content": [{"type": "tool_result", "content": "ok"}]}}


MISS = (
    "Draft reply to Sam in the thread. They replied there earlier, so there's no greeting:\n\n"
    "> Thanks! I can't get to the attachments, can you drop it in a shared folder and send me the link?\n\n"
    "Nothing has been sent yet. OK to send?\n\nWaiting on you: go-ahead to send."
)
NUMBERED = (
    "Draft to #general, three parts:\n\n> 1. Heads up on the release.\n> 2. Notes are attached.\n"
    "> 3. Need a yes by Friday.\n\nSay \"send\" and I'll post it."
)


class Analyse(unittest.TestCase):
    def test_miss_blocks(self):
        self.assertTrue(hook.analyse([user("ask her"), asst(text(MISS))]))

    def test_numbered_blocks(self):
        self.assertTrue(hook.analyse([user("draft"), asst(text(NUMBERED))]))

    def test_outbox_add_in_turn_ok(self):
        recs = [user("x"), asst(bash("loom outbox add --session $S --thread u --text-file m1.md")), result(), asst(text(MISS))]
        self.assertIsNone(hook.analyse(recs))

    def test_forwarding_cli_outbox_add_ok(self):
        # An older `slack-threads outbox add` that forwards to `loom` counts as recording the draft.
        recs = [user("x"), asst(bash("~/bin/slack-threads outbox add --thread u --text-file m1.md")), result(), asst(text(MISS))]
        self.assertIsNone(hook.analyse(recs))

    def test_unrelated_outbox_words_do_not_count(self):
        recs = [user("x"), asst(bash("echo outbox add")), result(), asst(text(MISS))]
        self.assertTrue(hook.analyse(recs))

    def test_outbox_update_ok(self):
        recs = [user("x"), asst(bash("loom outbox update 3 --text-file m.md")), result(), asst(text(MISS))]
        self.assertIsNone(hook.analyse(recs))

    def test_other_cli_named_outbox_does_not_count(self):
        recs = [user("x"), asst(bash("other-tool outbox add --text-file m.md")), result(), asst(text(MISS))]
        self.assertTrue(hook.analyse(recs))

    def test_recorded_earlier_same_text_ok(self):
        quote = "Thanks! I can't get to the attachments, can you drop it in a shared folder and send me the link?"
        recs = [
            user("draft"),
            asst({"type": "tool_use", "name": "Write", "input": {"file_path": "m1.md", "content": quote}}),
            asst(bash("loom outbox add --session S --thread u --text-file m1.md")),
            asst(text("recorded")),
            user("what's the status"),
            asst(text(MISS)),
        ]
        self.assertIsNone(hook.analyse(recs))

    def test_edited_draft_after_record_blocks(self):
        recs = [
            user("draft"),
            asst({"type": "tool_use", "name": "Write", "input": {"file_path": "m1.md", "content": "Old wording entirely different here"}}),
            asst(bash("loom outbox add --session S --thread u --text-file m1.md")),
            user("shorter"),
            asst(text(MISS)),
        ]
        self.assertTrue(hook.analyse(recs))

    def test_sent_report_ok(self):
        t = "Posted the draft reply to Sam in the thread.\n\n> Thanks! I can't get to the attachments.\n\nDone."
        self.assertIsNone(hook.analyse([user("send"), asst(text(t))]))

    def test_plain_quote_without_draft_cue_ok(self):
        t = "The error says:\n\n> connection refused while dialing the upstream service\n\nThat is the proxy."
        self.assertIsNone(hook.analyse([user("why"), asst(text(t))]))

    def test_final_override_wins_over_unflushed_transcript(self):
        self.assertTrue(hook.analyse([user("ask her")], final_override=MISS))

    def test_final_message_only(self):
        recs = [user("x"), asst(text(MISS)), result(), asst(text("Done, nothing to send."))]
        self.assertIsNone(hook.analyse(recs))


class Process(HomeCase):
    def run_hook(self, recs, **payload):
        path = os.path.join(self.home, "t.jsonl")
        with open(path, "w") as f:
            f.write("\n".join(json.dumps(r) for r in recs))
        p = dict({"transcript_path": path, "session_id": "sess-1"}, **payload)
        r = subprocess.run([sys.executable, os.path.join(HOOKS, "outbox-recording.py")],
                           input=json.dumps(p), capture_output=True, text=True, env=os.environ)
        self.assertEqual(r.returncode, 0, r.stderr)
        return r.stdout.strip()

    def test_off_when_slack_skipped(self):
        self.write_state(slack_mode="skip", outbox_chat_drafts=True)
        self.assertEqual(self.run_hook([user("x"), asst(text(MISS))]), "")

    def test_off_when_chat_drafts_off(self):
        self.write_state(slack_mode="direct", outbox_chat_drafts=False)
        self.assertEqual(self.run_hook([user("x"), asst(text(MISS))]), "")

    def test_off_with_no_state_file(self):
        self.assertEqual(self.run_hook([user("x"), asst(text(MISS))]), "")

    def test_blocks_when_on(self):
        self.write_state(slack_mode="mcp", outbox_chat_drafts=True)
        out = json.loads(self.run_hook([user("x"), asst(text(MISS))]))
        self.assertEqual(out["decision"], "block")
        self.assertIn("loom outbox add", out["reason"])

    def test_stop_hook_active_never_blocks(self):
        self.write_state(slack_mode="direct", outbox_chat_drafts=True)
        self.assertEqual(self.run_hook([user("x"), asst(text(MISS))], stop_hook_active=True), "")

    def test_payload_last_message_used(self):
        self.write_state(slack_mode="direct", outbox_chat_drafts=True)
        out = self.run_hook([user("x")], last_assistant_message=MISS)
        self.assertEqual(json.loads(out)["decision"], "block")


if __name__ == "__main__":
    unittest.main()
