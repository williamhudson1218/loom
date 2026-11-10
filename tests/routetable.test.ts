import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ROUTES } from '../src/routes/index.ts';

// The gate refuses any non-GET request whose path is not a row in ROUTES, so a
// write handler in server.ts without a row is dead code that answers 405.
describe('route table', () => {
  it('has a row for every write handler in server.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/server.ts'), 'utf8');
    const missing: string[] = [];
    for (const line of src.split('\n')) {
      const m = /req\.method === '(POST|PUT|DELETE|PATCH)'/.exec(line);
      if (!m) continue;
      for (const p of line.matchAll(/url\.pathname === '([^']+)'/g)) {
        if (!ROUTES.some((r) => r.path === p[1] && r.method === m[1])) missing.push(`${m[1]} ${p[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
