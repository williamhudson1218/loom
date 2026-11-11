import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

// Point every test run at a throwaway Loom home. src/paths.ts resolves TOOL_DIR
// from $LOOM_HOME at import time, so this has to be set before any src module is
// loaded — hence an env file rather than a per-test setup hook.
//
// Without it the suite reads and WRITES the developer's real ~/.loom/manager.db:
// anything exercising a server route opens the live DB, and a settings route test
// silently rewrites the launch preference they had chosen.
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-test-home-'));

// The same for tmux. Code under test runs plain `tmux …` (no -L/-S), which talks to
// the default server under $TMUX_TMPDIR, or to the one $TMUX names when the suite
// runs inside tmux: the developer's real workspace. A throwaway TMUX_TMPDIR (short,
// for the 104-byte socket path limit) and no $TMUX (tests/setup-env.ts) give every
// such call an empty server of its own; tests that want one start it with -L.
const testTmux = fs.mkdtempSync('/tmp/loom-tmux-');

export default defineConfig({
  test: {
    env: { LOOM_HOME: testHome, TMUX_TMPDIR: testTmux },
    setupFiles: ['tests/setup-env.ts'],
  },
});
