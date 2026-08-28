import { execFileSync } from 'node:child_process';
import type { Agent } from './types.ts';
import { recordPlacement } from './placements.ts';

export interface GotoResult {
  ok: boolean;
  detail: string;
}

// AppleScript: bring Ghostty forward and click the tab whose title ends with the
// tmux session name (tabs are titled "ta <session>" / "tn <session>").
const FOCUS_TAB_SCRIPT = `
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

// Jump to a chat's pane: select it within tmux, then focus its Ghostty tab.
// tmux selection is the reliable core; Ghostty focus is best-effort (Accessibility).
export function gotoPane(paneId: string, tmuxSession: string): GotoResult {
  try {
    execFileSync('tmux', ['select-window', '-t', paneId]);
    execFileSync('tmux', ['select-pane', '-t', paneId]);
  } catch (e) {
    return { ok: false, detail: 'tmux select failed: ' + (e as Error).message };
  }
  try {
    const r = execFileSync('osascript', ['-e', FOCUS_TAB_SCRIPT, tmuxSession], {
      encoding: 'utf-8',
    }).trim();
    return { ok: true, detail: `tmux ok; ghostty ${r}` };
  } catch (e) {
    // tmux already selected the pane; only the Ghostty focus failed.
    return { ok: true, detail: 'tmux ok; ghostty focus failed (grant Accessibility): ' + (e as Error).message };
  }
}

function shq(s: string): string {
  return "'" + s.replace(/'/g, `'\\''`) + "'";
}

// Codex's composer needs a beat between receiving typed text and the Enter that
// submits it: an Enter sent in the same burst arrives before the text is processed
// and is swallowed, leaving the line sitting unsent. Claude submits either way.
// Synchronous by design — these helpers run inside a single request handler.
const COMPOSER_SETTLE_MS = 350;

function settle(ms: number = COMPOSER_SETTLE_MS): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// Type a message into the agent session running in a pane and submit it.
// -l sends the text literally; a separate Enter submits.
export function sendToPane(paneId: string, text: string, agent: Agent = 'claude'): GotoResult {
  const clean = text.replace(/\r?\n/g, ' ').trim(); // both agents submit on Enter; keep one line
  if (!clean) return { ok: false, detail: 'empty message' };
  try {
    execFileSync('tmux', ['send-keys', '-t', paneId, '-l', clean]);
    if (agent === 'codex') settle();
    execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  return { ok: true, detail: 'sent' };
}

// Close (exit) the agent session running in a pane, freeing the pane back to a
// shell. The session is persisted on disk either way, so it stays resumable.
//
// The two agents quit differently, and each only responds to its own sequence:
//   Claude — Ctrl-C twice (the second confirms "press again to exit"). A typed
//            "/exit" does NOT work via send-keys.
//   Codex  — "/quit" + Enter. Ctrl-C only interrupts the current turn; sending it
//            twice leaves Codex running at its composer, and Ctrl-D does nothing.
//
// The Codex path sends Enter twice: typing "/quit" pops up its slash-command
// completion list, and whether the first Enter accepts the completion or submits
// outright depends on whether that popup has rendered yet. The second Enter covers
// the accept case, and lands harmlessly on the freed shell otherwise.
export function closeSession(paneId: string, agent: Agent = 'claude'): GotoResult {
  try {
    if (agent === 'codex') {
      execFileSync('tmux', ['send-keys', '-t', paneId, '-l', '/quit']);
      settle();
      execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);
      settle();
      execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);
    } else {
      execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
      execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
    }
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  return { ok: true, detail: agent === 'codex' ? 'sent /quit' : 'sent Ctrl-C x2' };
}

// Seed prompt submitted as the first turn of a branched session. A fork carries
// the original's full transcript, so the model can't otherwise tell it was
// forked (it looks identical to a resume from the inside) — this tells it.
function branchSeed(agent: Agent): string {
  const name = agent === 'codex' ? 'Codex' : 'Claude Code';
  return (
    `Heads up from Loom: this is a forked branch of a previous ${name} session. ` +
    "You carry that session's full context, but this is now an independent branch with a new " +
    'session id — nothing you do here affects the original session, and there is no need to redo ' +
    'prior work. Briefly acknowledge that you understand this is a fork, then wait for my next instruction.'
  );
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

export interface LaunchInput {
  projectDir: string;
  sessionId: string;
  sourceAgent: Agent;
  selectedAgent: Agent;
  fork?: boolean;
}

export interface LaunchInPaneInput extends LaunchInput {
  paneId: string;
  placementFile?: string;
}

const PANE_INFO_SEP = '~|LOOM|~';

export function buildLaunchCommand(input: LaunchInput): string {
  const cd = `cd ${shq(input.projectDir)} && `;
  // Native session ids are agent-specific. Cross-agent handoff starts a clean
  // session, so an id from the source agent can never be passed accidentally.
  if (input.sourceAgent !== input.selectedAgent) return cd + input.selectedAgent;
  const seedArg = input.fork ? ' ' + shq(branchSeed(input.selectedAgent)) : '';
  if (input.selectedAgent === 'codex') {
    // Codex forks through its own subcommand rather than a resume flag, and both
    // `resume` and `fork` take an optional prompt as their second positional arg.
    const verb = input.fork ? 'fork' : 'resume';
    return cd + `codex ${verb} ${shq(input.sessionId)}${seedArg}`;
  }
  const forkFlag = input.fork ? ' --fork-session' : '';
  return cd + `${RESUME_FULL_ENV} claude --resume ${shq(input.sessionId)}${forkFlag} --dangerously-skip-permissions${seedArg}`;
}

// Launch an agent into an idle (shell) pane, then focus it. A fork starts a new
// session id carrying the original's context and receives a seed prompt explaining
// the branch. Both agents fork natively; forking ACROSS agents is impossible —
// neither can read the other's transcript — so that combination is rejected.
export function launchInPane(input: LaunchInPaneInput): GotoResult {
  if (input.fork && input.sourceAgent !== input.selectedAgent) {
    return { ok: false, detail: 'a session can only be branched with its own agent' };
  }
  let tmuxSession = '';
  let paneInfo: string[] = [];
  try {
    paneInfo = execFileSync('tmux', ['display-message', '-p', '-t', input.paneId,
      `#{session_name}${PANE_INFO_SEP}#{window_index}${PANE_INFO_SEP}#{pane_index}${PANE_INFO_SEP}#{pane_current_path}`], {
      encoding: 'utf-8',
    }).trim().split(PANE_INFO_SEP);
    tmuxSession = paneInfo[0] ?? '';
  } catch {
    /* focus will be skipped */
  }
  const cmd = buildLaunchCommand(input);
  try {
    execFileSync('tmux', ['send-keys', '-t', input.paneId, cmd, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  if (input.sourceAgent === 'codex' && input.selectedAgent === 'codex' && !input.fork) {
    try {
      recordPlacement({
        agent: 'codex', session_id: input.sessionId, pane_id: input.paneId,
        tmux_session: tmuxSession, window_index: paneInfo[1] ?? '', pane_index: paneInfo[2] ?? '',
        cwd: paneInfo[3] || input.projectDir, ts: Date.now(),
      }, input.placementFile);
    } catch {
      // Launch succeeded; placement registration is best-effort like the Claude hook.
    }
  }
  const focus = tmuxSession ? gotoPane(input.paneId, tmuxSession) : { ok: true, detail: 'no focus' };
  const action = input.sourceAgent !== input.selectedAgent ? 'started fresh' : input.fork ? 'branched' : 'resumed';
  return { ok: true, detail: action + '; ' + focus.detail };
}

// Resume a stale chat into an idle (shell) pane: continue the original session.
export function resumeInPane(paneId: string, projectDir: string, sessionId: string, agent: Agent = 'claude'): GotoResult {
  return launchInPane({ paneId, projectDir, sessionId, sourceAgent: agent, selectedAgent: agent, fork: false });
}

// Branch a chat into an idle (shell) pane: fork the existing context into a new
// session (original left running/resumable) and drop it into the chosen pane.
export function branchInPane(paneId: string, projectDir: string, sessionId: string, agent: Agent = 'claude'): GotoResult {
  return launchInPane({ paneId, projectDir, sessionId, sourceAgent: agent, selectedAgent: agent, fork: true });
}
