import type { Match, Watcher } from '../model.ts';

// The work source: a findings endpoint polled every 15 minutes. Each finding
// is one Match, keyed by the finding's own key, so a finding that stays open is
// recorded once and a new key fires. The bearer token comes from the Keychain
// (service FINDINGS_TOKEN_SERVICE, account = the URL's host); it is never put
// in an error message.
//
// Dedupe is per finding key, forever (watcher_seen / watcher_events). A finding
// that closes and later reopens is NOT re-sent unless the endpoint encodes the
// episode in the key.

export const WORK_POLL_MS = 15 * 60_000;
export const WORK_MAX_BACKOFF_MS = 60 * 60_000;
export const FINDINGS_TOKEN_SERVICE = 'Loom findings token';
const FETCH_TIMEOUT_MS = 30_000;

export interface Finding {
  key: string;
  rule: string;
  subject: string;
  detail?: string;
  since?: string;
  ticket?: { code?: string; title?: string; assignee?: string | null } | null;
  suggestedFix?: { kind?: string; clear?: boolean };
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseFindings(body: unknown): Finding[] {
  let list: unknown;
  if (isObj(body) && Array.isArray(body.findings)) list = body.findings;
  else if (isObj(body) && isObj(body.data) && Array.isArray(body.data.findings)) list = body.data.findings;
  else throw new Error('not a findings response');
  const ok = (list as unknown[]).filter(
    (f): f is Finding => isObj(f) && typeof f.key === 'string' && typeof f.rule === 'string' && typeof f.subject === 'string',
  );
  // Every entry malformed means the shape changed (a renamed field), not "no findings".
  if ((list as unknown[]).length > 0 && ok.length === 0) throw new Error('not a findings response');
  return ok;
}

export async function fetchFindings(url: string, token: string, f: typeof fetch = fetch): Promise<Finding[]> {
  const res = await f(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`findings endpoint answered ${res.status}`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new Error('not a findings response');
  }
  return parseFindings(body);
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

export function evaluateWork(w: Watcher, findings: Finding[]): Match[] {
  const rules = list(w.trigger.params.rules);
  const out: Match[] = [];
  for (const f of findings) {
    if (rules.length && !rules.includes(f.rule)) continue;
    const code = f.ticket?.code ?? '';
    const title = `${f.rule} ${code}: ${f.subject}`.replace(/\s+/g, ' ').replace(/ :/, ':').trim().slice(0, 300);
    out.push({
      key: f.key,
      subject: `work:${code || f.key}`,
      title,
      permalink: '',
      vars: {
        TITLE: title,
        RULE: f.rule,
        TICKET: code,
        SUBJECT: f.subject,
        DETAIL: f.detail ?? '',
        CLEAR: f.suggestedFix?.clear ? 'yes' : 'no',
        KEY: f.key,
      },
    });
  }
  return out;
}

export function workBackoffMs(errorCount: number): number {
  return Math.min(WORK_POLL_MS * 2 ** Math.max(0, errorCount - 1), WORK_MAX_BACKOFF_MS);
}
