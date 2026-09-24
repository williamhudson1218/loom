import { execFileSync } from 'node:child_process';
import type { LiveInfo } from './placements.ts';

// Tint every pane running a chat by how stale that chat is, so a workspace of two
// dozen sessions shows at a glance which ones are dead and closable.
//
// Four tiers, and the healthy one is deliberately silent: a chat touched within
// the hour gets NO tint, exactly like a shell. Only decay is worth colour, so the
// workspace stays quiet until something actually needs attention.
export type Staleness = 'fresh' | 'today' | 'yesterday' | 'older';

// The palette, and the only place to tune it. 'fresh' has no entry on purpose —
// it is a reset, not a colour, which is what the Exclude<> below encodes.
//
// These are ONE ORDERED DIMENSION, not four hues. Warmth and prominence both
// rise with staleness against the cool #1e1e2e base, so 44 panes can be ranked at
// a glance instead of decoded against a key. Keep that ordering if you touch
// them: the ramp is the feature, the individual colours are not.
//
// Anchored on the terminal's actual base background — Ghostty on Catppuccin
// Mocha, #1e1e2e — because the tint is a wash BEHIND the pane's text and has to
// read as "that background, with a cast", never as a coloured pane.
//
// 'today' is MEANT to be barely perceptible. A chat touched three hours ago is
// not urgent, and making it shout drowns out the genuinely dead ones. Do not
// raise its saturation because it is hard to see in testing — that is the design.
export const TINT_BG: Record<Exclude<Staleness, 'fresh'>, string> = {
  today: '#26241c', // warm olive-grey — earlier today, deliberately subtle
  yesterday: '#332a15', // amber — yesterday, clearly readable
  older: '#3a1d1f', // red — older still, probably closable
};

// The same palette in the form tmux wants. Derived, so the hexes live in one place.
export const TINT_STYLE = Object.fromEntries(
  Object.entries(TINT_BG).map(([bucket, hex]) => [bucket, `bg=${hex}`]),
) as Record<Exclude<Staleness, 'fresh'>, string>;

const HOUR_MS = 60 * 60 * 1000;

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// Wall-clock day boundaries, not rolling 24h windows — "yesterday" has to mean
// what it means in conversation. The <1h test runs first and deliberately wins:
// a chat touched at 23:55 still reads fresh at 00:10 rather than crossing
// midnight into a colour that says it has gone cold.
export function staleness(lastActiveMs: number, now: number): Staleness {
  if (now - lastActiveMs < HOUR_MS) return 'fresh';
  const today = startOfLocalDay(now);
  if (lastActiveMs >= today) return 'today';
  if (lastActiveMs >= startOfLocalDay(today - 1)) return 'yesterday';
  return 'older';
}

// pane_id -> style, for panes that resolve to a chat we can date AND that have
// actually gone cold. This is deliberately ONLY that set. Absent — and therefore
// reset — are: an agent pane with no placement recorded yet, any pane with no
// agent at all (shell, nvim, a dev server's node), and, because the active tier
// is untinted, every chat touched within the last hour.
//
// That last one makes reset the busy path rather than the rare one. A chat that
// goes cold and is then picked up again has to travel tinted -> unset, and if it
// did not, the pane most recently worked in would be the one wearing the "this
// is dead" colour.
//
// Recomputed from scratch every tick rather than maintained by transition,
// because the transition Loom most needs to catch is the one it cannot observe:
// Will types /quit, the pane drops out of this map with no event anywhere, and a
// paint-only tick would leave yesterday's colour sitting on precisely the pane
// whose staleness the feature exists to report.
export function desiredTints(
  live: Map<string, LiveInfo>,
  lastActiveByKey: Map<string, number>,
  now: number,
  prefix: string,
): Map<string, string> {
  const desired = new Map<string, string>();
  for (const [key, info] of live) {
    // Paint is scoped to the workspace prefix, and the clear sweeps the same
    // prefix. They must agree: a tint painted outside it is one nothing cleans up.
    if (!info.tmux_session.startsWith(prefix)) continue;
    const lastActive = lastActiveByKey.get(key);
    if (lastActive === undefined) continue; // no transcript -> no date -> no guess
    const bucket = staleness(lastActive, now);
    if (bucket === 'fresh') continue; // a live chat is left looking like a shell
    desired.set(info.pane_id, TINT_STYLE[bucket]);
  }
  return desired;
}

// The tmux writes, behind an interface so the reconciliation can be tested without
// a tmux server. The ONLY options this module ever touches are window-style and
// window-active-style — both are set together, since a pane styled through only
// the first loses its tint the moment it becomes the active pane.
export interface TintTmux {
  paint(paneId: string, style: string): void;
  reset(paneId: string): void;
  clearWindows(prefix: string): number;
}

export const realTintTmux: TintTmux = {
  paint(paneId, style) {
    // One tmux invocation for both options: ';' separates commands in argv.
    tmuxQuiet(['set-option', '-p', '-t', paneId, 'window-style', style,
      ';', 'set-option', '-p', '-t', paneId, 'window-active-style', style]);
  },

  reset(paneId) {
    // -u removes the pane-local override and restores inheritance. It never
    // writes a global, so it is safe on a pane we may not have painted.
    tmuxQuiet(['set-option', '-pu', '-t', paneId, 'window-style',
      ';', 'set-option', '-pu', '-t', paneId, 'window-active-style']);
  },

  clearWindows(prefix) {
    let out: string;
    try {
      out = execFileSync('tmux', ['list-windows', '-a', '-F', '#{session_name}:#{window_index}'], {
        encoding: 'utf-8',
      });
    } catch {
      return 0; // tmux not running -> nothing to clear
    }
    const windows = out.split('\n').map((s) => s.trim()).filter((w) => w && w.startsWith(prefix));
    for (const w of windows) {
      // -U unsets on the window AND on every pane in it, so two calls per window
      // clear the whole workspace regardless of how it is split.
      tmuxQuiet(['set-option', '-U', '-t', w, 'window-style',
        ';', 'set-option', '-U', '-t', w, 'window-active-style']);
    }
    return windows.length;
  },
};

function tmuxQuiet(args: string[]): void {
  try {
    execFileSync('tmux', args, { stdio: 'ignore' });
  } catch {
    /* pane or window vanished between listing it and writing to it */
  }
}

export class PaneTints {
  // pane_id -> the style we last wrote there: the record of our OWN writes, which
  // is what lets a tick that changes nothing issue zero tmux calls.
  private applied = new Map<string, string>();

  constructor(private readonly tmux: TintTmux = realTintTmux) {}

  apply(desired: Map<string, string>, livePaneIds: Set<string>): { painted: number; reset: number } {
    let painted = 0;
    let reset = 0;

    for (const [paneId, style] of desired) {
      if (this.applied.get(paneId) === style) continue;
      this.tmux.paint(paneId, style);
      this.applied.set(paneId, style);
      painted++;
    }

    for (const paneId of [...this.applied.keys()]) {
      if (desired.has(paneId)) continue;
      this.applied.delete(paneId);
      // A pane that no longer exists took its options with it; resetting a dead
      // id would just be a failing tmux call on every tick forever.
      if (!livePaneIds.has(paneId)) continue;
      this.tmux.reset(paneId);
      reset++;
    }

    return { painted, reset };
  }

  // Unconditional sweep of the workspace. Called at startup BEFORE the first
  // paint — that is the real crash recovery, since tmux owns pane options and a
  // SIGKILLed Loom leaves its tints behind until the pane or the server dies.
  clearAll(prefix: string): number {
    this.applied.clear();
    return this.tmux.clearWindows(prefix);
  }
}
