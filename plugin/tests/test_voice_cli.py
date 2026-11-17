"""`loom slack mine` and `loom settings set`: the voice-tuning skill's two commands."""
import os
import subprocess
import sys
import unittest

from helpers import LOOM_BIN, HomeCase


class VoiceCli(HomeCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, LOOM_BIN] + list(args), capture_output=True, text=True, env=os.environ)

    def test_settings_set_writes_a_setting_event(self):
        r = self.run_cli("settings", "set", "voice_skill", "sam-voice")
        self.assertEqual(r.returncode, 0, r.stderr)
        ev = self.events()[0]
        self.assertEqual((ev["kind"], ev["key"], ev["value"]), ("setting.set", "voice_skill", "sam-voice"))

    def test_settings_set_refuses_other_keys_and_bad_names(self):
        self.assertEqual(self.run_cli("settings", "set", "perm_chats", "skip").returncode, 2)
        self.assertEqual(self.run_cli("settings", "set", "voice_skill", "bad name").returncode, 2)
        self.assertEqual(self.events(), [])

    def test_slack_mine_fails_cleanly_when_loom_is_down(self):
        r = self.run_cli("slack", "mine", "--limit", "10")
        self.assertEqual(r.returncode, 3)
        self.assertIn("not reachable", r.stderr)

    def test_slack_mine_checks_the_limit(self):
        self.assertEqual(self.run_cli("slack", "mine", "--limit", "0").returncode, 2)
        self.assertEqual(self.run_cli("slack", "nope").returncode, 2)


if __name__ == "__main__":
    unittest.main()
