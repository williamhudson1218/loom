// Environment probe: what is installed and signed in on this machine. Feeds the
// setup wizard's Requirements step and the "needs gh / needs Slack" states.
// Parsers are pure; every process spawn goes through an injectable Runner so
// tests never touch the real machine. Results are memoized for 10 s.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface RunResult {
  code: number | null; // null = killed (timeout)
  stdout: string;
  stderr: string;
  missing?: boolean; // binary not found (ENOENT)
}
export interface RunOpts {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}
export type Runner = (cmd: string, args: string[], opts?: RunOpts) => Promise<RunResult>;

export const defaultRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: opts.timeoutMs ?? 10_000, env: opts.env ?? process.env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (!err) return resolve({ code: 0, stdout: String(stdout), stderr: String(stderr) });
        const e = err as NodeJS.ErrnoException & { killed?: boolean };
        if (e.code === 'ENOENT') return resolve({ code: null, stdout: '', stderr: '', missing: true });
        const code = typeof e.code === 'number' ? e.code : null;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
      },
    );
  });

// ---------- pure parsers ----------

export interface Version {
  raw: string; // e.g. "3.7b"
  major: number;
  minor: number;
  suffix: string; // trailing letters, "" if none
  patch?: number;
}

function parseDotted(s: string): Version | null {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?([a-z]*)/.exec(s);
  if (!m) return null;
  return {
    raw: m[0],
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] !== undefined ? Number(m[3]) : undefined,
    suffix: m[4] ?? '',
  };
}

export function parseTmuxVersion(out: string): Version | null {
  const m = /tmux\s+(?:next-)?(\S+)/.exec(out);
  return m ? parseDotted(m[1]) : null;
}

// tmux 3.6a is the build with the copy-mode server SIGABRT.
export function tmuxWarning(v: Version | null): string | null {
  if (v && v.major === 3 && v.minor === 6 && v.suffix === 'a')
    return 'tmux 3.6a can crash the whole server when scrolling in copy-mode. Upgrade tmux (brew upgrade tmux).';
  return null;
}

export function parseClaudeVersion(out: string): Version | null {
  const m = /(\d+\.\d+\.\d+)\s*(?:\(Claude Code\))?/.exec(out);
  return m ? parseDotted(m[1]) : null;
}

export function parsePythonVersion(out: string): Version | null {
  const m = /Python\s+(\S+)/i.exec(out);
  return m ? parseDotted(m[1]) : null;
}

export function parseGhVersion(out: string): Version | null {
  const m = /gh version\s+(\S+)/.exec(out);
  return m ? parseDotted(m[1]) : null;
}

export function parseCodexVersion(out: string): Version | null {
  const m = /codex(?:-cli)?\s+(\S+)/i.exec(out);
  return m ? parseDotted(m[1]) : null;
}

export interface ClaudeAuth {
  loggedIn: boolean;
  method?: string; // authMethod, e.g. "claude.ai"
  provider?: string;
  subscription?: string;
}

// `claude auth status --json`. Account identifiers (email, org) are deliberately
// not carried out of the parser.
export function parseClaudeAuthJson(out: string): ClaudeAuth | null {
  let j: unknown;
  try {
    j = JSON.parse(out);
  } catch {
    return null;
  }
  if (!j || typeof j !== 'object') return null;
  const o = j as Record<string, unknown>;
  if (typeof o.loggedIn !== 'boolean') return null;
  return {
    loggedIn: o.loggedIn,
    method: typeof o.authMethod === 'string' ? o.authMethod : undefined,
    provider: typeof o.apiProvider === 'string' ? o.apiProvider : undefined,
    subscription: typeof o.subscriptionType === 'string' ? o.subscriptionType : undefined,
  };
}

// Fallback `claude -p "Reply with ok"` result: logged in iff it printed "ok".
export function parseClaudePrint(res: RunResult): boolean {
  return res.code === 0 && /\bok\b/i.test(res.stdout);
}

export interface GhAuth {
  loggedIn: boolean;
  hosts: string[];
}

export function parseGhAuthStatus(out: string, code: number | null): GhAuth {
  const hosts: string[] = [];
  let loggedIn = false;
  for (const line of out.split('\n')) {
    if (/^[\w.-]+\.[a-z]+$/.test(line.trim()) && !line.startsWith(' ')) hosts.push(line.trim());
    if (line.includes('Logged in to')) loggedIn = true;
  }
  if (/not logged into any/i.test(out)) loggedIn = false;
  if (!loggedIn && code === 0 && hosts.length) loggedIn = true;
  return { loggedIn, hosts };
}

export interface McpServer {
  name: string;
  target: string;
  connected: boolean;
  status: string;
}

// Lines look like "<name>: <url or command> - ✔ Connected" (✗ / "Needs authentication"
// otherwise). The name may contain spaces and, for stdio servers, the target may
// contain colons, so split on the first ": " and the last " - ".
export function parseMcpList(out: string): McpServer[] {
  const servers: McpServer[] = [];
  for (const line of out.split('\n')) {
    const i = line.indexOf(': ');
    const j = line.lastIndexOf(' - ');
    if (i <= 0 || j <= i) continue;
    const status = line.slice(j + 3).trim();
    servers.push({
      name: line.slice(0, i).trim(),
      target: line.slice(i + 2, j).trim(),
      connected: /✔|connected/i.test(status) && !/not connected|✗|fail/i.test(status),
      status,
    });
  }
  return servers;
}

export function findSlackMcp(servers: McpServer[]): McpServer | null {
  return servers.find((s) => /slack/i.test(s.name) || /slack\.com/i.test(s.target)) ?? null;
}

// Install a bare `mdfind` result list into the first .app path.
export function parseMdfind(out: string): string | null {
  const l = out.split('\n').map((s) => s.trim()).find((s) => s.endsWith('.app'));
  return l ?? null;
}

// ---------- the probe ----------

export interface ToolProbe {
  found: boolean;
  path?: string;
  version?: Version | null;
  warning?: string | null;
}

export interface ProbeReport {
  at: number;
  shell: string;
  loginPath: string[]; // login-shell PATH entries
  tmux: ToolProbe;
  claude: ToolProbe & { auth: ClaudeAuth | null; authVia?: 'auth-status' | 'print' };
  python3: ToolProbe;
  gh: ToolProbe & { auth: GhAuth | null };
  codex: ToolProbe & { homeDir: boolean };
  slackApp: { found: boolean; path?: string };
  slackMcp: { found: boolean; connected: boolean; name?: string };
  mcpServers: McpServer[];
  tmuxSocketDir: { path: string; exists: boolean };
  // true when every blocking wizard requirement passes
  ready: boolean;
}

export interface ProbeOpts {
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
  uid?: number;
  homedir?: string;
  exists?: (p: string) => boolean;
  now?: () => number;
  platform?: NodeJS.Platform;
  // an explicit claude path (Settings › claude_bin) wins over the login-shell lookup
  claudeBin?: string;
  extraPath?: string[];
  noMemo?: boolean;
}

const TTL_MS = 10_000;
let memo: { at: number; key: string; p: Promise<ProbeReport> } | null = null;
export function clearProbeMemo(): void {
  memo = null;
}

const SH_QUOTE = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export async function probeEnvironment(opts: ProbeOpts = {}): Promise<ProbeReport> {
  const now = opts.now ?? Date.now;
  const key = JSON.stringify([opts.claudeBin, opts.extraPath]);
  if (!opts.noMemo && memo && memo.key === key && now() - memo.at < TTL_MS) return memo.p;
  const p = runProbe(opts, now);
  if (!opts.noMemo) {
    memo = { at: now(), key, p };
    p.catch(() => {
      if (memo?.p === p) memo = null;
    });
  }
  return p;
}

async function runProbe(opts: ProbeOpts, now: () => number): Promise<ProbeReport> {
  const run = opts.runner ?? defaultRunner;
  const env = opts.env ?? process.env;
  const exists = opts.exists ?? ((p: string) => fs.existsSync(p));
  const home = opts.homedir ?? os.homedir();
  const uid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : 0);
  const shell = env.SHELL || '/bin/zsh';

  // The login shell's PATH is the source of truth: a GUI-launched app has a
  // minimal PATH, so every lookup is made with login PATH + extra_path.
  const pathRes = await run(shell, ['-lc', 'printf %s "$PATH"'], { timeoutMs: 8000 });
  const loginPath = (pathRes.code === 0 ? pathRes.stdout : env.PATH || '')
    .split(':')
    .filter(Boolean);
  const fullPath = [...(opts.extraPath ?? []), ...loginPath].join(':');
  const toolEnv: NodeJS.ProcessEnv = { ...env, PATH: fullPath };

  const which = async (bin: string): Promise<string | undefined> => {
    const r = await run(shell, ['-lc', `command -v ${SH_QUOTE(bin)}`], { timeoutMs: 8000, env: toolEnv });
    const line = r.stdout.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    return r.code === 0 && line && line.startsWith('/') ? line : undefined;
  };
  const tool = async (bin: string, args: string[], explicit?: string) => {
    const p = explicit && exists(explicit) ? explicit : await which(bin);
    if (!p) return { path: undefined as string | undefined, out: '', res: null as RunResult | null };
    const res = await run(p, args, { timeoutMs: 8000, env: toolEnv });
    return { path: p, out: res.stdout + (res.stdout ? '' : res.stderr), res };
  };

  const [tmuxT, claudeT, pyT, ghT, codexT] = await Promise.all([
    tool('tmux', ['-V']),
    tool('claude', ['--version'], opts.claudeBin),
    tool('python3', ['--version']),
    tool('gh', ['--version']),
    tool('codex', ['--version']),
  ]);

  const tmuxV = tmuxT.path ? parseTmuxVersion(tmuxT.out) : null;
  const claudeV = claudeT.path ? parseClaudeVersion(claudeT.out) : null;
  const pyV = pyT.path ? parsePythonVersion(pyT.out) : null;

  // claude: auth + MCP list (only meaningful when the binary exists)
  let auth: ClaudeAuth | null = null;
  let authVia: 'auth-status' | 'print' | undefined;
  let mcpServers: McpServer[] = [];
  if (claudeT.path) {
    const [a, m] = await Promise.all([
      run(claudeT.path, ['auth', 'status', '--json'], { timeoutMs: 15_000, env: toolEnv }),
      run(claudeT.path, ['mcp', 'list'], { timeoutMs: 30_000, env: toolEnv }),
    ]);
    auth = parseClaudeAuthJson(a.stdout);
    if (auth) authVia = 'auth-status';
    else {
      // older claude without `auth status`: a headless one-word call. Safe mode and
      // no persistence keep it out of the user's hooks and session index.
      const pr = await run(
        claudeT.path,
        ['-p', 'Reply with the single word ok', '--safe-mode', '--no-session-persistence'],
        { timeoutMs: 45_000, env: toolEnv },
      );
      auth = { loggedIn: parseClaudePrint(pr) };
      authVia = 'print';
    }
    mcpServers = m.code === 0 ? parseMcpList(m.stdout) : [];
  }
  const slackSrv = findSlackMcp(mcpServers);

  const ghAuthRes = ghT.path ? await run(ghT.path, ['auth', 'status'], { timeoutMs: 10_000, env: toolEnv }) : null;
  const ghAuth = ghAuthRes ? parseGhAuthStatus(ghAuthRes.stdout + '\n' + ghAuthRes.stderr, ghAuthRes.code) : null;

  const platform = opts.platform ?? process.platform;
  let slackApp: { found: boolean; path?: string } = { found: false };
  if (platform === 'darwin') {
    const md = await run('mdfind', ["kMDItemCFBundleIdentifier == 'com.tinyspeck.slackmacgap'"], { timeoutMs: 5000 });
    let p = md.code === 0 ? parseMdfind(md.stdout) : null;
    if (!p && exists('/Applications/Slack.app')) p = '/Applications/Slack.app';
    if (p) slackApp = { found: true, path: p };
  }

  // tmux puts its sockets in $TMUX_TMPDIR (default /tmp) under tmux-<uid>
  const sockBase = env.TMUX_TMPDIR || '/tmp';
  const sockDir = path.join(sockBase, `tmux-${uid}`);

  const report: ProbeReport = {
    at: now(),
    shell,
    loginPath,
    tmux: { found: !!tmuxT.path, path: tmuxT.path, version: tmuxV, warning: tmuxWarning(tmuxV) },
    claude: { found: !!claudeT.path, path: claudeT.path, version: claudeV, auth, authVia },
    // /usr/bin/python3 is a stub that prompts for Xcode CLT when none is installed:
    // it exists on PATH but prints no version, so found requires a parsed version.
    python3: { found: !!pyT.path && !!pyV, path: pyT.path, version: pyV },
    gh: { found: !!ghT.path, path: ghT.path, version: ghT.path ? parseGhVersion(ghT.out) : null, auth: ghAuth },
    codex: {
      found: !!codexT.path,
      path: codexT.path,
      version: codexT.path ? parseCodexVersion(codexT.out) : null,
      homeDir: exists(path.join(home, '.codex')),
    },
    slackApp,
    slackMcp: { found: !!slackSrv, connected: !!slackSrv?.connected, name: slackSrv?.name },
    mcpServers,
    tmuxSocketDir: { path: sockDir, exists: exists(sockDir) },
    ready: false,
  };
  report.ready = report.tmux.found && report.claude.found && !!report.claude.auth?.loggedIn && report.python3.found;
  return report;
}
