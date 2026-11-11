import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveLoomRepoDir } from './repodir.ts';

// Where Loom's native helpers live, and the one way Loom runs AppleScript.
//
// Each helper is the main executable of a tiny "Loom" app bundle (app/build.mjs):
//
//   ax        Contents/Helpers/ax/Loom.app/Contents/MacOS/loom-ax
//             the Slack reader, and the osascript runner for terminal scripting
//   keychain  Contents/Helpers/keychain/Loom.app/Contents/MacOS/loom-keychain
//
// From source (tsx, tests, the standalone server) the same bundles are in
// app/build-native/<kind>/Loom.app.

export type HelperKind = 'ax' | 'keychain';
const EXE: Record<HelperKind, string> = { ax: 'loom-ax', keychain: 'loom-keychain' };

/** The executable inside a helper bundle at `root` (a Contents/Helpers or build-native dir). */
export const helperExe = (root: string, kind: HelperKind): string => path.join(root, kind, 'Loom.app', 'Contents', 'MacOS', EXE[kind]);

/** The packaged app's copy, or null outside the packaged app. process.resourcesPath is Contents/Resources. */
export function packagedHelper(kind: HelperKind, resourcesPath = (process as { resourcesPath?: string }).resourcesPath): string | null {
  if (!resourcesPath) return null;
  const p = helperExe(path.join(resourcesPath, '..', 'Helpers'), kind);
  return isExecutable(p) ? p : null;
}

/** Packaged first, then a source checkout's app/build-native. */
export function findHelper(kind: HelperKind): string | null {
  const candidates: string[] = [];
  const res = (process as { resourcesPath?: string }).resourcesPath;
  if (res) candidates.push(helperExe(path.join(res, '..', 'Helpers'), kind));
  const repo = resolveLoomRepoDir();
  if (repo) candidates.push(helperExe(path.join(repo, 'app', 'build-native'), kind));
  candidates.push(helperExe(path.join(process.cwd(), 'app', 'build-native'), kind));
  candidates.push(helperExe(path.join(process.cwd(), 'build-native'), kind));
  return candidates.find(isExecutable) ?? null;
}

function isExecutable(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The command that runs `osascript -e script args…`. Inside the packaged app it
 * goes through the ax helper, so Ghostty / iTerm2 / Terminal.app scripting is
 * charged to the helper's "Loom" Accessibility and Automation rows, which
 * survive Loom updates, rather than to Loom.app, whose code hash changes with
 * every build. Anywhere else (the CLI, a terminal), plain osascript, which the
 * terminal's own grants cover.
 */
export function osascriptCommand(script: string, args: string[] = [], helper: string | null = packagedHelper('ax')): { cmd: string; args: string[] } {
  const osa = ['-e', script, ...args];
  return helper ? { cmd: helper, args: ['osascript', ...osa] } : { cmd: 'osascript', args: osa };
}

/** Run AppleScript synchronously (see osascriptCommand); returns stdout, throws on a non-zero exit. */
export function runOsascript(script: string, args: string[] = []): string {
  const c = osascriptCommand(script, args);
  return execFileSync(c.cmd, c.args, { encoding: 'utf-8' });
}
