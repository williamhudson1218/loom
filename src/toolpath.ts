import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';
import { composePath } from './appenv.ts';

// One resolver for the external tools Loom runs (claude, gh, tmux, brew, codex).
//
// A Finder-launched app starts with PATH=/usr/bin:/bin:/usr/sbin:/sbin. The
// setup wizard's probe (src/probe.ts) finds tools through the login shell, so a
// spawn that looks a bare name up on the process PATH can disagree with a check
// the user already saw pass: "claude was not found" on the plugin step right
// after the Claude step went green. So every spawn of one of these tools goes
// through resolveTool() and toolEnv(), in this order:
//
//   1. the setting override (Settings > claude_bin), when it names a real file;
//   2. the absolute path the probe found and remembered ($LOOM_HOME/tool-paths.json);
//   3. the login shell's PATH (remembered by the probe), then the process PATH;
//   4. known install locations (~/.local/bin, ~/.claude/local, Homebrew, npm,
//      bun, volta, pnpm, nvm, asdf, mise).
//
// toolEnv() gives the child a PATH that starts with the tool's own folder, so a
// `#!/usr/bin/env node` script installed by npm under nvm finds its node.

export const TOOL_PATHS_FILE = 'tool-paths.json';

export interface ToolStore {
  tools: Record<string, string>;
  loginPath: string[];
  at?: number;
}

export interface ResolveOpts {
  /** An explicit path or command name from a setting; '' when unset. */
  setting?: string;
  /** extra_path entries. */
  extra?: string[];
  home?: string;
  loomHome?: string;
  env?: NodeJS.ProcessEnv;
  isExec?: (p: string) => boolean;
  /** Read instead of $LOOM_HOME/tool-paths.json (tests). */
  store?: ToolStore;
  /** Replaces knownToolDirs(home) (tests). */
  knownDirs?: string[];
}

export function isExecFile(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.X_OK);
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const storePath = (loomHome: string = TOOL_DIR) => path.join(loomHome, TOOL_PATHS_FILE);

export function readToolStore(loomHome: string = TOOL_DIR): ToolStore {
  try {
    const j = JSON.parse(fs.readFileSync(storePath(loomHome), 'utf8'));
    return {
      tools: j && typeof j.tools === 'object' && j.tools ? j.tools : {},
      loginPath: Array.isArray(j?.loginPath) ? j.loginPath.filter((s: unknown) => typeof s === 'string') : [],
      at: Number(j?.at) || 0,
    };
  } catch {
    return { tools: {}, loginPath: [] };
  }
}

/**
 * Record what the probe found: absolute tool paths and the login shell's PATH.
 * A tool the probe did not find keeps its earlier entry only while that file
 * still exists. Never throws.
 */
export function rememberTools(found: Record<string, string | undefined>, loginPath: string[] | null, loomHome: string = TOOL_DIR): void {
  try {
    const cur = readToolStore(loomHome);
    const tools: Record<string, string> = {};
    for (const [k, v] of Object.entries(cur.tools)) if (typeof v === 'string' && isExecFile(v)) tools[k] = v;
    for (const [k, v] of Object.entries(found)) if (v && path.isAbsolute(v)) tools[k] = v;
    const next: ToolStore = { tools, loginPath: loginPath && loginPath.length ? loginPath : cur.loginPath, at: Date.now() };
    fs.mkdirSync(loomHome, { recursive: true });
    const file = storePath(loomHome);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  } catch {
    /* the resolver still has its other sources */
  }
}

/** Version-manager folders: nvm's newest node first. */
function nvmBins(home: string): string[] {
  const base = path.join(home, '.nvm', 'versions', 'node');
  try {
    return fs
      .readdirSync(base)
      .filter((v) => /^v\d/.test(v))
      .sort((a, b) => {
        const pa = a.slice(1).split('.').map(Number);
        const pb = b.slice(1).split('.').map(Number);
        for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pb[i] || 0) - (pa[i] || 0);
        return 0;
      })
      .map((v) => path.join(base, v, 'bin'));
  } catch {
    return [];
  }
}

/** Where tools are commonly installed on a Mac, user folders first. */
export function knownToolDirs(home: string): string[] {
  return [
    path.join(home, '.local', 'bin'),
    path.join(home, '.claude', 'local'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.bun', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, 'Library', 'pnpm'),
    path.join(home, '.local', 'share', 'pnpm'),
    ...nvmBins(home),
    path.join(home, '.asdf', 'shims'),
    path.join(home, '.local', 'share', 'mise', 'shims'),
    path.join(home, 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
}

const expandHome = (p: string, home: string) => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

/** The absolute path of a tool, or null when it is nowhere Loom can see. */
export function resolveTool(name: string, o: ResolveOpts = {}): string | null {
  const home = o.home ?? os.homedir();
  const env = o.env ?? process.env;
  const ok = o.isExec ?? isExecFile;
  const store = o.store ?? readToolStore(o.loomHome);
  const set = expandHome((o.setting ?? '').trim(), home);
  let bare = name;
  if (set) {
    if (set.includes('/')) {
      if (ok(set)) return set;
    } else bare = set; // a command name: look that up instead
  }
  const remembered = bare === name ? store.tools[name] : undefined;
  if (remembered && ok(remembered)) return remembered;
  const dirs = [
    ...(o.extra ?? []).map((d) => expandHome(d, home)),
    ...store.loginPath,
    ...(env.PATH ?? '').split(':'),
    ...(o.knownDirs ?? knownToolDirs(home)),
  ];
  const seen = new Set<string>();
  for (const d of dirs) {
    if (!d || seen.has(d)) continue;
    seen.add(d);
    const p = path.join(d, bare);
    if (ok(p)) return p;
  }
  return null;
}

/** The env a resolved tool runs with: its own folder first, then the composed PATH. */
export function toolEnv(bin: string | null, o: ResolveOpts & { base?: NodeJS.ProcessEnv } = {}): NodeJS.ProcessEnv {
  const home = o.home ?? os.homedir();
  const base = o.base ?? o.env ?? process.env;
  const store = o.store ?? readToolStore(o.loomHome);
  const composed = composePath({ home, extra: o.extra, loginPath: store.loginPath.join(':'), current: base.PATH });
  const own = bin && path.isAbsolute(bin) ? path.dirname(bin) : '';
  return { ...base, PATH: own ? `${own}:${composed}` : composed };
}

// ---- cached lookups for hot paths (tmux on every poll) -----------------------

const CACHE_MS = 30_000;
const cache = new Map<string, { at: number; v: string | null }>();

/** resolveTool(name) with no setting, cached briefly. Falls back to the bare name. */
export function toolBin(name: string): string {
  const now = Date.now();
  const hit = cache.get(name);
  if (hit && now - hit.at < CACHE_MS) return hit.v ?? name;
  const v = resolveTool(name);
  cache.set(name, { at: now, v });
  return v ?? name;
}

/** Forget cached lookups (after the probe remembers new paths). */
export function clearToolCache(): void {
  cache.clear();
}
