import { describe, it, expect, afterEach } from 'vitest';
import { routes, setUpdateHost } from '../src/routes/update.ts';
import type { UpdateState } from '../src/updater.ts';

// POST /api/update/check is the Settings › Updates button. It must answer at once
// with the check under way; the page follows the rest through pushed state and
// GET /api/update. When it waited for the whole download, the button showed
// nothing until it was clicked again.

const check = routes.find((r) => r.method === 'POST' && r.path === '/api/update/check')!;
afterEach(() => setUpdateHost(null));

describe('POST /api/update/check', () => {
  it('answers with "checking" before the download and verify finish', async () => {
    let status: UpdateState['status'] = 'current';
    let started = 0;
    setUpdateHost({
      state: () => ({ status, current: '0.1.5' }) as UpdateState,
      check: () => {
        started++;
        status = 'checking';
        return new Promise(() => {}); // the download that has not finished
      },
      restart: () => ({ ok: false, detail: 'no' }),
    });
    let answered: { code: number; body: { state: UpdateState } } | null = null;
    const ctx = { json: (code: number, body: unknown) => void (answered = { code, body: body as { state: UpdateState } }) };
    const ran = (check.handler as (c: unknown) => unknown)(ctx);
    await Promise.race([ran, new Promise((r) => setTimeout(r, 50))]);
    expect(started).toBe(1);
    expect(answered).not.toBeNull();
    expect(answered!.body.state.status).toBe('checking');
  });
});
