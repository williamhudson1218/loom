# Loom — Setup

Get Loom building and running on a fresh Mac. For what Loom *is*, see [README.md](./README.md).

> **TL;DR** — clone anywhere, then `./setup.sh --install`, register the hook, grant two macOS permissions, launch. Details below.

---

## 1. Requirements

### Runtime / system

| Requirement | Why | Notes |
|---|---|---|
| **macOS** (Apple Silicon or Intel) | Loom shells out to `osascript` / System Events / Ghostty and uses Electron | macOS-only. Apple Silicon is the primary target; Intel works (see build note). |
| **Node 20+** | CLI + app; native `better-sqlite3` needs a modern ABI | Pinned in [`.nvmrc`](./.nvmrc) and each `package.json` `engines`. `nvm use` picks it up. |
| **Yarn** (classic, v1) | Package manager for both workspaces | `npm i -g yarn` or `corepack enable`. |
| **tmux** | Loom's control substrate — live detection, jump, resume, branch, restore all address tmux panes | Without it Loom still indexes/summarizes, but pane actions no-op. |
| **Claude Code CLI (`claude`), logged in** | Resume/branch launch `claude`; the summarizer runs headless `claude -p` | Auth comes from your Claude Code keychain login — Loom has no token of its own. |
| **python3** | The placement hook parses hook JSON with it | Ships with the macOS Command Line Tools. |
| **Free TCP port 4317** | The app binds `127.0.0.1:4317` for the dashboard/API | Single-instance; not configurable without a code change. |
| **Ghostty** (optional) | Click-to-focus jumps to a session's Ghostty tab | Any terminal works for everything except tab focus. |

### Build tools

Installed automatically by `yarn install` in each workspace — listed here for reference:

- **esbuild** — bundles `app/main.ts` + `../src/*` into `app/dist/main.js`
- **electron** + **electron-builder** — package the `.app`
- **@electron/rebuild** — rebuilds `better-sqlite3` against Electron's ABI
- **tsx** / **typescript** / **vitest** — run and test the TypeScript backend

### External services / tokens

None beyond your existing Claude Code login. Loom talks only to your local filesystem (`~/.claude/projects/`), local tmux, and the local `claude` CLI. Nothing is uploaded.

---

## 2. Build & install

Clone the repo **wherever you like** — Loom no longer requires a fixed path.

```bash
git clone git@github.com:williamhudson1218/loom.git
cd loom
./setup.sh            # checks prereqs, installs deps, runs tests, builds Loom.app
./setup.sh --install  # ...and also copies Loom.app into /Applications
```

`setup.sh` is idempotent and self-locating (run it from any clone path). If you prefer the manual steps it wraps:

```bash
# backend (CLI) — Node-ABI native module
yarn install
yarn test

# desktop app — Electron-ABI native module
cd app
yarn install
yarn build      # esbuild bundle -> dist/main.js
yarn rebuild    # rebuild better-sqlite3 for Electron's ABI  (REQUIRED)
yarn dist       # -> app/release/mac-arm64/Loom.app  (unsigned)
```

Copy `Loom.app` to `/Applications` and launch it. It embeds the HTTP server, runs the summarizer + layout snapshots on intervals, lives in the menu bar, and registers itself to launch at login.

**CLI-only / dev usage** (no app):

```bash
./bin/chat-manager run             # one index + summarize pass, writes the dashboard
./bin/chat-manager restore --dry-run
```

### Register the placement hook

Loom knows which tmux pane a chat lives in via a `SessionStart` / `UserPromptSubmit` hook. Add this to `~/.claude/settings.json` under **both** events (use the absolute path to *your* clone):

```json
{ "type": "command", "command": "/path/to/loom/hooks/record-placement.sh", "timeout": 5 }
```

The hook is a no-op outside tmux, so it's harmless in non-tmux sessions.

---

## 3. First-run macOS permissions

On first launch, macOS will prompt (or you can pre-grant in **System Settings › Privacy & Security**):

- **Accessibility** — lets Loom drive System Events to click the right Ghostty tab when you "jump" to a live session. Without it, tmux still selects the pane; only the Ghostty window-focus fails (Loom reports this in the action result).
- **Automation** — lets Loom send AppleScript to **Ghostty** and **System Events**.

Grant to **Loom.app** (and, the first time, to the terminal you launched it from if you ran it via `electron .`).

Because the app is **unsigned** (personal use), Gatekeeper may object if the app was moved/downloaded rather than built locally:

```bash
xattr -dr com.apple.quarantine /Applications/Loom.app   # or right-click → Open once
```

A locally built app has no quarantine flag and opens directly.

---

## 4. Where Loom stores data

Loom writes its cache/runtime files (`manager.db`, `dashboard.html`, `layout.json`, `placements.jsonl`) to a **per-user data dir**, resolved identically by the app, the CLI, and the placement hook:

1. `$LOOM_HOME` if set
2. `~/.claude/tools/chat-manager` if it already exists (legacy installs — kept for back-compat)
3. `~/.loom` otherwise (default)

Nothing is written into the repo, so the clone location doesn't matter. All of these files are derived caches — deleting them just triggers a re-index. They're private (they embed your indexed chat content) and are git-ignored.

> **Overriding for the app:** the Finder-launched app does **not** inherit your shell's environment, so `export LOOM_HOME=…` in `.zshrc` won't reach it. To point the app at a custom dir, launch it from a shell that has `LOOM_HOME` set, or leave it on the default.

---

## 5. Gotchas

- **Two `node_modules`, two ABIs.** The root install compiles `better-sqlite3` for your system Node; `app/` compiles it for Electron. After `cd app && yarn install` you **must** `yarn rebuild` — skipping it gives a `NODE_MODULE_VERSION` mismatch at app launch. Don't copy `node_modules` between the two.
- **Intel build output path.** `yarn dist` emits to `app/release/mac-arm64/` on Apple Silicon and `app/release/mac/` on Intel. `setup.sh` handles both; adjust manual copies accordingly.
- **Port 4317 must be free.** A second instance exits immediately (single-instance lock); if the port is taken by something else the window won't load.
- **The app replaces the old launchd jobs.** If you previously ran the `com.loom.*` / `com.chatmanager.*` plists, unload them — the app now owns the summarizer + snapshot intervals. (The plists are git-ignored and retired.)
- **Ghostty tab titles.** Click-to-focus matches tabs titled `ta <session>` / `tn <session>` (the maintainer's tmux attach aliases). Different tmux workflows still get tmux-level pane selection; only the Ghostty focus step depends on this.
- **Don't run `asar extract-file` from a repo cwd.** It writes the extracted file into the current directory — run it from `/tmp` (or `grep -a` the archive directly) to avoid leaking a `main.js` bundle into your working tree.
