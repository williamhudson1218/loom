import { execFileSync } from 'node:child_process';

export interface OpenTabsResult {
  ok: boolean;
  opened: number;
  detail: string;
  script: string; // the AppleScript that was (or would be) run
}

// Escape a string for embedding inside an AppleScript double-quoted literal.
function esc(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// Build the AppleScript that opens one Ghostty tab per session and attaches to it.
// Each tab runs `ta <session>` (the `tmux attach -t` alias) so tab titles stay
// "ta <session>" — the same convention goto.ts relies on to focus a tab later.
// When Ghostty was just launched it already has one empty tab, so `reuseFirst`
// puts the first session there instead of opening a redundant tab.
export function buildOpenTabsScript(sessions: string[], reuseFirst: boolean): string {
  const lines: string[] = [
    'tell application "Ghostty" to activate',
    'delay 0.4',
    'tell application "System Events" to tell process "Ghostty"',
  ];
  sessions.forEach((s, i) => {
    if (!(reuseFirst && i === 0)) {
      lines.push('  keystroke "t" using command down');
      lines.push('  delay 0.35');
    }
    lines.push(`  keystroke "ta ${esc(s)}"`);
    lines.push('  delay 0.1');
    lines.push('  key code 36'); // Return
    lines.push('  delay 0.25');
  });
  lines.push('end tell');
  return lines.join('\n');
}

function ghosttyRunning(): boolean {
  try {
    return (
      execFileSync('osascript', ['-e', 'application "Ghostty" is running'], { encoding: 'utf-8' }).trim() === 'true'
    );
  } catch {
    return false;
  }
}

// Open a Ghostty tab per session and attach each to its tmux session. Best-effort
// keystroke automation (requires Accessibility permission, same as goto.ts). If
// Ghostty isn't running it's launched first and its initial empty tab is reused.
export function openGhosttyTabs(sessions: string[], opts: { dryRun?: boolean } = {}): OpenTabsResult {
  if (sessions.length === 0) return { ok: true, opened: 0, detail: 'no sessions to open', script: '' };

  const running = opts.dryRun ? true : ghosttyRunning();
  if (!running) {
    try {
      execFileSync('open', ['-a', 'Ghostty']);
      execFileSync('sleep', ['0.9']); // let Ghostty create its first window/tab
    } catch (e) {
      return { ok: false, opened: 0, detail: 'failed to launch Ghostty: ' + (e as Error).message, script: '' };
    }
  }

  const script = buildOpenTabsScript(sessions, /* reuseFirst */ !running);
  if (opts.dryRun) return { ok: true, opened: sessions.length, detail: 'dry-run', script };

  try {
    execFileSync('osascript', ['-e', script], { encoding: 'utf-8' });
    return { ok: true, opened: sessions.length, detail: `opened ${sessions.length} tab(s)`, script };
  } catch (e) {
    return {
      ok: false,
      opened: 0,
      detail: 'osascript failed (grant Accessibility to your terminal): ' + (e as Error).message,
      script,
    };
  }
}
