import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { tmux } from './tmux.ts';
import { isViewSession } from './tmux.ts';
import { parseLane } from './compact.ts';
import { openDb } from './db.ts';
import { getSetting } from './settingsSchema.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Where "jump to this chat" lands.
//
//   inside    Loom's own window: select the chat there (the default for new installs)
//   ghostty   focus the Ghostty tab titled for the tmux session
//   iterm2    switch the attached tmux client to the chat, select the iTerm2 tab on its tty
//   terminal  the same for Terminal.app
//
// The `terminal` setting stores the choice. With no setting the answer depends on
// the machine: a workspace of `loom-<lane>-<n>` sessions means Ghostty (that is
// the setup Loom grew up in, and nothing about it changes); anything else means
// inside. setup.sh writes `terminal=inside` for a new install.

export type TerminalKind = 'inside' | 'ghostty' | 'iterm2' | 'terminal';
export const TERMINAL_KINDS: TerminalKind[] = ['inside', 'ghostty', 'iterm2', 'terminal'];

export interface GotoResult {
  ok: boolean;
  detail: string;
}

interface AppInfo {
  label: string; // shown in the menu
  app: string; // `open -a` name
}
export const TERMINAL_APPS: Record<Exclude<TerminalKind, 'inside'>, AppInfo> = {
  ghostty: { label: 'Ghostty', app: 'Ghostty' },
  iterm2: { label: 'iTerm2', app: 'iTerm' },
  terminal: { label: 'Terminal', app: 'Terminal' },
};

export function parseTerminalKind(v: unknown): TerminalKind | null {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return (TERMINAL_KINDS as string[]).includes(s) ? (s as TerminalKind) : null;
}

/** The terminal in effect: the stored choice, else Ghostty on a lane workspace, else inside Loom. */
export function resolveTerminal(stored: unknown, lanesInUse: boolean): TerminalKind {
  return parseTerminalKind(stored) ?? (lanesInUse ? 'ghostty' : 'inside');
}

/** Whether the UI offers Codex: `codex_visible` on/off, or auto = only when ~/.codex exists. */
export function codexVisible(
  db: Database.Database,
  exists: (p: string) => boolean = fs.existsSync,
  home: string = os.homedir(),
): boolean {
  const v = getSetting(db, 'codex_visible');
  return v === 'on' ? true : v === 'off' ? false : exists(path.join(home, '.codex'));
}

/** The name the menu shows ("Ghostty"); '' for inside, which has no external app. */
export function terminalLabel(kind: TerminalKind): string {
  return kind === 'inside' ? '' : TERMINAL_APPS[kind].label;
}

/* ------------------------------------------------------------ tmux clients */

export interface TmuxClient {
  tty: string;
  session: string;
  activity: number;
}

export const CLIENT_FORMAT = '#{client_tty}\t#{client_session}\t#{client_activity}';

export function parseClients(raw: string): TmuxClient[] {
  const out: TmuxClient[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const [tty = '', session = '', activity = '0'] = line.split('\t');
    if (!tty) continue;
    out.push({ tty: normalizeTty(tty), session, activity: Number(activity) || 0 });
  }
  return out;
}

/** `ttys003`, `/dev/ttys003` and `/dev/ttys003\n` all name one device. */
export function normalizeTty(tty: string): string {
  const t = tty.trim();
  if (!t) return '';
  return t.startsWith('/dev/') ? t : '/dev/' + t.replace(/^\/+/, '');
}

export function ttyMatches(a: string, b: string): boolean {
  const x = normalizeTty(a);
  return !!x && x === normalizeTty(b);
}

/**
 * The client an external terminal is showing. Loom's own embedded terminal
 * attaches `loom-view-*` sessions and is never an external client. A client
 * already on the target session wins (no switch needed), else the most recently
 * active one.
 */
export function pickClient(clients: TmuxClient[], session: string): TmuxClient | null {
  const real = clients.filter((c) => !isViewSession(c.session));
  if (!real.length) return null;
  const same = real.filter((c) => c.session === session);
  const pool = same.length ? same : real;
  return [...pool].sort((a, b) => b.activity - a.activity)[0] ?? null;
}

/* -------------------------------------------------------------- AppleScript */

// Ghostty: click the tab whose title ends with the tmux session name (tabs are
// titled "ta <session>" / "tn <session>"). Unchanged from before the adapters.
export const GHOSTTY_FOCUS_SCRIPT = `
on run argv
  set sess to item 1 of argv
  tell application "Ghostty" to activate
  delay 0.12
  tell application "System Events" to tell process "Ghostty"
    repeat with w in windows
      if exists tab group 1 of w then
        repeat with t in (radio buttons of tab group 1 of w)
          if (title of t) ends with sess then
            click t
            return "ok"
          end if
        end repeat
      end if
    end repeat
  end tell
  return "tab-not-found"
end run`;

// iTerm2 and Terminal.app expose each tab's tty, so the tab is found by the
// device the attached tmux client runs on, not by a title. argv: the tty.
export const ITERM2_SELECT_SCRIPT = `
on run argv
  set wanted to item 1 of argv
  tell application "iTerm"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s) is wanted then
            select w
            tell w to select t
            tell t to select s
            return "ok"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "tab-not-found"
end run`;

export const TERMINAL_APP_SELECT_SCRIPT = `
on run argv
  set wanted to item 1 of argv
  tell application "Terminal"
    activate
    repeat with w in windows
      repeat with t in tabs of w
        if (tty of t) is wanted then
          set selected of t to true
          set index of w to 1
          return "ok"
        end if
      end repeat
    end repeat
  end tell
  return "tab-not-found"
end run`;

/* ----------------------------------------------------------------- adapters */

export interface JumpTarget {
  paneId: string;
  session: string;
}

export interface JumpDeps {
  tmux: (args: string[]) => string;
  osascript: (script: string, args: string[]) => string;
  open: (app: string) => void;
  /** `inside`: ask Loom's own window to show this pane's chat. */
  insideFocus: (paneId: string) => void;
}

export interface TerminalAdapter {
  kind: TerminalKind;
  label: string;
  focus(target: JumpTarget, deps: JumpDeps): GotoResult;
}

function selectInTmux(target: JumpTarget, deps: JumpDeps): GotoResult | null {
  try {
    deps.tmux(['select-window', '-t', target.paneId]);
    deps.tmux(['select-pane', '-t', target.paneId]);
    return null;
  } catch (e) {
    return { ok: false, detail: 'tmux select failed: ' + (e as Error).message };
  }
}

const ghosttyAdapter: TerminalAdapter = {
  kind: 'ghostty',
  label: 'Ghostty',
  // tmux selection is the reliable core; Ghostty focus is best-effort (Accessibility).
  focus(target, deps) {
    const bad = selectInTmux(target, deps);
    if (bad) return bad;
    try {
      const r = deps.osascript(GHOSTTY_FOCUS_SCRIPT, [target.session]).trim();
      return { ok: true, detail: `tmux ok; ghostty ${r}` };
    } catch (e) {
      return { ok: true, detail: 'tmux ok; ghostty focus failed (grant Accessibility): ' + (e as Error).message };
    }
  },
};

function tabAdapter(kind: 'iterm2' | 'terminal', script: string): TerminalAdapter {
  const { label, app } = TERMINAL_APPS[kind];
  return {
    kind,
    label,
    focus(target, deps) {
      const bad = selectInTmux(target, deps);
      if (bad) return bad;
      let client: TmuxClient | null = null;
      try {
        client = pickClient(parseClients(deps.tmux(['list-clients', '-F', CLIENT_FORMAT])), target.session);
      } catch {
        /* no server answer: handled as no client below */
      }
      if (!client) return { ok: false, detail: `tmux selected the pane, but no tmux client is attached in ${label} (run tmux attach there)` };
      try {
        if (client.session !== target.session) deps.tmux(['switch-client', '-c', client.tty, '-t', target.session]);
      } catch (e) {
        return { ok: false, detail: 'tmux switch-client failed: ' + (e as Error).message };
      }
      try {
        const r = deps.osascript(script, [client.tty]).trim();
        if (r === 'ok') return { ok: true, detail: `tmux ok; ${label} tab selected` };
        // The tty matched no tab (another app owns the client): fall back to just raising the app.
        deps.open(app);
        return { ok: true, detail: `tmux ok; ${label} ${r}; brought forward` };
      } catch (e) {
        try {
          deps.open(app);
        } catch {
          /* nothing more to try */
        }
        return { ok: true, detail: `tmux ok; ${label} tab select failed (grant Automation): ` + (e as Error).message };
      }
    },
  };
}

const insideAdapter: TerminalAdapter = {
  kind: 'inside',
  label: 'Loom',
  focus(target, deps) {
    const bad = selectInTmux(target, deps);
    if (bad) return bad;
    deps.insideFocus(target.paneId);
    return { ok: true, detail: 'tmux ok; selected in Loom' };
  },
};

const ADAPTERS: Record<TerminalKind, TerminalAdapter> = {
  inside: insideAdapter,
  ghostty: ghosttyAdapter,
  iterm2: tabAdapter('iterm2', ITERM2_SELECT_SCRIPT),
  terminal: tabAdapter('terminal', TERMINAL_APP_SELECT_SCRIPT),
};

export function adapterFor(kind: TerminalKind): TerminalAdapter {
  return ADAPTERS[kind];
}

export function jumpWith(kind: TerminalKind, target: JumpTarget, deps: JumpDeps): GotoResult {
  return adapterFor(kind).focus(target, deps);
}

/* ------------------------------------------------- inside-Loom focus requests */

// "Jump" for the inside terminal is a request to the page: the newest one is
// published on /api/data, and the page opens the chat in that pane when `seq`
// moves. The Electron main process registers a raiser so the window comes
// forward too.
let focusSeq = 0;
let focusPane = '';
let raiser: (() => void) | null = null;

export function setInsideRaiser(fn: (() => void) | null): void {
  raiser = fn;
}

export function requestInsideFocus(paneId: string): void {
  focusSeq++;
  focusPane = paneId;
  try {
    raiser?.();
  } catch {
    /* the page still gets the request */
  }
}

export function insideFocusState(): { seq: number; pane_id: string } {
  return { seq: focusSeq, pane_id: focusPane };
}

/* ----------------------------------------------------------------- settings */

export function getTerminalSetting(db: Database.Database): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'terminal'`).get() as { value: string } | undefined;
  return row?.value?.trim() ?? '';
}

export function setTerminalSetting(db: Database.Database, kind: TerminalKind): void {
  db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('terminal', ?)`).run(kind);
}

/** Any `loom-<lane>-<n>` session on the tmux server Loom drives. Never throws. */
export function lanesInUse(run: (args: string[]) => string = (a) => tmux(a)): boolean {
  try {
    return run(['list-sessions', '-F', '#{session_name}']).split('\n').some((s) => !!parseLane(s.trim()));
  } catch {
    return false;
  }
}

let memo: { at: number; kind: TerminalKind } | null = null;
const MEMO_MS = 3000;

/** The terminal in effect right now (setting + lane detection), briefly cached. Never throws. */
export function currentTerminal(): TerminalKind {
  const now = Date.now();
  if (memo && now - memo.at < MEMO_MS) return memo.kind;
  let stored = '';
  try {
    const db = openDb();
    try {
      stored = getTerminalSetting(db);
    } finally {
      db.close();
    }
  } catch {
    /* no db: the lane rule decides */
  }
  const kind = resolveTerminal(stored, parseTerminalKind(stored) ? false : lanesInUse());
  memo = { at: now, kind };
  return kind;
}

export function forgetTerminalMemo(): void {
  memo = null;
}

export const realJumpDeps = (): JumpDeps => ({
  tmux: (a) => tmux(a),
  osascript: (script, args) => execFileSync('osascript', ['-e', script, ...args], { encoding: 'utf-8' }),
  open: (app) => {
    execFileSync('open', ['-a', app]);
  },
  insideFocus: requestInsideFocus,
});
