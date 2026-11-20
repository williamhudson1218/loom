#!/usr/bin/env node
// Patch node-pty 1.1.0's macOS fd leak before it is compiled.
//
// pty_posix_spawn (src/unix/pty.cc) opens up to three "low fd" /dev/ptmx masters
// so the real master never lands on fd 0-2, then closes them with
//   for (; count > 0; count--) close(low_fds[count]);
// which never closes low_fds[0]. In the normal case (fds 0-2 already taken) that
// is the only one, so EVERY spawn leaks one live pseudo-terminal master for the
// life of the process. Loom spawns one per terminal view it opens, and the
// leaked masters count against kern.tty.ptmx_max until macOS runs out
// ("fork failed: Device not configured"). Fixed upstream in 1.2.0-beta; this
// applies the same close loop to the stable release. Idempotent.
//
// Usage: node scripts/patch-node-pty.cjs <path to node_modules/node-pty>...
'use strict';
const fs = require('fs');
const path = require('path');

const BUGGY = /for \(; count > 0; count--\) \{\s*close\(low_fds\[count\]\);\s*\}/;
const FIXED = 'for (size_t i = 0; i <= count && i < 3; i++) {\n    close(low_fds[i]);\n  }';
const MARKER = 'close(low_fds[i]);';

function patch(dir) {
  const file = path.join(dir, 'src', 'unix', 'pty.cc');
  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    return `${dir}: not installed, skipped`;
  }
  if (src.includes(MARKER)) return `${file}: already patched`;
  if (!BUGGY.test(src)) {
    // A node-pty that changed this code: fail loudly so nobody ships an unchecked build.
    console.error(`[patch-node-pty] ${file}: low_fds close loop not found; check whether this node-pty still leaks`);
    process.exitCode = 1;
    return `${file}: NOT patched`;
  }
  fs.writeFileSync(file, src.replace(BUGGY, FIXED));
  return `${file}: patched`;
}

module.exports = { patch, BUGGY, FIXED, MARKER };

if (require.main === module) {
  for (const d of process.argv.slice(2)) console.log('[patch-node-pty] ' + patch(d));
}
