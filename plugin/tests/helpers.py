"""Shared test setup: load the hook modules (hyphenated filenames) and isolate LOOM_HOME."""
import importlib.util
import os
import shutil
import sys
import tempfile
import unittest

PLUGIN = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "loom")
HOOKS = os.path.join(PLUGIN, "hooks")
LOOM_BIN = os.path.join(PLUGIN, "bin", "loom")
sys.path.insert(0, HOOKS)


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, os.path.join(HOOKS, filename))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class HomeCase(unittest.TestCase):
    """Each test gets a fresh LOOM_HOME and no Loom server (port 1 refuses)."""

    def setUp(self):
        self.home = tempfile.mkdtemp()
        self._env = dict(os.environ)
        os.environ["LOOM_HOME"] = self.home
        os.environ["LOOM_PORT"] = "1"
        os.environ["CLAUDE_CODE_SESSION_ID"] = "sess-1"
        os.environ.pop("CLAUDE_PLUGIN_ROOT", None)
        self.addCleanup(self._restore)

    def _restore(self):
        os.environ.clear()
        os.environ.update(self._env)
        shutil.rmtree(self.home, ignore_errors=True)

    def write_state(self, **kw):
        import json
        with open(os.path.join(self.home, "plugin-state.json"), "w") as f:
            json.dump(kw, f)

    def events(self):
        import json
        d = os.path.join(self.home, "events")
        out = []
        for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
            if n.endswith(".json") and not n.startswith("."):
                with open(os.path.join(d, n)) as f:
                    out.append(json.load(f))
        return out
