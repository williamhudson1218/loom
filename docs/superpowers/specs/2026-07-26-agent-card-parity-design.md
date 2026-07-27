# Agent card parity design

## Goal

Every Loom card identifies its owning agent and exposes the same management
controls for Claude Code and Codex: open in Ghostty, close, save, branch,
resume with its owner, and start fresh with the other agent. A launch preference
adds an `Ask every time` option without changing a card's explicit actions.

## Card actions

Each card displays a source-agent badge and two explicit stale-session actions:

- **Resume [source agent]** continues the stored session with its native agent.
- **Start with [other agent]** starts a fresh session in the same project.

Both buttons name the agent they launch, so no action depends on the header
preference to be unambiguous. Live cards retain **Open in Ghostty**, **Close**,
**Save**, and **Branch**, for both agents. The server validates the card's source
agent and never passes one agent's session ID to the other.

Each agent quits and forks through its own mechanism, and neither responds to the
other's:

| | quit | fork |
|---|---|---|
| Claude Code | `Ctrl-C` twice | `claude --resume <id> --fork-session` |
| Codex | `/quit` + Enter | `codex fork <id> [prompt]` |

Codex ignores `Ctrl-C` as a quit — it interrupts the turn and leaves the composer
up — so the original Claude-shaped close would have silently failed on it. Both
fork paths take the branch seed as a trailing prompt argument. Forking *across*
agents is rejected: neither can read the other's transcript.

## Launch preference

The header preference has `Claude Code`, `Codex`, and `Ask every time` values.
An agent value marks that agent's action as the highlighted default on every
card; `Ask every time` highlights neither, leaving the two explicit choices
equally weighted so the pick is made per launch. The preference is presentation
only — it never decides which agent a button launches.

## Live-session association

Loom records `(agent, session_id, pane_id)` from a `SessionStart` /
`UserPromptSubmit` hook. **Codex supports the same hook mechanism as Claude**, with
a Claude-compatible payload (`session_id`, `transcript_path`, `cwd`,
`hook_event_name`) — Claude reads the hook from `~/.claude/settings.json`, Codex
from `~/.codex/hooks.json`. Both agents therefore use one shared script and get
identical, exact association. No manual pane assignment, and no guessing from
recency, is needed for either agent.

This corrects the earlier diagnosis in this document's first revision, which held
that Codex exposed no comparable hook and proposed an explicit "assign live Codex
pane" action as the workaround. The hook existed and had in fact been firing all
along; the defect was in what it wrote.

**The bug:** the shared script recorded only a session id, no agent. `readPlacements`
resolved an absent agent to Claude, so every Codex placement was stored under
`claude:<codex-session-id>` — a key no chat row can ever match. 115 correctly
captured Codex placements were being discarded on read, and every Codex chat showed
as stale with its pane sitting right there.

**The fix:** the hook derives the agent from `transcript_path` (Codex writes
`rollout-<ts>-<id>.jsonl` under its sessions dir; Claude writes `<id>.jsonl` under
`projects/`), falling back to `$CODEX_HOME`, and writes it into each row. Rows
already on disk carry no agent and are genuinely ambiguous, so rather than being
assumed to be Claude they are resolved against the agent actually running in their
pane — the pane is the authority, and the id came from whatever is running there.
That heals the existing log without a rewrite.

## Verification

Tests cover all agent/action combinations, source-safe command construction, each
agent's quit and fork mechanism, the launch preference including `ask`, legacy
agent-less placement resolution, and live association. The hook is tested by
driving the real script with each agent's real payload shape.
