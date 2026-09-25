import { execFileSync } from 'node:child_process';
import { readLayout, type PaneSnap, type Layout } from './snapshot.ts';
import { LAYOUT_PATH } from './paths.ts';
import { attachedSessions } from './placements.ts';
import { orderSessionsByTabs, type SavedGhosttyWindow } from './ghostty.ts';
import { RESUME_FULL_ENV } from './goto.ts';
import { readPaneNames } from './panenames.ts';

function shq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// What to type into a restored pane, and whether to auto-run it.
// Agent chats and nvim auto-launch; arbitrary "other" commands (dev servers,
// tunnels) are pre-typed but NOT run, so nothing fires unexpectedly.
function paneCommand(p: PaneSnap): { text: string; run: boolean } | null {
  if (p.kind === 'claude') {
    if (!p.session_id) return null; // agent pane but unknown chat -> leave a shell
    if (p.agent === 'codex') return { text: `codex resume ${shq(p.session_id)}`, run: true };
    return {
      text: `${RESUME_FULL_ENV} claude --resume ${shq(p.session_id)} --dangerously-skip-permissions`,
      run: true,
    };
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

export function savedWindowsOf(layout: Layout): SavedGhosttyWindow[] {
  if (layout.ghostty_windows?.length) return layout.ghostty_windows;
  return layout.ghostty_tabs?.length ? [{ tabs: layout.ghostty_tabs }] : [];
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
  attach: string[];
  // The saved Ghostty windows to rebuild `attach` into (pass to
  // attachGhosttyTabs as `saved`). A legacy snapshot with only the flat tab list
  // comes back as one window; no tab record at all comes back empty.
  windows: SavedGhosttyWindow[];
  log: string[];
}

export function restore(
  opts: {
    dryRun?: boolean;
    layout?: Layout | null;
    existing?: Set<string>;
    attached?: Set<string>;
    prefix?: string;
    // pane_id -> @name of the panes already live, for the dry-run path. A real
    // restore reads tmux fresh before every name it sets instead.
    liveNames?: Map<string, string>;
  } = {},
): RestoreResult {
  const layout = opts.layout ?? readLayout();
  if (!layout) {
    throw new Error(`no layout snapshot found at ${LAYOUT_PATH}`);
  }
  const dry = !!opts.dryRun;
  const existing = opts.existing ?? existingSessions();
  const attached = opts.attached ?? attachedSessions();
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

  // Loom's namer may be ticking while a CLI restore runs, and can hand a
  // snapshot name to some other pane before restore gets to it. The snapshot
  // wins: strip the name from whichever other pane holds it, and the next tick
  // gives that pane a fresh one — never two panes answering to one name.
  const dryNames = new Map(opts.liveNames ?? []);
  const holders = (): Map<string, string> =>
    dry ? dryNames : new Map(readPaneNames().filter((r) => r.name).map((r) => [r.pane_id, r.name]));
  const giveName = (paneId: string, name: string): void => {
    for (const [id, held] of holders()) {
      if (held !== name || id === paneId) continue;
      tmux(['set-option', '-pu', '-t', id, '@name']);
      dryNames.delete(id);
    }
    tmux(['set-option', '-p', '-t', paneId, '@name', name]);
    if (dry) dryNames.set(paneId, name);
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
        // Give the pane back its name before anything else, so a name Will has
        // been using still points at the same work after the crash — and so the
        // namer tick sees a named pane rather than handing it a fresh one.
        const name = w.panes[i].name;
        if (name) giveName(paneIds[i], name);
        const c = paneCommand(w.panes[i]);
        if (!c) continue;
        tmux(['send-keys', '-t', paneIds[i], '-l', c.text]);
        if (c.run) tmux(['send-keys', '-t', paneIds[i], 'Enter']);
      }
    }
  }
  // A session needs a tab when nothing is attached to it — that covers the ones
  // just recreated and, just as importantly, ones that survived detached (their
  // tab died, not the session). Replay them in the order their tabs sat in.
  const needsTab = sessions.map((s) => s.name).filter((n) => restored.includes(n) || !attached.has(n));
  const windows = savedWindowsOf(layout);
  const titles = windows.flatMap((w) => w.tabs);
  return { restored, skipped, attach: orderSessionsByTabs(needsTab, titles), windows, log };
}
