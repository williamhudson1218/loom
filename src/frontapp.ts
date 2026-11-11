import { execFile } from 'node:child_process';

// Which app is frontmost, from lsappinfo (/usr/bin, no permission needed): the
// pick overlay asks before it looks at Slack (src/pickstate.ts, pickMayLook).

/** The ASN `lsappinfo front` prints, e.g. "ASN:0x0-0x1578176c:". */
export function parseFrontAsn(out: string): string | null {
  return /(ASN:0x[0-9a-f]+-0x[0-9a-f]+:?)/i.exec(out)?.[1] ?? null;
}

/** The bundle id from `lsappinfo info -only bundleid <asn>`. */
export function parseBundleId(out: string): string | null {
  return /"CFBundleIdentifier"\s*=\s*"([^"]+)"/.exec(out)?.[1] ?? null;
}

const run = (args: string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile('/usr/bin/lsappinfo', args, { timeout: 1500, encoding: 'utf8' }, (err, out) => resolve(err ? '' : String(out)));
  });

/** The frontmost app's bundle id, or null when lsappinfo cannot say. */
export async function frontBundleId(): Promise<string | null> {
  if (process.platform !== 'darwin') return null;
  const asn = parseFrontAsn(await run(['front']));
  return asn ? parseBundleId(await run(['info', '-only', 'bundleid', asn])) : null;
}
