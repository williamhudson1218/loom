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

export default defineConfig({
  test: {
    env: { LOOM_HOME: testHome },
  },
});
