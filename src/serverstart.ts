import type http from 'node:http';
import { openDb } from './db.ts';
import { getSetting } from './settingsSchema.ts';
import { TOOL_DIR } from './paths.ts';
import { localIdentity, listenOnFirstFree, type PortChoice } from './portpick.ts';
import { DEFAULT_PORT, portRange, setServerPort } from './serverport.ts';
import { removeServerJson, writeServerJson } from './serverjson.ts';
import { setLoomPort } from './routes/index.ts';

/** The configured port (setting, with $LOOM_PORT over it); 4317 when settings cannot be read. */
export function configuredPort(): number {
  try {
    const db = openDb();
    try {
      return getSetting(db, 'port');
    } finally {
      db.close();
    }
  } catch {
    return DEFAULT_PORT;
  }
}

/**
 * Bind the server on the configured port, or the next free one, and publish the
 * choice: the in-process port, and $LOOM_HOME/server.json for every other client.
 * 'running' (this user's own Loom already holds a port) and 'exhausted' leave the
 * server unbound and are the caller's to report.
 */
export async function startListening(server: http.Server): Promise<PortChoice> {
  const base = configuredPort();
  const choice = await listenOnFirstFree(server, portRange(base), localIdentity(TOOL_DIR));
  if (choice.kind !== 'bound') return choice;
  setServerPort(choice.port, base);
  setLoomPort(choice.port);
  writeServerJson({ port: choice.port, pid: process.pid, uid: process.getuid?.() ?? -1, startedAt: Date.now() }, TOOL_DIR);
  process.once('exit', () => removeServerJson(TOOL_DIR));
  return choice;
}

/** Plain-copy text for a start that did not bind. */
export function startFailure(choice: Exclude<PortChoice, { kind: 'bound' }>): { title: string; message: string } {
  if (choice.kind === 'running') {
    return { title: 'Loom is already running', message: `Loom is already running for this account on port ${choice.port}. Open that one from the menu bar.` };
  }
  const t = choice.tried;
  return {
    title: 'Loom cannot start',
    message: `Ports ${t[0]} to ${t[t.length - 1]} on this Mac are all in use. Quit what is using one of them, or set a different port with LOOM_PORT, then open Loom again.`,
  };
}
