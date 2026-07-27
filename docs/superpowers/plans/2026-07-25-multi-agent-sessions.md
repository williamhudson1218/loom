# Multi-agent sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Loom index Claude Code and Codex sessions from one board, resume each with its native agent, and explicitly start a fresh alternate-agent session in the same project/pane.

**Architecture:** Normalize both JSONL formats into an agent-tagged session record and store it under an agent-qualified identity in SQLite. The dashboard receives the source agent and persisted default-agent setting, while a centralized launcher selects native resume versus an alternate-agent fresh start. Pane snapshots and process detection retain the agent so restore is accurate.

**Tech Stack:** TypeScript, Node.js, better-sqlite3, Vitest, tmux, Claude Code CLI, Codex CLI, Electron packaging.

## Global Constraints

- Loom remains a local-only, macOS/tmux-focused single-developer app.
- `agent` values are exactly `claude` and `codex`.
- Native resume retains context only for the session's recorded agent.
- Selecting a different agent starts a fresh session in the existing session's `project_dir`; no transcript or source session ID is transferred.
- Do not alter either CLI's on-disk session files.
- Keep current active-window, saved-chat, and mtime-gated indexing behavior.
- Branch is Claude-only in this release.

---

## File structure

- `src/types.ts` — agent-aware session/database/launch types.
- `src/schema.ts`, `src/db.ts` — composite chat identity and persisted setting migration.
- `src/paths.ts`, `src/parser.ts`, `src/codexParser.ts`, `src/indexer.ts` — source discovery, parsing, and upsert.
- `src/transcript.ts`, `src/analyzer.ts` — normalized transcript and summary processing.
- `src/placements.ts`, `src/goto.ts`, `src/snapshot.ts`, `src/restore.ts` — agent-aware pane lifecycle.
- `src/dashboard.ts`, `src/server.ts` — card badges, default-agent picker, safe launch routes.
- `tests/fixtures/codex-chat.jsonl` and focused Vitest files — representative regression coverage.
- `README.md`, `SETUP.md` — CLI requirements and precise resume/fresh-start behavior.

### Task 1: Make storage and settings agent-aware

**Files:**
- Modify: `src/types.ts`
- Modify: `src/schema.ts`
- Modify: `src/db.ts`
- Modify: `tests/db.test.ts`

**Interfaces:**
- Produces `export type Agent = 'claude' | 'codex'`.
- Produces `ParsedChat.agent`, `ChatRow.agent`, `ChatKey = Pick<ParsedChat, 'agent' | 'session_id'>`.
- Produces `getDefaultAgent(db): Agent` and `setDefaultAgent(db, agent: Agent): void`.

- [ ] **Step 1: Write the failing migration/settings tests**

```ts
it('migrates legacy Claude rows and permits the same id for both agents', () => {
  const db = openLegacyDbWithChat({ session_id: 'same-id' });
  applySchema(db);
  expect(db.prepare('SELECT agent FROM chats WHERE session_id=?').get('same-id')).toEqual({ agent: 'claude' });
  insertChat(db, { agent: 'codex', session_id: 'same-id' });
  expect(db.prepare('SELECT COUNT(*) AS n FROM chats WHERE session_id=?').get('same-id')).toEqual({ n: 2 });
});
it('defaults to Claude and persists a chosen default agent', () => {
  const db = openDb(':memory:');
  expect(getDefaultAgent(db)).toBe('claude');
  setDefaultAgent(db, 'codex');
  expect(getDefaultAgent(db)).toBe('codex');
});
```

- [ ] **Step 2: Verify failure**

Run: `yarn vitest run tests/db.test.ts`

Expected: FAIL because `agent`, composite migration, and settings helpers do not exist.

- [ ] **Step 3: Implement the minimal schema boundary**

```ts
export type Agent = 'claude' | 'codex';
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT OR IGNORE INTO settings(key, value) VALUES ('default_agent', 'claude');
```

Use a transaction to migrate existing `chats`: create `chats_v2` with `agent TEXT NOT NULL` and `PRIMARY KEY (agent, session_id)`, copy every legacy row with literal `agent = 'claude'`, drop old `chats`, rename `chats_v2`, and recreate current indexes. New databases create the composite-key table directly.

- [ ] **Step 4: Verify pass**

Run: `yarn vitest run tests/db.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/types.ts src/schema.ts src/db.ts tests/db.test.ts
git commit -m "feat: add agent-aware Loom session storage"
```

### Task 2: Parse and index Codex sessions

**Files:**
- Modify: `src/paths.ts`, `src/parser.ts`, `src/indexer.ts`
- Create: `src/codexParser.ts`, `tests/fixtures/codex-chat.jsonl`
- Modify: `tests/parser.test.ts`, `tests/indexer.test.ts`

**Interfaces:**
- Produces `parseCodexJsonlFile(jsonlPath: string): Promise<ParsedChat>`.
- Produces `listCodexSessionJsonls(sessionsDir?: string): string[]`.

- [ ] **Step 1: Add fixture and failing parser/indexer tests**

```ts
it('parses Codex metadata and conversation events', async () => {
  const c = await parseCodexJsonlFile(CODEX_FIX);
  expect(c).toMatchObject({ agent: 'codex', session_id: '019f-test', project_dir: '/Users/me/dev/proj', first_message: 'fix the deployment', message_count: 2 });
});
it('keeps same-id Claude and Codex chats separate', async () => {
  upsertChat(db, { ...(await parseJsonlFile(CLAUDE_FIX)), session_id: 'same-id' }, 1, 1);
  upsertChat(db, { ...(await parseCodexJsonlFile(CODEX_FIX)), session_id: 'same-id' }, 1, 1);
  expect(db.prepare('SELECT COUNT(*) AS n FROM chats').get()).toEqual({ n: 2 });
});
```

- [ ] **Step 2: Verify failure**

Run: `yarn vitest run tests/parser.test.ts tests/indexer.test.ts`

Expected: FAIL because Codex parsing/discovery does not exist.

- [ ] **Step 3: Implement source-specific parsing and upsert**

```ts
export const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
if (obj.type === 'session_meta') {
  session_id ||= obj.payload?.session_id ?? obj.payload?.id ?? '';
  project_dir ||= obj.payload?.cwd ?? '';
}
if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
  const text = obj.payload.message;
}
```

Set `agent: 'claude'` in the existing parser. Recursively discover only `.jsonl` files beneath `CODEX_SESSIONS_DIR`; dispatch by source in `refresh`. Update insert/select/update filters in `upsertChat` to use `agent` and `session_id`; retain `jsonl_path` for the cheap mtime lookup.

- [ ] **Step 4: Verify pass**

Run: `yarn vitest run tests/parser.test.ts tests/indexer.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/paths.ts src/parser.ts src/codexParser.ts src/indexer.ts tests/fixtures/codex-chat.jsonl tests/parser.test.ts tests/indexer.test.ts
git commit -m "feat: index Codex sessions in Loom"
```

### Task 3: Normalize transcripts and summaries

**Files:**
- Modify: `src/transcript.ts`, `src/analyzer.ts`
- Modify: `tests/transcript.test.ts`, `tests/analyzer-run.test.ts`

**Interfaces:**
- Produces `readTranscript(agent: Agent, jsonlPath: string, opts?): Msg[]`.
- Produces `transcriptToText(agent: Agent, jsonlPath: string, cap?): Promise<string>`.

- [ ] **Step 1: Write failing Codex transcript and composite-summary tests**

```ts
it('reads Codex user and assistant prose', () => {
  expect(readTranscript('codex', CODEX_FIX)).toEqual([
    { role: 'user', text: 'fix the deployment' },
    { role: 'assistant', text: 'I found the failed health check.' },
  ]);
});
it('updates summaries with an agent-qualified key', async () => {
  await summarizeDirty(db, async () => validSummaryJson);
  expect(row(db, 'claude', 'same-id').summary_dirty).toBe(0);
  expect(row(db, 'codex', 'same-id').summary_dirty).toBe(0);
});
```

- [ ] **Step 2: Verify failure**

Run: `yarn vitest run tests/transcript.test.ts tests/analyzer-run.test.ts`

Expected: FAIL because current functions assume Claude JSONL and updates use only `session_id`.

- [ ] **Step 3: Implement agent-dispatched extraction**

```ts
export function readTranscript(agent: Agent, jsonlPath: string, opts = {}): Msg[] {
  return agent === 'codex' ? readCodexTranscript(jsonlPath, opts) : readClaudeTranscript(jsonlPath, opts);
}
const writeSummary = db.prepare(`UPDATE chats SET ... WHERE agent=@agent AND session_id=@session_id`);
```

Extract Codex `event_msg` user/assistant text while excluding tool logs. Dispatch `transcriptToText` by `row.agent`. Keep the existing headless Claude runner for summaries, but change summary wording from “Claude Code coding session” to “coding session.”

- [ ] **Step 4: Verify pass**

Run: `yarn vitest run tests/transcript.test.ts tests/analyzer-run.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/transcript.ts src/analyzer.ts tests/transcript.test.ts tests/analyzer-run.test.ts
git commit -m "feat: summarize sessions from either agent"
```

### Task 4: Make pane operations agent-aware

**Files:**
- Modify: `src/placements.ts`, `src/goto.ts`, `src/snapshot.ts`, `src/restore.ts`
- Modify: `tests/placements.test.ts`, `tests/restore.test.ts`
- Create: `tests/goto.test.ts`

**Interfaces:**
- Produces `launchInPane({ paneId, projectDir, sessionId, sourceAgent, selectedAgent, fork }): GotoResult`.
- Produces `buildLaunchCommand(input: LaunchInput): string`, `LiveInfo.agent`, and `PaneSnap.agent?: Agent`.

- [ ] **Step 1: Write failing launch/process/restore tests**

```ts
it('uses native resume only for a matching source/selected agent', () => {
  expect(buildLaunchCommand({ sourceAgent: 'codex', selectedAgent: 'codex', sessionId: 's', projectDir: '/p' })).toContain("cd '/p' && codex resume 's'");
});
it('starts a fresh alternate agent without a source id', () => {
  expect(buildLaunchCommand({ sourceAgent: 'claude', selectedAgent: 'codex', sessionId: 'old', projectDir: '/p' })).toBe("cd '/p' && codex");
});
it('restores Codex panes with codex resume', () => {
  expect(restore({ dryRun: true, layout: codexLayout, existing: new Set() }).log.join('\n')).toContain('codex resume');
});
```

- [ ] **Step 2: Verify failure**

Run: `yarn vitest run tests/goto.test.ts tests/placements.test.ts tests/restore.test.ts`

Expected: FAIL because launch/process/restore logic is Claude-only.

- [ ] **Step 3: Implement safe native resume and alternate fresh start**

```ts
export function buildLaunchCommand(input: LaunchInput): string {
  const cd = `cd ${shq(input.projectDir)} && `;
  if (input.sourceAgent !== input.selectedAgent) return cd + input.selectedAgent;
  if (input.selectedAgent === 'codex') return cd + `codex resume ${shq(input.sessionId)}`;
  return cd + `claude --resume ${shq(input.sessionId)} --dangerously-skip-permissions`;
}
```

Recognize both executables during the existing `ps`-tree walk. Add `agent` to placements (missing legacy hook records mean Claude), live state, and agent panes in snapshots. Restore uses the recorded agent's native resume. Allow branch only when `sourceAgent === selectedAgent === 'claude'`; return a clear rejected result otherwise.

- [ ] **Step 4: Verify pass**

Run: `yarn vitest run tests/goto.test.ts tests/placements.test.ts tests/restore.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/placements.ts src/goto.ts src/snapshot.ts src/restore.ts tests/goto.test.ts tests/placements.test.ts tests/restore.test.ts
git commit -m "feat: launch and restore sessions by agent"
```

### Task 5: Add dashboard controls and validated launch routes

**Files:**
- Modify: `src/dashboard.ts`, `src/server.ts`
- Modify: `tests/dashboard.test.ts`
- Create: `tests/server.test.ts`

**Interfaces:**
- Produces dashboard payload `{ defaultAgent, chats, live }`.
- Produces `PUT /api/settings/default-agent` accepting `{ agent: 'claude' | 'codex' }`.
- Produces `POST /resume?agent=<selected>&session=<id>&pane=<id>` with source agent resolved server-side.

- [ ] **Step 1: Write failing UI/API tests**

```ts
it('includes source and default agent in dashboard data', () => {
  const html = renderDashboard([{ ...view, agent: 'codex' }], 1, {}, 'codex');
  expect(html).toContain('"agent":"codex"');
  expect(html).toContain('id="default-agent"');
});
it('rejects an invalid default agent', async () => {
  expect((await request(server, 'PUT', '/api/settings/default-agent', { agent: 'other' })).status).toBe(400);
});
```

- [ ] **Step 2: Verify failure**

Run: `yarn vitest run tests/dashboard.test.ts tests/server.test.ts`

Expected: FAIL because settings/UI/selected-agent endpoints do not exist.

- [ ] **Step 3: Implement cards, setting, and action semantics**

```ts
const native = chat.agent === selectedAgent;
const actionLabel = native
  ? `Resume ${agentLabel(selectedAgent)} context`
  : `Start new ${agentLabel(selectedAgent)} here`;
```

Add header `<select id="default-agent">` options for Claude Code and Codex, persist through the settings API, and add a source-agent pill per card/details panel. The client sends selected `agent`, `session`, and `pane`; the server resolves the card's source agent from SQLite, validates the selection, and calls Task 4's centralized launcher. Hide Branch unless source and selected agent are Claude. Retain in-panel Send/Close for Claude only until Codex terminal interaction behavior has dedicated coverage.

- [ ] **Step 4: Verify pass**

Run: `yarn vitest run tests/dashboard.test.ts tests/server.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard.ts src/server.ts tests/dashboard.test.ts tests/server.test.ts
git commit -m "feat: choose agent when resuming Loom sessions"
```

### Task 6: Verify, document, package, and redeploy

**Files:**
- Modify: `README.md`, `SETUP.md`

**Interfaces:**
- Produces a tested `/Applications/Loom.app` package with dual-agent behavior.

- [ ] **Step 1: Add documentation acceptance criteria**

Add these explicit README statements:

```markdown
- Claude Code and Codex are indexed from their native local session stores.
- Native-agent resume preserves context; choosing the other agent starts fresh in the same project and selected pane.
- Both `claude` and `codex` CLIs must be installed and authenticated to use their respective controls.
```

- [ ] **Step 2: Run full automated verification**

Run: `yarn test`

Expected: PASS.

- [ ] **Step 3: Update README and setup requirements**

Document Codex's session source, default-agent picker, native-resume limitation, fresh cross-agent handoff, and Codex CLI login requirement. Preserve documentation that Claude's placement hook remains authoritative for Claude panes.

- [ ] **Step 4: Build/package and run manual smoke checks**

Run:

```bash
yarn test
./bin/chat-manager run
./bin/chat-manager restore --dry-run
cd app && yarn build && yarn rebuild && yarn dist
```

Expected: tests pass; indexing reports both sources without parser errors; dry restore includes correct native commands; package build succeeds. In disposable idle tmux panes, verify Claude→Claude and Codex→Codex preserve context, while each opposite-agent choice begins a fresh session in the card project.

- [ ] **Step 5: Commit and install the app**

```bash
git add README.md SETUP.md
git commit -m "docs: document Loom multi-agent sessions"
cp -R app/release/mac-arm64/Loom.app /Applications/Loom.app
open -a Loom
```

On Intel, copy `app/release/mac/Loom.app`. Quit the existing app before replacement and confirm the menu-bar app serves `http://localhost:4317`.

## Plan self-review

**Spec coverage:** Tasks 1–2 cover agent-qualified storage, settings, native stores, and indexing. Task 3 covers both transcript formats and summaries. Task 4 covers live state, native resume, cross-agent fresh starts, branch scope, and restore. Task 5 covers source tags, default selection, exact action labels, and server-side validation. Task 6 covers documentation, tests, packaging, deployment, and real tmux acceptance.

**Placeholder scan:** No TODO/TBD markers or unspecified implementation steps remain. Codex branching is deliberately excluded by the approved design.

**Type consistency:** `Agent`, `(agent, session_id)`, `sourceAgent`, and `selectedAgent` are used consistently through storage, parsing, pane operations, server, and dashboard tasks.
