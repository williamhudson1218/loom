// Which GitHub PR a transcript is about.
//
// The parsers used to take the LAST `/pull/` URL anywhere in a transcript. A chat
// that so much as quotes an example (`https://github.com/org/repo/pull/123`, from
// docs, a skill or a prompt) then "owned" that PR: the board showed it, and the
// pipeline tick asked gh about a repo that does not exist, every few minutes,
// forever. So a URL is only taken when it is about the chat's own repo:
//
//   - The chat's folder is a git checkout with GitHub remotes: only a PR in one of
//     those repos counts (any remote, so a fork's `upstream` PRs count too). A PR
//     the chat opened in a different repo is not picked up here; the detail panel's
//     branch lookup still finds a PR for the chat's own branch.
//   - The folder's remotes are unknown (not a checkout, no GitHub remote): the last
//     URL that is not an obvious placeholder.

import fs from 'node:fs';
import path from 'node:path';

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;

/** Every GitHub PR URL in a line, in order. */
export function prUrlsIn(line: string): string[] {
  return line.includes('/pull/') ? line.match(PR_URL) ?? [] : [];
}

const repoOfPrUrl = (url: string): string => (url.match(/github\.com\/([\w.-]+\/[\w.-]+)\/pull\//)?.[1] ?? '').toLowerCase();

/** `owner/repo` (lowercase) from a GitHub remote URL in any of git's forms, or null. */
export function githubRepoOf(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]+([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}

const PLACEHOLDER_OWNERS = new Set(['org', 'owner', 'user', 'username', 'your-org', 'yourorg', 'my-org', 'myorg', 'your-username', 'example', 'acme', 'foo', 'octocat', 'someone', 'you']);
const PLACEHOLDER_REPOS = new Set(['repo', 'your-repo', 'yourrepo', 'my-repo', 'myrepo', 'repository', 'example', 'project', 'foo', 'bar']);

/** An example URL's repo (`org/repo`, `owner/repo`, `octocat/hello-world`...). */
export function isPlaceholderRepo(repo: string): boolean {
  const [owner = '', name = ''] = repo.toLowerCase().split('/');
  return PLACEHOLDER_OWNERS.has(owner) || PLACEHOLDER_REPOS.has(name);
}

/** The git config of the checkout holding `dir` (a worktree's resolves to its main repo's), or null. */
function gitConfigPath(dir: string): string | null {
  let d = path.resolve(dir);
  for (;;) {
    const dotGit = path.join(d, '.git');
    let st: fs.Stats | null = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      /* not here */
    }
    if (st?.isDirectory()) return path.join(dotGit, 'config');
    if (st?.isFile()) {
      // A worktree: `.git` names its gitdir, whose `commondir` leads to the shared config.
      try {
        const gitdir = fs.readFileSync(dotGit, 'utf-8').match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
        if (!gitdir) return null;
        const g = path.resolve(d, gitdir);
        let common = g;
        try {
          common = path.resolve(g, fs.readFileSync(path.join(g, 'commondir'), 'utf-8').trim());
        } catch {
          /* not a linked worktree: the gitdir is the repo */
        }
        return path.join(common, 'config');
      } catch {
        return null;
      }
    }
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** The GitHub repos (`owner/repo`, lowercase) among the remotes of the checkout holding `dir`; null when unknown. */
export function githubRemotesOf(dir: string): string[] | null {
  if (!dir) return null;
  const conf = gitConfigPath(dir);
  if (!conf) return null;
  let text: string;
  try {
    text = fs.readFileSync(conf, 'utf-8');
  } catch {
    return null;
  }
  const repos = new Set<string>();
  let inRemote = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inRemote = /^\[remote\s+"/.test(line);
      continue;
    }
    if (!inRemote) continue;
    const m = line.match(/^(?:push)?url\s*=\s*(.+)$/i);
    const repo = m ? githubRepoOf(m[1]) : null;
    if (repo) repos.add(repo);
  }
  return repos.size ? [...repos] : null;
}

/** The PR a chat is about: the last URL in its own repo (remotes known), else the last non-placeholder one. '' when none. */
export function pickPrUrl(urls: string[], remotes: string[] | null): string {
  for (let i = urls.length - 1; i >= 0; i--) {
    const repo = repoOfPrUrl(urls[i]);
    if (!repo) continue;
    if (remotes ? remotes.includes(repo) : !isPlaceholderRepo(repo)) return urls[i];
  }
  return '';
}
