---
name: action-items
description: Use when the user describes a chain of follow-up work that depends on something happening later - "once X, do Y", "when the PR merges, send the reply", "after they answer, update the ticket", "then close this chat". Turns the chain into Loom action steps (`loom action add`) so Loom watches for the trigger and acts, instead of you remembering it.
---

# Action items: write the chain down

When the user says "once X, do Y", do not keep the chain in your head. Record each link as a step with
`loom action add`. Loom watches the trigger, runs the action, wakes this chat when it needs you, and can close
the chat when every step is done.

## Add a step

```bash
loom action add --title "<what this step is>" --when <trigger> --then <action> [--ask-first]
```

`--when` (the trigger):

- `now` fires at once. `manual` waits for the user: with `--then none` they check it off in Loom; with
  `send-draft` or `wake` it shows as due, and the send or wake happens only when they press Run.
- `pr-merged:acme/app#123` or a PR URL: fires when the PR is merged. `pr-shipped:acme/app#123` fires when the merge is deployed.
- `draft-sent:<draft id>`: fires when that outbox draft has been sent.
- `slack-reply:<thread url>[,from=<name>][,answers=<question>]`: fires on a reply in the thread, optionally only
  from one person, optionally only when the reply answers the question. `answers=` must come last and runs to the
  end of the string, so commas inside the question are fine.

`--then` (the action):

- `send-draft:<draft id>`: sends an outbox draft (Loom checks the thread for new messages first).
- `wake:"<instruction>"`: wakes this chat with the instruction.
- `none`: only tracks the trigger.

## Messages to send later

Write the message as a draft now (`loom outbox add`, see the slack-drafting skill) and add a `send-draft:<id>`
step. Revise it with `loom outbox update <id>`, never `loom outbox supersede`: a superseded draft removes its step.

## Ask first

Leave `--ask-first` off by default. The exception is a `wake` step whose instruction merges or deploys: add
`--ask-first` so the user confirms in Loom before it wakes you, unless the user said to just do it.

## Check your work

Run `loom action list` (Loom must be running). A spec Loom cannot parse is stored as a `failed` step there, not
rejected by the CLI, so always look. Fix it with `loom action remove <id>` and add the step again. Retry, Run and
Ask-first toggles are in the Loom panel.

If the user wants the chat closed at the end ("then close this chat"), run `loom action close-when-done on`
(`off` to undo). The chat closes once all steps are done, this chat is idle (not mid-turn and not sitting at a
permission prompt or a question), and it has no pending drafts.

## Example

"Once acme/app#123 merges, send the reply in that thread, then close this chat."

```bash
loom outbox add --thread https://acme.slack.com/archives/C0123456789/p1700000000000100 --text-file reply.md
# prints draft id d0123456789ab
loom action add --title "Send the reply after merge" --when pr-merged:acme/app#123 --then send-draft:d0123456789ab
loom action close-when-done on
loom action list
```

## When you are woken by `[Loom action <id>]`

Loom sends this when a `wake` step fires. The message gives the instruction. No one is watching, so act only if
things look the way the step expected. If they do not (a reply asking for changes, a red check, a merge conflict,
anything a person should see first), do not act: run `loom action fail <id> --why "<one line>"` and stop. When
the instruction is done, run `loom action done <id>`.
