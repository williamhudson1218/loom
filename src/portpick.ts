import type http from 'node:http';
import { createHash } from 'node:crypto';
import fs from 'node:fs';

// Choosing the port Loom serves on. localhost is shared by every macOS user, so
// the configured port can be held by another user's Loom, or by something that is
// not Loom. Loom then takes the next free port in a small range. A Loom that is
// this user's own on the same data folder is the one case it must not move past:
// a second server on the same data would fight the first over it.

export interface Identity {
  app: 'loom';
  uid: number;
  /** A hash of the data folder, so the endpoint never prints a path. */
  home_id: string;
}

/** What /api/whoami returns for this process. */
export function localIdentity(home: string): Identity {
  let real = home;
  try {
    real = fs.realpathSync(home);
  } catch {
    /* not created yet */
  }
  return { app: 'loom', uid: process.getuid?.() ?? -1, home_id: createHash('sha256').update(real).digest('hex').slice(0, 16) };
}

export type Occupant = 'mine' | 'other';

/** Whoever answered on a busy port: this user's Loom on this data folder, or anything else. */
export function classify(found: Partial<Identity> | null | undefined, mine: Identity): Occupant {
  if (!found || found.app !== 'loom') return 'other';
  return found.uid === mine.uid && found.home_id === mine.home_id ? 'mine' : 'other';
}

export type PortChoice =
  | { kind: 'bound'; port: number }
  | { kind: 'running'; port: number }
  | { kind: 'exhausted'; tried: number[] };

export interface PickDeps {
  /** Try to take the port. 'busy' means something already holds it. */
  tryBind(port: number): Promise<'bound' | 'busy'>;
  /** Ask a busy port who is there. null: no answer, or not Loom. */
  probe(port: number): Promise<Partial<Identity> | null>;
  mine: Identity;
}

/** Walk the ports in order. The decision is here so it can be tested with stubbed probes. */
export async function pickPort(ports: number[], deps: PickDeps): Promise<PortChoice> {
  const tried: number[] = [];
  for (const port of ports) {
    if ((await deps.tryBind(port)) === 'bound') return { kind: 'bound', port };
    tried.push(port);
    if (classify(await deps.probe(port), deps.mine) === 'mine') return { kind: 'running', port };
  }
  return { kind: 'exhausted', tried };
}

/** GET /api/whoami on 127.0.0.1:<port>. Anything but a Loom answer is null. */
export async function probeWhoami(port: number, timeoutMs = 1500, fetchImpl: typeof fetch = fetch): Promise<Partial<Identity> | null> {
  try {
    const r = await fetchImpl(`http://127.0.0.1:${port}/api/whoami`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const body = (await r.json()) as Partial<Identity>;
    return body && typeof body === 'object' ? body : null;
  } catch {
    return null;
  }
}

/** The real tryBind: listen on 127.0.0.1, and report EADDRINUSE or EACCES as busy. */
export function bindServer(server: http.Server, host = '127.0.0.1'): PickDeps['tryBind'] {
  return (port) =>
    new Promise((resolve, reject) => {
      const onError = (e: NodeJS.ErrnoException) => {
        server.off('listening', onListening);
        if (e.code === 'EADDRINUSE' || e.code === 'EACCES') resolve('busy');
        else reject(e);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve('bound');
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
}

/** Listen on the first usable port of `ports`, or say why none was taken. */
export function listenOnFirstFree(
  server: http.Server,
  ports: number[],
  mine: Identity,
  over: Partial<PickDeps> = {},
): Promise<PortChoice> {
  return pickPort(ports, { tryBind: bindServer(server), probe: (p) => probeWhoami(p), mine, ...over });
}
