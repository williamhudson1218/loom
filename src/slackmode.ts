import type Database from 'better-sqlite3';
import { openDb } from './db.ts';
import { getSetting } from './settingsSchema.ts';
import { slackToken } from './slackapi.ts';

// Slack modes and the feature gates (§5.2, §5.4). Every Slack tick asks
// slackFeatureOn() before it does anything, so MCP-only and Off installs make
// no Web API call at all.
//
//   direct  a user token resolves (env, Keychain or the migrated legacy file)
//           and slack_mode is 'direct'
//   mcp     slack_mode is 'mcp': chats post through the user's own Slack
//           connector, and Loom has no token
//   off     everything else, including 'direct' with no token (nothing to call with)

export type SlackMode = 'direct' | 'mcp' | 'off';

/**
 * The features that need the Web API (the exact §5.4 list, in order) plus the
 * three that still work without it.
 */
export const SLACK_FEATURES = [
  // Direct only
  'watchers', // 1  Slack-source watchers (channel polling)
  'parked', //   2  parked-thread reply detection, "reply received", Send & park
  'send', //     3  Outbox Send, Send & park, Send & close
  'names', //    4  channel #names, people names and custom emoji in the sidebar, previews, Outbox
  'previews', // 5  thread previews, root text, unread/replied counts
  'reconcile', //6  sent-draft reconcile against Slack
  'react', //    7  `loom thread stage --react` / `--ack`
  // Support the above
  'labels', //   channel label cache (conversations.info/list)
  'directory', //users.list and emoji.list refresh
  // Direct or MCP only
  'goto', //     the hotkey: jump to the owning chat, or start one
  'ownership', //thread ownership
  'outboxDrafts', // drafts visible in the Outbox
] as const;
export type SlackFeature = (typeof SLACK_FEATURES)[number];

const DIRECT_ONLY: readonly SlackFeature[] = ['watchers', 'parked', 'send', 'names', 'previews', 'reconcile', 'react', 'labels', 'directory'];

/** The mode in effect, from the setting and whether a token resolves. Pure. */
export function effectiveMode(setting: SlackMode, hasToken: boolean): SlackMode {
  if (setting === 'direct') return hasToken ? 'direct' : 'off';
  return setting;
}

/** Whether a feature runs in a mode. `pollParked` is the slack_poll_parked setting. Pure. */
export function featureOn(feature: SlackFeature, mode: SlackMode, pollParked = true): boolean {
  if (mode === 'off') return false;
  if (DIRECT_ONLY.includes(feature)) {
    if (mode !== 'direct') return false;
    return feature === 'parked' ? pollParked : true;
  }
  return true; // goto, ownership, outboxDrafts: direct or mcp
}

/** Reported by a gated tick or route that did nothing. */
export const SLACK_OFF = 'slack_off';

function withDb<T>(db: Database.Database | undefined, f: (db: Database.Database) => T): T {
  if (db) return f(db);
  const own = openDb();
  try {
    return f(own);
  } finally {
    own.close();
  }
}

/** The effective mode. T11 sends it as `slackMode` in /api/data. */
export function slackMode(db?: Database.Database): SlackMode {
  return withDb(db, (d) => effectiveMode(getSetting(d, 'slack_mode'), !!slackToken()));
}

/** `slackFeatureOn('send')` before any Slack tick, route or hook handler acts. */
export function slackFeatureOn(feature: SlackFeature, db?: Database.Database): boolean {
  return withDb(db, (d) => featureOn(feature, effectiveMode(getSetting(d, 'slack_mode'), !!slackToken()), getSetting(d, 'slack_poll_parked')));
}

/** Why Slack cannot send, in words: a lapsed Connect Slack token reads differently from never connected. */
export function slackOffDetail(db?: Database.Database): string {
  try {
    if (withDb(db, (d) => getSetting(d, 'slack_reconnect'))) return 'The Slack connection expired. Reconnect Slack in Settings, Slack.';
  } catch {
    /* fall through */
  }
  return 'Slack is not connected in direct mode';
}
