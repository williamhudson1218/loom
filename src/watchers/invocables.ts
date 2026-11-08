import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The skills and slash commands a watcher's chat can be told to run: user ones
// (~/.claude/skills, ~/.claude/commands), the installed plugins' (invoked as
// plugin:name) and the project's own (<project>/.claude/...). Discovery reads
// the disk, so it is cached briefly and takes the home folder as an argument
// for the tests.

export type InvocableKind = 'skill' | 'command';
export type InvocableSource = 'user' | 'plugin' | 'project';
export interface Invocable {
  kind: InvocableKind;
  name: string;
  description: string;
  source: InvocableSource;
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; list: Invocable[] }>();

export function clearInvocableCache(): void {
  cache.clear();
}

/** name and description from a markdown file's frontmatter. Handles plain, quoted and block (>, |) values. */
export function parseFrontmatter(text: string): { name: string; description: string } {
  const out = { name: '', description: '' };
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  if (lines[0]?.trim() !== '---') return out;
  const end = lines.indexOf('---', 1);
  const fm = lines.slice(1, end < 0 ? lines.length : end);
  for (let i = 0; i < fm.length; i++) {
    const m = /^(name|description):\s*(.*)$/.exec(fm[i]);
    if (!m) continue;
    let v = m[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const parts: string[] = [];
      while (i + 1 < fm.length && /^\s+\S/.test(fm[i + 1])) parts.push(fm[++i].trim());
      v = parts.join(' ');
    } else if ((v.startsWith('"') && v.endsWith('"') && v.length > 1) || (v.startsWith("'") && v.endsWith("'") && v.length > 1)) {
      v = v.slice(1, -1);
    }
    out[m[1] as 'name' | 'description'] = v;
  }
  return out;
}

const isDir = (p: string): boolean => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const readText = (p: string): string => {
  try {
    return fs.readFileSync(p, 'utf-8');
  } catch {
    return '';
  }
};
const ls = (p: string): string[] => {
  try {
    return fs.readdirSync(p).sort();
  } catch {
    return [];
  }
};

function skillsIn(dir: string, source: InvocableSource, prefix: string): Invocable[] {
  const out: Invocable[] = [];
  for (const d of ls(dir)) {
    if (!isDir(path.join(dir, d))) continue;
    const text = readText(path.join(dir, d, 'SKILL.md'));
    if (!text) continue;
    const fm = parseFrontmatter(text);
    out.push({ kind: 'skill', name: prefix + (fm.name || d), description: fm.description, source });
  }
  return out;
}

function commandsIn(dir: string, source: InvocableSource, prefix: string): Invocable[] {
  const out: Invocable[] = [];
  const walk = (sub: string, ns: string, depth: number): void => {
    for (const f of ls(sub)) {
      const full = path.join(sub, f);
      if (f.endsWith('.md')) {
        const text = readText(full);
        if (!text && !fs.existsSync(full)) continue;
        out.push({ kind: 'command', name: prefix + ns + f.slice(0, -3), description: parseFrontmatter(text).description, source });
      } else if (depth < 1 && isDir(full)) walk(full, ns + f + ':', depth + 1);
    }
  };
  walk(dir, '', 0);
  return out;
}

/** The installed plugins' folders: [plugin name, install path]. */
function pluginRoots(home: string): [string, string][] {
  let doc: { plugins?: Record<string, { installPath?: string }[]> } = {};
  try {
    doc = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), 'utf-8'));
  } catch {
    return [];
  }
  const out: [string, string][] = [];
  for (const [key, installs] of Object.entries(doc.plugins ?? {})) {
    const p = Array.isArray(installs) ? installs.find((i) => i && typeof i.installPath === 'string' && isDir(i.installPath)) : null;
    if (p?.installPath) out.push([key.split('@')[0], p.installPath]);
  }
  return out;
}

export interface DiscoverOpts {
  home?: string;
  now?: () => number;
}

/**
 * Every skill and command available to a chat in projectDir ('' for user and
 * plugin ones only). Sorted by kind, then name.
 */
export function discoverInvocables(projectDir: string, opts: DiscoverOpts = {}): Invocable[] {
  const home = opts.home ?? os.homedir();
  const now = (opts.now ?? Date.now)();
  const key = `${home}\n${projectDir}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.list;
  const list: Invocable[] = [
    ...skillsIn(path.join(home, '.claude', 'skills'), 'user', ''),
    ...commandsIn(path.join(home, '.claude', 'commands'), 'user', ''),
  ];
  for (const [plugin, root] of pluginRoots(home)) {
    list.push(...skillsIn(path.join(root, 'skills'), 'plugin', plugin + ':'), ...commandsIn(path.join(root, 'commands'), 'plugin', plugin + ':'));
  }
  if (projectDir && path.isAbsolute(projectDir)) {
    list.push(...skillsIn(path.join(projectDir, '.claude', 'skills'), 'project', ''), ...commandsIn(path.join(projectDir, '.claude', 'commands'), 'project', ''));
  }
  list.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'skill' ? -1 : 1));
  cache.set(key, { at: now, list });
  return list;
}

export function hasInvocable(kind: InvocableKind, name: string, projectDir: string, opts: DiscoverOpts = {}): boolean {
  return discoverInvocables(projectDir, opts).some((i) => i.kind === kind && i.name === name);
}

export type Invoke = { kind: InvocableKind; name: string; args: string };

/** The stored `invoke` param, or null when absent or malformed. */
export function readInvoke(p: Record<string, unknown>): Invoke | null {
  const i = p.invoke;
  if (!i || typeof i !== 'object') return null;
  const { kind, name, args } = i as Record<string, unknown>;
  if ((kind !== 'skill' && kind !== 'command') || typeof name !== 'string' || !name) return null;
  return { kind, name, args: typeof args === 'string' ? args : '' };
}
