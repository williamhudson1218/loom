import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseTmuxVersion,
  tmuxWarning,
  parseClaudeVersion,
  parsePythonVersion,
  parseGhVersion,
  parseCodexVersion,
  parseClaudeAuthJson,
  parseClaudePrint,
  parseGhAuthStatus,
  parseMcpList,
  findSlackMcp,
  parseMdfind,
  probeEnvironment,
  clearProbeMemo,
  type Runner,
  type RunResult,
} from '../src/probe.ts';

const fx = (n: string) => fs.readFileSync(path.join(__dirname, 'fixtures', 'probe', n), 'utf-8');

describe('version parsers', () => {
  it('tmux', () => {
    expect(parseTmuxVersion(fx('tmux-version.txt'))).toMatchObject({ major: 3, minor: 7, suffix: 'b', raw: '3.7b' });
    expect(parseTmuxVersion('tmux next-3.5')).toMatchObject({ major: 3, minor: 5 });
    expect(parseTmuxVersion('')).toBeNull();
    expect(parseTmuxVersion('zsh: command not found: tmux')).toBeNull();
  });
  it('tmux 3.6a warns, others do not', () => {
    expect(tmuxWarning(parseTmuxVersion('tmux 3.6a'))).toMatch(/3\.6a/);
    expect(tmuxWarning(parseTmuxVersion('tmux 3.6'))).toBeNull();
    expect(tmuxWarning(parseTmuxVersion('tmux 3.7b'))).toBeNull();
    expect(tmuxWarning(null)).toBeNull();
  });
  it('claude, python, gh, codex', () => {
    expect(parseClaudeVersion(fx('claude-version.txt'))).toMatchObject({ major: 2, minor: 1, patch: 319 });
    expect(parsePythonVersion(fx('python3-version.txt'))).toMatchObject({ major: 3, minor: 9, patch: 6 });
    expect(parseGhVersion(fx('gh-version.txt'))).toMatchObject({ major: 2, minor: 100 });
    expect(parseCodexVersion(fx('codex-version.txt'))).toMatchObject({ major: 0, minor: 145 });
    expect(parsePythonVersion('xcode-select: note: no developer tools were found')).toBeNull();
  });
});

describe('claude auth', () => {
  it('parses the fixture and drops account identifiers', () => {
    const a = parseClaudeAuthJson(fx('claude-auth-status.json'));
    expect(a).toEqual({ loggedIn: true, method: 'claude.ai', provider: 'firstParty', subscription: 'max' });
    expect(JSON.stringify(a)).not.toContain('example.com');
  });
  it('logged out and garbage', () => {
    expect(parseClaudeAuthJson('{"loggedIn": false}')?.loggedIn).toBe(false);
    expect(parseClaudeAuthJson('not json')).toBeNull();
    expect(parseClaudeAuthJson('{"foo":1}')).toBeNull();
    expect(parseClaudeAuthJson('')).toBeNull();
  });
  it('print fallback', () => {
    expect(parseClaudePrint({ code: 0, stdout: 'ok\n', stderr: '' })).toBe(true);
    expect(parseClaudePrint({ code: 1, stdout: 'Please run /login', stderr: '' })).toBe(false);
  });
});

describe('gh auth', () => {
  it('logged in', () => {
    expect(parseGhAuthStatus(fx('gh-auth-status.txt'), 0)).toEqual({ loggedIn: true, hosts: ['github.com'] });
  });
  it('logged out', () => {
    expect(parseGhAuthStatus(fx('gh-auth-status-out.txt'), 1)).toEqual({ loggedIn: false, hosts: [] });
  });
});

describe('mcp list', () => {
  it('parses the fixture', () => {
    const s = parseMcpList(fx('claude-mcp-list.txt'));
    expect(s).toHaveLength(2);
    expect(s[1]).toMatchObject({ name: 'claude.ai Slack', target: 'https://mcp.slack.com/mcp', connected: true });
    expect(findSlackMcp(s)?.name).toBe('claude.ai Slack');
  });
  it('failed, auth-needed and stdio servers', () => {
    const s = parseMcpList(
      'Checking MCP server health…\n\nfoo: npx -y @x/foo --a:b - ✗ Failed to connect\nslack: https://x.slack.com/mcp - ⚠ Needs authentication\n',
    );
    expect(s[0]).toMatchObject({ name: 'foo', target: 'npx -y @x/foo --a:b', connected: false });
    expect(s[1].connected).toBe(false);
    expect(findSlackMcp(s)?.name).toBe('slack');
  });
  it('empty / no servers', () => {
    expect(parseMcpList('No MCP servers configured.')).toEqual([]);
    expect(findSlackMcp([])).toBeNull();
  });
});

describe('mdfind', () => {
  it('first .app', () => {
    expect(parseMdfind('/Applications/Slack.app\n')).toBe('/Applications/Slack.app');
    expect(parseMdfind('')).toBeNull();
  });
});

// ---- probeEnvironment with a fake runner ----

type Reply = Partial<RunResult>;
function fakeRunner(table: Record<string, Reply>, calls: string[] = []): Runner {
  return async (cmd, args) => {
    const k = [cmd, ...args].join(' ');
    calls.push(k);
    // login shell lookups: "<shell> -lc command -v 'x'"
    const m = /command -v '(\w+)'/.exec(k);
    if (m) {
      const hit = table['which ' + m[1]];
      return hit ? { code: 0, stdout: hit.stdout ?? '', stderr: '' } : { code: 1, stdout: '', stderr: '' };
    }
    if (k.includes('printf %s "$PATH"')) return { code: 0, stdout: '/opt/homebrew/bin:/usr/bin', stderr: '' };
    for (const key of Object.keys(table)) {
      if (!key.startsWith('which ') && k.endsWith(key)) return { code: 0, stdout: '', stderr: '', ...table[key] };
    }
    return { code: null, stdout: '', stderr: '', missing: true };
  };
}

const FULL: Record<string, Reply> = {
  'which tmux': { stdout: '/opt/homebrew/bin/tmux\n' },
  'which claude': { stdout: '/Users/u/.local/bin/claude\n' },
  'which python3': { stdout: '/usr/bin/python3\n' },
  'which gh': { stdout: '/opt/homebrew/bin/gh\n' },
  'which codex': { stdout: '/opt/homebrew/bin/codex\n' },
  'tmux -V': { stdout: fx('tmux-version.txt') },
  'claude --version': { stdout: fx('claude-version.txt') },
  'python3 --version': { stdout: fx('python3-version.txt') },
  'gh --version': { stdout: fx('gh-version.txt') },
  'codex --version': { stdout: fx('codex-version.txt') },
  'auth status --json': { stdout: fx('claude-auth-status.json') },
  'mcp list': { stdout: fx('claude-mcp-list.txt') },
  'auth status': { stdout: fx('gh-auth-status.txt') },
  'mdfind kMDItemCFBundleIdentifier == \'com.tinyspeck.slackmacgap\'': { stdout: '/Applications/Slack.app\n' },
};
const base = { env: { SHELL: '/bin/zsh' }, uid: 501, homedir: '/Users/u', platform: 'darwin' as const, noMemo: true };

describe('probeEnvironment', () => {
  it('everything present', async () => {
    const r = await probeEnvironment({ ...base, runner: fakeRunner(FULL), exists: () => true });
    expect(r.ready).toBe(true);
    expect(r.tmux).toMatchObject({ found: true, path: '/opt/homebrew/bin/tmux', warning: null });
    expect(r.claude.auth).toMatchObject({ loggedIn: true });
    expect(r.claude.authVia).toBe('auth-status');
    expect(r.gh.auth?.loggedIn).toBe(true);
    expect(r.codex.homeDir).toBe(true);
    expect(r.slackApp).toEqual({ found: true, path: '/Applications/Slack.app' });
    expect(r.slackMcp).toMatchObject({ found: true, connected: true });
    expect(r.tmuxSocketDir).toEqual({ path: '/tmp/tmux-501', exists: true });
    expect(r.loginPath).toEqual(['/opt/homebrew/bin', '/usr/bin']);
  });

  it('a claude on disk that will not start is not found, and says why', async () => {
    const t = { ...FULL, 'claude --version': { code: 127, stdout: '', stderr: 'env: node: No such file or directory\n' } };
    const r = await probeEnvironment({ ...base, runner: fakeRunner(t), exists: () => true });
    expect(r.claude.found).toBe(false);
    expect(r.claude.broken).toBe('it exited with 127: env: node: No such file or directory');
    expect(r.ready).toBe(false);
  });

  it('finds claude in a known place the login shell does not list (~/.claude/local)', async () => {
    const t: Record<string, Reply> = { ...FULL };
    delete t['which claude'];
    const local = '/Users/u/.claude/local/claude';
    const r = await probeEnvironment({ ...base, runner: fakeRunner(t), exists: (p) => p === local || !p.endsWith('/claude') });
    expect(r.claude).toMatchObject({ found: true, path: local });
  });

  it('nothing installed', async () => {
    const r = await probeEnvironment({ ...base, runner: fakeRunner({}), exists: () => false });
    expect(r.ready).toBe(false);
    expect(r.tmux.found).toBe(false);
    expect(r.claude).toMatchObject({ found: false, auth: null });
    expect(r.python3.found).toBe(false);
    expect(r.gh).toMatchObject({ found: false, auth: null });
    expect(r.codex).toMatchObject({ found: false, homeDir: false });
    expect(r.slackApp.found).toBe(false);
    expect(r.slackMcp.found).toBe(false);
    expect(r.tmuxSocketDir.exists).toBe(false);
  });

  it('python3 stub with no developer tools is not found', async () => {
    const t = { ...FULL, 'python3 --version': { code: 1, stdout: '', stderr: 'xcode-select: note: no developer tools were found' } };
    const r = await probeEnvironment({ ...base, runner: fakeRunner(t), exists: () => true });
    expect(r.python3.found).toBe(false);
    expect(r.ready).toBe(false);
  });

  it('claude logged out blocks ready; gh logged out', async () => {
    const t = {
      ...FULL,
      'auth status --json': { code: 1, stdout: '{"loggedIn": false}' },
      'auth status': { code: 1, stdout: fx('gh-auth-status-out.txt') },
    };
    const r = await probeEnvironment({ ...base, runner: fakeRunner(t), exists: () => true });
    expect(r.claude.auth?.loggedIn).toBe(false);
    expect(r.gh.auth?.loggedIn).toBe(false);
    expect(r.ready).toBe(false);
  });

  it('falls back to a safe headless claude -p when auth status is unavailable', async () => {
    const calls: string[] = [];
    const t = { ...FULL, 'auth status --json': { code: 1, stderr: 'unknown command' }, '--no-session-persistence': { stdout: 'ok\n' } };
    const r = await probeEnvironment({ ...base, runner: fakeRunner(t, calls), exists: () => true });
    expect(r.claude.authVia).toBe('print');
    expect(r.claude.auth?.loggedIn).toBe(true);
    const pcall = calls.find((c) => c.includes(' -p '));
    expect(pcall).toContain('--safe-mode');
    expect(pcall).toContain('--no-session-persistence');
  });

  it('tmux 3.6a is flagged', async () => {
    const t = { ...FULL, 'tmux -V': { stdout: 'tmux 3.6a\n' } };
    const r = await probeEnvironment({ ...base, runner: fakeRunner(t), exists: () => true });
    expect(r.tmux.warning).toMatch(/3\.6a/);
    expect(r.ready).toBe(true);
  });

  it('claude_bin override and TMUX_TMPDIR are honored', async () => {
    const calls: string[] = [];
    const r = await probeEnvironment({
      ...base,
      env: { SHELL: '/bin/zsh', TMUX_TMPDIR: '/var/tmuxd' },
      claudeBin: '/custom/claude',
      runner: fakeRunner({ ...FULL, 'which claude': {} }, calls),
      exists: (p) => p === '/custom/claude',
    });
    expect(r.claude.path).toBe('/custom/claude');
    expect(r.tmuxSocketDir.path).toBe('/var/tmuxd/tmux-501');
  });

  describe('memo', () => {
    beforeEach(() => clearProbeMemo());
    it('reuses within 10 s, re-probes after', async () => {
      const calls: string[] = [];
      let t = 1000;
      const o = { ...base, noMemo: false, runner: fakeRunner(FULL, calls), exists: () => true, now: () => t };
      await probeEnvironment(o);
      const n = calls.length;
      t += 5000;
      await probeEnvironment(o);
      expect(calls.length).toBe(n);
      t += 6000;
      await probeEnvironment(o);
      expect(calls.length).toBeGreaterThan(n);
    });
  });
});
