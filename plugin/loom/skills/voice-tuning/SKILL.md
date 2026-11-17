---
name: voice-tuning
description: Use when the user runs /loom:voice-tuning, clicks "Tune my voice" in Loom Settings, or asks to build or retune a skill that writes Slack messages in their voice. Reads their own recent Slack messages, measures how they write, writes a voice skill (SKILL.md, people.md, corrections.md) under ~/.claude/skills/<handle>-voice/, tunes it with them on sample drafts, then sets it as Loom's voice skill. Never posts to Slack.
---

# Voice tuning

Build a skill that makes drafts sound like the user, from evidence: their own Slack messages.
The result is three files Loom's drafting already knows how to use, and the user approves every rule.

**This skill never posts, reacts, or sends anything to Slack.** It only reads. Sample drafts are shown in
chat; they are never recorded in the Outbox.

## Privacy

The messages are read through the user's own Slack connection (Loom's token on this computer, or their
Claude Slack connector). This Claude session analyzes them like any chat, so their text goes to the user's
model as part of this conversation. The raw messages are written only to a temp file, which is deleted
once the voice skill is written. The voice skill is saved in `~/.claude/skills`. Nothing is sent to Loom or
anyone else, and nothing is posted to Slack. Don't paste more than a few short examples into chat, and
don't write message text anywhere except the temp file and the new skill folder.

## 0. Say what happens, and ask first

Before reading anything, tell the user in plain words:

> This reads your own recent Slack messages (about 500) through your Slack connection, on this computer. This
> Claude session analyzes them like any chat. The raw messages go to a temp file that is deleted once your
> voice skill is written to ~/.claude/skills/<handle>-voice/. Nothing is sent to Loom or anyone else, and
> nothing is posted to Slack. Go ahead?

Wait for a yes. Without one, stop.

## 1. Pull their messages

**With a Loom Slack token** (Settings, Slack, Connected):

```bash
loom slack mine --limit 500 --out
```

`--out` with no path writes a private (0600) temp file and prints its path; keep that path for step 5. A path
of your own must be in a temp directory, or the command refuses it. Without `--out` the JSONL goes to stdout.

Each line is `{"ts", "channel_type": "dm"|"channel"|"thread", "channel", "channel_name", "text"}`, newest
first. Loom has already left out messages its Outbox sent, messages carrying the Claude connector's "Sent
using" stamp (those were drafted by Claude and would teach the skill its own voice), and Slack's own
join/leave/rename notices. The command prints kept and skipped counts.

- Exit 5 with "lacks search:read": tell the user to reconnect Slack in Loom Settings (Slack section) once, then stop.
- Exit 5 with "no Slack token" or "does not have `slack mine`": use the connector, below.

**With only the Claude Slack connector** (no Loom token): search with the connector's search tool
(`slack_search_public_and_private`, or `slack_search_public` if that is all there is), query `from:me`,
`sort: timestamp`, `include_context: false`, `response_format: concise`, 20 per page, following the cursor
until you have about 300 messages or the results run out. Note the channel type from where each hit was
(a DM, a channel, a thread reply). Leave out anything that reads as drafted by Claude: the "Sent using" stamp,
and any message whose text matches a draft in `loom outbox list --all --json`. Write the same JSONL shape to a temp file (`mktemp -t loom-mine` gives one), never to a
persistent location.

Fewer than 50 messages is too little to measure: say so and ask whether to go on.

## 2. Measure

Compute these with a short script over the JSONL (python3 is fine), split by channel type where it matters.
Report numbers, not impressions.

| Measure | What to compute |
|---|---|
| Length | median and 90th-percentile words per message; per channel type |
| Capitalization | share of messages starting lowercase; share of lowercase quick replies (under 8 words) |
| End punctuation | share ending with `.`, `?`, `!`, nothing |
| Dashes and marks | rate of em-dash `—`, en-dash, `;`, `...`, `!` per 100 messages |
| Openers | the 15 most common first words or two-word openers ("yeah", "ok", "hey", "so") |
| Sign-offs | common closing words or phrases, and whether they thank or sign their name |
| Softening | how directives are phrased: "can you", "could you", "mind", "would you", bare imperatives |
| Hedges | "I think", "probably", "might", "maybe", "not sure" rates |
| Emoji | rate, which ones, and whether they replace words or decorate |
| Bursts | consecutive messages within 2 minutes in the same conversation: how often, how many per burst |
| Formatting | backticks, bullets, bold, links, @-mentions: how often, and in which channel types |
| Questions | share of messages that are or contain a question |

Then read 30 to 40 messages across the types and note what numbers miss: humour, how they say no, how they
deliver bad news, how they answer a technical question, words they never use.

**People.** Count who they message most: group DMs by `channel` (a DM's `channel_name` is the other
person's user id), and count `<@U…>` mentions in thread and channel messages. Resolve ids to names with the
Slack tools this session has (the connector's user search or profile lookup). For the top 8 to 10 people,
compare length, capitalization and formality against the overall median: that shift is the person's register.

## 3. Write the skill

Pick a handle: the user's first name or Slack handle, lowercase (ask if unsure). Write
`~/.claude/skills/<handle>-voice/` with exactly three files. Check the folder does not already exist; if it
does, ask before overwriting, and keep its corrections.md.

**SKILL.md**: frontmatter `name: <handle>-voice` and a description that says to load it before writing any
message that goes out under the user's name. Then rules, each one a directive backed by its number:

- Openers: what they start with, and what they never start with.
- Length: the median and when to go longer.
- Capitalization and punctuation: lowercase quick replies, full sentences in longer ones, which dashes and
  marks to use and which to avoid.
- Softening: how directives and asks are phrased.
- Bursts: when to split into several messages and how long each is.
- Formatting: what to leave out in chat (often backticks, bullets and bold).
- Banned AI tells: things they never write and Claude tends to (filler openers like "Great question",
  "Happy to help", "I hope this helps", over-hedging, summaries of what was just said, em-dashes if they
  don't use them).
- Five to eight short example messages, paraphrased so no real names or numbers appear.
- A line saying corrections.md overrides this file where they conflict, and people.md sets the register per reader.

**people.md**: one section per person from step 2: name, how often, and how the register shifts (shorter,
more casual, more formal, more technical). Mark anything inferred as inferred. Never record pronouns unless
the user states them.

**corrections.md**: start it with this header exactly, then the entries from step 4. Loom appends to it when
the user edits a draft in the Outbox before sending, so keep the format:

```markdown
# Voice corrections log

Newest first. Each entry: what was drafted, what was sent or said instead, and the rule now.
These override SKILL.md where they conflict. Add an entry every time a draft is changed.

Format: `## YYYY-MM-DD — <where>: <lesson>`, then `Before:`, `After:` and `Note:` lines.
Add new entries at the top, under this header.

---
```

## 4. Tune with samples

Draft five sample messages with the new skill loaded, on neutral made-up topics from their work:

1. a quick reply (one line)
2. a status update
3. an ask of a teammate
4. a disagreement or a no
5. an answer in a thread to a technical question

Show them numbered, as blockquotes, and ask the user to approve or correct each. For every correction:

- change the rule in SKILL.md (or people.md) that produced the miss, and
- add an entry at the top of corrections.md: date, which sample, `Before:` the draft, `After:` their
  version, `Note:` the rule now.

Redraft the corrected samples and show them again. Repeat until the user says all five sound like them.

## 5. Turn it on

Set it as the skill Loom's drafting loads, through Loom's settings path (never by editing Loom's database):

```bash
loom settings set voice_skill <handle>-voice
```

Tell the user it is set, that Settings, Agents, "Voice skill for drafts" shows it, and that with "Learn from
Outbox edits" on, every draft they edit before sending is saved locally to corrections.md for the next tune.

Delete the temp file from step 1 (`rm <path>`), along with any other scratch file holding message text, and
say so: "Deleted the temp file with your messages. Your voice skill is in ~/.claude/skills/<handle>-voice/."
If the user stops partway, delete the temp file then too.
