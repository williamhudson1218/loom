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

// Resume a stale chat into an idle (shell) pane: type the resume command into
// that pane, run it, then focus the pane.
export function resumeInPane(paneId: string, projectDir: string, sessionId: string): GotoResult {
  let tmuxSession = '';
  try {
    tmuxSession = execFileSync('tmux', ['display-message', '-p', '-t', paneId, '#{session_name}'], {
      encoding: 'utf-8',
    }).trim();
  } catch {
    /* focus will be skipped */
  }
  const cmd = `cd ${shq(projectDir)} && claude --resume ${shq(sessionId)} --dangerously-skip-permissions`;
  try {
    execFileSync('tmux', ['send-keys', '-t', paneId, cmd, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'send-keys failed: ' + (e as Error).message };
  }
  const focus = tmuxSession ? gotoPane(paneId, tmuxSession) : { ok: true, detail: 'no focus' };
  return { ok: true, detail: 'resumed; ' + focus.detail };
}
