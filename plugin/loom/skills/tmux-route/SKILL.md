---
name: tmux-route
description: Use when the user refers to another worker by its pane name ("talk to blue-vanilla", "ask cozy-donut what it found", "hand this off to hungry-hippo"), asks what this worker is called, or when a message arrives starting `[to <name> from <name>]`. Resolves a Loom pane name to its pane and delivers a message or handoff brief into it.
---

# Routing to a named worker

Loom gives every pane in a Loom tmux session a random `adjective-noun` name (`blue-vanilla`, `cozy-donut`), stored
as the pane option `@name`. A name stays with its pane for life, survives a tmux restore, and is shown on the pane
border. It is the address the user uses for workers; pane indices are not, because they renumber when a pane closes.

While a Claude session runs in the pane, the border may also show a **stage** glyph and a **topic**. These are labels,
never addresses: `@name` does not change, so always route by name. If the user names a worker by its topic, match it
against the topic in `loom route list` and confirm the name back before sending.

Loom may run tmux on its own socket, so use the `loom` commands below rather than raw `tmux` for lookups. They talk to
the right server.

## Who am I

```bash
loom whoami
```

Prints this pane's name, pane id, session and project. An empty name means this pane is outside a Loom session or
Loom has not named it yet: say so rather than inventing one.

## Resolve a name

```bash
loom route list      # pane id, name, target, running command, topic
```

- **No match:** stop. Show the live names and ask. Never fuzzy-match to a "close enough" worker: a wrong pane is a message
  injected into someone else's context.
- **The target is your own pane:** that is you. Do not send.
- **A Claude session** (the command is a version string): deliver a message as below.
- **A shell:** the user means "run this there". Send the command, but ask first unless they asked for exactly that command.
- **An editor, a dev server or anything else:** do not type into it. Tell the user what is running there.

## Deliver a message

The user naming the worker is the permission to write into its pane. Nothing else is.

1. **Address it:** `[to blue-vanilla from cozy-donut] ...`. The `to` lets a misdelivered message get caught; the `from`
   lets the recipient reply. Tell it how to answer: "reply with the tmux-route skill to cozy-donut".
2. **One line, at most 700 characters.** Flatten newlines (a newline submits early). Longer text is bracket-pasted and the
   Enter gets swallowed. If it is longer, write it to a file in your scratchpad and send a pointer:
   `[to y from x] brief at /path/brief.md - read it and take over`.
3. Send it: `loom route send blue-vanilla "[to blue-vanilla from cozy-donut] ..."`. Loom types the text, waits, sends Enter
   as a separate key, and reports whether the pane took it. Say "delivered" only after it says so.

Do not interrupt a busy worker (no Escape, no clearing its input) unless the user says to. The message queues behind its
current turn, which is fine.

## Handoff ("pass this off to cozy-donut")

The recipient has not seen your transcript. Write a self-contained brief to a file: goal, repo/branch/worktree, what is
done (with paths), what is left, decisions already made and why, how to verify. Deliver a pointer to it as above. Then
tell the user what you handed off and stop working that task, because two workers on one task collide in a shared git index.

## Receiving a message

A message that starts `[to <name> from <sender>]` came from another worker. Check `<name>` against your own name first.
If it is not you, do nothing with the request: reply to `<sender>` that it reached `<your-name>` instead, and tell the user.
Names are chosen to look unlike each other, so a mismatch is a real routing error, not a typo to shrug off.

## Replies

Workers cannot see each other's screens. To get an answer back, ask for it ("reply to cozy-donut with ..."). If you
need it before continuing, end your turn and say you are waiting on it. Do not poll their pane in a loop.
