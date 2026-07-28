# Loom EM — Engineering Manager Layer — Design

**Date:** 2026-07-27
**Status:** Designed, not implemented
**Location:** `~/dev/loom/`

## Problem

Loom shows you every session. It does not *manage* them.

Will runs ~8 concurrent Claude/Codex sessions across several repos. Loom already
surfaces each one's state (`done` / `waiting_on_user` / `warning` / `error`),
whether its pane is live, and whether it's actively generating. But every
decision about that fleet is still manual and, in practice, doesn't happen:

- A session finishes and sits there **holding a pane** until Will notices.
- A session asks a question and **blocks indefinitely** — often a question whose
  answer is written down in `AGENTS.md` or `docs/`, requiring no judgment at all.
- Two sessions **converge on the same files** with neither aware of the other.
- A session **drifts** off the original ask into a tangent nobody chose.
- A session **spins** — dozens of messages of brainstorming, zero artifacts.
- A session's **context fills up** and quality degrades with no signal.
- Work that finished cleanly leaves **fast-follows that are never written down**,
  so they're lost when the pane closes.

The board is a read-only instrument panel. What's missing is something that
*acts* on what the panel shows.

## Mission

> Keep work moving. Prevent scope creep. Ensure every finding is documented so it
> can be picked up later.

Those three collapse into one dominant move: **when a session is stuck, drifting,
or bloated, externalize the loose work to a GitHub issue and get the session back
on its original ask.** Nothing is dropped, only deferred.

## Goals

- Detect stalled, blocked, drifting, spinning, colliding, bloated, and finished
  sessions **without spending tokens to do so**.
- Act autonomously — nudge the session, answer its question, refocus it, restart
  it, or wrap it up — with a full audit trail.
- **Answer the easy questions on Will's behalf.** Anything derivable from the
  repo, `AGENTS.md`, `docs/`, or Will's recorded preferences gets answered
  directly. Only real judgment calls reach Will.
- File every deferred finding as a GitHub issue on the session's own repo.
- Nudge Will through four channels when something genuinely needs him.

## Non-goals

- **A long-lived Claude session as the EM.** Considered and rejected: it occupies
  a pane, accumulates context without bound, dies when its tab closes, and burns
  tokens re-deriving state every tick — it is precisely the failure mode it
  exists to detect. The EM must be a process, not a conversation.
- **LLM-driven scanning.** Every detector is a threshold over numbers computed in
  TypeScript. The model is called only after a detector has already fired on a
  specific session.
- **Managing non-Loom work.** Scope is tmux panes running Claude/Codex that Loom
  already indexes.
- **Replacing the analyzer.** The EM consumes the analyzer's `state`, `overview`,
  and `key_moments`; it does not re-summarize.

## Architecture

A new module inside the always-on Loom process — the same host that already runs
the summarizer every 10 min and layout snapshots every 15s. No new daemon.

```
src/em/
  signals.ts     ChatRow + live map + fs + git → numbers.   0 tokens
  detectors.ts   thresholds over signals → Finding[].       0 tokens
  triage.ts      the ONLY LLM call site. Finding → Intervention.
  actions.ts     execute via goto.ts primitives, gh CLI, notifiers.
  ledger.ts      em_findings / em_actions. Cooldowns, idempotency.
  notify.ts      the four escalation channels.
  index.ts       the tick loop; wired into server.ts's interval block.
```

### Two-tier loop

| Tier | Period | Work | Token cost |
|---|---|---|---|
| fast | 30s | recompute all signals, run all detectors, record new findings | **zero** |
| slow | 5m | triage findings not yet triaged; execute interventions | one call per *new* finding |

A tick where nothing is wrong costs nothing. Cost scales with the number of
problems, not the number of sessions or the passage of time.

## Signals

All computed in plain TypeScript from data Loom already has, plus two cheap reads.

| Signal | Derivation |
|---|---|
| `live` / `working` | existing `liveSessions()` + the `WORKING_MS` mtime rule in `server.ts` |
| `idleMs` | `now − statSync(jsonl_path).mtimeMs` — `server.ts` already computes this |
| `state` | analyzer's `chats.state` column |
| `contextTokens` | tail-read the last assistant message's `usage`: `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` |
| `model` | last assistant message's `message.model` |
| `filesWritten` | **new column** — see *Required parser change* |
| `writeRatio` | `filesWritten.length / assistantMessageCount` |
| `commitsSince` | `git -C <project_dir> log --oneline --since=<started_at>` |
| `askDrift` | term-overlap score: `first_message` vs the last two `key_moments` |
| `overlap(a,b)` | Jaccard of `filesWritten` sets, for live chats sharing a `project_dir` |

### Required parser change

`parser.ts:13` defines `FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'NotebookEdit'])`
and folds all four into one `files_touched` column. **Convergence detection cannot
use that column.** In a monorepo, two sessions both reading `AGENTS.md` would
score as a collision; the false-positive rate would make the detector useless.

Add a `files_written` column populated from `Edit` / `Write` / `NotebookEdit` only.
`files_touched` keeps its current meaning and current consumers. Migration follows
the existing `applySchema` ALTER pattern in `schema.ts`, and rows are backfilled
naturally on the next index pass since `parseJsonlFile` re-reads the whole
transcript.

### Context limits are per-model

`message.model` is recorded on every assistant message (verified: `claude-opus-5`).
A `MODEL_CONTEXT_LIMITS` map keys off it — a `[1m]` session and a standard 200k
session must not share one hardcoded threshold. Unknown model ids fall back to a
conservative default. BLOATED fires on a *fraction* of the model's limit, never an
absolute token count.

## Detectors

Thresholds below are **initial guesses**. They are config constants, expected to
be recalibrated from what shadow mode reveals.

| Detector | Fires when | Intervention |
|---|---|---|
| **BLOCKED** | live ∧ `state = waiting_on_user` ∧ `idleMs > 90s` | Extract the question from the transcript tail; triage; answer it or escalate |
| **STALLED** | live ∧ `idleMs > 15m` ∧ `state ≠ waiting_on_user` | Nudge the pane: what's the current state, what's next |
| **SPINNING** | `messageCount > 30` ∧ `filesWritten = 0` ∧ `commitsSince = 0` ∧ age > 45m | Force a decision: instruct it to commit to one approach and start; file the unpicked options as issues |
| **DRIFTING** | `askDrift` below threshold ∧ writes landing outside the original ask's area | File the tangent as an issue; instruct the session to return to the original ask |
| **CONVERGING** | two live chats, same `project_dir`, `overlap > 0.3` on **written** files | Cross-brief both panes with what the other is doing; notify Will |
| **BLOATED** | `contextTokens > 0.70 × limit(model)` | Synthesize a handoff brief; close; relaunch fresh in the same pane seeded with the brief |
| **WRAPPABLE** | `state = done` ∧ `idleMs > 10m` | Extract fast-follows → `gh issue create` → close the session, freeing the pane |

### BLOCKED is the flagship

The highest-value detector, because it converts Will's inbox into throughput.

1. Read the transcript tail; isolate the assistant's actual question.
2. Triage into exactly one of:
   - **derivable** — the answer exists in the repo, `AGENTS.md`, `docs/`, or Will's
     recorded preferences. Conventions, "where does this live", "is this already
     implemented", "which of our two patterns applies". The EM answers into the
     pane and records **the answer plus its citation** in the ledger, so Will can
     audit and override.
   - **needs Will** — genuine product judgment, a tradeoff with no documented
     default, or anything irreversible / external-facing / costly. Escalates.
3. Default on uncertainty is **escalate**. A wrong auto-answer is more expensive
   than a delayed one, because it silently steers work.

This is the one detector whose accuracy depends on a corpus rather than a
threshold, and the corpus is unusually strong: `AGENTS.md` is dense with
enforceable conventions, `docs/README.md` is a generated index of every rule and
procedure, and the memory directory records prior decisions and their rationale.

## Actions

All actuation reuses primitives that already exist in `goto.ts`.

| Action | Mechanism |
|---|---|
| `answer` / `nudge` / `refocus` | `sendToPane(pane_id, text, agent)` |
| `crossBrief(a, b)` | `sendToPane` to both panes |
| `fileIssue` | `gh issue create --label fast-follow`, repo inferred from `project_dir`; body links back to the Loom session id |
| `restart(brief)` | `closeSession` then `launchInPane` seeded with the synthesized brief |
| `wrapUp` | file issues **first**, then mark `saved` and `closeSession` — reusing the existing `/save` semantics, so a wrapped session is exempt from the 7-day prune and stays pinned in the Saved section rather than aging out of the board |
| `escalate` | all four channels (below) |

**Timing:** the EM interrupts at any time, including mid-generation. This is a
deliberate choice — on a drifting or colliding session, every additional minute
is wasted work, and waiting for idle can mean waiting through the exact work the
intervention exists to prevent.

**Ordering invariant:** any action that removes work from a session — refocus,
stand-down, restart, wrap-up — files its GitHub issue *before* it acts. If issue
creation fails, the action does not proceed. This is the mission's "document all
findings" requirement made structural rather than aspirational.

## Escalation channels

All four fire for an escalation, each carrying a jump link to the session:

1. **Loom activity feed** — a new EM section in the dashboard: every finding,
   every action taken, every open escalation. The durable record and the primary
   audit surface.
2. **macOS notification** — via the existing Electron app; tray badge counts open
   escalations.
3. **Slack DM** — reaches Will off the machine.
4. **The pane itself** — the question is typed into the session it concerns, so
   it's waiting in context when Will next looks there.

## Ledger and safety

Two new tables, following the existing `schema.ts` conventions:

```sql
CREATE TABLE em_findings (
  id           INTEGER PRIMARY KEY,
  agent        TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,   -- BLOCKED | STALLED | SPINNING | ...
  signals_json TEXT NOT NULL,   -- the numbers that fired it, for calibration
  detected_at  INTEGER NOT NULL,
  status       TEXT NOT NULL    -- new | triaged | acted | escalated | expired
);

CREATE TABLE em_actions (
  id          INTEGER PRIMARY KEY,
  finding_id  INTEGER NOT NULL,
  kind        TEXT NOT NULL,    -- answer | nudge | refocus | restart | issue | ...
  payload     TEXT NOT NULL,    -- exact text sent / issue URL / citation
  taken_at    INTEGER NOT NULL,
  shadow      INTEGER NOT NULL, -- 1 = would have done this, didn't
  result      TEXT NOT NULL
);
```

Guardrails, each of which exists because its absence is a concrete failure:

- **Per-(session, detector) cooldown.** Without it, a STALLED session is nudged
  every 30 seconds forever.
- **Global hourly cap on pane-writes.** Bounds the blast radius of a
  miscalibrated detector to something recoverable.
- **Never act on sessions whose `project_dir` is the Loom repo**, and never on
  EM-spawned headless calls. Prevents the EM from managing itself.
- **`signals_json` is retained on every finding.** Calibration is impossible
  without knowing what the numbers were when a detector fired.

### Shadow mode

An `em_mode` setting: `off` | `shadow` | `live`.

In `shadow`, every detector runs, every triage runs, every intervention is
composed and written to the ledger with `shadow = 1` — but nothing is sent to a
pane and no issue is filed. The feed shows exactly what the EM *would* have done.

Same code path, one flag. **Recommendation: run one week in `shadow` before
flipping to `live`,** long enough to calibrate §Detectors' thresholds against
real sessions. The end state is fully autonomous; shadow is how the thresholds
earn that, not a permanent brake.

## Cost

- Fast ticks: **zero tokens**, indefinitely.
- Slow ticks: zero unless a detector fired.
- LLM calls: one triage per *new* finding, one extraction per wrap-up. Realistic
  steady state is **20–40 headless `claude -p` calls/day**, via the existing
  `ClaudeRunner` with `--safe-mode --no-session-persistence` (the flags that keep
  hooks from firing and keep the EM's own calls out of the index).

Well under a single interactive session's daily consumption.

## Build order

Two phases, split so the first is useful on its own and generates the data the
second needs to be calibrated.

**Phase 1 — sense and shadow.** Parser/schema change (`files_written`), `signals.ts`,
`ledger.ts`, the `em_mode` flag, the Loom activity feed, and the three detectors
that need no cross-session reasoning: **BLOCKED**, **WRAPPABLE**, **BLOATED**.
Ships in `shadow`. Deliverable: a week of ledger rows showing what the EM would
have done, which is what makes Phase 2's thresholds defensible instead of invented.

**Phase 2 — act.** The remaining detectors (**STALLED**, **SPINNING**, **DRIFTING**,
**CONVERGING**), the full action set, the other three escalation channels, and the
flip to `live`.

## Open questions

- **`askDrift` scoring.** Term overlap between `first_message` and recent
  `key_moments` is a cheap prefilter, but its threshold is the least defensible
  number here. Shadow mode should reveal whether it needs to become an LLM call
  gated behind a coarser signal (e.g. writes outside the initial file set).
- **Codex parity.** `codexParser.ts` records no token usage, so BLOATED is
  Claude-only at first. Every other detector works for both agents.
