// The live "working" line the phone shows under a chat's transcript: Claude Code's own
// spinner line, read off the pane with one `tmux capture-pane` and cleaned up.
//
//   "✻ Cogitating… (12s · ↓ 340 tokens · esc to interrupt)"  ->  "Cogitating… 12s · 340 tokens"
//   "✳ Waddling… (1m 8s · ↓ 2.1k tokens · thinking)"          ->  "Waddling… 1m 8s · 2.1k tokens · thinking"
//
// The finished line ("✻ Cooked for 25s · done 11:42 PM") has no ellipsis after the verb and
// no parenthesised elapsed time, so it never matches: an idle pane reads as null.

export interface LiveStatus {
  text: string;
  /** When the turn started (ms since epoch), from the elapsed time on the line. */
  since: number;
}

// The spinner glyph, the verb with its ellipsis, then "(<elapsed> · …)".
const SPINNER = /^\s*[·✢✳✶✻✽*∗●◐◓◑◒]\s+([A-Z][\w'’ -]{0,40}?)(?:…|\.\.\.)\s*\((\d+[hms](?:\s*\d+[ms])*)([^)]*)\)\s*$/u;
// Hints and noise that say nothing about the work.
const DROP = /^(?:esc to interrupt|ctrl\+\w to .*|thought for .*|\w+ to (?:hide|show) .*)$/i;

/** Seconds in "12s", "1m 8s", "2h 3m". */
export function elapsedSeconds(s: string): number {
  let n = 0;
  for (const m of s.matchAll(/(\d+)([hms])/g)) n += Number(m[1]) * (m[2] === 'h' ? 3600 : m[2] === 'm' ? 60 : 1);
  return n;
}

/** One spinner line, cleaned; null when the line is not one. */
export function parseSpinnerLine(line: string, now = Date.now()): LiveStatus | null {
  const m = SPINNER.exec(line);
  if (!m) return null;
  const verb = m[1].trim();
  const elapsed = m[2].trim();
  const rest = m[3]
    .split('·')
    .map((p) => p.replace(/[↓↑]/g, '').replace(/\s+/g, ' ').trim())
    .filter((p) => p && !DROP.test(p));
  return { text: [`${verb}… ${elapsed}`, ...rest].join(' · '), since: now - elapsedSeconds(elapsed) * 1000 };
}

/** The newest spinner line in the last `tail` non-blank lines of a captured screen. */
export function parseLiveStatus(screen: string, now = Date.now(), tail = 15): LiveStatus | null {
  const lines = screen
    .split('\n')
    .map((l) => l.trimEnd())
    .filter(Boolean)
    .slice(-tail);
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = parseSpinnerLine(lines[i], now);
    if (s) return s;
  }
  return null;
}

/** Capture the pane (read-only) and parse it. Null on any failure. */
export function paneLiveStatus(tmux: (args: string[]) => string, paneId: string, now = Date.now()): LiveStatus | null {
  if (!/^%\d+$/.test(paneId)) return null;
  try {
    return parseLiveStatus(tmux(['capture-pane', '-p', '-t', paneId]), now);
  } catch {
    return null;
  }
}
