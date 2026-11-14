// Split out of pipeline.ts so the action-items grammar can parse a PR reference
// without importing the gh-calling pipeline (and, through it, child_process).

/** `{repo, number}` from a GitHub pull request URL, or null. */
export function parsePrRef(url: string): { repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)/);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}
