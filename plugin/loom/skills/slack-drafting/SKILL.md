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

## A GitHub review in the same draft

A draft can also carry a pull request review, so the review and the Slack reply about it go out together
from one Send. Write the review as JSON in the scratchpad:

```json
{"repo": "acme/app", "pr": 12, "commit_id": "<head sha you reviewed>", "event": "REQUEST_CHANGES",
 "body": "Two blockers, inline.",
 "comments": [{"path": "src/a.ts", "line": 10, "body": "This drops the filter."},
              {"path": "src/b.ts", "start_line": 18, "line": 20, "side": "RIGHT", "body": "Null gets through here."}]}
```

`event` is `COMMENT`, `REQUEST_CHANGES` or `APPROVE` (a bare approve may have an empty body). Every comment needs
`path`, `line` and `body`; `side` defaults to `RIGHT`. Reactions to apply after the messages go in a second file,
a list of `{"url": "<slack message link>"}` (or `{"channel", "ts"}`) with `"add"` and/or `"remove"` emoji names:

```bash
loom outbox add --review-file review.json --reactions-file rx.json --thread <url> --text-file reply.md
loom outbox add --review-file review.json                  # a review with no Slack part
loom outbox update <id> --review-file review.json          # revise the review; the Slack text is kept
```

The card shows the PR, the verdict as a badge, the body and each inline comment above the Slack preview. Send,
Send & park and Send & close act on the whole draft: the review posts first (one call, every comment at once, as
the user through their own `gh` login), then the Slack messages with the usual typing gaps, then the reactions,
then the park or close. If GitHub refuses the review, nothing goes to Slack. Once the review is out it is recorded
on the draft, so a retry after a Slack failure posts only the Slack part. If the PR has new commits since
`commit_id`, the card warns before posting; the review still posts against `commit_id`.

## Every Send checks for new messages first

Before anything goes out, Loom re-reads where the draft is going: its Slack thread (or the channel, for a
top-level post), its email thread, its PR's reviews and comments. If someone other than the user wrote there since
the draft was recorded, nothing is sent: the card lists the new messages (who, when, a snippet, a link) with one
**Send anyway** (which also covers a moved PR head) and **Cancel**. If the check itself cannot run, the card says
"Could not check the thread for new messages" with the same two buttons. So read the thread right before you record
a draft, and if you read it a while ago, pass what you last saw: `--seen <slack ts>` or
`--seen '{"slack":"<ts>","email":"<gmail message id>","github":{"at":"<iso>","id":"<id>"}}'`. Without `--seen`
Loom records what is there when the draft arrives.

## Email drafts

When the email CLI is set up (Settings > Outbox > Email CLI; a Gmail-CLI-compatible script, by default
`~/.claude/tools/gmail/gmail.mjs`), an email can go through the outbox too:

```bash
cat > email.json <<'JSON'
{"to": ["sam@example.org"], "cc": [], "subject": "Re: Q3 filing", "body": "Hi Sam,\n\n...",
 "account": "work", "threadId": "<gmail thread id>", "inReplyTo": "<Message-ID it answers>",
 "thread_subject": "Q3 filing", "signature": true, "attachments": ["/abs/path.pdf"]}
JSON
loom outbox add --email-file email.json            # a new email: leave out threadId / inReplyTo
loom outbox update <id> --email-file email.json    # revise in place
```

A reply needs both `threadId` and `inReplyTo` (the `messageId` header `gmail read` prints). The card shows it as an
email; Send, Send & park (watches the Gmail thread for a reply) and Send & close work as for Slack. An email draft
carries no Slack messages or review.

## If Slack is not connected

When Loom's Slack mode is Skip, the plugin's outbox hook is off and `loom outbox add` still records the draft locally.
Show the draft in chat as usual and say it was recorded; the user decides how to send it.
