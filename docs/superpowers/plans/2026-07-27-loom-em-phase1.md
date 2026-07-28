# Loom EM — Phase 1 (Sense and Shadow) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Loom an autonomous engineering-manager layer that detects blocked, finished, and context-bloated sessions using zero-token signals, decides what to do about each via a single headless model call, and records every intended action to a ledger — running in shadow mode so a week of real data can calibrate the thresholds before it acts for real.

**Architecture:** A new `src/em/` module inside the always-on Loom server process (the same host that already runs the summarizer every 10 min and layout snapshots every 15s). A 30-second tick computes signals in plain TypeScript from the SQLite `chats` table plus a bounded tail-read of each transcript, and runs threshold detectors over them — this path never calls a model. A 5-minute tick triages findings the fast tick recorded, calling headless `claude -p` once per *new* finding, and hands the result to an executor that either performs the action or, in shadow mode, records what it would have done.

**Tech Stack:** TypeScript ESM (`.ts` extensions in imports), better-sqlite3, vitest, tsx. Actuation reuses the existing `sendToPane` / `closeSession` / `launchInPane` helpers in `src/goto.ts`. GitHub issues via the `gh` CLI.

**Spec:** `docs/superpowers/specs/2026-07-27-engineering-manager-design.md`

## Global Constraints

- **Phase 1 scope is BLOCKED, WRAPPABLE, BLOATED only.** STALLED, SPINNING, DRIFTING, and CONVERGING are Phase 2. Do not implement them. `DetectorKind` declares all seven so the ledger schema is stable, but only three are emitted.
- **`em_mode` defaults to `'shadow'`.** Shadow runs every detector and every triage call, composes every intervention, and writes it to `em_actions` with `shadow = 1` — but sends nothing to a pane and files no issue. There must be exactly one code path; shadow is a flag checked in one place (`perform()` in Task 7), never an `if` scattered through callers.
- **Nothing is deleted, only deferred.** Any action that removes work from a session files its GitHub issue *before* it acts. If issue creation fails, the removal does not proceed.
- **Never manage Loom's own sessions.** Chats whose `project_dir` is the Loom repo are filtered out in `computeSignals`, so the EM cannot act on the session implementing it.
- **DASHBOARD CLIENT-JS GOTCHA (has burned this repo 3×):** the dashboard's client JS lives inside a backtick template literal in `renderDashboard`. **Never put a regex literal there** — backslashes collapse (`/\/pull\/(\d+)/` becomes `//pull/(d+)/`, the `//` comments the line, and the whole page blanks). Use string methods instead. `tsc` and vitest cannot catch this because the JS is a string. Run `scripts/check-dashboard.sh` after any `dashboard.ts` edit.
- **Node ABI pinning:** `better-sqlite3` is compiled against the node in `.nvmrc`. If a native-module error appears, that is the cause — do not work around it in application code.
- **Typecheck:** `npx tsc --noEmit`. Never run `tsc` without `--noEmit`.
- **Tests:** `yarn test` (vitest run). A single file: `npx vitest run tests/<file> -t '<name>'`.
- **Commits:** this is the `loom` repo — committing and pushing is normal here, no permission needed. End every commit message with:
  ```
  Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
  ```
- **Import style:** relative, with explicit `.ts` extensions (`import { openDb } from '../db.ts'`). Match the existing codebase exactly.

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` *(modify)* | Add `files_written` to `ParsedChat` and `ChatRow` |
| `src/parser.ts` *(modify)* | Populate `files_written` from write tools only |
| `src/codexParser.ts` *(modify)* | Emit `files_written: []` (Codex records no file tools) |
| `src/schema.ts` *(modify)* | `files_written` column + migration; exec the EM schema |
| `src/indexer.ts` *(modify)* | Persist `files_written` on insert and update |
| `src/em/context.ts` *(create)* | Tail-read a transcript's last `usage` block → exact context size + per-model limit |
| `src/em/ledger.ts` *(create)* | `em_findings` / `em_actions` schema, `em_mode` setting, cooldowns, rate limit |
| `src/em/signals.ts` *(create)* | `ChatRow[]` + live map + fs → `EmSignals[]`. Pure of side effects beyond `stat` |
| `src/em/detectors.ts` *(create)* | Thresholds over `EmSignals` → `Finding[]`. Pure function |
| `src/em/triage.ts` *(create)* | The only model call site. Prompt builders + response parsers + runner |
| `src/em/actions.ts` *(create)* | Shadow-aware executor; GitHub issue filing; pane writes |
| `src/em/index.ts` *(create)* | `scanTick` (30s) and `triageTick` (5m) |
| `src/server.ts` *(modify)* | Wire both ticks into the existing interval block; add `/api/em` |
| `src/dashboard.ts` *(modify)* | Render the EM activity feed |

Tests mirror source under `tests/em/`.

---

### Task 1: Split written files out of `files_touched`

`parser.ts:13` folds `Read` in with `Edit`/`Write`/`NotebookEdit` into one `files_touched` column. Convergence detection (Phase 2) and the write-ratio signal both need writes only — in a monorepo, two sessions both reading `AGENTS.md` would otherwise score as a collision. Doing this now means Phase 1's indexing already backfills the column, so Phase 2 has history to work with.

**Files:**
- Modify: `src/types.ts:15-29` (`ParsedChat`), `src/types.ts:48-75` (`ChatRow`)
- Modify: `src/parser.ts:13`, `src/parser.ts:76-86`
- Modify: `src/codexParser.ts:58-73`
- Modify: `src/schema.ts` (CREATE block, `chats_v2` block, ALTER migrations)
- Modify: `src/indexer.ts:107-163` (`upsertChat`)
- Test: `tests/parser.test.ts`, `tests/indexer.test.ts`

**Interfaces:**
- Produces: `ParsedChat.files_written: string[]`, `ChatRow.files_written: string` (newline-joined, same encoding as `files_touched`).

- [ ] **Step 1: Write the failing test**

Append to `tests/parser.test.ts`, inside the existing `describe('parseJsonlFile', ...)`:

```typescript
  it('separates written files from merely-read files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-written-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'user', sessionId: 's', cwd: '/x', timestamp: '2026-07-27T12:00:00.000Z', message: { role: 'user', content: 'go' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-27T12:01:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/x/AGENTS.md' } },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.ts' } },
              { type: 'tool_use', name: 'Write', input: { file_path: '/x/b.ts' } },
            ],
          },
        }),
      ].join('\n'),
    );
    const c = await parseJsonlFile(f);
    expect(c.files_written).toEqual(['/x/a.ts', '/x/b.ts']);
    // files_touched keeps its existing meaning: reads included.
    expect(c.files_touched).toEqual(['/x/AGENTS.md', '/x/a.ts', '/x/b.ts']);
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/parser.test.ts -t 'separates written files'`
Expected: FAIL — `files_written` is `undefined`, so `toEqual(['/x/a.ts', '/x/b.ts'])` does not match.

- [ ] **Step 3: Add the field to the types**

In `src/types.ts`, inside `interface ParsedChat`, immediately after the `files_touched: string[];` line:

```typescript
  // Files the session actually CHANGED (Edit/Write/NotebookEdit). files_touched
  // also counts Read, so it cannot tell "both sessions edited this file" from
  // "both sessions read AGENTS.md" — the EM's collision and write-ratio signals
  // need writes only.
  files_written: string[];
```

In the same file, inside `interface ChatRow`, immediately after `files_touched: string;`:

```typescript
  files_written: string;
```

- [ ] **Step 4: Populate it in the Claude parser**

In `src/parser.ts`, immediately below the existing `FILE_TOOLS` declaration on line 13:

```typescript
const WRITE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
```

In `parseJsonlFile`, next to `const files = new Set<string>();`:

```typescript
  const written = new Set<string>();
```

Replace the tool-scanning block inside the assistant branch with:

```typescript
        for (const block of content) {
          if (block?.type !== 'tool_use') continue;
          if (!FILE_TOOLS.has(block.name)) continue;
          const fp = block.input?.file_path;
          if (typeof fp !== 'string') continue;
          files.add(fp);
          if (WRITE_TOOLS.has(block.name)) written.add(fp);
        }
```

In the returned object, immediately after `files_touched: Array.from(files),`:

```typescript
    files_written: Array.from(written),
```

- [ ] **Step 5: Satisfy the Codex parser**

Codex transcripts record no file-tool events, so its `files_touched` is already `[]`. In `src/codexParser.ts`, in the returned object immediately after `files_touched: [],`:

```typescript
    files_written: [],
```

- [ ] **Step 6: Run the parser test to verify it passes**

Run: `npx vitest run tests/parser.test.ts`
Expected: PASS, including the pre-existing `extracts core fields` case (`files_touched` behavior is unchanged).

- [ ] **Step 7: Write the failing persistence test**

Append to `tests/indexer.test.ts` (match the file's existing import list and DB-setup style — it already builds a `ParsedChat` and calls `upsertChat`):

```typescript
  it('persists files_written across insert and update', () => {
    const db = openDb(':memory:');
    const base = {
      agent: 'claude' as const,
      session_id: 'em-1',
      project_dir: '/x',
      jsonl_path: '/x/em-1.jsonl',
      started_at: 1,
      ended_at: 2,
      last_active_at: 2,
      message_count: 2,
      activity: {},
      files_touched: ['/x/AGENTS.md', '/x/a.ts'],
      files_written: ['/x/a.ts'],
      first_message: 'go',
      claude_auto_title: '',
      pr_url: '',
    };
    expect(upsertChat(db, base, 100, 100)).toBe('inserted');
    let row = db.prepare(`SELECT files_written FROM chats WHERE session_id = 'em-1'`).get() as { files_written: string };
    expect(row.files_written).toBe('/x/a.ts');

    // A changed transcript (new mtime) must refresh the column, not keep the old value.
    expect(upsertChat(db, { ...base, files_written: ['/x/a.ts', '/x/b.ts'] }, 200, 200)).toBe('updated');
    row = db.prepare(`SELECT files_written FROM chats WHERE session_id = 'em-1'`).get() as { files_written: string };
    expect(row.files_written).toBe('/x/a.ts\n/x/b.ts');
    db.close();
  });
```

- [ ] **Step 8: Run it to verify it fails**

Run: `npx vitest run tests/indexer.test.ts -t 'persists files_written'`
Expected: FAIL — `table chats has no column named files_written`.

- [ ] **Step 9: Add the column to the schema**

In `src/schema.ts`, in the `SCHEMA_SQL` `CREATE TABLE chats` block, immediately after the `files_touched` line:

```sql
  files_written     TEXT NOT NULL DEFAULT '',
```

Add the same line in the same position inside the `chats_v2` CREATE inside the `if (!have.has('agent'))` migration, and add `files_written` to **both** the explicit column list and the `SELECT` list of that migration's `INSERT INTO chats_v2`.

> **Why `chats_v2` matters:** the ALTER migrations below run *before* the `chats_v2` rebuild. On a DB old enough to predate the `agent` column, `files_written` would be added by the ALTER and then silently dropped when `chats_v2` is created without it. Both places must change together.

Add the ALTER alongside the existing ones, before the `if (!have.has('agent'))` block:

```typescript
  if (!have.has('files_written')) {
    db.exec(`ALTER TABLE chats ADD COLUMN files_written TEXT NOT NULL DEFAULT ''`);
  }
```

- [ ] **Step 10: Persist it in the indexer**

In `src/indexer.ts`, in `upsertChat`'s `common` object, immediately after the `files_touched` line:

```typescript
    files_written: parsed.files_written.join('\n'),
```

In the INSERT, add `files_written` to the column list (after `files_touched`) and `@files_written` to the VALUES list in the matching position.

In the UPDATE's SET clause, change `files_touched=@files_touched,` to:

```sql
       files_touched=@files_touched, files_written=@files_written,
```

- [ ] **Step 11: Run the full suite**

Run: `yarn test && npx tsc --noEmit`
Expected: all green. Existing tests that construct a `ParsedChat` literal may now fail to typecheck because `files_written` is required — add `files_written: []` to those literals.

- [ ] **Step 12: Commit**

```bash
git add src/types.ts src/parser.ts src/codexParser.ts src/schema.ts src/indexer.ts tests/parser.test.ts tests/indexer.test.ts
git commit -m "feat: track written files separately from read files

files_touched folds Read in with Edit/Write, so it cannot distinguish two
sessions editing the same file from two sessions both reading AGENTS.md.
The EM's collision and write-ratio signals need writes only.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Exact context measurement

Claude records a `usage` block on every assistant message. `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` is the true context size at that turn — so "needs a fresh restart" is a threshold on a measured number, not a heuristic. Verified against a live transcript: 89 messages carrying usage, the last reading 134,339 cache-read tokens.

**Files:**
- Create: `src/em/context.ts`
- Test: `tests/em/context.test.ts`

**Interfaces:**
- Produces: `interface ContextUsage { tokens: number; model: string; limit: number; fraction: number }`, `readContextUsage(jsonlPath: string, opts?: { bytes?: number }): ContextUsage | null`, `limitFor(model: string, observed: number): number`. Returns `null` for Codex transcripts and for any transcript with no usage block.

- [ ] **Step 1: Write the failing tests**

Create `tests/em/context.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readContextUsage, limitFor } from '../../src/em/context.ts';

function writeJsonl(lines: unknown[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-ctx-'));
  const f = path.join(dir, 'c.jsonl');
  fs.writeFileSync(f, lines.map((l) => JSON.stringify(l)).join('\n'));
  return f;
}

function assistant(model: string, usage: Record<string, number>) {
  return { type: 'assistant', message: { role: 'assistant', model, usage, content: [] } };
}

describe('readContextUsage', () => {
  it('sums the three input components of the LAST assistant message', () => {
    const f = writeJsonl([
      assistant('claude-opus-5', { input_tokens: 1, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 0, output_tokens: 50 }),
      assistant('claude-opus-5', { input_tokens: 2, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 1_000, output_tokens: 60 }),
    ]);
    const u = readContextUsage(f);
    expect(u).not.toBeNull();
    expect(u!.tokens).toBe(91_002);
    expect(u!.model).toBe('claude-opus-5');
    expect(u!.limit).toBe(200_000);
    expect(u!.fraction).toBeCloseTo(0.45501, 4);
  });

  it('ignores output_tokens, which do not occupy the window', () => {
    const f = writeJsonl([assistant('claude-opus-5', { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 99_999 })]);
    expect(readContextUsage(f)!.tokens).toBe(5);
  });

  it('returns null when no usage block exists (Codex transcripts)', () => {
    const f = writeJsonl([{ type: 'event_msg', payload: { type: 'agent_message', message: 'hi' } }]);
    expect(readContextUsage(f)).toBeNull();
  });

  it('returns null for a missing file rather than throwing', () => {
    expect(readContextUsage('/nope/does-not-exist.jsonl')).toBeNull();
  });
});

describe('limitFor', () => {
  it('maps a known model to its standard window', () => {
    expect(limitFor('claude-opus-5', 50_000)).toBe(200_000);
  });

  it('promotes to a larger tier when observed usage exceeds the mapped limit', () => {
    // A 1M-context session records the SAME model id as its 200k sibling, so the
    // id alone cannot identify the window. Without promotion this would report
    // >100% and fire BLOATED on every single turn.
    expect(limitFor('claude-opus-5', 340_000)).toBe(500_000);
    expect(limitFor('claude-opus-5', 700_000)).toBe(1_000_000);
  });

  it('falls back to the default window for an unknown model id', () => {
    expect(limitFor('some-future-model', 10_000)).toBe(200_000);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/em/context.test.ts`
Expected: FAIL — cannot resolve `../../src/em/context.ts`.

- [ ] **Step 3: Implement it**

Create `src/em/context.ts`:

```typescript
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
// a [1m] session logs "claude-opus-5"), so the id alone cannot identify the
// window. If observed usage already exceeds the mapped limit, the session is
// demonstrably on a larger tier — promote, rather than report an impossible
// >100% and fire BLOATED on every turn for the rest of the session.
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/em/context.test.ts && npx tsc --noEmit`
Expected: all 7 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/em/context.ts tests/em/context.test.ts
git commit -m "feat(em): measure a session's exact context size from its usage block

Claude records input/cache_read/cache_creation token counts on every assistant
message, so context pressure is a measured number rather than a heuristic. The
1M variant reports the same model id as its 200k sibling, so the limit promotes
by observation when usage exceeds the mapped window.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: The ledger

Every finding and every action — including the ones shadow mode declines to perform — lands here. `signals_json` is retained on each finding because calibrating Phase 2's thresholds is impossible without knowing what the numbers were when a detector fired.

**Files:**
- Create: `src/em/ledger.ts`
- Modify: `src/schema.ts` (exec the EM schema from `applySchema`)
- Test: `tests/em/ledger.test.ts`

**Interfaces:**
- Produces: `DetectorKind`, `EmMode`, `Finding`, `FindingRow`, `ActionRow`, `EM_SCHEMA_SQL`, and functions `getEmMode(db)`, `setEmMode(db, mode)`, `recordFinding(db, finding, cooldownMs)`, `recordAction(db, action)`, `setFindingStatus(db, id, status)`, `newFindings(db)`, `paneWritesSince(db, since)`, `recentLedger(db, since)`.
- Consumes: `openDb` from `src/db.ts`.

- [ ] **Step 1: Write the failing tests**

Create `tests/em/ledger.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { openDb } from '../../src/db.ts';
import {
  getEmMode, setEmMode, recordFinding, recordAction,
  setFindingStatus, newFindings, paneWritesSince, recentLedger,
} from '../../src/em/ledger.ts';

const HOUR = 3_600_000;

function finding(overrides: Partial<Parameters<typeof recordFinding>[1]> = {}) {
  return {
    agent: 'claude' as const,
    session_id: 's1',
    kind: 'BLOCKED' as const,
    signals: { idleMs: 120_000 },
    detected_at: 1_000_000,
    ...overrides,
  };
}

describe('em_mode', () => {
  it('defaults to shadow so a fresh install observes without acting', () => {
    const db = openDb(':memory:');
    expect(getEmMode(db)).toBe('shadow');
    db.close();
  });

  it('round-trips a set mode', () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    expect(getEmMode(db)).toBe('live');
    db.close();
  });

  it('reads an unrecognised stored value as off, the safe direction', () => {
    const db = openDb(':memory:');
    db.prepare(`INSERT INTO settings(key, value) VALUES ('em_mode', 'banana')`).run();
    expect(getEmMode(db)).toBe('off');
    db.close();
  });
});

describe('recordFinding', () => {
  it('records a finding and returns its id', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR);
    expect(id).toBeTypeOf('number');
    const rows = newFindings(db);
    expect(rows.length).toBe(1);
    expect(rows[0].kind).toBe('BLOCKED');
    expect(JSON.parse(rows[0].signals_json)).toEqual({ idleMs: 120_000 });
    db.close();
  });

  it('suppresses a repeat of the same (session, kind) inside the cooldown', () => {
    const db = openDb(':memory:');
    expect(recordFinding(db, finding(), HOUR)).toBeTypeOf('number');
    // Without this, a stuck session is re-detected every 30s forever.
    expect(recordFinding(db, finding({ detected_at: 1_000_000 + 60_000 }), HOUR)).toBeNull();
    expect(newFindings(db).length).toBe(1);
    db.close();
  });

  it('allows the same kind again once the cooldown has elapsed', () => {
    const db = openDb(':memory:');
    recordFinding(db, finding(), HOUR);
    expect(recordFinding(db, finding({ detected_at: 1_000_000 + HOUR + 1 }), HOUR)).toBeTypeOf('number');
    db.close();
  });

  it('does not let one kind suppress a different kind on the same session', () => {
    const db = openDb(':memory:');
    recordFinding(db, finding({ kind: 'BLOCKED' }), HOUR);
    expect(recordFinding(db, finding({ kind: 'BLOATED' }), HOUR)).toBeTypeOf('number');
    db.close();
  });
});

describe('actions and status', () => {
  it('drops a finding out of newFindings once its status advances', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR)!;
    setFindingStatus(db, id, 'acted');
    expect(newFindings(db).length).toBe(0);
    db.close();
  });

  it('counts only non-shadow pane writes toward the rate limit', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR)!;
    recordAction(db, { finding_id: id, kind: 'answer', payload: 'a', shadow: 1, result: 'shadow', taken_at: 2_000 });
    recordAction(db, { finding_id: id, kind: 'answer', payload: 'b', shadow: 0, result: 'sent', taken_at: 3_000 });
    recordAction(db, { finding_id: id, kind: 'issue', payload: 'c', shadow: 0, result: 'ok', taken_at: 4_000 });
    // Shadow actions send nothing, and filing an issue is not a pane write.
    expect(paneWritesSince(db, 0)).toBe(1);
    db.close();
  });

  it('returns findings and actions together for the feed', () => {
    const db = openDb(':memory:');
    const id = recordFinding(db, finding(), HOUR)!;
    recordAction(db, { finding_id: id, kind: 'answer', payload: 'x', shadow: 1, result: 'shadow', taken_at: 2_000 });
    const led = recentLedger(db, 0);
    expect(led.findings.length).toBe(1);
    expect(led.actions.length).toBe(1);
    expect(led.actions[0].finding_id).toBe(id);
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/em/ledger.test.ts`
Expected: FAIL — cannot resolve `../../src/em/ledger.ts`.

- [ ] **Step 3: Implement the ledger**

Create `src/em/ledger.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { Agent } from '../types.ts';

// All seven detectors are declared so the ledger schema is stable across phases.
// Phase 1 emits only BLOCKED, WRAPPABLE, and BLOATED.
export type DetectorKind =
  | 'BLOCKED' | 'WRAPPABLE' | 'BLOATED'
  | 'STALLED' | 'SPINNING' | 'DRIFTING' | 'CONVERGING';

export type EmMode = 'off' | 'shadow' | 'live';
export type FindingStatus = 'new' | 'triaged' | 'acted' | 'escalated' | 'expired';

export const EM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS em_findings (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  agent        TEXT NOT NULL,
  session_id   TEXT NOT NULL,
  kind         TEXT NOT NULL,
  signals_json TEXT NOT NULL,
  detected_at  INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT 'new'
);

CREATE TABLE IF NOT EXISTS em_actions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  finding_id INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  payload    TEXT NOT NULL,
  taken_at   INTEGER NOT NULL,
  shadow     INTEGER NOT NULL DEFAULT 1,
  result     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS em_findings_cooldown_idx
  ON em_findings(agent, session_id, kind, detected_at);
CREATE INDEX IF NOT EXISTS em_findings_status_idx ON em_findings(status);
CREATE INDEX IF NOT EXISTS em_actions_taken_idx ON em_actions(taken_at);
`;

export interface Finding {
  agent: Agent;
  session_id: string;
  kind: DetectorKind;
  signals: Record<string, unknown>;
  detected_at: number;
}

export interface FindingRow {
  id: number;
  agent: Agent;
  session_id: string;
  kind: DetectorKind;
  signals_json: string;
  detected_at: number;
  status: FindingStatus;
}

export interface ActionInput {
  finding_id: number;
  kind: string;
  payload: string;
  shadow: 0 | 1;
  result: string;
  taken_at: number;
}

export interface ActionRow extends ActionInput {
  id: number;
}

const EM_MODES: readonly EmMode[] = ['off', 'shadow', 'live'];

// Unrecognised or unset reads as… different things in each direction, on purpose:
// unset means a fresh install, which should observe (shadow); a stored value we
// cannot parse means something is wrong, so fail closed (off).
export function getEmMode(db: Database.Database): EmMode {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'em_mode'`).get() as { value: string } | undefined;
  if (!row) return 'shadow';
  return EM_MODES.includes(row.value as EmMode) ? (row.value as EmMode) : 'off';
}

export function setEmMode(db: Database.Database, mode: EmMode): void {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES ('em_mode', ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(mode);
}

// Returns the new finding's id, or null when an identical (session, kind) fired
// inside the cooldown. Without this a stuck session is re-detected every tick.
export function recordFinding(db: Database.Database, f: Finding, cooldownMs: number): number | null {
  const last = db
    .prepare(`SELECT MAX(detected_at) AS t FROM em_findings WHERE agent = ? AND session_id = ? AND kind = ?`)
    .get(f.agent, f.session_id, f.kind) as { t: number | null };
  if (last.t !== null && f.detected_at - last.t < cooldownMs) return null;

  const info = db
    .prepare(`INSERT INTO em_findings (agent, session_id, kind, signals_json, detected_at, status)
              VALUES (?, ?, ?, ?, ?, 'new')`)
    .run(f.agent, f.session_id, f.kind, JSON.stringify(f.signals), f.detected_at);
  return Number(info.lastInsertRowid);
}

export function recordAction(db: Database.Database, a: ActionInput): number {
  const info = db
    .prepare(`INSERT INTO em_actions (finding_id, kind, payload, taken_at, shadow, result)
              VALUES (@finding_id, @kind, @payload, @taken_at, @shadow, @result)`)
    .run(a);
  return Number(info.lastInsertRowid);
}

export function setFindingStatus(db: Database.Database, id: number, status: FindingStatus): void {
  db.prepare(`UPDATE em_findings SET status = ? WHERE id = ?`).run(status, id);
}

export function newFindings(db: Database.Database): FindingRow[] {
  return db
    .prepare(`SELECT * FROM em_findings WHERE status = 'new' ORDER BY detected_at ASC`)
    .all() as FindingRow[];
}

// Bounds the blast radius of a miscalibrated detector. Shadow actions send
// nothing, and filing an issue is not a pane write, so neither is counted.
const PANE_WRITE_KINDS = new Set(['answer', 'nudge', 'refocus', 'brief', 'restart']);

export function paneWritesSince(db: Database.Database, since: number): number {
  const rows = db
    .prepare(`SELECT kind FROM em_actions WHERE shadow = 0 AND taken_at >= ?`)
    .all(since) as { kind: string }[];
  return rows.filter((r) => PANE_WRITE_KINDS.has(r.kind)).length;
}

export function recentLedger(
  db: Database.Database,
  since: number,
): { findings: FindingRow[]; actions: ActionRow[] } {
  return {
    findings: db
      .prepare(`SELECT * FROM em_findings WHERE detected_at >= ? ORDER BY detected_at DESC LIMIT 200`)
      .all(since) as FindingRow[],
    actions: db
      .prepare(`SELECT * FROM em_actions WHERE taken_at >= ? ORDER BY taken_at DESC LIMIT 200`)
      .all(since) as ActionRow[],
  };
}
```

- [ ] **Step 4: Create the tables on open**

In `src/schema.ts`, add to the imports at the top:

```typescript
import { EM_SCHEMA_SQL } from './em/ledger.ts';
```

At the very end of `applySchema`, after the existing `chats_saved_idx` line:

```typescript
  // EM tables live alongside the chat index in the same DB — a finding is
  // meaningless without the chat row it points at.
  db.exec(EM_SCHEMA_SQL);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/em/ledger.test.ts && npx tsc --noEmit`
Expected: all 10 cases PASS.

- [ ] **Step 6: Run the full suite to check the schema change is safe**

Run: `yarn test`
Expected: all green — `applySchema` runs for every existing test that opens a DB.

- [ ] **Step 7: Commit**

```bash
git add src/em/ledger.ts src/schema.ts tests/em/ledger.test.ts
git commit -m "feat(em): add the findings and actions ledger

Records every detection and every intended action, including the ones shadow
mode declines to perform. Per-(session, kind) cooldowns stop a stuck session
being re-detected every tick; signals_json is retained so Phase 2's thresholds
can be calibrated from what actually fired.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Signals

The zero-token half of the system. Everything here is SQL already in memory, one `stat` per chat, and one bounded tail-read.

**Files:**
- Create: `src/em/signals.ts`
- Test: `tests/em/signals.test.ts`

**Interfaces:**
- Consumes: `ContextUsage` / `readContextUsage` (Task 2), `ChatRow` from `src/types.ts`, `LiveLoc` from `src/dashboard.ts`, `agentSessionKey` from `src/placements.ts`.
- Produces: `interface EmSignals`, `computeSignals(rows, live, now, opts?): EmSignals[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/em/signals.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeSignals } from '../../src/em/signals.ts';
import type { ChatRow } from '../../src/types.ts';
import type { LiveLoc } from '../../src/dashboard.ts';

const NOW = 2_000_000_000_000;

function chatRow(over: Partial<ChatRow> = {}): ChatRow {
  return {
    agent: 'claude', session_id: 's1', project_dir: '/repo', jsonl_path: '/nope.jsonl',
    started_at: NOW - 600_000, ended_at: NOW, last_active_at: NOW, message_count: 12,
    activity_json: '{}', files_touched: '', files_written: '', first_message: 'do the thing',
    claude_auto_title: '', pr_url: '', title: 't', overview: 'o', state: 'waiting_on_user',
    breakdown_json: '[]', summary_dirty: 0, summary_model: '', summary_at: 0,
    last_tmux_session: '', last_pane_id: '', saved: 0, saved_at: 0,
    jsonl_mtime: NOW, last_indexed_at: NOW, ...over,
  };
}

function liveLoc(over: Partial<LiveLoc> = {}): LiveLoc {
  return {
    agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a',
    window_index: '0', pane_index: '0', running: true, working: false, ...over,
  };
}

describe('computeSignals', () => {
  it('marks a chat with no live pane as not live, with no pane id', () => {
    const [s] = computeSignals([chatRow()], {}, NOW);
    expect(s.live).toBe(false);
    expect(s.pane).toBeNull();
  });

  it('carries live and working through from the live map', () => {
    const [s] = computeSignals([chatRow()], { 'claude:s1': liveLoc({ working: true }) }, NOW);
    expect(s.live).toBe(true);
    expect(s.working).toBe(true);
    expect(s.pane!.pane_id).toBe('%1');
  });

  it('derives idleMs from the transcript mtime, not the indexed last_active_at', () => {
    // last_active_at only refreshes on a summarizer pass (minutes of lag); the
    // file's mtime is the true last-activity time.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-sig-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, '');
    const mtime = new Date(NOW - 300_000);
    fs.utimesSync(f, mtime, mtime);
    const [s] = computeSignals([chatRow({ jsonl_path: f, last_active_at: NOW })], {}, NOW);
    expect(s.idleMs).toBeGreaterThanOrEqual(299_000);
    expect(s.idleMs).toBeLessThanOrEqual(301_000);
  });

  it('falls back to last_active_at when the transcript is gone', () => {
    const [s] = computeSignals([chatRow({ jsonl_path: '/gone.jsonl', last_active_at: NOW - 60_000 })], {}, NOW);
    expect(s.idleMs).toBe(60_000);
  });

  it('splits files_written on newlines and drops blanks', () => {
    const [s] = computeSignals([chatRow({ files_written: '/repo/a.ts\n/repo/b.ts\n' })], {}, NOW);
    expect(s.filesWritten).toEqual(['/repo/a.ts', '/repo/b.ts']);
  });

  it('excludes chats whose project_dir is the Loom repo itself', () => {
    // Otherwise the EM manages the session implementing the EM.
    const rows = [chatRow({ session_id: 'other', project_dir: '/repo' }), chatRow({ session_id: 'self', project_dir: '/loom' })];
    const out = computeSignals(rows, {}, NOW, { selfDir: '/loom' });
    expect(out.map((s) => s.session_id)).toEqual(['other']);
  });

  it('excludes chats nested inside the Loom repo, not just an exact match', () => {
    const rows = [chatRow({ session_id: 'wt', project_dir: '/loom/.worktrees/x' })];
    expect(computeSignals(rows, {}, NOW, { selfDir: '/loom' }).length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/em/signals.test.ts`
Expected: FAIL — cannot resolve `../../src/em/signals.ts`.

- [ ] **Step 3: Implement it**

Create `src/em/signals.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChatRow, Agent } from '../types.ts';
import type { LiveLoc } from '../dashboard.ts';
import { agentSessionKey } from '../placements.ts';
import { readContextUsage, type ContextUsage } from './context.ts';

export interface EmSignals {
  agent: Agent;
  session_id: string;
  project_dir: string;
  jsonl_path: string;
  title: string;
  first_message: string;
  state: string;
  live: boolean;
  working: boolean;
  pane: LiveLoc | null;
  idleMs: number;
  ageMs: number;
  messageCount: number;
  filesWritten: string[];
  context: ContextUsage | null;
}

// src/em/signals.ts -> repo root.
const LOOM_REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function splitList(raw: string): string[] {
  return raw.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function computeSignals(
  rows: ChatRow[],
  live: Record<string, LiveLoc>,
  now: number,
  opts: { selfDir?: string } = {},
): EmSignals[] {
  const selfDir = opts.selfDir ?? LOOM_REPO_DIR;
  const out: EmSignals[] = [];

  for (const r of rows) {
    // Never manage Loom's own sessions — including worktrees of this repo —
    // or the EM ends up acting on the session that is implementing it.
    if (r.project_dir && isInside(r.project_dir, selfDir)) continue;

    // The DB's last_active_at only refreshes on a summarizer pass (minutes of
    // lag). The transcript's mtime is the true last-activity time.
    let lastActive = r.last_active_at;
    try {
      lastActive = Math.max(lastActive, fs.statSync(r.jsonl_path).mtimeMs);
    } catch {
      /* transcript gone; fall back to the indexed value */
    }

    const loc = live[agentSessionKey(r.agent, r.session_id)] ?? null;

    out.push({
      agent: r.agent,
      session_id: r.session_id,
      project_dir: r.project_dir,
      jsonl_path: r.jsonl_path,
      title: r.title || r.claude_auto_title || '',
      first_message: r.first_message,
      state: r.state,
      live: !!loc,
      working: !!loc?.working,
      pane: loc,
      idleMs: Math.max(0, now - lastActive),
      ageMs: Math.max(0, now - r.started_at),
      messageCount: r.message_count,
      filesWritten: splitList(r.files_written),
      // Codex transcripts carry no usage block, so this is null for them and
      // BLOATED simply never fires — correct, not a gap to work around.
      context: readContextUsage(r.jsonl_path),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/em/signals.test.ts && npx tsc --noEmit`
Expected: all 7 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/em/signals.ts tests/em/signals.test.ts
git commit -m "feat(em): compute per-session signals with no model calls

Idle time from the transcript mtime rather than the lagging indexed value,
written-file lists, and exact context usage. Chats inside the Loom repo are
excluded so the EM cannot manage the session implementing it.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Detectors

Pure threshold logic — no I/O, no model. Every number here is an initial guess whose whole purpose is to be recalibrated from shadow-mode data.

**Files:**
- Create: `src/em/detectors.ts`
- Test: `tests/em/detectors.test.ts`

**Interfaces:**
- Consumes: `EmSignals` (Task 4), `Finding` / `DetectorKind` (Task 3).
- Produces: `THRESHOLDS`, `type Thresholds`, `detect(signals: EmSignals[], now: number, t?: Thresholds): Finding[]`.

- [ ] **Step 1: Write the failing tests**

Create `tests/em/detectors.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { detect, THRESHOLDS } from '../../src/em/detectors.ts';
import type { EmSignals } from '../../src/em/signals.ts';

const NOW = 2_000_000_000_000;

function sig(over: Partial<EmSignals> = {}): EmSignals {
  return {
    agent: 'claude', session_id: 's1', project_dir: '/repo', jsonl_path: '/c.jsonl',
    title: 't', first_message: 'do the thing', state: 'done',
    live: true, working: false,
    pane: { agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a', window_index: '0', pane_index: '0', running: true, working: false },
    idleMs: 0, ageMs: 600_000, messageCount: 12, filesWritten: [], context: null, ...over,
  };
}

const kinds = (s: EmSignals[]) => detect(s, NOW).map((f) => f.kind);

describe('BLOCKED', () => {
  it('fires on a live, idle, waiting_on_user session', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 120_000 })])).toEqual(['BLOCKED']);
  });

  it('does not fire before the idle threshold — the user may just be reading', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 30_000 })])).toEqual([]);
  });

  it('does not fire while the session is working', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 120_000, working: true })])).toEqual([]);
  });

  it('does not fire on a dead pane — there is nobody to answer', () => {
    expect(kinds([sig({ state: 'waiting_on_user', idleMs: 120_000, live: false, pane: null })])).toEqual([]);
  });
});

describe('WRAPPABLE', () => {
  it('fires on a finished session that has been sitting idle', () => {
    expect(kinds([sig({ state: 'done', idleMs: 11 * 60_000 })])).toEqual(['WRAPPABLE']);
  });

  it('waits out the grace period so a just-finished session is not yanked away', () => {
    expect(kinds([sig({ state: 'done', idleMs: 60_000 })])).toEqual([]);
  });

  it('does not fire on a warning or error state — those are not finished', () => {
    expect(kinds([sig({ state: 'warning', idleMs: 11 * 60_000 })])).toEqual([]);
    expect(kinds([sig({ state: 'error', idleMs: 11 * 60_000 })])).toEqual([]);
  });
});

describe('BLOATED', () => {
  const ctx = (fraction: number) => ({ tokens: Math.round(200_000 * fraction), model: 'claude-opus-5', limit: 200_000, fraction });

  it('fires once context passes the threshold fraction', () => {
    expect(kinds([sig({ state: 'warning', context: ctx(0.75) })])).toEqual(['BLOATED']);
  });

  it('does not fire below the threshold', () => {
    expect(kinds([sig({ state: 'warning', context: ctx(0.5) })])).toEqual([]);
  });

  it('never fires without a usage block (Codex)', () => {
    expect(kinds([sig({ state: 'warning', context: null })])).toEqual([]);
  });

  it('fires even while working, because context only ever grows', () => {
    expect(kinds([sig({ state: 'warning', context: ctx(0.9), working: true })])).toEqual(['BLOATED']);
  });
});

describe('detect', () => {
  it('can return several kinds for one session', () => {
    const out = kinds([sig({ state: 'done', idleMs: 11 * 60_000, context: { tokens: 180_000, model: 'claude-opus-5', limit: 200_000, fraction: 0.9 } })]);
    expect(out.sort()).toEqual(['BLOATED', 'WRAPPABLE']);
  });

  it('stamps detected_at and captures the signals that fired it', () => {
    const [f] = detect([sig({ state: 'waiting_on_user', idleMs: 120_000 })], NOW);
    expect(f.detected_at).toBe(NOW);
    expect(f.signals).toMatchObject({ idleMs: 120_000, state: 'waiting_on_user' });
  });

  it('honours overridden thresholds', () => {
    const s = [sig({ state: 'waiting_on_user', idleMs: 30_000 })];
    expect(detect(s, NOW, { ...THRESHOLDS, blockedIdleMs: 10_000 }).map((f) => f.kind)).toEqual(['BLOCKED']);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/em/detectors.test.ts`
Expected: FAIL — cannot resolve `../../src/em/detectors.ts`.

- [ ] **Step 3: Implement it**

Create `src/em/detectors.ts`:

```typescript
import type { EmSignals } from './signals.ts';
import type { Finding } from './ledger.ts';

// INITIAL GUESSES. These exist to be recalibrated from a week of shadow-mode
// em_findings rows — that is the entire point of Phase 1. Do not treat them as
// tuned values.
export interface Thresholds {
  blockedIdleMs: number;
  wrappableIdleMs: number;
  bloatedFraction: number;
}

export const THRESHOLDS: Thresholds = {
  // Long enough that Will simply reading the question does not trip it.
  blockedIdleMs: 90_000,
  // Grace period so a just-finished session is not yanked out from under him.
  wrappableIdleMs: 10 * 60_000,
  bloatedFraction: 0.70,
};

function finding(s: EmSignals, kind: Finding['kind'], now: number, extra: Record<string, unknown>): Finding {
  return {
    agent: s.agent,
    session_id: s.session_id,
    kind,
    // Retained so Phase 2's thresholds can be set from what actually fired.
    signals: { state: s.state, idleMs: s.idleMs, ageMs: s.ageMs, messageCount: s.messageCount, ...extra },
    detected_at: now,
  };
}

export function detect(signals: EmSignals[], now: number, t: Thresholds = THRESHOLDS): Finding[] {
  const out: Finding[] = [];

  for (const s of signals) {
    // BLOCKED and WRAPPABLE are definitionally idle states: a session that is
    // generating is neither waiting on the user nor finished, whatever the last
    // summarizer pass recorded.
    const idleAndLive = s.live && !s.working;

    if (idleAndLive && s.state === 'waiting_on_user' && s.idleMs > t.blockedIdleMs) {
      out.push(finding(s, 'BLOCKED', now, {}));
    }

    if (idleAndLive && s.state === 'done' && s.idleMs > t.wrappableIdleMs) {
      out.push(finding(s, 'WRAPPABLE', now, {}));
    }

    // Unlike the other two, this fires while working: context only ever grows,
    // so waiting for idle means waiting through the degraded turns the detector
    // exists to prevent.
    if (s.live && s.context && s.context.fraction >= t.bloatedFraction) {
      out.push(
        finding(s, 'BLOATED', now, {
          contextTokens: s.context.tokens,
          contextLimit: s.context.limit,
          contextFraction: Number(s.context.fraction.toFixed(4)),
          model: s.context.model,
        }),
      );
    }
  }
  return out;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/em/detectors.test.ts && npx tsc --noEmit`
Expected: all 14 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/em/detectors.ts tests/em/detectors.test.ts
git commit -m "feat(em): add the BLOCKED, WRAPPABLE, and BLOATED detectors

Pure threshold logic over the signals, no I/O. BLOCKED and WRAPPABLE require an
idle pane since both are definitionally idle states; BLOATED fires even while
working, because context only grows and waiting means waiting through the
degraded turns it exists to prevent.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Triage

The only place in the EM that calls a model, and only ever on a finding a detector already produced. Three prompts: decide whether a blocked session's question is answerable, extract fast-follows from a finished session, and write a handoff brief for a bloated one.

**Files:**
- Create: `src/em/triage.ts`
- Test: `tests/em/triage.test.ts`

**Interfaces:**
- Consumes: `ClaudeRunner` type from `src/analyzer.ts`, `readTranscript` from `src/transcript.ts`.
- Produces: `makeRunner(cwd)`, `BlockedTriage`, `FastFollow`, `buildBlockedPrompt`, `parseBlockedTriage`, `buildFastFollowPrompt`, `parseFastFollows`, `buildHandoffPrompt`, `transcriptTail`, `lastAssistantText`.

- [ ] **Step 1: Write the failing tests**

Create `tests/em/triage.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseBlockedTriage, parseFastFollows, buildBlockedPrompt, buildFastFollowPrompt,
  buildHandoffPrompt, lastAssistantText,
} from '../../src/em/triage.ts';

describe('parseBlockedTriage', () => {
  it('parses an answer with its citation', () => {
    const r = parseBlockedTriage('{"decision":"answer","answer":"Use the Dropdown component.","citation":"AGENTS.md"}');
    expect(r).toEqual({ decision: 'answer', answer: 'Use the Dropdown component.', citation: 'AGENTS.md' });
  });

  it('parses an escalation with its reason', () => {
    const r = parseBlockedTriage('{"decision":"escalate","reason":"Pricing is a product call."}');
    expect(r).toEqual({ decision: 'escalate', reason: 'Pricing is a product call.' });
  });

  it('tolerates prose and fences around the JSON', () => {
    const r = parseBlockedTriage('Sure!\n```json\n{"decision":"escalate","reason":"needs Will"}\n```\nHope that helps.');
    expect(r.decision).toBe('escalate');
  });

  it('escalates when the response is unparseable — a wrong auto-answer is worse than a slow one', () => {
    const r = parseBlockedTriage('I could not determine an answer.');
    expect(r.decision).toBe('escalate');
  });

  it('escalates an answer that arrives with no citation', () => {
    // Uncited means underived, which is exactly what must not be auto-sent.
    const r = parseBlockedTriage('{"decision":"answer","answer":"probably yes","citation":""}');
    expect(r.decision).toBe('escalate');
  });

  it('escalates an answer whose text is empty', () => {
    expect(parseBlockedTriage('{"decision":"answer","answer":"   ","citation":"AGENTS.md"}').decision).toBe('escalate');
  });
});

describe('parseFastFollows', () => {
  it('parses a list of follow-ups', () => {
    const r = parseFastFollows('{"fast_follows":[{"title":"Add a test","body":"The retry path is uncovered."}]}');
    expect(r).toEqual([{ title: 'Add a test', body: 'The retry path is uncovered.' }]);
  });

  it('returns an empty list when the session genuinely left nothing behind', () => {
    expect(parseFastFollows('{"fast_follows":[]}')).toEqual([]);
  });

  it('returns an empty list rather than throwing on a malformed response', () => {
    expect(parseFastFollows('no json here')).toEqual([]);
  });

  it('drops entries missing a title', () => {
    expect(parseFastFollows('{"fast_follows":[{"body":"orphan"},{"title":"keep","body":"b"}]}')).toEqual([{ title: 'keep', body: 'b' }]);
  });
});

describe('prompt builders', () => {
  it('tells the blocked triage to read the conventions itself and to default to escalating', () => {
    const p = buildBlockedPrompt('Which dropdown should I use?', '/repo', 'USER: hi');
    expect(p).toContain('AGENTS.md');
    expect(p).toContain('escalate');
    expect(p).toContain('Which dropdown should I use?');
  });

  it('instructs the fast-follow extractor to return an empty list when nothing is outstanding', () => {
    const p = buildFastFollowPrompt('USER: hi\nASSISTANT: done');
    expect(p).toContain('fast_follows');
    expect(p).toContain('empty');
  });

  it('asks the handoff brief for prose, not JSON, since it is sent verbatim', () => {
    const p = buildHandoffPrompt('USER: hi');
    expect(p.toLowerCase()).toContain('no json');
  });
});

describe('lastAssistantText', () => {
  it('returns the final assistant turn — the question actually being asked', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-last-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'first' }] } }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'ok' } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Which approach do you want?' }] } }),
    ].join('\n'));
    expect(lastAssistantText('claude', f)).toBe('Which approach do you want?');
  });

  it('returns an empty string when there is no assistant turn', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-last2-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }));
    expect(lastAssistantText('claude', f)).toBe('');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/em/triage.test.ts`
Expected: FAIL — cannot resolve `../../src/em/triage.ts`.

- [ ] **Step 3: Implement it**

Create `src/em/triage.ts`:

```typescript
import { execFile } from 'node:child_process';
import type { ClaudeRunner } from '../analyzer.ts';
import { readTranscript } from '../transcript.ts';
import type { Agent } from '../types.ts';

export type BlockedTriage =
  | { decision: 'answer'; answer: string; citation: string }
  | { decision: 'escalate'; reason: string };

export interface FastFollow {
  title: string;
  body: string;
}

// Same flags as the analyzer's runner, for the same reasons:
//   --safe-mode              disables customizations INCLUDING hooks, so these
//                            background calls do not fire Will's Stop hook.
//   --no-session-persistence keeps the EM's own calls out of Loom's index.
// Unlike the analyzer's runner, cwd is the session's project dir so the model can
// read that repo's conventions. --safe-mode may suppress auto-loaded CLAUDE.md,
// so the prompts below tell it to open those files itself rather than assume.
export function makeRunner(cwd: string): ClaudeRunner {
  return (prompt: string) =>
    new Promise((resolve, reject) => {
      execFile(
        'claude',
        ['-p', '--safe-mode', '--no-session-persistence', prompt],
        { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 180_000 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
    });
}

// Recent conversation text for prompt context, bounded so cost does not scale
// with transcript size.
export function transcriptTail(agent: Agent, jsonlPath: string, turns = 12, cap = 12_000): string {
  const msgs = readTranscript(agent, jsonlPath, { limit: turns });
  const text = msgs.map((m) => `${m.role.toUpperCase()}: ${m.text}`).join('\n');
  return text.length <= cap ? text : text.slice(-cap);
}

// The final assistant turn — for a session in waiting_on_user, this IS the
// question being asked. Passing the whole tail as "the question" would leave the
// triage model guessing which of several turns it is meant to answer.
export function lastAssistantText(agent: Agent, jsonlPath: string): string {
  const msgs = readTranscript(agent, jsonlPath, { limit: 40 });
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant' && msgs[i].text.trim()) return msgs[i].text.trim();
  }
  return '';
}

function extractJson(raw: string): any | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

export function buildBlockedPrompt(question: string, projectDir: string, recent: string): string {
  return [
    'You are an engineering manager standing in for the repo owner, who is away.',
    `A coding session in ${projectDir} is blocked, waiting on an answer.`,
    '',
    'Decide whether you can answer it ON HIS BEHALF, or whether it genuinely needs him.',
    '',
    'You MAY answer only when the answer is DERIVABLE from this repo — read the files',
    'yourself to check: AGENTS.md, CLAUDE.md, docs/README.md and the docs it indexes,',
    'and the surrounding source. Typical answerable questions: which convention or',
    'pattern applies, where a thing belongs, whether something already exists, what',
    'the established naming is.',
    '',
    'You MUST escalate when the question calls for product judgment, picks between',
    'options with no documented default, or touches anything irreversible, external-',
    'facing, or costly (production, money, published artifacts, deletions).',
    '',
    'If you are unsure, ESCALATE. A wrong answer silently steers the work and is far',
    'more expensive than a delayed one.',
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences.',
    'Either: {"decision":"answer","answer":"<what to tell the session>","citation":"<file(s) the answer came from>"}',
    'Or:     {"decision":"escalate","reason":"<one sentence on why this needs him>"}',
    '',
    'An "answer" MUST carry a non-empty citation naming the file(s) you derived it',
    'from. If you cannot cite one, that means you did not derive it — escalate.',
    '',
    'The question:',
    '"""',
    question,
    '"""',
    '',
    'Recent conversation, for context:',
    '"""',
    recent,
    '"""',
  ].join('\n');
}

export function parseBlockedTriage(raw: string): BlockedTriage {
  const obj = extractJson(raw);
  // Every failure path lands on escalate: uncertainty must never auto-send.
  if (!obj) return { decision: 'escalate', reason: 'triage response was unparseable' };
  if (obj.decision === 'answer') {
    const answer = typeof obj.answer === 'string' ? obj.answer.trim() : '';
    const citation = typeof obj.citation === 'string' ? obj.citation.trim() : '';
    if (!answer) return { decision: 'escalate', reason: 'triage returned an empty answer' };
    if (!citation) return { decision: 'escalate', reason: 'triage answered without citing a source' };
    return { decision: 'answer', answer, citation };
  }
  const reason = typeof obj.reason === 'string' && obj.reason.trim() ? obj.reason.trim() : 'needs a human decision';
  return { decision: 'escalate', reason };
}

export function buildFastFollowPrompt(transcript: string): string {
  return [
    'A coding session has finished its work. Extract the FAST-FOLLOWS it left behind:',
    'things explicitly deferred, noted as out of scope, flagged as needing a later fix,',
    'or acknowledged as unverified. These become GitHub issues so nothing is lost when',
    'the session closes.',
    '',
    'Do NOT invent work. Do NOT include what the session actually completed. Do NOT',
    'include generic advice ("add more tests") that the session did not itself raise.',
    'If it genuinely left nothing outstanding, return an empty list — that is a normal',
    'and expected result.',
    '',
    'Respond with ONLY a JSON object — no prose, no markdown fences:',
    '{"fast_follows":[{"title":"<= 10 words, imperative","body":"what and why, plus any file or error named in the session"}]}',
    '',
    'Transcript:',
    '"""',
    transcript,
    '"""',
  ].join('\n');
}

export function parseFastFollows(raw: string): FastFollow[] {
  const obj = extractJson(raw);
  if (!obj || !Array.isArray(obj.fast_follows)) return [];
  return obj.fast_follows
    .filter((f: any) => f && typeof f.title === 'string' && f.title.trim())
    .map((f: any) => ({ title: String(f.title).trim(), body: typeof f.body === 'string' ? f.body.trim() : '' }));
}

export function buildHandoffPrompt(transcript: string): string {
  return [
    "A coding session has nearly filled its context window and is about to be restarted",
    'fresh. Write the handoff brief that its replacement will receive as its first message.',
    '',
    'Cover, in this order: the original goal; what has already been done (naming the',
    'files); what is left; and any decision or constraint the replacement would',
    'otherwise re-litigate or violate.',
    '',
    'Write it as a direct instruction to the replacement session. Be specific and',
    'concrete — it starts with no memory whatsoever of this work.',
    '',
    'Respond with the brief itself and nothing else: no JSON, no preamble, no fences.',
    '',
    'Transcript:',
    '"""',
    transcript,
    '"""',
  ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/em/triage.test.ts && npx tsc --noEmit`
Expected: all 13 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/em/triage.ts tests/em/triage.test.ts
git commit -m "feat(em): triage findings with a single headless model call

Blocked-session triage answers only what it can cite from the repo's own
conventions and escalates everything else — every parse failure, missing
citation, and empty answer lands on escalate, because a wrong auto-answer
silently steers the work.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Shadow-aware actions

One `perform()` chokepoint decides whether an intervention is executed or merely recorded. Every caller goes through it, so shadow mode is a single branch rather than a rule that must be remembered in each action.

**Files:**
- Create: `src/em/actions.ts`
- Test: `tests/em/actions.test.ts`

**Interfaces:**
- Consumes: `sendToPane` / `closeSession` from `src/goto.ts`, ledger functions (Task 3), `FastFollow` (Task 6), `LiveLoc` from `src/dashboard.ts`.
- Produces: `ActionCtx`, `perform`, `repoSlug`, `fileIssue`, `writeToPane`, `wrapUpSession`, `RATE_LIMIT_PER_HOUR`.

- [ ] **Step 1: Write the failing tests**

Create `tests/em/actions.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { openDb } from '../../src/db.ts';
import { recordFinding, paneWritesSince } from '../../src/em/ledger.ts';
import { perform, fileIssue, writeToPane, repoSlug, type ActionCtx } from '../../src/em/actions.ts';
import type { LiveLoc } from '../../src/dashboard.ts';

const NOW = 2_000_000_000_000;

const PANE: LiveLoc = {
  agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a',
  window_index: '0', pane_index: '0', running: true, working: false,
};

function ctx(over: Partial<ActionCtx> = {}): ActionCtx {
  const db = openDb(':memory:');
  return {
    db, mode: 'shadow', now: NOW,
    send: vi.fn(() => ({ ok: true, detail: 'sent' })),
    close: vi.fn(() => ({ ok: true, detail: 'closed' })),
    gh: vi.fn(() => 'https://github.com/o/r/issues/1'),
    ...over,
  };
}

function findingId(c: ActionCtx): number {
  return recordFinding(c.db, { agent: 'claude', session_id: 's1', kind: 'BLOCKED', signals: {}, detected_at: NOW }, 1)!;
}

describe('perform', () => {
  it('records the intended action but does NOT execute it in shadow mode', () => {
    const c = ctx({ mode: 'shadow' });
    const exec = vi.fn(() => 'executed');
    perform(c, findingId(c), 'answer', 'hello', exec);
    expect(exec).not.toHaveBeenCalled();
    const row = c.db.prepare(`SELECT * FROM em_actions`).get() as any;
    expect(row.shadow).toBe(1);
    expect(row.payload).toBe('hello');
    expect(row.result).toBe('shadow');
    c.db.close();
  });

  it('executes and records in live mode', () => {
    const c = ctx({ mode: 'live' });
    const exec = vi.fn(() => 'executed');
    perform(c, findingId(c), 'answer', 'hello', exec);
    expect(exec).toHaveBeenCalledOnce();
    const row = c.db.prepare(`SELECT * FROM em_actions`).get() as any;
    expect(row.shadow).toBe(0);
    expect(row.result).toBe('executed');
    c.db.close();
  });

  it('does nothing at all when mode is off', () => {
    const c = ctx({ mode: 'off' });
    const exec = vi.fn();
    perform(c, findingId(c), 'answer', 'hello', exec);
    expect(exec).not.toHaveBeenCalled();
    expect(c.db.prepare(`SELECT COUNT(*) AS n FROM em_actions`).get()).toEqual({ n: 0 });
    c.db.close();
  });

  it('records the error instead of throwing when execution fails', () => {
    const c = ctx({ mode: 'live' });
    perform(c, findingId(c), 'answer', 'hello', () => { throw new Error('tmux gone'); });
    const row = c.db.prepare(`SELECT result FROM em_actions`).get() as any;
    expect(row.result).toContain('tmux gone');
    c.db.close();
  });
});

describe('writeToPane', () => {
  it('sends in live mode and counts toward the pane-write rate limit', () => {
    const c = ctx({ mode: 'live' });
    writeToPane(c, findingId(c), 'answer', PANE, 'the answer');
    expect(c.send).toHaveBeenCalledWith('%1', 'the answer', 'claude');
    expect(paneWritesSince(c.db, 0)).toBe(1);
    c.db.close();
  });

  it('refuses once the hourly cap is reached, bounding a bad detector', () => {
    const c = ctx({ mode: 'live' });
    const id = findingId(c);
    for (let i = 0; i < 40; i++) writeToPane(c, id, 'answer', PANE, `m${i}`);
    expect((c.send as any).mock.calls.length).toBeLessThanOrEqual(30);
    c.db.close();
  });

  it('does not consume rate limit in shadow mode', () => {
    const c = ctx({ mode: 'shadow' });
    const id = findingId(c);
    for (let i = 0; i < 40; i++) writeToPane(c, id, 'answer', PANE, `m${i}`);
    expect(c.send).not.toHaveBeenCalled();
    expect(paneWritesSince(c.db, 0)).toBe(0);
    c.db.close();
  });
});

describe('repoSlug', () => {
  it('returns the slug gh reports', () => {
    const gh = vi.fn(() => 'tax-pilot-org/tax-pilot-app\n');
    expect(repoSlug('/repo', gh)).toBe('tax-pilot-org/tax-pilot-app');
  });

  it('returns null for a directory with no GitHub remote', () => {
    const gh = vi.fn(() => { throw new Error('not a gh repo'); });
    expect(repoSlug('/tmp', gh)).toBeNull();
  });
});

describe('fileIssue', () => {
  it('files the issue and returns its url in live mode', () => {
    const c = ctx({ mode: 'live' });
    const r = fileIssue(c, findingId(c), '/repo', { title: 'Add a test', body: 'retry path uncovered' }, 'sess-1');
    expect(r.ok).toBe(true);
    expect(r.url).toBe('https://github.com/o/r/issues/1');
    const args = (c.gh as any).mock.calls.at(-1)[0] as string[];
    expect(args).toContain('--label');
    expect(args).toContain('fast-follow');
    // The issue must point back at the session it came from.
    expect(args.join(' ')).toContain('sess-1');
    c.db.close();
  });

  it('reports failure rather than throwing when gh errors', () => {
    const c = ctx({ mode: 'live', gh: vi.fn(() => { throw new Error('gh: not authenticated'); }) });
    expect(fileIssue(c, findingId(c), '/repo', { title: 't', body: 'b' }, 's').ok).toBe(false);
    c.db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/em/actions.test.ts`
Expected: FAIL — cannot resolve `../../src/em/actions.ts`.

- [ ] **Step 3: Implement it**

Create `src/em/actions.ts`:

```typescript
import { execFileSync } from 'node:child_process';
import type Database from 'better-sqlite3';
import { sendToPane, closeSession, type GotoResult } from '../goto.ts';
import type { LiveLoc } from '../dashboard.ts';
import { recordAction, paneWritesSince, type EmMode } from './ledger.ts';
import type { FastFollow } from './triage.ts';

// Bounds the blast radius of a miscalibrated detector to something recoverable.
export const RATE_LIMIT_PER_HOUR = 30;
const HOUR = 3_600_000;

export type GhRunner = (args: string[], cwd: string) => string;

export interface ActionCtx {
  db: Database.Database;
  mode: EmMode;
  now: number;
  send: (paneId: string, text: string, agent: 'claude' | 'codex') => GotoResult;
  close: (paneId: string, agent: 'claude' | 'codex') => GotoResult;
  gh: GhRunner;
}

const defaultGh: GhRunner = (args, cwd) =>
  execFileSync('gh', args, { cwd, encoding: 'utf-8', timeout: 60_000 });

export function makeActionCtx(db: Database.Database, mode: EmMode, now: number): ActionCtx {
  return { db, mode, now, send: sendToPane, close: closeSession, gh: defaultGh };
}

// THE shadow chokepoint. Every intervention routes through here, so shadow mode
// is one branch rather than a rule each action has to remember.
export function perform(
  ctx: ActionCtx,
  findingId: number,
  kind: string,
  payload: string,
  exec: () => string,
): { executed: boolean; result: string } {
  if (ctx.mode === 'off') return { executed: false, result: 'off' };

  if (ctx.mode === 'shadow') {
    recordAction(ctx.db, { finding_id: findingId, kind, payload, shadow: 1, result: 'shadow', taken_at: ctx.now });
    return { executed: false, result: 'shadow' };
  }

  let result: string;
  try {
    result = exec();
  } catch (e) {
    result = 'error: ' + (e as Error).message;
  }
  recordAction(ctx.db, { finding_id: findingId, kind, payload, shadow: 0, result, taken_at: ctx.now });
  return { executed: true, result };
}

export function writeToPane(
  ctx: ActionCtx,
  findingId: number,
  kind: string,
  pane: LiveLoc,
  text: string,
): { executed: boolean; result: string } {
  if (ctx.mode === 'live' && paneWritesSince(ctx.db, ctx.now - HOUR) >= RATE_LIMIT_PER_HOUR) {
    recordAction(ctx.db, {
      finding_id: findingId, kind, payload: text, shadow: 1,
      result: 'suppressed: hourly pane-write limit reached', taken_at: ctx.now,
    });
    return { executed: false, result: 'rate-limited' };
  }
  return perform(ctx, findingId, kind, text, () => {
    const r = ctx.send(pane.pane_id, text, pane.agent);
    if (!r.ok) throw new Error(r.detail);
    return r.detail;
  });
}

export function repoSlug(projectDir: string, gh: GhRunner): string | null {
  try {
    const out = gh(['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], projectDir).trim();
    return out || null;
  } catch {
    return null;
  }
}

// Files a fast-follow on the session's OWN repo, linking back to the Loom session
// so the issue can be traced to the conversation that produced it.
export function fileIssue(
  ctx: ActionCtx,
  findingId: number,
  projectDir: string,
  ff: FastFollow,
  sessionId: string,
): { ok: boolean; url: string } {
  const body = [
    ff.body,
    '',
    '---',
    `Filed by the Loom EM from session \`${sessionId}\`.`,
  ].join('\n');

  const args = ['issue', 'create', '--title', ff.title, '--body', body, '--label', 'fast-follow'];
  const r = perform(ctx, findingId, 'issue', `${ff.title}\n\n${body}`, () => ctx.gh(args, projectDir).trim());

  if (!r.executed) return { ok: ctx.mode === 'shadow', url: '' };
  if (r.result.startsWith('error:')) return { ok: false, url: '' };
  return { ok: true, url: r.result };
}

// Wrap up a finished session: mark it saved (exempt from the 7-day prune, pinned
// in the dashboard's Saved section) and free its pane. Callers MUST have filed
// the session's fast-follows first — nothing is dropped, only deferred.
export function wrapUpSession(
  ctx: ActionCtx,
  findingId: number,
  pane: LiveLoc,
  sessionId: string,
  agent: 'claude' | 'codex',
): { executed: boolean; result: string } {
  return perform(ctx, findingId, 'wrapup', `save + close ${sessionId}`, () => {
    ctx.db.prepare(`UPDATE chats SET saved = 1, saved_at = ? WHERE agent = ? AND session_id = ?`)
      .run(ctx.now, agent, sessionId);
    const r = ctx.close(pane.pane_id, agent);
    if (!r.ok) throw new Error(r.detail);
    return 'saved and closed';
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/em/actions.test.ts && npx tsc --noEmit`
Expected: all 11 cases PASS.

- [ ] **Step 5: Commit**

```bash
git add src/em/actions.ts tests/em/actions.test.ts
git commit -m "feat(em): route every intervention through a shadow-aware chokepoint

One perform() decides whether an action executes or is only recorded, so shadow
mode is a single branch rather than a rule each action must remember. Pane
writes are capped hourly to bound a miscalibrated detector.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: The tick loop

Two entry points wired into the server's existing interval block: a 30-second scan that costs nothing, and a 5-minute triage pass that calls the model once per new finding.

**Files:**
- Create: `src/em/index.ts`
- Modify: `src/server.ts` (add `/api/em`; add both intervals to the bottom `import.meta.url` block)
- Test: `tests/em/tick.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–7, plus `openDb`, `toChatViews`'s underlying `chats` table, and `liveSessions` from `src/placements.ts`.
- Produces: `scanTick(db, live, now, opts?)`, `triageTick(db, now, opts?)`, `COOLDOWN_MS`.

- [ ] **Step 1: Write the failing tests**

Create `tests/em/tick.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../../src/db.ts';
import { scanTick, triageTick } from '../../src/em/index.ts';
import { newFindings, setEmMode } from '../../src/em/ledger.ts';
import type { LiveLoc } from '../../src/dashboard.ts';

const NOW = 2_000_000_000_000;

const PANE: LiveLoc = {
  agent: 'claude', session_id: 's1', pane_id: '%1', tmux_session: 'loom-a',
  window_index: '0', pane_index: '0', running: true, working: false,
};

function seed(db: any, over: Record<string, unknown> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-tick-'));
  const jsonl = path.join(dir, 's1.jsonl');
  fs.writeFileSync(jsonl, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Which approach do you want?' }] } }));
  // 12 minutes, not 10: computeSignals takes max(last_active_at, mtime), and
  // WRAPPABLE needs idleMs STRICTLY GREATER than its 10-minute threshold. Both
  // values must clear it or the wrap-up cases silently detect nothing.
  const idle = 12 * 60_000;
  const old = new Date(NOW - idle);
  fs.utimesSync(jsonl, old, old);
  db.prepare(`INSERT INTO chats (agent, session_id, project_dir, jsonl_path, started_at, ended_at,
    last_active_at, message_count, first_message, state, title, jsonl_mtime, last_indexed_at, summary_dirty)
    VALUES ('claude','s1',@project_dir,@jsonl_path,@started,@ended,@ended,12,'do it',@state,'t',0,0,0)`)
    .run({ project_dir: dir, jsonl_path: jsonl, started: NOW - 3_600_000, ended: NOW - idle, state: 'waiting_on_user', ...over });
  return { dir, jsonl };
}

describe('scanTick', () => {
  it('records a finding for a blocked session and costs no model call', () => {
    const db = openDb(':memory:');
    seed(db);
    const n = scanTick(db, { 'claude:s1': PANE }, NOW);
    expect(n).toBe(1);
    expect(newFindings(db)[0].kind).toBe('BLOCKED');
    db.close();
  });

  it('does not re-record the same finding on the next tick', () => {
    const db = openDb(':memory:');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    expect(scanTick(db, { 'claude:s1': PANE }, NOW + 30_000)).toBe(0);
    db.close();
  });

  it('records nothing when the mode is off', () => {
    const db = openDb(':memory:');
    setEmMode(db, 'off');
    seed(db);
    expect(scanTick(db, { 'claude:s1': PANE }, NOW)).toBe(0);
    db.close();
  });
});

describe('triageTick', () => {
  it('answers a blocked session in shadow mode without touching the pane', async () => {
    const db = openDb(':memory:'); // defaults to shadow
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const send = vi.fn();
    const runner = vi.fn(async () => '{"decision":"answer","answer":"Use the Dropdown.","citation":"AGENTS.md"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send });
    expect(runner).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
    const row = db.prepare(`SELECT * FROM em_actions`).get() as any;
    expect(row.kind).toBe('answer');
    expect(row.shadow).toBe(1);
    expect(row.payload).toContain('Use the Dropdown.');
    db.close();
  });

  it('sends the answer to the pane in live mode', async () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const send = vi.fn(() => ({ ok: true, detail: 'sent' }));
    const runner = vi.fn(async () => '{"decision":"answer","answer":"Use the Dropdown.","citation":"AGENTS.md"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send });
    expect(send).toHaveBeenCalledOnce();
    expect((send as any).mock.calls[0][1]).toContain('Use the Dropdown.');
    db.close();
  });

  it('marks an escalated finding as escalated and never writes to the pane', async () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const send = vi.fn(() => ({ ok: true, detail: 'sent' }));
    const runner = vi.fn(async () => '{"decision":"escalate","reason":"pricing is a product call"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send });
    const f = db.prepare(`SELECT status FROM em_findings`).get() as any;
    expect(f.status).toBe('escalated');
    expect(newFindings(db).length).toBe(0);
    db.close();
  });

  it('leaves no finding in "new" after a pass, so nothing is triaged twice', async () => {
    const db = openDb(':memory:');
    seed(db);
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const runner = vi.fn(async () => '{"decision":"escalate","reason":"x"}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, send: vi.fn() });
    expect(newFindings(db).length).toBe(0);
    db.close();
  });

  it('files fast-follows BEFORE wrapping up, so nothing is dropped', async () => {
    const db = openDb(':memory:');
    setEmMode(db, 'live');
    seed(db, { state: 'done' });
    scanTick(db, { 'claude:s1': PANE }, NOW);
    const order: string[] = [];
    const gh = vi.fn(() => { order.push('issue'); return 'https://github.com/o/r/issues/9'; });
    const close = vi.fn(() => { order.push('close'); return { ok: true, detail: 'closed' }; });
    const runner = vi.fn(async () => '{"fast_follows":[{"title":"Add a test","body":"uncovered"}]}');
    await triageTick(db, NOW, { live: { 'claude:s1': PANE }, makeRunner: () => runner, gh, close });
    expect(order).toEqual(['issue', 'close']);
    db.close();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/em/tick.test.ts`
Expected: FAIL — cannot resolve `../../src/em/index.ts`.

- [ ] **Step 3: Implement the loop**

Create `src/em/index.ts`:

```typescript
import type Database from 'better-sqlite3';
import type { ChatRow } from '../types.ts';
import type { LiveLoc } from '../dashboard.ts';
import { computeSignals } from './signals.ts';
import { detect } from './detectors.ts';
import {
  getEmMode, recordFinding, newFindings, setFindingStatus, type FindingRow,
} from './ledger.ts';
import {
  makeRunner as defaultMakeRunner, transcriptTail, lastAssistantText, buildBlockedPrompt,
  parseBlockedTriage, buildFastFollowPrompt, parseFastFollows, buildHandoffPrompt,
} from './triage.ts';
import { makeActionCtx, writeToPane, fileIssue, wrapUpSession, type ActionCtx } from './actions.ts';
import type { ClaudeRunner } from '../analyzer.ts';
import { agentSessionKey } from '../placements.ts';

// One intervention per (session, detector) per hour. Without it a stuck session
// is re-detected every 30 seconds forever.
export const COOLDOWN_MS = 3_600_000;

function chatRows(db: Database.Database): ChatRow[] {
  return db.prepare(`SELECT * FROM chats`).all() as ChatRow[];
}

// Fast tick. Pure SQL, one stat and one bounded tail-read per chat. No model.
export function scanTick(
  db: Database.Database,
  live: Record<string, LiveLoc>,
  now: number,
  opts: { selfDir?: string } = {},
): number {
  if (getEmMode(db) === 'off') return 0;
  const signals = computeSignals(chatRows(db), live, now, opts);
  let recorded = 0;
  for (const f of detect(signals, now)) {
    if (recordFinding(db, f, COOLDOWN_MS) !== null) recorded++;
  }
  return recorded;
}

export interface TriageDeps {
  live: Record<string, LiveLoc>;
  makeRunner?: (cwd: string) => ClaudeRunner;
  send?: ActionCtx['send'];
  close?: ActionCtx['close'];
  gh?: ActionCtx['gh'];
}

// Slow tick. One model call per NEW finding — never per session, never per tick.
export async function triageTick(db: Database.Database, now: number, deps: TriageDeps): Promise<number> {
  const mode = getEmMode(db);
  if (mode === 'off') return 0;

  const ctx = makeActionCtx(db, mode, now);
  if (deps.send) ctx.send = deps.send;
  if (deps.close) ctx.close = deps.close;
  if (deps.gh) ctx.gh = deps.gh;
  const makeRunner = deps.makeRunner ?? defaultMakeRunner;

  const pending = newFindings(db);
  let handled = 0;

  for (const f of pending) {
    const chat = db
      .prepare(`SELECT * FROM chats WHERE agent = ? AND session_id = ?`)
      .get(f.agent, f.session_id) as ChatRow | undefined;
    if (!chat) {
      setFindingStatus(db, f.id, 'expired');
      continue;
    }
    const pane = deps.live[agentSessionKey(f.agent, f.session_id)] ?? null;
    try {
      await handleFinding(ctx, f, chat, pane, makeRunner(chat.project_dir));
      handled++;
    } catch {
      // A finding that cannot be triaged now is retried on the next pass only if
      // its cooldown has lapsed; leaving it 'new' forever would re-call the model
      // every 5 minutes for the rest of the session.
      setFindingStatus(db, f.id, 'expired');
    }
  }
  return handled;
}

async function handleFinding(
  ctx: ActionCtx,
  f: FindingRow,
  chat: ChatRow,
  pane: LiveLoc | null,
  runner: ClaudeRunner,
): Promise<void> {
  const tail = transcriptTail(chat.agent, chat.jsonl_path);

  if (f.kind === 'BLOCKED') {
    if (!pane) return setFindingStatus(ctx.db, f.id, 'expired');
    const question = lastAssistantText(chat.agent, chat.jsonl_path);
    if (!question) return setFindingStatus(ctx.db, f.id, 'expired');
    const verdict = parseBlockedTriage(await runner(buildBlockedPrompt(question, chat.project_dir, tail)));
    if (verdict.decision === 'escalate') {
      // Phase 2 adds the notification channels; for now the ledger IS the feed.
      setFindingStatus(ctx.db, f.id, 'escalated');
      return;
    }
    writeToPane(ctx, f.id, 'answer', pane, `${verdict.answer} (per ${verdict.citation})`);
    setFindingStatus(ctx.db, f.id, 'acted');
    return;
  }

  if (f.kind === 'WRAPPABLE') {
    if (!pane) return setFindingStatus(ctx.db, f.id, 'expired');
    const follows = parseFastFollows(await runner(buildFastFollowPrompt(tail)));
    // Nothing is dropped, only deferred: every follow-up is filed BEFORE the
    // session is closed, and a failed filing aborts the wrap-up.
    for (const ff of follows) {
      if (!fileIssue(ctx, f.id, chat.project_dir, ff, chat.session_id).ok) {
        setFindingStatus(ctx.db, f.id, 'expired');
        return;
      }
    }
    wrapUpSession(ctx, f.id, pane, chat.session_id, chat.agent);
    setFindingStatus(ctx.db, f.id, 'acted');
    return;
  }

  if (f.kind === 'BLOATED') {
    if (!pane) return setFindingStatus(ctx.db, f.id, 'expired');
    const brief = (await runner(buildHandoffPrompt(tail))).trim();
    // Phase 1 hands the brief to the session itself rather than restarting it:
    // a restart is destructive and its threshold is still uncalibrated. The
    // ledger records the brief either way, which is what Phase 2 needs to judge
    // whether auto-restart is safe.
    writeToPane(
      ctx, f.id, 'brief', pane,
      `Heads up from Loom: this session is near its context limit. Handoff brief for a fresh session: ${brief}`,
    );
    setFindingStatus(ctx.db, f.id, 'acted');
    return;
  }

  // Phase 2 detectors are declared in DetectorKind but never emitted yet.
  setFindingStatus(ctx.db, f.id, 'expired');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/em/tick.test.ts && npx tsc --noEmit`
Expected: all 9 cases PASS.

- [ ] **Step 5: Add the read API**

In `src/server.ts`, add to the imports:

```typescript
import { recentLedger, getEmMode } from './em/ledger.ts';
```

Add this route immediately before the `if (url.pathname === '/' || url.pathname === '/index.html')` block:

```typescript
    if (url.pathname === '/api/em') {
      const since = Date.now() - 24 * 3_600_000;
      const db = openDb();
      const led = recentLedger(db, since);
      const mode = getEmMode(db);
      db.close();
      return json(res, 200, { ok: true, mode, ...led });
    }
```

- [ ] **Step 6: Wire both ticks into the always-on process**

In `src/server.ts`, add to the imports:

```typescript
import { scanTick, triageTick } from './em/index.ts';
```

Inside the bottom `if (import.meta.url === ...)` block, after the existing `setInterval(snap, 15_000);`:

```typescript
  // EM fast tick: signals + detectors only. No model calls, so this is free to
  // run often — a tick with nothing wrong costs nothing.
  setInterval(() => {
    try {
      const db = openDb();
      scanTick(db, snapshot().live, Date.now());
      db.close();
    } catch (e) {
      console.error('[loom] em scan failed:', (e as Error).message);
    }
  }, 30_000);

  // EM slow tick: one model call per NEW finding. Serialized against itself so a
  // slow triage pass cannot overlap the next one and double-handle a finding.
  let triaging = false;
  setInterval(async () => {
    if (triaging) return;
    triaging = true;
    const db = openDb();
    try {
      await triageTick(db, Date.now(), { live: snapshot().live });
    } catch (e) {
      console.error('[loom] em triage failed:', (e as Error).message);
    } finally {
      db.close();
      triaging = false;
    }
  }, 300_000);
```

- [ ] **Step 7: Verify the server still starts and the route responds**

Run:
```bash
npx tsc --noEmit && yarn test
npx tsx src/server.ts &
sleep 2 && curl -s http://localhost:4317/api/em | head -c 300 && echo
kill %1
```
Expected: typecheck and suite green; the curl returns JSON containing `"mode":"shadow"`.

> If port 4317 is already taken, the installed Loom.app is running. Quit it from the tray first, and relaunch it when done.

- [ ] **Step 8: Commit**

```bash
git add src/em/index.ts src/server.ts tests/em/tick.test.ts
git commit -m "feat(em): run the scan and triage ticks in the always-on server

A 30s scan costs nothing — SQL, one stat, one bounded tail-read. A 5m triage
pass calls the model once per NEW finding and is serialized against itself.
Fast-follows are filed before a wrap-up closes anything.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: The activity feed

Shadow mode is only useful if its output is readable. This is the surface where a week of "what the EM would have done" gets reviewed.

**Files:**
- Modify: `src/dashboard.ts`
- Test: `tests/dashboard.test.ts`

**Interfaces:**
- Consumes: `/api/em` (Task 8).
- Produces: an `EM` section in the rendered dashboard.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('dashboard', ...)` block in `tests/dashboard.test.ts`:

```typescript
  it('renders the EM feed container and its fetch wiring', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('id="em-feed"');
    expect(html).toContain('id="em-mode"');
    expect(html).toContain('/api/em');
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/dashboard.test.ts -t 'EM feed'`
Expected: FAIL — `id="em-feed"` is not in the output.

- [ ] **Step 3: Add the feed markup and client code**

> **Re-read the DASHBOARD CLIENT-JS GOTCHA in Global Constraints before editing this file.** The client JS is inside a backtick template literal. **No regex literals.** Use `.split()` / `.indexOf()` / plain `.replace()` with string arguments only.

In `renderDashboard`'s HTML, add a section after the existing chat grid markup:

```html
<section id="em-section">
  <h2 class="emtitle">EM <span id="em-mode" class="emmode"></span></h2>
  <div id="em-feed" class="emfeed"></div>
</section>
```

In the inline client script, add the following. It matches the file's existing house style — `rel()` for relative times, `esc()` before any interpolation, `innerHTML` assembly, compact `function` declarations:

```javascript
function emRow(f,acts){return '<div class="emrow em-'+esc(f.status)+'"><div class="emhead"><b>'+esc(f.kind)+'</b> · '+esc(f.status)+' · '+rel(f.detected_at)+'</div>'+
  acts.map(a=>'<div class="emact'+(a.shadow?' shadow':'')+'"><span class="emtag">'+(a.shadow?'would':'did')+'</span> '+esc(a.kind)+': '+esc(a.payload)+'</div>').join('')+'</div>';}
function renderEm(d){const byF={};(d.actions||[]).forEach(a=>{(byF[a.finding_id]=byF[a.finding_id]||[]).push(a);});
  $('#em-mode').textContent=d.mode||'';
  const rows=(d.findings||[]).map(f=>emRow(f,byF[f.id]||[]));
  $('#em-feed').innerHTML=rows.length?rows.join(''):'<p class="muted">nothing yet</p>';}
function refreshEm(){fetch('/api/em').then(r=>r.json()).then(renderEm).catch(()=>{});}
```

Call `refreshEm()` once at startup and add `setInterval(refreshEm,15000);` alongside the existing refresh interval.

> **`rel` and `esc` already exist** in this script (`dashboard.ts:298` and `:306`). Reuse them — do not add another relative-time or escaping helper.
>
> `esc()` itself contains `/[&<>"]/g`, which is safe only because it has **no backslashes**. That is the precise boundary of the gotcha: a regex with a backslash in this template literal breaks the whole page. Do not add one.

Add these styles alongside the existing CSS, using the established palette from `dashboard.ts:112`. The page is single-theme (`color-scheme: dark`) — there is no light variant to write:

```css
  #em-section { padding:0 20px 24px; }
  .emtitle { font-size:14px; color:#8b93a7; font-weight:600; margin:18px 0 8px; text-transform:uppercase; letter-spacing:.6px; }
  .emmode { font-size:11px; color:#0d0f15; background:var(--warning); padding:1px 7px; border-radius:9px; text-transform:none; letter-spacing:0; }
  .emfeed { display:flex; flex-direction:column; gap:6px; }
  .emrow { border:1px solid #232634; border-left:3px solid var(--pending); border-radius:6px; padding:8px 10px; background:#11141d; }
  .emrow.em-escalated { border-left-color:var(--waiting_on_user); }
  .emrow.em-acted { border-left-color:var(--done); }
  .emrow.em-expired { opacity:.55; }
  .emhead { font-size:12px; color:#8b93a7; }
  .emact { font-size:12px; margin-top:5px; color:#e6e6e6; word-break:break-word; }
  .emact.shadow { color:#8b93a7; font-style:italic; }
  .emtag { font-size:10px; padding:1px 5px; border-radius:4px; background:#232634; color:#8b93a7; margin-right:5px; }
  .emact:not(.shadow) .emtag { background:var(--done); color:#0d0f15; }
```

Shadow entries read muted and italic against solid text for real ones, so a week of `would` is scannable at a glance and any stray `did` stands out immediately — which is exactly the thing to notice while calibrating.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/dashboard.test.ts`
Expected: PASS.

- [ ] **Step 5: Validate the inline JS — tsc and vitest CANNOT catch a break here**

Run:
```bash
npx tsx src/server.ts &
sleep 2 && bash scripts/check-dashboard.sh
kill %1
```
Expected: `✓ dashboard inline JS valid`.

- [ ] **Step 6: Verify the page actually renders**

Run: `npx tsx src/server.ts &` then open http://localhost:4317/ and confirm the EM section appears with the mode reading `shadow`, and that the rest of the dashboard is unchanged. Kill the server when done.

- [ ] **Step 7: Commit**

```bash
git add src/dashboard.ts tests/dashboard.test.ts
git commit -m "feat(em): render the EM activity feed

Shows each finding with the actions taken under it, marking shadow entries
[would] against [did]. Shadow mode is only useful if its output is readable —
this is the surface a week of calibration data gets reviewed on.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- [ ] `yarn test` green; `npx tsc --noEmit` clean.
- [ ] `bash scripts/check-dashboard.sh` reports valid inline JS.
- [ ] `curl -s localhost:4317/api/em` returns `"mode":"shadow"`.
- [ ] After ~30 minutes with real sessions running, `em_findings` has rows and `em_actions` rows are all `shadow = 1`.
- [ ] No pane has been written to and no GitHub issue has been filed.

## Handing off to Phase 2

Phase 2 needs Phase 1's data, not just its code. Before starting it, review a week of ledger output:

```sql
SELECT kind, status, COUNT(*) FROM em_findings GROUP BY kind, status;
SELECT kind, payload, result FROM em_actions ORDER BY taken_at DESC LIMIT 50;
```

The questions to answer from that data, each of which is currently a guess:

- **Is `blockedIdleMs` right?** Too low and it fires while Will is reading; too high and sessions sit blocked.
- **How often does BLOCKED triage answer vs escalate,** and — reading the `payload` of the answers — were the answers actually correct? This is the single most important calibration in the system.
- **Does BLOATED fire at a useful moment,** or too late to be worth a restart?
- **Do the extracted fast-follows read like real deferred work,** or like invented busywork?

Only flip `em_mode` to `live` once those read well. Then implement STALLED, SPINNING, DRIFTING, and CONVERGING, the remaining three escalation channels, and promote BLOATED from "send the brief" to "restart with the brief".
