import { EventEmitter } from 'node:events';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { CLAUDE_HOME } from './paths.ts';

// The settings registry: every key Loom stores in the `settings(key, value)`
// table, with its type, where it shows in Settings, and two defaults:
//
//   defaultNew   what an unset key means on a new install (settings_schema >= 2)
//   legacyUnset  what an unset key means on a DB from before the registry
//                (settings_schema < 2): exactly what the code did before, so an
//                existing install behaves the same until its migration writes
//                its effective values out as rows
//
// Resolution: env override (when the key has one) > stored row > default.
// A stored row that does not parse or validate reads as unset, which is what
// every hand-written getter did before (parse-or-default).
//
// Encoding in the table: booleans 'on'/'off', numbers and strings as text,
// objects and lists as JSON. Secrets never live here.

export const SECTIONS = [
  'general',
  'projects',
  'terminal',
  'agents',
  'slack',
  'shortcut',
  'outbox',
  'ship',
  'orch',
  'watchers',
  'helpers',
  'advanced',
  'updates',
  'help',
] as const;
export type Section = (typeof SECTIONS)[number];

export type SettingType = 'enum' | 'bool' | 'int' | 'number' | 'string' | 'json' | 'list';
export type SettingSource = 'env' | 'stored' | 'default';
export type Check<T> = { ok: true; value: T } | { ok: false; detail: string };

export interface SettingDef<T = unknown> {
  key: string;
  type: SettingType;
  section: Section;
  label: string;
  help: string;
  defaultNew: T;
  legacyUnset: T;
  /** The running process reads it once; a change takes effect after a restart. */
  restart: boolean;
  /** Loom's own bookkeeping: shown by GET, never written by the settings PUT. */
  internal?: boolean;
  options?: readonly string[];
  /** The row name, when it predates the registry under another name. */
  storageKey?: string;
  /** The environment override, already parsed and validated; undefined = none. */
  env?: (env: NodeJS.ProcessEnv) => T | undefined;
  envName?: string;
  /**
   * Read a pre-registry row under an older name, used only while this key has no
   * row of its own. Returns undefined when that row is absent too.
   */
  legacy?: (raw: (key: string) => string | undefined) => T | undefined;
  /** Validate a value from the API (already JSON-typed) or a decoded row. */
  validate: (v: unknown) => Check<T>;
}

/* ------------------------------------------------------------ builders */

type Meta<T> = Omit<SettingDef<T>, 'type' | 'validate' | 'options'> & { validate?: (v: unknown) => Check<T> };

const ok = <T>(value: T): Check<T> => ({ ok: true, value });
const bad = <T>(detail: string): Check<T> => ({ ok: false, detail });

function enumDef<K extends string, O extends string>(options: readonly O[], m: Meta<O> & { key: K }): SettingDef<O> & { key: K } {
  return {
    ...m,
    type: 'enum',
    options,
    validate: (v) =>
      typeof v === 'string' && (options as readonly string[]).includes(v.trim())
        ? ok(v.trim() as O)
        : bad(`${m.key} must be one of ${options.join(', ')}`),
  };
}

function boolDef<K extends string>(m: Meta<boolean> & { key: K }): SettingDef<boolean> & { key: K } {
  return { ...m, type: 'bool', validate: (v) => (typeof v === 'boolean' ? ok(v) : bad(`${m.key} must be true or false`)) };
}

function intDef<K extends string>(min: number, max: number, m: Meta<number> & { key: K }): SettingDef<number> & { key: K } {
  return {
    ...m,
    type: 'int',
    validate: (v) =>
      typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? ok(v) : bad(`${m.key} must be a whole number from ${min} to ${max}`),
  };
}

function numDef<K extends string>(min: number, max: number, m: Meta<number> & { key: K }): SettingDef<number> & { key: K } {
  return {
    ...m,
    type: 'number',
    validate: (v) => (typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? ok(v) : bad(`${m.key} must be a number from ${min} to ${max}`)),
  };
}

function strDef<K extends string>(test: (s: string) => string | null, m: Meta<string> & { key: K }): SettingDef<string> & { key: K } {
  return {
    ...m,
    type: 'string',
    validate: (v) => {
      if (typeof v !== 'string') return bad(`${m.key} must be text`);
      const s = v.trim();
      const why = test(s);
      return why ? bad(`${m.key} ${why}`) : ok(s);
    },
  };
}

function jsonDef<K extends string, T>(test: (v: unknown) => Check<T>, m: Meta<T> & { key: K }): SettingDef<T> & { key: K } {
  return { ...m, type: 'json', validate: test };
}

function listDef<K extends string>(test: (s: string) => boolean, what: string, m: Meta<string[]> & { key: K }): SettingDef<string[]> & { key: K } {
  return {
    ...m,
    type: 'list',
    validate: (v) =>
      Array.isArray(v) && v.every((x) => typeof x === 'string' && test(x.trim()))
        ? ok((v as string[]).map((x) => x.trim()))
        : bad(`${m.key} must be a list of ${what}`),
  };
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const anyObject = (key: string) => (v: unknown): Check<Record<string, unknown>> => (isPlainObject(v) ? ok(v) : bad(`${key} must be an object`));

const absOrHome = (s: string) => path.isAbsolute(s) || s === '~' || s.startsWith('~/');
const optionalPath = (s: string) => (s === '' || absOrHome(s) ? null : 'must be empty (detect) or an absolute path');

/** A positive number from an env var, else undefined (the shape the old env readers used). */
const envPositive = (name: string) => (env: NodeJS.ProcessEnv) => {
  const n = Number(env[name]);
  return env[name]?.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
};
const envText = (name: string, test: (s: string) => boolean = (s) => !!s) => (env: NodeJS.ProcessEnv) => {
  const v = env[name]?.trim();
  return v !== undefined && test(v) ? v : undefined;
};

/* ------------------------------------------------------------ value tests */

export const SOCKET_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const SKILL_NAME = /^[A-Za-z0-9_.:-]{1,80}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const CHANNEL_ID = /^[A-Z0-9]+$/;
const ACCEL_MODIFIERS = new Set([
  'command', 'cmd', 'control', 'ctrl', 'commandorcontrol', 'cmdorctrl', 'alt', 'option', 'altgr', 'shift', 'super', 'meta',
]);
const ACCEL_KEY = /^([A-Za-z0-9]|F([1-9]|1[0-9]|2[0-4])|[`~!@#$%^&*()\-=_[\]{}\\|;:'",.<>/?]|Plus|Space|Tab|Backspace|Delete|Insert|Return|Enter|Up|Down|Left|Right|Home|End|PageUp|PageDown|Escape|Esc)$/;

/** An Electron accelerator: optional modifiers, then exactly one key, joined by '+'. */
export function isAccelerator(s: string): boolean {
  const parts = s.split('+').map((p) => p.trim());
  if (!parts.length || parts.some((p) => !p)) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  return mods.every((m) => ACCEL_MODIFIERS.has(m.toLowerCase())) && new Set(mods.map((m) => m.toLowerCase())).size === mods.length && ACCEL_KEY.test(key);
}

export const MAC_SOUNDS = ['Basso', 'Blow', 'Bottle', 'Frog', 'Funk', 'Glass', 'Hero', 'Morse', 'Ping', 'Pop', 'Purr', 'Sosumi', 'Submarine', 'Tink'] as const;

/** `{channel_id: project_dir}`; the same filter slackowner.getChannelProjects applies. */
function channelMap(v: unknown): Check<Record<string, string>> {
  if (!isPlainObject(v)) return bad('channel_projects must be an object of channel id -> project folder');
  const out: Record<string, string> = {};
  for (const [k, d] of Object.entries(v)) {
    if (!CHANNEL_ID.test(k) || typeof d !== 'string' || !d) return bad(`channel_projects: ${k} is not a channel id -> folder pair`);
    out[k] = d;
  }
  return ok(out);
}

/** Connected Gmail accounts: [{email, label, reconnect?}], no secrets. */
function googleAccounts(v: unknown): Check<{ email: string; label: string; reconnect?: string }[]> {
  if (!Array.isArray(v)) return bad('google_accounts must be a list');
  const out: { email: string; label: string; reconnect?: string }[] = [];
  for (const a of v) {
    if (!isPlainObject(a) || typeof a.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(a.email)) return bad('google_accounts: each entry needs an email');
    const label = typeof a.label === 'string' && a.label.trim() ? a.label.trim().slice(0, 64) : a.email;
    out.push({ email: a.email.toLowerCase(), label, ...(typeof a.reconnect === 'string' && a.reconnect ? { reconnect: a.reconnect } : {}) });
  }
  return ok(out);
}

/* ------------------------------------------------------------ the registry */

export const SETTINGS = [
  // ---- General / agents and models
  enumDef(['claude', 'codex', 'ask'] as const, {
    key: 'default_agent', section: 'general', label: 'Default agent', help: 'The agent New thread starts, or ask each time.',
    defaultNew: 'claude', legacyUnset: 'claude', restart: false,
  }),
  enumDef(['haiku', 'sonnet', 'opus', 'account'] as const, {
    key: 'summary_model', section: 'general', label: 'Summary model',
    help: 'The model that writes chat titles and summaries. "account" passes no model flag and uses your account default.',
    defaultNew: 'haiku', legacyUnset: 'account', restart: false,
  }),
  intDef(1, 100, {
    key: 'analyze_cap', section: 'general', label: 'Summaries per pass', help: 'How many chats one indexing pass summarizes at most.',
    defaultNew: 10, legacyUnset: 25, restart: false,
  }),
  intDef(1, 6, {
    key: 'analyze_concurrency', section: 'general', label: 'Summaries at once', help: 'How many summary calls run at the same time.',
    defaultNew: 2, legacyUnset: 3, restart: false,
  }),
  intDef(1, 60, {
    key: 'active_window_days', section: 'general', label: 'Days shown', help: 'Chats active within this many days are indexed and listed.',
    defaultNew: 7, legacyUnset: 7, restart: false,
  }),
  strDef((s) => (s === 'last' || s === 'home' || absOrHome(s) ? null : 'must be last, home or an absolute path'), {
    key: 'new_thread_dir', section: 'general', label: 'New thread folder',
    help: 'Where New thread starts: the last folder used, your home folder, or a fixed path.',
    defaultNew: 'last', legacyUnset: 'last', restart: false,
  }),
  enumDef(['off', 'system', ...MAC_SOUNDS] as const, {
    key: 'notify_sound', section: 'general', label: 'Notification sound', help: 'The sound on a Loom notification.',
    defaultNew: 'system', legacyUnset: 'Hero', restart: false,
  }),
  strDef(optionalPath, {
    key: 'claude_bin', section: 'general', label: 'Claude binary', help: 'Path to claude. Empty detects it.',
    defaultNew: '', legacyUnset: '', restart: false,
  }),
  listDef(absOrHome, 'absolute paths', {
    key: 'extra_path', section: 'general', label: 'Extra PATH entries',
    help: 'Folders searched for tools, ahead of the built-in ones and your login-shell PATH.',
    defaultNew: [], legacyUnset: [], restart: false,
  }),
  // Before the registry the Codex option was always offered.
  enumDef(['auto', 'on', 'off'] as const, {
    key: 'codex_visible', section: 'general', label: 'Show Codex', help: 'auto shows Codex only when ~/.codex exists.',
    defaultNew: 'auto', legacyUnset: 'on', restart: false,
  }),

  // ---- Terminal
  // Unset on an old DB is '' (auto): Ghostty when a lane workspace exists, else
  // inside Loom; resolveTerminal in terminal.ts does that.
  enumDef(['inside', 'ghostty', 'iterm2', 'terminal'] as const, {
    key: 'terminal', section: 'terminal', label: 'Terminal', help: 'Where jumping to a chat lands.',
    defaultNew: 'inside', legacyUnset: '' as 'inside', restart: false,
  }),
  // Unset on an old DB is '' (auto): lanes when lane sessions exist, else managed.
  enumDef(['managed', 'lanes'] as const, {
    key: 'launch_target', section: 'terminal', label: 'Launch target',
    help: 'Where New thread, Resume and Slack starts put a chat: a Loom-managed window, or your lane sessions.',
    defaultNew: 'managed', legacyUnset: '' as 'managed', restart: false,
  }),
  enumDef(['zoom', 'mirror'] as const, {
    key: 'lane_view', section: 'terminal', label: 'Shared-window panes',
    help: 'zoom attaches and zooms a pane that shares its window; mirror streams it without touching the window.',
    defaultNew: 'zoom', legacyUnset: 'zoom', restart: false,
  }),
  boolDef({
    key: 'auto_update', section: 'updates', label: 'Update automatically',
    help: 'Download and verify new releases from GitHub in the background, and install one on restart or the next quit.',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  boolDef({
    key: 'ghostty_rehome', section: 'terminal', label: 'Reuse Ghostty tabs', help: 'Restore re-homes sessions into their existing Ghostty tabs.',
    defaultNew: false, legacyUnset: true, restart: false,
  }),
  strDef((s) => (s ? null : 'must not be empty'), {
    key: 'ghostty_attach_cmd', section: 'terminal', label: 'Ghostty attach command', help: 'The command a Ghostty tab runs, followed by the session name.',
    defaultNew: 'tmux attach -t', legacyUnset: 'tmux attach -t', restart: false,
  }),
  boolDef({
    key: 'pane_labels', section: 'terminal', label: 'Pane topics', help: 'Label each pane border with a short topic written by a small model.',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  enumDef(['haiku', 'sonnet'] as const, {
    key: 'pane_label_model', section: 'terminal', label: 'Pane topic model', help: 'The model that writes pane topics.',
    defaultNew: 'haiku', legacyUnset: 'haiku', restart: false,
  }),
  boolDef({
    key: 'pane_tint', section: 'terminal', label: 'Pane tint', help: 'Tint idle panes warmer the longer they wait.',
    defaultNew: false, legacyUnset: true, restart: false,
  }),
  strDef((s) => (HEX_COLOR.test(s) ? null : 'must be a #rrggbb color'), {
    key: 'pane_tint_base', section: 'terminal', label: 'Tint base color', help: 'The pane background the tint starts from.',
    defaultNew: '#1e1e2e', legacyUnset: '#1e1e2e', restart: false,
  }),

  // ---- Agents and permissions
  enumDef(['normal', 'skip'] as const, {
    key: 'perm_chats', section: 'agents', label: 'Chats permission mode', help: 'skip starts chats with --dangerously-skip-permissions.',
    defaultNew: 'normal', legacyUnset: 'skip', restart: false,
  }),
  enumDef(['normal', 'skip'] as const, {
    key: 'perm_watchers', section: 'agents', label: 'Watcher workers permission mode', help: 'skip starts watcher workers with --dangerously-skip-permissions.',
    defaultNew: 'normal', legacyUnset: 'skip', restart: false,
  }),
  enumDef(['normal', 'skip'] as const, {
    key: 'perm_orchestrator', section: 'agents', label: 'Orchestrator permission mode', help: 'skip starts the orchestrator with --dangerously-skip-permissions.',
    defaultNew: 'normal', legacyUnset: 'skip', restart: false,
  }),
  boolDef({
    key: 'rc_watchers', section: 'agents', label: 'Remote Control for watcher workers', help: 'Start watcher workers with --remote-control.',
    defaultNew: false, legacyUnset: true, restart: false,
  }),
  // An existing install's values are read from its own watcher briefs by the
  // migration (src/migrations/settings.ts), so the legacy defaults are generic.
  strDef((s) => (s === 'none' || SKILL_NAME.test(s) ? null : 'must be a skill name or none'), {
    key: 'review_skill', section: 'agents', label: 'Review skill', help: 'The skill PR watchers load to review.',
    defaultNew: 'loom:review', legacyUnset: 'loom:review', restart: false,
  }),
  strDef((s) => (s === '' || SKILL_NAME.test(s) ? null : 'must be a skill name or empty'), {
    key: 'voice_skill', section: 'agents', label: 'Writing voice skill', help: 'A skill loaded before drafting text that goes out under your name.',
    defaultNew: '', legacyUnset: '', restart: false,
  }),

  // ---- Slack
  // Before the registry Slack ran whenever its CLI was present, which is direct.
  enumDef(['direct', 'mcp', 'off'] as const, {
    key: 'slack_mode', section: 'slack', label: 'Slack connection', help: 'Direct app, MCP only, or off.',
    defaultNew: 'off', legacyUnset: 'direct', restart: false,
  }),
  jsonDef(anyObject('slack_identity'), {
    key: 'slack_identity', section: 'slack', label: 'Slack identity', help: 'Workspace and user from the last connection test.',
    defaultNew: {}, legacyUnset: {}, restart: false, internal: true,
  }),
  listDef((s) => /^[a-z0-9:._-]+$/.test(s), 'scope names', {
    key: 'slack_scopes_granted', section: 'slack', label: 'Granted scopes', help: 'Scopes the token was granted, from the last connection test.',
    defaultNew: [], legacyUnset: [], restart: false, internal: true,
  }),
  // The shared Slack app's client id for Connect Slack (OAuth with PKCE). Public,
  // not a secret: a PKCE app has no client secret at all.
  strDef((s) => (s === '' || /^[0-9]+\.[0-9]+$/.test(s) ? null : 'must look like 1234567890.1234567890'), {
    key: 'slack_client_id', section: 'slack', label: 'Shared Slack app client id', help: 'From the shared Slack app (Basic Information, Client ID). Turns on Connect Slack.',
    defaultNew: '', legacyUnset: '', restart: false, envName: 'LOOM_SLACK_CLIENT_ID',
    env: (env) => env.LOOM_SLACK_CLIENT_ID?.trim() || undefined,
  }),
  strDef(() => null, {
    key: 'slack_reconnect', section: 'slack', label: 'Slack needs reconnecting', help: 'Why the Connect Slack token stopped working (a refused refresh). Empty when it works.',
    defaultNew: '', legacyUnset: '', restart: false, internal: true,
  }),
  boolDef({
    key: 'slack_poll_parked', section: 'slack', label: 'Watch parked threads', help: 'Poll parked chats’ Slack threads for replies (direct mode only).',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  jsonDef(channelMap, {
    key: 'channel_projects', storageKey: 'slack_channel_projects', section: 'slack', label: 'Channel folders',
    help: 'Which project folder a chat started from a channel opens in.',
    defaultNew: {}, legacyUnset: {}, restart: false,
  }),
  strDef((s) => (s === 'off' || isAccelerator(s) ? null : 'must be a shortcut like Command+Shift+L, or off'), {
    key: 'slack_goto_hotkey', section: 'shortcut', label: 'Open-chat shortcut', help: 'The global shortcut that opens the chat for the Slack message under the pointer.',
    defaultNew: 'Command+Shift+L', legacyUnset: 'Command+Shift+L', restart: true,
  }),
  boolDef({
    key: 'slack_paste_fallback', section: 'shortcut', label: 'Clipboard fallback', help: 'When the message cannot be read directly, copy its link and read that.',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  boolDef({
    key: 'slack_goto_confirm_new', section: 'shortcut', label: 'Ask before a new chat', help: 'When no chat owns the picked thread, ask for optional context before starting one.',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  jsonDef(anyObject('slack_ax_last_result'), {
    key: 'slack_ax_last_result', section: 'shortcut', label: 'Last shortcut result', help: 'Diagnostics from the last shortcut press.',
    defaultNew: {}, legacyUnset: {}, restart: false, internal: true,
  }),

  // ---- Outbox
  enumDef(['send', 'park', 'close'] as const, {
    key: 'outbox_primary', section: 'outbox', label: 'Primary action', help: 'The main button on a draft.',
    defaultNew: 'send', legacyUnset: 'send', restart: false,
  }),
  boolDef({
    key: 'outbox_confirm', section: 'outbox', label: 'Confirm before sending', help: 'Ask before a draft is posted.',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  boolDef({
    key: 'auto_resume_parked', section: 'outbox', label: 'Reopen parked chats', help: 'Reopen a parked chat by itself when its thread gets a reply.',
    defaultNew: false, legacyUnset: false, restart: false,
  }),
  boolDef({
    key: 'outbox_slack_drafts', section: 'outbox', label: 'Mirror drafts into Slack', help: 'Also save drafts as Slack drafts (unofficial API).',
    defaultNew: false, legacyUnset: false, restart: false,
  }),
  boolDef({
    key: 'outbox_chat_drafts', section: 'outbox', label: 'Chats may add drafts', help: 'Chats can put drafts in the Outbox (needs the plugin and Slack direct).',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  // Empty = the Gmail CLI at ~/.claude/tools/gmail/gmail.mjs when it exists; otherwise email drafts cannot send.
  strDef(optionalPath, {
    key: 'email_cli', section: 'outbox', label: 'Email CLI',
    help: 'A Gmail-CLI-compatible script (send, thread, send-as) that sends email drafts as you. Empty uses ~/.claude/tools/gmail/gmail.mjs when it exists.',
    defaultNew: '', legacyUnset: '', restart: false,
  }),
  enumDef(['auto', 'gmail', 'cli'] as const, {
    key: 'email_via', section: 'outbox', label: 'Send email through',
    help: 'Automatic uses a connected Gmail account when there is one, else the Email CLI.',
    defaultNew: 'auto', legacyUnset: 'auto', restart: false,
  }),
  // Connect Gmail: the person's own Google "Desktop app" OAuth client. Google documents
  // that an installed app's secret cannot be kept confidential, so both live here.
  strDef((s) => (s === '' || /^[0-9A-Za-z-]+\.apps\.googleusercontent\.com$/.test(s) ? null : 'must end in .apps.googleusercontent.com'), {
    key: 'google_client_id', section: 'outbox', label: 'Google client id', help: 'The OAuth client id of a Desktop app client in Google Cloud. Turns on Connect Gmail.',
    defaultNew: '', legacyUnset: '', restart: false, envName: 'LOOM_GOOGLE_CLIENT_ID',
    env: (env) => env.LOOM_GOOGLE_CLIENT_ID?.trim() || undefined,
  }),
  strDef((s) => (/^[A-Za-z0-9_-]{0,100}$/.test(s) ? null : 'must be the client secret Google shows (letters, digits, - _)'), {
    key: 'google_client_secret', section: 'outbox', label: 'Google client secret', help: 'Shown next to the client id. Not confidential for a Desktop app client.',
    defaultNew: '', legacyUnset: '', restart: false, envName: 'LOOM_GOOGLE_CLIENT_SECRET',
    env: (env) => env.LOOM_GOOGLE_CLIENT_SECRET?.trim() || undefined,
  }),
  jsonDef(googleAccounts, {
    key: 'google_accounts', section: 'outbox', label: 'Connected Gmail accounts', help: 'Email addresses and draft labels. The refresh tokens are in the Keychain.',
    defaultNew: [], legacyUnset: [], restart: false, internal: true,
  }),
  intDef(1, 365, {
    key: 'outbox_keep_days', section: 'outbox', label: 'Keep sent drafts (days)', help: 'How long sent and dismissed drafts stay listed.',
    defaultNew: 14, legacyUnset: 14, restart: false,
  }),

  // ---- Ship
  // On for migrated installs too (legacyUnset true): it was asked for as the default.
  boolDef({
    key: 'trees_prune_after_ship', section: 'ship', label: 'Prune merged worktrees after a ship',
    help: 'When a ship lands, remove that repo’s worktrees that are merged, clean and not in use. Never forced.',
    defaultNew: true, legacyUnset: true, restart: false,
  }),

  // ---- Orchestrator
  // Before the registry the orchestrator ran unless the row read '0'.
  enumDef(['0', '1'] as const, {
    key: 'orchestrator_enabled', section: 'orch', label: 'Orchestrator', help: 'Run the orchestrator chat.',
    defaultNew: '0', legacyUnset: '1', restart: false, envName: 'LOOM_ORCHESTRATOR',
    env: (env) => (env.LOOM_ORCHESTRATOR === '0' || env.LOOM_ORCHESTRATOR === '1' ? env.LOOM_ORCHESTRATOR : undefined),
  }),
  boolDef({
    key: 'orchestrator_autostart', section: 'orch', label: 'Start with Loom', help: 'Start the orchestrator when Loom starts (when it is on).',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  enumDef(['needs_you', 'all', 'off'] as const, {
    key: 'orchestrator_notify', section: 'orch', label: 'Orchestrator notifications', help: 'Which orchestrator items notify you.',
    defaultNew: 'needs_you', legacyUnset: 'needs_you', restart: false,
  }),
  boolDef({
    key: 'orchestrator_trust', section: 'orch', label: 'Trust the orchestrator folder',
    help: 'Consent to add the orchestrator folder to Claude’s trusted folders in ~/.claude.json.',
    defaultNew: false, legacyUnset: true, restart: false,
  }),
  strDef(() => null, {
    key: 'orchestrator_session_id', section: 'orch', label: 'Orchestrator session', help: 'The orchestrator chat’s session id.',
    defaultNew: '', legacyUnset: '', restart: false, internal: true,
  }),
  strDef(() => null, {
    key: 'orchestrator_pane_id', section: 'orch', label: 'Orchestrator pane', help: 'The orchestrator chat’s tmux pane.',
    defaultNew: '', legacyUnset: '', restart: false, internal: true,
  }),

  // ---- Watchers
  // Replaces `slack_watchers`: before the registry watchers ran unless that row read 'off'.
  boolDef({
    key: 'watchers_enabled', section: 'watchers', label: 'Watchers', help: 'Run watchers at all.',
    defaultNew: false, legacyUnset: true, restart: false, envName: 'LOOM_WATCHERS_OFF',
    env: (env) => (env.LOOM_WATCHERS_OFF === '1' ? false : undefined),
    legacy: (raw) => {
      const v = raw('slack_watchers');
      return v === undefined ? undefined : v.trim().toLowerCase() !== 'off';
    },
  }),
  // 0 = never prune (what happened before the registry).
  intDef(0, 365, {
    key: 'watcher_brief_prune_days', section: 'watchers', label: 'Keep watcher briefs (days)', help: 'Delete watcher brief files older than this. 0 keeps them.',
    defaultNew: 14, legacyUnset: 0, restart: false,
  }),
  boolDef({
    key: 'watchers_ignore_self', section: 'watchers', label: 'Ignore my own messages', help: 'Watchers skip messages you posted.',
    defaultNew: true, legacyUnset: true, restart: false,
  }),
  // An existing install's lane is read from where its watcher workers started (the migration).
  strDef((s) => (s === 'managed' || /^lane:[A-Za-z0-9_-]{1,32}$/.test(s) ? null : 'must be managed or lane:<name>'), {
    key: 'watcher_default_target', section: 'watchers', label: 'Where watcher chats start', help: 'A Loom-managed window, or a lane.',
    defaultNew: 'managed', legacyUnset: 'managed', restart: false,
  }),

  // ---- Helpers (plugin)
  jsonDef(anyObject('plugin_state'), {
    key: 'plugin_state', section: 'helpers', label: 'Plugin state', help: 'What the plugin manager installed.',
    defaultNew: {}, legacyUnset: {}, restart: false, internal: true,
  }),
  boolDef({
    key: 'codex_hook', section: 'helpers', label: 'Codex placement hook', help: 'Consent to add Loom’s placement hook to ~/.codex/hooks.json.',
    defaultNew: false, legacyUnset: true, restart: false,
  }),

  // ---- Advanced
  strDef((s) => (SOCKET_NAME.test(s) ? null : 'must be a short name (letters, digits, . _ -)'), {
    key: 'tmux_socket', section: 'advanced', label: 'tmux server', help: '"default" is your own tmux server; any other name is a separate one.',
    defaultNew: 'loom', legacyUnset: 'default', restart: true, envName: 'LOOM_TMUX_SOCKET',
    env: envText('LOOM_TMUX_SOCKET', (s) => SOCKET_NAME.test(s)),
  }),
  // An empty prefix (env only) means every session counts.
  strDef((s) => (/^[A-Za-z0-9_.-]{0,32}$/.test(s) ? null : 'must be letters, digits, . _ - (up to 32)'), {
    key: 'session_prefix', section: 'advanced', label: 'Session prefix', help: 'Only tmux sessions starting with this are saved and restored.',
    defaultNew: 'loom-', legacyUnset: 'loom-', restart: true, envName: 'LOOM_SESSION_PREFIX',
    env: (env) => env.LOOM_SESSION_PREFIX?.trim(),
  }),
  strDef((s) => (s === 'auto' || absOrHome(s) ? null : 'must be auto or an absolute path'), {
    key: 'tmux_tmpdir', section: 'advanced', label: 'tmux socket folder', help: 'Where tmux keeps its socket. auto asks your login shell.',
    defaultNew: 'auto', legacyUnset: '/tmp', restart: true, envName: 'TMUX_TMPDIR',
    env: envText('TMUX_TMPDIR'),
  }),
  intDef(1, 1440, {
    key: 'reap_idle_min', section: 'advanced', label: 'Close finished windows after (min)', help: 'A managed window whose agent exited closes after this long.',
    defaultNew: 10, legacyUnset: 10, restart: false,
  }),
  // 0 = the built-in rule (2% of memory, at least 300 MB).
  intDef(0, 1_000_000, {
    key: 'min_free_mb', section: 'advanced', label: 'Minimum free memory (MB)', help: 'Hold new chats below this much free memory. 0 uses the built-in rule.',
    defaultNew: 0, legacyUnset: 0, restart: false, envName: 'LOOM_MIN_FREE_MB', env: envPositive('LOOM_MIN_FREE_MB'),
  }),
  numDef(0.1, 64, {
    key: 'max_load_per_cpu', section: 'advanced', label: 'Maximum load per CPU', help: 'Hold new chats above this load average per core.',
    defaultNew: 2, legacyUnset: 2, restart: false, envName: 'LOOM_MAX_LOAD_PER_CPU', env: envPositive('LOOM_MAX_LOAD_PER_CPU'),
  }),
  intDef(1024, 65535, {
    key: 'port', section: 'advanced', label: 'Port', help: 'The local port Loom serves on.',
    defaultNew: 4317, legacyUnset: 4317, restart: true, envName: 'LOOM_PORT',
    env: (env) => {
      const n = Number(env.LOOM_PORT);
      return env.LOOM_PORT?.trim() && Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
    },
  }),
  // The legacy value is the path paths.ts hardcoded before this was a setting.
  strDef(optionalPath, {
    key: 'find_chat_bin', section: 'advanced', label: 'find-chat binary', help: 'Archive search beyond the days shown. Empty detects it.',
    defaultNew: '', legacyUnset: path.join(CLAUDE_HOME, 'tools', 'find-chat', 'bin', 'find-chat'), restart: false,
    envName: 'FIND_CHAT_BIN', env: envText('FIND_CHAT_BIN'),
  }),
  strDef(() => null, {
    key: 'last_project_dir', section: 'general', label: 'Last project folder', help: 'The folder New thread used last.',
    defaultNew: '', legacyUnset: '', restart: false, internal: true,
  }),

  // ---- Setup / help (internal)
  intDef(0, 1000, {
    key: 'settings_schema', section: 'help', label: 'Settings schema', help: '2 once the install is on the registry.',
    defaultNew: 1, legacyUnset: 1, restart: false, internal: true,
  }),
  jsonDef(anyObject('setup_state'), {
    key: 'setup_state', section: 'help', label: 'Setup progress', help: 'Where the setup wizard is.',
    defaultNew: {}, legacyUnset: {}, restart: false, internal: true,
  }),
  intDef(0, Number.MAX_SAFE_INTEGER, {
    key: 'setup_completed_at', section: 'help', label: 'Setup completed', help: 'When setup finished (epoch ms); 0 = not yet.',
    defaultNew: 0, legacyUnset: 0, restart: false, internal: true,
  }),
  enumDef(['', 'fresh', 'migrated'] as const, {
    key: 'setup_origin', section: 'help', label: 'Install origin', help: 'fresh, or migrated from an earlier install.',
    defaultNew: '', legacyUnset: '', restart: false, internal: true,
  }),
  intDef(0, Number.MAX_SAFE_INTEGER, {
    key: 'tour_completed_at', section: 'help', label: 'Tour completed', help: 'When the tour was finished (epoch ms).',
    defaultNew: 0, legacyUnset: 0, restart: false, internal: true,
  }),
  intDef(0, Number.MAX_SAFE_INTEGER, {
    key: 'tour_skipped_at', section: 'help', label: 'Tour skipped', help: 'When the tour was skipped (epoch ms).',
    defaultNew: 0, legacyUnset: 0, restart: false, internal: true,
  }),
] as const;

/* ------------------------------------------------------------ typing */

type Defs = (typeof SETTINGS)[number];
export type SettingKey = Defs['key'];
type DefFor<K extends SettingKey> = Extract<Defs, { key: K }>;
export type SettingValue<K extends SettingKey> = DefFor<K> extends SettingDef<infer T> ? T : never;

const BY_KEY = new Map<string, SettingDef>(SETTINGS.map((d) => [d.key, d as SettingDef]));
export const SETTING_KEYS = SETTINGS.map((d) => d.key) as SettingKey[];
export const isSettingKey = (k: unknown): k is SettingKey => typeof k === 'string' && BY_KEY.has(k);
export function settingDef(key: SettingKey): SettingDef {
  return BY_KEY.get(key)!;
}

/* ------------------------------------------------------------ storage */

const rowKey = (d: SettingDef) => d.storageKey ?? d.key;

function readRaw(db: Database.Database, key: string): string | undefined {
  return (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value;
}

/** A stored row back into a value, or undefined when it does not parse or validate. */
export function decodeRow(d: SettingDef, raw: string): unknown {
  const s = raw.trim();
  let v: unknown;
  switch (d.type) {
    case 'bool': {
      const l = s.toLowerCase();
      if (l === 'on' || l === '1' || l === 'true') v = true;
      else if (l === 'off' || l === '0' || l === 'false') v = false;
      else return undefined;
      break;
    }
    case 'int':
    case 'number':
      if (!s) return undefined;
      v = Number(s);
      break;
    case 'json':
    case 'list':
      try {
        v = JSON.parse(s || 'null');
      } catch {
        return undefined;
      }
      break;
    default:
      v = s;
  }
  const r = d.validate(v);
  return r.ok ? r.value : undefined;
}

export function encodeValue(d: SettingDef, v: unknown): string {
  if (d.type === 'bool') return v ? 'on' : 'off';
  if (d.type === 'json' || d.type === 'list') return JSON.stringify(v);
  return String(v);
}

/** The schema the stored rows follow: below 2 means "unmigrated", so unset keys read as legacyUnset. */
export function schemaVersion(db: Database.Database): number {
  const n = Number(readRaw(db, 'settings_schema')?.trim());
  return Number.isInteger(n) && n > 0 ? n : 1;
}

export interface Resolved<T = unknown> {
  value: T;
  source: SettingSource;
}

export interface ResolveOpts {
  /** The environment to consult; `false` ignores overrides (the stored-or-default value). */
  env?: NodeJS.ProcessEnv | false;
}

export function resolveSetting<K extends SettingKey>(db: Database.Database, key: K, opts: ResolveOpts = {}): Resolved<SettingValue<K>> {
  const d = BY_KEY.get(key);
  if (!d) throw new Error(`unknown setting ${key}`);
  const env = opts.env === undefined ? process.env : opts.env;
  if (env && d.env) {
    const v = d.env(env);
    if (v !== undefined) return { value: v as SettingValue<K>, source: 'env' };
  }
  const raw = readRaw(db, rowKey(d));
  if (raw !== undefined) {
    const v = decodeRow(d, raw);
    if (v !== undefined) return { value: v as SettingValue<K>, source: 'stored' };
  }
  const legacy = schemaVersion(db) < 2;
  if (legacy && raw === undefined && d.legacy) {
    const v = d.legacy((k) => readRaw(db, k));
    if (v !== undefined) return { value: v as SettingValue<K>, source: 'stored' };
  }
  return { value: (legacy ? d.legacyUnset : d.defaultNew) as SettingValue<K>, source: 'default' };
}

/** The effective value: env override > stored row > default. */
export function getSetting<K extends SettingKey>(db: Database.Database, key: K, opts: ResolveOpts = {}): SettingValue<K> {
  return resolveSetting(db, key, opts).value;
}

/* ------------------------------------------------------------ change events */

export interface SettingChange {
  key: SettingKey;
  value: unknown;
  previous: unknown;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(50);

/** Called after a setting is written through setSetting / applySettingsPatch. Returns an unsubscribe. */
export function onSettingChanged(fn: (c: SettingChange) => void): () => void {
  const wrapped = (c: SettingChange) => {
    try {
      fn(c);
    } catch {
      /* a listener's failure never fails the write */
    }
  };
  emitter.on('change', wrapped);
  return () => emitter.off('change', wrapped);
}

function writeSetting(db: Database.Database, d: SettingDef, value: unknown): { ok: true; change: SettingChange | null; value: unknown } | { ok: false; detail: string } {
  const r = d.validate(value);
  if (!r.ok) return r;
  const key = d.key as SettingKey;
  const previous = getSetting(db, key, { env: false });
  db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(rowKey(d), encodeValue(d, r.value));
  const changed = JSON.stringify(previous) !== JSON.stringify(r.value);
  return { ok: true, change: changed ? { key, value: r.value, previous } : null, value: r.value };
}

/**
 * Validate and store one value. Returns whether the stored-or-default value
 * changed, and emits onSettingChanged when it did. Internal keys are allowed
 * here (Loom's own code writes them); the HTTP PUT refuses them.
 */
export function setSetting<K extends SettingKey>(
  db: Database.Database,
  key: K,
  value: unknown,
): { ok: true; changed: boolean; value: SettingValue<K> } | { ok: false; detail: string } {
  const d = BY_KEY.get(key);
  if (!d) return { ok: false, detail: `unknown setting ${key}` };
  const r = writeSetting(db, d, value);
  if (!r.ok) return r;
  if (r.change) emitter.emit('change', r.change);
  return { ok: true, changed: !!r.change, value: r.value as SettingValue<K> };
}

/* ------------------------------------------------------------ the API view */

export interface SettingView {
  value: unknown;
  source: SettingSource;
  restart: boolean;
  type: SettingType;
  section: Section;
  label: string;
  help: string;
  default: unknown;
  options?: readonly string[];
  env?: string;
  internal?: boolean;
}

/** Every key with its effective value and where it came from. Never contains a secret. */
export function settingsRegistryView(db: Database.Database, env: NodeJS.ProcessEnv = process.env): Record<SettingKey, SettingView> {
  const legacy = schemaVersion(db) < 2;
  const out = {} as Record<SettingKey, SettingView>;
  for (const def of SETTINGS) {
    const d = def as SettingDef;
    const r = resolveSetting(db, d.key as SettingKey, { env });
    out[d.key as SettingKey] = {
      value: r.value,
      source: r.source,
      restart: d.restart,
      type: d.type,
      section: d.section,
      label: d.label,
      help: d.help,
      default: legacy ? d.legacyUnset : d.defaultNew,
      ...(d.options ? { options: d.options } : {}),
      ...(d.envName ? { env: d.envName } : {}),
      ...(d.internal ? { internal: true } : {}),
    };
  }
  return out;
}

/** Old body keys the page still sends, mapped to their registry key. */
export const LEGACY_ALIASES: Record<string, SettingKey> = { slack_watchers: 'watchers_enabled' };

/**
 * Apply a partial update from the API: `{key: value, ...}`. Every key is checked
 * before anything is written, so an unknown key, an internal key or a malformed
 * value rejects the whole call and stores nothing. `restart` is true when a
 * changed key only takes effect after a restart.
 */
export function applySettingsPatch(
  db: Database.Database,
  body: unknown,
): { ok: true; restart: boolean; changed: SettingKey[] } | { ok: false; detail: string } {
  if (!isPlainObject(body)) return { ok: false, detail: 'body must be an object of setting -> value' };
  const entries: [SettingKey, unknown][] = [];
  for (const [k0, v] of Object.entries(body)) {
    const k = LEGACY_ALIASES[k0] ?? k0;
    if (!isSettingKey(k)) return { ok: false, detail: `unknown setting ${k0}` };
    const d = BY_KEY.get(k)!;
    if (d.internal) return { ok: false, detail: `${k0} is not a setting you can change` };
    const r = d.validate(v);
    if (!r.ok) return r;
    entries.push([k, r.value]);
  }
  const changes: SettingChange[] = [];
  db.transaction(() => {
    for (const [k, v] of entries) {
      const r = writeSetting(db, BY_KEY.get(k)!, v);
      if (r.ok && r.change) changes.push(r.change);
    }
  })();
  // Listeners hear about a change only once it is committed.
  for (const c of changes) emitter.emit('change', c);
  return { ok: true, restart: changes.some((c) => BY_KEY.get(c.key)!.restart), changed: changes.map((c) => c.key) };
}
