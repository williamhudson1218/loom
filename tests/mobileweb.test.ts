import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import { mobileFile, MOBILE_HTML, MOBILE_SW } from '../src/mobile/web.ts';
import { APP_JS } from '../src/mobile/webapp.ts';
import { APP_CSS } from '../src/mobile/webcss.ts';
import { QR_JS } from '../src/vendor/qrcode.ts';
import { DEVICES_VIEW_CSS, DEVICES_VIEW_JS } from '../src/devicesview.ts';
import { SETTINGS_VIEW_CSS, SETTINGS_VIEW_JS } from '../src/settingsview.ts';

const PATHS: Record<string, string> = {
  '/m/': 'text/html',
  '/m/app.js': 'text/javascript',
  '/m/app.css': 'text/css',
  '/m/manifest.webmanifest': 'application/manifest+json',
  '/m/sw.js': 'text/javascript',
  '/m/icon-180.png': 'image/png',
  '/m/icon-192.png': 'image/png',
  '/m/icon-512.png': 'image/png',
};

describe('mobileFile', () => {
  it('serves every path with the right content type', () => {
    for (const [p, type] of Object.entries(PATHS)) {
      const f = mobileFile(p);
      expect(f, p).not.toBeNull();
      expect(f!.type.startsWith(type), p).toBe(true);
      expect(f!.body.length, p).toBeGreaterThan(20);
    }
  });

  it('returns null for everything else', () => {
    for (const p of ['/m', '/', '/m/api/me', '/m/index.html', '/m/nope.js', '/api/data', '/m/../etc/passwd', '/m/app.js/', '']) {
      expect(mobileFile(p), p).toBeNull();
    }
  });

  it('serves PNG icons of the right size', () => {
    for (const n of [180, 192, 512]) {
      const b = mobileFile(`/m/icon-${n}.png`)!.body as Buffer;
      expect(Buffer.isBuffer(b)).toBe(true);
      expect(b.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(b.readUInt32BE(16)).toBe(n);
      expect(b.readUInt32BE(20)).toBe(n);
    }
  });

  it('has a valid manifest scoped to /m/', () => {
    const m = JSON.parse(String(mobileFile('/m/manifest.webmanifest')!.body));
    expect(m.scope).toBe('/m/');
    expect(m.start_url).toBe('/m/');
    expect(m.display).toBe('standalone');
    expect(m.name).toBe('Loom');
    for (const i of m.icons) expect(i.src.startsWith('/m/')).toBe(true);
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toContain('512x512');
  });
});

describe('index html under the CSP', () => {
  it('references only /m/ assets and has no inline script or handler', () => {
    const refs = [...MOBILE_HTML.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(3);
    for (const r of refs) expect(r.startsWith('/m/'), r).toBe(true);
    for (const r of refs) expect(mobileFile(r.split('#')[0]), r).not.toBeNull();
    const scripts = [...MOBILE_HTML.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBe(1);
    expect(scripts[0][1]).toContain('src="/m/app.js"');
    expect(scripts[0][2].trim()).toBe('');
    expect(MOBILE_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(MOBILE_HTML).not.toMatch(/javascript:/i);
    expect(MOBILE_HTML).toContain('viewport-fit=cover');
    expect(MOBILE_HTML).toContain('apple-mobile-web-app-capable');
    expect(MOBILE_HTML).toContain('apple-touch-icon');
  });

  it('app.js and sw.js parse, and the page script never reaches outside /m/', () => {
    expect(() => new vm.Script(APP_JS)).not.toThrow();
    expect(() => new vm.Script(MOBILE_SW)).not.toThrow();
    // It talks only to its own origin.
    expect(APP_JS).not.toMatch(/https?:\/\//);
    expect(APP_JS).not.toMatch(/\beval\s*\(|new Function|document\.write/);
    // innerHTML is used once, for its own static icon strings.
    expect([...APP_JS.matchAll(/innerHTML/g)].length).toBe(1);
    // Every request goes to /m/ paths.
    for (const m of APP_JS.matchAll(/api\('([^']+)'/g)) expect(m[1].startsWith('/m/api/'), m[1]).toBe(true);
    expect(APP_CSS).not.toMatch(/url\(\s*['"]?https?:/);
  });

  it('the service worker never caches the API', () => {
    expect(MOBILE_SW).toContain("indexOf('/m/api/') === 0) return");
    expect(MOBILE_SW).toContain("addEventListener('push'");
    expect(MOBILE_SW).toContain("addEventListener('notificationclick'");
  });

  it('carries no personal data', () => {
    for (const s of [MOBILE_HTML, APP_JS, APP_CSS, MOBILE_SW, DEVICES_VIEW_JS]) {
      expect(s).not.toMatch(/\/Users\/|willhudson|@gmail|xox[bpa]-|Tax Pilot/i);
    }
  });
});

describe('page scripts are safe to splice', () => {
  it('app.js and css are safe inside a template string', () => {
    for (const s of [APP_JS, APP_CSS]) {
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
    }
  });

  it('the devices view has no backslash, backtick or dollar-brace, and parses', () => {
    for (const s of [QR_JS, DEVICES_VIEW_JS, DEVICES_VIEW_CSS]) {
      expect(s).not.toContain('\\');
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
    }
    expect(() => new vm.Script(QR_JS)).not.toThrow();
    expect(() => new vm.Script(SETTINGS_VIEW_JS.split('__SX_KEYMAP__').join('[]'))).not.toThrow();
  });

  it('is wired into Settings', () => {
    expect(SETTINGS_VIEW_JS).toContain("{id:'devices',label:'Devices'");
    expect(SETTINGS_VIEW_JS).toContain("if(id==='devices')return sxDevices();");
    expect(SETTINGS_VIEW_JS).toContain("a.indexOf('dev_')===0");
    expect(SETTINGS_VIEW_CSS).toContain('.devpair');
    for (const p of ['/api/devices', '/api/devices/phone-access', '/api/devices/pair-start', '/api/devices/revoke', "'approve'", "'deny'"]) {
      expect(DEVICES_VIEW_JS).toContain(p);
    }
  });
});

// ---- QR encoder -----------------------------------------------------------------------

type Qr = { size: number; rows: boolean[][]; mask: number; version: number };
const sandbox: { loomQr?: (t: string, mask?: number) => Qr; loomQrSvg?: (t: string, px?: number) => string; loomQrInternals?: any } = {};
vm.createContext(sandbox);
vm.runInContext(QR_JS, sandbox);
const qr = (t: string, mask?: number) => sandbox.loomQr!(t, mask);
const I = sandbox.loomQrInternals!;

// An independent reader, written from the spec: where the function modules are, the
// format word, the zigzag, and a Reed-Solomon syndrome check.
const EXP: number[] = [];
const LOG: number[] = [];
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 0x11d;
  }
}
const mul = (a: number, b: number) => (a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0);
const ALIGN: Record<number, number[]> = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const ECC_M = [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const BLOCKS_M = [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

function functionMask(v: number): boolean[][] {
  const n = v * 4 + 17;
  const f = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const box = (x0: number, y0: number, w: number, h: number) => {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) if (y >= 0 && y < n && x >= 0 && x < n) f[y][x] = true;
  };
  box(0, 0, 9, 9); // finder + separator + format
  box(n - 8, 0, 8, 9);
  box(0, n - 8, 9, 8);
  box(6, 0, 1, n); // timing
  box(0, 6, n, 1);
  const a = ALIGN[v];
  for (let i = 0; i < a.length; i++)
    for (let j = 0; j < a.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === a.length - 1) || (i === a.length - 1 && j === 0)) continue;
      box(a[i] - 2, a[j] - 2, 5, 5);
    }
  if (v >= 7) {
    box(n - 11, 0, 3, 6);
    box(0, n - 11, 6, 3);
  }
  return f;
}
const MASKS: Array<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => ((((x + y) % 2) + ((x * y) % 3)) % 2) === 0,
];
// Valid format words for level M, masks 0-7 (ISO 18004 Annex C).
const FORMAT_M = [0b101010000010010, 0b101000100100101, 0b101111001111100, 0b101101101001011, 0b100010111111001, 0b100000011001110, 0b100111110010111, 0b100101010100000];

function decode(q: Qr): string {
  const n = q.size;
  const v = (n - 17) / 4;
  const m = q.rows;
  // format word, first copy: bits 0-5 down column 8 from the top, then 7, 8 and the row.
  let word = 0;
  const first = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  first.forEach(([x, y], i) => { if (m[y][x]) word |= 1 << i; });
  let word2 = 0;
  const second: number[][] = [];
  for (let i = 0; i < 8; i++) second.push([n - 1 - i, 8]);
  for (let i = 8; i < 15; i++) second.push([8, n - 15 + i]);
  second.forEach(([x, y], i) => { if (m[y][x]) word2 |= 1 << i; });
  expect(word2, 'format copies agree').toBe(word);
  const mask = FORMAT_M.indexOf(word);
  expect(mask, 'format word is a valid level M word').toBeGreaterThanOrEqual(0);
  expect(mask).toBe(q.mask);
  expect(m[n - 8][8], 'dark module').toBe(true);

  const fm = functionMask(v);
  const bits: number[] = [];
  let up = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const y = up ? n - 1 - k : k;
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        if (fm[y][x]) continue;
        bits.push(m[y][x] !== MASKS[mask](x, y) ? 1 : 0);
      }
    }
    up = !up;
  }
  const raw = Math.floor(bits.length / 8);
  const cw: number[] = [];
  for (let i = 0; i < raw; i++) cw.push(parseInt(bits.slice(i * 8, i * 8 + 8).join(''), 2));

  // de-interleave
  const nb = BLOCKS_M[v];
  const el = ECC_M[v];
  const shortLen = Math.floor(raw / nb);
  const nShort = nb - (raw % nb);
  const dlen = Array.from({ length: nb }, (_, i) => shortLen - el + (i < nShort ? 0 : 1));
  const blocks: number[][] = Array.from({ length: nb }, () => []);
  let p = 0;
  for (let i = 0; i < shortLen - el + 1; i++)
    for (let b = 0; b < nb; b++) if (i < dlen[b]) blocks[b].push(cw[p++]);
  for (let i = 0; i < el; i++) for (let b = 0; b < nb; b++) blocks[b].push(cw[p++]);
  expect(p).toBe(raw);
  // Each block (data then ecc) must have zero syndromes.
  for (const blk of blocks) {
    for (let k = 0; k < el; k++) {
      let s = 0;
      for (const c of blk) s = mul(s, EXP[k]) ^ c;
      expect(s, 'RS syndrome').toBe(0);
    }
  }
  const data: number[] = [];
  for (const blk of blocks) data.push(...blk.slice(0, blk.length - el));
  const bs = data.map((b) => b.toString(2).padStart(8, '0')).join('');
  expect(bs.slice(0, 4)).toBe('0100');
  const cb = v <= 9 ? 8 : 16;
  const len = parseInt(bs.slice(4, 4 + cb), 2);
  const bytes = Buffer.alloc(len);
  for (let i = 0; i < len; i++) bytes[i] = parseInt(bs.slice(4 + cb + i * 8, 4 + cb + i * 8 + 8), 2);
  return bytes.toString('utf8');
}

describe('QR encoder', () => {
  it('computes Reed-Solomon like the published worked example', () => {
    // The 1-M "HELLO WORLD" example: 16 data codewords, 10 error correction codewords.
    const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
    const ecc = Array.from(I.rsRemainder(data, I.rsDivisor(10)) as number[]);
    expect(ecc).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('computes the BCH format and version words', () => {
    for (let m = 0; m < 8; m++) expect(I.formatBits(m)).toBe(FORMAT_M[m]);
    expect(I.versionBits(7)).toBe(0b000111110010010100);
    expect(I.versionBits(10)).toBe(0b001010010011010011);
  });

  it('has the expected sizes and finder patterns', () => {
    const q = qr('https://example-tailnet.ts.net/m/');
    expect(q.size).toBe(q.version * 4 + 17);
    const dark = (x: number, y: number) => q.rows[y][x];
    for (const [ox, oy] of [[0, 0], [q.size - 7, 0], [0, q.size - 7]]) {
      for (let i = 0; i < 7; i++) {
        expect(dark(ox + i, oy)).toBe(true);
        expect(dark(ox + i, oy + 6)).toBe(true);
        expect(dark(ox, oy + i)).toBe(true);
        expect(dark(ox + 6, oy + i)).toBe(true);
      }
      expect(dark(ox + 3, oy + 3)).toBe(true);
      expect(dark(ox + 1, oy + 1)).toBe(false);
    }
  });

  it('round-trips through an independent reader at every version, every mask', () => {
    const texts = [
      'a',
      'https://mac.example-tailnet.ts.net/m/',
      'https://mac.example-tailnet.ts.net/m/#pair=K7QM-42XD',
      'x'.repeat(86), // fills version 5
      'y'.repeat(120), // version 7: carries version information
      'z'.repeat(213), // version 10, 16-bit length
      'Ünï — ✓ 日本',
    ];
    for (const t of texts) {
      const q = qr(t);
      expect(decode(q), t.slice(0, 20)).toBe(t);
    }
    const v7 = qr('y'.repeat(120));
    expect(v7.version).toBe(7);
    // version information, both copies
    let w = 0;
    for (let i = 0; i < 18; i++) if (v7.rows[Math.floor(i / 3)][v7.size - 11 + (i % 3)]) w |= 1 << i;
    expect(w).toBe(I.versionBits(7));
    for (let m = 0; m < 8; m++) expect(decode(qr('https://mac.example-tailnet.ts.net/m/', m)).length).toBeGreaterThan(10);
  });

  it('refuses text that does not fit, and draws an svg', () => {
    expect(() => qr('q'.repeat(300))).toThrow();
    const svg = sandbox.loomQrSvg!('hello', 120);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 ' + (qr('hello').size + 8));
    expect(svg).not.toContain('<script');
  });
});

describe('Settings › Devices pane', () => {
  const ctx: any = {
    sxEsc: (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!),
    sxGrp: (t: string) => `<h>${t}</h>`,
    sxRow: (a: string, b: string, c: string) => `<row>${a}|${b}|${c}</row>`,
    sxBtn: (act: string, label: string, o: any = {}) => `<btn ${act} ${o.arg ?? ''} ${o.dis ? 'disabled' : ''}>${label}</btn>`,
    sxPill: (c: string, t: string) => `<pill ${c}>${t}</pill>`,
    sxNote: (t: string, k?: string) => `<note ${k ?? ''}>${t}</note>`,
    sxAgo: () => 'a while ago',
    sxWhen: () => 'then',
    sxJ: () => Promise.resolve({}),
    sxRerender: () => {},
    SX: { sec: 'devices' },
    tab: 'settings',
    document: { querySelectorAll: () => [], hidden: false },
    setInterval: () => 1,
    clearInterval: () => {},
    Date,
    Math,
  };
  vm.createContext(ctx);
  vm.runInContext(DEVICES_VIEW_JS, ctx);
  const run = (code: string) => vm.runInContext(code, ctx);

  it('draws the QR, the code and the approve buttons', () => {
    run(`DEV.d={phoneAccess:{on:true,state:'on',url:'https://mac.example-tailnet.ts.net/m/'},devices:[{id:'d1',name:'iPhone',created_at:1,last_seen_at:2,push:true}],pending:[{id:'r1',name:'iPad',requested_at:Date.now()}],pairing:{code:'K7QM-42XD',url:'https://mac.example-tailnet.ts.net/m/',expires_at:Date.now()+300000}};`);
    const html = run('sxDevices()') as string;
    expect(html).toContain('<svg');
    expect(html).toContain('K7QM-42XD');
    expect(html).toContain('data-dev-exp=');
    expect(html).toContain('Allow “iPad”?');
    expect(html).toContain('<btn dev_allow r1');
    expect(html).toContain('<btn dev_deny r1');
    expect(html).toContain('<btn dev_revoke d1');
    expect(html).toContain('notifications on');
    expect(run('devStatus()')).toEqual(['warn', '1 request waiting']);
  });

  it('degrades when Tailscale is missing and when the backend is off', () => {
    run(`DEV.d={phoneAccess:{on:false,state:'no-tailscale',detail:'not installed'},devices:[],pending:[],pairing:null};`);
    const html = run('sxDevices()') as string;
    expect(html).toContain('Install Tailscale on this Mac and on your iPhone');
    expect(html).toContain('<btn dev_pair  disabled>'); // can't pair until Phone access is on
    expect(run('devStatus()')).toEqual(['warn', 'Tailscale not found']);
    run(`DEV.d=null;DEV.err='boom';`);
    expect(run('sxDevices()')).toContain('boom');
    expect(run('devStatus()')).toEqual(['off', 'Unavailable']);
  });
});
