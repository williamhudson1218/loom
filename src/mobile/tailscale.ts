import fs from 'node:fs';
import { execFile } from 'node:child_process';

// Phone access is `tailscale serve`: HTTPS on 443 with the tailnet's own cert,
// proxied to Loom's 127.0.0.1 listener. Loom never binds anything else. Never
// Funnel: the URL resolves only inside the tailnet.
//
// Every path degrades to a state + detail; nothing here throws. The command
// runner is injected so tests never run the real CLI.

export type PhoneState = 'off' | 'on' | 'no-tailscale' | 'logged-out' | 'error';

export interface PhoneAccess {
  on: boolean;
  state: PhoneState;
  url?: string;
  detail?: string;
  /** A login.tailscale.com link Tailscale printed when Serve needs approving for the tailnet. */
  approveUrl?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface TailscaleDeps {
  run(bin: string, args: string[]): Promise<RunResult>;
  exists(file: string): boolean;
}

export const CLI_CANDIDATES = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

export const realTailscaleDeps: TailscaleDeps = {
  run: (bin, args) =>
    new Promise((resolve) => {
      execFile(bin, args, { timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as unknown as { code: number }).code) : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') || (err ? err.message : '') });
      });
    }),
  exists: (f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  },
};

export function findCli(deps: TailscaleDeps): string | null {
  return CLI_CANDIDATES.find((f) => deps.exists(f)) ?? null;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$/;

export type StatusResult = { ok: true; cli: string; host: string } | { ok: false; state: Exclude<PhoneState, 'on' | 'off'>; detail: string };

/** Is Tailscale here, signed in, and what is this Mac's tailnet name? */
export async function tailscaleStatus(deps: TailscaleDeps = realTailscaleDeps): Promise<StatusResult> {
  const cli = findCli(deps);
  if (!cli) return { ok: false, state: 'no-tailscale', detail: 'Tailscale is not installed on this Mac' };
  const r = await deps.run(cli, ['status', '--json']);
  let j: { BackendState?: string; Self?: { DNSName?: string } } | null = null;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    /* not json */
  }
  if (!j) return { ok: false, state: 'error', detail: oneLine(r.stderr) || 'tailscale status failed' };
  if (j.BackendState && j.BackendState !== 'Running') {
    return { ok: false, state: 'logged-out', detail: j.BackendState === 'NeedsLogin' ? 'Tailscale is not signed in' : `Tailscale is ${j.BackendState}` };
  }
  const host = (j.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  if (!HOST_RE.test(host)) return { ok: false, state: 'error', detail: 'Tailscale has no MagicDNS name for this Mac (turn on MagicDNS and HTTPS certificates)' };
  return { ok: true, cli, host };
}

/** The approval link in `tailscale serve` output (e.g. "Serve is not enabled on your tailnet. To enable, visit: https://login.tailscale.com/f/serve?node=..."). */
export function extractApprovalUrl(text: string): string | undefined {
  const m = /https:\/\/login\.tailscale\.com\/[^\s"'<>)]+/.exec(text);
  return m ? m[0].replace(/[.,;]+$/, '') : undefined;
}

export type IphoneState = 'none' | 'offline' | 'online';

export interface TailscaleSetup {
  tailscaleInstalled: boolean;
  signedIn: boolean;
  magicDns: boolean;
  httpsCerts: boolean;
  iphone: IphoneState;
}

/** One `tailscale status --json`, read for the setup checklist. Pure. */
export function parseSetup(statusJson: string): Omit<TailscaleSetup, 'tailscaleInstalled'> {
  const none = { signedIn: false, magicDns: false, httpsCerts: false, iphone: 'none' as IphoneState };
  let j: { BackendState?: string; Self?: { DNSName?: string }; CertDomains?: unknown; Peer?: Record<string, { OS?: string; Online?: boolean }> } | null = null;
  try {
    j = JSON.parse(statusJson);
  } catch {
    return none;
  }
  if (!j || typeof j !== 'object') return none;
  const host = (j.Self?.DNSName ?? '').replace(/\.$/, '').toLowerCase();
  const peers = j.Peer && typeof j.Peer === 'object' ? Object.values(j.Peer).filter((p) => p && String(p.OS ?? '').toLowerCase() === 'ios') : [];
  return {
    signedIn: j.BackendState === 'Running',
    magicDns: HOST_RE.test(host),
    httpsCerts: Array.isArray(j.CertDomains) && j.CertDomains.length > 0,
    iphone: peers.length === 0 ? 'none' : peers.some((p) => p.Online === true) ? 'online' : 'offline',
  };
}

let setupDeps: TailscaleDeps = realTailscaleDeps;
let setupCache: { at: number; deps: TailscaleDeps; v: TailscaleSetup } | null = null;

/** Tests: point the setup read at a fake CLI and forget the cache. */
export function setTailscaleSetupDeps(d: TailscaleDeps | null): void {
  setupDeps = d ?? realTailscaleDeps;
  setupCache = null;
}

/** Setup checklist facts. Cached 4 s: the Devices pane polls every 2 s. Never throws. */
export async function tailscaleSetup(deps: TailscaleDeps = setupDeps): Promise<TailscaleSetup> {
  if (setupCache && setupCache.deps === deps && Date.now() - setupCache.at < 4000) return setupCache.v;
  const cli = findCli(deps);
  let v: TailscaleSetup;
  if (!cli) v = { tailscaleInstalled: false, signedIn: false, magicDns: false, httpsCerts: false, iphone: 'none' };
  else {
    const r = await deps.run(cli, ['status', '--json']).catch(() => ({ code: 1, stdout: '', stderr: '' }));
    v = { tailscaleInstalled: true, ...parseSetup(r.stdout) };
  }
  setupCache = { at: Date.now(), deps, v };
  return v;
}

const oneLine = (s: string): string => s.trim().split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) ?? '';

export interface ApplyResult {
  access: PhoneAccess;
  /** The tailnet name, when Tailscale told us one. */
  host?: string;
}

/** Turn serve on for `port`, or off. */
export async function applyServe(on: boolean, port: number, deps: TailscaleDeps = realTailscaleDeps): Promise<ApplyResult> {
  const s = await tailscaleStatus(deps);
  if (!s.ok) return { access: { on, state: on ? s.state : 'off', detail: s.detail } };
  const url = `https://${s.host}/m/`;
  if (!on) {
    const r = await deps.run(s.cli, ['serve', '--https=443', 'off']);
    // "off" on a port with nothing served is fine: it is off either way.
    if (r.code !== 0 && !/not found|no serve config|nothing to/i.test(r.stderr + r.stdout)) {
      return { access: { on: false, state: 'error', detail: oneLine(r.stderr) || 'tailscale serve off failed' }, host: s.host };
    }
    return { access: { on: false, state: 'off', url }, host: s.host };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { access: { on, state: 'error', detail: 'bad port' } };
  const r = await deps.run(s.cli, ['serve', '--bg', '--https=443', `http://127.0.0.1:${port}`]);
  if (r.code !== 0) {
    const approveUrl = extractApprovalUrl(r.stderr + '\n' + r.stdout);
    return { access: { on, state: 'error', detail: oneLine(r.stderr) || 'tailscale serve failed', ...(approveUrl ? { approveUrl } : {}) }, host: s.host };
  }
  return { access: { on: true, state: 'on', url }, host: s.host };
}

/** The ports a Loom on this Mac may serve on. */
type PortSet = readonly number[];

/**
 * Does `serve status --json` show 443 proxying only to Loom (http://127.0.0.1:<a Loom port>)?
 * Any other handler on 443, or anything unparseable, is someone else's config: false.
 */
export function serveIsLoomOnly(statusJson: string, ports: PortSet): boolean {
  let j: { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> } | null = null;
  try {
    j = JSON.parse(statusJson);
  } catch {
    return false;
  }
  const web = j?.Web && typeof j.Web === 'object' ? j.Web : {};
  const on443 = Object.entries(web).filter(([hostPort]) => hostPort.endsWith(':443'));
  if (!on443.length) return false;
  const handlers = on443.flatMap(([, v]) => Object.values(v?.Handlers ?? {}));
  if (!handlers.length) return false;
  return handlers.every((h) => {
    const m = /^http:\/\/127\.0\.0\.1:(\d+)\/?$/.exec(h?.Proxy ?? '');
    return !!m && ports.includes(Number(m[1]));
  });
}

/** Startup with Phone access off: a serve on 443 left behind by Loom is turned off; any other config is left alone. */
export async function clearLeftoverServe(ports: PortSet, deps: TailscaleDeps = realTailscaleDeps): Promise<boolean> {
  const cli = findCli(deps);
  if (!cli) return false;
  const st = await deps.run(cli, ['serve', 'status', '--json']);
  if (st.code !== 0 || !serveIsLoomOnly(st.stdout, ports)) return false;
  const r = await deps.run(cli, ['serve', '--https=443', 'off']);
  return r.code === 0;
}
