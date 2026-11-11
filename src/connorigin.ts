import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';

// How each connection came to be, so the Connections step can say so honestly:
// "Connected through Loom" only when Loom did it, otherwise what Loom found and
// where. $LOOM_HOME/connection-origins.json, written when a Loom flow finishes:
//   slack:  { via: 'connect' | 'pasted', who: team_id }
//   github: { via: 'loom', who: login }
// A connection with no matching record was there before Loom looked.

export const ORIGINS_FILE = 'connection-origins.json';

export interface OriginRecord {
  via: string;
  who: string;
  at: number;
}
export type Origins = Partial<Record<'slack' | 'github', OriginRecord>>;

const file = (loomHome: string) => path.join(loomHome, ORIGINS_FILE);

export function readOrigins(loomHome: string = TOOL_DIR): Origins {
  try {
    const j = JSON.parse(fs.readFileSync(file(loomHome), 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** Record that a Loom flow made this connection. Never throws. */
export function recordOrigin(kind: 'slack' | 'github', via: string, who: string, loomHome: string = TOOL_DIR): void {
  try {
    const cur = readOrigins(loomHome);
    cur[kind] = { via, who, at: Date.now() };
    fs.mkdirSync(loomHome, { recursive: true });
    fs.writeFileSync(`${file(loomHome)}.tmp`, JSON.stringify(cur, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file(loomHome)}.tmp`, file(loomHome));
  } catch {
    /* the page then says "found", which is the cautious reading */
  }
}

/**
 * Where the Slack token came from: Connect Slack, pasted into Loom, the
 * SLACK_USER_TOKEN environment variable, or already there (stored earlier,
 * before Loom recorded how). null when not connected.
 */
export function slackOrigin(o: { connected: boolean; tokenSource: string; teamId?: string | null }, origins: Origins = readOrigins()): 'connect' | 'pasted' | 'env' | 'earlier' | null {
  if (!o.connected) return null;
  if (o.tokenSource === 'env') return 'env';
  const r = origins.slack;
  if (r && (!o.teamId || r.who === o.teamId) && (r.via === 'connect' || r.via === 'pasted')) return r.via;
  return 'earlier';
}

/** 'loom' when Loom's Connect GitHub signed this login in, 'found' for a gh login that was already there. */
export function githubOrigin(login: string | null | undefined, origins: Origins = readOrigins()): 'loom' | 'found' | null {
  if (!login) return null;
  return origins.github?.via === 'loom' && origins.github.who === login ? 'loom' : 'found';
}

/** A path with the home folder shown as ~. */
export function homeTilde(p: string, home: string = os.homedir()): string {
  return home && (p === home || p.startsWith(home + '/')) ? '~' + p.slice(home.length) : p;
}
