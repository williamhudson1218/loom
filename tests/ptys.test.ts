import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { countPtys, explainTmuxFailure, isPtyExhaustion, outOfTerminalsDetail, ptyRefusal, readPtyMax } from '../src/ptys.ts';
import { acquireManagedPane } from '../src/managed.ts';

const require = createRequire(import.meta.url);
const { patch } = require('../scripts/patch-node-pty.cjs') as { patch: (dir: string) => string };

const roomy = () => ({ freeMem: 8 * 1024 ** 3, totalMem: 16 * 1024 ** 3, load1: 0, cpus: 8 });
const FORK_FAIL = 'Command failed: tmux new-window -d -t =loom-managed: -c /x -P -F #{pane_id}\ncreate window failed: fork failed: Device not configured';

describe('pty usage', () => {
  it('counts /dev/ttysNNN nodes only', () => {
    expect(countPtys(() => ['ttys000', 'ttys123', 'ttyp0', 'tty', 'ptmx', 'ttys', 'ttys01a'])).toBe(2);
    expect(countPtys(() => { throw new Error('no /dev'); })).toBe(0);
  });

  it('reads kern.tty.ptmx_max, falling back to the macOS default', () => {
    expect(readPtyMax(() => '999\n')).toBe(999);
    expect(readPtyMax(() => 'junk')).toBe(511);
    expect(readPtyMax(() => { throw new Error('no sysctl'); })).toBe(511);
  });
});

describe('out of terminals', () => {
  it("recognises tmux's fork failure, not other fork errors", () => {
    expect(isPtyExhaustion(FORK_FAIL)).toBe(true);
    expect(isPtyExhaustion('fork failed: Resource temporarily unavailable')).toBe(false);
    expect(isPtyExhaustion("can't find session: loom-managed")).toBe(false);
  });

  it('says how many are in use and what to do, and offers the sysctl only below the hard cap', () => {
    const low = outOfTerminalsDetail({ used: 511, max: 511, ratio: 1 });
    expect(low).toMatch(/^Out of terminals \(511\/511 in use\)\./);
    expect(low).toMatch(/Close tmux panes/);
    expect(low).toMatch(/kern\.tty\.ptmx_max=999/);
    expect(outOfTerminalsDetail({ used: 998, max: 999, ratio: 0.999 })).not.toMatch(/sysctl/);
  });

  it('refuses only with fewer than two free', () => {
    expect(ptyRefusal({ used: 500, max: 511, ratio: 0.98 })).toBeNull();
    expect(ptyRefusal({ used: 510, max: 511, ratio: 0.998 })).toMatch(/Out of terminals \(510\/511/);
  });

  it('passes other tmux errors through unchanged', () => {
    expect(explainTmuxFailure('no server running', () => ({ used: 1, max: 9, ratio: 0.1 }))).toBe('no server running');
    expect(explainTmuxFailure(FORK_FAIL, () => ({ used: 9, max: 9, ratio: 1 }))).toMatch(/^Out of terminals \(9\/9 in use\)/);
  });

  it('a managed launch that hits the limit reports it in plain words, not the raw tmux error', () => {
    const run = (args: string[]) => {
      if (args[0] === 'has-session') return '';
      if (args[0] === 'new-window') throw new Error(FORK_FAIL);
      return '';
    };
    const r = acquireManagedPane('/tmp', { run, resources: roomy, ptys: () => ({ used: 300, max: 511, ratio: 0.59 }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.detail).toMatch(/^Out of terminals \(300\/511 in use\)/);
  });

  it('a managed launch with none left is refused before tmux is asked', () => {
    const calls: string[] = [];
    const run = (args: string[]) => (calls.push(args[0]), '');
    const r = acquireManagedPane('/tmp', { run, resources: roomy, ptys: () => ({ used: 511, max: 511, ratio: 1 }) });
    expect(r.ok).toBe(false);
    expect(calls).not.toContain('new-window');
  });
});

describe('node-pty fd-leak patch', () => {
  const BUGGY = 'done:\n  posix_spawn_file_actions_destroy(&acts);\n  posix_spawnattr_destroy(&attrs);\n\n  for (; count > 0; count--) {\n    close(low_fds[count]);\n  }\n}\n';
  const tmpPkg = (src: string) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'npty-'));
    fs.mkdirSync(path.join(d, 'src', 'unix'), { recursive: true });
    fs.writeFileSync(path.join(d, 'src', 'unix', 'pty.cc'), src);
    return d;
  };

  it('closes every low fd, including low_fds[0], and is idempotent', () => {
    const d = tmpPkg(BUGGY);
    expect(patch(d)).toMatch(/: patched$/);
    const out = fs.readFileSync(path.join(d, 'src', 'unix', 'pty.cc'), 'utf8');
    expect(out).toContain('for (size_t i = 0; i <= count && i < 3; i++) {\n    close(low_fds[i]);');
    expect(out).not.toContain('count--');
    expect(patch(d)).toMatch(/already patched$/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  // The shipped app compiles node-pty from app/node_modules (electron-builder npmRebuild):
  // it must be the patched source, or every Loom terminal view leaks a pty again.
  it('the installed node-pty sources are patched', () => {
    for (const dir of ['node_modules/node-pty', 'app/node_modules/node-pty']) {
      const file = path.join(dir, 'src', 'unix', 'pty.cc');
      if (!fs.existsSync(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      expect(src, file).toContain('close(low_fds[i]);');
      expect(src, file).not.toMatch(/for \(; count > 0; count--\)/);
    }
  });
});
