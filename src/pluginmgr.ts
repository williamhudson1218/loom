import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { defaultRunner, type Runner } from './probe.ts';
import { getSetting, onSettingChanged, setSetting } from './settingsSchema.ts';
import { TOOL_DIR } from './paths.ts';
import { resolveLoomRepoDir } from './repodir.ts';
import { moduleDirOf } from './moduledir.ts';

// Plugin manager (design §4): installs, updates and removes the Loom Claude Code
// plugin. Loom never edits ~/.claude/settings.json; it asks `claude plugin ...` to,
// and only reads that file to list legacy hook entries the plugin replaces.


export const MARKETPLACE_NAME = 'loom-local';
export const PLUGIN_NAME = 'loom';
export const PLUGIN_ID = `${PLUGIN_NAME}@${MARKETPLACE_NAME}`;
export const MARKETPLACE_DIRNAME = 'plugin-marketplace';

/** What the plugin manager remembers (settings key `plugin_state`). */
export interface PluginState {
  installed_version?: string;
  installed_at?: string;
  marketplace_dir?: string;
}

export type PluginStatusKind = 'not_installed' | 'installed' | 'update_available' | 'disabled' | 'error';

export interface LegacyEntry {
  /** The pattern that matched. */
  pattern: string;
  /** Hook event the entry sits under, when the file parses. */
  event: string | null;
  /** 1-based line in the settings file. */
  line: number;
  /** The exact line, trimmed of indentation. */
  text: string;
}

export interface PluginCommand {
  /** Human-readable `claude plugin ...` line for the preview. */
  display: string;
  argv: string[];
}

export interface PluginStatus {
  status: PluginStatusKind;
  installedVersion: string | null;
  bundledVersion: string | null;
  marketplaceDir: string;
  /** Present when status is `error`. */
  error?: string;
  /** The bundled plugin source could not be found (a broken build). */
  sourceMissing?: boolean;
  legacy: LegacyEntry[];
  /** What Install will run, for the confirm dialog. */
  preview: { install: PluginCommand[]; remove: PluginCommand[]; note: string };
}

export interface PluginMgrDeps {
  db: Database.Database;
  loomHome?: string;
  /** Source plugin dir (contains .claude-plugin/marketplace.json and loom/). */
  bundledDir?: string | null;
  claudeBin?: string;
  extraPath?: string[];
  runner?: Runner;
  /** ~/.claude/settings.json, read only. */
  claudeSettingsPath?: string;
  /** Stamped into plugin.json at copy time. Defaults to the bundled plugin's own version. */
  appVersion?: string;
  /** Rotate $LOOM_HOME/cli-token on Remove. Defaults to routes/index.ts's. */
  rotateToken?: (dir: string) => void | Promise<void>;
}

// ---------- locating things ----------

/** The plugin source: $LOOM_PLUGIN_SRC, the packaged app's Resources/plugin, then the repo's plugin/. */
export function bundledPluginDir(): string | null {
  const candidates: string[] = [];
  const env = process.env.LOOM_PLUGIN_SRC?.trim();
  if (env) candidates.push(env);
  const res = (process as { resourcesPath?: string }).resourcesPath;
  if (res) candidates.push(path.join(res, 'plugin'));
  const repo = resolveLoomRepoDir();
  if (repo) candidates.push(path.join(repo, 'plugin'));
  // Running from source (tsx, vitest): the repo's plugin/ next to src/. In the
  // app bundle import.meta.url is a sentinel, not a URL, and this is skipped.
  const here = moduleDirOf(import.meta.url);
  if (here) candidates.push(path.resolve(here, '..', 'plugin'));
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, '.claude-plugin', 'marketplace.json'))) return c;
    } catch {
      /* next */
    }
  }
  return null;
}

export const marketplaceDir = (loomHome: string = TOOL_DIR): string => path.join(loomHome, MARKETPLACE_DIRNAME);

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function bundledVersion(bundledDir: string | null): string | null {
  if (!bundledDir) return null;
  const v = readJson(path.join(bundledDir, PLUGIN_NAME, '.claude-plugin', 'plugin.json'))?.version;
  return typeof v === 'string' && v ? v : null;
}

/** Numeric dotted compare; non-numeric parts compare as strings. >0 when a is newer. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    if (!Number.isNaN(nx) && !Number.isNaN(ny)) {
      if (nx !== ny) return nx - ny;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------- copy + atomic swap ----------

const SKIP = new Set(['tests', '__pycache__', '.DS_Store', 'node_modules']);

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o755 });
  fs.chmodSync(to, 0o755);
  for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
    if (SKIP.has(ent.name) || ent.name.endsWith('.pyc')) continue;
    const src = path.join(from, ent.name);
    const dst = path.join(to, ent.name);
    if (ent.isDirectory()) copyTree(src, dst);
    else if (ent.isFile()) {
      const exec = (fs.statSync(src).mode & 0o111) !== 0;
      fs.copyFileSync(src, dst);
      fs.chmodSync(dst, exec ? 0o755 : 0o644);
    }
  }
}

/**
 * Copy the plugin source to <loomHome>/plugin-marketplace by writing a sibling
 * `.new` dir and renaming it into place, so a reader never sees a half-copy.
 * plugin/tests is left out. When `version` is given it is stamped into
 * loom/.claude-plugin/plugin.json.
 */
export function installFiles(src: string, loomHome: string, version?: string): string {
  const target = marketplaceDir(loomHome);
  const next = `${target}.new`;
  const old = `${target}.old`;
  fs.mkdirSync(loomHome, { recursive: true });
  fs.rmSync(next, { recursive: true, force: true });
  fs.rmSync(old, { recursive: true, force: true });
  copyTree(src, next);
  if (version) {
    const manifest = path.join(next, PLUGIN_NAME, '.claude-plugin', 'plugin.json');
    const j = readJson(manifest);
    if (j) {
      j.version = version;
      fs.writeFileSync(manifest, JSON.stringify(j, null, 2) + '\n', { mode: 0o644 });
    }
  }
  const had = fs.existsSync(target);
  if (had) fs.renameSync(target, old);
  try {
    fs.renameSync(next, target);
  } catch (e) {
    if (had) fs.renameSync(old, target); // put the old tree back
    fs.rmSync(next, { recursive: true, force: true });
    throw e;
  }
  fs.rmSync(old, { recursive: true, force: true });
  return target;
}

// ---------- legacy hook scan (read-only) ----------

export const LEGACY_PATTERNS = ['loom/hooks/record-placement.sh', 'slack-threads.py', 'require-slack-outbox.py', 'require-ship-label.py'] as const;

/**
 * Lines of ~/.claude/settings.json that still point at the old hook scripts the
 * plugin replaces. Never written; the UI shows them as "safe to remove".
 */
export function scanLegacyHooks(settingsPath: string = path.join(os.homedir(), '.claude', 'settings.json')): LegacyEntry[] {
  let raw: string;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch {
    return [];
  }
  const eventOf = new Map<string, string>();
  try {
    const hooks = JSON.parse(raw)?.hooks;
    if (hooks && typeof hooks === 'object') {
      for (const [event, groups] of Object.entries(hooks as Record<string, any>)) {
        for (const g of Array.isArray(groups) ? groups : []) {
          for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
            if (typeof h?.command === 'string') eventOf.set(h.command, event);
          }
        }
      }
    }
  } catch {
    /* not parseable: lines only */
  }
  const out: LegacyEntry[] = [];
  raw.split('\n').forEach((line, i) => {
    for (const pattern of LEGACY_PATTERNS) {
      if (!line.includes(pattern)) continue;
      let event: string | null = null;
      for (const [cmd, ev] of eventOf) {
        if (cmd.includes(pattern) && line.includes(cmd.slice(0, 200).replace(/"/g, '\\"'))) event = ev;
      }
      if (!event) for (const [cmd, ev] of eventOf) if (cmd.includes(pattern) && !event) event = ev;
      out.push({ pattern, event, line: i + 1, text: line.trim() });
      break;
    }
  });
  return out;
}

// ---------- plugin-state.json (what the hooks read) ----------

export interface ShipGate {
  repos: string[];
  labelRequired?: string[];
  /** Repos whose ship takes `<repo>/.git/ship.lock`; the git-add guard blocks staging on their base branch while it is held. */
  lock?: string[];
  /** Each repo's base branch (the branch the lock protects). */
  base?: Record<string, string>;
}
type ShipProvider = (db: Database.Database) => ShipGate;

let shipProvider: ShipProvider = (db) => {
  // ship_projects: one row per repo Ship works on (src/schema.ts). The hook gates on
  // ship.label_required, so the rows that require a label are listed explicitly.
  try {
    const rows = db.prepare(`SELECT project_dir AS p, label_required AS l, ship_lock AS k, base_branch AS b FROM ship_projects WHERE enabled = 1`).all() as { p: string; l: number; k: number; b: string }[];
    return {
      repos: rows.map((r) => r.p),
      labelRequired: rows.filter((r) => r.l).map((r) => r.p),
      lock: rows.filter((r) => r.k).map((r) => r.p),
      base: Object.fromEntries(rows.map((r) => [r.p, r.b || 'main'])),
    };
  } catch {
    return { repos: [] };
  }
};
/** The ship task registers the real source of the repo list here. */
export function setShipGateProvider(fn: ShipProvider): void {
  shipProvider = fn;
}

export const pluginStatePath = (loomHome: string = TOOL_DIR): string => path.join(loomHome, 'plugin-state.json');

export function buildPluginStateFile(db: Database.Database): Record<string, unknown> {
  const gate = shipProvider(db);
  const ship: Record<string, unknown> = { repos: gate.repos };
  if (gate.labelRequired) ship.label_required = gate.labelRequired;
  if (gate.lock) ship.lock = gate.lock;
  if (gate.base) ship.base = gate.base;
  // plugin_version marks the plugin as installed: the legacy record-placement.sh shim
  // stands down when it is set. Absent until installed; Remove deletes the whole file.
  const version = (getSetting(db, 'plugin_state', { env: false }) as PluginState).installed_version;
  return {
    ...(version ? { plugin_version: version } : {}),
    slack_mode: getSetting(db, 'slack_mode', { env: false }),
    outbox_chat_drafts: getSetting(db, 'outbox_chat_drafts', { env: false }),
    ship,
  };
}

/** Atomically rewrite $LOOM_HOME/plugin-state.json. */
export function writePluginStateFile(db: Database.Database, loomHome: string = TOOL_DIR): string {
  const file = pluginStatePath(loomHome);
  fs.mkdirSync(loomHome, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(buildPluginStateFile(db), null, 2) + '\n', { mode: 0o644 });
  fs.renameSync(tmp, file);
  return file;
}

/** True when the plugin manager has installed the plugin (so the gate file is worth keeping current). */
function installed(db: Database.Database): boolean {
  return !!(getSetting(db, 'plugin_state', { env: false }) as PluginState).installed_version;
}

/**
 * At startup, rewrite plugin-state.json when anything reads it: the plugin is
 * installed, or a repo is on Ship (the ship hooks read its lock and label lists,
 * installed plugin or not). An upgrade that adds a key to the file then reaches
 * the hooks without waiting for a settings change.
 */
function refreshPluginStateOnStart(openDb: () => Database.Database, loomHome: string): void {
  try {
    const db = openDb();
    try {
      let ship = false;
      try {
        ship = !!db.prepare(`SELECT 1 FROM ship_projects LIMIT 1`).get();
      } catch {
        /* no table yet */
      }
      if (installed(db) || ship) writePluginStateFile(db, loomHome);
    } finally {
      db.close();
    }
  } catch (e) {
    console.error('[loom] plugin-state.json not refreshed:', (e as Error).message);
  }
}

/**
 * Keep plugin-state.json current: rewrites it when a setting it carries changes.
 * Call once at startup with a way to open the DB; returns the unsubscribe.
 */
export function startPluginStateSync(openDb: () => Database.Database, loomHome: string = TOOL_DIR): () => void {
  refreshPluginStateOnStart(openDb, loomHome);
  return onSettingChanged((c) => {
    if (c.key !== 'slack_mode' && c.key !== 'outbox_chat_drafts') return;
    const db = openDb();
    try {
      if (installed(db)) writePluginStateFile(db, loomHome);
    } finally {
      db.close();
    }
  });
}

// ---------- the manager ----------

const previewCommands = (dir: string, claude = 'claude') => ({
  install: [
    { argv: [claude, 'plugin', 'marketplace', 'add', dir, '--scope', 'user', '--json'] },
    { argv: [claude, 'plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json'] },
  ],
  remove: [
    { argv: [claude, 'plugin', 'uninstall', PLUGIN_ID, '--json'] },
    { argv: [claude, 'plugin', 'marketplace', 'remove', MARKETPLACE_NAME] },
  ],
});
const shq = (s: string) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const withDisplay = (cmds: { argv: string[] }[]): PluginCommand[] => cmds.map((c) => ({ argv: c.argv, display: c.argv.map(shq).join(' ') }));

export const PREVIEW_NOTE =
  'These commands are run by Claude Code itself, and they record the plugin in your ~/.claude/settings.json. Loom does not edit that file.';

export interface StepResult {
  display: string;
  code: number | null;
  output: string;
}
export interface ActionResult {
  ok: boolean;
  detail?: string;
  steps: StepResult[];
  status: PluginStatus;
}

export class PluginManager {
  readonly loomHome: string;
  readonly bundledDir: string | null;
  private readonly runner: Runner;
  private readonly claude: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly settingsPath: string;

  constructor(private readonly d: PluginMgrDeps) {
    this.loomHome = d.loomHome ?? TOOL_DIR;
    this.bundledDir = d.bundledDir === undefined ? bundledPluginDir() : d.bundledDir;
    this.runner = d.runner ?? defaultRunner;
    this.claude = d.claudeBin || (getSetting(d.db, 'claude_bin', { env: false }) as string) || 'claude';
    const extra = d.extraPath ?? (getSetting(d.db, 'extra_path', { env: false }) as string[]);
    this.env = { ...process.env, PATH: [...extra, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter) };
    this.settingsPath = d.claudeSettingsPath ?? path.join(os.homedir(), '.claude', 'settings.json');
  }

  private state(): PluginState {
    return { ...(getSetting(this.d.db, 'plugin_state', { env: false }) as PluginState) };
  }
  private async run(argv: string[], timeoutMs = 60_000): Promise<StepResult & { stdout: string; missing?: boolean }> {
    const display = [this.claude, ...argv].map(shq).join(' ');
    const r = await this.runner(this.claude, argv, { timeoutMs, env: this.env });
    const output = (r.stdout + (r.stderr ? `\n${r.stderr}` : '')).trim();
    return { display, code: r.code, output, stdout: r.stdout, missing: r.missing };
  }

  preview(): PluginStatus['preview'] {
    const p = previewCommands(marketplaceDir(this.loomHome), this.claude);
    return { install: withDisplay(p.install), remove: withDisplay(p.remove), note: PREVIEW_NOTE };
  }

  /** `claude plugin list --json`, parsed. null + error when claude cannot answer. */
  private async listed(): Promise<{ entry: any | null; error?: string }> {
    const r = await this.run(['plugin', 'list', '--json'], 20_000);
    if (r.missing) return { entry: null, error: 'claude was not found' };
    if (r.code !== 0) return { entry: null, error: r.output.slice(0, 300) || 'claude plugin list failed' };
    try {
      const arr = JSON.parse(r.stdout);
      if (!Array.isArray(arr)) return { entry: null, error: 'unexpected output from claude plugin list' };
      return { entry: arr.find((e: any) => e?.id === PLUGIN_ID) ?? null };
    } catch {
      return { entry: null, error: 'could not read claude plugin list output' };
    }
  }

  async status(): Promise<PluginStatus> {
    const st = this.state();
    const bundled = this.d.appVersion ?? bundledVersion(this.bundledDir);
    const base = {
      installedVersion: st.installed_version ?? null,
      bundledVersion: bundled,
      marketplaceDir: marketplaceDir(this.loomHome),
      legacy: scanLegacyHooks(this.settingsPath),
      preview: this.preview(),
      ...(this.bundledDir ? {} : { sourceMissing: true }),
    };
    const { entry, error } = await this.listed();
    if (error) {
      // claude missing and nothing recorded: simply not installed; otherwise it is an error worth showing.
      if (!st.installed_version) return { ...base, status: error === 'claude was not found' ? 'not_installed' : 'error', error };
      return { ...base, status: 'error', error };
    }
    if (!entry) return { ...base, status: 'not_installed' };
    const installedVersion = st.installed_version ?? (typeof entry.version === 'string' ? entry.version : null);
    if (entry.enabled === false) return { ...base, installedVersion, status: 'disabled' };
    const newer = bundled && installedVersion && compareVersions(bundled, installedVersion) > 0;
    return { ...base, installedVersion, status: newer ? 'update_available' : 'installed' };
  }

  private async result(ok: boolean, steps: StepResult[], detail?: string): Promise<ActionResult> {
    return { ok, detail, steps, status: await this.status() };
  }

  private stamp(): string | undefined {
    return this.d.appVersion ?? bundledVersion(this.bundledDir) ?? undefined;
  }

  private remember(version: string | undefined): void {
    const prev = this.state();
    setSetting(this.d.db, 'plugin_state', {
      installed_version: version ?? prev.installed_version,
      installed_at: prev.installed_at ?? new Date().toISOString(),
      marketplace_dir: marketplaceDir(this.loomHome),
    });
  }

  async install(): Promise<ActionResult> {
    if (!this.bundledDir) return this.result(false, [], 'The plugin files are missing from this build.');
    const steps: StepResult[] = [];
    const dir = installFiles(this.bundledDir, this.loomHome, this.stamp());
    // add the marketplace unless Claude already has it pointing at this directory
    const ml = await this.run(['plugin', 'marketplace', 'list', '--json'], 20_000);
    if (ml.missing) return this.result(false, steps, 'claude was not found. Install Claude Code or set its path in Settings.');
    let have = false;
    try {
      const arr = JSON.parse(ml.stdout);
      have = Array.isArray(arr) && arr.some((m: any) => m?.name === MARKETPLACE_NAME && (!m.installLocation || path.resolve(m.installLocation) === path.resolve(dir)));
    } catch {
      /* treat as not added */
    }
    if (!have) {
      const add = await this.run(['plugin', 'marketplace', 'add', dir, '--scope', 'user', '--json']);
      steps.push(add);
      if (add.code !== 0) return this.result(false, steps, add.output.slice(0, 300) || 'claude plugin marketplace add failed');
    }
    const inst = await this.run(['plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json']);
    steps.push(inst);
    if (inst.code !== 0) return this.result(false, steps, inst.output.slice(0, 300) || 'claude plugin install failed');
    this.remember(this.stamp());
    writePluginStateFile(this.d.db, this.loomHome);
    return this.result(true, steps);
  }

  /** Swap in the bundled files. Running chats pick them up at their next start or /reload-plugins. */
  async update(): Promise<ActionResult> {
    if (!this.bundledDir) return this.result(false, [], 'The plugin files are missing from this build.');
    if (!this.state().installed_version) return this.result(false, [], 'The plugin is not installed.');
    installFiles(this.bundledDir, this.loomHome, this.stamp());
    this.remember(this.stamp());
    writePluginStateFile(this.d.db, this.loomHome);
    return this.result(true, []);
  }

  async remove(): Promise<ActionResult> {
    const steps: StepResult[] = [];
    const un = await this.run(['plugin', 'uninstall', PLUGIN_ID, '--json']);
    steps.push(un);
    if (un.missing) return this.result(false, steps, 'claude was not found.');
    // A plugin that is already gone is fine; carry on to the marketplace.
    const mk = await this.run(['plugin', 'marketplace', 'remove', MARKETPLACE_NAME]);
    steps.push(mk);
    if (un.code !== 0 && mk.code !== 0) return this.result(false, steps, (un.output || mk.output).slice(0, 300) || 'claude plugin uninstall failed');
    fs.rmSync(marketplaceDir(this.loomHome), { recursive: true, force: true });
    fs.rmSync(`${marketplaceDir(this.loomHome)}.new`, { recursive: true, force: true });
    fs.rmSync(`${marketplaceDir(this.loomHome)}.old`, { recursive: true, force: true });
    fs.rmSync(pluginStatePath(this.loomHome), { force: true });
    const rotate = this.d.rotateToken ?? (async (dir: string) => (await import('./routes/index.ts')).rotateCliToken(dir));
    await rotate(this.loomHome);
    setSetting(this.d.db, 'plugin_state', {});
    return this.result(true, steps);
  }
}
