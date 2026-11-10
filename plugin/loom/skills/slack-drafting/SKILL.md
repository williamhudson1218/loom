---
name: slack-drafting
description: Use when drafting a Slack message, DM or thread reply for the user to review and send. Shows the draft in chat and records it in Loom's outbox with `loom outbox add` so it can be sent from Loom. Never sends on its own.
---

# Drafting Slack messages

A Slack message is written in the user's name, so it is **drafted, shown, recorded and then sent only by the user**. This skill never posts.

## Steps

1. **Read before writing.** If the draft replies in a thread, read the thread first (the Slack tools or MCP server this
   session has; Loom's `loom thread list` shows the threads this chat owns). Reply to what was asked, in the order it was asked.
2. **Write the draft** in the user's register, not yours: plain, short, no filler openers, no flattery. Check the channel:
   a message that belongs in a different channel is a reason to tell the user, not to post it there.
   If the user has a voice or style skill installed, load it and let it layer on top of this one.
3. **Show it in chat** as a blockquote (or a numbered list of blockquotes when it is several messages), then ask whether to send it.
4. **Record it in the outbox in the same turn.** Write each message to a file in the session scratchpad, then:

   ```bash
   loom outbox add --thread <slack-thread-url> --text-file m1.md [--text-file m2.md ...]
   loom outbox add --channel <id|#name|@user> --text-file m1.md      # a new top-level message
   ```

   - A reply in a thread **must** use `--thread <url>`, not `--channel`: Loom needs the thread to watch it for the answer.
   - Several `--text-file` flags are one burst, sent in order.
   - **Images:** `--file <absolute-or-relative path>` (repeatable) attaches a file to the message it follows, so
     `--text-file m1.md --file shot1.png --text-file m2.md` puts the image on message 1. The file must exist when you
     record the draft. Loom shows a thumbnail under that message and Send uploads it as part of that message
     (the text becomes the upload's comment). A message that is only images, with no text, is `--images-only --file a.png`:
     on a top-level draft it posts as a thread reply under message 1; in a thread draft it posts in that thread.
     Text messages after the first stay where the draft posts. `update` keeps attachments when you omit `--file` and the
     message count is unchanged, replaces them when you pass `--file`, and `--clear-files` drops them.
   - The command prints the draft id. Mention it in one line under the draft.
5. **Revise in place.** When the user asks for changes, edit and re-record: `loom outbox update <id> --text-file m1.md`,
   or `loom outbox add` again for the same destination (the older pending draft is superseded). Re-record after **every** redraft;
   the outbox must hold the text the user is looking at.
6. **Retire a draft** that a different approach replaces: `loom outbox supersede <id>`.
7. **Sending is the user's.** They send from Loom, or tell you to send. Do not post, react, or reply in Slack yourself from this skill.
   After a send is confirmed, say what was sent; do not show it again as a draft.
   A Slack post from a chat is denied by Loom's `outbox-guard.py` hook unless this chat's outbox holds a pending
   draft for that destination with the same text. If it denies one, record or update the draft, show it, and wait.

`loom outbox list` shows pending drafts; `loom outbox show <id>` shows one.

## If Slack is not connected

When Loom's Slack mode is Skip, the plugin's outbox hook is off and `loom outbox add` still records the draft locally.
Show the draft in chat as usual and say it was recorded; the user decides how to send it.
