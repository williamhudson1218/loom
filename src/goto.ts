import { execFileSync } from 'node:child_process';

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

// Type a message into the Claude session running in a pane and submit it.
// -l sends the text literally; a separate Enter submits.
export function sendToPane(paneId: string, text: string): GotoResult {
  const clean = text.replace(/\r?\n/g, ' ').trim(); // Claude submits on Enter; keep one line
  if (!clean) return { ok: false, detail: 'empty message' };
  try {
    execFileSync('tmux', ['send-keys', '-t', paneId, '-l', clean]);
    execFileSync('tmux', ['send-keys', '-t', paneId, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  return { ok: true, detail: 'sent' };
}

// Close (exit) the Claude session running in a pane, freeing the pane back to a
// shell. Sends Ctrl-C twice (the second confirms the "press again to exit"),
// exactly like quitting Claude by hand. The session is persisted on disk, so it
// stays resumable from Loom. A typed "/exit" does NOT work via send-keys.
export function closeSession(paneId: string): GotoResult {
  try {
    execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
    execFileSync('tmux', ['send-keys', '-t', paneId, 'C-c']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  return { ok: true, detail: 'sent Ctrl-C x2' };
}

// Seed prompt submitted as the first turn of a branched session. A fork carries
// the original's full transcript, so the model can't otherwise tell it was
// forked (it looks identical to a resume from the inside) — this tells it.
const BRANCH_SEED =
  'Heads up from Loom: this is a forked branch of a previous Claude Code session. ' +
  "You carry that session's full context, but this is now an independent branch with a new " +
  'session id — nothing you do here affects the original session, and there is no need to redo ' +
  'prior work. Briefly acknowledge that you understand this is a fork, then wait for my next instruction.';

// Launch Claude into an idle (shell) pane: type the command into that pane, run
// it, then focus the pane. With `fork`, --fork-session branches the resumed
// context into a NEW session id, leaving the original session untouched, and a
// seed prompt is passed positionally so the new session knows it was forked.
function launchInPane(
  paneId: string,
  projectDir: string,
  sessionId: string,
  fork: boolean,
): GotoResult {
  let tmuxSession = '';
  try {
    tmuxSession = execFileSync('tmux', ['display-message', '-p', '-t', paneId, '#{session_name}'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    /* focus will be skipped */
  }
  const forkFlag = fork ? ' --fork-session' : '';
  const seedArg = fork ? ' ' + shq(BRANCH_SEED) : '';
  const cmd = `cd ${shq(projectDir)} && claude --resume ${shq(sessionId)}${forkFlag} --dangerously-skip-permissions${seedArg}`;
  try {
    execFileSync('tmux', ['send-keys', '-t', paneId, cmd, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  const focus = tmuxSession ? gotoPane(paneId, tmuxSession) : { ok: true, detail: 'no focus' };
  return { ok: true, detail: (fork ? 'branched; ' : 'resumed; ') + focus.detail };
}

// Resume a stale chat into an idle (shell) pane: continue the original session.
export function resumeInPane(paneId: string, projectDir: string, sessionId: string): GotoResult {
  return launchInPane(paneId, projectDir, sessionId, false);
}

// Branch a chat into an idle (shell) pane: fork the existing context into a new
// session (original left running/resumable) and drop it into the chosen pane.
export function branchInPane(paneId: string, projectDir: string, sessionId: string): GotoResult {
  return launchInPane(paneId, projectDir, sessionId, true);
}
