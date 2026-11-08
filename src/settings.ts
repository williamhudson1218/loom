import type Database from 'better-sqlite3';
import { tmuxSocket } from './tmux.ts';
import { LANE_VIEWS, getLaneView, getTmuxSocket, parseLaneView, setLaneView, watchersFeatureOn } from './db.ts';
import { LAUNCH_TARGETS, getLaunchTarget, parseLaunchTarget, pickStrategy, setLaunchTarget } from './managed.ts';
import { readWorld } from './compact.ts';
import {
  TERMINAL_KINDS,
  getTerminalSetting,
  lanesInUse,
  parseTerminalKind,
  resolveTerminal,
  setTerminalSetting,
  terminalLabel,
  forgetTerminalMemo,
} from './terminal.ts';
import { getChannelProjects } from './slackowner.ts';
import { applySettingsPatch, getSetting, onSettingChanged, settingsRegistryView, setSetting, SOCKET_NAME, type SettingKey, type SettingView } from './settingsSchema.ts';

// The few settings a person changes: which terminal "jump" lands in, which tmux
// server Loom drives, whether the Slack watchers run, and the channel -> project
// mapping the Slack hotkey uses. Each is a row in the settings table with a
// default that keeps an existing install exactly as it was:
//
//   terminal        unset: Ghostty if a loom-<lane>-<n> workspace exists, else inside
//   tmux_socket     unset: the default server (setup.sh writes `loom` on a new install)
//   slack_watchers  unset: on (the owner's config); setup.sh writes `off` on a new install
//   launch_target   unset: lanes when lane sessions exist, else managed; setup.sh writes `managed`
//   lane_view       unset: zoom (a pane sharing its window is zoomed in Loom's view)

//
// Every key, its defaults and its validation live in the registry
// (src/settingsSchema.ts); this file keeps the older Settings view the page reads
// and the GET/PUT /api/settings handlers that carry both.

export function setWatchersFeature(db: Database.Database, on: boolean): void {
  setSetting(db, 'watchers_enabled', on);
}

/** Reopen a parked chat by itself when its thread gets a reply. Off unless set. */
export function autoResumeParked(db: Database.Database): boolean {
  return getSetting(db, 'auto_resume_parked', { env: false });
}

// A terminal change must drop the memoised resolution, whichever path wrote it.
onSettingChanged((c) => {
  if (c.key === 'terminal') forgetTerminalMemo();
});

export interface SettingsView {
  terminal: { stored: string; effective: string; label: string; kinds: string[] };
  tmux_socket: { stored: string; effective: string; env: boolean };
  slack_watchers: boolean;
  auto_resume_parked: boolean;
  channel_projects: Record<string, string>;
  launch_target: { stored: string; effective: string; options: string[] };
  lane_view: { effective: string; options: string[] };
}

export function readSettings(db: Database.Database, lanes: boolean = lanesInUse()): SettingsView {
  const stored = getTerminalSetting(db);
  const effective = resolveTerminal(stored, lanes);
  return {
    terminal: { stored, effective, label: terminalLabel(effective), kinds: TERMINAL_KINDS },
    tmux_socket: { stored: getTmuxSocket(db), effective: tmuxSocket(), env: !!process.env.LOOM_TMUX_SOCKET?.trim() },
    slack_watchers: watchersFeatureOn(db),
    auto_resume_parked: autoResumeParked(db),
    channel_projects: getChannelProjects(db),
    launch_target: { stored: getLaunchTarget(db), effective: pickStrategy(readWorld(), getLaunchTarget(db)), options: LAUNCH_TARGETS },
    lane_view: { effective: getLaneView(db), options: LANE_VIEWS },
  };
}

/** Apply a partial update. Unknown or malformed values reject the whole call. */
export function applySettings(db: Database.Database, body: Record<string, unknown>): { ok: true; restart: boolean } | { ok: false; detail: string } {
  let restart = false;
  if ('terminal' in body) {
    const k = parseTerminalKind(body.terminal);
    if (!k) return { ok: false, detail: 'terminal must be one of ' + TERMINAL_KINDS.join(', ') };
    setTerminalSetting(db, k);
    forgetTerminalMemo();
  }
  if ('tmux_socket' in body) {
    const s = typeof body.tmux_socket === 'string' ? body.tmux_socket.trim() : '';
    if (!SOCKET_NAME.test(s)) return { ok: false, detail: 'tmux_socket must be a short name (letters, digits, . _ -)' };
    if (s !== getTmuxSocket(db)) restart = true; // the runner reads it once at launch
    setSetting(db, 'tmux_socket', s);
  }
  if ('slack_watchers' in body) {
    if (typeof body.slack_watchers !== 'boolean') return { ok: false, detail: 'slack_watchers must be true or false' };
    setWatchersFeature(db, body.slack_watchers);
  }
  if ('auto_resume_parked' in body) {
    if (typeof body.auto_resume_parked !== 'boolean') return { ok: false, detail: 'auto_resume_parked must be true or false' };
    setSetting(db, 'auto_resume_parked', body.auto_resume_parked);
  }
  if ('launch_target' in body) {
    const t = parseLaunchTarget(body.launch_target);
    if (!t) return { ok: false, detail: 'launch_target must be one of ' + LAUNCH_TARGETS.join(', ') };
    setLaunchTarget(db, t);
  }
  if ('lane_view' in body) {
    const v = parseLaneView(body.lane_view);
    if (!v) return { ok: false, detail: 'lane_view must be one of ' + LANE_VIEWS.join(', ') };
    setLaneView(db, v);
  }
  return { ok: true, restart };
}

/* ------------------------------------------------------------ GET/PUT /api/settings */

// Route-agnostic handlers for the settings endpoint: the caller supplies the
// opened db and the parsed JSON body and sends `{status, body}`. The body keeps
// the older SettingsView fields at the top level (the current Settings page reads
// them) and adds `settings`: every registry key as {value, source, restart, ...}.
// A PUT takes `{key: value, ...}` with registry keys (plus `slack_watchers`, the
// old name of `watchers_enabled`); one bad key or value rejects the whole call.

export interface SettingsResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface SettingsHandlerOpts {
  lanes?: boolean;
  env?: NodeJS.ProcessEnv;
}

function fullView(db: Database.Database, opts: SettingsHandlerOpts): Record<string, unknown> & { settings: Record<SettingKey, SettingView> } {
  return { ...readSettings(db, opts.lanes ?? lanesInUse()), settings: settingsRegistryView(db, opts.env ?? process.env) };
}

export function settingsGet(db: Database.Database, opts: SettingsHandlerOpts = {}): SettingsResponse {
  return { status: 200, body: { ok: true, ...fullView(db, opts) } };
}

export function settingsPut(db: Database.Database, body: unknown, opts: SettingsHandlerOpts = {}): SettingsResponse {
  const r = applySettingsPatch(db, body);
  if (!r.ok) return { status: 400, body: r };
  // managed.ts memoises the launch target; its own setter is what clears that.
  if (r.changed.includes('launch_target')) setLaunchTarget(db, getSetting(db, 'launch_target', { env: false }));
  return { status: 200, body: { ok: true, restart: r.restart, changed: r.changed, ...fullView(db, opts) } };
}

export { watchersFeatureOn };
