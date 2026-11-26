import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { applyServe, extractApprovalUrl, parseSetup, tailscaleSetup, type TailscaleDeps } from '../src/mobile/tailscale.ts';
import { DEVICES_VIEW_CSS, DEVICES_VIEW_JS } from '../src/devicesview.ts';

const HOST = 'example-mac.tail0000.ts.net.';
const full = {
  BackendState: 'Running',
  Self: { DNSName: HOST },
  CertDomains: ['example-mac.tail0000.ts.net'],
  Peer: { a: { OS: 'macOS', Online: true }, b: { OS: 'iOS', Online: true } },
};

describe('parseSetup', () => {
  it('reads every flag from one status', () => {
    expect(parseSetup(JSON.stringify(full))).toEqual({ signedIn: true, magicDns: true, httpsCerts: true, iphone: 'online' });
  });
  it('needs login', () => {
    expect(parseSetup(JSON.stringify({ BackendState: 'NeedsLogin' }))).toEqual({ signedIn: false, magicDns: false, httpsCerts: false, iphone: 'none' });
  });
  it('magic dns without https certs', () => {
    const r = parseSetup(JSON.stringify({ ...full, CertDomains: [] }));
    expect(r).toMatchObject({ magicDns: true, httpsCerts: false });
    expect(parseSetup(JSON.stringify({ ...full, CertDomains: undefined })).httpsCerts).toBe(false);
  });
  it('no ts.net name means no magic dns', () => {
    expect(parseSetup(JSON.stringify({ ...full, Self: { DNSName: 'example-mac.' } })).magicDns).toBe(false);
  });
  it('iphone none, offline, online', () => {
    expect(parseSetup(JSON.stringify({ ...full, Peer: { a: { OS: 'macOS', Online: true } } })).iphone).toBe('none');
    expect(parseSetup(JSON.stringify({ ...full, Peer: { b: { OS: 'iOS', Online: false } } })).iphone).toBe('offline');
    expect(parseSetup(JSON.stringify({ ...full, Peer: { b: { OS: 'iOS', Online: false }, c: { OS: 'iOS', Online: true } } })).iphone).toBe('online');
    expect(parseSetup(JSON.stringify({ ...full, Peer: null })).iphone).toBe('none');
  });
  it('garbage is all false', () => {
    expect(parseSetup('nope')).toEqual({ signedIn: false, magicDns: false, httpsCerts: false, iphone: 'none' });
  });
});

describe('tailscaleSetup', () => {
  const mk = (exists: boolean, out: string) => {
    let runs = 0;
    const deps: TailscaleDeps = { exists: () => exists, run: async () => (runs++, { code: 0, stdout: out, stderr: '' }) };
    return { deps, runs: () => runs };
  };
  it('not installed', async () => {
    expect(await tailscaleSetup(mk(false, '').deps)).toMatchObject({ tailscaleInstalled: false, signedIn: false });
  });
  it('uses one status call and caches it', async () => {
    const f = mk(true, JSON.stringify(full));
    expect(await tailscaleSetup(f.deps)).toMatchObject({ tailscaleInstalled: true, signedIn: true, iphone: 'online' });
    await tailscaleSetup(f.deps);
    expect(f.runs()).toBe(1);
  });
});

describe('serve approval url', () => {
  const msg = 'Serve is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=n123abc\n';
  it('extracts it', () => {
    expect(extractApprovalUrl(msg)).toBe('https://login.tailscale.com/f/serve?node=n123abc');
    expect(extractApprovalUrl('permission denied')).toBeUndefined();
    expect(extractApprovalUrl('visit https://example.com/x')).toBeUndefined();
  });
  it('applyServe surfaces it', async () => {
    const deps: TailscaleDeps = {
      exists: () => true,
      run: async (_b, args) => (args[0] === 'status' ? { code: 0, stdout: JSON.stringify(full), stderr: '' } : { code: 1, stdout: '', stderr: msg }),
    };
    const r = await applyServe(true, 4317, deps);
    expect(r.access).toMatchObject({ state: 'error', approveUrl: 'https://login.tailscale.com/f/serve?node=n123abc' });
  });
});

describe('devices view checklist script', () => {
  it('has no backslash, backtick or dollar-brace, and parses', () => {
    for (const s of [DEVICES_VIEW_JS, DEVICES_VIEW_CSS]) {
      expect(s).not.toContain('\\');
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
    }
    expect(() => new vm.Script(DEVICES_VIEW_JS)).not.toThrow();
    expect(DEVICES_VIEW_JS).toContain('Set up your phone');
  });

  // Run the real script with stub helpers and check the rendered steps.
  const render = (d: unknown): string => {
    const ctx: Record<string, unknown> = {
      sxEsc: (x: unknown) => String(x),
      sxGrp: (t: string) => `<h>${t}</h>`,
      sxBtn: (a: string, l: string) => `[${a}:${l}]`,
      sxNote: (t: string) => t,
      sxRow: () => '',
      sxPill: () => '',
      sxRerender: () => {},
      sxJ: () => Promise.resolve(null),
      window: {},
      document: {},
    };
    vm.createContext(ctx);
    vm.runInContext(DEVICES_VIEW_JS, ctx);
    vm.runInContext('DEV.d = ' + JSON.stringify(d) + ';', ctx);
    return vm.runInContext('devChecklist(DEV.d)', ctx) as string;
  };
  const base = { phoneAccess: { state: 'off' }, pending: [], devices: [] };
  const setup = { tailscaleInstalled: true, signedIn: true, magicDns: true, httpsCerts: false, iphone: 'none', phoneAccess: false, paired: false, notifications: false };

  it('expands only the first undone step', () => {
    const h = render({ ...base, setup });
    expect(h).toContain('Enable HTTPS');
    expect(h).toContain('href="https://login.tailscale.com/admin/dns"');
    expect(h).not.toContain('Add to Home Screen');
  });
  it('shows an approval link from the serve detail', () => {
    const h = render({ ...base, phoneAccess: { state: 'error', detail: 'To enable, visit: https://login.tailscale.com/f/serve?node=n1' }, setup: { ...setup, httpsCerts: true, iphone: 'online' } });
    expect(h).toContain('href="https://login.tailscale.com/f/serve?node=n1"');
  });
  it('collapses to one line when everything is done', () => {
    const h = render({ ...base, setup: { ...setup, httpsCerts: true, iphone: 'online', phoneAccess: true, paired: true, notifications: true } });
    expect(h).toContain('Phone set up ✓');
    expect(h).not.toContain('class="devstep ');
  });
});
