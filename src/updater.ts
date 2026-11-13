import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

// Loom's self-updater: GitHub Releases in, a swapped bundle out.
//
// Not electron-updater / Squirrel.Mac: Loom is ad-hoc signed, so its designated
// requirement is `cdhash H"…"`, pinned to the exact bytes of this build, and
// ShipIt refuses any new bundle that does not satisfy the running app's
// requirement, i.e. every update. So the updater here does what ShipIt would, by
// hand: fetch latest.json from the newest release, download the zip, check its
// sha256, unpack it with ditto, `codesign --verify --deep --strict` it, check the
// bundle id and version, and keep it ready. Applying hands off to a detached
// bash script (applyScript) that waits for this process to exit, swaps the
// bundles with two renames, relaunches, and rolls back if the new one does not
// answer /api/whoami.
//
// Grants survive because they are not on Loom.app: Accessibility, Automation and
// the Keychain item belong to the helper bundles under Contents/Helpers, which a
// release reuses byte for byte while their inputs are unchanged (app/build.mjs,
// .github/workflows/release.yml). The swap does not touch tmux: chats keep running.
//
// No electron import, so all of it runs under vitest; app/main.ts wires it up.

export const REPO = 'williamhudson1218/loom';
export const FEED_URL = `https://github.com/${REPO}/releases/latest/download/latest.json`;
export const BUNDLE_ID = 'com.loom.app';
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const MAX_ZIP_BYTES = 600 * 1024 * 1024;

/* ------------------------------------------------------------ versions */

/** [major, minor, patch, …] or null when `v` is not a dotted run of integers (an optional leading v). */
export function parseVersion(v: unknown): number[] | null {
  if (typeof v !== 'string') return null;
  const m = /^v?(\d+(?:\.\d+){0,3})$/.exec(v.trim());
  return m ? m[1].split('.').map(Number) : null;
}

/** -1, 0 or 1. An unparseable version sorts below every real one. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/* ------------------------------------------------------------ latest.json */

export interface Latest {
  version: string;
  sha: string;
  zip: string;
  sha256: string;
  notes: string[];
  published_at?: string;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; detail: string };

/**
 * Validate latest.json. The zip must come from this repo's release downloads, or
 * from the feed's own origin when the feed was overridden (a local test feed).
 */
export function parseLatest(raw: unknown, feedUrl: string = FEED_URL): Parsed<Latest> {
  const bad = (detail: string): Parsed<Latest> => ({ ok: false, detail });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('latest.json is not an object');
  const o = raw as Record<string, unknown>;
  if (!parseVersion(o.version)) return bad('latest.json has no valid version');
  if (typeof o.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(o.sha256)) return bad('latest.json has no valid sha256');
  if (typeof o.zip !== 'string') return bad('latest.json has no zip url');
  let zip: URL;
  let feed: URL;
  try {
    zip = new URL(o.zip);
    feed = new URL(feedUrl);
  } catch {
    return bad('latest.json zip url is not a url');
  }
  const official = zip.protocol === 'https:' && zip.host === 'github.com' && zip.pathname.startsWith(`/${REPO}/releases/download/`);
  const sameOrigin = feedUrl !== FEED_URL && zip.origin === feed.origin;
  if (!official && !sameOrigin) return bad(`latest.json zip url is not a ${REPO} release download`);
  const notes = Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === 'string') : typeof o.notes === 'string' ? o.notes.split('\n').filter(Boolean) : [];
  return {
    ok: true,
    value: {
      version: String(o.version).trim().replace(/^v/, ''),
      sha: typeof o.sha === 'string' ? o.sha : '',
      zip: zip.toString(),
      sha256: o.sha256.toLowerCase(),
      notes: notes.slice(0, 50).map((n) => n.slice(0, 300)),
      published_at: typeof o.published_at === 'string' ? o.published_at : undefined,
    },
  };
}

/* ------------------------------------------------------------ where the app is */

/** The .app bundle around an executable (…/Loom.app/Contents/MacOS/Loom), or null. */
export function bundleOf(execPath: string): string | null {
  const app = path.resolve(execPath, '..', '..', '..');
  return app.endsWith('.app') && path.basename(path.dirname(execPath)) === 'MacOS' ? app : null;
}

/** Whether the updater may replace `app`: its folder must be writable, since the swap renames inside it. */
export function locationWritable(app: string, access: (p: string, mode: number) => void = fs.accessSync): boolean {
  try {
    access(path.dirname(app), fs.constants.W_OK);
    access(app, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** Why this process never self-updates, or null when it may. */
export function disabledReason(o: { packaged: boolean; app: string | null; env?: NodeJS.ProcessEnv }): string | null {
  const env = o.env ?? process.env;
  if (!o.packaged) return 'Running from source: updates come from git, not GitHub Releases.';
  if (env.LOOM_NO_UPDATE === '1') return 'LOOM_NO_UPDATE=1 is set.';
  if (!o.app) return 'Loom is not running from an app bundle.';
  if (/\/AppTranslocation\//.test(o.app)) return 'macOS is running Loom from a temporary copy. Move Loom to Applications and open it again.';
  return null;
}

/* ------------------------------------------------------------ state */

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'current' | 'downloading' | 'verifying' | 'ready' | 'applying' | 'error';

/** A check is under way: the page shows progress and keeps polling or listening. */
export const UPDATE_BUSY: readonly UpdateStatus[] = ['checking', 'downloading', 'verifying'];

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  commit: string;
  channel: string;
  app: string | null;
  writable: boolean;
  auto: boolean;
  lastChecked: number | null;
  /** The newest release seen, ready or not. */
  latest: Latest | null;
  /** While downloading: whole percent received, or null when the size is unknown. */
  progress: number | null;
  /** The verified bundle waiting to be swapped in. */
  ready: { version: string; app: string; notes: string[] } | null;
  detail: string | null;
  /** What the last apply did, read from the apply script's result file. */
  lastApply: ApplyResult | null;
}

export interface ApplyResult {
  ok: boolean;
  from: string;
  to: string;
  at: number;
  detail: string;
}

export interface UpdaterDeps {
  fetchJson(url: string): Promise<unknown>;
  /** `onProgress(received, total)`; total is 0 when the server sends no length. */
  download(url: string, dest: string, onProgress?: (received: number, total: number) => void): Promise<void>;
  sha256File(p: string): Promise<string>;
  /** ditto -x -k zip dir */
  extract(zip: string, dir: string): Promise<void>;
  /** codesign --verify --deep --strict; throws on failure. */
  verifySignature(app: string): Promise<void>;
  /** CFBundleIdentifier and CFBundleShortVersionString of a bundle. */
  readBundle(app: string): Promise<{ id: string; version: string }>;
  now(): number;
}

export interface UpdaterOpts {
  current: string;
  commit?: string;
  channel?: string;
  app: string | null;
  packaged: boolean;
  cacheDir?: string;
  feedUrl?: string;
  auto?: () => boolean;
  env?: NodeJS.ProcessEnv;
  deps?: Partial<UpdaterDeps>;
  onChange?: (s: UpdateState) => void;
}

/** Downloads per check: one retry covers a transfer cut short by sleep or a network change. */
export const DOWNLOAD_TRIES = 2;

export const defaultCacheDir = (): string => path.join(os.homedir(), 'Library', 'Caches', 'Loom', 'updates');

const run = (cmd: string, args: string[]): Promise<string> =>
  new Promise((resolve, reject) =>
    execFile(cmd, args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? reject(new Error(`${path.basename(cmd)} failed: ${(stderr || err.message).trim().split('\n').slice(-3).join(' ')}`)) : resolve(stdout),
    ),
  );

export const defaultDeps: UpdaterDeps = {
  async fetchJson(url) {
    const res = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Loom-updater' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`feed answered ${res.status}`);
    return res.json();
  },
  async download(url, dest, onProgress) {
    const res = await fetch(url, { headers: { 'user-agent': 'Loom-updater' }, signal: AbortSignal.timeout(15 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`download answered ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_ZIP_BYTES) throw new Error('download is larger than any Loom release');
    let seen = 0;
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (c: Buffer) => {
      seen += c.length;
      if (seen > MAX_ZIP_BYTES) body.destroy(new Error('download is larger than any Loom release'));
      else onProgress?.(seen, len);
    });
    await pipeline(body, fs.createWriteStream(dest));
    // A connection dropped mid-body (sleep, wifi change) can end the stream
    // cleanly; a short file is a failed download, not a bad release.
    if (len > 0 && seen !== len) throw new Error(`download ended early (${seen} of ${len} bytes)`);
  },
  async sha256File(p) {
    const h = crypto.createHash('sha256');
    await pipeline(fs.createReadStream(p), h);
    return h.digest('hex');
  },
  async extract(zip, dir) {
    await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  },
  async verifySignature(app) {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  },
  async readBundle(app) {
    const plist = path.join(app, 'Contents', 'Info.plist');
    const get = (k: string) => run('/usr/bin/plutil', ['-extract', k, 'raw', '-o', '-', plist]).then((s) => s.trim());
    return { id: await get('CFBundleIdentifier'), version: await get('CFBundleShortVersionString') };
  },
  now: () => Date.now(),
};

interface Persisted {
  lastChecked?: number | null;
  ready?: { version: string; app: string; notes: string[] } | null;
}

export class Updater {
  readonly cacheDir: string;
  readonly feedUrl: string;
  private d: UpdaterDeps;
  private s: UpdateState;
  private inflight: Promise<UpdateState> | null = null;
  private inflightManual = false;
  private timer: NodeJS.Timeout | null = null;

  private o: UpdaterOpts;

  constructor(o: UpdaterOpts) {
    this.o = o;
    const env = o.env ?? process.env;
    this.cacheDir = o.cacheDir ?? defaultCacheDir();
    this.feedUrl = env.LOOM_UPDATE_FEED?.trim() || o.feedUrl || FEED_URL;
    this.d = { ...defaultDeps, ...o.deps };
    const off = disabledReason({ packaged: o.packaged, app: o.app, env });
    const p = this.readPersisted();
    this.s = {
      status: off ? 'disabled' : 'idle',
      current: o.current,
      commit: o.commit ?? '',
      channel: o.channel ?? 'local',
      app: o.app,
      writable: o.app ? locationWritable(o.app) : false,
      auto: this.auto(),
      lastChecked: p.lastChecked ?? null,
      latest: null,
      progress: null,
      ready: null,
      detail: off,
      lastApply: this.readApplyResult(),
    };
    // A bundle verified by an earlier run is still good if it is newer and still there.
    if (!off && p.ready && compareVersions(p.ready.version, o.current) > 0 && fs.existsSync(p.ready.app)) {
      this.s.ready = p.ready;
      this.s.status = 'ready';
    }
  }

  get disabled(): boolean {
    return this.s.status === 'disabled';
  }

  private auto(): boolean {
    try {
      return this.o.auto ? this.o.auto() : true;
    } catch {
      return true;
    }
  }

  state(): UpdateState {
    return { ...this.s, auto: this.auto(), writable: this.s.app ? locationWritable(this.s.app) : false, lastApply: this.s.lastApply };
  }

  private set(patch: Partial<UpdateState>): void {
    this.s = { ...this.s, ...patch };
    this.o.onChange?.(this.state());
  }

  private get stateFile(): string {
    return path.join(this.cacheDir, 'state.json');
  }
  get resultFile(): string {
    return path.join(this.cacheDir, 'last-apply.json');
  }

  private readPersisted(): Persisted {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')) as Persisted;
    } catch {
      return {};
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ lastChecked: this.s.lastChecked, ready: this.s.ready } satisfies Persisted));
    } catch {
      /* a cache that cannot be written only costs a re-download */
    }
  }

  readApplyResult(): ApplyResult | null {
    try {
      const r = JSON.parse(fs.readFileSync(this.resultFile, 'utf8')) as ApplyResult;
      return typeof r.ok === 'boolean' ? r : null;
    } catch {
      return null;
    }
  }

  /** Check every CHECK_EVERY_MS, and once soon after launch. */
  start(firstDelayMs = 30_000): void {
    if (this.disabled || this.timer) return;
    const tick = () => {
      if (this.auto()) void this.check();
    };
    const first = setTimeout(tick, firstDelayMs);
    first.unref?.();
    this.timer = setInterval(tick, CHECK_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Fetch latest.json and, when it is newer, download and verify it. `manual` is
   * the Check for updates button: it reports a failure instead of staying quiet,
   * and downloads even with automatic updates off.
   */
  check(opts: { manual?: boolean } = {}): Promise<UpdateState> {
    if (this.disabled) return Promise.resolve(this.state());
    const manual = !!opts.manual;
    if (this.inflight) {
      // A click during a background check: that check may stop at "available,
      // automatic updates are off", so the click gets its own check after it.
      if (manual && !this.inflightManual) return this.inflight.then(() => this.check({ manual: true }));
      return this.inflight;
    }
    this.inflightManual = manual;
    this.inflight = this.doCheck(manual).finally(() => {
      this.inflight = null;
      this.inflightManual = false;
    });
    return this.inflight;
  }

  private async doCheck(manual: boolean): Promise<UpdateState> {
    const before = this.s.status;
    this.set({ status: 'checking', detail: null, progress: null });
    let latest: Latest;
    try {
      const parsed = parseLatest(await this.d.fetchJson(this.feedUrl), this.feedUrl);
      if (!parsed.ok) throw new Error(parsed.detail);
      latest = parsed.value;
    } catch (e) {
      // Offline, rate limited, GitHub down: a background check stays silent.
      this.set({ lastChecked: this.d.now() });
      this.persist();
      if (manual) this.set({ status: 'error', detail: `Could not check for updates: ${(e as Error).message}` });
      else this.set({ status: this.s.ready ? 'ready' : before === 'error' ? 'idle' : before === 'checking' ? 'idle' : before, detail: null });
      return this.state();
    }
    this.set({ lastChecked: this.d.now(), latest });
    this.persist();
    if (compareVersions(latest.version, this.o.current) <= 0) {
      this.set({ status: 'current', ready: null });
      this.persist();
      return this.state();
    }
    if (this.s.ready && this.s.ready.version === latest.version && fs.existsSync(this.s.ready.app)) {
      this.set({ status: 'ready' });
      return this.state();
    }
    if (!manual && !this.auto()) {
      this.set({ status: 'idle', detail: `Loom ${latest.version} is available. Automatic updates are off.` });
      return this.state();
    }
    try {
      const ready = await this.fetchAndVerify(latest);
      this.set({ status: 'ready', ready, detail: null });
      this.persist();
    } catch (e) {
      this.set({ status: 'error', detail: `Loom ${latest.version} was not installed: ${(e as Error).message}` });
    }
    return this.state();
  }

  /** Download, check, unpack and verify one release. Throws with a reason; leaves nothing half-done behind. */
  async fetchAndVerify(latest: Latest): Promise<{ version: string; app: string; notes: string[] }> {
    this.set({ status: 'downloading', progress: null });
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const zip = path.join(this.cacheDir, `Loom-${latest.version}.zip.part`);
    const dir = path.join(this.cacheDir, latest.version);
    const tmp = path.join(this.cacheDir, `${latest.version}.unpacking`);
    try {
      // A damaged download (cut short by sleep or a network change) is retried
      // once before it is reported; a release whose hash is wrong fails both.
      for (let attempt = 1; ; attempt++) {
        fs.rmSync(zip, { force: true });
        this.set({ status: 'downloading', progress: null });
        try {
          // One push per whole percent, not one per chunk.
          await this.d.download(latest.zip, zip, (got, total) => {
            const pct = total > 0 ? Math.min(100, Math.floor((got / total) * 100)) : null;
            if (pct !== this.s.progress) this.set({ progress: pct });
          });
          this.set({ status: 'verifying', progress: null });
          const sum = await this.d.sha256File(zip);
          if (sum.toLowerCase() !== latest.sha256) throw new Error(`the download's sha256 is ${sum}, the release says ${latest.sha256}`);
          break;
        } catch (e) {
          if (attempt >= DOWNLOAD_TRIES) throw new Error(`${(e as Error).message} (after ${DOWNLOAD_TRIES} tries)`);
        }
      }
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.mkdirSync(tmp, { recursive: true });
      await this.d.extract(zip, tmp);
      const app = path.join(tmp, 'Loom.app');
      if (!fs.existsSync(path.join(app, 'Contents', 'Info.plist'))) throw new Error('the zip has no Loom.app');
      try {
        await this.d.verifySignature(app);
      } catch (e) {
        throw new Error(`the downloaded app does not pass codesign --verify (${(e as Error).message})`);
      }
      const b = await this.d.readBundle(app);
      if (b.id !== BUNDLE_ID) throw new Error(`the downloaded app is ${b.id}, not ${BUNDLE_ID}`);
      if (b.version !== latest.version) throw new Error(`the downloaded app is version ${b.version}, the release says ${latest.version}`);
      fs.rmSync(dir, { recursive: true, force: true });
      fs.renameSync(tmp, dir);
      this.prune(latest.version);
      return { version: latest.version, app: path.join(dir, 'Loom.app'), notes: latest.notes };
    } finally {
      fs.rmSync(zip, { force: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  /** Drop every unpacked release but `keep`. */
  private prune(keep: string): void {
    try {
      for (const e of fs.readdirSync(this.cacheDir, { withFileTypes: true })) {
        if (e.isDirectory() && e.name !== keep && parseVersion(e.name)) fs.rmSync(path.join(this.cacheDir, e.name), { recursive: true, force: true });
      }
    } catch {
      /* best effort */
    }
  }

  /**
   * Hand the ready bundle to the apply script, which waits for `pid` to exit.
   * The caller quits the app right after. Returns why it could not, instead.
   */
  apply(o: { pid: number; relaunch: boolean; loomHome: string; spawnScript?: (script: string, env: NodeJS.ProcessEnv) => void }): { ok: true } | { ok: false; detail: string } {
    const r = this.s.ready;
    if (!r || !this.s.app) return { ok: false, detail: 'No update is ready.' };
    if (!fs.existsSync(r.app)) {
      this.set({ status: 'idle', ready: null });
      this.persist();
      return { ok: false, detail: 'The downloaded update is gone. Check for updates again.' };
    }
    if (!locationWritable(this.s.app)) {
      const detail = `Loom cannot replace itself in ${path.dirname(this.s.app)}: that folder is not writable. Move Loom to Applications or ~/Applications, or install ${r.version} by hand.`;
      this.set({ status: 'error', detail });
      return { ok: false, detail };
    }
    fs.mkdirSync(this.cacheDir, { recursive: true });
    const script = path.join(this.cacheDir, 'apply-update.sh');
    fs.writeFileSync(script, APPLY_SCRIPT, { mode: 0o755 });
    fs.rmSync(this.resultFile, { force: true });
    const env: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      HOME: os.homedir(),
      LOOM_PID: String(o.pid),
      LOOM_DEST: this.s.app,
      LOOM_NEW: r.app,
      LOOM_FROM: this.o.current,
      LOOM_TO: r.version,
      LOOM_RELAUNCH: o.relaunch ? '1' : '0',
      LOOM_HOME: o.loomHome,
      LOOM_RESULT: this.resultFile,
      LOOM_LOCK: path.join(this.cacheDir, 'swap.lock'),
      LOOM_LOG: path.join(this.cacheDir, 'apply.log'),
    };
    (o.spawnScript ?? spawnDetached)(script, env);
    this.set({ status: 'applying' });
    return { ok: true };
  }
}

function spawnDetached(script: string, env: NodeJS.ProcessEnv): void {
  const child = spawn('/bin/bash', [script], { detached: true, stdio: 'ignore', env });
  child.unref();
}

/* ------------------------------------------------------------ the apply script */

// Runs detached from Loom, so it outlives the quit. Inputs come in the
// environment (no quoting through argv). Everything it does is appended to
// $LOOM_LOG and the outcome is written to $LOOM_RESULT, which the next Loom reads.
//
// The order is the install-app.sh order (see its header, the 2026-11-06 crash):
// copy the new bundle next to the old one first, while Loom is still quitting;
// wait for the old process to be gone; then swap with two renames, so there is
// never a moment with no Loom.app or a half-written one. The old bundle is only
// deleted once the new one has started and answers /api/whoami (or, on a quit
// with no relaunch, passes codesign --verify in place); otherwise it is renamed
// back. $LOOM_LOCK is shared with install-app.sh, so the two never swap at once,
// and a bundle someone else replaced in the meantime is left alone.
export const APPLY_SCRIPT = `#!/bin/bash
set -u
LOG="\${LOOM_LOG:-/dev/null}"
log() { echo "$(date '+%Y-%m-%dT%H:%M:%S') $*" >> "$LOG"; }
esc() { printf '%s' "$1" | sed 's/\\\\/\\\\\\\\/g; s/"/\\\\"/g'; }
result() { # ok detail
  printf '{"ok":%s,"from":"%s","to":"%s","at":%s,"detail":"%s"}\\n' "$1" "$(esc "$LOOM_FROM")" "$(esc "$LOOM_TO")" "$(date +%s)000" "$(esc "$2")" > "$LOOM_RESULT.tmp" && mv "$LOOM_RESULT.tmp" "$LOOM_RESULT"
  log "result ok=$1 $2"
}
DEST="$LOOM_DEST"; NEW="$LOOM_NEW"; EXE="$DEST/Contents/MacOS/Loom"
OPEN="\${LOOM_OPEN_CMD:-open}"; UP_TIMEOUT="\${LOOM_UP_TIMEOUT:-90}"
STAGE="$DEST.incoming.$$"; OLD="$DEST.previous.$$"; FAILED="$DEST.failed.$$"
LOCKED=0
finish() { rm -rf "$STAGE"; [ "$LOCKED" = 1 ] && rmdir "$LOOM_LOCK" 2>/dev/null; }
trap finish EXIT
version_of() { /usr/bin/plutil -extract CFBundleShortVersionString raw -o - "$1/Contents/Info.plist" 2>/dev/null; }
loom_port() {
  local f="$LOOM_HOME/server.json" p pid
  if [ -r "$f" ]; then
    p=$(sed -n 's/.*"port"[^0-9]*\\([0-9][0-9]*\\).*/\\1/p' "$f" | head -1)
    pid=$(sed -n 's/.*"pid"[^0-9]*\\([0-9][0-9]*\\).*/\\1/p' "$f" | head -1)
    if [ -n "$p" ] && [ -n "$pid" ] && [ "$pid" != "$LOOM_PID" ] && kill -0 "$pid" 2>/dev/null; then echo "$p"; return; fi
  fi
  echo ""
}
answers() { # the new Loom is up when it serves /api/whoami as loom
  local port; port=$(loom_port); [ -n "$port" ] || return 1
  curl -s -m 2 "http://127.0.0.1:$port/api/whoami" 2>/dev/null | grep -q '"app":"loom"'
}
stop_new() {
  pgrep -xf "$EXE" > /dev/null 2>&1 || return 0
  osascript -e 'tell application id "com.loom.app" to quit' > /dev/null 2>&1 || true
  for _ in $(seq 1 50); do pgrep -xf "$EXE" > /dev/null 2>&1 || return 0; sleep 0.2; done
  pkill -TERM -xf "$EXE" 2>/dev/null || true
  sleep 1
}
rollback() { # detail
  log "rolling back: $1"
  stop_new
  if [ -d "$OLD" ]; then
    if [ -e "$DEST" ]; then mv "$DEST" "$FAILED" || { result false "$1; rollback could not move the new bundle aside"; exit 1; }; fi
    mv "$OLD" "$DEST" || { result false "$1; rollback failed, the previous Loom is at $OLD"; exit 1; }
    rm -rf "$FAILED"
  fi
  [ "$LOOM_RELAUNCH" = 1 ] && $OPEN "$DEST"
  result false "$1. Rolled back to $LOOM_FROM."
  exit 1
}

log "apply $LOOM_FROM -> $LOOM_TO into $DEST (relaunch=$LOOM_RELAUNCH)"
[ -d "$NEW/Contents" ] || { result false "the downloaded update is missing"; exit 1; }
# The slow part first, while Loom is still quitting: a copy beside the old bundle,
# on the same volume, so the swap below is two renames.
rm -rf "$STAGE"
/usr/bin/ditto "$NEW" "$STAGE" || { result false "could not copy the update next to $DEST"; exit 1; }
xattr -dr com.apple.quarantine "$STAGE" 2>/dev/null || true

for _ in $(seq 1 300); do kill -0 "$LOOM_PID" 2>/dev/null || break; sleep 0.2; done
if kill -0 "$LOOM_PID" 2>/dev/null; then result false "Loom did not quit within 60s; nothing was changed"; exit 1; fi
sleep 0.3

# One swap at a time (install-app.sh takes the same lock). A stale lock is a crash.
if ! mkdir "$LOOM_LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOOM_LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then rmdir "$LOOM_LOCK" 2>/dev/null; mkdir "$LOOM_LOCK" 2>/dev/null || { result false "another install is running; nothing was changed"; exit 1; }
  else result false "another install is running; nothing was changed"; exit 1; fi
fi
LOCKED=1
have="$(version_of "$DEST")"
if [ -e "$DEST" ] && [ "$have" != "$LOOM_FROM" ]; then result false "$DEST is now version \${have:-unknown}, not $LOOM_FROM; left it alone"; exit 1; fi
if pgrep -xf "$EXE" > /dev/null 2>&1; then result false "Loom was started again before the swap; nothing was changed"; exit 1; fi

if [ -e "$DEST" ]; then mv "$DEST" "$OLD" || { result false "could not move $DEST aside; nothing was changed"; exit 1; }; fi
if ! mv "$STAGE" "$DEST"; then
  [ -d "$OLD" ] && mv "$OLD" "$DEST"
  result false "could not move the update into place. Rolled back to $LOOM_FROM."
  exit 1
fi
log "swapped"

if [ "$LOOM_RELAUNCH" = 1 ]; then
  $OPEN "$DEST" || rollback "macOS would not open the new Loom"
  up=0
  for _ in $(seq 1 "$UP_TIMEOUT"); do if answers; then up=1; break; fi; sleep 1; done
  [ "$up" = 1 ] || rollback "the new Loom did not answer within \${UP_TIMEOUT}s"
else
  /usr/bin/codesign --verify --deep --strict "$DEST" 2> /dev/null || rollback "the installed update does not pass codesign --verify"
fi
rm -rf "$OLD"
result true "Updated to $LOOM_TO."
exit 0
`;
