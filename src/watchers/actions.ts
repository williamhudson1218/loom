import type Database from 'better-sqlite3';
import { claudeCommand, type LaunchSettings } from '../launch.ts';
import { defaultRun, parseLane, type LanePane, type TmuxRunner } from '../compact.ts';
import { logOrch, type RelayDeps } from '../orchestrator.ts';
import type { Agent } from '../types.ts';
import { readInvoke } from './invocables.ts';

// What an action needs that is not the engine loop: picking a lane pane,
// building the launch line, typing it, rendering a template, and relaying a
// message into a chat (focus-aware, queued while the user is looking at it).

const SHELL = /^(zsh|bash)$/;

/* ------------------------------------------------------------ templates */

/** Fill {{NAME}} variables; unknown ones are left as typed. */
export function renderBrief(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (whole, k: string) => (k in vars ? vars[k] : whole));
}

/**
 * What the chat receives. With an `invoke` param it is `/<name> <args>` (variables
 * filled), then a blank line and the notes; without one it is the free-text
 * template, exactly as before. `oneLine` is for message_chat, which is typed as a
 * single line: the notes follow the arguments on the same line.
 */
export function renderPrompt(params: Record<string, unknown>, textKey: 'brief_template' | 'template', vars: Record<string, string>, oneLine = false): string {
  const inv = readInvoke(params);
  if (!inv) return renderBrief(String(params[textKey] ?? ''), vars);
  const head = `/${inv.name} ${renderBrief(inv.args, vars)}`.trimEnd();
  const notes = renderBrief(String(params.notes ?? ''), vars).trim();
  if (!notes) return head;
  return oneLine ? `${head} Additional instructions: ${notes}` : `${head}\n\n${notes}`;
}

/* ------------------------------------------------------------ start_chat */

export interface PickOpts {
  lane?: string; // default 'tp' (the previous build's only lane)
  exclude?: Iterable<string>; // pane ids not to use (own pane, just-launched panes)
  focused?: string | null; // the pane the user is looking at: never typed into
}

/**
 * The first idle shell pane in a loom-<lane>-N session, in session/window/pane
 * order. Existing panes only: there is no split fallback, by design. Excludes
 * other lanes, un-numbered sessions, any pane running an agent, node, nvim or
 * anything else that is not a bare shell, grouped panes, and the focused pane.
 */
export function pickPane(panes: LanePane[], opts: PickOpts = {}): LanePane | null {
  const lane = opts.lane ?? 'tp';
  const exclude = new Set(opts.exclude ?? []);
  const free = panes.filter(
    (p) =>
      parseLane(p.tmux_session)?.lane === lane &&
      SHELL.test(p.command) &&
      !p.agent &&
      !p.group &&
      !exclude.has(p.pane_id) &&
      p.pane_id !== opts.focused,
  );
  free.sort(
    (a, b) =>
      parseLane(a.tmux_session)!.n - parseLane(b.tmux_session)!.n ||
      Number(a.window_index) - Number(b.window_index) ||
      Number(a.pane_index) - Number(b.pane_index),
  );
  return free[0] ?? null;
}

export const paneWhere = (p: LanePane): string => `${p.tmux_session}:${p.window_index}.${p.pane_index}`;

/** perm 'inherit' follows perm_watchers; 'normal'/'skip' override it for this watcher only. */
export function settingsForPerm(s: LaunchSettings, perm: unknown): LaunchSettings {
  if (perm === 'normal') return { ...s, skipWatchers: false };
  if (perm === 'skip') return { ...s, skipWatchers: true };
  return s;
}

/**
 * What gets typed into the pane: the brief rides as the CLI argument, read from its file.
 * With rc_watchers on, Remote Control is named after the pane; skip-permissions
 * follows perm_watchers (src/launch.ts). The name must be passed: `--remote-control [name]` would otherwise eat the brief.
 */
export function launchCommand(projectDir: string, briefPath: string, rcName: string, settings?: LaunchSettings): string {
  return claudeCommand({ kind: 'watcher', dir: projectDir, promptFile: briefPath, name: rcName }, settings);
}

/** Type the command literally, then Enter as a separate send-keys. */
export async function tmuxLaunch(paneId: string, command: string, run: TmuxRunner = defaultRun, settleMs = 800): Promise<void> {
  run(['send-keys', '-t', paneId, '-l', command]);
  await new Promise((r) => setTimeout(r, settleMs));
  run(['send-keys', '-t', paneId, 'Enter']);
}

/* ------------------------------------------------------------ message_chat */

export const watcherPrefix = (label: string): string => `[from Loom watcher "${label.replace(/"/g, "'").slice(0, 60)}"]`;

export type RelayOutcome = { status: 'sent' | 'queued' | 'failed'; detail: string };

/**
 * Type a message into a chat's pane, the way the orchestrator relays: never
 * into the pane the user is focused on. That one is queued in
 * orchestrator_outbox, which the board tick delivers once they leave it.
 */
export function relayFromWatcher(db: Database.Database, deps: RelayDeps, label: string, agent: Agent, sessionId: string, text: string, opts: { bare?: boolean } = {}): RelayOutcome {
  const body = text.replace(/\s+/g, ' ').trim();
  if (!body) return { status: 'failed', detail: 'empty message' };
  const t = deps.resolve(agent, sessionId);
  const now = deps.now();
  if (!t) return { status: 'failed', detail: 'that chat is not running; it has no pane to type into' };
  // A slash command only runs when it is the first thing typed, so it goes without the prefix.
  const msg = opts.bare ? body : `${watcherPrefix(label)} ${body}`;
  if (deps.focused() === t.pane_id) {
    db.prepare(`INSERT INTO orchestrator_outbox (agent, session_id, label, text, queued_at) VALUES (?, ?, ?, ?, ?)`).run(agent, sessionId, t.label, msg, now);
    logOrch(db, 'queued', t.label, body, now);
    return { status: 'queued', detail: `${t.label} is the pane the user is looking at; queued until they leave it` };
  }
  const r = deps.send(t.pane_id, msg, agent);
  return r.ok ? { status: 'sent', detail: `sent to ${t.label}` } : { status: 'failed', detail: r.detail };
}
