---
name: ship
description: Use when the user runs /loom:ship, or says "ship it" / "ship these", to release the current batch of staged work through a branch and pull request. Commits the staged files, pushes a ship/ branch, opens a PR with gh, waits for checks, and merges only when branch protection allows it. Never force-pushes, never skips hooks.
---

# Ship

Running this skill is the user's explicit go-ahead to commit and push **the batch**, once.
It does not carry over to the next commit. It never force-pushes, never passes `--no-verify`,
and never has a `--force` mode: if something is red, fix it or stop and say what is stuck.

## The batch

The batch is **what is staged** (`git diff --cached --name-only`). Staged files are the signal that
work is finished; unstaged and untracked files belong to someone else (another chat sharing this
tree, or the user mid-edit) and are left alone.

- Nothing staged: say so and stop. Do not stage on your own to have something to ship.
- Several unrelated changes staged together are one batch and one commit. Do not split them or ask
  whether they belong together.
- Stage by path only. Never `git add -A` or `git add .`.

## The ship lock

Several chats often share one working tree. While you stage, commit and push, hold the lock so a
parallel chat's `git add` cannot sweep half-finished work into your commit. The lock is a file
(`ship.lock`) in the git common dir of the repo you ship, so every worktree of that repo sees it and a
ship in one repo never blocks another. Always name the repo you are shipping:

```bash
REPO="$(git rev-parse --show-toplevel)"
loom ship-lock acquire "$REPO"   # before touching the index; re-run right before the commit to re-stamp it
loom ship-lock release "$REPO"   # after the branch is pushed, and on ANY failure or abort
loom ship-lock status "$REPO"
```

- The lock is a per-repo setting in Loom (Settings › Ship, "Ship lock", on by default). When it is off
  for this repo, `acquire` says so and takes nothing; carry on with the ship.

- Acquire fails with `held by another session (...)`: another chat is mid-ship. **Do not stage, commit
  or push, and do not release a lock you do not own.** Finish everything else you have, retry at the end,
  or hand the ship back to the user and tell them which session holds it.
- A lock older than five minutes is treated as abandoned and `acquire` takes it.
- The lock blocks only committing, pushing and `git add` on the default branch. Editing, tests, linting,
  reading code and every unrelated task carry on. A held lock is never a reason to end a turn.

## Procedure

1. **Look first.** `git status`, `git diff --cached --stat`, `git log -5 --oneline`. Confirm the
   current branch, the default branch (`git symbolic-ref refs/remotes/origin/HEAD`), and that `gh auth status` works.
2. **Acquire the lock.** If it fails, stop as above.
3. **Run the project's own checks** that are cheap and local (typecheck, lint, the tests for what changed).
   Red means fix, not skip. Heavy suites are the CI's job.
4. **Commit** the staged files with a message that says what changed and why, in the project's style
   (`git log` shows it). Let commit hooks run; if one fails, fix the cause and make a **new** commit.
   After the commit, re-check `HEAD`: a lint-staged partial commit can leave a different tree than you expected.
5. **Branch and push.**
   - On the default branch: `git switch -c ship/<short-slug>` first, then `git push -u origin ship/<short-slug>`.
     Move the default branch back to where it was only if the user asks; do not rewrite history.
   - On a feature branch: push that branch.
   - A plain push is the only push. If it is rejected, `git pull --rebase` and push again. Never `--force`
     or `--force-with-lease`.
6. **Release the lock** (`loom ship-lock release "$REPO"`). The commit is pushed; the index is free again.
7. **Open the PR** with `gh pr create` (draft if the project reviews every push automatically, ready otherwise).
   Body: what changed, why, how it was checked, and anything not verified. Add the one-line ship label
   (`loom ship-label "<what this is>"`) if it has not been recorded.
8. **Wait for checks** without ending the turn on a bare "still running": run
   `gh pr checks <n> --watch` in the background and report when it settles. `--watch` exits 0 even on some
   failures, so read the conclusions with `gh pr checks <n> --json name,state,bucket` and name what failed.
9. **Merge only if the repository allows it.** If branch protection and required reviews are satisfied,
   `gh pr merge <n> --squash` (use `--auto` when checks are still pending and auto-merge is enabled).
   If a review or approval from another person is required, stop and tell the user the PR link and what it is waiting on.
   Never use admin bypass, and never merge past a failing check.
10. **If checks go red,** read the failing job's log, fix the cause with a new commit, push, and watch again.
    Do not retry a red run hoping it passes; do not mark a flaky failure as someone else's without evidence.

## Report

End with the PR link, the checks result as a breakdown (each check and its conclusion), whether it merged,
and anything you could not verify. If the lock was held or a step was skipped, say so.

## Don't

- Don't commit or push anything that was not staged when the skill started.
- Don't pass `--no-verify`, `--force`, `--force-with-lease`, or `--no-gpg-sign` unless the user asked for that exact flag.
- Don't merge, close or rebase a PR you did not open in this ship.
- Don't delete branches other than your own `ship/` branch, and only after it merged.
