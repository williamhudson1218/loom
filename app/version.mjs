// The version a build is stamped with (app/build.mjs, app/dist.mjs, CI).
//
// 0.1.<n>, where n is the number of commits on the branch: it only goes up on
// main, needs no state outside git, and a local build of the same commit gets the
// same number as CI's. CI passes LOOM_VERSION / LOOM_COMMIT explicitly so the
// release, its tag and its latest.json can never disagree.
//
// channel: 'release' for a CI build (LOOM_RELEASE=1), 'local' for anything built
// on a laptop. Both self-update from GitHub Releases; the channel is shown in
// Settings › Updates so a hand-built app is recognisable.
import { execFileSync } from 'node:child_process';

export const VERSION_BASE = '0.1';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** Pure: the version string for a commit count. */
export function versionFor(count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0) throw new Error(`bad commit count: ${count}`);
  return `${VERSION_BASE}.${n}`;
}

/** { version, commit, channel } for the checkout at `cwd`, honouring LOOM_VERSION / LOOM_COMMIT / LOOM_RELEASE. */
export function buildInfo(cwd, env = process.env) {
  const channel = env.LOOM_RELEASE === '1' ? 'release' : 'local';
  let version = (env.LOOM_VERSION || '').trim();
  let commit = (env.LOOM_COMMIT || '').trim();
  try {
    if (!version) version = versionFor(git(cwd, ['rev-list', '--count', 'HEAD']));
    if (!commit) {
      commit = git(cwd, ['rev-parse', 'HEAD']);
      if (channel === 'local' && git(cwd, ['status', '--porcelain', '--untracked-files=no'])) commit += '-dirty';
    }
  } catch {
    version ||= `${VERSION_BASE}.0`;
    commit ||= 'unknown';
  }
  return { version, commit, channel };
}
