import { execFileSync } from 'node:child_process';
import { readLayout, type PaneSnap, type Layout } from './snapshot.ts';
import { LAYOUT_PATH } from './paths.ts';

function shq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// What to type into a restored pane, and whether to auto-run it.
// Claude chats and nvim auto-launch; arbitrary "other" commands (dev servers,
// tunnels) are pre-typed but NOT run, so nothing fires unexpectedly.
function paneCommand(p: PaneSnap): { text: string; run: boolean } | null {
  if (p.kind === 'claude') {
    if (!p.session_id) return null; // claude pane but unknown chat -> leave a shell
    return { text: `claude --resume ${shq(p.session_id)} --dangerously-skip-permissions`, run: true };
  }
  if (p.kind === 'nvim') return { text: 'nvim', run: true };
  if (p.kind === 'other' && p.full_command) return { text: p.full_command, run: false };
  return null; // shell -> nothing to type (pane already opened in its cwd)
}

function existingSessions(): Set<string> {
  try {
    return new Set(
      execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf-8' })
        .split('\n')
        .filter(Boolean),
    );
  } catch {
    return new Set(); // tmux server not running yet
  }
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
  attach: string[];
  log: string[];
}

export function restore(
  opts: { dryRun?: boolean; layout?: Layout | null; existing?: Set<string>; prefix?: string } = {},
): RestoreResult {
  const layout = opts.layout ?? readLayout();
  if (!layout) {
    throw new Error(`no layout snapshot found at ${LAYOUT_PATH}`);
  }
  const dry = !!opts.dryRun;
  const existing = opts.existing ?? existingSessions();
  // Belt-and-suspenders: snapshots are already prefix-filtered, but an entry
  // point can pass a prefix so a stale/unfiltered layout still only restores the
  // workspace set. Omitted -> restore every session in the layout.
  const sessions = opts.prefix ? layout.sessions.filter((s) => s.name.startsWith(opts.prefix!)) : layout.sessions;
  const restored: string[] = [];
  const skipped: string[] = [];
  const log: string[] = [];

  const tmux = (args: string[]): string => {
    if (dry) {
      log.push('tmux ' + args.map((a) => (/\s/.test(a) ? shq(a) : a)).join(' '));
      return '';
    }
    return execFileSync('tmux', args, { encoding: 'utf-8' }).trim();
  };

  for (const s of sessions) {
    if (existing.has(s.name)) {
      skipped.push(s.name);
      continue;
    }
    restored.push(s.name);
    for (let wi = 0; wi < s.windows.length; wi++) {
      const w = s.windows[wi];
      const cwd0 = w.panes[0]?.cwd || process.env.HOME || '.';
      if (wi === 0) {
        tmux(['new-session', '-d', '-s', s.name, '-c', cwd0, '-x', '250', '-y', '60']);
      } else {
        tmux(['new-window', '-t', s.name, '-c', cwd0]);
      }
      // Build the remaining panes, redistributing space after each so splits fit.
      for (let i = 1; i < w.panes.length; i++) {
        tmux(['split-window', '-t', s.name, '-c', w.panes[i].cwd]);
        tmux(['select-layout', '-t', s.name, 'tiled']);
      }
      // Apply the exact captured geometry.
      if (w.window_layout) tmux(['select-layout', '-t', s.name, w.window_layout]);
      // Resolve the new pane ids in order and launch each pane's program.
      const paneIds = dry
        ? w.panes.map((_, i) => `%win${wi}p${i}`)
        : tmux(['list-panes', '-t', s.name, '-F', '#{pane_id}']).split('\n').filter(Boolean);
      for (let i = 0; i < w.panes.length && i < paneIds.length; i++) {
        const c = paneCommand(w.panes[i]);
        if (!c) continue;
        tmux(['send-keys', '-t', paneIds[i], '-l', c.text]);
        if (c.run) tmux(['send-keys', '-t', paneIds[i], 'Enter']);
      }
    }
  }
  return { restored, skipped, attach: restored, log };
}
