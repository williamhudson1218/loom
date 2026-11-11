import { openDb } from './db.ts';
import { getSetting } from './settingsSchema.ts';
import { resolveTool } from './toolpath.ts';

// claude as the user configured it: the claude_bin setting, then the shared
// resolver (src/toolpath.ts). Kept apart from toolpath.ts so the resolver stays
// free of the database. Cached briefly; background callers run it often.

const CACHE_MS = 30_000;
let memo: { at: number; v: string } | null = null;

export function claudePath(): string {
  if (memo && Date.now() - memo.at < CACHE_MS) return memo.v;
  let setting = '';
  let extra: string[] = [];
  try {
    const db = openDb();
    try {
      setting = (getSetting(db, 'claude_bin', { env: false }) as string) || '';
      extra = (getSetting(db, 'extra_path', { env: false }) as string[]) || [];
    } finally {
      db.close();
    }
  } catch {
    /* no database yet: the resolver alone */
  }
  const v = resolveTool('claude', { setting, extra }) ?? (setting || 'claude');
  memo = { at: Date.now(), v };
  return v;
}

export function clearClaudePath(): void {
  memo = null;
}
