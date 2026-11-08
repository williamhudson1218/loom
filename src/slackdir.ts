import fs from 'node:fs';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';
import { channelLabels } from './slack.ts';
import { authTest, emojiList, slackToken, userLabel, usersList } from './slackapi.ts';

// What the draft renderer needs to read a Slack message the way Slack shows it:
// user names for <@U…>, channel names for <#C…>, the workspace's custom emoji, and
// who "me" is (the sender header). Channels come from the label cache (slack.ts);
// the rest is read-only Slack API calls (users.list, emoji.list, auth.test, via
// slackapi.ts) made with the same user token the watchers use, cached on disk and refreshed in the
// background. Every part degrades on its own: no token, no scope (emoji:read) or
// no network just leaves that map empty, and the renderer falls back to raw ids
// and a styled :name: pill.

export const DIRECTORY_PATH = path.join(TOOL_DIR, 'slack-directory.json');
const TTL_MS = 6 * 3_600_000;

export interface SlackDirectory {
  fetchedAt: number;
  users: Record<string, string>;
  custom: Record<string, string>;
  channels: Record<string, string>;
  me: { id: string; name: string; avatar: string };
}

const empty = (): SlackDirectory => ({ fetchedAt: 0, users: {}, custom: {}, channels: {}, me: { id: '', name: '', avatar: '' } });

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

function channelNames(labelsFile?: string): Record<string, string> {
  const out: Record<string, string> = {};
  const labels = labelsFile ? readJson<Record<string, string>>(labelsFile, {}) : channelLabels();
  for (const [id, label] of Object.entries(labels)) out[id] = String(label).replace(/^[#@]/, '');
  return out;
}

/** `labelsFile` reads one labels file only (tests); by default the label cache with its legacy fallback. */
export function readDirectory(file: string = DIRECTORY_PATH, labelsFile?: string): SlackDirectory {
  const d = { ...empty(), ...readJson<Partial<SlackDirectory>>(file, {}) };
  return { ...d, channels: channelNames(labelsFile) };
}

interface ApiOpts {
  token?: string;
  fetchImpl?: typeof fetch;
  file?: string;
  labelsFile?: string;
}

/** Fetch what it can, keep what it already had for whatever fails, write the cache. */
export async function refreshDirectory(opts: ApiOpts = {}): Promise<SlackDirectory> {
  const file = opts.file ?? DIRECTORY_PATH;
  const prev = readDirectory(file, opts.labelsFile);
  const token = opts.token || slackToken();
  if (!token) return prev;
  const api = { token, fetchImpl: opts.fetchImpl };
  const next: SlackDirectory = { ...prev, fetchedAt: Date.now() };

  try {
    const users: Record<string, string> = {};
    const avatars: Record<string, string> = {};
    for (const m of await usersList({}, api)) {
      if (m.deleted) continue;
      users[m.id] = userLabel(m);
      if (m.profile?.image_48) avatars[m.id] = m.profile.image_48;
    }
    next.users = users;
    try {
      const { identity } = await authTest(api);
      next.me = { id: identity.user_id, name: users[identity.user_id] || identity.user, avatar: avatars[identity.user_id] ?? '' };
    } catch {
      /* the sender header falls back to "You" */
    }
  } catch {
    /* keep the previous users */
  }
  try {
    next.custom = await emojiList(api);
  } catch {
    /* keep the previous emoji (no emoji:read scope lands here) */
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const { channels: _c, ...persist } = next;
    fs.writeFileSync(file, JSON.stringify(persist));
  } catch {
    /* a cache that cannot be written is only slower */
  }
  return next;
}

let inflight: Promise<unknown> | null = null;

/** The cached directory now; a stale or missing one also starts a background refresh. */
export function getDirectory(opts: ApiOpts = {}): SlackDirectory {
  const d = readDirectory(opts.file, opts.labelsFile);
  if (Date.now() - d.fetchedAt > TTL_MS && !inflight) {
    inflight = refreshDirectory(opts)
      .catch(() => undefined)
      .finally(() => {
        inflight = null;
      });
  }
  return d;
}
