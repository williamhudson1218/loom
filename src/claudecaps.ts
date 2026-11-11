import type { Runner } from './probe.ts';

// What this claude's `plugin` commands accept, read from its own --help.
//
// Claude Code's plugin CLI grew in steps (captured from the npm releases,
// tests/fixtures/claude-cli):
//   2.0.20   plugin install and plugin marketplace add/list/remove exist
//   2.1.8    plugin list (with --json), plugin marketplace list --json
//   2.1.63   plugin marketplace add --scope
//   later    --json on marketplace add and plugin install
// An older claude rejects a flag it does not know ("error: unknown option
// '--json'"), so Loom asks each subcommand's --help instead of assuming, and
// caches the answer per claude path and version.

export const MIN_PLUGIN_CLAUDE = '2.0.20';
export const CLAUDE_UPDATE_HINT = 'Update with `claude update`, or reinstall Claude Code.';

export interface ClaudeCaps {
  version: string | null;
  /** plugin install + plugin marketplace exist. */
  plugins: boolean;
  pluginList: boolean;
  pluginListJson: boolean;
  marketplaceListJson: boolean;
  marketplaceAddScope: boolean;
  marketplaceAddJson: boolean;
  installScope: boolean;
  installJson: boolean;
  uninstallJson: boolean;
}

/** Option names (`--scope`, `--json`) in a help text's Options section. */
export function helpOptions(help: string): Set<string> {
  const out = new Set<string>();
  let inOpts = false;
  for (const line of help.split('\n')) {
    if (/^Options:/.test(line)) { inOpts = true; continue; }
    if (/^\S/.test(line)) inOpts = false;
    if (!inOpts) continue;
    const m = /^\s+(?:-\w,\s*)?(--[a-z][a-z0-9-]*)/.exec(line);
    if (m) out.add(m[1]);
  }
  return out;
}

/** Subcommand names (and aliases) in a help text's Commands section. */
export function helpCommands(help: string): Set<string> {
  const out = new Set<string>();
  let inCmds = false;
  for (const line of help.split('\n')) {
    if (/^Commands:/.test(line)) { inCmds = true; continue; }
    if (/^\S/.test(line)) inCmds = false;
    if (!inCmds) continue;
    const m = /^\s{2}([a-z][a-z|-]*)/.exec(line);
    if (m) for (const n of m[1].split('|')) out.add(n);
  }
  return out;
}

/** The options of `claude <path> --help`, only when the help really is that command's. */
function optionsOf(help: string, cmd: string): Set<string> {
  return new RegExp(`^Usage: claude ${cmd.replace(/ /g, '\\s+')}(\\|\\S+)?\\s`, 'm').test(help) ? helpOptions(help) : new Set();
}

export function parseCaps(version: string | null, help: Record<string, string>): ClaudeCaps {
  const plugin = helpCommands(help['plugin'] ?? '');
  const market = helpCommands(help['plugin marketplace'] ?? '');
  const plugins = plugin.has('install') && plugin.has('marketplace') && market.has('add');
  const list = optionsOf(help['plugin list'] ?? '', 'plugin list');
  const mlist = optionsOf(help['plugin marketplace list'] ?? '', 'plugin marketplace list');
  const madd = optionsOf(help['plugin marketplace add'] ?? '', 'plugin marketplace add');
  const inst = optionsOf(help['plugin install'] ?? '', 'plugin install');
  const unin = optionsOf(help['plugin uninstall'] ?? '', 'plugin uninstall');
  return {
    version,
    plugins,
    pluginList: plugin.has('list'),
    pluginListJson: plugin.has('list') && list.has('--json'),
    marketplaceListJson: mlist.has('--json'),
    marketplaceAddScope: madd.has('--scope'),
    marketplaceAddJson: madd.has('--json'),
    installScope: inst.has('--scope'),
    installJson: inst.has('--json'),
    uninstallJson: unin.has('--json'),
  };
}

export const HELP_COMMANDS = [
  'plugin',
  'plugin marketplace',
  'plugin marketplace add',
  'plugin marketplace list',
  'plugin install',
  'plugin list',
  'plugin uninstall',
] as const;

const memo = new Map<string, ClaudeCaps>();

/** Dotted compare of the leading x.y.z; >0 when a is newer. */
export function versionCmp(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** Ask this claude what it supports. Cached per path and version. */
export async function detectCaps(run: Runner, bin: string, env: NodeJS.ProcessEnv): Promise<ClaudeCaps> {
  const v = await run(bin, ['--version'], { timeoutMs: 15_000, env });
  const version = /(\d+\.\d+\.\d+)/.exec(v.stdout)?.[1] ?? null;
  const key = `${bin}\0${version ?? ''}`;
  const hit = memo.get(key);
  if (hit && version) return hit;
  const help: Record<string, string> = {};
  await Promise.all(
    HELP_COMMANDS.map(async (c) => {
      const r = await run(bin, [...c.split(' '), '--help'], { timeoutMs: 15_000, env });
      help[c] = `${r.stdout}\n${r.stderr}`;
    }),
  );
  const caps = parseCaps(version, help);
  if (version) memo.set(key, caps);
  return caps;
}

export function clearCapsMemo(): void {
  memo.clear();
}

/** The message for a claude too old for plugins. */
export function tooOldDetail(version: string | null): string {
  return `Claude Code ${version ?? '(unknown version)'} has no plugin commands. Loom's plugin needs Claude Code ${MIN_PLUGIN_CLAUDE} or newer. ${CLAUDE_UPDATE_HINT}`;
}

// ---- reading the listings without --json -----------------------------------

/** `claude plugin marketplace list` text: name and directory per entry. */
export function parseMarketplaceListText(out: string): { name: string; installLocation?: string }[] {
  const res: { name: string; installLocation?: string }[] = [];
  for (const line of out.split('\n')) {
    const n = /^\s*(?:❯|>|\*|-)\s+(\S+)\s*$/.exec(line);
    if (n) { res.push({ name: n[1] }); continue; }
    const s = /^\s+Source:\s*Directory\s*\((.+)\)\s*$/.exec(line);
    if (s && res.length) res[res.length - 1].installLocation = s[1];
  }
  return res;
}

/** `claude plugin list` text: id, version and enabled per entry. */
export function parsePluginListText(out: string): { id: string; version?: string; enabled?: boolean }[] {
  const res: { id: string; version?: string; enabled?: boolean }[] = [];
  for (const line of out.split('\n')) {
    const n = /^\s*(?:❯|>|\*|-)\s+(\S+@\S+)\s*$/.exec(line);
    if (n) { res.push({ id: n[1] }); continue; }
    const cur = res[res.length - 1];
    if (!cur) continue;
    const v = /^\s+Version:\s*(\S+)/.exec(line);
    if (v) cur.version = v[1];
    const st = /^\s+Status:\s*(.+)$/.exec(line);
    if (st) cur.enabled = !/disabled/i.test(st[1]);
  }
  return res;
}
