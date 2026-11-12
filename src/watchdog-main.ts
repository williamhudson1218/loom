// The watchdog process (see src/watchdog.ts for what it is for). Loom starts it
// detached, as dist/watchdog.js under its own binary with ELECTRON_RUN_AS_NODE=1:
//
//   watchdog.js --pid <loom main pid> --port <server port> --home <LOOM_HOME> [--app <Loom.app>]
//
// It exits when Loom's pid is gone (a quit, a crash, an update), when Loom sends
// it SIGTERM (before-quit), or when a newer watchdog has taken the pid file.
import {
  WATCH,
  appendLog,
  clearPidFile,
  initialState,
  killAndRelaunch,
  mayRestart,
  noteRestart,
  readPidFile,
  readRestarts,
  realActDeps,
  reportPath,
  sampleInto,
  step,
  writeNotice,
  writePidFile,
} from './watchdog.ts';

function arg(name: string): string {
  const i = process.argv.indexOf('--' + name);
  return i > 0 ? (process.argv[i + 1] ?? '') : '';
}

const loomPid = Number(arg('pid'));
const port = Number(arg('port'));
const home = arg('home');
const app = arg('app') || null;
if (!loomPid || !port || !home) {
  console.error('usage: watchdog.js --pid <pid> --port <port> --home <dir> [--app <bundle>]');
  process.exit(2);
}

const deps = realActDeps();
const log = (level: 'info' | 'error', msg: string) => appendLog(home, level, '[loom-watchdog] ' + msg);

async function healthy(): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(WATCH.pingTimeoutMs) });
    if (!r.ok) return false;
    const j = (await r.json()) as { ok?: boolean; pid?: number };
    return j.ok === true && j.pid === loomPid;
  } catch {
    return false;
  }
}

function bye(code = 0): never {
  clearPidFile(home, process.pid);
  process.exit(code);
}

process.on('SIGTERM', () => bye(0));
process.on('SIGINT', () => bye(0));
process.on('SIGHUP', () => {}); // the launching terminal closing is not a reason to stop

// Which process loomPid is: its start time. Checked again before anything is
// sampled or killed, so a recycled pid (Loom gone, another process given its
// number) is never touched.
async function startedAt(pid: number): Promise<string> {
  const { execFile } = await import('node:child_process');
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5_000, encoding: 'utf-8' }, (err, out) => resolve(err ? '' : out.trim()));
  });
}
let identity = '';

writePidFile(home, { pid: process.pid, loomPid });
log('info', `watching pid ${loomPid} on port ${port}`);

let state = initialState(Date.now());
let acting = false;

async function onFrozen(frozenMs: number): Promise<void> {
  const now = Date.now();
  if (!identity || (await startedAt(loomPid)) !== identity) {
    log('info', `pid ${loomPid} is no longer the Loom this watchdog started for; exiting`);
    return bye(0);
  }
  const report = reportPath(home, now);
  log('error', `pid ${loomPid} has not answered /api/health for ${Math.round(frozenMs / 1000)}s; sampling its main thread to ${report}`);
  await sampleInto(loomPid, report, deps);
  if (!deps.alive(loomPid)) return bye(0); // quit or crashed while it was sampled
  if (await healthy()) {
    log('info', `pid ${loomPid} answered again during the sample; leaving it running (report kept)`);
    state = initialState(Date.now());
    return;
  }
  if (!mayRestart(readRestarts(home), Date.now())) {
    log('error', `already restarted Loom ${WATCH.restartCap} times in ${WATCH.restartWindowMs / 60_000} min; leaving it frozen (chat-manager restart forces one)`);
    state = initialState(Date.now());
    return;
  }
  writeNotice(home, { at: Date.now(), frozenMs: Date.now() - state.lastOk, report, by: 'watchdog' });
  noteRestart(home, Date.now());
  log('error', `killing pid ${loomPid} and opening Loom again`);
  const r = await killAndRelaunch(loomPid, app, deps);
  log(r.ok ? 'info' : 'error', `restart: ${r.detail}`);
  bye(r.ok ? 0 : 1);
}

async function tick(): Promise<void> {
  if (acting) return;
  if (!deps.alive(loomPid)) {
    log('info', `pid ${loomPid} is gone; exiting`);
    return bye(0);
  }
  const mine = readPidFile(home);
  if (mine && mine.pid !== process.pid) return bye(0); // a newer watchdog took over
  const ok = await healthy();
  const r = step(state, Date.now(), ok);
  state = r.state;
  if (r.verdict === 'slept') log('info', 'a long gap between pings (sleep/wake); counting from now');
  if (r.verdict !== 'frozen') return;
  acting = true;
  try {
    await onFrozen(r.frozenMs);
  } finally {
    acting = false;
  }
}

void startedAt(loomPid).then((s) => {
  identity = s;
  if (!s) {
    log('error', `could not read pid ${loomPid}'s start time; exiting`);
    bye(1);
  }
  setInterval(() => void tick(), WATCH.intervalMs);
});
