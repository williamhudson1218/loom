import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../db.ts';
import { TOOL_DIR } from '../paths.ts';
import { formatAccelerator } from '../keymap.ts';
import { setupDone } from '../migrate.ts';
import { showWelcome } from '../welcome.ts';
import { writePluginStateFile } from '../pluginmgr.ts';
import { clearProbeMemo, probeEnvironment, type ProbeReport } from '../probe.ts';
import {
  addProject,
  addShipProject,
  checkProjectPath,
  checkShipCommand,
  defaultSyncGit,
  detectBaseBranch,
  detectRepoSlug,
  gitRepoRoot,
  listProjects,
  listShipProjects,
  updateProject,
  removeProject,
  updateShipProject,
  DEFAULT_SHIP_COMMAND,
  type SyncGit,
} from '../projects.ts';
import { applySettingsPatch, getSetting, setSetting } from '../settingsSchema.ts';
import { slackToken, slackTokenSource } from '../slackapi.ts';
import { slackMode } from '../slackmode.ts';
import { createFromTemplate, templateList } from '../watchers/templates.ts';
import { createTerminalSession } from '../terminals.ts';
import { tmux as runTmux } from '../tmux.ts';
import {
  buildSummary,
  close,
  continueStep,
  finish,
  goTo,
  isStepId,
  back as stepBack,
  parseState,
  progress,
  rail,
  rerun,
  shouldShow,
  skipStep,
  stepMeta,
  STEPS,
  type Marker,
  type Requirements,
  type SetupOrigin,
  type StepCheck,
  type StepId,
  type SummaryInput,
  type WizardCtx,
  type WizardState,
} from '../wizard.ts';
import { classifyAccelerator, practice } from './shortcut.ts';
import { CLAUDE_UPDATE_HINT, MIN_PLUGIN_CLAUDE, versionCmp } from '../claudecaps.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// The setup wizard: state, per-step writes, the environment check, Homebrew
// installs, the Claude login terminal, project discovery, and the done marker (§6).
// Every entry is gated by requireWrite(kind) in src/routes/index.ts before its
// handler runs; tests/auth.test.ts sweeps this list, so a route cannot skip it.
//
// What this file never does: install the plugin, store a token or register a
// shortcut. Those have their own routes (/api/plugin/*, /api/slack/*,
// PUT /api/settings), which the wizard page calls from the button that names
// the change. Continue only records choices (settings and project rows) and moves
// the state machine on.

/* ------------------------------------------------------------ requirements rows */

export interface RequirementRow {
  id: 'tmux' | 'claude' | 'claudever' | 'login' | 'python3' | 'gh' | 'codex';
  required: boolean;
  ok: boolean;
  title: string;
  detail: string;
  /** What the row's button does: a Homebrew install, a Claude login, or nothing. */
  fix: 'brew-tmux' | 'brew-gh' | 'login' | 'none';
  /** Why the fix button is unavailable, when it is. */
  fixBlocked?: string;
}

export interface BrewInfo {
  found: boolean;
  path?: string;
}

const verText = (v?: { raw?: string; major?: number; minor?: number } | null): string => (v?.raw ? v.raw : '');

/** The probe report as the Requirements step shows it. Pure. */
export function requirementRows(r: ProbeReport, brew: BrewInfo): RequirementRow[] {
  const brewBlocked = brew.found ? undefined : 'Homebrew is not installed. Install tmux another way, or get Homebrew from brew.sh.';
  const rows: RequirementRow[] = [];
  rows.push({
    id: 'tmux', required: true, ok: r.tmux.found, title: 'tmux',
    detail: r.tmux.found ? `Found at ${r.tmux.path}${verText(r.tmux.version) ? ', version ' + verText(r.tmux.version) : ''}${r.tmux.warning ? '. ' + r.tmux.warning : ''}` : 'Not found on PATH. Loom needs it to run and track chats.',
    fix: r.tmux.found ? 'none' : 'brew-tmux', fixBlocked: r.tmux.found ? undefined : brewBlocked,
  });
  rows.push({
    id: 'claude', required: true, ok: r.claude.found, title: 'Claude Code installed',
    detail: r.claude.found ? `Found at ${r.claude.path}${verText(r.claude.version) ? ', version ' + verText(r.claude.version) : ''}`
      : r.claude.broken ? `Found at ${r.claude.path}, but ${r.claude.broken}. Reinstall Claude Code, or set a working path in Settings › General.`
      : 'Not found. Install Claude Code, then check again. If it is installed somewhere unusual, set its path in Settings › General.',
    fix: 'none',
  });
  if (r.claude.found) {
    // The Loom plugin's commands (plugin install, plugin marketplace) first
    // shipped in Claude Code 2.0.20 (src/claudecaps.ts).
    const v = verText(r.claude.version);
    const newEnough = !!v && versionCmp(v, MIN_PLUGIN_CLAUDE) >= 0;
    rows.push({
      id: 'claudever', required: false, ok: newEnough, title: `Claude Code ${MIN_PLUGIN_CLAUDE} or newer`,
      detail: newEnough ? `Version ${v}.`
        : v ? `Version ${v} is too old for the Loom plugin, which needs ${MIN_PLUGIN_CLAUDE} or newer. ${CLAUDE_UPDATE_HINT}`
        : `Loom could not read the Claude Code version. The Loom plugin needs ${MIN_PLUGIN_CLAUDE} or newer. ${CLAUDE_UPDATE_HINT}`,
      fix: 'none',
    });
  }
  const loggedIn = !!r.claude.auth?.loggedIn;
  rows.push({
    id: 'login', required: true, ok: r.claude.found && loggedIn, title: 'Claude Code logged in',
    detail: !r.claude.found ? 'Install Claude Code first.' : loggedIn ? 'Logged in.' : 'No active login. Summaries and new chats need one.',
    fix: r.claude.found && !loggedIn ? 'login' : 'none',
    fixBlocked: r.claude.found && !loggedIn && !r.tmux.found ? 'Install tmux first: the login opens in a Loom terminal tab.' : undefined,
  });
  rows.push({
    id: 'python3', required: true, ok: r.python3.found, title: 'python3',
    detail: r.python3.found ? `Found at ${r.python3.path}${verText(r.python3.version) ? ', version ' + verText(r.python3.version) : ''}` : 'Not found. The plugin hooks are Python 3. Run xcode-select --install in a terminal to get the Xcode Command Line Tools, which include it.',
    fix: 'none',
  });
  rows.push({
    id: 'gh', required: false, ok: r.gh.found && !!r.gh.auth?.loggedIn, title: 'GitHub CLI (gh)',
    detail: !r.gh.found ? 'Not installed. Needed for PR status, checks and the Ship button.' : r.gh.auth?.loggedIn ? `Found at ${r.gh.path}, logged in${r.gh.auth.hosts.length ? ' to ' + r.gh.auth.hosts.join(', ') : ''}.` : `Found at ${r.gh.path}, not logged in. Run gh auth login in a terminal.`,
    fix: r.gh.found ? 'none' : 'brew-gh', fixBlocked: r.gh.found ? undefined : brewBlocked,
  });
  rows.push({
    id: 'codex', required: false, ok: r.codex.found, title: 'Codex',
    detail: r.codex.found ? `Found at ${r.codex.path}.` : 'Not installed. Only needed if you use Codex chats.',
    fix: 'none',
  });
  return rows;
}

export const requirementsOf = (r: ProbeReport): Requirements => ({
  tmux: r.tmux.found,
  claude: r.claude.found,
  claudeLoggedIn: !!r.claude.auth?.loggedIn,
  python3: r.python3.found,
});

/* ------------------------------------------------------------ project discovery */

export interface Discovered {
  path: string;
  name: string;
  mtime: number;
}

/**
 * Folders Claude Code has been run in, read from ~/.claude/projects/<folder>/*.jsonl
 * (each transcript's lines carry the cwd). Offered as unchecked suggestions
 * only. Read-only. Skips the home folder itself, worktrees, temp and hidden
 * folders and anything already a project.
 */
export function discoverProjectDirs(claudeHome: string, home: string, known: Set<string>, limit = 12): Discovered[] {
  const root = path.join(claudeHome, 'projects');
  let dirs: { dir: string; mtime: number }[] = [];
  try {
    dirs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => ({ dir: path.join(root, d.name), mtime: fs.statSync(path.join(root, d.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 80);
  } catch {
    return [];
  }
  const out: Discovered[] = [];
  const seen = new Set<string>();
  for (const { dir, mtime } of dirs) {
    if (out.length >= limit) break;
    const cwd = cwdOf(dir);
    if (!cwd || seen.has(cwd) || known.has(cwd)) continue;
    seen.add(cwd);
    const underHome = cwd.startsWith(home + '/');
    const scratch = !underHome && (cwd.startsWith('/tmp') || cwd.startsWith('/private/tmp') || cwd.startsWith('/var/folders') || cwd.startsWith('/private/var/folders'));
    if (cwd === home || cwd === '/' || scratch || cwd.includes('/.worktrees/') || cwd.includes('/node_modules/') || (underHome && /(^|\/)\.[^/]/.test(cwd.slice(home.length)))) continue;
    const c = checkProjectPath(cwd);
    if (!c.ok || known.has(c.path)) continue;
    out.push({ path: c.path, name: path.basename(c.path), mtime });
  }
  return out;
}

function cwdOf(projectDir: string): string {
  try {
    const files = fs
      .readdirSync(projectDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => ({ f, m: fs.statSync(path.join(projectDir, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return '';
    const fd = fs.openSync(path.join(projectDir, files[0]!.f), 'r');
    try {
      const buf = Buffer.alloc(32 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString('utf8').split('\n')) {
        // string methods only: a cheap scan for the "cwd" key, then JSON.parse on the value
        const at = line.indexOf('"cwd":"');
        if (at < 0) continue;
        const start = at + 6;
        let end = start + 1;
        while (end < line.length && !(line[end] === '"' && line[end - 1] !== '\\')) end++;
        try {
          const v: unknown = JSON.parse(line.slice(start, end + 1));
          if (typeof v === 'string' && path.isAbsolute(v)) return v;
        } catch {
          /* next line */
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    /* unreadable: no suggestion */
  }
  return '';
}

/* ------------------------------------------------------------ ship options */

export interface ShipOption {
  path: string;
  name: string;
  repo: string;
  base: string;
  command: string;
  /** Already on Ship (a re-run). */
  existing: boolean;
  enabled: boolean;
  label_required: boolean;
}

/** Projects with a GitHub remote, with what Ship would store for each. Projects with no remote are not listed. */
export function shipOptions(db: Database.Database, git: SyncGit = defaultSyncGit): ShipOption[] {
  const rows = new Map(listShipProjects(db, { includeDisabled: true }).map((s) => [s.project_dir, s]));
  const out: ShipOption[] = [];
  const seen = new Set<string>();
  for (const p of listProjects(db)) {
    const root = gitRepoRoot(p.path, git);
    if (!root || seen.has(root)) continue;
    const repo = detectRepoSlug(root, git);
    if (!repo) continue; // no git remote: off, and not listed
    seen.add(root);
    const row = rows.get(root);
    out.push({
      path: root, name: p.name, repo,
      base: row?.base_branch ?? detectBaseBranch(root, git),
      command: row?.ship_command ?? DEFAULT_SHIP_COMMAND,
      existing: !!row, enabled: row ? row.enabled : true, label_required: row ? row.label_required : false,
    });
  }
  return out;
}

/* ------------------------------------------------------------ watcher templates (T15's API, §9.2) */

export interface TemplateInfo {
  id: string;
  label: string;
  description: string;
  group: 'slack' | 'chats' | 'prs';
  /** direct: needs the Direct Slack app. gh: needs an authed gh. */
  needs: 'direct' | 'gh' | 'orchestrator' | null;
}

/** The mock's 11 starter templates, used for display until the watcher engine's own list is wired in. */
export const FALLBACK_TEMPLATES: TemplateInfo[] = [
  { id: 'slack-pr-posts', label: 'PRs posted in a channel', description: 'Start a read-only review chat when a GitHub PR link appears.', group: 'slack', needs: 'direct' },
  { id: 'slack-mentions', label: 'Posts that mention me', description: 'Start a chat with the post and its thread.', group: 'slack', needs: 'direct' },
  { id: 'slack-bot-phrase', label: 'Bot alerts containing a phrase', description: 'Start a chat when a bot posts text such as "deploy failed".', group: 'slack', needs: 'direct' },
  { id: 'chat-blocked-tool', label: 'Stuck waiting on a tool', description: 'A chat has been blocked for 5 minutes. Notify me.', group: 'chats', needs: null },
  { id: 'chat-done', label: 'Finished, ready to wrap up', description: 'Work is done and nothing is pending. Notify me.', group: 'chats', needs: null },
  { id: 'chat-context', label: 'Context nearly full', description: 'A chat passed 85 percent of its context. Message it to wrap up.', group: 'chats', needs: null },
  { id: 'chat-silent', label: 'Silent mid-task', description: 'No output for 10 minutes while working. Tell the orchestrator.', group: 'chats', needs: null },
  { id: 'chat-your-turn', label: 'Flipped to Your turn', description: 'A chat now needs you. Mac notification.', group: 'chats', needs: null },
  { id: 'pr-checks-red', label: 'Checks went red', description: 'Message the chat that owns the PR with the failing check.', group: 'prs', needs: 'gh' },
  { id: 'pr-changes', label: 'Review requested changes', description: 'Start a chat to address the review comments.', group: 'prs', needs: 'gh' },
  { id: 'pr-green', label: 'Approved and green', description: 'Notify me that it is ready to merge.', group: 'prs', needs: 'gh' },
];

/** The watcher engine, as the wizard sees it. T15 supplies the real one; until then create() reports it is unavailable. */
export interface WatcherTemplatePort {
  list(): TemplateInfo[];
  /** Create the chosen templates Disabled or in Shadow. Nothing runs live. */
  create(db: Database.Database, ids: string[]): Promise<{ ok: true; created: number } | { ok: false; detail: string }>;
  /** How many watchers exist, for the Done summary. */
  count(db: Database.Database): number;
}

const GROUPS: Record<string, TemplateInfo['group']> = { Slack: 'slack', Chats: 'chats', 'Pull requests': 'prs' };
const NEEDS: Record<string, TemplateInfo['needs']> = { slack_direct: 'direct', gh: 'gh', orchestrator: 'orchestrator' };

/** The watcher engine's own templates (src/watchers/templates.ts). Each is created Disabled, in Shadow. */
const defaultTemplates: WatcherTemplatePort = {
  list: () =>
    templateList().map((t) => ({
      id: t.id, label: t.label, description: t.description,
      group: GROUPS[String(t.group)] ?? 'chats', needs: NEEDS[String(t.needs)] ?? null,
    })),
  create: async (db, ids) => {
    let n = 0;
    for (const id of ids) {
      const r = createFromTemplate(db, id, { enabled: false, run_mode: 'shadow' });
      if (!r.ok) return { ok: false, detail: `${id}: ${r.detail}` };
      n++;
    }
    return { ok: true, created: n };
  },
  count: (db) => {
    try {
      return (db.prepare(`SELECT COUNT(*) AS n FROM watchers`).get() as { n: number }).n;
    } catch {
      return 0;
    }
  },
};

/* ------------------------------------------------------------ install jobs and login terminal */

export interface InstallJob {
  id: string;
  tool: 'tmux' | 'gh';
  status: 'running' | 'done' | 'failed';
  log: string;
  code: number | null;
}

export const INSTALLABLE = ['tmux', 'gh'] as const;

export interface WizardDeps {
  openDb(): Database.Database;
  probe(db: Database.Database, fresh: boolean): Promise<ProbeReport>;
  /** Homebrew, if present. Loom never installs it. */
  brew(): BrewInfo;
  /** Start `brew install <tool>`; returns a handle the page polls. */
  install(tool: 'tmux' | 'gh', brewPath: string): InstallJob;
  getJob(id: string): InstallJob | null;
  /** Open `claude auth login` in a Loom terminal session. */
  openLogin(claudePath: string): { ok: true; session: string; window: string } | { ok: false; detail: string };
  discover(known: Set<string>): Discovered[];
  git: SyncGit;
  templates: WatcherTemplatePort;
  now(): number;
}

function findBrew(): BrewInfo {
  for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return { found: true, path: p };
    } catch {
      /* next */
    }
  }
  return { found: false };
}

const jobs = new Map<string, InstallJob>();
let jobSeq = 0;

function startBrewInstall(tool: 'tmux' | 'gh', brewPath: string): InstallJob {
  const job: InstallJob = { id: `i${Date.now().toString(36)}${++jobSeq}`, tool, status: 'running', log: '', code: null };
  jobs.set(job.id, job);
  const add = (b: Buffer) => {
    job.log = (job.log + b.toString('utf8')).slice(-8000);
  };
  // Homebrew installs are not run through a shell, and the tool name is from a fixed list.
  const child = spawn(brewPath, ['install', tool], { env: { ...process.env, HOMEBREW_NO_ENV_HINTS: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', NONINTERACTIVE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', add);
  child.stderr.on('data', add);
  child.on('error', (e) => {
    job.log += `\n${e.message}`;
    job.status = 'failed';
  });
  child.on('close', (code) => {
    job.code = code;
    job.status = code === 0 ? 'done' : 'failed';
    clearProbeMemo();
  });
  return job;
}

function openClaudeLogin(claudePath: string): { ok: true; session: string; window: string } | { ok: false; detail: string } {
  const r = createTerminalSession('claude-login', os.homedir());
  if (!r.ok) return r;
  try {
    // The path is quoted for the shell tmux's new pane runs it in.
    runTmux(['send-keys', '-t', `=${r.session}:`, '-l', `'${claudePath.replace(/'/g, `'\\''`)}' auth login`]);
    runTmux(['send-keys', '-t', `=${r.session}:`, 'Enter']);
  } catch (e) {
    return { ok: false, detail: 'Could not start the login: ' + (e as Error).message };
  }
  return r;
}

const defaultDeps: WizardDeps = {
  openDb: () => openDb(),
  probe: (db, fresh) => {
    if (fresh) clearProbeMemo();
    return probeEnvironment({ claudeBin: getSetting(db, 'claude_bin') || undefined, extraPath: getSetting(db, 'extra_path') as string[] });
  },
  brew: findBrew,
  install: startBrewInstall,
  getJob: (id) => jobs.get(id) ?? null,
  openLogin: openClaudeLogin,
  discover: (known) => discoverProjectDirs(path.join(os.homedir(), '.claude'), os.homedir(), known),
  git: defaultSyncGit,
  templates: defaultTemplates,
  now: Date.now,
};

/* ------------------------------------------------------------ state storage */

const readState = (db: Database.Database): WizardState => parseState(getSetting(db, 'setup_state'));
const writeState = (db: Database.Database, s: WizardState): void => void setSetting(db, 'setup_state', s);

function marker(db: Database.Database): Marker {
  const origin = getSetting(db, 'setup_origin') as SetupOrigin;
  return { completedAt: Number(getSetting(db, 'setup_completed_at')) || 0, origin };
}

function ctxOf(db: Database.Database): WizardCtx {
  return { slackMode: slackMode(db) };
}

/* ------------------------------------------------------------ the view */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * What the very first paint of the board page must show. The page HTML is
 * rendered with the welcome screen already open (and the board hidden) when
 * this says so, so no frame of the board appears before it on a first launch.
 */
export function firstPaint(db: Database.Database): { welcome: boolean } {
  const show = shouldShow(marker(db)) && !setupDone(db);
  return { welcome: showWelcome({ setupShow: show, seenAt: Number(getSetting(db, 'welcome_seen_at')) || 0 }) };
}

export function buildView(db: Database.Database) {
  const state = readState(db);
  const ctx = ctxOf(db);
  const m = marker(db);
  const cur = stepMeta(state.current);
  const show = shouldShow(m) && !setupDone(db);
  return {
    ok: true,
    show,
    // The welcome screen goes in front of the wizard until Enter is pressed once.
    welcome: showWelcome({ setupShow: show, seenAt: Number(getSetting(db, 'welcome_seen_at')) || 0 }),
    origin: m.origin,
    completedAt: m.completedAt,
    tourCompletedAt: Number(getSetting(db, 'tour_completed_at')) || 0,
    tourSkippedAt: Number(getSetting(db, 'tour_skipped_at')) || 0,
    current: state.current,
    state,
    rail: rail(state, ctx),
    progress: progress(state, ctx),
    step: { id: cur.id, title: cur.title, optional: cur.optional, blocking: cur.blocking, skippable: cur.skippable, why: cur.why, unlocks: cur.unlocks },
    steps: STEPS.map((s) => ({ id: s.id, title: s.title, optional: s.optional })),
    slackMode: ctx.slackMode,
    values: {
      claude_bin: getSetting(db, 'claude_bin'),
      extra_path: getSetting(db, 'extra_path'),
      terminal: getSetting(db, 'terminal'),
      perm_chats: getSetting(db, 'perm_chats'),
      perm_watchers: getSetting(db, 'perm_watchers'),
      perm_orchestrator: getSetting(db, 'perm_orchestrator'),
      slack_mode: getSetting(db, 'slack_mode'),
      hotkey: getSetting(db, 'slack_goto_hotkey'),
      hotkey_display: hotkeyDisplay(db),
      orchestrator_enabled: getSetting(db, 'orchestrator_enabled') === '1',
      orchestrator_notify: getSetting(db, 'orchestrator_notify'),
      orchestrator_trust: !!getSetting(db, 'orchestrator_trust'),
      orchestrator_dir: path.join(TOOL_DIR, 'orchestrator'),
    },
  };
}

function hotkeyDisplay(db: Database.Database): string {
  const h = String(getSetting(db, 'slack_goto_hotkey'));
  return h && h !== 'off' ? formatAccelerator(h) : 'Off';
}

/* ------------------------------------------------------------ routes */

type Fail = { status: number; detail: string; field?: string };

export function makeWizardRoutes(over: Partial<WizardDeps> = {}): RouteDef[] {
  const deps: WizardDeps = { ...defaultDeps, ...over };

  const withDb = async <T>(f: (db: Database.Database) => Promise<T> | T): Promise<T> => {
    const db = deps.openDb();
    try {
      return await f(db);
    } finally {
      db.close();
    }
  };

  /** Run the probe and say whether the blocking checks pass. */
  const requirements = async (db: Database.Database, fresh: boolean) => {
    const report = await deps.probe(db, fresh);
    const brew = deps.brew();
    return { report, brew, rows: requirementRows(report, brew), met: requirementsOf(report) };
  };

  /** Persist one step's own values. Returns a failure, or the extra facts its guard needs. */
  async function persist(db: Database.Database, id: StepId, v: Record<string, unknown>): Promise<Fail | { check: StepCheck }> {
    const patch = (p: Record<string, unknown>): Fail | null => {
      const r = applySettingsPatch(db, p);
      return r.ok ? null : { status: 400, detail: r.detail };
    };
    switch (id) {
      case 'requirements': {
        const p: Record<string, unknown> = {};
        if ('claude_bin' in v) p.claude_bin = str(v.claude_bin).trim();
        if ('extra_path' in v) p.extra_path = arr(v.extra_path).map(str).filter(Boolean);
        if (Object.keys(p).length) {
          const f = patch(p);
          if (f) return f;
        }
        const { met } = await requirements(db, true);
        return { check: { requirements: met } };
      }
      case 'projects': {
        const wanted = arr(v.projects).map(obj);
        const removed = arr(v.remove).map(str).filter(Boolean);
        for (const p of wanted) {
          const c = checkProjectPath(str(p.path));
          if (!c.ok) return { status: 400, detail: `${str(p.path) || 'A folder'}: ${c.detail}`, field: 'projects' };
        }
        const have = listProjects(db, { includeHidden: true });
        for (const p of wanted) {
          const r = addProject(db, str(p.path));
          if (!r.ok) return { status: 400, detail: r.detail, field: 'projects' };
          const name = str(p.name).trim();
          if (name && name !== r.project.name) updateProject(db, r.project.id, { name });
        }
        for (const dir of removed) {
          const row = have.find((h) => h.path === dir);
          if (row) removeProject(db, row.id);
        }
        return { check: {} };
      }
      case 'terminal': {
        // Absent means "keep what is set" (Inside Loom on a new install).
        if (!('terminal' in v)) return { check: {} };
        const f = patch({ terminal: str(v.terminal) });
        return f ?? { check: {} };
      }
      case 'permissions': {
        const chats = str(v.perm_chats) || 'normal';
        const watchers = str(v.perm_watchers) || undefined;
        const orch = str(v.perm_orchestrator) || undefined;
        const check: StepCheck = {
          permChats: chats === 'skip' ? 'skip' : 'normal',
          permWatchers: watchers === 'skip' ? 'skip' : watchers ? 'normal' : undefined,
          permOrchestrator: orch === 'skip' ? 'skip' : orch ? 'normal' : undefined,
          confirmSkip: v.confirm_skip === true,
        };
        // The guard runs before any write: skip never lands without the box.
        if (chats !== 'normal' && chats !== 'skip') return { status: 400, detail: 'perm_chats must be normal or skip' };
        if ((check.permChats === 'skip' || check.permWatchers === 'skip' || check.permOrchestrator === 'skip') && !check.confirmSkip) {
          return { status: 400, detail: 'Tick the box to confirm you want chats to run without asking.', field: 'confirm_skip' };
        }
        const p: Record<string, unknown> = { perm_chats: chats };
        if (watchers) p.perm_watchers = watchers;
        if (orch) p.perm_orchestrator = orch;
        const f = patch(p);
        return f ?? { check };
      }
      case 'plugin':
      case 'macos': // nothing to store: the grant lives in macOS, read live
        return { check: {} };
      case 'slack': {
        const choice = str(v.mode);
        if (choice === 'skip') {
          const r = setSetting(db, 'slack_mode', 'off');
          return r.ok ? { check: {} } : { status: 400, detail: r.detail };
        }
        if (choice === 'mcp') {
          if (getSetting(db, 'slack_mode') !== 'mcp') {
            const { report } = await requirements(db, false);
            if (!report.slackMcp.found) return { status: 409, detail: 'No Slack server in claude mcp list. Add the Slack connector in Claude Code, or choose another option.', field: 'mode' };
          }
          setSetting(db, 'slack_mode', 'mcp');
          return { check: {} };
        }
        if (choice === 'direct') {
          // A direct connection exists only after a passing token Test (POST /api/slack/token).
          if (!slackToken()) setSetting(db, 'slack_mode', 'off');
          else setSetting(db, 'slack_mode', 'direct');
          return { check: {} };
        }
        return { status: 400, detail: 'Choose Direct app, MCP only or Skip.', field: 'mode' };
      }
      case 'shortcut': {
        practice.cancel();
        const hk = str(v.hotkey);
        if (hk) {
          if (hk !== 'off') {
            const c = classifyAccelerator(hk);
            if (c.level === 'refuse') return { status: 400, detail: c.detail, field: 'hotkey' };
          }
          const f = patch({ slack_goto_hotkey: hk });
          if (f) return f;
        }
        return { check: {} };
      }
      case 'ship': {
        for (const raw of arr(v.ship).map(obj)) {
          const dir = str(raw.path);
          const cmd = checkShipCommand(raw.ship_command);
          if (!cmd.ok) return { status: 400, detail: cmd.detail, field: 'ship' };
          if (raw.enabled === false) {
            updateShipProject(db, dir, { enabled: false });
            continue;
          }
          const r = addShipProject(db, dir, { command: raw.ship_command, labelRequired: raw.label_required === true, baseBranch: str(raw.base_branch), enabled: true }, deps.git, deps.now());
          if (!r.ok) return { status: 400, detail: r.detail, field: 'ship' };
        }
        try {
          writePluginStateFile(db);
        } catch (e) {
          console.error('[loom] plugin-state.json not updated:', (e as Error).message);
        }
        return { check: {} };
      }
      case 'orchestrator': {
        const enabled = v.enabled === true;
        const p: Record<string, unknown> = { orchestrator_enabled: enabled ? '1' : '0', orchestrator_trust: enabled && v.trust === true };
        if (str(v.notify)) p.orchestrator_notify = str(v.notify);
        const f = patch(p);
        return f ?? { check: {} };
      }
      case 'watchers': {
        const ids = arr(v.templates).map(str).filter(Boolean);
        if (ids.length) {
          const known = new Map(deps.templates.list().map((t) => [t.id, t]));
          const { report } = await requirements(db, false);
          const mode = slackMode(db);
          for (const id of ids) {
            const t = known.get(id);
            if (!t) return { status: 400, detail: `Unknown template ${id}.`, field: 'templates' };
            if (t.needs === 'direct' && mode !== 'direct') return { status: 409, detail: `${t.label} needs the Direct Slack app.`, field: 'templates' };
            if (t.needs === 'gh' && !(report.gh.found && report.gh.auth?.loggedIn)) return { status: 409, detail: `${t.label} needs gh, logged in.`, field: 'templates' };
            if (t.needs === 'orchestrator' && getSetting(db, 'orchestrator_enabled') !== '1') return { status: 409, detail: `${t.label} needs the orchestrator turned on.`, field: 'templates' };
          }
          const made = await deps.templates.create(db, ids);
          if (!made.ok) return { status: 502, detail: made.detail, field: 'templates' };
          // Templates start Disabled or in Shadow, so the master switch only lets Shadow results appear.
          setSetting(db, 'watchers_enabled', true);
        }
        return { check: {} };
      }
      default:
        return { check: {} };
    }
  }

  async function postContinue(c: RouteCtx): Promise<void> {
    const b = await c.body();
    if (!b || !isStepId(b.step)) return c.json(400, { ok: false, detail: 'step is required' });
    const id = b.step;
    await withDb(async (db) => {
      const state = readState(db);
      if (id !== state.current) return c.json(409, { ok: false, detail: 'That is not the current step.', view: buildView(db) });
      // Validate the step's guard against what is about to be written, then write, then move on.
      const r = await persist(db, id, obj(b.values));
      if ('detail' in r) return c.json(r.status, { ok: false, detail: r.detail, field: r.field, view: buildView(db) });
      const t = continueStep(state, id, ctxOf(db), r.check, deps.now());
      if (!t.ok) return c.json(409, { ok: false, detail: t.error, view: buildView(db) });
      writeState(db, t.state);
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function postSkip(c: RouteCtx): Promise<void> {
    const b = await c.body();
    if (!b || !isStepId(b.step)) return c.json(400, { ok: false, detail: 'step is required' });
    await withDb((db) => {
      if (b.step === 'shortcut') practice.cancel();
      const t = skipStep(readState(db), b.step as StepId, ctxOf(db), deps.now());
      if (!t.ok) return c.json(409, { ok: false, detail: t.error, view: buildView(db) });
      writeState(db, t.state);
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function postBack(c: RouteCtx): Promise<void> {
    await withDb((db) => {
      practice.cancel();
      const t = stepBack(readState(db), ctxOf(db));
      if (!t.ok) return c.json(409, { ok: false, detail: t.error, view: buildView(db) });
      writeState(db, t.state);
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function postGoto(c: RouteCtx): Promise<void> {
    const b = await c.body();
    if (!b || !isStepId(b.step)) return c.json(400, { ok: false, detail: 'step is required' });
    await withDb((db) => {
      practice.cancel();
      const t = goTo(readState(db), b.step as StepId, ctxOf(db));
      if (!t.ok) return c.json(409, { ok: false, detail: t.error, view: buildView(db) });
      writeState(db, t.state);
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function postClose(c: RouteCtx): Promise<void> {
    await withDb((db) => {
      practice.cancel();
      // Closing keeps the current step and writes no done marker.
      writeState(db, close(readState(db)));
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function postRerun(c: RouteCtx): Promise<void> {
    await withDb((db) => {
      writeState(db, rerun());
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function postFinish(c: RouteCtx): Promise<void> {
    const b = await c.body();
    await withDb((db) => {
      const m = marker(db);
      const f = finish(readState(db), m.origin, deps.now());
      if (!f.ok) return c.json(409, { ok: false, detail: f.error, view: buildView(db) });
      // The done step and the marker land together.
      db.transaction(() => {
        writeState(db, f.state);
        setSetting(db, 'setup_completed_at', f.marker.completedAt);
        setSetting(db, 'setup_origin', f.marker.origin);
      })();
      c.json(200, { ok: true, tour: b?.tour === true, view: buildView(db) });
    });
  }

  async function postTour(c: RouteCtx): Promise<void> {
    const b = await c.body();
    const result = b?.result;
    if (result !== 'completed' && result !== 'skipped') return c.json(400, { ok: false, detail: 'result must be completed or skipped' });
    await withDb((db) => {
      setSetting(db, result === 'completed' ? 'tour_completed_at' : 'tour_skipped_at', deps.now());
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function postWelcome(c: RouteCtx): Promise<void> {
    await withDb((db) => {
      setSetting(db, 'welcome_seen_at', deps.now());
      c.json(200, { ok: true, view: buildView(db) });
    });
  }

  async function getWizard(c: RouteCtx): Promise<void> {
    await withDb((db) => c.json(200, buildView(db)));
  }

  async function getRequirements(c: RouteCtx): Promise<void> {
    const fresh = c.url.searchParams.get('fresh') === '1';
    await withDb(async (db) => {
      const r = await requirements(db, fresh);
      c.json(200, {
        ok: true,
        rows: r.rows,
        ready: r.met.tmux && r.met.claude && r.met.claudeLoggedIn && r.met.python3,
        brew: r.brew,
        tmuxWarning: r.report.tmux.warning ?? null,
        claudePath: r.report.claude.path ?? '',
        shell: r.report.shell,
      });
    });
  }

  async function postInstall(c: RouteCtx): Promise<void> {
    const b = await c.body();
    const tool = b?.tool;
    if (tool !== 'tmux' && tool !== 'gh') return c.json(400, { ok: false, detail: 'tool must be tmux or gh' });
    const brew = deps.brew();
    // Loom never installs Homebrew itself.
    if (!brew.found || !brew.path) return c.json(409, { ok: false, detail: 'Homebrew is not installed. Get it from brew.sh, or install this another way.' });
    const running = [...jobs.values()].find((j) => j.status === 'running' && j.tool === tool);
    if (running) return c.json(200, { ok: true, job: running });
    c.json(200, { ok: true, job: deps.install(tool, brew.path) });
  }

  function getInstall(c: RouteCtx): void {
    const job = deps.getJob(c.url.searchParams.get('id') ?? '');
    if (!job) return c.json(404, { ok: false, detail: 'no such install' });
    c.json(200, { ok: true, job });
  }

  async function postLogin(c: RouteCtx): Promise<void> {
    await withDb(async (db) => {
      const { report } = await requirements(db, false);
      if (!report.claude.found || !report.claude.path) return c.json(409, { ok: false, detail: 'Claude Code is not installed.' });
      if (!report.tmux.found) return c.json(409, { ok: false, detail: 'Install tmux first: the login opens in a Loom terminal tab.' });
      const r = deps.openLogin(report.claude.path);
      c.json(r.ok ? 200 : 500, r.ok ? { ok: true, session: r.session, window: r.window } : { ok: false, detail: r.detail });
    });
  }

  async function getProjects(c: RouteCtx): Promise<void> {
    await withDb((db) => {
      const projects = listProjects(db);
      c.json(200, {
        ok: true,
        projects: projects.map((p) => ({ id: p.id, path: p.path, name: p.name })),
        suggestions: deps.discover(new Set(listProjects(db, { includeHidden: true }).map((p) => p.path))),
      });
    });
  }

  async function getShip(c: RouteCtx): Promise<void> {
    await withDb((db) => c.json(200, { ok: true, options: shipOptions(db, deps.git), defaultCommand: DEFAULT_SHIP_COMMAND }));
  }

  async function getTemplates(c: RouteCtx): Promise<void> {
    await withDb(async (db) => {
      const { report } = await requirements(db, false);
      const mode = slackMode(db);
      const ghOk = report.gh.found && !!report.gh.auth?.loggedIn;
      const orchOn = getSetting(db, 'orchestrator_enabled') === '1';
      c.json(200, {
        ok: true,
        templates: deps.templates.list().map((t) => ({
          ...t,
          available: t.needs === 'direct' ? mode === 'direct' : t.needs === 'gh' ? ghOk : t.needs === 'orchestrator' ? orchOn : true,
          blocked: t.needs === 'direct' && mode !== 'direct' ? 'needs the Direct Slack app' : t.needs === 'gh' && !ghOk ? 'needs gh, logged in' : t.needs === 'orchestrator' && !orchOn ? 'needs the orchestrator' : '',
        })),
      });
    });
  }

  async function getSummary(c: RouteCtx): Promise<void> {
    const ax = c.url.searchParams.get('ax');
    await withDb((db) => {
      const mode = slackMode(db);
      const identity = obj(getSetting(db, 'slack_identity'));
      const plugin = obj(getSetting(db, 'plugin_state'));
      const input: SummaryInput = {
        projects: listProjects(db).map((p) => p.name),
        terminal: String(getSetting(db, 'terminal')),
        permChats: getSetting(db, 'perm_chats') === 'skip' ? 'skip' : 'normal',
        pluginInstalled: !!plugin.installed_version,
        slackMode: mode,
        slackConnected: mode === 'direct' && !!slackToken(),
        slackTeam: str(identity.team) || undefined,
        shortcut: hotkeyDisplay(db),
        shortcutReady: mode === 'off' ? null : ax === '1',
        shipRepos: listShipProjects(db).map((s) => s.repo_slug || path.basename(s.project_dir)),
        orchestrator: getSetting(db, 'orchestrator_enabled') === '1',
        watchers: deps.templates.count(db),
      };
      c.json(200, { ok: true, rows: buildSummary(input), tokenSource: slackTokenSource() });
    });
  }

  return [
    { method: 'GET', path: '/api/wizard', kind: 'read', handler: getWizard },
    { method: 'GET', path: '/api/wizard/requirements', kind: 'read', handler: getRequirements },
    { method: 'GET', path: '/api/wizard/projects', kind: 'read', handler: getProjects },
    { method: 'GET', path: '/api/wizard/ship', kind: 'read', handler: getShip },
    { method: 'GET', path: '/api/wizard/templates', kind: 'read', handler: getTemplates },
    { method: 'GET', path: '/api/wizard/summary', kind: 'read', handler: getSummary },
    { method: 'GET', path: '/api/wizard/install', kind: 'read', handler: getInstall },
    { method: 'POST', path: '/api/wizard/install', kind: 'browser', handler: postInstall },
    { method: 'POST', path: '/api/wizard/login', kind: 'browser', handler: postLogin },
    { method: 'POST', path: '/api/wizard/continue', kind: 'browser', handler: postContinue },
    { method: 'POST', path: '/api/wizard/skip', kind: 'browser', handler: postSkip },
    { method: 'POST', path: '/api/wizard/back', kind: 'browser', handler: postBack },
    { method: 'POST', path: '/api/wizard/goto', kind: 'browser', handler: postGoto },
    { method: 'POST', path: '/api/wizard/close', kind: 'browser', handler: postClose },
    { method: 'POST', path: '/api/wizard/rerun', kind: 'browser', handler: postRerun },
    { method: 'POST', path: '/api/wizard/welcome', kind: 'browser', handler: postWelcome },
    { method: 'POST', path: '/api/wizard/finish', kind: 'browser', handler: postFinish },
    { method: 'POST', path: '/api/wizard/tour', kind: 'browser', handler: postTour },
  ];
}

export const routes: RouteDef[] = makeWizardRoutes();
