// The first-run setup wizard's state machine (design §6). Pure: no DB, no I/O, no clock.
// src/routes/wizard.ts persists what this returns; the page (src/wizardview.ts) renders it.
//
// State is `{version, current, steps:{<id>:{status, at}}}`, stored as the
// `setup_state` setting. The "setup done" marker is separate (`setup_completed_at`
// plus `setup_origin`), so closing, resuming and re-running never touch it
// until the Done step is finished.

export const STEP_IDS = [
  'welcome',
  'requirements',
  'projects',
  'terminal',
  'macos',
  'permissions',
  'plugin',
  'slack',
  'shortcut',
  'ship',
  'orchestrator',
  'watchers',
  'done',
] as const;
export type StepId = (typeof STEP_IDS)[number];

export type StepStatus = 'pending' | 'done' | 'skipped';
export type SlackModeValue = 'direct' | 'mcp' | 'off';

export interface StepMeta {
  id: StepId;
  title: string;
  /** Shown as the Optional pill. */
  optional: boolean;
  /** Continue is refused until the step's own checks pass. */
  blocking: boolean;
  /** Skip is offered and accepted. */
  skippable: boolean;
  /** What this step is for, in one sentence. */
  why: string;
  /** What it unlocks, a short list. */
  unlocks: string[];
}

export const STEPS: readonly StepMeta[] = [
  {
    id: 'welcome', title: 'Welcome', optional: false, blocking: false, skippable: false,
    why: 'Loom shows every Claude Code chat on this Mac in one place and takes you to the right terminal.',
    unlocks: ['A single list of chats grouped by what needs you', 'Live working, waiting and done status', 'Resume, branch and park any chat'],
  },
  {
    id: 'requirements', title: 'Requirements', optional: false, blocking: true, skippable: false,
    why: 'Loom runs chats inside tmux and calls Claude Code, so both must be present.',
    unlocks: ['Starting and tracking chats (tmux and Claude Code)', 'Chat titles and summaries (Claude login)', 'PR status and the Ship button (gh, optional)', 'Codex chats (Codex, optional)'],
  },
  {
    id: 'projects', title: 'Projects', optional: true, blocking: false, skippable: true,
    why: 'Tells Loom which folders hold the code you work on, so chats are grouped and new chats start in the right place.',
    unlocks: ['Per-project grouping and filters', 'New thread opens in the right folder', 'Ship and Slack channel mapping later on'],
  },
  {
    id: 'terminal', title: 'Terminal', optional: true, blocking: false, skippable: true,
    why: 'Chooses where a chat opens when you click Jump or Resume.',
    unlocks: ['Inside Loom: a built-in terminal, no permissions needed', 'External terminals: jump to the existing tab (needs macOS permissions)'],
  },
  {
    // macOS privacy permissions, not Claude Code's: kept apart from Agent permissions by name.
    id: 'macos', title: 'macOS access', optional: true, blocking: false, skippable: true,
    why: 'Lets macOS allow the parts of Loom that read or control other apps. Loom appears as "Loom" in System Settings.',
    unlocks: ['Accessibility: the Slack shortcut reads the message under the pointer', 'Accessibility: Jump switches to the chat\'s tab in Ghostty', 'Automation: asked by macOS the first time Loom switches a terminal tab'],
  },
  {
    id: 'permissions', title: 'Agent permissions', optional: true, blocking: false, skippable: true,
    why: 'Sets whether chats Loom starts ask before running commands.',
    unlocks: ['A safe default for everything Loom starts (Normal)', 'Unattended chats and watcher workers (Skip permissions only)'],
  },
  {
    id: 'plugin', title: 'Loom plugin', optional: true, blocking: false, skippable: true,
    why: 'Installs the small hooks and skills that let chats talk to Loom.',
    unlocks: ['Reliable Jump, Resume and live state (pane state hook)', 'Slack thread ownership and the Outbox', 'Ship labels: who contributed what', 'Named panes and messages between chats'],
  },
  {
    id: 'slack', title: 'Slack connection', optional: true, blocking: false, skippable: true,
    why: 'Lets Loom read and post to Slack as you.',
    unlocks: ['Direct app: Outbox sending, parked-thread replies, watchers, names and emoji', 'MCP only: chats can use Slack, Loom itself cannot', 'Skip: nothing Slack-related appears'],
  },
  {
    id: 'shortcut', title: 'Slack shortcut', optional: true, blocking: false, skippable: true,
    why: 'Press a key over any Slack message to jump to its chat or start one.',
    unlocks: ['Jump to an existing chat for a thread in one keystroke', 'Start a chat in the right project from a message', 'Falls back to pasting a thread link'],
  },
  {
    id: 'ship', title: 'Ship', optional: true, blocking: false, skippable: true,
    why: 'Tells Loom which repos you ship from, so it can show staged work and run your ship command.',
    unlocks: ['Ship groups and the staged-work dialog', 'Optional labels: who contributed what to a ship'],
  },
  {
    id: 'orchestrator', title: 'Orchestrator', optional: true, blocking: false, skippable: true,
    why: 'A supervising chat that watches your other chats and reports back.',
    unlocks: ['One place that summarises all running chats', 'Starting and messaging chats on your behalf, if you allow it'],
  },
  {
    id: 'watchers', title: 'Watchers', optional: true, blocking: false, skippable: true,
    why: 'Reacts to Slack posts, chat behaviour or pull request events by starting a chat, messaging one, notifying you or telling the orchestrator.',
    unlocks: ['Auto-review of PR links and mentions', 'A heads-up when a chat is blocked, silent or nearly out of context', 'A nudge when checks go red or a PR is approved'],
  },
  {
    id: 'done', title: 'Done', optional: false, blocking: false, skippable: false,
    why: 'Here is what is on and off. Everything can be changed later in Settings.',
    unlocks: ['A short tour of the main window', 'Settings (the gear) for every choice above'],
  },
];

const META = new Map<StepId, StepMeta>(STEPS.map((s) => [s.id, s]));
export const stepMeta = (id: StepId): StepMeta => META.get(id)!;
export const isStepId = (v: unknown): v is StepId => typeof v === 'string' && (STEP_IDS as readonly string[]).includes(v);

/* ------------------------------------------------------------ state */

export interface StepEntry {
  status: StepStatus;
  at: number;
}

export interface WizardState {
  version: 1;
  current: StepId;
  steps: Record<StepId, StepEntry>;
}

export function freshState(): WizardState {
  const steps = {} as Record<StepId, StepEntry>;
  for (const id of STEP_IDS) steps[id] = { status: 'pending', at: 0 };
  return { version: 1, current: 'welcome', steps };
}

/**
 * Read the stored `setup_state` back. Anything unreadable falls back to a fresh
 * state, and unknown step ids or statuses are dropped, so a state written by a
 * newer or older build never wedges the wizard.
 */
export function parseState(raw: unknown): WizardState {
  const s = freshState();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return s;
  const o = raw as { current?: unknown; steps?: unknown };
  if (isStepId(o.current)) s.current = o.current;
  if (o.steps && typeof o.steps === 'object' && !Array.isArray(o.steps)) {
    for (const id of STEP_IDS) {
      const e = (o.steps as Record<string, unknown>)[id];
      if (!e || typeof e !== 'object') continue;
      const { status, at } = e as { status?: unknown; at?: unknown };
      if (status === 'done' || status === 'skipped' || status === 'pending') {
        s.steps[id] = { status, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
      }
    }
  }
  return s;
}

/* ------------------------------------------------------------ guards */

/** What the guards read. Always taken from live settings, never from the wizard's memory. */
export interface WizardCtx {
  slackMode: SlackModeValue;
}

/** A step a guard hides: the shortcut step needs Slack (§6.2). Every other step is always visible. */
export function isVisible(id: StepId, ctx: WizardCtx): boolean {
  if (id === 'shortcut') return ctx.slackMode !== 'off';
  return true;
}

export const visibleSteps = (ctx: WizardCtx): StepId[] => STEP_IDS.filter((id) => isVisible(id, ctx));

/** The first later step whose guard passes, or null after the last. */
export function nextVisible(from: StepId, ctx: WizardCtx): StepId | null {
  const i = STEP_IDS.indexOf(from);
  for (let j = i + 1; j < STEP_IDS.length; j++) if (isVisible(STEP_IDS[j]!, ctx)) return STEP_IDS[j]!;
  return null;
}

/** The previous visible step, or null before the first. */
export function prevVisible(from: StepId, ctx: WizardCtx): StepId | null {
  const i = STEP_IDS.indexOf(from);
  for (let j = i - 1; j >= 0; j--) if (isVisible(STEP_IDS[j]!, ctx)) return STEP_IDS[j]!;
  return null;
}

/** What the probe found. Only the blocking four matter to the wizard. */
export interface Requirements {
  tmux: boolean;
  claude: boolean;
  claudeLoggedIn: boolean;
  python3: boolean;
}

export const allRequirementsMet = (r: Requirements): boolean => r.tmux && r.claude && r.claudeLoggedIn && r.python3;

/** The unmet required checks, by name. */
export function missingRequirements(r: Requirements): string[] {
  const out: string[] = [];
  if (!r.tmux) out.push('tmux');
  if (!r.claude) out.push('Claude Code');
  else if (!r.claudeLoggedIn) out.push('a Claude Code login');
  if (!r.python3) out.push('python3');
  return out;
}

/** What a step's own Continue needs, supplied by the route from the request and the live probe. */
export interface StepCheck {
  requirements?: Requirements;
  /** permissions: the chats mode being saved and whether the box was ticked. */
  permChats?: 'normal' | 'skip';
  permWatchers?: 'normal' | 'skip';
  permOrchestrator?: 'normal' | 'skip';
  confirmSkip?: boolean;
}

/** null when the step may continue, else the reason it may not. Skip never calls this. */
export function validateContinue(id: StepId, check: StepCheck): string | null {
  if (id === 'requirements') {
    const r = check.requirements;
    if (!r) return 'The environment check has not run yet.';
    const miss = missingRequirements(r);
    return miss.length ? `Still needed: ${miss.join(', ')}.` : null;
  }
  if (id === 'permissions') {
    const wantsSkip = check.permChats === 'skip' || check.permWatchers === 'skip' || check.permOrchestrator === 'skip';
    if (wantsSkip && !check.confirmSkip) return 'Tick the box to confirm you want chats to run without asking.';
  }
  return null;
}

/* ------------------------------------------------------------ transitions */

export type Transition = { ok: true; state: WizardState } | { ok: false; error: string };

const clone = (s: WizardState): WizardState => ({ version: 1, current: s.current, steps: Object.fromEntries(STEP_IDS.map((id) => [id, { ...s.steps[id] }])) as Record<StepId, StepEntry> });

/**
 * Mark `id` with `status`, then move to the next visible step. Steps the guard
 * hides in between are marked skipped, with no writes, so the rail never shows
 * them as outstanding.
 */
function settle(state: WizardState, id: StepId, status: 'done' | 'skipped', ctx: WizardCtx, now: number): WizardState {
  const s = clone(state);
  s.steps[id] = { status, at: now };
  const next = nextVisible(id, ctx);
  const from = STEP_IDS.indexOf(id);
  const to = next ? STEP_IDS.indexOf(next) : STEP_IDS.length;
  for (let j = from + 1; j < to; j++) s.steps[STEP_IDS[j]!] = { status: 'skipped', at: now };
  s.current = next ?? id;
  return s;
}

/**
 * Continue(step): the step must be the current one and pass its checks. The
 * route has already persisted that step's own values by the time it calls this.
 * The Done step cannot be continued; finish() ends it.
 */
export function continueStep(state: WizardState, id: StepId, ctx: WizardCtx, check: StepCheck, now: number): Transition {
  if (id !== state.current) return { ok: false, error: 'That is not the current step.' };
  if (id === 'done') return { ok: false, error: 'Use finish on the last step.' };
  const why = validateContinue(id, check);
  if (why) return { ok: false, error: why };
  return { ok: true, state: settle(state, id, 'done', ctx, now) };
}

/** Skip(step): no writes. Refused for steps that cannot be skipped (welcome, requirements, done). */
export function skipStep(state: WizardState, id: StepId, ctx: WizardCtx, now: number): Transition {
  if (id !== state.current) return { ok: false, error: 'That is not the current step.' };
  if (!stepMeta(id).skippable) return { ok: false, error: `${stepMeta(id).title} cannot be skipped.` };
  return { ok: true, state: settle(state, id, 'skipped', ctx, now) };
}

/** Back: the previous visible step. Statuses are kept; the page keeps staged values in memory. */
export function back(state: WizardState, ctx: WizardCtx): Transition {
  const prev = prevVisible(state.current, ctx);
  if (!prev) return { ok: false, error: 'This is the first step.' };
  const s = clone(state);
  s.current = prev;
  return { ok: true, state: s };
}

/**
 * Jump to a step from the rail. Allowed to any step already settled (done or
 * skipped) and to the current one; never forward over pending steps, and never
 * past Requirements until it is done.
 */
export function goTo(state: WizardState, id: StepId, ctx: WizardCtx): Transition {
  if (!isVisible(id, ctx)) return { ok: false, error: 'That step is not available.' };
  if (id === state.current) return { ok: true, state: clone(state) };
  const here = STEP_IDS.indexOf(state.current);
  const there = STEP_IDS.indexOf(id);
  if (there > here && state.steps[id].status === 'pending') return { ok: false, error: 'Finish the steps before it first.' };
  if (there > STEP_IDS.indexOf('requirements') && state.steps.requirements.status !== 'done') return { ok: false, error: 'Requirements must pass first.' };
  const s = clone(state);
  s.current = id;
  return { ok: true, state: s };
}

/**
 * Close (x): nothing changes. The current step is already stored, so the next
 * launch reopens there, and no done marker is written.
 */
export function close(state: WizardState): WizardState {
  return clone(state);
}

/** Re-run (Settings › Help): back to Welcome with every step pending. The done marker is not touched here. */
export function rerun(): WizardState {
  return freshState();
}

/* ------------------------------------------------------------ the done marker (§6.3) */

export type SetupOrigin = '' | 'fresh' | 'migrated';

export interface Marker {
  completedAt: number;
  origin: SetupOrigin;
}

/** The page shows the wizard iff this is true: no marker, and not a migrated install. Same rule as migrate.ts setupDone. */
export function shouldShow(m: Marker): boolean {
  return !((Number.isFinite(m.completedAt) && m.completedAt > 0) || m.origin === 'migrated');
}

export type Finish = { ok: true; state: WizardState; marker: Marker } | { ok: false; error: string };

/**
 * Finish the Done step: it becomes done and the marker is written in the same
 * go (the route does both in one transaction). Requirements must have passed.
 * A migrated install keeps its origin and only updates the time (re-run).
 */
export function finish(state: WizardState, origin: SetupOrigin, now: number): Finish {
  if (state.current !== 'done') return { ok: false, error: 'Finish is only on the last step.' };
  if (state.steps.requirements.status !== 'done') return { ok: false, error: 'Requirements have not passed.' };
  const s = clone(state);
  s.steps.done = { status: 'done', at: now };
  return { ok: true, state: s, marker: { completedAt: now, origin: origin === 'migrated' ? 'migrated' : 'fresh' } };
}

/* ------------------------------------------------------------ view helpers */

export interface RailItem {
  id: StepId;
  title: string;
  optional: boolean;
  visible: boolean;
  status: StepStatus;
  current: boolean;
  /** The rail may link to it. */
  reachable: boolean;
}

export function rail(state: WizardState, ctx: WizardCtx): RailItem[] {
  return STEPS.map((m) => {
    const visible = isVisible(m.id, ctx);
    return {
      id: m.id,
      title: m.title,
      optional: m.optional,
      visible,
      status: state.steps[m.id].status,
      current: m.id === state.current,
      reachable: visible && goTo(state, m.id, ctx).ok,
    };
  });
}

/** "Step 3 of 11" counts only visible steps. */
export function progress(state: WizardState, ctx: WizardCtx): { index: number; total: number; percent: number } {
  const vis = visibleSteps(ctx);
  const at = vis.indexOf(state.current);
  const index = at < 0 ? 1 : at + 1;
  return { index, total: vis.length, percent: Math.round((index / vis.length) * 100) };
}

/* ------------------------------------------------------------ the Done summary */

export interface SummaryInput {
  projects: string[];
  terminal: string;
  permChats: 'normal' | 'skip';
  pluginInstalled: boolean;
  slackMode: SlackModeValue;
  slackConnected: boolean;
  slackTeam?: string;
  shortcut: string;
  shortcutReady: boolean | null; // null: not asked (no Slack)
  shipRepos: string[];
  orchestrator: boolean;
  watchers: number;
}

export interface SummaryRow {
  id: string;
  label: string;
  detail: string;
  on: boolean;
}

const TERMINAL_NAMES: Record<string, string> = { inside: 'Inside Loom', ghostty: 'Ghostty', iterm2: 'iTerm2', terminal: 'Terminal.app', '': 'Inside Loom' };

/** Step 12: what is on and what is off, one row each. */
export function buildSummary(i: SummaryInput): SummaryRow[] {
  const slack =
    i.slackMode === 'direct'
      ? { on: i.slackConnected, detail: i.slackConnected ? `Direct app, connected${i.slackTeam ? ' to ' + i.slackTeam : ''}` : 'Direct app, token not tested' }
      : i.slackMode === 'mcp'
        ? { on: true, detail: 'MCP only (reduced)' }
        : { on: false, detail: 'Off' };
  return [
    { id: 'projects', label: 'Projects', on: i.projects.length > 0, detail: i.projects.length ? `${i.projects.length} added: ${i.projects.slice(0, 4).join(', ')}${i.projects.length > 4 ? ', ...' : ''}` : 'None added. Loom uses the folders your chats started in.' },
    { id: 'terminal', label: 'Terminal', on: true, detail: TERMINAL_NAMES[i.terminal] ?? i.terminal },
    { id: 'permissions', label: 'Agent permissions', on: true, detail: i.permChats === 'skip' ? 'Skip permissions for chats' : 'Normal' },
    { id: 'plugin', label: 'Loom plugin', on: i.pluginInstalled, detail: i.pluginInstalled ? 'Hooks and skills installed' : 'Not installed. Jump falls back to a process scan.' },
    { id: 'slack', label: 'Slack', on: slack.on, detail: slack.detail },
    {
      id: 'shortcut',
      label: `Slack shortcut ${i.shortcut}`,
      on: i.shortcutReady === true,
      detail: i.shortcutReady === null ? 'Off (needs Slack)' : i.shortcutReady ? 'Ready' : 'Accessibility not granted',
    },
    { id: 'ship', label: 'Ship', on: i.shipRepos.length > 0, detail: i.shipRepos.length ? i.shipRepos.join(', ') : 'No repos on Ship' },
    { id: 'orchestrator', label: 'Orchestrator', on: i.orchestrator, detail: i.orchestrator ? 'On' : 'Off' },
    { id: 'watchers', label: 'Watchers', on: i.watchers > 0, detail: i.watchers ? `${i.watchers} template${i.watchers === 1 ? '' : 's'}, off or in Shadow until tested` : 'Off' },
  ];
}
