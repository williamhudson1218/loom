# Multi-agent sessions design

## Goal

Loom will index and manage both Claude Code and Codex sessions from one board.
Each session retains its source agent and can be resumed with that agent's native
context. A user may instead choose the other agent for a selected idle tmux pane;
that starts a new session in the same project and does not imply that prior
conversation context transfers.

## Data model

Add an `agent` discriminator with the values `claude` and `codex` to indexed
chats. A chat's database identity becomes `(agent, session_id)`, preventing a
session identifier from one agent from colliding with an identifier from the
other. The normalized `ParsedChat` and dashboard `ChatView` shapes expose this
field.

Add a small settings table, initially containing `default_agent`. Its value is
used as the initial selected action agent for a stale chat and is editable from
the dashboard header. Existing databases migrate without losing Claude rows:
old rows receive `agent = 'claude'` and are copied or rebuilt into the new key
shape as needed.

## Indexing and summaries

The existing Claude parser continues to index `~/.claude/projects/*/*.jsonl`.
A Codex parser indexes `~/.codex/sessions/**/*.jsonl`, using its `session_meta`
record for the session ID and working directory, and its event records for
timestamps, user messages, assistant text, activity, and useful file activity.

Both parsers produce the same normalized session data. The existing summary
pipeline receives agent-aware transcript text so it can summarize either source
without confusing their record formats. Index scans remain mtime-gated and
respect the current active-window and saved-session behavior.

## Dashboard and pane actions

Cards carry a visible Claude or Codex label. For stale cards, the resume control
uses the persisted default agent but allows a per-action override before a pane
is picked:

* Native agent selected: show **Resume [agent] context** and launch its native
  resume command (`claude --resume <id>` or `codex resume <id>`).
* Other agent selected: show **Start new [agent] here** and launch that agent in
  the card's project directory as a fresh session. No old session ID or
  misleading context-transfer claim is passed.

Branch is only offered for agents that support Loom's verified native branching
flow. In this first release, that is Claude; Codex branch support is deferred
until its CLI flags and persisted-session behavior are covered by tests.

## Live state, restore, and safety

Pane discovery becomes agent-aware by recognizing either CLI process. Claude's
existing placement hook remains authoritative for Claude sessions. Loom records
the agent and session identity whenever it launches a resumed session, allowing
the same pane mapping to work for Codex resumes. If a live process cannot be
matched to a session, Loom does not guess; it is simply not attached to a card.

Restore replays each saved pane with the recorded agent and native resume command.
Close and message actions use the same tmux controls for either agent. Message
injection is enabled only where the agent's terminal interaction is compatible;
unsupported actions are hidden instead of silently failing.

## Verification

Unit tests cover Claude/Codex parsing, agent-qualified storage and migrations,
both native launch commands, cross-agent fresh starts, and agent-aware snapshot
restore. Existing dashboard tests are extended to assert agent tags, default
selection, and accurate action labels. A manual smoke test indexes a real
session from each store, resumes each in a disposable tmux pane, and confirms
that selecting the other agent starts a fresh session in the same project.

## Non-goals

This change does not translate conversation histories between vendors, alter
either agent's own stored sessions, or introduce cross-agent semantic search.
It preserves the existing local-only, single-developer macOS/tmux operating
model.
