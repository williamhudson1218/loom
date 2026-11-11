import { claudePath } from '../toolbins.ts';
import { toolEnv } from '../toolpath.ts';
import { defaultRunner, parseClaudeVersion } from '../probe.ts';
import { currentEnv, diagnosticsText } from '../diagnostics.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// POST /api/diagnostics: the redacted plain-text bundle behind every "Copy
// details" button and Settings > About > Copy diagnostics (src/errorview.ts).
// A POST so the page's write token gates it: the bundle carries log lines.

let claudeMemo: { at: number; v: string | null } | null = null;
const CLAUDE_TTL_MS = 5 * 60_000;

async function claudeVersion(): Promise<string | null> {
  if (claudeMemo && Date.now() - claudeMemo.at < CLAUDE_TTL_MS) return claudeMemo.v;
  const bin = claudePath();
  const r = await defaultRunner(bin, ['--version'], { timeoutMs: 4000, env: toolEnv(bin) });
  const v = r.missing ? 'not found' : r.code === 0 ? (parseClaudeVersion(r.stdout)?.raw ?? r.stdout.trim().split('\n')[0] ?? null) : null;
  claudeMemo = { at: Date.now(), v };
  return v;
}

const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.slice(0, n) : '');

async function postDiagnostics({ json, body }: RouteCtx): Promise<void> {
  const b = (await body()) ?? {};
  const text = diagnosticsText(
    { what: str(b.what, 300), message: str(b.message, 4000), output: str(b.output, 60_000) },
    currentEnv(await claudeVersion().catch(() => null)),
  );
  json(200, { ok: true, text });
}

export const routes: RouteDef[] = [{ method: 'POST', path: '/api/diagnostics', kind: 'browser', handler: postDiagnostics }];
