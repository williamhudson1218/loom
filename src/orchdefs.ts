// The Loom MCP server's tool list. No imports on purpose: the MCP process
// (src/orchmcp.ts) loads only this and talks to Loom over HTTP, so it never
// opens the database or tmux itself, and the bundle needs no native modules.

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
}

const chat = { type: 'string', description: "A chat key as list_chats returns it: '<agent>:<session id>', e.g. 'claude:3f2a…'." };
const itemKind = { type: 'string', enum: ['needs_you', 'blocked', 'moving', 'done'] };

export const ORCH_TOOLS: ToolDef[] = [
  {
    name: 'list_chats',
    description:
      'Every chat Loom knows: state (working | your_turn | not_running), its summary, project, pane name and tmux target, PR, owned Slack threads and tags. Running chats first. Your own session is left out. Pass tag to list only the chats carrying that tag.',
    inputSchema: {
      type: 'object',
      properties: {
        include_stopped: { type: 'boolean', description: 'Also list chats that are not running (active in the last 24h). Default false.' },
        tag: { type: 'string', description: 'Only chats carrying this tag (case-insensitive name).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'chat_tail',
    description: "The last turns of one chat's transcript, text only (no tool calls).",
    inputSchema: {
      type: 'object',
      properties: { chat, turns: { type: 'number', description: 'How many messages, default 8, max 40.' } },
      required: ['chat'],
      additionalProperties: false,
    },
  },
  {
    name: 'pr_status',
    description: "A PR's state, checks and review, from gh. Give the PR URL or a chat key (its PR is used).",
    inputSchema: {
      type: 'object',
      properties: { pr: { type: 'string', description: 'PR URL (https://github.com/o/r/pull/N) or a chat key.' } },
      required: ['pr'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_thread',
    description: 'Slack thread ownership. With a chat key: the threads that chat owns. With a thread permalink: the chat that owns it, if any.',
    inputSchema: {
      type: 'object',
      properties: { chat, url: { type: 'string', description: 'A Slack message or thread permalink.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'send_to_chat',
    description:
      "Type a message into another chat and submit it. Never asks Will first. If Will is looking at that chat's pane right now, the message is queued and goes out when he leaves it; the result says which.",
    inputSchema: {
      type: 'object',
      properties: { chat, text: { type: 'string', description: 'The message, as you would type it to that agent.' } },
      required: ['chat', 'text'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_items',
    description: 'The status rail: open items (needs_you, blocked, moving) and, with include_done, what was resolved today.',
    inputSchema: {
      type: 'object',
      properties: { include_done: { type: 'boolean', description: 'Also return items resolved today.' } },
      additionalProperties: false,
    },
  },
  {
    name: 'upsert_item',
    description:
      "Create or update a status item. One open item per ref: writing the same ref_type + ref_id again updates it (or pass id). kind 'done' resolves it into Done today. A new needs_you item notifies Will.",
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'number' },
        kind: itemKind,
        ref_type: { type: 'string', enum: ['chat', 'pr', 'slack', ''], description: 'What the item points at.' },
        ref_id: { type: 'string', description: 'chat key, PR URL or Slack permalink.' },
        title: { type: 'string', description: 'A few words.' },
        why: { type: 'string', description: 'One line: what is needed and why.' },
        who: { type: 'string', description: 'blocked: who it waits on. moving: the agent pane name.' },
      },
      required: ['kind', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'resolve_item',
    description: 'Close an item that no longer applies (it leaves the rail without counting as done).',
    inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'], additionalProperties: false },
  },
];
