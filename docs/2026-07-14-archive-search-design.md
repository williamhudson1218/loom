# Archive Search — Design

**Date:** 2026-07-14
**Status:** Implemented 2026-07-14 (see *Implementation notes* for deltas)
**Location:** `~/dev/loom/` (relocated from `~/.claude/tools/chat-manager/` — see Step 0)

## Problem

Loom indexes a **7-day window** (`ACTIVE_WINDOW_DAYS = 7`); older chats are pruned
from `manager.db` by design — deep archive search was explicitly delegated to the
sibling `find-chat` tool. That leaves two half-tools:

1. **Loom** has the good *actions* — resume into an idle tmux pane, branch, jump,
   a transcript panel — but can only see the last 7 days. Anything older is
   invisible and unreachable from the UI.
2. **find-chat** has the good *search* — FTS5 over every transcript on disk, with
   bm25 ranking — but its only outcome is printing a `claude --resume <id>`
   command for the user to copy-paste by hand. It has no idea about panes.

The dashboard's existing `#q` box looks like it might bridge this, but it does
not: it is a **client-side substring filter over the already-loaded 7-day
`DATA.chats`** (matching `title + overview + first_message`). It never touches
the archive.

So: to resume a chat older than 7 days, Will has to leave Loom, run `/find-chat`
in a terminal, copy a session id, find a free pane, and type the resume command —
re-doing by hand the exact thing Loom's resume button already does.

## Goals

- Search **all** chat history from inside Loom, using find-chat as the engine.
- Give archive results the **same resume UX** as board cards: resume and branch
  into a chosen idle pane, plus the transcript panel.
- Change nothing about how the existing 7-day board behaves.

## Non-goals

- **AI summaries for archive chats.** Board cards get `title/overview/state/
  key_moments` from a headless `claude -p` pass. Doing that for archive hits
  would cost one `claude -p` per result per search. find-chat's match snippet
  already says what the chat is. Archive cards stay lean.
- **Replacing or absorbing find-chat.** It stays its own tool/repo with its own
  index (`~/.claude/tools/find-chat/index.db`). Loom is a client of its CLI.
- **Widening `ACTIVE_WINDOW_DAYS`.** The 7-day board and the archive stay
  distinct surfaces; the window is what keeps the summarizer's cost bounded.
- **Moving find-chat.** It stays at `~/.claude/tools/find-chat/` for now.

---

## Step 0 — Relocate Loom to `~/dev/loom`

Loom outgrew `~/.claude/tools/`: it is a full Electron app with its own GitHub
repo (`williamhudson1218/loom`), and belongs beside the other repos in `~/dev`.
This is a prerequisite step, committed separately from the feature.

`paths.ts` already decouples repo from data — `resolveLoomHome()` resolves
`$LOOM_HOME` → `~/.claude/tools/chat-manager` (if it exists) → `~/.loom`. So the
code is already relocatable; what's pinned is the data and two hook paths.

1. Move the repo to `~/dev/loom`.
2. Move the gitignored runtime data — `manager.db`, `dashboard.html`,
   `layout.json`, `placements.jsonl`, `*.log` — **out of the repo** into
   `~/.loom`. With the legacy dir gone, `resolveLoomHome()` lands on `~/.loom`
   with zero env configuration. This is the decoupling the code already wants.
3. Repoint the two placement-hook entries in `~/.claude/settings.json`
   (`SessionStart`, `UserPromptSubmit`) to `~/dev/loom/hooks/record-placement.sh`.
4. Update `hooks/record-placement.sh`, which resolves its own copy of LOOM_HOME
   and has an `elif [ -d "$HOME/.claude/tools/chat-manager" ]` branch that will
   no longer match — it must fall through to `~/.loom`.
5. Update the `LEGACY_TOOL_DIR` comment in `paths.ts` (the fallback itself stays,
   for other machines / older installs).
6. Rebuild and reinstall the app (`cd app && yarn build && yarn dist`) so it
   bundles from the new location. The installed `/Applications/Loom.app` is a
   self-contained bundle and keeps running until then — no outage.
7. Fix the now-stale pointer in `~/dev/toolbox/README.md`
   (`~/.claude/tools/chat-manager → williamhudson1218/loom`).

**No launchd work.** The three plists in the repo are retired (`launchctl list`
shows no `com.loom.*` / `com.chatmanager` job; `~/Library/LaunchAgents` has
none). The app is the daemon.

**Verification:** after the move, the app starts, the board still lists chats
(proving it found `~/.loom/manager.db`), and sending a prompt in any chat still
lights it up live (proving the repointed hook still writes `placements.jsonl`).

---

## Architecture

```
dashboard (#q box)
  └─ ⤷ "Search all history for …"  ── GET /api/search?q= ──┐
                                                            │
server.ts ──────────────────────────────────────────────────┤
  └─ findchat.ts (adapter)                                  │
       └─ execFile ~/.claude/tools/find-chat/bin/find-chat  │
            --exclude <board sid>… "<query>"                │
              └─ (find-chat's own tsx + index.db)  ─── JSON ┘
```

### Talking to find-chat

Shell out to the **`bin/find-chat` wrapper**, not `tsx src/search.ts`. The
wrapper resolves its own real directory (through symlinks) and exec's find-chat's
*local* `node_modules/.bin/tsx`. So Loom needs no global `tsx`, no assumption
about find-chat's internals, and no shared node_modules.

Invoke with `execFile` (never a shell) so the query can't inject.

**Binary resolution:** `$FIND_CHAT_BIN` → default
`~/.claude/tools/find-chat/bin/find-chat`. Mirrors the `LOOM_HOME` philosophy so
find-chat can relocate later without a code change.

**Contract** (verified against the current source, which has drifted from
find-chat's own plan doc — `TOP_N` is 30, and `jsonl_path` is now returned):

```
find-chat [--exclude <session_id>]... "<query>"

stdout: { query, count, excluded, results: SearchResult[] }
stderr: index-progress noise — ignore
exit 2: empty query

SearchResult = {
  session_id, project_dir, jsonl_path,
  started_at, ended_at, message_count,
  title, snippet, score
}
```

Parse **stdout only**. `jsonl_path` being present means the transcript panel
needs no path computation.

**Dedupe via find-chat's own `--exclude`.** Pass every `session_id` currently on
the board, so the archive section only ever shows chats not already visible
above. This is find-chat's designed affordance, not a Loom invention.

Two behaviors that follow from the current implementation and are accepted as-is:

- **Excludes apply after `LIMIT`.** `runSearch` LIMITs to `TOP_N` and *then*
  filters the exclude set, so exclusion thins results rather than backfilling to
  30. A query about a recent topic may return a sparse archive section — which is
  correct, since those chats are on the board already.
- **`process.cwd()` effects are benign.** find-chat uses cwd for its
  current-project bm25 boost and for `detectCurrentSessionId` auto-exclusion.
  Spawned from Loom's server (cwd `~/.loom`, not a project dir), both are no-ops:
  no boost applied, nothing accidentally excluded.

### `src/findchat.ts` (new)

The adapter. Mirrors the **injectable-runner convention already established in
`analyzer.ts`** (`export type ClaudeRunner = (prompt) => Promise<string>` +
`defaultRunner` + injected as a parameter), which is what makes it unit-testable
without spawning a process:

```ts
export type FindChatRunner = (args: string[]) => Promise<string>; // -> raw stdout
export const defaultRunner: FindChatRunner = …;                   // execFile the bin
export interface ArchiveHit { session_id, project_dir, jsonl_path,
  started_at, ended_at, message_count, title, snippet, score }
export async function searchArchive(
  query: string, exclude: string[], runner: FindChatRunner = defaultRunner,
): Promise<{ ok: true; results: ArchiveHit[] } | { ok: false; detail: string }>;
```

Responsibilities: build argv (`--exclude` per id, then the query), run, parse
stdout JSON, validate shape, map errors to `{ok:false, detail}`. `defaultRunner`
sets a **60s timeout** and a generous `maxBuffer`. 60s (not 15s) because a
missing `index.db` makes the first search backfill the whole archive; on this
machine the index exists, so refreshes are incremental and fast.

---

## Endpoints (`src/server.ts`)

### New: `GET /api/search?q=<query>`

1. `snapshot()` → collect board `session_id`s as the exclude list.
2. `searchArchive(q, excludes)`.
3. → `{ ok: true, results: ArchiveHit[] }` or `{ ok: false, detail }`.

Empty/missing `q` → `{ok:true, results:[]}` (not an error; the UI simply hasn't
searched yet).

### Generalized: `/resume`, `/branch`, `/api/transcript`

All three currently resolve a session via `views.find(x => x.session_id === sid)`
and **404 on anything not in the 7-day DB** — i.e. on every archive chat. Each
gains an optional fallback parameter, resolved **DB-view-first** so existing
board cards are byte-for-byte unaffected:

| Endpoint | Added param | Fallback behavior |
|---|---|---|
| `/resume?session=&pane=` | `&proj=` | `resumeInPane(pane, proj, sid)` |
| `/branch?session=&pane=` | `&proj=` | `branchInPane(pane, proj, sid)` |
| `/api/transcript?session=` | `&jsonl=` | `readTranscript(jsonl)`; respond `live:false` |

**Validation.** `proj` becomes free-form input to `cd <proj> && claude --resume`.
It is already `shq`-quoted in `goto.ts` (so not an injection), but the server is
reachable by any local process, so both params get a cheap guard:

- `proj` — must be an absolute path to an existing directory.
- `jsonl` — must resolve inside `~/.claude/projects` and end in `.jsonl`.

Failing either → 400. One line each; closes a new capability that didn't exist
when every resolvable session had to already be in Loom's own DB.

`/goto` and `/close` are **not** generalized: both act on a *live pane*, and an
archive chat by definition has none.

---

## UI (`src/dashboard.ts`)

`#q` keeps working exactly as today (live client-side board filter). Beneath it,
a `#deep` affordance appears **only when `#q` is non-empty**:

```
[ dropdown bug________ ]  ‹filter box — board narrows live›
 ⤷ Search all history for "dropdown bug"      ← explicit click
```

Click — never keystroke — so we never spawn a subprocess per character.

Results render in a new `#archive` section below `#list`:

```
── From your archive ──────────────────────
  "dropdown a11y refactor"          ‹archive card›
  tax-pilot · 42 msgs · Apr 12
  …fixing the [dropdown] size regression…
  [⏵ resume…] [⑃ branch…]
```

**Archive card** — deliberately leaner than a board card: no state pill and no
overview (no AI summary exists), muted/dashed left border to read as a different
class of thing. Shows title (falling back to snippet head), project tag (reusing
`pcolor`), `rel(ended_at)`, message count, and the match snippet. find-chat wraps
matches in `[...]`; the snippet goes through the existing `esc()` like all other
untrusted text.

**Actions.** `⏵ resume…` / `⑃ branch…` reuse the existing `openPicker` →
`/api/idle-panes` → `doLaunch` flow; both are extended to carry `proj` for
archive cards. Card click opens the transcript panel via `openChat`, carrying
`jsonl`. The panel's stale foot ("This chat isn't running — **Resume** it from
its card to send messages") is already the correct message for an archive chat,
so `renderFoot` needs no change.

**Client state:** `archiveHits` / `archiveQuery`. The 5s `refresh()` poll must
not wipe the archive section — it needs a guard alongside the existing
open-picker / open-card guard.

### Two known traps

- **No regex literals in the dashboard's client JS.** It lives inside a backtick
  template literal in `renderDashboard`, where backslashes collapse
  (`/\/pull\/(\d+)/` → `//pull/(d+)/`, which comments out the line and blanks the
  entire page). This has been burned three times. Use string methods only.
  `tsc` and vitest cannot catch it — the JS is a string.
- **`scripts/check-dashboard.sh` must pass** after any `dashboard.ts` edit; it
  node-syntax-checks the *served* inline JS, which is the only thing that does.

---

## Data flow (resume an archive chat)

1. Type `dropdown bug` in `#q` → board filters client-side (unchanged).
2. `⤷ Search all history for "dropdown bug"` appears → click.
3. `GET /api/search?q=dropdown+bug` → server snapshots the board for excludes →
   `execFile` find-chat → parse stdout → `{ok:true, results}`.
4. Client renders the `From your archive` section.
5. Click `⏵ resume…` → `/api/idle-panes` → user picks a pane.
6. `GET /resume?session=<sid>&pane=<pane>&proj=<project_dir>` →
   `resumeInPane` → `tmux send-keys`
   `cd <proj> && claude --resume <sid> --dangerously-skip-permissions` → focus.

Identical to the board's resume path from step 5 onward — that's the point.

## Error handling

| Case | Behavior |
|---|---|
| find-chat binary missing | `{ok:false, detail:'find-chat not installed'}` → muted note in the archive section |
| non-zero exit / unparseable stdout | `{ok:false, detail}` → muted note |
| 60s timeout | `{ok:false, detail:'search timed out'}` |
| zero results | `From your archive` section shows "no archive matches" |
| server unreachable | reuse the existing `server off?` treatment |

A search in flight shows a `searching…` state — it is a subprocess, not a local
filter, and the first run against a cold index can genuinely take a while.

## Testing

- **`tests/findchat.test.ts` (new)** — the adapter, driven by a stub
  `FindChatRunner` (no spawning), mirroring `tests/analyzer-run.test.ts`:
  argv construction (one `--exclude` per id, query last), parsing a realistic
  stdout fixture, unparseable stdout → `{ok:false}`, runner throw (missing
  binary) → `{ok:false}`, empty query → `{ok:true, results:[]}`.
- **`tests/dashboard.test.ts` (extend)** — archive section renders hits; escapes
  snippet/title; renders nothing when there are no hits.
- **`scripts/check-dashboard.sh`** — must pass.
- **Endpoints:** there is no `server.test.ts` today (the HTTP layer is currently
  untested), so this change does not introduce one. The logic worth testing —
  argv building, parsing, failure mapping — lives in `findchat.ts` and is covered
  above; the endpoints stay thin. The `proj`/`jsonl` validators are pure
  functions and get unit tests alongside the adapter.
- **Manual:** search a >7-day-old topic, confirm it appears only in the archive
  section, open its transcript, resume it into an idle pane, confirm the pane
  runs the right session and the card goes live on the next poll.

## Files

| File | Change |
|---|---|
| `src/findchat.ts` | **new** — runner type, `defaultRunner`, `searchArchive`, path validators |
| `src/paths.ts` | `FIND_CHAT_BIN` resolution; `LEGACY_TOOL_DIR` comment (Step 0) |
| `src/server.ts` | `/api/search`; `proj`/`jsonl` fallback + validation on `/resume`, `/branch`, `/api/transcript` |
| `src/dashboard.ts` | `#deep` affordance, `#archive` section, archive card, picker/panel `proj`+`jsonl` plumbing, refresh guard |
| `tests/findchat.test.ts` | **new** |
| `tests/dashboard.test.ts` | extend |
| `hooks/record-placement.sh` | Step 0 — LOOM_HOME fallback |
| `README.md` | document archive search + `FIND_CHAT_BIN` |
| `~/.claude/settings.json` | Step 0 — 2 hook paths (outside the repo) |
| `~/dev/toolbox/README.md` | Step 0 — stale pointer (outside the repo) |

## Risks

- **find-chat's output contract is unversioned.** Loom now depends on its stdout
  shape. Mitigated by validating shape in the adapter and degrading to a muted
  note rather than throwing. The two repos are both Will's and move together.
- **A stale find-chat index** shows stale hits. find-chat's `refresh()` runs on
  every invocation (mtime-gated), so this self-corrects per search.
- **Step 0 and the feature are independent**; Step 0 ships and gets verified
  first, so a relocation problem can never be confused for a feature bug.

---

## Implementation notes

What the design got wrong or didn't know, recorded 2026-07-14.

### Deleted transcripts — the big one

find-chat's `refresh()` is mtime-gated over the files it *finds*, so it never
prunes rows whose transcript has since been deleted. **455 of 867 rows (52%) of
its index point at files that no longer exist**, and 16 of 27 hits for a real
query were such ghosts — unreadable and unresumable. `searchArchive` now drops
any hit whose `jsonl_path` is missing (at most `TOP_N` stats). This was not
foreseen in the design.

The root fix belongs in find-chat (prune rows for vanished files on refresh),
which would also stop `/find-chat` surfacing ghosts and let its `LIMIT` return 30
*live* hits instead of ~11 after filtering. Left open deliberately — it's a
different repo.

### find-chat was entirely broken

Its `better-sqlite3` was built under nvm node 24 (ABI 137) but every Node that
runs it is ABI 127 (`~/.local/bin/node` v22) or 141 (Homebrew v25), so it threw
`NODE_MODULE_VERSION` on every call — `/find-chat` included. Fixed by
`npm rebuild better-sqlite3` under node 22. find-chat has **no `.nvmrc`**, so this
will recur if the default Node changes; documented in the README.

### A pre-existing dashboard bug in the resume path

`doLaunch`/`doClose` called `setTimeout(poll, …)`, but `poll` **is not defined**
(`refresh` is). `setTimeout` evaluates its argument eagerly, so it threw inside
`.then()`, and the adjacent `.catch()` converted it into a bogus **"server off?"**
on every *successful* resume/branch/close. Fixed to `refresh` — archive resume
would otherwise have inherited the same false error.

### Corrections to this design

- **No refresh() guard was needed.** The design worried the 5s poll would wipe the
  archive section; `render()` only rewrites `#list`, and `#archive` is a separate
  container, so it survives untouched.
- **The dashboard archive-render test isn't feasible.** Archive cards are built in
  the browser from `/api/search`; `renderDashboard` only emits a static shell. The
  test asserts the shell ships the scaffolding; behaviour is covered by
  `check-dashboard.sh` and end-to-end use.
- **No "no backslashes" test.** Attempted, and it was wrong: `isn\'t` is a
  legitimate escape. The real rule is *no single backslash* (a collapsed regex
  yields `//` and comments out the line), which `node --check` already catches.
- **Two UI warts only visible against real data:** most chats have no custom
  title, so find-chat's `title` is `''` and the heading falls back to the snippet —
  which was then printed twice; the snippet line is now suppressed unless a real
  title exists. And some rows carry an empty `project_dir`, so resume/branch are
  hidden when there's no cwd to `cd` into.

### Step 0 surprises

- **The installed app was stale.** `/Applications/Loom.app` was built 2026-07-09
  with `TOOL_DIR` **hardcoded** to the legacy path — it predated
  `resolveLoomHome()` entirely (`yarn build` had run since; `yarn dist` had not).
  Relaunching it after the move silently recreated the legacy dir and re-indexed a
  throwaway DB there. **Rebuild and reinstall before relaunching after any move.**
- **The `loom-` prefix gate was latent.** `SESSION_PREFIX = 'loom-'` (commit
  398c965, 2026-07-13) never reached the app, so the Jul-9 bundle had been
  snapshotting every session. Rebuilding activated the gate and, since no tmux
  session matched `loom-`, `writeLayout` returned `null` every 15s — crash
  recovery silently dead. Resolved by renaming all 9 sessions to `loom-*`.
- **Renaming broke Ghostty tab matching**, since tabs were titled by the command
  (`ta tp-2`) and tmux never set a title. Fixed in `.tmux.conf` with
  `set -g set-titles on` + `set-titles-string '#S'`, so titles now track renames
  automatically and `gotoPane`'s *ends with* match keeps working.
