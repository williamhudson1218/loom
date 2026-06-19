import { describe, it, expect } from 'vitest';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { runPass } from '../src/cli.ts';

describe('runPass', () => {
  it('indexes fixtures, summarizes with a stub runner, and writes a dashboard', async () => {
    const db = openDb(':memory:');
    const projectsDir = path.join(__dirname, 'fixtures-projects');
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cm-')), 'dashboard.html');
    const runner = async () => `{"title":"T","overview":"O","breakdown":["a","left off"]}`;

    const res = await runPass(db, runner, { now: 1000, projectsDir, dashboardPath: out });
    expect(res.scanned).toBeGreaterThan(0);
    expect(fs.existsSync(out)).toBe(true);
    expect(fs.readFileSync(out, 'utf-8')).toContain('<!doctype html>');
    db.close();
  });
});
