# Loom

Loom is a macOS app that shows all of your [Claude Code](https://claude.com/claude-code) chats in one place. It indexes every chat, summarizes it, tells you which ones are running and whose turn it is, and lets you open, resume, branch, park and message any of them.

macOS only. tmux is required. It keeps chats alive when Loom quits and is how Loom types into them. Loom installs it, runs it on its own socket and shows each chat as a terminal inside the app, so you never have to learn it.

## Get started

```bash
git clone <this repo's URL> loom
cd loom
./setup.sh --install
```

`setup.sh` checks Node 20+, yarn, tmux and the `claude` CLI, installs dependencies, runs the tests, builds `Loom.app` and copies it to `/Applications`. Run it again any time; it is safe to repeat. It installs tmux with Homebrew if tmux is missing. It does not edit `~/.claude/settings.json`.

Open Loom. A brand-new install starts the **setup wizard**. Every step after the requirements check is optional, and you can change any choice later in Settings (the gear). Full details, including permissions and troubleshooting, are in [SETUP.md](./SETUP.md).

The wizard steps:

1. **Requirements.** tmux, Claude Code (logged in) and python3 must be present.
2. **Projects.** The folders you work in.
3. **Terminal.** Where Jump and Resume open a chat. The default is inside Loom.
4. **Agent permissions.** Whether chats Loom starts ask before running commands. The default is normal permissions.
5. **Loom plugin.** Installs the hooks and skills that connect chats to Loom.
6. **Slack connection.** Direct app, MCP only, or off.
7. **Slack shortcut.** Shown when Slack is on.
8. **Ship.** The repos you ship from.
9. **Orchestrator.** A supervising chat. Off by default.
10. **Watchers.** Rules that react to events. Off by default.
11. **Done.** A summary of what is on and off, then a short tour.

You can reopen the tour or the wizard from Settings › Help (**Take the tour**, **Run setup again**).

## What each part is for

- **The board.** Every chat from the last few days (Settings › General › Days shown), grouped by state: working, your turn, done. Click a chat to read its transcript, its key moments and its edited files, or to type into the running session.
- **Terminal inside Loom.** A chat opens as its real Claude Code terminal in the main area. Quitting Loom detaches; chats keep running. You can use Ghostty, iTerm2 or Terminal.app instead (Settings › Terminal).
- **Resume, branch, close.** Resume an old chat, branch it into a new session that leaves the original alone, or close it to free its window.
- **Save for later.** Star a chat to pin it and keep it from aging out of the board.
- **Search all history.** Type in the filter box and press Enter to search every transcript on disk. This needs the optional find-chat tool (see SETUP.md).
- **Outbox.** Slack drafts that chats prepare for you. You review them and send, or send and park the chat until the thread replies.
- **Ship.** A per-project button that releases the staged work in a repo (see below).
- **Orchestrator.** One chat that sees all the others and reports what needs you. Optional.
- **Watchers.** Rules like "tell me when a chat is stuck" (see below). Optional.
- **Menu-bar icon.** Live counts of chats that are working and waiting on you.

## The plugin

Loom talks to Claude Code through a plugin. It adds four hooks (which tmux window a chat lives in, Slack thread ownership, Outbox recording, ship labels), a `loom` command, and five skills: `loom:ship`, `loom:slack-drafting`, `loom:handling-slack-threads`, `loom:tmux-route` and `loom:review`.

Loom installs it with Claude Code's own plugin commands, so it never edits `settings.json` itself. The wizard (or Settings › Helpers) shows the exact commands before it runs them:

```bash
claude plugin marketplace add ~/.loom/plugin-marketplace --scope user
claude plugin install loom@loom-local --scope user
```

To remove it, use Settings › Helpers, or:

```bash
claude plugin uninstall loom@loom-local
claude plugin marketplace remove loom-local
```

Start new Claude sessions after installing; running sessions keep the hooks they began with. Codex has no plugin system, so Loom adds its placement hook to `~/.codex/hooks.json` only if you say yes, after showing you the change.

## Slack

Slack is optional. Pick one mode in the wizard or Settings › Slack.

**Direct app.** You create a small Slack app in your own workspace from a manifest Loom shows you, install it, and paste the User OAuth Token (starts with `xoxp-`) into Loom. The token is stored in the macOS login Keychain, not in a file. This turns on everything:

- Slack watchers (polling channels)
- parked-thread reply detection and the "reply received" notification
- sending from the Outbox, including Send and park and Send and close
- channel names, people names and custom emoji in the sidebar, previews and Outbox
- thread previews and unread counts
- reconciling sent drafts against Slack
- reactions from the `loom thread` command

The app asks for user scopes only (no bot user, no events):

```
channels:history  groups:history  im:history  mpim:history
channels:read     groups:read     im:read     mpim:read
users:read        emoji:read      files:read
chat:write        im:write        mpim:write  files:write
reactions:write   search:read
```

There is a read-only manifest that leaves out the five write scopes (`chat:write`, `im:write`, `mpim:write`, `files:write`, `reactions:write`). Loom then reads and never posts. After connecting, Settings › Slack shows how many scopes were granted and which are missing. Some workspaces need an admin to approve a new app; if you see "Request to install", ask your admin or use MCP only.

**MCP only.** Loom uses the Claude Slack connector you already have in Claude Code. There is no app to create, but Loom has no token of its own, so these stay **off**: watchers on Slack, parked-thread reply detection, Outbox sending, Slack names and emoji, and thread previews and unread counts. Still working: chats that read or post to Slack through the connector, thread ownership, Outbox drafts being visible, and the shortcut.

**Off.** Nothing Slack-related appears, and Loom makes no Slack call.

### The shortcut

Press <kbd>⌘⇧L</kbd> anywhere. Loom shows a crosshair over every display and outlines the Slack message under the pointer. Click one, and Loom jumps to the chat that owns that thread, or starts a chat for it in the project mapped to that channel (Settings › Slack › Channel folders). <kbd>Esc</kbd> cancels. You can change the key in Settings › Shortcut.

Loom reads the message through the macOS Accessibility API, so grant **Loom.app** Accessibility in System Settings › Privacy & Security › Accessibility. If a message cannot be read, Loom can fall back to the link you copy (the clipboard fallback). The Accessibility grant is also what Ghostty tab focus needs. The embedded terminal needs no permissions at all.

## Watchers and templates

A watcher is one rule: a source (a Slack channel, your chats, or pull requests), a trigger, and an action (start a chat, message a chat, notify you, or tell the orchestrator). Watchers are off until you turn them on (Settings › Watchers), and a new watcher starts disabled and in shadow mode, which logs what it would have done without doing it.

Pick a template to start from, then fill in the blanks (a channel, a repo, a project folder):

- **Slack** (needs Direct): PRs posted in a channel, posts that mention you, bot alerts containing a phrase
- **Chats**: stuck waiting on a tool, finished and ready to wrap up, context nearly full, silent mid-task, flipped to your turn
- **Pull requests** (needs `gh`): checks went red, review requested changes, approved and green

## Ship, per project

Ship releases the work you have staged in a git repo: it commits the batch, pushes a `ship/` branch, opens a pull request and merges it when checks allow. It never force-pushes and never skips hooks.

Ship needs a git repo with a remote and `gh` logged in. It is set up per project. In the wizard's Ship step (or Settings › Ship), add each repo and, for each one, set:

- the **base branch** (default `main`)
- the **ship command** the button sends to the chat (default `/loom:ship`)
- whether a **ship label** is required before staged work can ship

A new install has no repos, so there is no Ship button until you add one.

## Where data lives

Loom's data is in `~/.loom` (set `LOOM_HOME` to move it). It holds the database (`manager.db`), the generated dashboard, the tmux config, Outbox drafts, watcher briefs and the plugin copy. Nothing is written into the repo. Slack tokens are in the macOS Keychain, not in this folder. Everything in the data folder except the Keychain item is derived from your local transcripts, which Loom only reads (`~/.claude/projects`). Nothing is uploaded.

## Uninstall

1. Remove the plugin: Settings › Helpers, or the two `claude plugin` commands above.
2. If you connected Slack directly, use Settings › Slack › Disconnect. That deletes the token from the Keychain. You can also delete the Slack app at api.slack.com/apps.
3. If you let Loom edit `~/.codex/hooks.json`, remove the entry that runs `record-placement.sh` (a `.loom-bak` backup sits beside the file).
4. Quit Loom from the menu bar, then delete `/Applications/Loom.app`. Loom registers itself to open at login; deleting the app removes that.
5. Optional: delete `~/.loom`, which removes your Loom data (not your Claude chats), and the cloned repo.
6. Stop Loom's tmux server if it is still running: `tmux -L loom kill-server`. This ends the chats running inside it, so do it last.

## Advanced: lanes and crash recovery

Skip this unless you already keep your own tmux workspace. Loom also understands sessions named `loom-<lane>-<n>` on your own tmux server (Settings › Advanced › tmux server and Session prefix). With them you get:

- **Crash recovery.** Loom saves the full tmux layout every 15 seconds. `./bin/chat-manager restore --dry-run` shows what would be rebuilt, and `restore` rebuilds every session with its pane geometry and resumes the right chats. Only sessions whose names start with the session prefix (default `loom-`) are saved.
- **Ghostty tab reuse.** Restore can put sessions back into their existing Ghostty tabs.
- **Pane topics and tints.** Pane borders can show a short topic, and idle panes can warm in color the longer they wait.
- **Lane targets.** Watcher chats and new threads can start in an idle lane pane instead of a Loom-managed window.

## Architecture

```
src/            shared TypeScript backend (parser, indexer, analyzer, placements,
                goto, snapshot, restore, server, dashboard, settings, watchers, Slack)
app/            Electron app: bundles the backend, tray and window, background intervals
plugin/         the Claude Code plugin: hooks, `loom` CLI, skills
hooks/          placement hook for Codex and CLI-only use
scripts/        install-app.sh, install-hook.mjs
```

The app runs the backend, serves the dashboard at `127.0.0.1:4317`, and does the privileged work (tmux, process listing, osascript, file reads, headless `claude -p` summaries).

## Develop

```bash
yarn install
yarn test
./bin/chat-manager run        # one index pass, writes the dashboard
```

Build the app by hand with `cd app && yarn install && yarn build && yarn rebuild && yarn dist`. Install it with `scripts/install-app.sh`, which quits a running Loom, swaps the bundle in and relaunches. Never delete and copy over a running Loom; opening it mid-copy crashes it.

The app is unsigned. Built locally it opens directly.

## License

MIT
