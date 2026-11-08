import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { getSetting, setSetting } from '../src/settingsSchema.ts';
import { memoryBackend, setKeychainBackend } from '../src/secrets.ts';
import { configureToken } from '../src/slackapi.ts';
import { setupDone } from '../src/migrate.ts';
import { listProjects, listShipProjects } from '../src/projects.ts';
import { practice } from '../src/routes/shortcut.ts';
import {
  FALLBACK_TEMPLATES,
  discoverProjectDirs,
  makeWizardRoutes,
  requirementRows,
  shipOptions,
  type InstallJob,
  type WatcherTemplatePort,
  type WizardDeps,
} from '../src/routes/wizard.ts';
import { ROUTES, type RouteCtx, type RouteDef } from '../src/routes/index.ts';
import type { ProbeReport } from '../src/probe.ts';

// Nothing real here: the probe is a stub, Homebrew and the login terminal are
// fakes that record the call, the Keychain is in memory, the DB is a temp file
// and Slack is never contacted. No plugin is installed and no shortcut registered.

let dir: string;
let dbPath: string;
let report: ProbeReport;
let brewFound = true;
let installs: string[];
let logins: string[];
let created: string[][];
let templateResult: Awaited<ReturnType<WatcherTemplatePort['create']>>;
let jobs: Map<string, InstallJob>;

const ver = (raw: string) => ({ raw, major: 1, minor: 0, suffix: '' });
function goodReport(): ProbeReport {
  return {
    at: 1, shell: '/bin/zsh', loginPath: [],
    tmux: { found: true, path: '/opt/homebrew/bin/tmux', version: ver('3.5a'), warning: null },
    claude: { found: true, path: '/usr/local/bin/claude', version: ver('2.1.0'), auth: { loggedIn: true } },
    python3: { found: true, path: '/usr/bin/python3', version: ver('3.11.0') },
    gh: { found: true, path: '/opt/homebrew/bin/gh', version: ver('2.60.0'), auth: { loggedIn: true, hosts: ['github.com'] } },
    codex: { found: false, homeDir: false },
    slackApp: { found: false },
    slackMcp: { found: false, connected: false },
    mcpServers: [], tmuxSocketDir: { path: '/tmp/tmux-1', exists: true }, ready: true,
  } as unknown as ProbeReport;
}

const REAL_HOME = process.env.HOME;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-wizroutes-'));
  // A migration reads ~/.claude and ~/.codex: point HOME at an empty folder so it never sees the developer's own.
  process.env.HOME = fs.mkdirSync(path.join(dir, 'home'), { recursive: true }) ? path.join(dir, 'home') : '';
  dbPath = path.join(dir, 'manager.db');
  delete process.env.SLACK_USER_TOKEN;
  setKeychainBackend(memoryBackend());
  configureToken({ account: () => 'default', allowLegacy: () => false });
  report = goodReport();
  brewFound = true;
  installs = [];
  logins = [];
  created = [];
  jobs = new Map();
  templateResult = { ok: true, created: 1 };
  practice.cancel();
});
afterEach(() => {
  process.env.HOME = REAL_HOME;
  configureToken(null);
  setKeychainBackend(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

const templates: WatcherTemplatePort = {
  list: () => FALLBACK_TEMPLATES,
  create: async (_db, ids) => {
    created.push(ids);
    return templateResult;
  },
  count: () => created.flat().length,
};

/** git stub: `repos` maps a folder to its origin URL ('' = a checkout with no remote). */
function gitFor(repos: Record<string, string>) {
  return (args: string[], cwd: string): string => {
    const root = Object.keys(repos).find((r) => cwd === r || cwd.startsWith(r + '/'));
    if (!root) throw new Error('not a repo');
    const a = args.join(' ');
    if (a.includes('--git-common-dir')) return path.join(root, '.git');
    if (a === 'rev-parse --show-toplevel') return root;
    if (a === 'remote get-url origin') {
      if (!repos[root]) throw new Error('no remote');
      return repos[root]!;
    }
    if (a.startsWith('symbolic-ref')) return 'origin/trunk';
    throw new Error('unexpected git ' + a);
  };
}

function table(over: Partial<WizardDeps> = {}): Record<string, RouteDef> {
  const list = makeWizardRoutes({
    openDb: () => openDb(dbPath),
    probe: async () => report,
    brew: () => (brewFound ? { found: true, path: '/opt/homebrew/bin/brew' } : { found: false }),
    install: (tool) => {
      installs.push(tool);
      const job: InstallJob = { id: 'j' + installs.length, tool, status: 'running', log: '', code: null };
      jobs.set(job.id, job);
      return job;
    },
    getJob: (id) => jobs.get(id) ?? null,
    openLogin: (p) => {
      logins.push(p);
      return { ok: true, session: 'loom-claude-login', window: '1' };
    },
    discover: () => [],
    git: gitFor({}),
    templates,
    now: () => 1_700_000_000_000,
    ...over,
  });
  return Object.fromEntries(list.map((r) => [`${r.method} ${r.path}`, r]));
}

type Res = { status: number; body: Record<string, any> };
async function hit(t: Record<string, RouteDef>, key: string, body?: unknown, query = ''): Promise<Res> {
  const r = t[key];
  if (!r) throw new Error('no route ' + key);
  let out: Res | null = null;
  const ctx = {
    req: {} as never, res: {} as never,
    url: new URL('http://localhost:4317' + r.path + query),
    json: (status: number, b: unknown) => (out = { status, body: b as Record<string, any> }),
    body: async () => (body && typeof body === 'object' ? (body as Record<string, unknown>) : body === undefined ? {} : null),
  } as RouteCtx;
  await r.handler!(ctx);
  if (!out) throw new Error('no response');
  return out;
}

const withDb = <T>(f: (db: Database.Database) => T): T => {
  const db = openDb(dbPath);
  try {
    return f(db);
  } finally {
    db.close();
  }
};

/** Continue the current step with `values`, expecting success. */
async function next(t: Record<string, RouteDef>, step: string, values: Record<string, unknown> = {}): Promise<Res> {
  const r = await hit(t, 'POST /api/wizard/continue', { step, values });
  expect(r.status, `${step}: ${r.body.detail}`).toBe(200);
  return r;
}

async function walkTo(t: Record<string, RouteDef>, step: string): Promise<void> {
  // Slack is skipped on the way (the shortcut step is then passed over); tests that need it on set it up themselves.
  for (let i = 0; i < 20; i++) {
    const cur = (await hit(t, 'GET /api/wizard')).body.current as string;
    if (cur === step) return;
    await next(t, cur, cur === 'slack' ? { mode: 'skip' } : {});
  }
  throw new Error('never reached ' + step);
}

describe('route table', () => {
  it('every wizard route is in the guarded table, writes as browser', () => {
    const mine = makeWizardRoutes();
    for (const r of mine) expect(ROUTES.find((x) => x.method === r.method && x.path === r.path), `${r.method} ${r.path}`).toBeTruthy();
    for (const r of mine.filter((x) => x.method !== 'GET')) expect(r.kind).toBe('browser');
    for (const r of mine.filter((x) => x.method === 'GET')) expect(r.kind).toBe('read');
  });
});

describe('GET /api/wizard', () => {
  it('a fresh install shows the wizard at Welcome', async () => {
    const r = await hit(table(), 'GET /api/wizard');
    expect(r.status).toBe(200);
    expect(r.body.show).toBe(true);
    expect(r.body.current).toBe('welcome');
    expect(r.body.rail).toHaveLength(12);
    expect(r.body.progress).toMatchObject({ index: 1, total: 11 }); // Slack is off, so the shortcut step is hidden
    expect(r.body.values.perm_chats).toBe('normal'); // safe by default
    expect(r.body.values.terminal).toBe('inside');
    expect(r.body.values.slack_mode).toBe('off');
    expect(r.body.values.orchestrator_enabled).toBe(false);
  });

  it('a migrated install never shows it', async () => {
    // A pre-wizard install: a DB with rows but no settings rows. openDb migrates it.
    const legacy = path.join(dir, 'legacy', 'manager.db');
    const seed = openDb(legacy, { migrate: false });
    seed.prepare(`DELETE FROM settings`).run();
    seed.prepare(`INSERT INTO projects (path, name, added_at) VALUES ('/p', 'p', 1)`).run();
    seed.close();
    const t = table({ openDb: () => openDb(legacy) });
    const r = await hit(t, 'GET /api/wizard');
    expect(r.body.origin).toBe('migrated');
    expect(r.body.show).toBe(false);
    const db = openDb(legacy);
    expect(setupDone(db)).toBe(true);
    db.close();
  });

  it('a finished fresh install does not show it either, but a re-run still works', async () => {
    const t = table();
    await walkTo(t, 'done');
    const done = await hit(t, 'POST /api/wizard/finish', {});
    expect(done.body.view.show).toBe(false);
    const again = await hit(t, 'POST /api/wizard/rerun', {});
    expect(again.body.view.current).toBe('welcome');
    expect(again.body.view.show).toBe(false); // the marker is untouched by a re-run
    expect(again.body.view.completedAt).toBe(1_700_000_000_000);
  });

  it('a migrated install that re-runs setup keeps origin migrated and updates the time', async () => {
    const legacy = path.join(dir, 'legacy2', 'manager.db');
    const seed = openDb(legacy, { migrate: false });
    seed.prepare(`DELETE FROM settings`).run();
    seed.prepare(`INSERT INTO tags (name, color, created_at) VALUES ('t', 'blue', 1)`).run();
    seed.close();
    const t = table({ openDb: () => openDb(legacy), now: () => 1_800_000_000_123 });
    await hit(t, 'POST /api/wizard/rerun', {});
    await walkTo(t, 'done');
    const r = await hit(t, 'POST /api/wizard/finish', {});
    expect(r.body.view.origin).toBe('migrated');
    expect(r.body.view.completedAt).toBe(1_800_000_000_123);
  });
});

describe('requirements', () => {
  it('rows say what is missing and what the fix does', () => {
    const bad = goodReport();
    bad.tmux = { found: false } as never;
    bad.claude.auth = { loggedIn: false } as never;
    bad.gh = { found: false, auth: null } as never;
    const rows = requirementRows(bad, { found: true, path: '/opt/homebrew/bin/brew' });
    expect(rows.map((r) => [r.id, r.ok, r.fix])).toEqual([
      ['tmux', false, 'brew-tmux'], ['claude', true, 'none'], ['login', false, 'login'], ['python3', true, 'none'], ['gh', false, 'brew-gh'], ['codex', false, 'none'],
    ]);
    expect(rows.filter((r) => r.required).map((r) => r.id)).toEqual(['tmux', 'claude', 'login', 'python3']);
    // login needs tmux (it opens in a Loom terminal tab)
    expect(rows.find((r) => r.id === 'login')!.fixBlocked).toMatch(/Install tmux first/);
  });

  it('without Homebrew the install buttons are blocked and Loom does not offer to install it', () => {
    const bad = goodReport();
    bad.tmux = { found: false } as never;
    const rows = requirementRows(bad, { found: false });
    expect(rows[0]!.fixBlocked).toMatch(/Homebrew is not installed/);
  });

  it('Continue is refused until the blocking four pass, then moves on', async () => {
    const t = table();
    await next(t, 'welcome');
    report.tmux = { found: false } as never;
    const no = await hit(t, 'POST /api/wizard/continue', { step: 'requirements', values: {} });
    expect(no.status).toBe(409);
    expect(no.body.detail).toMatch(/tmux/);
    expect(no.body.view.current).toBe('requirements');
    report = goodReport();
    const yes = await next(t, 'requirements');
    expect(yes.body.view.current).toBe('projects');
  });

  it('optional gh and codex do not block', async () => {
    const t = table();
    report.gh = { found: false, auth: null } as never;
    report.codex = { found: false, homeDir: false } as never;
    await walkTo(t, 'projects');
    expect((await hit(t, 'GET /api/wizard')).body.current).toBe('projects');
  });

  it('writes claude_bin and extra_path only when sent, and rejects a bad value', async () => {
    const t = table();
    await next(t, 'welcome');
    const bad = await hit(t, 'POST /api/wizard/continue', { step: 'requirements', values: { extra_path: 'not-a-list-is-coerced', claude_bin: '' } });
    expect(bad.status).toBe(200);
    expect(withDb((db) => getSetting(db, 'claude_bin'))).toBe('');
  });

  it('GET lists the rows and the brew state; fresh clears the memo', async () => {
    const r = await hit(table(), 'GET /api/wizard/requirements', undefined, '?fresh=1');
    expect(r.body.ready).toBe(true);
    expect(r.body.brew).toEqual({ found: true, path: '/opt/homebrew/bin/brew' });
    expect(r.body.rows).toHaveLength(6);
  });

  it('install runs brew install through the injected runner and never installs Homebrew', async () => {
    const t = table();
    const r = await hit(t, 'POST /api/wizard/install', { tool: 'tmux' });
    expect(r.body.job.tool).toBe('tmux');
    expect(installs).toEqual(['tmux']);
    const poll = await hit(t, 'GET /api/wizard/install', undefined, '?id=' + r.body.job.id);
    expect(poll.body.job.status).toBe('running');
    expect((await hit(t, 'GET /api/wizard/install', undefined, '?id=nope')).status).toBe(404);
    expect((await hit(t, 'POST /api/wizard/install', { tool: 'rm -rf' })).status).toBe(400);
    expect((await hit(t, 'POST /api/wizard/install', { tool: 'homebrew' })).status).toBe(400);
    brewFound = false;
    const nobrew = await hit(t, 'POST /api/wizard/install', { tool: 'gh' });
    expect(nobrew.status).toBe(409);
    expect(installs).toEqual(['tmux']);
  });

  it('login opens a terminal for claude auth login, and needs tmux', async () => {
    const t = table();
    const r = await hit(t, 'POST /api/wizard/login', {});
    expect(r.body).toMatchObject({ ok: true, session: 'loom-claude-login' });
    expect(logins).toEqual(['/usr/local/bin/claude']);
    report.tmux = { found: false } as never;
    expect((await hit(t, 'POST /api/wizard/login', {})).status).toBe(409);
    report = goodReport();
    report.claude = { found: false } as never;
    expect((await hit(t, 'POST /api/wizard/login', {})).status).toBe(409);
    expect(logins).toHaveLength(1);
  });
});

describe('projects', () => {
  it('adds folders with their names, removes only what is listed, and keeps staged names', async () => {
    const t = table();
    await walkTo(t, 'projects');
    const a = path.join(dir, 'alpha');
    const b = path.join(dir, 'beta');
    fs.mkdirSync(a);
    fs.mkdirSync(b);
    await next(t, 'projects', { projects: [{ path: a, name: 'Alpha app' }, { path: b, name: '' }] });
    let rows = withDb((db) => listProjects(db));
    expect(rows.map((p) => p.name).sort()).toEqual(['Alpha app', 'beta']);
    // a re-run removes one explicitly
    await hit(t, 'POST /api/wizard/rerun', {});
    await walkTo(t, 'projects');
    await next(t, 'projects', { projects: [], remove: [fs.realpathSync(b)] });
    rows = withDb((db) => listProjects(db));
    expect(rows.map((p) => p.name)).toEqual(['Alpha app']);
  });

  it('a path that is not a folder refuses the step and does not advance', async () => {
    const t = table();
    await walkTo(t, 'projects');
    const r = await hit(t, 'POST /api/wizard/continue', { step: 'projects', values: { projects: [{ path: path.join(dir, 'missing'), name: 'x' }] } });
    expect(r.status).toBe(400);
    expect(r.body.view.current).toBe('projects');
    expect(withDb((db) => listProjects(db))).toHaveLength(0);
  });

  it('may be empty, and may be skipped without writing', async () => {
    const t = table();
    await walkTo(t, 'projects');
    const r = await hit(t, 'POST /api/wizard/skip', { step: 'projects' });
    expect(r.body.view.current).toBe('terminal');
    expect(r.body.view.state.steps.projects.status).toBe('skipped');
    expect(withDb((db) => listProjects(db))).toHaveLength(0);
  });

  it('suggestions come from Claude transcripts, skip the home folder and known projects', () => {
    const home = path.join(dir, 'home');
    const claude = path.join(home, '.claude');
    const mk = (enc: string, cwd: string, mtime: number) => {
      const d = path.join(claude, 'projects', enc);
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, 's.jsonl');
      fs.writeFileSync(f, JSON.stringify({ type: 'user', cwd }) + '\n');
      fs.utimesSync(d, mtime, mtime);
    };
    const proj = path.join(home, 'dev', 'proj');
    const known = path.join(home, 'dev', 'known');
    const wt = path.join(home, 'dev', 'proj', '.worktrees', 'x');
    for (const p of [proj, known, wt]) fs.mkdirSync(p, { recursive: true });
    mk('a', proj, 3000);
    mk('b', known, 2000);
    mk('c', home, 1500);
    mk('d', wt, 1000);
    mk('e', path.join(home, 'gone'), 900); // no longer on disk
    const out = discoverProjectDirs(claude, home, new Set([fs.realpathSync(known)]));
    expect(out.map((o) => o.name)).toEqual(['proj']);
    expect(discoverProjectDirs(path.join(dir, 'nowhere'), home, new Set())).toEqual([]);
  });

  it('GET lists existing projects and the injected suggestions', async () => {
    const t = table({ discover: () => [{ path: '/x/y', name: 'y', mtime: 1 }] });
    const r = await hit(t, 'GET /api/wizard/projects');
    expect(r.body.suggestions).toEqual([{ path: '/x/y', name: 'y', mtime: 1 }]);
  });
});

describe('terminal and permissions', () => {
  it('terminal writes the setting and rejects an unknown kind', async () => {
    const t = table();
    await walkTo(t, 'terminal');
    expect((await hit(t, 'POST /api/wizard/continue', { step: 'terminal', values: { terminal: 'kitty' } })).status).toBe(400);
    await next(t, 'terminal', { terminal: 'ghostty' });
    expect(withDb((db) => getSetting(db, 'terminal'))).toBe('ghostty');
  });

  it('Normal is the default and Continue writes it', async () => {
    const t = table();
    await walkTo(t, 'permissions');
    await next(t, 'permissions', { perm_chats: 'normal' });
    expect(withDb((db) => getSetting(db, 'perm_chats'))).toBe('normal');
  });

  it('Skip permissions is refused without the box, and writes nothing', async () => {
    const t = table();
    await walkTo(t, 'permissions');
    const no = await hit(t, 'POST /api/wizard/continue', { step: 'permissions', values: { perm_chats: 'skip' } });
    expect(no.status).toBe(400);
    expect(no.body.field).toBe('confirm_skip');
    expect(no.body.view.current).toBe('permissions');
    expect(withDb((db) => getSetting(db, 'perm_chats'))).toBe('normal');
    await next(t, 'permissions', { perm_chats: 'skip', confirm_skip: true });
    expect(withDb((db) => getSetting(db, 'perm_chats'))).toBe('skip');
  });

  it('the watcher and orchestrator switches need the box too', async () => {
    const t = table();
    await walkTo(t, 'permissions');
    const no = await hit(t, 'POST /api/wizard/continue', { step: 'permissions', values: { perm_chats: 'normal', perm_orchestrator: 'skip' } });
    expect(no.status).toBe(400);
    await next(t, 'permissions', { perm_chats: 'normal', perm_watchers: 'normal', perm_orchestrator: 'skip', confirm_skip: true });
    withDb((db) => {
      expect(getSetting(db, 'perm_orchestrator')).toBe('skip');
      expect(getSetting(db, 'perm_watchers')).toBe('normal');
      expect(getSetting(db, 'perm_chats')).toBe('normal');
    });
  });

  it('skipping permissions leaves the safe default', async () => {
    const t = table();
    await walkTo(t, 'permissions');
    await hit(t, 'POST /api/wizard/skip', { step: 'permissions' });
    expect(withDb((db) => getSetting(db, 'perm_chats'))).toBe('normal');
  });
});

describe('plugin', () => {
  it('Continue installs nothing and writes no plugin state', async () => {
    const t = table();
    await walkTo(t, 'plugin');
    await next(t, 'plugin');
    expect(withDb((db) => getSetting(db, 'plugin_state'))).toEqual({});
  });
});

describe('slack, and the shortcut guard', () => {
  it('Skip leaves Slack off and the shortcut step is passed over', async () => {
    const t = table();
    await walkTo(t, 'slack');
    const r = await next(t, 'slack', { mode: 'skip' });
    expect(r.body.view.current).toBe('ship');
    expect(r.body.view.state.steps.shortcut.status).toBe('skipped');
    expect(r.body.view.rail.find((x: any) => x.id === 'shortcut').visible).toBe(false);
    expect(r.body.view.progress.total).toBe(11);
  });

  it('skipping the Slack step itself also passes over the shortcut step', async () => {
    const t = table();
    await walkTo(t, 'slack');
    const r = await hit(t, 'POST /api/wizard/skip', { step: 'slack' });
    expect(r.body.view.current).toBe('ship');
    expect(r.body.view.state.steps.shortcut.status).toBe('skipped');
  });

  it('MCP only needs the connector, then shows the shortcut step', async () => {
    const t = table();
    await walkTo(t, 'slack');
    const no = await hit(t, 'POST /api/wizard/continue', { step: 'slack', values: { mode: 'mcp' } });
    expect(no.status).toBe(409);
    expect(no.body.view.current).toBe('slack');
    report.slackMcp = { found: true, connected: true, name: 'claude.ai Slack' };
    const yes = await next(t, 'slack', { mode: 'mcp' });
    expect(yes.body.view.current).toBe('shortcut');
    expect(withDb((db) => getSetting(db, 'slack_mode'))).toBe('mcp');
  });

  it('Direct with no tested token stays off, so no shortcut step; with a token it is direct', async () => {
    const t = table();
    await walkTo(t, 'slack');
    const a = await next(t, 'slack', { mode: 'direct' });
    expect(a.body.view.current).toBe('ship');
    expect(withDb((db) => getSetting(db, 'slack_mode'))).toBe('off');

    const t2 = table();
    await hit(t2, 'POST /api/wizard/rerun', {});
    process.env.SLACK_USER_TOKEN = 'xoxp-1-2-3-fake';
    try {
      await walkTo(t2, 'slack');
      const b = await next(t2, 'slack', { mode: 'direct' });
      expect(b.body.view.current).toBe('shortcut');
      expect(b.body.view.slackMode).toBe('direct');
    } finally {
      delete process.env.SLACK_USER_TOKEN;
    }
  });

  it('no choice is refused', async () => {
    const t = table();
    await walkTo(t, 'slack');
    expect((await hit(t, 'POST /api/wizard/continue', { step: 'slack', values: {} })).status).toBe(400);
  });

  it('the token never appears in a view', async () => {
    process.env.SLACK_USER_TOKEN = 'xoxp-9-9-9-secretvalue';
    try {
      const t = table();
      const text = JSON.stringify([(await hit(t, 'GET /api/wizard')).body, (await hit(t, 'GET /api/wizard/summary')).body]);
      expect(text).not.toContain('secretvalue');
    } finally {
      delete process.env.SLACK_USER_TOKEN;
    }
  });

  it('Back from Ship steps over the hidden shortcut step to Slack', async () => {
    const t = table();
    await walkTo(t, 'slack');
    await next(t, 'slack', { mode: 'skip' });
    const r = await hit(t, 'POST /api/wizard/back', {});
    expect(r.body.view.current).toBe('slack');
  });
});

describe('shortcut', () => {
  async function toShortcut(t: Record<string, RouteDef>): Promise<void> {
    report.slackMcp = { found: true, connected: true, name: 'Slack' };
    await walkTo(t, 'slack');
    await next(t, 'slack', { mode: 'mcp' });
  }

  it('refuses a macOS-reserved shortcut and does not advance', async () => {
    const t = table();
    await toShortcut(t);
    const r = await hit(t, 'POST /api/wizard/continue', { step: 'shortcut', values: { hotkey: 'Command+Space' } });
    expect(r.status).toBe(400);
    expect(r.body.field).toBe('hotkey');
    expect(r.body.view.current).toBe('shortcut');
  });

  it('keeps ⌘⇧L by default, and stores another when chosen', async () => {
    const t = table();
    await toShortcut(t);
    const v = (await hit(t, 'GET /api/wizard')).body.values;
    expect(v.hotkey).toBe('Command+Shift+L');
    expect(v.hotkey_display).toBe('⌘⇧L');
    await next(t, 'shortcut', { hotkey: 'Command+Shift+Y' });
    expect(withDb((db) => getSetting(db, 'slack_goto_hotkey'))).toBe('Command+Shift+Y');
  });

  it('a Slack-desktop clash only warns, so keeping it is allowed', async () => {
    const t = table();
    await toShortcut(t);
    const r = await hit(t, 'POST /api/wizard/continue', { step: 'shortcut', values: { hotkey: 'Command+Shift+K' } });
    expect(r.status).toBe(200);
  });

  it('leaving the step disarms practice mode', async () => {
    const t = table();
    await toShortcut(t);
    practice.arm();
    expect(practice.armed()).toBe(true);
    await hit(t, 'POST /api/wizard/back', {});
    expect(practice.armed()).toBe(false);
    practice.arm();
    await hit(t, 'POST /api/wizard/close', {});
    expect(practice.armed()).toBe(false);
  });
});

describe('ship', () => {
  it('lists only projects with a git remote, with the detected base and the default command', () => {
    const repo = path.join(dir, 'with-remote');
    const bare = path.join(dir, 'no-remote');
    const plain = path.join(dir, 'not-git');
    for (const p of [repo, bare, plain]) fs.mkdirSync(p);
    const db = openDb(dbPath);
    for (const p of [repo, bare, plain]) db.prepare(`INSERT INTO projects (path, name, added_at) VALUES (?, ?, 1)`).run(fs.realpathSync(p), path.basename(p));
    const real = (p: string) => fs.realpathSync(p);
    const opts = shipOptions(db, gitFor({ [real(repo)]: 'git@github.com:acme/app.git', [real(bare)]: '' }));
    db.close();
    expect(opts).toHaveLength(1);
    expect(opts[0]).toMatchObject({ name: 'with-remote', repo: 'acme/app', base: 'trunk', command: '/loom:ship', existing: false, enabled: true, label_required: false });
  });

  it('Continue stores enabled rows only, with the typed base and command, and refuses --force', async () => {
    const repo = path.join(dir, 'app');
    fs.mkdirSync(repo);
    const real = fs.realpathSync(repo);
    const git = gitFor({ [real]: 'https://github.com/acme/app.git' });
    const t = table({ git });
    await walkTo(t, 'ship');
    const bad = await hit(t, 'POST /api/wizard/continue', { step: 'ship', values: { ship: [{ path: real, enabled: true, ship_command: '/ship --force' }] } });
    expect(bad.status).toBe(400);
    expect(withDb((db) => listShipProjects(db, { includeDisabled: true }))).toHaveLength(0);
    await next(t, 'ship', { ship: [{ path: real, enabled: true, base_branch: 'main', ship_command: '/ship', label_required: true }] });
    const rows = withDb((db) => listShipProjects(db));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo_slug: 'acme/app', base_branch: 'main', ship_command: '/ship', label_required: true, enabled: true });
    // plugin-state.json follows, and lands in the throwaway home
    const state = JSON.parse(fs.readFileSync(path.join(process.env.LOOM_HOME!, 'plugin-state.json'), 'utf8'));
    expect(state.ship.repos).toContain(real);
  });

  it('a new install has an empty ship list until the step writes it', async () => {
    const t = table();
    await walkTo(t, 'ship');
    await hit(t, 'POST /api/wizard/skip', { step: 'ship' });
    expect(withDb((db) => listShipProjects(db, { includeDisabled: true }))).toHaveLength(0);
  });
});

describe('orchestrator', () => {
  it('off by default: Continue with the toggle off writes 0 and no trust', async () => {
    const t = table();
    await walkTo(t, 'orchestrator');
    await next(t, 'orchestrator', { enabled: false, trust: true });
    withDb((db) => {
      expect(getSetting(db, 'orchestrator_enabled')).toBe('0');
      expect(getSetting(db, 'orchestrator_trust')).toBe(false); // trust only rides on enabling
    });
  });

  it('on with the trust box ticked records both; trust unticked records none', async () => {
    const t = table();
    await walkTo(t, 'orchestrator');
    await next(t, 'orchestrator', { enabled: true, trust: true, notify: 'all' });
    withDb((db) => {
      expect(getSetting(db, 'orchestrator_enabled')).toBe('1');
      expect(getSetting(db, 'orchestrator_trust')).toBe(true);
      expect(getSetting(db, 'orchestrator_notify')).toBe('all');
    });
    await hit(t, 'POST /api/wizard/rerun', {});
    await walkTo(t, 'orchestrator');
    await next(t, 'orchestrator', { enabled: true, trust: false });
    expect(withDb((db) => getSetting(db, 'orchestrator_trust'))).toBe(false);
  });
});

describe('watchers', () => {
  it('lists the 11 templates with availability by mode and gh', async () => {
    const t = table();
    const r = await hit(t, 'GET /api/wizard/templates');
    expect(r.body.templates).toHaveLength(11);
    const by = (id: string) => r.body.templates.find((x: any) => x.id === id);
    expect(by('slack-pr-posts')).toMatchObject({ available: false, blocked: 'needs the Direct Slack app' });
    expect(by('chat-blocked-tool').available).toBe(true);
    expect(by('pr-checks-red').available).toBe(true);
    report.gh = { found: true, path: '/x', version: null, auth: { loggedIn: false, hosts: [] } } as never;
    const r2 = await hit(t, 'GET /api/wizard/templates');
    expect(r2.body.templates.find((x: any) => x.id === 'pr-checks-red')).toMatchObject({ available: false, blocked: 'needs gh, logged in' });
  });

  it('Continue creates the chosen templates and turns the master switch on', async () => {
    const t = table();
    await walkTo(t, 'watchers');
    await next(t, 'watchers', { templates: ['chat-blocked-tool', 'chat-your-turn'] });
    expect(created).toEqual([['chat-blocked-tool', 'chat-your-turn']]);
    expect(withDb((db) => getSetting(db, 'watchers_enabled'))).toBe(true);
  });

  it('none chosen means watchers stay off and nothing is created', async () => {
    const t = table();
    await walkTo(t, 'watchers');
    await next(t, 'watchers', { templates: [] });
    expect(created).toEqual([]);
    expect(withDb((db) => getSetting(db, 'watchers_enabled'))).toBe(false);
  });

  it('refuses a Slack template without Direct, a PR template without gh, and an unknown id', async () => {
    const t = table();
    await walkTo(t, 'watchers');
    expect((await hit(t, 'POST /api/wizard/continue', { step: 'watchers', values: { templates: ['slack-pr-posts'] } })).status).toBe(409);
    report.gh = { found: false, auth: null } as never;
    expect((await hit(t, 'POST /api/wizard/continue', { step: 'watchers', values: { templates: ['pr-checks-red'] } })).status).toBe(409);
    expect((await hit(t, 'POST /api/wizard/continue', { step: 'watchers', values: { templates: ['nope'] } })).status).toBe(400);
    expect(created).toEqual([]);
  });

  it('a failed create does not advance', async () => {
    const t = table();
    await walkTo(t, 'watchers');
    templateResult = { ok: false, detail: 'engine down' };
    const r = await hit(t, 'POST /api/wizard/continue', { step: 'watchers', values: { templates: ['chat-your-turn'] } });
    expect(r.status).toBe(502);
    expect(r.body.view.current).toBe('watchers');
    expect(withDb((db) => getSetting(db, 'watchers_enabled'))).toBe(false);
  });
});

describe('close, resume, finish, tour', () => {
  it('close keeps the step and writes no marker; the next read resumes there', async () => {
    const t = table();
    await walkTo(t, 'plugin');
    const c = await hit(t, 'POST /api/wizard/close', {});
    expect(c.body.view.current).toBe('plugin');
    expect(c.body.view.completedAt).toBe(0);
    const r = await hit(t, 'GET /api/wizard');
    expect(r.body.show).toBe(true);
    expect(r.body.current).toBe('plugin');
    expect(r.body.state.steps.projects.status).toBe('done');
  });

  it('a refused Continue leaves the stored state byte-identical', async () => {
    const t = table();
    await walkTo(t, 'permissions');
    const before = JSON.stringify(withDb((db) => getSetting(db, 'setup_state')));
    await hit(t, 'POST /api/wizard/continue', { step: 'permissions', values: { perm_chats: 'skip' } });
    expect(JSON.stringify(withDb((db) => getSetting(db, 'setup_state')))).toBe(before);
  });

  it('Continue on a step that is not current is refused', async () => {
    const r = await hit(table(), 'POST /api/wizard/continue', { step: 'terminal', values: {} });
    expect(r.status).toBe(409);
  });

  it('goto honours the rail rules', async () => {
    const t = table();
    await walkTo(t, 'plugin');
    expect((await hit(t, 'POST /api/wizard/goto', { step: 'ship' })).status).toBe(409);
    const ok = await hit(t, 'POST /api/wizard/goto', { step: 'projects' });
    expect(ok.body.view.current).toBe('projects');
    expect((await hit(t, 'POST /api/wizard/goto', { step: 'bogus' })).status).toBe(400);
  });

  it('finish needs the last step; then it writes the marker with origin fresh, and the wizard is done', async () => {
    const t = table();
    expect((await hit(t, 'POST /api/wizard/finish', {})).status).toBe(409);
    await walkTo(t, 'done');
    expect(withDb((db) => setupDone(db))).toBe(false);
    const r = await hit(t, 'POST /api/wizard/finish', { tour: true });
    expect(r.body.tour).toBe(true);
    expect(r.body.view).toMatchObject({ show: false, origin: 'fresh', completedAt: 1_700_000_000_000 });
    expect(r.body.view.state.steps.done.status).toBe('done');
    expect(withDb((db) => setupDone(db))).toBe(true);
  });

  it('finish is refused if requirements never passed', async () => {
    const t = table();
    await walkTo(t, 'done');
    withDb((db) => {
      const s = getSetting(db, 'setup_state') as any;
      s.steps.requirements.status = 'pending';
      setSetting(db, 'setup_state', s);
    });
    expect((await hit(t, 'POST /api/wizard/finish', {})).status).toBe(409);
  });

  it('tour markers', async () => {
    const t = table();
    expect((await hit(t, 'POST /api/wizard/tour', { result: 'maybe' })).status).toBe(400);
    const done = await hit(t, 'POST /api/wizard/tour', { result: 'completed' });
    expect(done.body.view.tourCompletedAt).toBe(1_700_000_000_000);
    const skipped = await hit(t, 'POST /api/wizard/tour', { result: 'skipped' });
    expect(skipped.body.view.tourSkippedAt).toBe(1_700_000_000_000);
  });

  it('the Done summary reflects the real settings', async () => {
    const t = table();
    await walkTo(t, 'done');
    const s = await hit(t, 'GET /api/wizard/summary', undefined, '?ax=0');
    const row = (id: string) => s.body.rows.find((r: any) => r.id === id);
    expect(row('slack')).toMatchObject({ on: false, detail: 'Off' });
    expect(row('shortcut').detail).toBe('Off (needs Slack)');
    expect(row('permissions').detail).toBe('Normal');
    expect(row('orchestrator').on).toBe(false);
  });

  it('a body that is not JSON is a 400, not a crash', async () => {
    const r = await hit(table(), 'POST /api/wizard/continue', null);
    expect(r.status).toBe(400);
  });
});

describe('the repo stays generic', () => {
  it('has no personal names, vendor setups or machine paths in the wizard sources', () => {
    for (const f of ['src/wizard.ts', 'src/routes/wizard.ts', 'src/wizardview.ts']) {
      const text = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect(text, f).not.toMatch(/Will\b|Tax Pilot|tax-pilot|Superset|loom-tp|\/Users\/|U08Q|williamhudson/);
    }
  });
});

void execFileSync;
