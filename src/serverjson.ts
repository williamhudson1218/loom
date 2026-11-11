import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_PORT } from './serverport.ts';

// $LOOM_HOME/server.json: which port this user's Loom is on, written after listen
// and removed on a clean quit. localhost is shared by every macOS user on the Mac,
// so a client that hardcodes a port can reach someone else's Loom; the data folder
// is per user, so this file is the one place a client can ask.

export interface ServerInfo {
  port: number;
  pid: number;
  uid: number;
  startedAt: number;
}

export const SERVER_JSON = 'server.json';

/** The data folder, resolved the way src/paths.ts and the plugin's _common.py do, without importing either. */
export function defaultHome(): string {
  const env = process.env.LOOM_HOME?.trim();
  if (env) return path.resolve(env);
  const legacy = path.join(os.homedir(), '.claude', 'tools', 'chat-manager');
  try {
    if (fs.existsSync(legacy)) return legacy;
  } catch {
    /* fall through */
  }
  return path.join(os.homedir(), '.loom');
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    // ESRCH: gone. EPERM: it exists but belongs to another user, so it is not this user's Loom.
    return false;
  }
}

export function writeServerJson(info: ServerInfo, home: string = defaultHome()): void {
  fs.mkdirSync(home, { recursive: true });
  const file = path.join(home, SERVER_JSON);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** Remove the file, but only if it is still this process's: a newer Loom may have replaced it. */
export function removeServerJson(home: string = defaultHome(), pid: number = process.pid): void {
  const file = path.join(home, SERVER_JSON);
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ServerInfo>;
    if (cur.pid === pid) fs.unlinkSync(file);
  } catch {
    /* absent or unreadable */
  }
}

/** The recorded Loom, or null when there is no file, it is malformed, or its process is gone. */
export function readServerJson(home: string = defaultHome(), alive: (pid: number) => boolean = pidAlive): ServerInfo | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(home, SERVER_JSON), 'utf-8')) as Partial<ServerInfo>;
    if (!Number.isInteger(v.port) || !Number.isInteger(v.pid)) return null;
    if (v.port! < 1 || v.port! > 65535) return null;
    if (!alive(v.pid!)) return null;
    return v as ServerInfo;
  } catch {
    return null;
  }
}

const validPort = (v: unknown): number | undefined => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return v !== undefined && v !== '' && Number.isInteger(n) && n > 0 && n <= 65535 ? n : undefined;
};

/**
 * The port a client should use: $LOOM_PORT, then server.json (its pid alive),
 * then the configured setting when the caller has one, then 4317.
 */
export function resolveLoomPort(opts: {
  env?: NodeJS.ProcessEnv;
  home?: string;
  alive?: (pid: number) => boolean;
  setting?: number;
} = {}): number {
  const env = opts.env ?? process.env;
  return validPort(env.LOOM_PORT) ?? readServerJson(opts.home ?? (env.LOOM_HOME?.trim() || defaultHome()), opts.alive)?.port ?? validPort(opts.setting) ?? DEFAULT_PORT;
}
