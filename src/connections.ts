import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { openDb } from './db.ts';
import { getSetting } from './settingsSchema.ts';
import { resolveEmailCli } from './outboxemail.ts';
import { slackMode } from './slackmode.ts';

// The header's connections group: one dot per outside service Loom talks to.
//   ok    green  working
//   warn  amber  set up but needs attention
//   off   grey   not set up
// Slack comes from the effective Slack mode, GitHub from `gh auth status` (cached; never
// run per poll), Gmail from the email CLI setting resolving to a file that exists. None of
// them calls the service itself.

export type ConnState = 'ok' | 'warn' | 'off';
export type GhState = 'ok' | 'unauth' | 'missing' | 'unknown';
export interface Connection {
  id: 'slack' | 'github' | 'gmail';
  label: string;
  state: ConnState;
  /** The state in words, for the hover title. */
  detail: string;
  /** The Settings section a click opens. */
  section: string;
}

export interface ConnInputs {
  slackMode: string;
  slackReconnect: string;
  gh: GhState;
  emailSetting: string;
  /** What resolveEmailCli returned ('' when email is off). */
  emailCli: string;
  emailCliExists: boolean;
}

export function connectionStates(i: ConnInputs): Connection[] {
  let slack: Pick<Connection, 'state' | 'detail'>;
  if (i.slackMode === 'direct' || i.slackMode === 'mcp') {
    if (i.slackReconnect) slack = { state: 'warn', detail: 'Slack: the connection expired. Click to reconnect.' };
    else if (i.slackMode === 'direct') slack = { state: 'ok', detail: 'Slack: connected.' };
    else slack = { state: 'ok', detail: 'Slack: through the Claude Slack connector (MCP).' };
  } else if (i.slackReconnect) slack = { state: 'warn', detail: 'Slack: the connection expired. Click to reconnect.' };
  else slack = { state: 'off', detail: 'Slack: not set up.' };

  let gh: Pick<Connection, 'state' | 'detail'>;
  if (i.gh === 'ok') gh = { state: 'ok', detail: 'GitHub: gh is signed in.' };
  else if (i.gh === 'unauth') gh = { state: 'warn', detail: 'GitHub: gh is installed but not signed in. Run gh auth login.' };
  else if (i.gh === 'missing') gh = { state: 'off', detail: 'GitHub: gh is not installed.' };
  else gh = { state: 'off', detail: 'GitHub: checking.' };

  let gmail: Pick<Connection, 'state' | 'detail'>;
  if (i.emailCli && i.emailCliExists) gmail = { state: 'ok', detail: 'Gmail: the email CLI is set up.' };
  else if (i.emailSetting.trim()) gmail = { state: 'warn', detail: 'Gmail: the Email CLI setting points at a file that does not exist.' };
  else gmail = { state: 'off', detail: 'Gmail: no email CLI set up.' };

  return [
    { id: 'slack', label: 'Slack', ...slack, section: 'slack' },
    { id: 'github', label: 'GitHub', ...gh, section: 'general' },
    { id: 'gmail', label: 'Gmail', ...gmail, section: 'outbox' },
  ];
}

/* ------------------------------------------------------------------ gh, cached */

export const GH_TTL_MS = 5 * 60_000;
export type GhRun = () => Promise<GhState>;

/** `gh auth status`: exit 0 is signed in, ENOENT is missing, any other exit is not signed in. */
export const runGhAuth: GhRun = () =>
  new Promise((resolve) => {
    try {
      execFile('gh', ['auth', 'status'], { timeout: 5000 }, (err) => {
        if (!err) return resolve('ok');
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return resolve('missing');
        if (e.killed) return resolve('unknown');
        resolve('unauth');
      });
    } catch {
      resolve('unknown');
    }
  });

/** Stale-while-revalidate: always answers from the cache at once; a stale or empty cache starts one background run. */
export function makeGhCache(run: GhRun = runGhAuth, ttl: number = GH_TTL_MS, now: () => number = Date.now) {
  let value: GhState = 'unknown';
  let at = -Infinity;
  let inflight = false;
  return {
    get(): GhState {
      if (!inflight && now() - at >= ttl) {
        inflight = true;
        run()
          .then((v) => {
            value = v;
            at = now();
          })
          .catch(() => {
            at = now();
          })
          .finally(() => {
            inflight = false;
          });
      }
      return value;
    },
  };
}

const ghCache = makeGhCache();

/** The header data for /api/data. Never throws. */
export function connectionsSafe(): Connection[] {
  let reconnect = '';
  let setting = '';
  let mode = 'off';
  try {
    const db = openDb();
    try {
      reconnect = getSetting(db, 'slack_reconnect');
      setting = getSetting(db, 'email_cli', { env: false });
      mode = slackMode(db);
    } finally {
      db.close();
    }
  } catch {
    /* a state read that failed reads as not set up */
  }
  const cli = resolveEmailCli(setting);
  return connectionStates({
    slackMode: mode,
    slackReconnect: reconnect,
    gh: ghCache.get(),
    emailSetting: setting,
    emailCli: cli,
    emailCliExists: !!cli && fs.existsSync(cli),
  });
}
