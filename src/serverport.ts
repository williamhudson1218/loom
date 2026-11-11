// The port Loom is actually serving on. It starts as the configured port and is
// replaced after listen() when that port was taken and Loom moved to the next
// free one (src/portpick.ts). Everything that builds a Loom URL, an Origin or a
// Host check reads it here, so a Loom that moved keeps working.

export const DEFAULT_PORT = 4317;
/** How many consecutive ports Loom tries, from the configured one: 4317 to 4326 by default. */
export const PORT_SPAN = 10;

let preferred = DEFAULT_PORT;
let actual = DEFAULT_PORT;

/** The ports Loom may serve on for a configured base. Small on purpose: OAuth redirects are registered per port. */
export function portRange(base: number = DEFAULT_PORT, span: number = PORT_SPAN): number[] {
  const out: number[] = [];
  for (let p = base; p < base + span && p <= 65535; p++) out.push(p);
  return out;
}

/** The port serving right now. */
export const serverPort = (): number => actual;
/** The configured port (the base of the range), whether or not Loom could take it. */
export const preferredPort = (): number => preferred;

export function setServerPort(port: number, base: number = port): void {
  actual = port;
  preferred = base;
}
