import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let routes: typeof import('../src/routes/settingsextra.ts').routes;
let home: string;
beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-extra-'));
  process.env.LOOM_HOME = home;
  routes = (await import('../src/routes/settingsextra.ts')).routes;
});

const call = async (method: string, p: string, body?: unknown) => {
  const r = routes.find((x) => x.method === method && x.path === p)!;
  let out: { code: number; body: any } = { code: 0, body: null };
  await r.handler!({ req: {} as any, res: {} as any, url: new URL('http://x' + p), json: (code, b) => (out = { code, body: b }), body: async () => (body as any) ?? null });
  return out;
};

describe('settings extra routes', () => {
  it('every write is a browser-guarded route', () => {
    for (const r of routes) if (r.method !== 'GET') expect(r.kind).toBe('browser');
  });

  it('writes, reads and clears the orchestrator prompt override', async () => {
    expect((await call('GET', '/api/orchestrator/prompt-override')).body.active).toBe('default');
    expect((await call('PUT', '/api/orchestrator/prompt-override', { text: 'Be brief.' })).body.active).toBe('override');
    const g = (await call('GET', '/api/orchestrator/prompt-override')).body;
    expect(g.override.trim()).toBe('Be brief.');
    expect(fs.existsSync(path.join(home, 'orchestrator', 'prompt.override.md'))).toBe(true);
    expect((await call('PUT', '/api/orchestrator/prompt-override', { text: '  ' })).body.active).toBe('default');
    expect(fs.existsSync(path.join(home, 'orchestrator', 'prompt.override.md'))).toBe(false);
    expect((await call('PUT', '/api/orchestrator/prompt-override', {})).code).toBe(400);
  });

  it('refuses a sound name that is not a plain name', async () => {
    expect((await call('POST', '/api/sound/preview', { name: '../../etc/passwd' })).code).toBe(400);
    expect((await call('POST', '/api/sound/preview', { name: 'off' })).body.played).toBe(false);
  });
});
