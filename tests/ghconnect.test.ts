import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBin, makeGhConnect, parseDeviceCode, parseGhLogin, GH_LOGIN_ARGS, type Job } from '../src/ghconnect.ts';
import { makeGithubRoutes } from '../src/routes/github.ts';
import { ROUTES, type RouteCtx, type RouteDef } from '../src/routes/index.ts';

// No real gh or brew ever runs: each test writes a fake script into a temp dir
// and points Loom at it. The fake logs its arguments so the flags can be checked.

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-gh-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!/bin/sh\necho "$@" >> "${dir}/${name}.args"\n${body}\n`, { mode: 0o755 });
  return p;
}
const args = (name: string) => fs.readFileSync(path.join(dir, `${name}.args`), 'utf8').trim();

// What gh 2.x prints on a non-interactive --web login.
const GH_OK = `printf '! First copy your one-time code: AB12-CD34\\n' >&2
printf 'Open this URL to continue in your web browser: https://github.com/login/device\\n' >&2
sleep 0.3
printf '\\342\\234\\223 Authentication complete.\\n' >&2
exit 0`;

const until = async (f: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!f()) {
    if (Date.now() - t > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

describe('parsing gh output', () => {
  it('finds the one-time code, with or without colour', () => {
    expect(parseDeviceCode('! First copy your one-time code: AB12-CD34')).toBe('AB12-CD34');
    expect(parseDeviceCode('\x1b[0;33m!\x1b[0m First copy your one-time code: \x1b[1mWXYZ-9876\x1b[0m')).toBe('WXYZ-9876');
    expect(parseDeviceCode('nothing here')).toBe('');
  });
  it('reads the account from gh auth status', () => {
    expect(parseGhLogin('github.com\n  ✓ Logged in to github.com account octo-cat (keyring)')).toBe('octo-cat');
    expect(parseGhLogin('✓ Logged in to github.com as hubber (oauth_token)')).toBe('hubber');
    expect(parseGhLogin('You are not logged into any GitHub hosts.')).toBe('');
  });
  it('runs the documented login flags', () => {
    expect(GH_LOGIN_ARGS).toEqual(['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https']);
  });
  it('looks for gh on PATH and in the Homebrew folders', () => {
    const seen: string[] = [];
    expect(findBin('gh', { PATH: '/a:/b' }, (p) => (seen.push(p), p === '/opt/homebrew/bin/gh'))).toBe('/opt/homebrew/bin/gh');
    expect(seen).toEqual(['/a/gh', '/b/gh', '/opt/homebrew/bin/gh']);
    expect(findBin('gh', { PATH: '' }, () => false)).toBe('');
  });
});

describe('the device login job', () => {
  it('shows the code, opens the device page once, and ends ok when gh exits 0', async () => {
    const gh = fake('gh', GH_OK);
    const codes: string[] = [];
    let done: Job | null = null;
    const c = makeGhConnect({ onCode: (code) => codes.push(code), onDone: (j) => (done = j) });
    c.login(gh);
    await until(() => !!c.job()?.code);
    expect(c.job()).toMatchObject({ kind: 'login', state: 'running', code: 'AB12-CD34', url: 'https://github.com/login/device' });
    await until(() => c.job()?.state !== 'running');
    expect(c.job()?.state).toBe('ok');
    expect(codes).toEqual(['AB12-CD34']);
    expect(done).not.toBeNull();
    expect(args('gh')).toBe('auth login --hostname github.com --web --git-protocol https');
  });

  it('reports why a login failed', async () => {
    const gh = fake('gh', `printf '! First copy your one-time code: AB12-CD34\\n' >&2\nprintf 'error: authorization_pending expired\\n' >&2\nexit 1`);
    const c = makeGhConnect();
    c.login(gh);
    await until(() => c.job()?.state !== 'running');
    expect(c.job()).toMatchObject({ state: 'error' });
    expect(c.job()?.error).toContain('expired');
    expect(c.job()?.error).not.toContain('one-time code');
  });

  it('Cancel kills gh and frees the slot', async () => {
    const gh = fake('gh', `printf '! First copy your one-time code: AB12-CD34\\n' >&2\nexec sleep 30`);
    const c = makeGhConnect();
    c.login(gh);
    await until(() => !!c.job()?.code);
    expect(() => c.login(gh)).toThrow('busy');
    expect(c.cancel()).toBe(true);
    expect(c.job()?.state).toBe('cancelled');
    expect(c.cancel()).toBe(false);
    // A new job can start once the old one is cancelled.
    const gh2 = fake('gh2', GH_OK);
    c.login(gh2);
    await until(() => c.job()?.state !== 'running');
    expect(c.job()?.state).toBe('ok');
  });

  it('a missing gh ends as not installed', async () => {
    const c = makeGhConnect();
    c.login(path.join(dir, 'no-such-gh'));
    await until(() => c.job()?.state !== 'running');
    expect(c.job()).toMatchObject({ state: 'error', error: 'no-such-gh is not installed' });
  });

  it('streams brew install output', async () => {
    const brew = fake('brew', `echo '==> Downloading gh'\necho '==> Pouring gh--2.100.0.arm64_sequoia.bottle.tar.gz'\nexit 0`);
    const c = makeGhConnect();
    c.install(brew);
    await until(() => c.job()?.state !== 'running');
    expect(c.job()).toMatchObject({ kind: 'install', state: 'ok' });
    expect(c.job()?.log).toContain('==> Downloading gh');
    expect(args('brew')).toBe('install gh');
  });
});

/* ------------------------------------------------------------------ routes */

function ctxFor(method: string, url: string, body?: unknown) {
  const out: { status?: number; body?: Record<string, any> } = {};
  const ctx = {
    req: { socket: { localPort: 4317 } },
    res: { headersSent: false },
    url: new URL('http://localhost:4317' + url),
    json(code: number, b: unknown) {
      out.status = code;
      out.body = b as Record<string, any>;
    },
    body: async () => (body ?? {}) as Record<string, unknown>,
  } as unknown as RouteCtx;
  return { ctx, out };
}

function routes(o: { gh?: string; brew?: string; status?: { state: 'ok' | 'unauth' | 'missing' | 'unknown'; login: string } } = {}) {
  const connect = makeGhConnect();
  const list = makeGithubRoutes({
    ghBin: () => o.gh ?? '',
    brewBin: () => o.brew ?? '',
    status: async () => o.status ?? { state: o.gh ? 'unauth' : 'missing', login: '' },
    connect,
  });
  const by: Record<string, RouteDef> = Object.fromEntries(list.map((r) => [`${r.method} ${r.path}`, r]));
  const call = async (key: string, url: string, body?: unknown) => {
    const { ctx, out } = ctxFor(key.split(' ')[0], url, body);
    await by[key].handler!(ctx);
    return out;
  };
  return { call, connect };
}

describe('GitHub routes', () => {
  it('are in the guarded route table', () => {
    const keys = ROUTES.map((r) => `${r.method} ${r.path} ${r.kind}`);
    expect(keys).toContain('POST /api/github/login browser');
    expect(keys).toContain('POST /api/github/install browser');
    expect(keys).toContain('POST /api/github/cancel browser');
    expect(keys).toContain('GET /api/github/status read');
  });

  it('never starts a login over an existing one unless asked to sign in again', async () => {
    const gh = fake('gh', GH_OK);
    const r = routes({ gh, status: { state: 'ok', login: 'octo-cat' } });
    const refused = await r.call('POST /api/github/login', '/api/github/login', {});
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ error: 'already_signed_in', login: 'octo-cat' });
    expect(fs.existsSync(path.join(dir, 'gh.args'))).toBe(false);
    const again = await r.call('POST /api/github/login', '/api/github/login', { again: true });
    expect(again.status).toBe(200);
    await until(() => r.connect.job()?.state !== 'running');
    expect(r.connect.job()?.state).toBe('ok');
  });

  it('status says signed in, not installed, or the running job', async () => {
    const ok = await routes({ gh: '/x/gh', status: { state: 'ok', login: 'octo-cat' } }).call('GET /api/github/status', '/api/github/status');
    expect(ok.body).toMatchObject({ state: 'ok', login: 'octo-cat', gh: '/x/gh' });
    const missing = await routes({ brew: '/opt/homebrew/bin/brew' }).call('GET /api/github/status', '/api/github/status');
    expect(missing.body).toMatchObject({ state: 'missing', gh: null, brew: true });
  });

  it('installs with Homebrew only when gh is missing and brew exists', async () => {
    expect((await routes({ gh: '/x/gh' }).call('POST /api/github/install', '/api/github/install')).body).toMatchObject({ error: 'gh_installed' });
    expect((await routes({}).call('POST /api/github/install', '/api/github/install')).body).toMatchObject({ error: 'no_brew' });
    const brew = fake('brew', 'echo ok');
    const r = routes({ brew });
    expect((await r.call('POST /api/github/install', '/api/github/install')).status).toBe(200);
    await until(() => r.connect.job()?.state !== 'running');
    expect(r.connect.job()?.state).toBe('ok');
  });

  it('refuses a login when gh is missing, and cancel answers when nothing runs', async () => {
    expect((await routes({}).call('POST /api/github/login', '/api/github/login')).body).toMatchObject({ error: 'gh_missing' });
    expect((await routes({}).call('POST /api/github/cancel', '/api/github/cancel')).body).toMatchObject({ ok: true, cancelled: false });
  });
});
