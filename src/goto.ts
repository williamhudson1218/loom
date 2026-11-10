import { isViewSession, paneHome, tmux } from './tmux.ts';
import type { Agent } from './types.ts';
import { recordPlacement } from './placements.ts';
import { RESUME_FULL_ENV, ansiQuote, claudeCommand, promptArg, shq, type LaunchSettings } from './launch.ts';
import { currentTerminal, jumpWith, realJumpDeps, type GotoResult, type JumpDeps, type TerminalKind } from './terminal.ts';

export type { GotoResult };

// Jump to a chat's pane: select it within tmux, then bring the user's terminal to
// it. Which terminal is the `terminal` setting (src/terminal.ts): Ghostty tab
// focus as ever on a lane workspace, Loom's own window by default on a new
// install, or an iTerm2 / Terminal.app tab found by tty.
export function gotoPane(paneId: string, tmuxSession: string, kind: TerminalKind = currentTerminal(), deps: JumpDeps = realJumpDeps()): GotoResult {
  return jumpWith(kind, { paneId, session: tmuxSession }, deps);
}

export { ansiQuote, RESUME_FULL_ENV };

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
    tmux(['send-keys', '-t', paneId, '-l', clean]);
    if (agent === 'codex') settle();
    tmux(['send-keys', '-t', paneId, 'Enter']);
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
      tmux(['send-keys', '-t', paneId, '-l', '/quit']);
      settle();
      tmux(['send-keys', '-t', paneId, 'Enter']);
      settle();
      tmux(['send-keys', '-t', paneId, 'Enter']);
    } else {
      tmux(['send-keys', '-t', paneId, 'C-c']);
      tmux(['send-keys', '-t', paneId, 'C-c']);
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

export interface LaunchInput {
  projectDir: string;
  sessionId: string;
  sourceAgent: Agent;
  selectedAgent: Agent;
  fork?: boolean;
  // A brand-new thread: no session to resume, and `prompt` is its first turn,
  // passed as the agent's CLI argument rather than typed at its composer.
  fresh?: boolean;
  prompt?: string;
}

export interface LaunchInPaneInput extends LaunchInput {
  paneId: string;
  placementFile?: string;
  focus?: boolean; // jump Ghostty to the pane afterwards (default true)
}

const PANE_INFO_SEP = '~|LOOM|~';

export function buildLaunchCommand(input: LaunchInput, settings?: LaunchSettings): string {
  const cd = `cd ${shq(input.projectDir)} && `;
  if (input.fresh) {
    if (input.selectedAgent === 'codex') {
      const arg = input.prompt?.trim() ? ' ' + promptArg(input.prompt) : '';
      return cd + `codex${arg}`;
    }
    // A fresh Claude chat can be given its session id up front (--session-id), so
    // whoever starts it knows which transcript is theirs before it exists.
    return claudeCommand({ kind: 'chat', dir: input.projectDir, sid: input.sessionId, prompt: input.prompt }, settings);
  }
  // Native session ids are agent-specific. Cross-agent handoff starts a clean
  // session, so an id from the source agent can never be passed accidentally.
  if (input.sourceAgent !== input.selectedAgent) return cd + input.selectedAgent;
  // A resume can carry a first prompt (a parked chat resumed with the reply that woke it).
  const seed = input.fork ? branchSeed(input.selectedAgent) : input.prompt;
  if (input.selectedAgent === 'codex') {
    // Codex forks through its own subcommand rather than a resume flag, and both
    // `resume` and `fork` take an optional prompt as their second positional arg.
    const verb = input.fork ? 'fork' : 'resume';
    const seedArg = input.fork ? ' ' + promptArg(seed!, shq) : seed?.trim() ? ' ' + promptArg(seed) : '';
    return cd + `codex ${verb} ${shq(input.sessionId)}${seedArg}`;
  }
  return claudeCommand({ kind: input.fork ? 'branch' : 'resume', dir: input.projectDir, sid: input.sessionId, prompt: seed }, settings);
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
    paneInfo = tmux(['display-message', '-p', '-t', input.paneId,
      `#{session_name}${PANE_INFO_SEP}#{window_index}${PANE_INFO_SEP}#{pane_index}${PANE_INFO_SEP}#{pane_current_path}`]).trim().split(PANE_INFO_SEP);
    tmuxSession = paneInfo[0] ?? '';
    // display-message resolves a bare pane to an attached view of its group; use the real session.
    if (isViewSession(tmuxSession)) tmuxSession = paneHome(input.paneId, (a) => tmux(a))?.session ?? '';
  } catch {
    /* focus will be skipped */
  }
  const cmd = buildLaunchCommand(input);
  try {
    tmux(['send-keys', '-t', input.paneId, '-l', cmd]);
    tmux(['send-keys', '-t', input.paneId, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  if (input.sourceAgent === 'codex' && input.selectedAgent === 'codex' && !input.fork && !input.fresh) {
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
  const focus = tmuxSession && input.focus !== false ? gotoPane(input.paneId, tmuxSession) : { ok: true, detail: 'no focus' };
  const action = input.fresh ? 'started' : input.sourceAgent !== input.selectedAgent ? 'started fresh' : input.fork ? 'branched' : 'resumed';
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
