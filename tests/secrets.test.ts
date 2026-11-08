import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { helperBackend, keychain, memoryBackend, setKeychainBackend } from '../src/secrets.ts';

// The real login Keychain is never touched here. helperBackend is exercised
// against a fake `loom-keychain` (a shell script speaking the same protocol)
// that keeps its items in a temp dir and records the argv it was given.

const SECRET = 'xoxp-1111-2222-3333-abcdefabcdef';

function fakeHelper(): { bin: string; dir: string; argvLog: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-kc-'));
  const bin = path.join(dir, 'loom-keychain');
  const argvLog = path.join(dir, 'argv.log');
  fs.writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${argvLog}"
op="$1"; svc="$3"; acct="$5"
f="${dir}/item-$(printf '%s_%s' "$svc" "$acct" | tr -c 'A-Za-z0-9_' '_')"
case "$op" in
  get) [ -f "$f" ] || exit 44; cat "$f" ;;
  has) [ -f "$f" ] || exit 44 ;;
  set) cat > "$f" ;;
  delete) rm -f "$f" ;;
  boom) ;;
esac
if [ "$acct" = "denied" ]; then echo "keychain error -25293: denied" >&2; exit 1; fi
exit 0
`,
  );
  fs.chmodSync(bin, 0o755);
  return { bin, dir, argvLog };
}

afterEach(() => setKeychainBackend(null));

describe('keychain helper backend', () => {
  it('round-trips a secret over stdin/stdout and never puts it in argv', () => {
    const h = fakeHelper();
    const kc = helperBackend(h.bin);
    expect(kc.get('Loom Slack token', 'T1')).toBeNull();
    kc.set('Loom Slack token', 'T1', SECRET);
    expect(kc.get('Loom Slack token', 'T1')).toBe(SECRET);
    kc.delete('Loom Slack token', 'T1');
    expect(kc.get('Loom Slack token', 'T1')).toBeNull();
    kc.delete('Loom Slack token', 'T1'); // idempotent
    const argv = fs.readFileSync(h.argvLog, 'utf-8');
    expect(argv).toContain('set --service Loom Slack token --account T1');
    expect(argv).not.toContain(SECRET);
  });

  it('reports a Keychain failure without the secret in the message', () => {
    const h = fakeHelper();
    const kc = helperBackend(h.bin);
    let msg = '';
    try {
      kc.set('Loom Slack token', 'denied', SECRET);
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('keychain set failed');
    expect(msg).toContain('denied');
    expect(msg).not.toContain(SECRET);
  });

  it('reads as empty when the helper is not built, and refuses an empty secret', () => {
    const kc = helperBackend(null);
    expect(kc.get('s', 'a')).toBeNull();
    expect(() => kc.delete('s', 'a')).not.toThrow();
    expect(() => helperBackend(fakeHelper().bin).set('s', 'a', '')).toThrow('empty secret');
  });

  it('defaults to an in-memory store under vitest, so tests cannot reach the login Keychain', () => {
    setKeychainBackend(null);
    const kc = keychain();
    kc.set('s', 'a', 'v');
    expect(kc.get('s', 'a')).toBe('v');
    expect(memoryBackend({ ['s\u0000a']: 'x' }).get('s', 'a')).toBe('x');
  });
});
