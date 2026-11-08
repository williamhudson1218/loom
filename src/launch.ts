import fs from 'node:fs';
import Database from 'better-sqlite3';
import { DB_PATH } from './paths.ts';
import { getSetting } from './settingsSchema.ts';

// The one place a `claude` command line is built. Chats (fresh, resume, branch),
// watcher workers and the orchestrator all come through claudeCommand(), so the
// permission flag, Remote Control and the binary path each have a single owner:
//
//   --dangerously-skip-permissions   only when that kind's perm_* setting is `skip`
//   --remote-control <name>          watchers when rc_watchers is on; the orchestrator always
//   claude                           or the claude_bin setting
//
// Codex commands are not built here (they take neither flag).

export function shq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

/**
 * Quote any text as ONE shell word that survives being typed into a pane by
 * send-keys: `$'…'` (ANSI-C quoting, zsh and bash alike) spells newlines, tabs
 * and every other control character as escapes, so a multi-line prompt goes in
 * as a single line and nothing in it can submit early or be read as a key.
 */
export function ansiQuote(s: string): string {
  let out = "$'";
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '\\') out += '\\\\';
    else if (ch === "'") out += "\\'";
    else if (ch === '\n') out += '\\n';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\r') out += '\\r';
    else if (c < 0x20 || c === 0x7f) out += '\\x' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out + "'";
}

// Resuming a long-running session pops a "resume from a summary, or the full
// session as-is?" prompt before the pane is usable. Loom resumes mean "put this
// chat back exactly as it was", so the two thresholds that trigger that prompt
// are pushed out of reach on every command Loom launches.
//
// It has to be the real environment: Claude Code applies a settings.json `env`
// block through an allowlist, and these keys are not on it.
export const RESUME_FULL_ENV =
  'CLAUDE_CODE_RESUME_THRESHOLD_MINUTES=99999999 CLAUDE_CODE_RESUME_TOKEN_THRESHOLD=999999999';

/* ------------------------------------------------------------ settings */

export interface LaunchSettings {
  /** The claude_bin setting; '' means plain `claude` on PATH. */
  claudeBin: string;
  skipChats: boolean;
  skipWatchers: boolean;
  skipOrchestrator: boolean;
  rcWatchers: boolean;
}

/** A new install: normal permission mode, no Remote Control. */
export const SAFE_LAUNCH_SETTINGS: LaunchSettings = {
  claudeBin: '',
  skipChats: false,
  skipWatchers: false,
  skipOrchestrator: false,
  rcWatchers: false,
};

/** What an install from before settings schema 2 resolves to: skip-permissions everywhere, Remote Control on. */
export const LEGACY_LAUNCH_SETTINGS: LaunchSettings = {
  claudeBin: '',
  skipChats: true,
  skipWatchers: true,
  skipOrchestrator: true,
  rcWatchers: true,
};

export function readLaunchSettings(db: Database.Database): LaunchSettings {
  return {
    claudeBin: getSetting(db, 'claude_bin'),
    skipChats: getSetting(db, 'perm_chats') === 'skip',
    skipWatchers: getSetting(db, 'perm_watchers') === 'skip',
    skipOrchestrator: getSetting(db, 'perm_orchestrator') === 'skip',
    rcWatchers: getSetting(db, 'rc_watchers'),
  };
}

let source: (() => LaunchSettings) | null = null;

/** Override where claudeCommand reads settings from (tests, or a caller that already holds the db). null restores the default. */
export function setLaunchSettingsSource(fn: (() => LaunchSettings) | null): void {
  source = fn;
}

/**
 * The settings in force right now. Read fresh on every launch (launches are rare
 * and a permission change must apply to the next one), through a short-lived
 * read-only connection so no caller has to thread a db through. Anything that
 * goes wrong reads as the safe defaults, never as skip-permissions.
 */
export function currentLaunchSettings(): LaunchSettings {
  if (source) return source();
  if (process.env.VITEST) return SAFE_LAUNCH_SETTINGS;
  try {
    if (!fs.existsSync(DB_PATH)) return SAFE_LAUNCH_SETTINGS;
    const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      return readLaunchSettings(db);
    } finally {
      db.close();
    }
  } catch {
    return SAFE_LAUNCH_SETTINGS;
  }
}

/* ------------------------------------------------------------ builder */

export type ClaudeKind = 'chat' | 'resume' | 'branch' | 'watcher' | 'orch';

export interface ClaudeCommandInput {
  kind: ClaudeKind;
  /** Directory the command `cd`s into first. */
  dir: string;
  /** chat: --session-id when given. resume/branch: the session to resume. orch: new id, or the one to resume. */
  sid?: string;
  /** First turn. Quoted here (ANSI-C for most kinds; a branch seed is plain single-quoted). */
  prompt?: string;
  /** watcher/orch: the Remote Control display name (used only when rc_* is on). orch: also --name. */
  name?: string;
  /** watcher: a file whose contents ride as the prompt argument ("$(cat file)"). */
  promptFile?: string;
  /** orch only. */
  resume?: boolean;
  mcpConfig?: string;
  systemPromptFile?: string;
}

function binary(s: LaunchSettings): string {
  const b = s.claudeBin.trim();
  if (!b) return 'claude';
  return /^[A-Za-z0-9_./+@:-]+$/.test(b) ? b : shq(b);
}

/** The shell line typed into a pane to start (or resume) a Claude Code session. */
export function claudeCommand(input: ClaudeCommandInput, settings: LaunchSettings = currentLaunchSettings()): string {
  const cd = `cd ${shq(input.dir)} && `;
  const claude = binary(settings);
  const skip = ' --dangerously-skip-permissions';
  switch (input.kind) {
    case 'chat': {
      const sid = input.sid ? ` --session-id ${shq(input.sid)}` : '';
      const prompt = input.prompt?.trim() ? ' ' + ansiQuote(input.prompt) : '';
      return cd + `${claude}${settings.skipChats ? skip : ''}${sid}${prompt}`;
    }
    case 'resume':
    case 'branch': {
      const fork = input.kind === 'branch' ? ' --fork-session' : '';
      const prompt = !input.prompt?.trim() ? '' : input.kind === 'branch' ? ' ' + shq(input.prompt) : ' ' + ansiQuote(input.prompt);
      return cd + `${RESUME_FULL_ENV} ${claude} --resume ${shq(input.sid ?? '')}${fork}${settings.skipChats ? skip : ''}${prompt}`;
    }
    case 'watcher': {
      // The name must be passed: `--remote-control [name]` would otherwise eat the brief.
      const rc = settings.rcWatchers ? ` --remote-control ${shq(input.name ?? '')}` : '';
      const brief = input.promptFile ? ` "$(cat ${shq(input.promptFile)})"` : '';
      return cd + `${claude}${settings.skipWatchers ? skip : ''}${rc}${brief}`;
    }
    case 'orch': {
      const name = input.name ?? '';
      const flags =
        (settings.skipOrchestrator ? skip : '') +
        // Always on: the orchestrator is the one session meant to be reached from a phone.
        ` --remote-control ${shq(name)}` +
        ` --name ${shq(name)}` +
        (input.mcpConfig ? ` --mcp-config ${shq(input.mcpConfig)}` : '') +
        (input.systemPromptFile ? ` --append-system-prompt "$(cat ${shq(input.systemPromptFile)})"` : '');
      const prompt = input.prompt?.trim() ? ' ' + ansiQuote(input.prompt) : '';
      if (input.resume) return cd + `${RESUME_FULL_ENV} ${claude} --resume ${shq(input.sid ?? '')}${flags}${prompt}`;
      return cd + `${claude} --session-id ${shq(input.sid ?? '')}${flags}${prompt}`;
    }
  }
}
