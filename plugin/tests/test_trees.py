"""loom trees prune: argument handling and the failure mode with no Loom running."""
import os
import subprocess
import sys

from helpers import LOOM_BIN, HomeCase


class TreesPrune(HomeCase):
    def run_cli(self, *args):
        return subprocess.run([sys.executable, LOOM_BIN] + list(args), capture_output=True, text=True, env=os.environ)

    def test_unknown_subcommand(self):
        self.assertEqual(self.run_cli("trees").returncode, 2)
        self.assertEqual(self.run_cli("trees", "frob").returncode, 2)

    def test_repo_needs_a_value_and_no_stray_args(self):
        self.assertEqual(self.run_cli("trees", "prune", "--repo").returncode, 2)
        self.assertEqual(self.run_cli("trees", "prune", "extra").returncode, 2)

    def test_without_loom_fails_cleanly(self):
        r = self.run_cli("trees", "prune", "--dry-run")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn("not reachable", r.stderr)

    def test_never_writes_events(self):
        self.run_cli("trees", "prune")
        self.assertEqual(self.events(), [])


if __name__ == "__main__":
    import unittest
    unittest.main()
