import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { TOOL_DIR } from '../paths.ts';

// Paired phones (the /m/ surface). A device is a name plus the SHA-256 of a
// 32-byte secret the phone holds in an HttpOnly cookie (`loom_device=<id>.<secret>`).
// The plaintext secret never touches disk: it exists in memory from the Mac's
// Allow click until the phone's next status poll collects it, then only on the phone.
//
// Pairing: the Mac shows an 8-character code (5 minutes, one at a time, 5 wrong
// tries burn it). The phone sends the code and a name and gets a pending request
// plus a `claim` secret only it holds. Nothing is minted until the Mac approves.
//
// ~/.loom/devices.json (0600, atomic write) holds the devices, their push
// subscriptions and prefs, and the Phone access wish. Pending requests and the
// live code are memory only: a restart forgets them, which is the safe direction.

export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface DevicePrefs {
  turn: boolean;
  blocked: boolean;
  drafts: boolean;
  watcher: boolean;
  away: boolean;
  quiet: boolean;
}

export const DEFAULT_PREFS: DevicePrefs = { turn: true, blocked: true, drafts: true, watcher: false, away: true, quiet: false };
export const PREF_KEYS = Object.keys(DEFAULT_PREFS) as (keyof DevicePrefs)[];

export interface Device {
  id: string;
  name: string;
  /** hex sha256 of the cookie secret */
  hash: string;
  created_at: number;
  last_seen_at: number;
  prefs: DevicePrefs;
  push?: PushSub;
}

export interface PhoneAccessWish {
  on: boolean;
  /** The tailnet name last seen from `tailscale status` (e.g. mac.example-tailnet.ts.net). */
  host?: string;
}

interface FileShape {
  devices: Device[];
  phone_access?: PhoneAccessWish;
}

export interface PendingRequest {
  id: string;
  name: string;
  requested_at: number;
  claim_hash: string;
  state: 'pending' | 'approved' | 'denied';
  /** Set on approve, cleared once the phone collects it. */
  cookie?: string;
  decided_at?: number;
}

export interface PairingCode {
  code: string;
  expires_at: number;
  attempts: number;
}

/** No 0/O, 1/I/L: read off a screen and typed on a phone. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_TTL_MS = 5 * 60_000;
export const MAX_CODE_ATTEMPTS = 5;
/** A pending request (or an approved one never collected) is forgotten after this. */
export const PENDING_TTL_MS = 10 * 60_000;
export const MAX_PENDING = 3;
export const SEEN_THROTTLE_MS = 60_000;
export const COOKIE_NAME = 'loom_device';
export const COOKIE_MAX_AGE_S = 400 * 24 * 3600;
export const MAX_DEVICES = 20;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

function safeEqualHex(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === 32 && x.length === y.length && timingSafeEqual(x, y);
}

/** `XXXXXXXX` -> `XXXX-XXXX`, for display. */
export const formatCode = (c: string): string => `${c.slice(0, 4)}-${c.slice(4)}`;
/** What a person typed, uppercased with spaces and dashes dropped. */
export const normalizeCode = (c: string): string => c.toUpperCase().replace(/[\s-]/g, '');

/** A device name from the phone: printable, trimmed, at most 40 characters. */
export function cleanName(v: unknown): string {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 40) : '';
  return s || 'Phone';
}

export interface StoreOpts {
  file?: string;
  now?: () => number;
}

export class DeviceStore {
  readonly file: string;
  private now: () => number;
  private cache: FileShape | null = null;
  private cacheMtime = -1;
  private code: PairingCode | null = null;
  private pending = new Map<string, PendingRequest>();
  /** Called when a phone asks to pair (the Mac's "Allow <name>?" notification). */
  onRequest: ((p: PendingRequest) => void) | null = null;

  constructor(opts: StoreOpts = {}) {
    this.file = opts.file ?? path.join(TOOL_DIR, 'devices.json');
    this.now = opts.now ?? Date.now;
  }

  /* ---------------------------------------------------------------- file */

  private read(): FileShape {
    let mtime = -2;
    try {
      mtime = fs.statSync(this.file).mtimeMs;
    } catch {
      /* missing */
    }
    if (this.cache && mtime === this.cacheMtime) return this.cache;
    let data: FileShape = { devices: [] };
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      data = {
        devices: Array.isArray(raw.devices) ? raw.devices.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string').map((d) => ({ ...d, prefs: { ...DEFAULT_PREFS, ...(d.prefs ?? {}) } })) : [],
        ...(raw.phone_access && typeof raw.phone_access === 'object' ? { phone_access: { on: raw.phone_access.on === true, ...(typeof raw.phone_access.host === 'string' ? { host: raw.phone_access.host } : {}) } } : {}),
      };
    } catch {
      /* missing or corrupt: no devices (fail closed) */
    }
    this.cache = data;
    this.cacheMtime = mtime;
    return data;
  }

  private write(data: FileShape): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, this.file);
    this.cache = data;
    try {
      this.cacheMtime = fs.statSync(this.file).mtimeMs;
    } catch {
      this.cacheMtime = -1;
    }
  }

  private mutate<T>(fn: (d: FileShape) => T): T {
    const d = structuredClone(this.read());
    const out = fn(d);
    this.write(d);
    return out;
  }

  /* ---------------------------------------------------------------- devices */

  devices(): Device[] {
    return this.read().devices;
  }

  get(id: string): Device | undefined {
    return this.read().devices.find((d) => d.id === id);
  }

  /** The device a `loom_device` cookie value names, or null. Constant-time on the secret. */
  verify(cookieValue: string | undefined | null): Device | null {
    if (!cookieValue) return null;
    const m = /^([a-f0-9]{16})\.([A-Za-z0-9_-]{43})$/.exec(cookieValue);
    if (!m) return null;
    const dev = this.get(m[1]);
    if (!dev) return null;
    return safeEqualHex(sha256(m[2]), dev.hash) ? dev : null;
  }

  /** last_seen_at, written at most once a minute per device. */
  touch(id: string): void {
    const d = this.get(id);
    if (!d || this.now() - d.last_seen_at < SEEN_THROTTLE_MS) return;
    this.mutate((f) => {
      const x = f.devices.find((y) => y.id === id);
      if (x) x.last_seen_at = this.now();
    });
  }

  revoke(id: string): boolean {
    if (!this.get(id)) return false;
    this.mutate((f) => {
      f.devices = f.devices.filter((d) => d.id !== id);
    });
    return true;
  }

  setPrefs(id: string, prefs: Partial<Record<string, unknown>>): DevicePrefs | null {
    if (!this.get(id)) return null;
    return this.mutate((f) => {
      const x = f.devices.find((y) => y.id === id)!;
      for (const k of PREF_KEYS) if (typeof prefs[k] === 'boolean') x.prefs[k] = prefs[k] as boolean;
      return x.prefs;
    });
  }

  setPush(id: string, sub: PushSub | null): boolean {
    if (!this.get(id)) return false;
    this.mutate((f) => {
      const x = f.devices.find((y) => y.id === id)!;
      if (sub) x.push = sub;
      else delete x.push;
    });
    return true;
  }

  /** Drop a subscription the push service says is gone (404/410), wherever it is. */
  dropEndpoint(endpoint: string): void {
    if (!this.read().devices.some((d) => d.push?.endpoint === endpoint)) return;
    this.mutate((f) => {
      for (const d of f.devices) if (d.push?.endpoint === endpoint) delete d.push;
    });
  }

  /* ---------------------------------------------------------------- phone access */

  phoneAccess(): PhoneAccessWish {
    return this.read().phone_access ?? { on: false };
  }

  setPhoneAccess(w: PhoneAccessWish): void {
    this.mutate((f) => {
      f.phone_access = { on: w.on, ...(w.host ? { host: w.host } : {}) };
    });
  }

  /* ---------------------------------------------------------------- pairing */

  private sweep(): void {
    const now = this.now();
    if (this.code && now >= this.code.expires_at) this.code = null;
    for (const [id, p] of this.pending) {
      const since = p.decided_at ?? p.requested_at;
      if (now - since >= PENDING_TTL_MS) this.pending.delete(id);
    }
  }

  /** A fresh code, replacing any live one. */
  startPairing(): PairingCode {
    let code = '';
    for (let i = 0; i < 8; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    this.code = { code, expires_at: this.now() + CODE_TTL_MS, attempts: 0 };
    return { ...this.code };
  }

  liveCode(): PairingCode | null {
    this.sweep();
    return this.code ? { ...this.code } : null;
  }

  cancelPairing(): void {
    this.code = null;
  }

  /**
   * The phone's half: a correct code becomes a pending request (and is used up).
   * Wrong codes count against the live one; the fifth burns it.
   */
  requestPairing(given: unknown, name: unknown): { ok: true; pending_id: string; claim: string } | { ok: false; status: number; detail: string } {
    this.sweep();
    if (!this.code) return { ok: false, status: 400, detail: 'no pairing code is active: start pairing on the Mac' };
    const typed = typeof given === 'string' ? normalizeCode(given) : '';
    const want = this.code.code;
    const match = typed.length === want.length && timingSafeEqual(Buffer.from(typed), Buffer.from(want));
    if (!match) {
      this.code.attempts++;
      if (this.code.attempts >= MAX_CODE_ATTEMPTS) {
        this.code = null;
        return { ok: false, status: 403, detail: 'wrong code: too many tries, start pairing again on the Mac' };
      }
      return { ok: false, status: 403, detail: 'wrong code' };
    }
    if ([...this.pending.values()].filter((p) => p.state === 'pending').length >= MAX_PENDING) {
      return { ok: false, status: 429, detail: 'too many pending requests' };
    }
    this.code = null;
    const claim = randomBytes(32).toString('base64url');
    const p: PendingRequest = { id: randomBytes(8).toString('hex'), name: cleanName(name), requested_at: this.now(), claim_hash: sha256(claim), state: 'pending' };
    this.pending.set(p.id, p);
    try {
      this.onRequest?.(p);
    } catch {
      /* a notification is a nicety */
    }
    return { ok: true, pending_id: p.id, claim };
  }

  pendingRequests(): { id: string; name: string; requested_at: number }[] {
    this.sweep();
    return [...this.pending.values()].filter((p) => p.state === 'pending').map((p) => ({ id: p.id, name: p.name, requested_at: p.requested_at }));
  }

  /** The Mac's Allow: the only thing that mints a device. */
  approve(id: string): Device | null {
    this.sweep();
    const p = this.pending.get(id);
    if (!p || p.state !== 'pending') return null;
    if (this.devices().length >= MAX_DEVICES) return null;
    const secret = randomBytes(32).toString('base64url');
    const now = this.now();
    const dev: Device = { id: randomBytes(8).toString('hex'), name: p.name, hash: sha256(secret), created_at: now, last_seen_at: now, prefs: { ...DEFAULT_PREFS } };
    this.mutate((f) => {
      f.devices.push(dev);
    });
    p.state = 'approved';
    p.cookie = `${dev.id}.${secret}`;
    p.decided_at = now;
    return dev;
  }

  deny(id: string): boolean {
    this.sweep();
    const p = this.pending.get(id);
    if (!p || p.state !== 'pending') return false;
    p.state = 'denied';
    p.decided_at = this.now();
    return true;
  }

  /**
   * The phone's poll. A wrong claim looks exactly like an unknown request. The
   * first approved poll hands over the cookie value and forgets the request.
   */
  pairStatus(id: unknown, claim: unknown): { state: 'pending' | 'approved' | 'denied' | 'expired'; cookie?: string } {
    this.sweep();
    const p = typeof id === 'string' ? this.pending.get(id) : undefined;
    if (!p || typeof claim !== 'string' || !claim || !safeEqualHex(sha256(claim), p.claim_hash)) return { state: 'expired' };
    if (p.state === 'pending') return { state: 'pending' };
    if (p.state === 'denied') {
      this.pending.delete(p.id);
      return { state: 'denied' };
    }
    const cookie = p.cookie;
    this.pending.delete(p.id);
    // Approved, then revoked from the Mac before the phone collected it.
    if (!cookie || !this.verify(cookie)) return { state: 'expired' };
    return { state: 'approved', cookie };
  }
}

let shared: DeviceStore | null = null;
/** The running Loom's store. Tests make their own or swap it with setDeviceStore. */
export function deviceStore(): DeviceStore {
  return (shared ??= new DeviceStore());
}
export function setDeviceStore(s: DeviceStore | null): void {
  shared = s;
}

/** The `loom_device` value from a Cookie header. */
export function deviceCookie(header: string | string[] | undefined): string | null {
  const h = Array.isArray(header) ? header.join('; ') : header ?? '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === COOKIE_NAME) return part.slice(i + 1).trim();
  }
  return null;
}

export function setCookieHeader(value: string): string {
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/m/; Max-Age=${COOKIE_MAX_AGE_S}`;
}

export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; HttpOnly; Secure; SameSite=Strict; Path=/m/; Max-Age=0`;
}
