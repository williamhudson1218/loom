# Loom setup

How to build Loom on a Mac and what to expect on first launch. For what Loom is, see [README.md](./README.md).

> **Short version.** Clone the repo, run `./setup.sh --install`, open Loom, and follow the setup wizard.

## 1. Requirements

| Requirement | Why | Notes |
|---|---|---|
| macOS (Apple Silicon or Intel) | Loom uses Electron, `osascript` and the Accessibility API | macOS only. |
| Node 20+ | The CLI and the app use a native `better-sqlite3` | Pinned in `.nvmrc`. `nvm use` picks it up. |
| yarn (classic, v1) | Package manager for both workspaces | `corepack enable` or `npm i -g yarn`. |
| tmux | Keeps chats alive when Loom quits and is how Loom types into them | `setup.sh` installs it with Homebrew if missing. It warns on 3.6a, which crashes in copy-mode. Loom runs its own server (`tmux -L loom`, config `~/.loom/tmux.conf`), so your tmux and `~/.tmux.conf` are untouched. |
| Claude Code (`claude`), logged in | Loom resumes chats with it and summarizes them with headless `claude -p` | Loom has no credentials of its own. It uses your Claude Code login. |
| python3 | The plugin's hooks and the `loom` command use it | Included with the macOS Command Line Tools. |
| Swift compiler (`swiftc`) | Build time only. Compiles the Keychain helper and the Accessibility helper (the Slack shortcut and terminal tab focus) | Included with the Xcode Command Line Tools (`xcode-select --install`). |
| A free TCP port from 4317 to 4326 | Loom serves its dashboard on `127.0.0.1:4317`, or the next free port up to 4326 | One Loom per account. The first port is changeable in Settings › Advanced › Port. |

Optional:

- `gh` (GitHub CLI), logged in. Needed for pull request status, the pull request watchers and Ship.
- Ghostty, iTerm2 or Terminal.app, if you want Jump to open an external terminal instead of the one inside Loom.
- Codex. If `~/.codex` exists Loom can show Codex chats.
- find-chat, a separate tool that searches every transcript on disk. Put it at `~/.claude/tools/find-chat/bin/find-chat`, or set the path in Settings › Advanced › find-chat binary. Without it, the board works as normal and Search all history says find-chat is not installed. If search reports a `NODE_MODULE_VERSION` mismatch, rebuild find-chat's `better-sqlite3` with the same Node that runs it.

Loom uploads nothing. It reads `~/.claude/projects`, talks to local tmux and the local `claude` CLI, and calls Slack only if you connect it.

## 2. Build and install

```bash
git clone <this repo's URL> loom
cd loom
./setup.sh            # check prerequisites, install, test, build Loom.app
./setup.sh --install  # the same, then copy Loom.app into /Applications
```

`setup.sh` can be re-run and works from any clone location. It:

1. checks macOS, Node 20+, yarn, the `claude` CLI (a warning if missing), and tmux (installs it with Homebrew if missing);
2. runs `yarn install` and `yarn test` in the repo root;
3. creates Loom's data folder and copies Loom's tmux config there (it never overwrites an existing copy);
4. if `~/.codex` exists, shows the change it would make to `~/.codex/hooks.json` and asks first;
5. runs `yarn install`, `yarn build`, `yarn rebuild` and `yarn dist` in `app/`, producing `app/release/mac-arm64/Loom.app` (or `app/release/mac/Loom.app` on Intel);
6. with `--install`, runs `scripts/install-app.sh`.

It does not edit `~/.claude/settings.json`, and it does not write Loom's settings. The first time Loom opens, it sees a brand-new data folder and starts the setup wizard.

To install a build by hand, use `scripts/install-app.sh app/release/mac-arm64/Loom.app`. It quits a running Loom, waits for it to exit, swaps the bundle in and relaunches. Do not delete and copy over a running Loom; opening it mid-copy crashes it.

To use the CLI without the app: `yarn install`, then `./bin/chat-manager run` for one indexing pass.

## 3. The setup wizard

Loom opens the wizard on first launch. Only the **Requirements** step blocks you (tmux, Claude Code logged in, python3). Every other step can be skipped, and each one says what it unlocks.

| Step | What it does |
|---|---|
| Projects | Pick the folders you work in. Chats are grouped by project and new chats start there. |
| Terminal | Inside Loom (default), Ghostty, iTerm2 or Terminal.app. |
| macOS access | Accessibility for the Slack shortcut and Ghostty tab focus, with a Grant access button and live status. See section 6. |
| Agent permissions | Normal (default) or skip permissions, for chats, watcher chats and the orchestrator. |
| Loom plugin | Installs the plugin. Loom shows the exact `claude plugin` commands first. |
| Connections | Slack, GitHub and Gmail side by side, each with its status and Connect button, each optional. Slack keeps its Direct app, MCP only and off choices (section 5); GitHub and Gmail are in section 5a. |
| Slack shortcut | Hidden when Slack is off. See section 6. |
| Ship | Add the repos you ship from. |
| Orchestrator | A supervising chat. Off by default. Loom asks before it trusts the orchestrator's folder in `~/.claude.json`. |
| Watchers | Rules that react to events. Off by default. |
| Done | What is on and off, then a short tour. |

Close the wizard at any time; it resumes where you stopped. Settings (the gear) holds every choice. Settings › Help has **Take the tour** and **Run setup again**.

## 4. The plugin

The plugin connects chats to Loom: hooks, a `loom` command and five skills. Loom installs it through Claude Code, so nothing edits `settings.json` by hand. Loom copies the plugin to `~/.loom/plugin-marketplace` and runs:

```bash
claude plugin marketplace add ~/.loom/plugin-marketplace --scope user
claude plugin install loom@loom-local --scope user
```

Remove it from Settings › Helpers, or:

```bash
claude plugin uninstall loom@loom-local
claude plugin marketplace remove loom-local
```

Start new Claude sessions after installing or removing it. Running sessions keep the hooks they started with. Without the plugin, Loom still indexes and shows chats, but Jump and live state are less reliable and Slack thread ownership, the Outbox and ship labels do not work.

Codex has no plugin system. If `~/.codex` exists, Loom adds `hooks/record-placement.sh` to `~/.codex/hooks.json` only after you say yes, and writes `hooks.json.loom-bak` first. `setup.sh` offers this too.

## 5. Slack

Pick a mode in the wizard or Settings › Slack. You can change it later.

### Direct app

1. In Loom, copy the app manifest it shows you (Settings › Slack). It uses your name in the app title.
2. At [api.slack.com/apps](https://api.slack.com/apps), choose Create New App, From a manifest, and paste it.
3. Install the app to your workspace. Some workspaces need an admin to approve it.
4. Copy the **User OAuth Token** (it starts with `xoxp-`) and paste it into Loom. Loom checks it, shows the workspace and user, and stores it in the macOS login Keychain.

The app asks for these user scopes. There is no bot user, no event subscription and no socket.

| Needed for | Scopes |
|---|---|
| Reading channels, threads and DMs | `channels:history` `groups:history` `im:history` `mpim:history` |
| Channel and DM names | `channels:read` `groups:read` `im:read` `mpim:read` |
| People and emoji | `users:read` `emoji:read` |
| Thread previews with files | `files:read` |
| Sending from the Outbox | `chat:write` `im:write` `mpim:write` `files:write` |
| Reactions | `reactions:write` |
| Search | `search:read` |

A read-only manifest leaves out `chat:write`, `im:write`, `mpim:write`, `files:write` and `reactions:write`. Loom then reads and never posts. After connecting, Settings › Slack shows "N of M scopes granted" and lists any that are missing.

You can also provide the token in the `SLACK_USER_TOKEN` environment variable, which takes precedence over the Keychain.

### MCP only

Loom uses the Claude Slack connector already in your Claude Code setup. No app, no token. Because Loom has no token, these are **off**:

- watchers that read a Slack channel
- parked-thread reply detection and the "reply received" notification
- Outbox Send, Send and park, Send and close (chats can still post through the connector themselves)
- channel names, people names and custom emoji in the sidebar, previews and Outbox
- thread previews and unread counts
- checking sent drafts against Slack, and reactions from the `loom thread` command

These still work: chats that read or post through the connector, thread ownership, drafts showing in the Outbox, and the shortcut.

### Off

Nothing Slack-related appears, and Loom makes no Slack call. Choosing Direct without a token behaves the same until you add one.

To disconnect, use Settings › Slack › Disconnect. It deletes the token from the Keychain and turns Slack off.

## 5a. Connections: GitHub and Gmail

The header shows one dot per connection (green working, amber needs attention, grey not set up). Click a dot to open its Settings section. The wizard's Connections step shows the same three side by side.

### GitHub

Loom uses the GitHub CLI (`gh`) for pull request status, checks, reviews and Ship. Settings › GitHub, or the GitHub card in the wizard:

- **gh missing.** With Homebrew, click **Install with Homebrew**: Loom runs `brew install gh` and shows its output. Without Homebrew, get gh from [cli.github.com](https://cli.github.com), then click Check again.
- **gh not signed in.** Click **Connect GitHub**. Loom runs `gh auth login --hostname github.com --web --git-protocol https`, shows the one-time code with a Copy button, and opens github.com/login/device in your browser. Paste the code there and approve. Loom notices when gh finishes. Cancel stops gh.
- **gh signed in.** The card reads "Connected as <login>". Loom never changes an existing login. **Sign in again** asks first, then runs the same login; gh adds the account you approve and makes it active. Sign out or switch with `gh auth logout` and `gh auth switch`.

gh keeps its token in its own credential store. Loom never reads it.

### Gmail

Email drafts in the Outbox send as you. There are two ways, picked by Settings › Outbox › **Send email through**:

- **Automatic** (the default): a connected Gmail account if there is one, else the Email CLI.
- **Gmail** or **Email CLI**: always that one.

So an existing Email CLI setup keeps sending exactly as before until you connect a Gmail account.

**Connect Gmail (built in)** signs in to Google with your own OAuth client. Create it once (about five minutes):

1. In [console.cloud.google.com](https://console.cloud.google.com), create a project.
2. APIs and Services › Library: enable the **Gmail API**.
3. OAuth consent screen (Google Auth Platform): choose **External**, leave publishing status in **Testing**, and add every address you will connect as a **test user**.
4. Data access: add the scopes `gmail.send` and `gmail.metadata`.
5. Clients › Create client › **Desktop app**. Copy the client id and client secret into Settings › Outbox (or set `LOOM_GOOGLE_CLIENT_ID` and `LOOM_GOOGLE_CLIENT_SECRET`).
6. Click **Connect Gmail**. Google shows "Google hasn’t verified this app" because it is your own Testing app: click Continue, then allow.

Google treats a Desktop app's client secret as not confidential, so Loom keeps it with your settings. PKCE protects the sign-in, and the redirect goes to Loom on `http://127.0.0.1:<port>/google/callback`.

What Loom asks for, and why:

| Scope | Used for |
|---|---|
| `openid`, `email` | Your address: the From line and the address that counts as you in the before-send check |
| `gmail.send` | Sending a draft. It grants no read access. |
| `gmail.metadata` | Reading a draft's thread for the before-send check and parked replies: From, Date, Message-ID, labels and the snippet. No message bodies or attachments. |

Loom does not ask for `gmail.readonly` or `gmail.settings.basic`, so the built-in sender does not append your Gmail signature and does not list send-as aliases (messages you sent are still recognised through their SENT label). If you need either, use the Email CLI.

Each account's refresh token is kept in your macOS Keychain (item "Loom Google refresh", one per address). Connect more than one account with **Add another account**. The first is the default; a draft names another by its **Draft label** or its address in `account`. A Testing app's sign-in lasts seven days; when it lapses the Gmail dot turns amber and the account shows Reconnect. Disconnect deletes the Keychain item and revokes the grant at Google.

**Email CLI** is the alternative: any Gmail-CLI-compatible script (`send`, `thread`, `send-as`). Empty uses `~/.claude/tools/gmail/gmail.mjs` when it exists. Loom only runs it; the script holds its own credentials.

## 6. macOS permissions and the shortcut

Loom appears as **Loom**, with its icon, everywhere macOS asks. The wizard's **macOS access** step (and Settings › Terminal and Settings › Shortcut) shows whether Accessibility is on and has a **Grant access** button. Grant only what you use. The embedded terminal, the sidebar, the orchestrator and the Outbox need none of them.

- **Accessibility** (System Settings › Privacy & Security › Accessibility, the row named **Loom**). Needed for the Slack shortcut (<kbd>⌘⇧L</kbd>, or the key you choose in Settings › Shortcut), which reads the message under the pointer, and for Ghostty tab focus. Grant access shows the macOS prompt and adds the row switched off; switch it on. After you grant it, press the shortcut again. The wizard's shortcut step can test it.
- **Automation** (Privacy & Security › Automation, under **Loom**). Needed only for an external terminal: Ghostty (and System Events), iTerm2 or Terminal.app. macOS asks "“Loom” wants access to control …" the first time Loom reads or switches a tab; choose Allow. Without it tmux still selects the pane; only the window or tab focus fails, and Loom says so.
- **Keychain.** With Slack Direct, Loom keeps its token in the login Keychain. If macOS asks whether **Loom** may use "Loom Slack token", enter your login password and choose **Always Allow**.

The row named Loom belongs to a small helper inside the app (`Loom.app/Contents/Helpers/ax/Loom.app`), not to Loom.app itself. Loom.app is re-signed on every build, and macOS ties an unsigned app's permission to its exact code, so a permission held by Loom.app would be lost on every update. The helper is rebuilt only when its own source changes, so its permissions survive ordinary updates. When a release does change it, the old row stops working and macOS asks again: remove the old Loom row with the minus button, then grant the new one.

## 6a. Sharing Loom

Loom is not signed with an Apple Developer ID or notarized, so a copy someone downloads needs one extra step the first time. It is ad-hoc signed with a valid seal, so macOS treats it as an unverified app, not a damaged one.

To make the file: `cd app && yarn dist`, then `scripts/share-app.sh`. It checks the signature and writes `app/release/Loom-<version>-<arch>.zip`. Build on the same kind of Mac (Apple Silicon or Intel) as the person you are sending it to.

On the other Mac (macOS 15 or later):

1. Unzip it and drag **Loom** into Applications.
2. Open Loom. macOS says "Apple could not verify “Loom” is free of malware". Choose **Done** (not Move to Trash).
3. Open System Settings › Privacy & Security, scroll to Security, and click **Open Anyway** next to "“Loom” was blocked". Authenticate, then choose **Open Anyway** in the dialog. This is needed once per copy. Right-click › Open no longer skips this on macOS 15.
4. Or, instead of steps 2 and 3, run `xattr -dr com.apple.quarantine /Applications/Loom.app` in Terminal, then open Loom normally.
5. Loom starts the setup wizard. In **macOS access**, choose Grant access and switch on **Loom** in Accessibility for the Slack shortcut or Ghostty tab focus. Automation and Keychain are asked for when first used, as above.

If macOS ever says "Loom is damaged and can't be opened", the copy's signature is broken (an older build, or a bundle edited after signing). Rebuild with `yarn dist` and share it again.

## 7. Watchers and Ship

**Watchers.** Settings › Watchers has a master switch (off on a new install) and a list of rules. Start from a template: three for Slack (needs Direct), five for chats and three for pull requests (needs `gh`). A new watcher is saved disabled and in shadow mode. Shadow mode records what it would have done without acting. Check what it logged, then switch it to live. Watcher chats start in a Loom-managed window unless you set Settings › Watchers › Where watcher chats start to a lane.

**Ship.** Settings › Ship lists the repos Ship works on. For each repo you set the base branch (default `main`), the command the Ship button sends (default `/loom:ship`) and whether a ship label is required. The repo needs a remote and `gh` logged in. There is no Ship button until you add a repo.

## 8. Where Loom stores data

The data folder is found the same way by the app, the CLI and the hook:

1. `$LOOM_HOME`, if set
2. `~/.claude/tools/chat-manager`, if it already exists (older installs)
3. `~/.loom`

It holds `manager.db` (the index and settings), `dashboard.html`, `layout.json`, `placements.jsonl`, `tmux.conf`, the Outbox, watcher briefs, the orchestrator folder, `plugin-marketplace/` and `plugin-state.json`. Nothing is written into the repo. Slack tokens live in the Keychain, not here. Settings changes made in the app are saved in `manager.db`; before it changes an older install's data, Loom copies `manager.db` to a `manager.db.pre-*` backup.

The Finder-launched app does not read your shell profile, so `LOOM_HOME` in `.zshrc` does not reach it. To use a custom folder, start the app from a shell that has `LOOM_HOME` set.

## 9. Uninstall

1. Remove the plugin (Settings › Helpers, or the two `claude plugin` commands in section 4).
2. Settings › Slack › Disconnect, if you used Direct. Delete the Slack app at api.slack.com/apps if you want.
3. If you allowed the Codex hook, remove the `record-placement.sh` entry from `~/.codex/hooks.json`. A `.loom-bak` copy is beside it.
4. Quit Loom from the menu bar and delete `/Applications/Loom.app`. That also removes the open-at-login entry.
5. Delete `~/.loom` (or your `LOOM_HOME`) to remove Loom's data. Your Claude chats in `~/.claude` are not touched.
6. Run `tmux -L loom kill-server` to stop Loom's tmux server. This ends the chats running in it, so save what you need first.

## 10. Gotchas

- **Two `node_modules`, two ABIs.** The root install builds `better-sqlite3` for your Node. `app/` builds it for Electron. After `cd app && yarn install`, run `yarn rebuild`, or the app fails to launch with a `NODE_MODULE_VERSION` mismatch. Do not copy `node_modules` between them.
- **Intel output path.** `yarn dist` writes to `app/release/mac-arm64/` on Apple Silicon and `app/release/mac/` on Intel. `setup.sh` handles both.
- **Port 4317 busy.** Loom moves to the next free port, up to 4326, and Settings › Advanced › Port says which one it is using. Only when all ten are taken does it stop, with a message. A second Loom for the same account does not start; it reports the port the first one is on.
- **Two accounts on one Mac.** `localhost` is shared by every macOS user, so the second account's Loom finds 4317 held by the first and takes 4318. Each Loom writes its port to `server.json` in its own data folder (`~/.loom`), removes it on a clean quit, and the `loom` command, the plugin hooks, the orchestrator and the install script read it from there. `$LOOM_PORT` overrides it. Do not point a script at a fixed port: it would reach the other account's Loom. Slack and Google sign-in follow the actual port; the shared Slack app's manifest lists all ten redirect URLs.
- **Old launchd jobs.** If you ran an earlier version's `com.loom.*` or `com.chatmanager.*` jobs, unload them. The app now runs those intervals itself.
- **Extracting from the app bundle.** `asar extract-file` writes into the current directory. Run it from a scratch folder, not from the repo.

## 11. External terminals

Terminal, tmux socket and the other choices are in Settings (or `PUT /api/settings` with a JSON body).

| Setting | New install | Values |
|---|---|---|
| `terminal` | `inside` | `inside`, `ghostty`, `iterm2`, `terminal` |
| `tmux_socket` | `loom` | a socket name, or `default` for your own tmux server. `$LOOM_TMUX_SOCKET` overrides. Restart Loom after changing it. |
| `watchers_enabled` | off | on or off |

With an external terminal, Jump runs `tmux switch-client` on the attached client and brings the app forward. iTerm2 and Terminal.app select the tab whose tty matches the client, so a tmux client must be attached there (`tmux -L loom attach`). Ghostty matches the tab by its title, set by Settings › Terminal › Ghostty attach command.

## 12. Advanced: lanes and crash recovery

Optional. Skip it unless you keep your own tmux workspace. Loom also understands tmux sessions named `loom-<lane>-<n>` on your own tmux server. Set Settings › Advanced › tmux server to `default` and leave the session prefix at `loom-`. Then you can use:

- **Crash recovery.** Loom saves the tmux layout every 15 seconds. After a tmux crash, `./bin/chat-manager restore --dry-run` shows the plan and `./bin/chat-manager restore` rebuilds every session with its pane geometry and resumes the right chats. Only sessions whose names start with the session prefix are saved. `$LOOM_SESSION_PREFIX` overrides the prefix; an empty value includes every session.
- **Ghostty tab reuse** on restore (Settings › Terminal › Reuse Ghostty tabs).
- **Pane topics and tints** (Settings › Terminal).
- **Lane targets** for new threads and watcher chats.

The paths for Ship repos and the optional Slack command-line tools can be set with `$LOOM_SHIP_REPOS` (colon-separated), `$LOOM_SLACK_CLI`, `$LOOM_SLACK_THREADS_CLI` and `$LOOM_SLACK_STATE_DIR`. They are skipped quietly when absent.
