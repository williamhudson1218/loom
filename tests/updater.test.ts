import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  APPLY_SCRIPT,
  FEED_URL,
  REPO,
  Updater,
  bundleOf,
  compareVersions,
  disabledReason,
  locationWritable,
  parseLatest,
  parseVersion,
  type UpdaterDeps,
  type UpdateState,
} from '../src/updater.ts';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-updater-'));
});
afterEach(() => {
  try {
    execFileSync('chmod', ['-R', 'u+w', tmp]);
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const plist = (id: string, version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleExecutable</key><string>Loom</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
`;

/** A tiny Loom.app: a shell script as its executable, ad-hoc signed unless sign is false. */
function fakeApp(dir: string, o: { version: string; id?: string; sign?: boolean; marker?: string }): string {
  const app = path.join(dir, 'Loom.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Loom'), '#!/bin/sh\n', { mode: 0o755 });
  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist(o.id ?? 'com.loom.app', o.version));
  fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'marker'), o.marker ?? o.version);
  if (o.sign !== false) execFileSync('codesign', ['--force', '--sign', '-', app], { stdio: 'ignore' });
  return app;
}

function zipOf(app: string, out: string): { zip: string; sha256: string } {
  execFileSync('ditto', ['-c', '-k', '--keepParent', app, out]);
  return { zip: out, sha256: crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex') };
}

const ZIP_URL = `https://github.com/${REPO}/releases/download/v0.1.9/Loom-0.1.9-arm64.zip`;

describe('versions', () => {
  it('parses dotted integers, with or without a v', () => {
    expect(parseVersion('0.1.90')).toEqual([0, 1, 90]);
    expect(parseVersion('v1.2')).toEqual([1, 2]);
    expect(parseVersion('0.1.90-dirty')).toBeNull();
    expect(parseVersion('')).toBeNull();
    expect(parseVersion(3)).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('0.1.9', '0.1.10')).toBe(-1);
    expect(compareVersions('0.1.9', '0.1.9')).toBe(0);
    expect(compareVersions('0.2', '0.1.99')).toBe(1);
    expect(compareVersions('0.1', '0.1.0')).toBe(0);
    expect(compareVersions('junk', '0.0.1')).toBe(-1);
  });
});

describe('latest.json', () => {
  const good = { version: '0.1.9', sha: 'abc', zip: ZIP_URL, sha256: 'a'.repeat(64), notes: ['fix: one', 'feat: two'] };

  it('accepts a release asset from this repo', () => {
    const r = parseLatest(good);
    expect(r.ok && r.value).toMatchObject({ version: '0.1.9', zip: ZIP_URL, notes: ['fix: one', 'feat: two'] });
  });

  it('rejects a bad version, a bad sha256 and a zip from anywhere else', () => {
    expect(parseLatest({ ...good, version: 'latest' }).ok).toBe(false);
    expect(parseLatest({ ...good, sha256: 'nope' }).ok).toBe(false);
    expect(parseLatest({ ...good, zip: 'https://evil.example/Loom.zip' }).ok).toBe(false);
    expect(parseLatest({ ...good, zip: 'https://github.com/someone/else/releases/download/v1/Loom.zip' }).ok).toBe(false);
    expect(parseLatest({ ...good, zip: ZIP_URL.replace('https', 'http') }).ok).toBe(false);
    expect(parseLatest(null).ok).toBe(false);
    expect(parseLatest([]).ok).toBe(false);
  });

  it('allows the feed’s own origin only when the feed was overridden (a local test feed)', () => {
    const local = { ...good, zip: 'http://127.0.0.1:5555/Loom.zip' };
    expect(parseLatest(local, FEED_URL).ok).toBe(false);
    expect(parseLatest(local, 'http://127.0.0.1:5555/latest.json').ok).toBe(true);
    expect(parseLatest(local, 'http://127.0.0.1:6666/latest.json').ok).toBe(false);
  });
});

describe('where Loom runs', () => {
  it('finds the bundle around the executable', () => {
    expect(bundleOf('/Applications/Loom.app/Contents/MacOS/Loom')).toBe('/Applications/Loom.app');
    expect(bundleOf('/usr/local/bin/node')).toBeNull();
  });

  it('never updates a run from source, and honours LOOM_NO_UPDATE', () => {
    expect(disabledReason({ packaged: false, app: '/Applications/Loom.app', env: {} })).toMatch(/source/);
    expect(disabledReason({ packaged: true, app: '/Applications/Loom.app', env: { LOOM_NO_UPDATE: '1' } })).toMatch(/LOOM_NO_UPDATE/);
    expect(disabledReason({ packaged: true, app: null, env: {} })).toMatch(/bundle/);
    expect(disabledReason({ packaged: true, app: '/private/var/folders/x/AppTranslocation/1/d/Loom.app', env: {} })).toMatch(/Applications/);
    expect(disabledReason({ packaged: true, app: '/Applications/Loom.app', env: {} })).toBeNull();
  });

  it('reports a folder it cannot write to', () => {
    const dir = path.join(tmp, 'ro');
    const app = fakeApp(dir, { version: '0.1.1', sign: false });
    expect(locationWritable(app)).toBe(true);
    fs.chmodSync(dir, 0o555);
    expect(locationWritable(app)).toBe(false);
  });
});

describe('Updater', () => {
  function make(o: { current?: string; feed?: unknown; zip?: string; packaged?: boolean; fetchFails?: boolean; deps?: Partial<UpdaterDeps>; auto?: boolean; app?: string; onChange?: (s: UpdateState) => void } = {}) {
    let fetched = 0;
    const deps: Partial<UpdaterDeps> = {
      fetchJson: async () => {
        fetched++;
        if (o.fetchFails) throw new Error('getaddrinfo ENOTFOUND github.com');
        return o.feed;
      },
      download: async (_url, dest) => {
        fs.copyFileSync(o.zip!, dest);
      },
      now: () => 1_700_000_000_000,
      ...o.deps,
    };
    const app = o.app ?? fakeApp(path.join(tmp, 'Applications'), { version: o.current ?? '0.1.5' });
    const u = new Updater({
      current: o.current ?? '0.1.5',
      app,
      packaged: o.packaged ?? true,
      cacheDir: path.join(tmp, 'cache'),
      env: {},
      auto: () => o.auto ?? true,
      deps,
      onChange: o.onChange,
    });
    return { u, fetched: () => fetched };
  }

  function release(version: string, o: { id?: string; sign?: boolean; zipVersion?: string } = {}) {
    const app = fakeApp(path.join(tmp, 'build', version), { version: o.zipVersion ?? version, id: o.id, sign: o.sign });
    const { zip, sha256 } = zipOf(app, path.join(tmp, `Loom-${version}.zip`));
    return { zip, feed: { version, sha: 'f00', zip: ZIP_URL, sha256, notes: ['fix: a thing'] } };
  }

  it('downloads, verifies and readies a newer release, and remembers it', async () => {
    const r = release('0.1.9');
    const { u } = make({ feed: r.feed, zip: r.zip });
    const s = await u.check();
    expect(s.status).toBe('ready');
    expect(s.ready?.version).toBe('0.1.9');
    expect(fs.readFileSync(path.join(s.ready!.app, 'Contents', 'Resources', 'marker'), 'utf8')).toBe('0.1.9');
    expect(s.lastChecked).toBe(1_700_000_000_000);
    // No partial download or unpack directory left behind.
    expect(fs.readdirSync(path.join(tmp, 'cache')).sort()).toEqual(['0.1.9', 'state.json']);
    // A later launch picks the verified bundle up without downloading again.
    const again = make({ feed: r.feed, zip: '/nonexistent', app: u.state().app! });
    expect(again.u.state().status).toBe('ready');
  });

  it('says it is current when the release is not newer', async () => {
    const r = release('0.1.5');
    const { u } = make({ feed: r.feed, zip: r.zip });
    expect((await u.check()).status).toBe('current');
  });

  it('rejects a download whose sha256 does not match', async () => {
    const r = release('0.1.9');
    const { u } = make({ feed: { ...r.feed, sha256: 'b'.repeat(64) }, zip: r.zip });
    const s = await u.check();
    expect(s.status).toBe('error');
    expect(s.detail).toMatch(/sha256 is [0-9a-f]{64} \(\d+ bytes\).*after 2 tries/);
    expect(s.ready).toBeNull();
    expect(fs.readdirSync(path.join(tmp, 'cache'))).toEqual(['state.json']);
  });

  it('retries a damaged download once and readies the good second copy', async () => {
    const r = release('0.1.9');
    let tries = 0;
    const { u } = make({
      feed: r.feed,
      zip: r.zip,
      deps: {
        download: async (_url, dest) => {
          tries++;
          if (tries === 1) fs.writeFileSync(dest, 'truncated');
          else fs.copyFileSync(r.zip, dest);
        },
      },
    });
    const s = await u.check();
    expect(tries).toBe(2);
    expect(s.status).toBe('ready');
    expect(s.ready?.version).toBe('0.1.9');
  });

  it('reports the byte count against the feed size on a hash mismatch', async () => {
    const r = release('0.1.9');
    const { u } = make({
      feed: { ...r.feed, size: 999 },
      zip: r.zip,
      deps: { download: async (_url, dest) => fs.writeFileSync(dest, 'short') },
    });
    const s = await u.check();
    expect(s.detail).toMatch(/\(5 bytes of 999\)/);
  });

  it('retries a download that ends early, then reports both tries', async () => {
    const r = release('0.1.9');
    let tries = 0;
    const { u } = make({
      feed: r.feed,
      zip: r.zip,
      deps: {
        download: async () => {
          tries++;
          throw new Error('download ended early (10 of 20 bytes)');
        },
      },
    });
    const s = await u.check();
    expect(tries).toBe(2);
    expect(s.status).toBe('error');
    expect(s.detail).toMatch(/ended early.*after 2 tries/);
  });

  it('rejects an app that fails codesign --verify', async () => {
    const r = release('0.1.9', { sign: false });
    const s = await make({ feed: r.feed, zip: r.zip }).u.check();
    expect(s.status).toBe('error');
    expect(s.detail).toMatch(/codesign/);
    expect(s.ready).toBeNull();
  });

  it('rejects a different bundle id or a version that disagrees with the release', async () => {
    const other = release('0.1.9', { id: 'com.example.notloom' });
    expect((await make({ feed: other.feed, zip: other.zip }).u.check()).detail).toMatch(/com\.example\.notloom/);
    const off = release('0.1.10', { zipVersion: '0.1.8' });
    expect((await make({ feed: off.feed, zip: off.zip }).u.check()).detail).toMatch(/version 0\.1\.8/);
  });

  it('stays quiet when a background check is offline, and says so when asked', async () => {
    const quiet = await make({ fetchFails: true }).u.check();
    expect(quiet.status).toBe('idle');
    expect(quiet.detail).toBeNull();
    const loud = await make({ fetchFails: true }).u.check({ manual: true });
    expect(loud.status).toBe('error');
    expect(loud.detail).toMatch(/ENOTFOUND/);
  });

  it('with automatic updates off, only says a release exists until asked', async () => {
    const r = release('0.1.9');
    const { u } = make({ feed: r.feed, zip: r.zip, auto: false });
    const s = await u.check();
    expect(s.status).toBe('idle');
    expect(s.detail).toMatch(/0\.1\.9 is available/);
    expect((await u.check({ manual: true })).status).toBe('ready');
  });

  it('reports every step of a check as it happens: checking, download percent, verifying, ready', async () => {
    const r = release('0.1.9');
    const seen: string[] = [];
    const { u } = make({
      feed: r.feed,
      zip: r.zip,
      onChange: (s) => seen.push(s.status === 'downloading' && s.progress != null ? `downloading ${s.progress}%` : s.status),
      deps: {
        download: async (_url, dest, onProgress) => {
          for (const got of [0, 25, 25, 50, 100]) onProgress?.(got, 100);
          fs.copyFileSync(r.zip, dest);
        },
      },
    });
    const done = u.check({ manual: true });
    // The click's state is there before anything is awaited.
    expect(u.state().status).toBe('checking');
    await done;
    const steps = seen.filter((x, i) => x !== seen[i - 1]);
    expect(steps).toEqual(['checking', 'downloading', 'downloading 0%', 'downloading 25%', 'downloading 50%', 'downloading 100%', 'verifying', 'ready']);
  });

  it('a click during a background check that stops at "available" still downloads', async () => {
    const r = release('0.1.9');
    const { u } = make({ feed: r.feed, zip: r.zip, auto: false });
    const bg = u.check();
    const click = u.check({ manual: true });
    expect((await bg).status).toBe('idle');
    expect((await click).status).toBe('ready');
  });

  it('never checks when running from source', async () => {
    const { u, fetched } = make({ packaged: false });
    expect(u.state().status).toBe('disabled');
    expect((await u.check({ manual: true })).status).toBe('disabled');
    expect(fetched()).toBe(0);
  });

  it('refuses to apply into a folder it cannot write, and says where', async () => {
    const r = release('0.1.9');
    const { u } = make({ feed: r.feed, zip: r.zip });
    await u.check();
    fs.chmodSync(path.dirname(u.state().app!), 0o555);
    let spawned = false;
    const res = u.apply({ pid: 1, relaunch: true, loomHome: tmp, spawnScript: () => (spawned = true) });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.detail).toMatch(/not writable/);
    expect(spawned).toBe(false);
    expect(u.state().status).toBe('error');
  });

  it('hands the ready bundle to the apply script with everything it needs', async () => {
    const r = release('0.1.9');
    const { u } = make({ feed: r.feed, zip: r.zip });
    await u.check();
    let env: NodeJS.ProcessEnv = {};
    const res = u.apply({ pid: 4321, relaunch: false, loomHome: '/x/home', spawnScript: (_s, e) => (env = e) });
    expect(res.ok).toBe(true);
    expect(env).toMatchObject({ LOOM_PID: '4321', LOOM_DEST: u.state().app, LOOM_FROM: '0.1.5', LOOM_TO: '0.1.9', LOOM_RELAUNCH: '0', LOOM_HOME: '/x/home' });
    expect(fs.readFileSync(path.join(tmp, 'cache', 'apply-update.sh'), 'utf8')).toBe(APPLY_SCRIPT);
    expect(u.state().status).toBe('applying');
  });
});

describe('the apply script', () => {
  let bin: string;
  let home: string;
  let dest: string;
  let cache: string;
  let events: string;
  const servers: number[] = [];

  beforeEach(() => {
    bin = path.join(tmp, 'bin');
    home = path.join(tmp, 'home');
    cache = path.join(tmp, 'cache');
    events = path.join(tmp, 'events');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(events, '');
    dest = fakeApp(path.join(tmp, 'Applications'), { version: '0.1.5', marker: 'old' });
    // Nothing here may reach a real Loom: osascript is a recorder.
    fs.writeFileSync(path.join(bin, 'osascript'), `#!/bin/bash\necho "osascript $*" >> "${events}"\n`, { mode: 0o755 });
  });
  afterEach(() => {
    for (const pid of servers.splice(0)) {
      try {
        process.kill(pid);
      } catch {
        /* gone */
      }
    }
  });

  /** `open` that starts a stand-in Loom: an HTTP server answering /api/whoami, recorded in server.json. */
  function openStartsLoom(): void {
    const server = path.join(tmp, 'fake-loom.cjs');
    fs.writeFileSync(
      server,
      `const http=require('http'),fs=require('fs');const s=http.createServer((q,r)=>{r.end(JSON.stringify({app:'loom',uid:1,home_id:'x'}));});s.listen(0,'127.0.0.1',()=>{fs.writeFileSync(process.argv[2]+'/server.json',JSON.stringify({port:s.address().port,pid:process.pid,uid:1,startedAt:1}));});setTimeout(()=>process.exit(0),30000);`,
    );
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/bash\necho "open $1" >> "${events}"\nnohup "${process.execPath}" "${server}" "${home}" > /dev/null 2>&1 &\n`, { mode: 0o755 });
  }
  function openDoesNothing(): void {
    fs.writeFileSync(path.join(bin, 'open'), `#!/bin/bash\necho "open $1" >> "${events}"\n`, { mode: 0o755 });
  }

  function runScript(o: { newApp: string; relaunch: boolean; from?: string; to?: string }) {
    const script = path.join(cache, 'apply-update.sh');
    fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o755 });
    const r = spawnSync('/bin/bash', [script], {
      encoding: 'utf8',
      timeout: 60_000,
      env: {
        PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
        HOME: home,
        LOOM_PID: '999999', // long gone
        LOOM_DEST: dest,
        LOOM_NEW: o.newApp,
        LOOM_FROM: o.from ?? '0.1.5',
        LOOM_TO: o.to ?? '0.1.9',
        LOOM_RELAUNCH: o.relaunch ? '1' : '0',
        LOOM_HOME: home,
        LOOM_RESULT: path.join(cache, 'last-apply.json'),
        LOOM_LOCK: path.join(cache, 'swap.lock'),
        LOOM_LOG: path.join(cache, 'apply.log'),
        LOOM_UP_TIMEOUT: '3',
      },
    });
    try {
      const sj = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8'));
      servers.push(sj.pid);
    } catch {
      /* no stand-in started */
    }
    const result = JSON.parse(fs.readFileSync(path.join(cache, 'last-apply.json'), 'utf8'));
    return { r, result };
  }

  const markerAt = (app: string) => fs.readFileSync(path.join(app, 'Contents', 'Resources', 'marker'), 'utf8');
  const siblings = () => fs.readdirSync(path.dirname(dest));

  it('swaps, relaunches, waits for /api/whoami, then deletes the old bundle', () => {
    openStartsLoom();
    const newApp = fakeApp(path.join(tmp, 'dl'), { version: '0.1.9', marker: 'new' });
    const { r, result } = runScript({ newApp, relaunch: true });
    expect(r.status, fs.readFileSync(path.join(cache, 'apply.log'), 'utf8')).toBe(0);
    expect(result).toMatchObject({ ok: true, from: '0.1.5', to: '0.1.9' });
    expect(markerAt(dest)).toBe('new');
    expect(siblings()).toEqual(['Loom.app']);
    expect(fs.existsSync(path.join(cache, 'swap.lock'))).toBe(false);
    expect(fs.readFileSync(events, 'utf8')).toContain(`open ${dest}`);
  });

  it('rolls back to the old bundle when the new one never answers', () => {
    openDoesNothing();
    const newApp = fakeApp(path.join(tmp, 'dl'), { version: '0.1.9', marker: 'new' });
    const { r, result } = runScript({ newApp, relaunch: true });
    expect(r.status).not.toBe(0);
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/did not answer.*Rolled back to 0\.1\.5/);
    expect(markerAt(dest)).toBe('old');
    expect(siblings()).toEqual(['Loom.app']);
    // Relaunched twice: the new one, then the restored old one.
    expect(fs.readFileSync(events, 'utf8').split('\n').filter((l) => l.startsWith('open ')).length).toBe(2);
  });

  it('on a quit (no relaunch) installs a bundle that verifies in place', () => {
    openDoesNothing();
    const newApp = fakeApp(path.join(tmp, 'dl'), { version: '0.1.9', marker: 'new' });
    const { r, result } = runScript({ newApp, relaunch: false });
    expect(r.status).toBe(0);
    expect(result.ok).toBe(true);
    expect(markerAt(dest)).toBe('new');
    expect(fs.readFileSync(events, 'utf8')).not.toContain('open ');
  });

  it('on a quit, rolls back a bundle that fails codesign --verify in place', () => {
    openDoesNothing();
    const newApp = fakeApp(path.join(tmp, 'dl'), { version: '0.1.9', marker: 'new', sign: false });
    const { result } = runScript({ newApp, relaunch: false });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/codesign/);
    expect(markerAt(dest)).toBe('old');
    expect(siblings()).toEqual(['Loom.app']);
  });

  it('leaves a bundle alone that someone else replaced in the meantime', () => {
    openDoesNothing();
    const newApp = fakeApp(path.join(tmp, 'dl'), { version: '0.1.9', marker: 'new' });
    const { result } = runScript({ newApp, relaunch: true, from: '0.1.4' });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/now version 0\.1\.5/);
    expect(markerAt(dest)).toBe('old');
  });

  it('waits its turn: a held swap lock (install-app.sh) means nothing is changed', () => {
    openDoesNothing();
    fs.mkdirSync(path.join(cache, 'swap.lock'));
    const newApp = fakeApp(path.join(tmp, 'dl'), { version: '0.1.9', marker: 'new' });
    const { result } = runScript({ newApp, relaunch: true });
    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/another install/);
    expect(markerAt(dest)).toBe('old');
    expect(fs.existsSync(path.join(cache, 'swap.lock'))).toBe(true);
  });
});
