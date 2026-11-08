import type Database from 'better-sqlite3';
import { insertWatcher, validateDraft, type ActionKind, type Params, type RunMode, type SourceKind, type WatcherDraft } from './model.ts';

// The 11 starting points (§9.2). Generic on purpose: no person, repo, channel
// or house skill is named. A skill comes from the review_skill / voice_skill
// settings through {{REVIEW_SKILL}} / {{VOICE_SKILL}} at render time. Every
// template is created Disabled and in Shadow, so nothing acts until the user
// has filled it in, watched what it would do, and switched it to Live.

export type TemplateNeed = 'slack_direct' | 'gh' | 'orchestrator' | null;

export interface WatcherTemplate {
  id: string;
  label: string;
  description: string;
  group: 'Slack' | 'Chats' | 'Pull requests';
  /** What must be set up for it to work (the editor shows it, the wizard filters by it). */
  needs: TemplateNeed;
  /** Fields the user must fill before it can be enabled. */
  fill: string[];
  draft: WatcherDraft;
}

const READ_ONLY_RULES = `## Read-only until the user says otherwise
- Slack: no reactions, replies, DMs or posts.
- GitHub: no reviews, comments, approvals, merges, pushes or reactions. Read with \`gh pr view\`, \`gh pr diff\`, \`gh pr checks\` and \`gh api\` GETs.
- Never switch branches or check out the PR in this working tree; other sessions may share it.
- No edits to the repo and no writes to any database.`;

export const PR_REVIEW_BRIEF = `A pull request was posted in Slack: {{TITLE}}
Message: {{PERMALINK}}

Prepare a review of the pull request(s) linked in that message. Read the message (and any thread under it) for the link and what the poster asked. Load the {{REVIEW_SKILL}} skill and run its analysis, but publish nothing: skip every step of it that posts, reacts, resolves or approves.

${READ_ONLY_RULES}

## When you have it
End your turn with, for each PR:
1. **What it does**: 2-3 lines, with author, size and base branch.
2. **Risk**: low / medium / high, and why.
3. **Look at**: the files or hunks worth a human's eyes, as \`path:line\`.
4. **Findings**: blocking concerns only, each as the draft comment you would post. "None" if there are none.
5. **Recommendation**: approve / request changes / comment, in one line.

Then ask once what to do, and wait in this pane.
`;

export const SLACK_ASK_BRIEF = `A Slack message needs a look: {{TITLE}}
Message: {{PERMALINK}}
From: {{AUTHOR}}

{{TEXT}}

Read the message and its thread, then work out what is being asked and what the answer or fix is. Investigate read-only: code, docs, logs.

## Slack is off-limits until the user approves
- No reactions, replies, DMs or posts. Draft any reply here instead{{VOICE_HINT}}.

## When you have it
End your turn with: the answer (2-5 lines with the evidence), the reply you would post (not sent), and at most one question. Then wait in this pane.
`;

export const PR_CHANGES_BRIEF = `The review on {{PR}} requested changes: {{PR_TITLE}}
{{URL}}

Read the review comments, then address each one that is right and draft a reply for each that is not. Follow the repo's own rules for commits and pushes. Do not merge.

End your turn with what you changed, what you replied, and anything that needs a human decision.
`;

const T = (
  id: string,
  group: WatcherTemplate['group'],
  label: string,
  description: string,
  needs: TemplateNeed,
  fill: string[],
  source: [SourceKind, Params],
  trigger: [string, Params],
  action: [ActionKind, Params],
  safety: { max_per_hour?: number; cooldown_min?: number } = {},
): WatcherTemplate => ({
  id,
  group,
  label,
  description,
  needs,
  fill,
  draft: {
    label,
    enabled: false,
    run_mode: 'shadow',
    source: { kind: source[0], params: source[1] },
    trigger: { kind: trigger[0], params: trigger[1] },
    action: { kind: action[0], params: action[1] },
    template_id: id,
    ...safety,
  },
});

export const TEMPLATES: WatcherTemplate[] = [
  // Slack (needs the Direct connection)
  T('slack-pr-posts', 'Slack', 'PRs posted in a channel', 'Someone posts a pull request link in a channel: start a chat that prepares a review and publishes nothing.', 'slack_direct',
    ['source.params.channel', 'trigger.params.repos', 'action.params.project_dir'],
    ['slack', { channel: '' }], ['pr-link-post', { repos: [], exclude_user_ids: [] }],
    ['start_chat', { project_dir: '', target: 'managed', brief_template: PR_REVIEW_BRIEF, perm: 'inherit' }]),
  T('slack-mentions', 'Slack', 'Posts that mention me', 'A message in a channel @-mentions you: get a notification.', 'slack_direct',
    ['source.params.channel'],
    ['slack', { channel: '' }], ['mentions-me', {}],
    ['notify', { template: '{{AUTHOR}} mentioned you: {{TITLE}}' }]),
  T('slack-bot-phrase', 'Slack', 'Bot alerts containing a phrase', 'A bot posts a message containing a phrase: start a chat to look into it.', 'slack_direct',
    ['source.params.channel', 'trigger.params.bot_ids', 'trigger.params.needle', 'action.params.project_dir'],
    ['slack', { channel: '' }], ['bot-post-contains', { bot_ids: [], user_ids: [], needle: '' }],
    ['start_chat', { project_dir: '', target: 'managed', brief_template: SLACK_ASK_BRIEF, perm: 'inherit' }]),
  // Chats
  T('chat-blocked-tool', 'Chats', 'Stuck waiting on a tool', 'A chat has waited 5 minutes on a tool call (often a permission prompt): get a notification.', null, [],
    ['chats', {}], ['blocked_on_tool', { min: 5 }],
    ['notify', { template: '{{CHAT_TITLE}} has been waiting on a tool for {{WAITING_MIN}} min' }]),
  T('chat-done', 'Chats', 'Finished, ready to wrap up', 'A chat finished its work and has sat idle for 10 minutes: get a notification.', null, [],
    ['chats', {}], ['done_idle', { min: 10 }],
    ['notify', { template: '{{CHAT_TITLE}} is done and ready to wrap up' }]),
  T('chat-context', 'Chats', 'Context nearly full', 'A chat has used 85% of its context window: tell it to write a handoff.', null, [],
    ['chats', {}], ['context_over', { fraction: 0.85 }],
    ['message_chat', { template: 'Your context is {{PERCENT}}% full. Write a short handoff brief now (goal, what is done with file names, what is left, decisions to keep) so a fresh session can continue.' }]),
  T('chat-silent', 'Chats', 'Silent mid-task', 'A chat is mid-turn but has written nothing for 10 minutes: tell the orchestrator.', 'orchestrator', [],
    ['chats', {}], ['silent_mid_turn', { min: 10 }],
    ['tell_orch', { template: '{{CHAT_TITLE}} is mid-turn but silent for {{SILENT_MIN}} min' }]),
  T('chat-your-turn', 'Chats', 'Flipped to Your turn', 'A chat finished its turn and is waiting for you: get a notification.', null, [],
    ['chats', {}], ['became_your_turn', {}],
    ['notify', { template: '{{CHAT_TITLE}}: your turn' }], { max_per_hour: 30, cooldown_min: 0 }),
  // Pull requests (needs gh)
  T('pr-checks-red', 'Pull requests', 'Checks went red', "A PR one of your chats owns fails its checks: tell that chat.", 'gh', [],
    ['prs', { repos: [], mine_only: true }], ['checks_red', {}],
    ['message_chat', { template: 'Checks failed on {{PR}}: {{CHECK}}. Look at the failure and fix it.' }]),
  T('pr-changes', 'Pull requests', 'Review requested changes', 'A review on one of your PRs requests changes: start a chat to address it.', 'gh', ['action.params.project_dir'],
    ['prs', { repos: [], mine_only: true }], ['changes_requested', {}],
    ['start_chat', { project_dir: '', target: 'managed', brief_template: PR_CHANGES_BRIEF, perm: 'inherit' }]),
  T('pr-green', 'Pull requests', 'Approved and green', 'One of your PRs is approved with green checks: get a notification.', 'gh', [],
    ['prs', { repos: [], mine_only: true }], ['approved_green', {}],
    ['notify', { template: '{{PR}} is approved and green' }]),
];

export function getTemplate(id: string): WatcherTemplate | null {
  return TEMPLATES.find((t) => t.id === id) ?? null;
}

/** The list the editor and the wizard show. */
export function templateList(): Omit<WatcherTemplate, 'draft'>[] & { trigger: string; action: string; source: string }[] {
  return TEMPLATES.map(({ draft, ...t }) => ({ ...t, source: draft.source.kind, trigger: draft.trigger.kind, action: draft.action.kind }));
}

export interface FromTemplateOverrides {
  label?: string;
  enabled?: boolean;
  run_mode?: RunMode;
  source_params?: Params;
  trigger_params?: Params;
  action_params?: Params;
}

/**
 * Create a watcher from a template. Overrides are merged over the template's
 * params. It is saved Disabled and in Shadow unless the caller says otherwise,
 * and enabling is refused while a required field is empty.
 */
export function createFromTemplate(db: Database.Database, templateId: string, o: FromTemplateOverrides = {}, now: number = Date.now()): { ok: true; id: string } | { ok: false; detail: string } {
  const t = getTemplate(templateId);
  if (!t) return { ok: false, detail: 'unknown template' };
  const draft: WatcherDraft = {
    ...t.draft,
    label: o.label ?? t.draft.label,
    enabled: o.enabled ?? false,
    run_mode: o.run_mode ?? 'shadow',
    source: { kind: t.draft.source.kind, params: { ...t.draft.source.params, ...(o.source_params ?? {}) } },
    trigger: { kind: t.draft.trigger.kind, params: { ...t.draft.trigger.params, ...(o.trigger_params ?? {}) } },
    action: { kind: t.draft.action.kind, params: { ...t.draft.action.params, ...(o.action_params ?? {}) } },
  };
  const v = validateDraft(draft, { forEnable: !!draft.enabled });
  if (!v.ok) return v;
  return { ok: true, id: insertWatcher(db, v.draft, now) };
}
