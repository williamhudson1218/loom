import { execFile } from 'node:child_process';

// The environment a Dock-launched Loom needs before it shells out: a PATH that
// finds claude, tmux and gh, and the folder tmux keeps its socket in. Pure
// composition here; app/main.ts applies it. (T13)

/** Tool folders on both Homebrew prefixes (Apple Silicon and Intel) and the system. */
export function builtinPath(home: string): string[] {
  return [`${home}/.local/bin`, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
}

/**
 * PATH order: the user's extra_path, then the built-ins, then what the login
 * shell reported, then whatever the process already had. Duplicates keep their
 * first (highest) position; empty entries are dropped.
 */
export function composePath(o: { home: string; extra?: string[]; loginPath?: string; current?: string }): string {
  const split = (s?: string) => (s ? s.split(':') : []);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of [...(o.extra ?? []), ...builtinPath(o.home), ...split(o.loginPath), ...split(o.current)]) {
    const v = p.trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.join(':');
}

/**
 * Where tmux keeps its socket. A concrete `tmux_tmpdir` wins; `auto` takes the
 * login shell's TMUX_TMPDIR, then the process's, then /tmp.
 */
export function resolveTmuxTmpdir(setting: string, loginValue?: string, current?: string): string {
  if (setting && setting !== 'auto') return setting;
  return (loginValue && loginValue.trim()) || (current && current.trim()) || '/tmp';
}

export interface LoginEnv { path: string; tmuxTmpdir: string }

/** Parse the two lines `loginEnv` prints (PATH, then TMUX_TMPDIR). */
export function parseLoginEnv(out: string): LoginEnv {
  const [path = '', tmuxTmpdir = ''] = out.split('\n');
  return { path: path.trim(), tmuxTmpdir: tmuxTmpdir.trim() };
}

/** Ask the user's login shell for PATH and TMUX_TMPDIR. Resolves to null on any failure. */
export function loginEnv(shell: string = process.env.SHELL || '/bin/zsh', timeoutMs = 8000): Promise<LoginEnv | null> {
  return new Promise((resolve) => {
    try {
      execFile(shell, ['-lc', 'printf "%s\\n%s" "$PATH" "$TMUX_TMPDIR"'], { timeout: timeoutMs, encoding: 'utf8' }, (err, stdout) => {
        resolve(err ? null : parseLoginEnv(String(stdout)));
      });
    } catch {
      resolve(null);
    }
  });
}

/** The orchestrator supervisor starts with Loom only when it is on and `orchestrator_autostart` is true. */
export function shouldAutostartOrchestrator(enabled: boolean, autostart: boolean): boolean {
  return enabled && autostart;
}
