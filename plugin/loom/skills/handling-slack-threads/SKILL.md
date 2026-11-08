---
name: handling-slack-threads
description: Use when the user pastes a Slack thread link into a chat, or the Loom plugin says this chat now owns a thread. Decides whether the paste is a ticket to work or just context, and for a ticket owns its lifecycle - an eyes reaction and optional short ack when picked up, a no-entry reaction when it stalls on someone, the solution reply, and a check mark when done.
---

# Handling Slack threads

A pasted Slack link usually means "someone needs something, handle it". Not always. The Loom plugin
claims the thread for this chat (so a later paste of the same link routes back here) but posts and
reacts to nothing. Everything visible in Slack is this skill's call, made with judgment, not by reflex.

```bash
loom thread open <url> [--ack] [--eyes]        # eyes reaction (top-level channel posts only; --eyes forces), optional short reply
loom thread stage <url> blocked "<who/what>"   # no-entry reaction
loom thread stage <url> done [--react]         # check mark (only where open showed eyes; --react forces)
loom thread list [filter]                      # every thread with its stage and owner
loom thread claim <url>                        # take a thread another chat owns
```

Reactions and acks go through Loom and need Slack connected in direct mode. In any other mode the commands
still record the stage and print `(no reaction)`; the stage is how Loom shows the thread's state.

## 1. Read the thread, then decide what the paste is

Read the thread first, then the user's prompt around the link. It is one of three things:

| The paste is | Signs | Do |
|---|---|---|
| **A ticket**: someone needs something from the user | A question, a bug, a "can you", an @mention of the user, a problem nobody has resolved; the user says "handle this" or "look into this", or just pastes it bare | `open`, work it, close it (below) |
| **Context** for work already in this chat | "more context", "see also"; the chat is already working a related ticket; the thread is the user's own post or already resolved | Read it, use it, touch nothing in Slack |
| **A reference** | The user asks a question *about* the thread, wants a summary, or points at it for a different task | Answer in chat, touch nothing in Slack |

**Default to ticket.** Skip it only when the paste is clearly context or a reference. If it is unclear, it is a ticket:
`open` it and keep going, do not stop to ask. A second link into a ticket this chat already owns is context unless
someone in it is also waiting on an answer.

## 2. Open the ticket: eyes, and an ack only when it earns one

`loom thread open <url>` puts the eyes reaction on the parent **only when the link is a top-level post in a channel**.
A DM link or a link to a reply inside a thread is recorded as looking with no reaction. Still run `open` on those.
Add `--eyes` to force the reaction when the user asks for it. The check mark follows the same rule (section 4); the
no-entry reaction always shows.

Add `--ack` to also post one short reply in the thread ("Looking into it"). The command picks the phrase, never acks a thread
twice and avoids recent phrases, so do not write your own. Ack only when **all** hold:

- someone asked the user directly or is plainly waiting on them,
- the user has not replied in the thread since,
- the answer needs real work (a query, an investigation, a fix), not a reply you can draft in a minute,
- it is an internal channel or DM. **Never ack in an external or shared-with-customer channel.**

Otherwise just `open`. An ack followed two minutes later by the real answer is noise. The ack is the only thing this
skill posts without showing the user first; everything else follows the `slack-drafting` skill.

## 3. Work it, and say so when it stalls

If it ends up waiting on someone, `loom thread stage <url> blocked "waiting on <who> for <what>"` and end the turn
with a `Waiting on <who>: <what>` line. The no-entry reaction is for when **our** next move is stuck behind someone,
not for a person's own follow-through after we handed them the fix.

## 4. Close it: a reply with the solution, then the check mark

The closing reply gives the fix (and, where they can do it themselves in the product, the steps), or "no fix yet, here is
what is next", or just answers if they were not after a fix. Never a diagnosis with no solution. Draft it with the
`slack-drafting` skill, show it, send it on the user's go-ahead.

Then `loom thread stage <url> done` once the reply is sent, or the user says they are handling it or drops it.
Done means the person has an answer, not that you understood the problem. The check mark shows only where `open`
showed eyes; a DM or reply-link ticket is still marked done with no reaction. Add `--react` when the user asks for
the check, or when the person who asked would plainly look for one.

Mark it done once our part is finished and nothing else is likely needed from us. If what is left is theirs to do,
it is done; if they come back with a problem, the thread reopens.

## Re-checking a thread

When the user asks you to check the thread again, re-read the thread this chat owns (`loom thread list` finds it if there are
several) and handle the newest message from the other person: answer it, draft the follow-up, or say nothing new has come in.

## Not this skill

- Threads owned by another chat: the plugin says so. Treat them as reference unless the user says to take one over
  (`loom thread claim <url>`).
- A context or reference paste never gets a stage, so it never needs closing.
