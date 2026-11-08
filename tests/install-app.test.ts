import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * scripts/install-app.sh against a throwaway "Applications" dir, with pgrep,
 * osascript, open and curl stubbed on PATH. A file `running` stands for a live
 * Loom main process; every stub appends to `events`, as does the script's trace.
 *
 * The regression (2026-11-06 08:46 crash): the old recipe quit Loom, slept, then
 * deleted and recopied the bundle. A Dock click during the sleep relaunched the
 * OLD bundle and the delete pulled it out from under the new process, which
 * crashed in V8. The installer must never swap while a Loom is running, and must
 * re-quit a Loom that relaunched after the first quit.
 */

const SCRIPT = path.resolve(__dirname, '../scripts/install-app.sh');

let tmp: string;
let bin: string;
let dest: string;
let src: string;
let events: string;
let running: string;

const write = (p: string, body: string, mode = 0o644) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, { mode });
};

function makeBundle(dir: string, marker: string): void {
  write(path.join(dir, 'Contents/MacOS/Loom'), '#!/bin/sh\n', 0o755);
  write(path.join(dir, 'Contents/Resources/marker'), marker);
}

/** quitBehaviour: what the stub osascript does with the `running` file. */
function stubs(quitBehaviour: 'quits' | 'relaunches-once' | 'never-quits'): void {
  const q = {
    quits: `rm -f "${running}"`,
    // The first quit exits Loom, then a "Dock click" brings it straight back.
    'relaunches-once': `rm -f "${running}"; if [ ! -e "${tmp}/relaunched" ]; then touch "${tmp}/relaunched"; ( sleep 0.1; echo relaunch >> "${events}"; touch "${running}" ) & fi`,
    'never-quits': ':',
  }[quitBehaviour];
  write(path.join(bin, 'pgrep'), `#!/bin/bash\n[ -e "${running}" ] && { echo 4242; exit 0; }\nexit 1\n`, 0o755);
  write(path.join(bin, 'osascript'), `#!/bin/bash\necho osascript >> "${events}"\n${q}\n`, 0o755);
  write(path.join(bin, 'open'), `#!/bin/bash\necho "open $1" >> "${events}"\n`, 0o755);
  write(path.join(bin, 'curl'), `#!/bin/bash\nprintf 200\n`, 0o755);
}

function run(args: string[] = []) {
  return spawnSync('bash', [SCRIPT, src, ...args], {
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${bin}:/usr/bin:/bin`,
      LOOM_APP_DEST: dest,
      LOOM_QUIT_TIMEOUT: '3',
      LOOM_INSTALL_TRACE: events,
    },
  });
}

const marker = () => fs.readFileSync(path.join(dest, 'Contents/Resources/marker'), 'utf-8');
const log = () => fs.readFileSync(events, 'utf-8').trim().split('\n');

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-install-app-'));
  bin = path.join(tmp, 'bin');
  dest = path.join(tmp, 'Applications/Loom.app');
  src = path.join(tmp, 'release/Loom.app');
  events = path.join(tmp, 'events');
  running = path.join(tmp, 'running');
  fs.writeFileSync(events, '');
  makeBundle(dest, 'old');
  makeBundle(src, 'new');
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('install-app.sh', () => {
  it('stages first, quits the running Loom, swaps only once it is gone, then opens', () => {
    stubs('quits');
    fs.writeFileSync(running, '');
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(marker()).toBe('new');
    expect(log()).toEqual(['stage', 'quit', 'osascript', 'swap', 'open', 'open ' + dest]);
    // No staging or replaced copies left next to the app.
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['Loom.app']);
  });

  it('re-quits a Loom that relaunched after the first quit (the Dock-click crash) before swapping', () => {
    stubs('relaunches-once');
    fs.writeFileSync(running, '');
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    const ev = log();
    expect(ev.filter((e) => e === 'osascript')).toHaveLength(2);
    // The relaunch is seen and quit again, all before the bundle is touched.
    expect(ev.indexOf('relaunch')).toBeLessThan(ev.indexOf('swap'));
    expect(ev.lastIndexOf('osascript')).toBeLessThan(ev.indexOf('swap'));
    expect(fs.existsSync(running)).toBe(false);
    expect(marker()).toBe('new');
  });

  it('never sends quit (which would LAUNCH Loom) when none is running', () => {
    stubs('quits');
    const r = run(['--no-open']);
    expect(r.status, r.stderr).toBe(0);
    expect(log()).toEqual(['stage', 'swap']);
    expect(marker()).toBe('new');
  });

  it('gives up without touching the installed app when Loom will not quit', () => {
    stubs('never-quits');
    fs.writeFileSync(running, '');
    const r = run();
    expect(r.status).not.toBe(0);
    expect(marker()).toBe('old');
    expect(log()).not.toContain('swap');
    expect(fs.readdirSync(path.dirname(dest))).toEqual(['Loom.app']);
  });
});
