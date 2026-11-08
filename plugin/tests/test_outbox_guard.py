"""PreToolUse outbox guard: a Slack post needs a matching pending outbox draft from the same chat."""
import json
import os
import subprocess
import sys
import unittest

from helpers import HOOKS, HomeCase, load

guard = load("outbox_guard", "outbox-guard.py")

CH, TS = "C0TESTADV01", "1793825192.594839"
KATE = ("Sorry, wasn't clear. We already have what's in the app (834092000), the problem is it's only 9 digits "
        "so it needs to come from CT directly.")

# The saffron-leopard leak, 2026-11-06: a heredoc payload and a send in one command, no draft on record.
KATE_SEND = (
    "cd ~/.claude/tools/slack && cat > /tmp/s/reply.json <<'EOF'\n"
    + json.dumps({"channel": CH, "thread_ts": TS, "text": KATE})
    + "\nEOF\nnode slack.mjs send --file /tmp/s/reply.json"
)
# Its earlier send: the payload file is built by the same command, so only the python literal shows the target.
PY_SEND = (
    "cd /tmp/s && python3 -c \"import json;print(json.dumps({'channel':'%s','thread_ts':'%s',"
    "'text':open('d2.md').read().strip()}))\" > send2.json && node ~/.claude/tools/slack/slack.mjs send --file send2.json"
    % (CH, TS)
)


def draft(did, session="sess-1", status="pending", channel=CH, thread_ts=TS, messages=(KATE,), **kw):
    d = {"id": did, "session_id": session, "channel": channel, "messages": list(messages), "status": status,
         "created_at": "2026-11-06T20:00:00"}
    if thread_ts:
        d["thread_ts"] = thread_ts
    d.update(kw)
    return d


class Detect(unittest.TestCase):
    def test_posts(self):
        for cmd in (
            KATE_SEND,
            PY_SEND,
            "node ~/.claude/tools/slack/slack.mjs send --file p.json",
            "slack send --channel C1 --text hi",
            "~/dev/toolbox/bin/slack-threads send x",
            "curl -s -X POST https://slack.com/api/chat.postMessage -d channel=C1",
            "curl -s -d @p.json $API/chat.postMessage",
            # a preview beside a send does not hide the send
            "node slack.mjs preview --file p.json && node slack.mjs send --file p.json",
            "S=~/.claude/tools/slack/slack.mjs; node $S send --file p.json",
        ):
            self.assertTrue(guard.is_send_call("Bash", {"command": cmd}), cmd)

    def test_not_posts(self):
        for cmd in (
            "node slack.mjs read-thread --channel %s --ts %s" % (CH, TS),
            "node slack.mjs preview --file p.json",
            "node slack.mjs draft --file p.json",
            "node slack.mjs react --channel C1 --ts 1.2 --emoji eyes",
            "~/dev/toolbox/bin/slack-threads outbox sent d1 --permalink u --by chat",
            "~/.claude/hooks/slack-threads.py open https://x.slack.com/archives/C1/p1793825192594839 --ack",
            "loom outbox add --thread u --text-file m1.md",
            "git commit -m 'send the slack post'",
            "grep -n chat.postMessage src/slack.ts",
            # a heredoc body is data: editing a test that mentions a send is not a send
            "python3 - <<'EOF'\nopen('t.ts','w').write('node slack.mjs send --file p.json')\nEOF",
        ):
            self.assertFalse(guard.is_send_call("Bash", {"command": cmd}), cmd)

    def test_mcp(self):
        self.assertTrue(guard.is_send_call("mcp__claude_ai_Slack__slack_send_message", {}))
        self.assertTrue(guard.is_send_call("mcp__claude_ai_Slack__slack_schedule_message", {}))
        self.assertFalse(guard.is_send_call("mcp__claude_ai_Slack__slack_send_message_draft", {}))
        self.assertFalse(guard.is_send_call("mcp__claude_ai_Slack__slack_read_thread", {}))


class Extract(unittest.TestCase):
    def test_heredoc(self):
        call = guard.extract("Bash", {"command": KATE_SEND})
        self.assertEqual((call["channel"], call["thread_ts"], call["texts"]), (CH, TS, [KATE]))

    def test_python_literal(self):
        call = guard.extract("Bash", {"command": PY_SEND})
        self.assertEqual((call["channel"], call["thread_ts"], call["texts"]), (CH, TS, []))

    def test_existing_file(self):
        import tempfile
        d = tempfile.mkdtemp()
        with open(os.path.join(d, "p.json"), "w") as f:
            json.dump({"channel": CH, "thread_ts": TS, "messages": ["one two three four", "five"]}, f)
        call = guard.extract("Bash", {"command": "cd %s && node slack.mjs send --file p.json" % d})
        self.assertEqual(call["texts"], ["one two three four", "five"])

    def test_mcp(self):
        call = guard.extract("mcp__claude_ai_Slack__slack_send_message",
                             {"channel_id": CH, "thread_ts": TS, "message": KATE})
        self.assertEqual((call["channel"], call["thread_ts"], call["texts"]), (CH, TS, [KATE]))


class Decide(unittest.TestCase):
    def call(self, cmd=KATE_SEND):
        return guard.extract("Bash", {"command": cmd})

    def test_saffron_leopard_leak_is_denied(self):
        reason = guard.decide(self.call(), {}, "sess-1")
        self.assertIn("no Loom outbox draft", reason)
        self.assertIn("loom outbox add", reason)

    def test_matching_pending_draft_allows(self):
        self.assertIsNone(guard.decide(self.call(), {"d1": draft("d1")}, "sess-1"))

    def test_other_sessions_draft_does_not_count(self):
        self.assertTrue(guard.decide(self.call(), {"d1": draft("d1", session="other")}, "sess-1"))

    def test_revised_text_not_recorded_is_denied(self):
        reason = guard.decide(self.call(), {"d1": draft("d1", messages=["No worries, that one's on me."])}, "sess-1")
        self.assertIn("does not match outbox draft d1", reason)

    def test_other_thread_is_denied(self):
        self.assertTrue(guard.decide(self.call(), {"d1": draft("d1", thread_ts="1793825192.000001")}, "sess-1"))

    def test_thread_draft_does_not_cover_top_level_post(self):
        top = guard.extract("mcp__x_slack_send_message", {"channel_id": CH, "message": KATE})
        self.assertTrue(guard.decide(top, {"d1": draft("d1")}, "sess-1"))

    def test_already_sent_is_denied(self):
        d = draft("d1", status="sent", sent_by="loom", permalink="https://x.slack.com/archives/C/p1")
        reason = guard.decide(self.call(), {"d1": d}, "sess-1")
        self.assertIn("already sent from Loom", reason)

    def test_marked_sent_by_chat_still_covers_the_post(self):
        # Loom's watcher has marked drafts sent at the moment they were recorded; the real send follows.
        d = draft("d1", status="sent", sent_by="chat", closed_at="2026-11-06T20:00:05")
        now = guard._epoch("2026-11-06T20:10:00")
        self.assertIsNone(guard.decide(self.call(), {"d1": d}, "sess-1", now=now))
        # ...but not days later, which would let any post to that thread through.
        self.assertTrue(guard.decide(self.call(), {"d1": d}, "sess-1", now=now + 86400))

    def test_superseded_does_not_count(self):
        self.assertTrue(guard.decide(self.call(), {"d1": draft("d1", status="superseded")}, "sess-1"))

    def test_payload_built_in_same_command_matches_destination(self):
        self.assertIsNone(guard.decide(self.call(PY_SEND), {"d1": draft("d1", messages=["anything"])}, "sess-1"))
        self.assertTrue(guard.decide(self.call(PY_SEND), {}, "sess-1"))

    def test_channel_name_draft_matches_by_text(self):
        call = guard.extract("mcp__x_slack_send_message", {"channel_id": "C08ABCDEF", "message": "Release notes are up"})
        d = draft("d1", channel="#pay-and-file-eng", thread_ts=None, messages=["Release notes are up"])
        self.assertIsNone(guard.decide(call, {"d1": d}, "sess-1"))


class Store(HomeCase):
    def write_outbox(self, *drafts):
        with open(os.path.join(self.home, "outbox.json"), "w") as f:
            json.dump({"drafts": {d["id"]: d for d in drafts}}, f)

    def test_unread_add_event_counts(self):
        import _common as c
        c.write_event("outbox.add", session="sess-1", id="d9", channel=CH, thread_ts=TS, messages=[KATE])
        drafts = guard.load_drafts(self.home)
        self.assertEqual(drafts["d9"]["status"], "pending")

    def test_update_and_supersede_events_apply(self):
        import _common as c
        self.write_outbox(draft("d1", messages=["old"]), draft("d2"))
        c.write_event("outbox.update", session="sess-1", id="d1", messages=[KATE])
        c.write_event("outbox.supersede", session="sess-1", id="d2")
        drafts = guard.load_drafts(self.home)
        self.assertEqual(drafts["d1"]["messages"], [KATE])
        self.assertEqual(drafts["d2"]["status"], "superseded")

    def test_add_event_supersedes_same_destination(self):
        import _common as c
        self.write_outbox(draft("d1"))
        c.write_event("outbox.add", session="sess-1", id="d2", channel=CH, thread_ts=TS, messages=[KATE])
        drafts = guard.load_drafts(self.home)
        self.assertEqual((drafts["d1"]["status"], drafts["d2"]["status"]), ("superseded", "pending"))

    def test_missing_or_corrupt_store_is_empty(self):
        self.assertEqual(guard.load_drafts(self.home), {})
        with open(os.path.join(self.home, "outbox.json"), "w") as f:
            f.write("{not json")
        self.assertEqual(guard.load_drafts(self.home), {})


class Main(HomeCase):
    def run_hook(self, tool_name, tool_input, session="sess-1"):
        p = subprocess.run([sys.executable, os.path.join(HOOKS, "outbox-guard.py")],
                           input=json.dumps({"session_id": session, "tool_name": tool_name, "tool_input": tool_input,
                                             "hook_event_name": "PreToolUse"}),
                           capture_output=True, text=True, env=dict(os.environ), timeout=10)
        self.assertEqual(p.returncode, 0, p.stderr)
        return json.loads(p.stdout)["hookSpecificOutput"] if p.stdout.strip() else None

    def test_off_without_slack(self):
        self.assertIsNone(self.run_hook("Bash", {"command": KATE_SEND}))
        self.write_state(slack_mode="skip", outbox_chat_drafts=True)
        self.assertIsNone(self.run_hook("Bash", {"command": KATE_SEND}))

    def test_off_without_chat_drafts(self):
        self.write_state(slack_mode="direct", outbox_chat_drafts=False)
        self.assertIsNone(self.run_hook("Bash", {"command": KATE_SEND}))

    def test_explicit_switch_wins(self):
        self.write_state(slack_mode="skip", outbox_guard=True)
        self.assertEqual(self.run_hook("Bash", {"command": KATE_SEND})["permissionDecision"], "deny")
        self.write_state(slack_mode="direct", outbox_chat_drafts=True, outbox_guard=False)
        self.assertIsNone(self.run_hook("Bash", {"command": KATE_SEND}))

    def test_denies_then_allows_once_recorded(self):
        self.write_state(slack_mode="direct", outbox_chat_drafts=True)
        out = self.run_hook("Bash", {"command": KATE_SEND})
        self.assertEqual(out["permissionDecision"], "deny")
        self.assertIn("loom outbox add", out["permissionDecisionReason"])
        import _common as c
        c.write_event("outbox.add", session="sess-1", id="d9", channel=CH, thread_ts=TS, messages=[KATE])
        self.assertIsNone(self.run_hook("Bash", {"command": KATE_SEND}))

    def test_non_send_passes_untouched(self):
        self.write_state(slack_mode="direct", outbox_chat_drafts=True)
        self.assertIsNone(self.run_hook("Bash", {"command": "node slack.mjs read-thread --channel C1 --ts 1.2"}))
        self.assertIsNone(self.run_hook("mcp__claude_ai_Slack__slack_read_thread", {"channel_id": CH}))

    def test_mcp_send_denied(self):
        self.write_state(slack_mode="mcp", outbox_chat_drafts=True)
        out = self.run_hook("mcp__claude_ai_Slack__slack_send_message", {"channel_id": CH, "thread_ts": TS, "message": KATE})
        self.assertEqual(out["permissionDecision"], "deny")


if __name__ == "__main__":
    unittest.main()
