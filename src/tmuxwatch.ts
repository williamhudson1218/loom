import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOL_DIR } from './paths.ts';

// Losing the tmux server takes every session with it, and it happens rarely
// enough that it is always reconstructed after the fact from guesswork. This
// records the server's identity next to Loom's own lifecycle events, so the next
// time the workspace vanishes there is a timestamp for when the server went and
// whether Loom was even running at the time.
export const TMUX_WATCH_PATH = path.join(TOOL_DIR, 'tmux-watch.log');

export interface TmuxServerState {
  pid: string; // '' when no server is running
  sessions: number;
}

const SEP = '~|LOOM|~';

// The server's pid is the parent of every session's process group; tmux reports
// it directly, and it changes exactly when the server is replaced.
export function tmuxServerState(): TmuxServerState {
  try {
    const out = execFileSync('tmux', ['list-sessions', '-F', `#{pid}${SEP}#{session_name}`], { encoding: 'utf-8' });
    const lines = out.split('\n').filter(Boolean);
    return { pid: lines[0]?.split(SEP)[0] ?? '', sessions: lines.length };
  } catch {
    return { pid: '', sessions: 0 }; // no server
  }
}

export function formatWatchLine(now: number, event: string, state: TmuxServerState, note = ''): string {
  const when = new Date(now).toISOString();
  const server = state.pid ? `server=${state.pid} sessions=${state.sessions}` : 'server=none';
  return `${when} ${event} ${server}${note ? ' ' + note : ''}\n`;
}

export function noteTmuxState(now: number, event: string, note = '', file: string = TMUX_WATCH_PATH): TmuxServerState {
  const state = tmuxServerState();
  try {
    fs.appendFileSync(file, formatWatchLine(now, event, state, note), 'utf-8');
  } catch {
    /* logging must never take the app down */
  }
  return state;
}

// Log only transitions, so the periodic caller can run as often as it likes
// without the log becoming a heartbeat nobody reads.
export function makeTmuxWatcher(file: string = TMUX_WATCH_PATH) {
  let last: string | null = null;
  return (now: number, event = 'tick'): void => {
    const state = tmuxServerState();
    if (last !== null && state.pid === last) return;
    const note = last === null ? '(first observation)' : `(was server=${last || 'none'})`;
    try {
      fs.appendFileSync(file, formatWatchLine(now, last === null ? 'watch-start' : event, state, note), 'utf-8');
    } catch {
      /* ignore */
    }
    last = state.pid;
  };
}
