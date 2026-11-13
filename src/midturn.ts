/**
 * Which live panes are mid-turn, read off the panes themselves.
 *
 * The snapshot used to ask this one pane at a time: a `tmux capture-pane`
 * process per live chat, synchronously, on Electron's main thread. Measured
 * with 23 live chats: 62 ms of the snapshot's ~115 ms, repeated every time the
 * 1.5 s snapshot memo expired. One tmux process now captures every pane, with a
 * marker line before each so the output splits back per pane: ~5 ms.
 *
 * tmux stops a command sequence at the first capture whose pane has gone (exit
 * 1), so on failure the panes after it are asked one at a time, as before.
 */

/**
 * THREE SIGNALS, because a pane can be working in two different ways.
 *
 * Will: "this page doesn't show that it's being worked on if the main agent
 * kicks it off to a sub-agent."
 *
 * Right, and the interrupt hint alone cannot catch it. While a subagent
 * runs, the PARENT is genuinely not mid-turn — it is blocked on the Task
 * tool, its prompt is free, and it writes nothing to its transcript. So it
 * fails the mtime proxy AND the interrupt test, while real work is going on
 * in its name.
 *
 * What the pane does show is an agent roster:
 *
 *     ✻ Waiting for 1 background agent to finish
 *       ⏺ main
 *       ◯ Explore  Confirming no CADE9C conversion migration exists   3m 46s
 *
 * Measured across 23 panes: 3 showed the interrupt hint, 2 showed a roster
 * line, and the two sets did not overlap — so this is additive, not a
 * widening. The 18 idle panes matched none of the three, which is the part
 * that matters: unlike the `✻` glyph, which persists as a finished-turn
 * summary, `◯` is present only while a subagent is live.
 *
 * Still fails closed. No match means not working, so a tmux hiccup cannot
 * invent activity.
 */
export function textIsMidTurn(out: string): boolean {
  return /esc to interrupt/i.test(out) || /^\s*◯ /m.test(out) || /Waiting for \d+ background agent/i.test(out);
}

// \x1e (record separator) never appears in a Claude/Codex status line. The marker
// carries the pane's position, not its id: display-message runs its text through
// strftime, which eats the `%` of `%42`.
const MARK = '\x1eloom-cap ';

/** tmux argv capturing the last lines of every pane in one process, each preceded by a marker line. Pure. */
export function batchCaptureArgs(paneIds: string[]): string[] {
  const args: string[] = [];
  paneIds.forEach((id, i) => {
    if (i) args.push(';');
    args.push('display-message', '-p', MARK + i, ';', 'capture-pane', '-p', '-t', id, '-S', '-4');
  });
  return args;
}

/** Split batchCaptureArgs(paneIds)' output back into pane id -> captured text, in order. Pure. */
export function splitBatchCapture(out: string, paneIds: string[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const chunk of out.split(MARK).slice(1)) {
    const nl = chunk.indexOf('\n');
    const id = paneIds[Number((nl < 0 ? chunk : chunk.slice(0, nl)).trim())];
    if (id) m.set(id, nl < 0 ? '' : chunk.slice(nl + 1));
  }
  return m;
}

/**
 * The set of pane ids whose screen says mid-turn. `run` is the sync tmux door
 * (src/tmux.ts). Fails closed: a pane tmux cannot answer for reads as not working.
 *
 * A pane that closed since it was listed stops the batch at its capture: keep
 * what came back before it, skip it, and batch the rest again. A failure that
 * got nowhere (tmux not answering, the breaker open) ends it.
 */
export function panesMidTurn(paneIds: string[], run: (args: string[]) => string): Set<string> {
  let rest = [...new Set(paneIds.filter(Boolean))];
  const got = new Map<string, string>();
  for (let tries = 0; rest.length && tries < 4; tries++) {
    try {
      for (const [id, text] of splitBatchCapture(run(batchCaptureArgs(rest)), rest)) got.set(id, text);
      break;
    } catch (e) {
      const partial = splitBatchCapture(String((e as { stdout?: unknown }).stdout ?? ''), rest);
      // The last marker printed is the pane whose capture failed.
      const failed = [...partial.keys()].pop();
      if (!failed) break;
      partial.delete(failed);
      for (const [id, text] of partial) got.set(id, text);
      rest = rest.slice(rest.indexOf(failed) + 1);
    }
  }
  const working = new Set<string>();
  for (const [id, text] of got) if (textIsMidTurn(text)) working.add(id);
  return working;
}
