# Loom plugin

Hooks, a `loom` command line and five skills that connect Claude Code chats to Loom. Loom installs it from
Settings > Helpers through Claude Code's own `claude plugin` commands; nothing edits `settings.json` by hand.

- **Hooks:** `record-placement.sh` (which tmux pane a chat lives in), `thread-ownership.py` (a pasted Slack thread belongs
  to one chat), `outbox-recording.py` (a draft shown in chat must be recorded), `outbox-guard.py` (a Slack post is
  denied unless this chat's outbox already holds a matching draft), `ship-labels.py` (staged work needs a label).
  Each reads `$LOOM_HOME/plugin-state.json` and does nothing when its feature is off.
- **CLI:** `bin/loom` (python3, stdlib only). Writes are atomic event files in `$LOOM_HOME/events/`; reads and Slack actions go
  to Loom over HTTP on 127.0.0.1 with the token in `$LOOM_HOME/cli-token`. The Slack token never leaves Loom.
- **Skills:** `loom:ship`, `loom:slack-drafting`, `loom:handling-slack-threads`, `loom:tmux-route`, `loom:review`.

Tests: `python3 -m unittest discover -s plugin/tests` from the repo root.
