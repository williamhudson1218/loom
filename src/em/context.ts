import fs from 'node:fs';

export interface ContextUsage {
  tokens: number;   // input + cache_read + cache_creation — what occupies the window
  model: string;
  limit: number;
  fraction: number; // tokens / limit
}

const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  'claude-opus-5': 200_000,
  'claude-sonnet-5': 200_000,
  'claude-fable-5': 200_000,
  'claude-haiku-4-5-20251001': 200_000,
};

const DEFAULT_LIMIT = 200_000;
const TIERS = [200_000, 500_000, 1_000_000];

// A 1M-context variant records the same model id as its 200k sibling (verified:
// a [1m] session logs "claude-opus-5"), and nothing else in the transcript names
// the window — so the id alone cannot identify it. If observed usage already
// exceeds the mapped limit, the session is demonstrably on a larger tier —
// promote, rather than report an impossible >100% and fire BLOATED on every turn
// for the rest of the session. This matters in practice: 6 of 8 live sessions
// sampled were already past 200k.
//
// CAVEAT for calibration: the promoted tier is a LOWER BOUND on the true window,
// so `fraction` is an UPPER BOUND on real pressure. A 1M session sitting at 430k
// reads as 86% of 500k when it is really 43% of 1M. BLOATED therefore skews
// early, and shadow-mode data should be read with that bias in mind.
export function limitFor(model: string, observed: number): number {
  const base = MODEL_CONTEXT_LIMITS[model] ?? DEFAULT_LIMIT;
  if (observed <= base) return base;
  return TIERS.find((t) => t >= observed) ?? observed;
}

// Tail-read a transcript and return the context size at its most recent assistant
// turn. Bounded by `bytes` so cost is independent of transcript size, mirroring
// readTranscript in src/transcript.ts.
export function readContextUsage(jsonlPath: string, opts: { bytes?: number } = {}): ContextUsage | null {
  const bytes = opts.bytes ?? 200_000;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(jsonlPath);
  } catch {
    return null;
  }
  const start = Math.max(0, stat.size - bytes);
  let text: string;
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf-8');
  } catch {
    return null;
  }
  let lines = text.split('\n');
  if (start > 0) lines = lines.slice(1); // drop the partial first line

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap reject before the JSON.parse — most lines have no usage block.
    if (!line.trim() || !line.includes('"usage"')) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const u = o?.message?.usage;
    if (!u) continue;
    const tokens =
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (!tokens) continue;
    const model = typeof o.message.model === 'string' ? o.message.model : '';
    const limit = limitFor(model, tokens);
    return { tokens, model, limit, fraction: tokens / limit };
  }
  return null;
}
