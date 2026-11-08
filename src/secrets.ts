import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Secrets live in the macOS login Keychain, reached through the small
// `loom-keychain` helper (app/native/loom-keychain.swift). The secret crosses
// the process boundary on stdin/stdout only, never as an argument, so it never
// shows up in `ps`. Nothing here writes a secret to disk, logs one, or puts one
// in an error message.
//
// Tests swap the whole backend with setKeychainBackend(); they never touch the
// real Keychain.

export interface KeychainBackend {
  /** The secret, or null when there is no such item (or no helper to ask). */
  get(service: string, account: string): string | null;
  set(service: string, account: string, secret: string): void;
  /** Idempotent: deleting a missing item is not an error. */
  delete(service: string, account: string): void;
}

const NOT_FOUND = 44;

declare const __LOOM_REPO_DIR__: string | undefined;

/**
 * Where the helper binary is. Packaged: electron-builder puts it beside
 * app.asar (process.resourcesPath). From source (tsx, tests, the standalone
 * server): app/build-native/, where app/build.mjs compiles it. LOOM_KEYCHAIN_BIN
 * overrides both.
 */
export function keychainHelperPath(): string | null {
  const candidates: string[] = [];
  const env = process.env.LOOM_KEYCHAIN_BIN?.trim();
  if (env) candidates.push(env);
  const res = (process as { resourcesPath?: string }).resourcesPath;
  if (res) candidates.push(path.join(res, 'loom-keychain'));
  if (typeof __LOOM_REPO_DIR__ === 'string' && __LOOM_REPO_DIR__) candidates.push(path.join(__LOOM_REPO_DIR__, 'app', 'build-native', 'loom-keychain'));
  candidates.push(path.join(process.cwd(), 'app', 'build-native', 'loom-keychain'));
  candidates.push(path.join(process.cwd(), 'build-native', 'loom-keychain'));
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The redacted reason a helper call failed: its stderr, which never carries the secret. */
function reason(e: unknown): string {
  const err = e as { stderr?: Buffer | string; status?: number; message?: string };
  const stderr = err.stderr ? String(err.stderr).trim() : '';
  return stderr || `exit ${err.status ?? '?'}`;
}

export function helperBackend(bin: string | null = keychainHelperPath()): KeychainBackend {
  const run = (op: string, service: string, account: string, input?: string): Buffer => {
    if (!bin) throw new Error('keychain helper not built (app/build-native/loom-keychain)');
    return execFileSync(bin, [op, '--service', service, '--account', account], {
      input: input ?? '',
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
  return {
    get(service, account) {
      if (!bin) return null;
      try {
        return run('get', service, account).toString('utf-8') || null;
      } catch (e) {
        if ((e as { status?: number }).status === NOT_FOUND) return null;
        throw new Error('keychain get failed: ' + reason(e));
      }
    },
    set(service, account, secret) {
      if (!secret) throw new Error('refusing to store an empty secret');
      try {
        run('set', service, account, secret);
      } catch (e) {
        throw new Error('keychain set failed: ' + reason(e));
      }
    },
    delete(service, account) {
      if (!bin) return;
      try {
        run('delete', service, account);
      } catch (e) {
        throw new Error('keychain delete failed: ' + reason(e));
      }
    },
  };
}

/** An in-memory Keychain for tests. */
export function memoryBackend(seed: Record<string, string> = {}): KeychainBackend & { items: Map<string, string> } {
  const items = new Map(Object.entries(seed));
  const k = (s: string, a: string) => s + '\u0000' + a;
  return {
    items,
    get: (s, a) => items.get(k(s, a)) ?? null,
    set: (s, a, v) => void items.set(k(s, a), v),
    delete: (s, a) => void items.delete(k(s, a)),
  };
}

let backend: KeychainBackend | null = null;

export function keychain(): KeychainBackend {
  // Under vitest the real login Keychain is never reached by accident: a test
  // that wants one installs it with setKeychainBackend().
  if (!backend) backend = process.env.VITEST ? memoryBackend() : helperBackend();
  return backend;
}

/** Swap the backend (tests). Pass null to go back to the real helper. */
export function setKeychainBackend(b: KeychainBackend | null): void {
  backend = b;
}
