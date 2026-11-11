import { redirectUri } from './slackoauth.ts';
import { portRange } from './serverport.ts';
import { FEATURE_METHODS, READ_FEATURES, compareScopes, scopesFor, type ScopeReport } from './slackapi.ts';

// The Slack app manifest Loom asks the user to paste at api.slack.com/apps (§5.1).
// A user token only: no bot user, no bot scopes, no events, no sockets.

export interface ManifestOpts {
  /** The person's name, for the app title: `Loom (<name>)`. */
  fullName?: string;
  /** Strip every write scope: Loom then only reads. */
  readonly?: boolean;
}

export interface SlackManifest {
  display_information: { name: string; description: string };
  oauth_config: { scopes: { user: string[] } };
  settings: { org_deploy_enabled: false; socket_mode_enabled: false; token_rotation_enabled: false };
}

/** The features a manifest (and the scope comparison) covers. */
export function manifestFeatures(readonly = false): string[] {
  return readonly ? READ_FEATURES : Object.keys(FEATURE_METHODS);
}

export function manifestScopes(readonly = false): string[] {
  return scopesFor(manifestFeatures(readonly));
}

export function appName(fullName?: string): string {
  const n = (fullName ?? '').replace(/[^\p{L}\p{N} .'-]/gu, '').trim().slice(0, 40);
  return n ? `Loom (${n})` : 'Loom';
}

export function buildManifest(opts: ManifestOpts = {}): SlackManifest {
  return {
    display_information: {
      name: appName(opts.fullName),
      description: opts.readonly
        ? 'Loom reads your Slack threads on your behalf. It never posts.'
        : 'Loom links your Slack threads to your Claude Code chats and sends the drafts you approve.',
    },
    oauth_config: { scopes: { user: manifestScopes(opts.readonly) } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
}

/**
 * The ONE shared app a workspace admin creates for Connect Slack: the same user
 * scopes, a localhost redirect, and PKCE on, which makes it a public client with
 * no client secret (one-way: Slack cannot turn PKCE off again). Token rotation
 * is on, so a token expires after 12 hours and refreshes; a PKCE app's refresh
 * token lasts 30 days. Still no bot user and no bot scopes: a localhost
 * redirect counts as a desktop redirect under PKCE, and those cannot take bot
 * scopes anyway. A read-only person asks for fewer scopes at authorize time.
 */
export interface SharedManifest {
  display_information: { name: string; description: string };
  oauth_config: { redirect_urls: string[]; scopes: { user: string[] }; pkce_enabled: true };
  settings: { org_deploy_enabled: false; socket_mode_enabled: false; token_rotation_enabled: true };
}

/**
 * `port` is the configured base. Loom moves to the next free port when another
 * user's Loom holds it (src/portpick.ts), and Slack matches a redirect exactly, so
 * every port in the range is registered up front: the app is created once.
 */
export function buildSharedManifest(opts: { port: number }): SharedManifest {
  return {
    display_information: {
      name: 'Loom',
      description: 'Loom links your Slack threads to your Claude Code chats and sends the drafts you approve, as you.',
    },
    oauth_config: { redirect_urls: portRange(opts.port).map(redirectUri), scopes: { user: manifestScopes(false) }, pkce_enabled: true },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: true },
  };
}

/** What the wizard and Settings show after a Test. */
export interface ScopeSummary extends ScopeReport {
  text: string;
  /** True when anything is missing, so the UI offers Re-authorise. */
  reauthorise: boolean;
}

/** "N of M scopes granted" plus the missing ones, against what the enabled features need. */
export function scopeSummary(granted: string[], readonly = false): ScopeSummary {
  const r = compareScopes(granted, manifestFeatures(readonly));
  const text = r.missing.length ? `${r.granted} of ${r.required} scopes granted, ${r.missing.join(', ')} missing` : `${r.required} of ${r.required} scopes granted`;
  return { ...r, text, reauthorise: r.missing.length > 0 };
}
