import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where Loom's own source checkout is, if this machine has one.
//
// A local build (app/build.mjs) stamps the checkout it was built from into
// __LOOM_REPO_DIR__. A release build (LOOM_RELEASE=1, CI) stamps '' so no path
// from the build machine ships in the app, and the checkout is found at run time
// instead: $LOOM_REPO_DIR, then the usual places a clone lives under $HOME. A
// folder only counts when it really is a Loom checkout.

declare const __LOOM_REPO_DIR__: string | undefined;

/** Where people usually clone repos, relative to $HOME. */
export const REPO_CANDIDATES = ['dev/loom', 'code/loom', 'src/loom', 'Projects/loom', 'projects/loom', 'loom'];

export function isLoomCheckout(dir: string, exists: (p: string) => boolean = fs.existsSync): boolean {
  if (!dir) return false;
  return exists(path.join(dir, 'app', 'build.mjs')) && exists(path.join(dir, 'src', 'server.ts')) && exists(path.join(dir, 'plugin'));
}

export interface RepoDirOpts {
  env?: NodeJS.ProcessEnv;
  stamped?: string;
  home?: string;
  exists?: (p: string) => boolean;
}

/** The checkout, or '' when there is none. Pure apart from `exists`. */
export function resolveLoomRepoDir(opts: RepoDirOpts = {}): string {
  const env = opts.env ?? process.env;
  const fromEnv = env.LOOM_REPO_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  const stamped = opts.stamped ?? (typeof __LOOM_REPO_DIR__ === 'string' ? __LOOM_REPO_DIR__ : '');
  if (stamped) return stamped;
  const exists = opts.exists ?? fs.existsSync;
  let home = opts.home;
  if (home === undefined) {
    try {
      home = os.homedir();
    } catch {
      home = '';
    }
  }
  if (!home) return '';
  for (const rel of REPO_CANDIDATES) {
    const dir = path.join(home, rel);
    if (isLoomCheckout(dir, exists)) return dir;
  }
  return '';
}
