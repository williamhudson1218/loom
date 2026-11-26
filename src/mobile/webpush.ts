import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto';
import { TOOL_DIR } from '../paths.ts';
import type { PushSub } from './devices.ts';

// Web Push with node:crypto only: RFC 8291 message encryption (aes128gcm, RFC 8188)
// and RFC 8292 VAPID (an ES256 JWT). tests/mobile-webpush.test.ts checks the
// encryption against RFC 8291 Appendix A byte for byte.

const b64u = (b: Buffer | Uint8Array): string => Buffer.from(b).toString('base64url');
const unb64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export interface EncryptOpts {
  /** 16 bytes; random when absent (tests pin it). */
  salt?: Buffer;
  /** The sender's ephemeral P-256 private key, 32 bytes; random when absent. */
  asPrivate?: Buffer;
  /** Record size; 4096 is the usual. */
  rs?: number;
}

/** The aes128gcm body for one push message to one subscription. */
export function encryptPayload(plaintext: Buffer | string, keys: { p256dh: string; auth: string }, opts: EncryptOpts = {}): Buffer {
  const uaPublic = unb64u(keys.p256dh);
  const authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('p256dh must be an uncompressed P-256 point');
  if (authSecret.length < 16) throw new Error('auth secret too short');
  const ecdh = createECDH('prime256v1');
  if (opts.asPrivate) ecdh.setPrivateKey(opts.asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);
  const rs = opts.rs ?? 4096;

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const data = Buffer.concat([Buffer.from(plaintext), Buffer.from([2])]); // one record: the last-record delimiter
  if (data.length + 16 > rs) throw new Error('payload too large for one record');
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([cipher.update(data), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, ct]);
}

/* ---------------------------------------------------------------- VAPID */

export interface VapidKeys {
  /** base64url uncompressed P-256 point (65 bytes): what pushManager.subscribe takes */
  publicKey: string;
  /** base64url 32-byte scalar */
  privateKey: string;
}

export function generateVapidKeys(): VapidKeys {
  const e = createECDH('prime256v1');
  e.generateKeys();
  return { publicKey: b64u(e.getPublicKey()), privateKey: b64u(e.getPrivateKey()) };
}

export const VAPID_PATH = (): string => path.join(TOOL_DIR, 'vapid.json');

/** The keypair in ~/.loom/vapid.json (0600), made once. */
export function loadVapidKeys(file: string = VAPID_PATH()): VapidKeys {
  try {
    const k = JSON.parse(fs.readFileSync(file, 'utf8')) as VapidKeys;
    if (typeof k.publicKey === 'string' && typeof k.privateKey === 'string' && unb64u(k.publicKey).length === 65) {
      if ((fs.statSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600);
      return k;
    }
  } catch {
    /* make one */
  }
  const k = generateVapidKeys();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(k) + '\n', { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, file);
  return k;
}

/** Generic contact for the push services; never a person's address. */
export const VAPID_SUBJECT = 'mailto:loom@localhost.invalid';

/** `vapid t=<jwt>, k=<public key>` for one push service origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, now: number = Date.now(), subject: string = VAPID_SUBJECT): string {
  const aud = new URL(endpoint).origin;
  const pub = unb64u(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: keys.privateKey, x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33, 65)) };
  const key = createPrivateKey({ key: jwk, format: 'jwk' });
  const head = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(Buffer.from(JSON.stringify({ aud, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const input = `${head}.${body}`;
  const sig = sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${input}.${b64u(sig)}, k=${keys.publicKey}`;
}

/* ---------------------------------------------------------------- subscriptions */

const PUSH_HOSTS = ['push.apple.com', 'googleapis.com', 'mozilla.com', 'windows.com'];

/** A subscription from the phone, checked: https, a known push service, well-formed keys. */
export function validSubscription(v: unknown): PushSub | null {
  if (!v || typeof v !== 'object') return null;
  const s = v as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
  if (typeof s.endpoint !== 'string' || s.endpoint.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(s.endpoint);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return null;
  const host = u.hostname.toLowerCase();
  if (!PUSH_HOSTS.some((h) => host === h || host.endsWith('.' + h))) return null;
  const p256dh = s.keys?.p256dh;
  const auth = s.keys?.auth;
  if (typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth)) return null;
  const pk = unb64u(p256dh);
  if (pk.length !== 65 || pk[0] !== 4 || unb64u(auth).length < 16) return null;
  return { endpoint: s.endpoint, keys: { p256dh, auth } };
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag: string;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: Buffer; signal?: AbortSignal }) => Promise<{ status: number }>;

/** Send one message. Resolves with the push service's status (0 on a network error). */
export async function sendPush(sub: PushSub, payload: PushPayload, keys: VapidKeys, fetchImpl: FetchLike = fetch as unknown as FetchLike, now: number = Date.now()): Promise<number> {
  const body = encryptPayload(JSON.stringify(payload), sub.keys);
  try {
    const r = await fetchImpl(sub.endpoint, {
      method: 'POST',
      headers: {
        authorization: vapidAuthorization(sub.endpoint, keys, now),
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
        ttl: '86400',
        urgency: 'high',
        topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'loom',
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });
    return r.status;
  } catch {
    return 0;
  }
}
