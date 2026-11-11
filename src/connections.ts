import fs from 'node:fs';
import { openDb } from './db.ts';
import { findBin, ghStatusVia, type GhStatus } from './ghconnect.ts';
import { listGoogleAccounts } from './googleoauth.ts';
import { getSetting } from './settingsSchema.ts';
import { resolveEmailCli } from './outboxemail.ts';
import { slackMode } from './slackmode.ts';

// The header's connections group: one dot per outside service Loom talks to.
//   ok    green  working
//   warn  amber  set up but needs attention
//   off   grey   not set up
// Slack comes from the effective Slack mode, GitHub from `gh auth status` (cached; never
// run per poll), Gmail from the connected Google accounts (src/googleoauth.ts) or else the
// email CLI setting resolving to a file that exists. None of them calls the service itself.

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
  /** The gh account name, when gh said. */
  ghLogin?: string;
  /** Connected Gmail accounts, and how many need reconnecting. */
  gmailAccounts?: number;
  gmailReconnect?: number;
  /** The email_via setting: auto | gmail | cli. */
  emailVia?: string;
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
  if (i.gh === 'ok') gh = { state: 'ok', detail: `GitHub: gh is signed in${i.ghLogin ? ' as ' + i.ghLogin : ''}.` };
  else if (i.gh === 'unauth') gh = { state: 'warn', detail: 'GitHub: gh is installed but not signed in. Click to connect.' };
  else if (i.gh === 'missing') gh = { state: 'off', detail: 'GitHub: gh is not installed. Click to set it up.' };
  else gh = { state: 'off', detail: 'GitHub: checking.' };

  let gmail: Pick<Connection, 'state' | 'detail'>;
  const nG = i.gmailAccounts ?? 0;
  const useCli = i.emailVia === 'cli' || (!nG && i.emailVia !== 'gmail');
  if (!useCli && nG && (i.gmailReconnect ?? 0) > 0) gmail = { state: 'warn', detail: 'Gmail: a connected account needs reconnecting. Click to reconnect.' };
  else if (!useCli && nG) gmail = { state: 'ok', detail: `Gmail: ${nG === 1 ? 'one account' : nG + ' accounts'} connected.` };
  else if (!useCli) gmail = { state: 'warn', detail: 'Gmail: email is set to send through Gmail, but no account is connected.' };
  else if (i.emailCli && i.emailCliExists) gmail = { state: 'ok', detail: 'Gmail: the email CLI is set up.' };
  else if (i.emailSetting.trim()) gmail = { state: 'warn', detail: 'Gmail: the Email CLI setting points at a file that does not exist.' };
  else gmail = { state: 'off', detail: 'Gmail: not set up. Click to connect Gmail.' };

  return [
    { id: 'slack', label: 'Slack', ...slack, section: 'slack' },
    { id: 'github', label: 'GitHub', ...gh, section: 'github' },
    { id: 'gmail', label: 'Gmail', ...gmail, section: 'outbox' },
  ];
}

/* ------------------------------------------------------------------ gh, cached */

export const GH_TTL_MS = 5 * 60_000;
export type GhRun = () => Promise<GhState>;

/** Stale-while-revalidate: always answers from the cache at once; a stale or empty cache starts one background run. */
export function makeGhCache<T = GhState>(run: () => Promise<T>, ttl: number = GH_TTL_MS, now: () => number = Date.now, initial: T = 'unknown' as T) {
  let value: T = initial;
  let at = -Infinity;
  let inflight = false;
  const start = () => {
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
  };
  return {
    get(): T {
      if (!inflight && now() - at >= ttl) start();
      return value;
    },
    /** Take a known answer now (Connect GitHub just finished). */
    set(v: T): void {
      value = v;
      at = now();
    },
    /** Forget the answer so the next get() runs again. */
    invalidate(): void {
      at = -Infinity;
    },
  };
}

const ghCache = makeGhCache<GhStatus>(() => ghStatusVia(findBin('gh')), GH_TTL_MS, Date.now, { state: 'unknown', login: '' });

/** Connect GitHub ended (or gh was installed): record the fresh status for the header. */
export function setGhStatus(s: GhStatus): void {
  ghCache.set(s);
}
export function invalidateGhStatus(): void {
  ghCache.invalidate();
}

/** The header data for /api/data. Never throws. */
export function connectionsSafe(): Connection[] {
  let reconnect = '';
  let setting = '';
  let mode = 'off';
  let via = 'auto';
  let accts: { reconnect?: string }[] = [];
  try {
    const db = openDb();
    try {
      reconnect = getSetting(db, 'slack_reconnect');
      setting = getSetting(db, 'email_cli', { env: false });
      mode = slackMode(db);
      via = getSetting(db, 'email_via');
      accts = listGoogleAccounts(db);
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
    ...(() => {
      const g = ghCache.get();
      return { gh: g.state, ghLogin: g.login };
    })(),
    gmailAccounts: accts.length,
    gmailReconnect: accts.filter((a) => a.reconnect).length,
    emailVia: via,
    emailSetting: setting,
    emailCli: cli,
    emailCliExists: !!cli && fs.existsSync(cli),
  });
}
