import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { CLAUDE_PROJECTS_DIR, TOOL_DIR, encodeProjectDir } from './paths.ts';
import type { TmuxRunner, WorldState } from './compact.ts';
import type { ManagedPaneResult } from './managed.ts';
import { claudeCommand, type LaunchSettings } from './launch.ts';
import { getSetting } from './settingsSchema.ts';
import { MCP_SERVER_NAME } from './orchmcp.ts';
import { logOrch, orchSettings } from './orchestrator.ts';
import { pretrustFolder } from './orchstart.ts';

// The orchestrator session (design §8): one normal, interactive Claude Code
// session in a Loom-managed window, started when Loom starts and restarted when
// it dies, always with Remote Control on, so it can be reached from a phone. It sees
// every other chat through the `loom` MCP server (src/orchmcp.ts) and hears about
// changes from Loom's event batches (src/orchestrator.ts); it never polls.
//
// Remote Control is the real CLI flag: `claude --remote-control [name]` ("Start an
// interactive session with Remote Control enabled", claude 2.1.318). Its phone
// link is printed in the session's own terminal; remoteControlUrl() reads it back
// off the pane for the Copy phone link button.

export const ORCH_DISPLAY_NAME = 'Loom orchestrator';
export const ORCH_PROMPT_OVERRIDE = 'prompt.override.md';
export const ORCH_PANE_NAME = 'orchestrator';
export const ORCH_ROLE = 'orchestrator'; // pane option @loom_role, so a reused %id is never mistaken for it

export const ORCH_PROMPT = `You are the Loom orchestrator: one agent that knows about every other agent (Claude Code and Codex chats) running on this Mac, so the user does not have to check each one.

What you can see and do is the \`loom\` MCP server:
- list_chats, chat_tail: every chat, its state (working, your_turn, not_running), summary, pane name, PR and Slack threads; the last turns of any one.
- pr_status, slack_thread: a PR's checks and review; which chat owns a Slack thread.
- send_to_chat: type a message into another chat. When the user tells you to tell an agent something, relay it right away, without asking them to confirm, in plain words the agent can act on. If the result says "queued", the user is looking at that chat; say it is queued and goes out when they leave it.
- list_items, upsert_item, resolve_item: the status rail. This table is the source of truth, not your memory: compaction or a restart can wipe your context but never the items.

Items:
- needs_you: only a decision or action that is the user's and nobody else's (a question an agent is blocked on, a PR ready for their approval, something only they can answer). Title a few words, why one line: what is needed and what it blocks.
- blocked: waiting on someone other than the user (a teammate, an agency, CI). Put who in "who".
- moving: an agent making progress. One per chat (ref_type chat), "who" is its pane name, "why" its current stage.
- done: finished today. Writing kind done resolves it.
Point every item at what it is about (ref_type chat / pr / slack + ref_id) so the user can jump to it. Keep the table accurate: update an item the moment it changes, resolve what no longer applies, never leave a stale needs_you.

Loom types messages starting with "[Loom events]" into this session when a chat finishes its turn, goes silent mid-turn, or a PR's checks or review change. They are not from the user. For each: look (chat_tail, pr_status) only as far as needed, update the items, and reply in one or two lines. Do not message the user about events that do not create or change a needs_you item.

When the user asks where things stand: needs-you first (numbered), then moving, then waiting on others. Keep replies concise and lead with the answer: one line per item, chat pane names and PR numbers as handles. Never invent state you have not read through the tools.`;

export interface McpSpec {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface OrchFiles {
  dir: string;
  mcpConfig: string;
  promptFile: string;
  tokenFile: string;
}

export const orchDir = (home: string = TOOL_DIR) => path.join(home, 'orchestrator');

/** The token the MCP process presents to Loom. Generated once, then reused, so a running orchestrator survives a Loom restart. */
export function ensureOrchToken(dir: string): string {
  const file = path.join(dir, 'token');
  try {
    const t = fs.readFileSync(file, 'utf-8').trim();
    if (t.length >= 32) return t;
  } catch {
    /* first run */
  }
  fs.mkdirSync(dir, { recursive: true });
  const t = randomBytes(24).toString('hex');
  fs.writeFileSync(file, t + '\n', { mode: 0o600 });
  return t;
}

/** The prompt the session starts with: `prompt.override.md` in the orchestrator's dir when it has text, else the built-in default. */
export function orchPromptText(dir: string): string {
  try {
    const o = fs.readFileSync(path.join(dir, ORCH_PROMPT_OVERRIDE), 'utf-8').trim();
    if (o) return o;
  } catch {
    /* no override */
  }
  return ORCH_PROMPT;
}

/** Write the prompt, the MCP config and the token into the orchestrator's dir. */
export function ensureOrchFiles(dir: string, mcp: McpSpec): OrchFiles {
  fs.mkdirSync(dir, { recursive: true });
  const tokenFile = path.join(dir, 'token');
  ensureOrchToken(dir);
  const promptFile = path.join(dir, 'prompt.md');
  fs.writeFileSync(promptFile, orchPromptText(dir) + '\n');
  const mcpConfig = path.join(dir, 'mcp.json');
  const server = { type: 'stdio', command: mcp.command, args: [...mcp.args, tokenFile], ...(mcp.env ? { env: mcp.env } : {}) };
  fs.writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: server } }, null, 2) + '\n');
  return { dir, mcpConfig, promptFile, tokenFile };
}

export function orchTranscriptPath(dir: string, sessionId: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, encodeProjectDir(dir), `${sessionId}.jsonl`);
}

export const KICKOFF_NEW =
  'Loom started you as the orchestrator. Call list_items and list_chats, make the items match what you find, reply with one line, then wait for [Loom events] or the user.';
export const KICKOFF_RESTART =
  'Loom restarted you (the session had exited). Re-read list_items and list_chats, fix any item that is stale, reply with one line, then wait.';

/** The shell line typed into the orchestrator's window. Flags follow perm_orchestrator; Remote Control is always on (src/launch.ts). */
export function buildOrchestratorCommand(o: { files: OrchFiles; sessionId: string; resume: boolean }, settings?: LaunchSettings): string {
  return claudeCommand(
    {
      kind: 'orch',
      dir: o.files.dir,
      sid: o.sessionId,
      resume: o.resume,
      name: ORCH_DISPLAY_NAME,
      mcpConfig: o.files.mcpConfig,
      systemPromptFile: o.files.promptFile,
      prompt: o.resume ? KICKOFF_RESTART : KICKOFF_NEW,
    },
    settings,
  );
}

/* ------------------------------------------------------------ supervision */

export const LAUNCH_GRACE_MS = 90_000; // a launch this recent is still starting up
export const CRASH_WINDOW_MS = 30 * 60_000;
export const MAX_LAUNCHES_PER_WINDOW = 5;

const SHELL = /^(zsh|bash|fish|sh)$/;

export interface SuperviseDeps {
  run: TmuxRunner;
  world: () => WorldState;
  acquire: (dir: string) => ManagedPaneResult;
  now: () => number;
  exists: (file: string) => boolean;
  uuid?: () => string;
  /** Pre-trust the folder in ~/.claude.json just before launch. Only called when orchestrator_trust is on. */
  pretrust?: (dir: string) => void;
}

export interface SuperviseMemo {
  launches: number[];
}

export type SuperviseResult =
  | { action: 'disabled' | 'running' | 'starting' | 'gave_up' | 'busy'; detail: string; paneId?: string }
  | { action: 'started' | 'restarted'; detail: string; paneId: string }
  | { action: 'refused'; detail: string };

/**
 * Is this session the orchestrator's? Any one signal is enough, so it stays out of
 * every chat list even before its session id is recorded: the recorded session id,
 * a cwd in its own directory, or (when a tmux runner is given) its pane's @loom_role.
 */
export function isOrchestratorRef(l: { session_id?: string; cwd?: string; project_dir?: string; pane_id?: string }, orchSid: string, opts: { dir?: string; run?: TmuxRunner } = {}): boolean {
  if (orchSid && l.session_id === orchSid) return true;
  const dir = opts.dir ?? orchDir();
  const cwd = l.cwd ?? l.project_dir ?? '';
  if (cwd && (cwd === dir || cwd.startsWith(dir + '/'))) return true;
  return !!(opts.run && l.pane_id && isOrchPane(opts.run, l.pane_id));
}

/** Is `paneId` (still) the orchestrator's pane? %ids restart from %0 on a new tmux server. */
export function isOrchPane(run: TmuxRunner, paneId: string): boolean {
  if (!/^%\d+$/.test(paneId)) return false;
  try {
    return run(['display-message', '-p', '-t', paneId, '#{@loom_role}']).trim() === ORCH_ROLE;
  } catch {
    return false;
  }
}

/**
 * One supervision pass: leave a running orchestrator alone, relaunch it into its
 * own window when the agent has exited, or open a new managed window when the
 * window is gone. Never more than MAX_LAUNCHES_PER_WINDOW launches in
 * CRASH_WINDOW_MS, so a session that dies at startup cannot loop forever.
 */
export function superviseOrchestrator(db: Database.Database, files: OrchFiles, deps: SuperviseDeps, memo: SuperviseMemo): SuperviseResult {
  if (!orchSettings.enabled(db)) return { action: 'disabled', detail: 'orchestrator is off' };
  const now = deps.now();
  memo.launches = memo.launches.filter((t) => now - t < CRASH_WINDOW_MS);
  let sid = orchSettings.sessionId(db);
  if (!sid) {
    sid = (deps.uuid ?? randomUUID)();
    orchSettings.setSessionId(db, sid);
  }
  let paneId = orchSettings.paneId(db);
  const world = deps.world();
  const pane = isOrchPane(deps.run, paneId) ? world.panes.find((p) => p.pane_id === paneId) : undefined;
  if (pane?.agent) return { action: 'running', detail: 'running', paneId };
  const last = memo.launches.at(-1);
  if (last !== undefined && now - last < LAUNCH_GRACE_MS) return { action: 'starting', detail: 'starting up', ...(pane ? { paneId } : {}) };
  if (memo.launches.length >= MAX_LAUNCHES_PER_WINDOW) {
    return { action: 'gave_up', detail: `exited ${memo.launches.length} times in ${CRASH_WINDOW_MS / 60_000} min; not restarting until Loom restarts` };
  }
  if (pane && !SHELL.test(pane.command)) return { action: 'busy', detail: `its window is running ${pane.command}`, paneId };
  let restarted = !!pane;
  if (!pane) {
    const a = deps.acquire(files.dir);
    if (!a.ok) return { action: 'refused', detail: a.detail };
    paneId = a.paneId;
    for (const args of [
      ['set-option', '-p', '-t', paneId, '@loom_role', ORCH_ROLE],
      ['set-option', '-p', '-t', paneId, '@name', ORCH_PANE_NAME],
      ['rename-window', '-t', paneId, ORCH_PANE_NAME],
    ]) {
      try {
        deps.run(args);
      } catch {
        /* cosmetic, except @loom_role: without it the next pass opens another window */
      }
    }
    orchSettings.setPaneId(db, paneId);
    restarted = memo.launches.length > 0 || deps.exists(orchTranscriptPath(files.dir, sid));
  }
  const resume = deps.exists(orchTranscriptPath(files.dir, sid));
  // Editing ~/.claude.json needs the user's consent (wizard step 10 / Settings).
  if (getSetting(db, 'orchestrator_trust')) (deps.pretrust ?? ((d: string) => void pretrustFolder(d)))(files.dir);
  try {
    fs.writeFileSync(files.promptFile, orchPromptText(files.dir) + '\n'); // an edited override applies to the next start
  } catch {
    /* the last written prompt still stands */
  }
  const cmd = buildOrchestratorCommand({ files, sessionId: sid, resume });
  try {
    deps.run(['send-keys', '-t', paneId, cmd, 'Enter']);
  } catch (e) {
    return { action: 'refused', detail: 'send-keys failed: ' + (e as Error).message };
  }
  memo.launches.push(now);
  const action = restarted ? 'restarted' : 'started';
  logOrch(db, 'started', ORCH_PANE_NAME, `${action} the orchestrator (${resume ? 'resumed its session' : 'new session'})`, now);
  return { action, detail: resume ? 'resumed' : 'new session', paneId };
}

/** The Remote Control link the session printed in its own terminal, if it is still on screen or in scrollback. */
export function remoteControlUrl(run: TmuxRunner, paneId: string): string {
  if (!paneId) return '';
  try {
    const out = run(['capture-pane', '-p', '-J', '-t', paneId, '-S', '-400']);
    const hits = out.match(/https:\/\/claude\.ai\/code[^\s'")\]]*/g);
    return hits?.at(-1) ?? '';
  } catch {
    return '';
  }
}
