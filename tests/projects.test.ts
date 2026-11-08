import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { addProject, listProjects, lastUsedProject, removeProject, seedProjects, touchProject, updateProject } from '../src/projects.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'proj-')));
const chat = (db: any, sid: string, dir: string) =>
  db.prepare(`INSERT INTO chats (agent, session_id, project_dir, jsonl_path, started_at, ended_at, last_active_at, message_count, jsonl_mtime, last_indexed_at) VALUES ('claude', ?, ?, ?, 1, 1, 1, 1, 1, 1)`).run(sid, dir, '/x/' + sid);

describe('projects', () => {
  it('seeds from indexed chats once, skips missing dirs and worktrees, and never overwrites edits', () => {
    const db = openDb(':memory:');
    const a = tmp(), b = tmp();
    fs.mkdirSync(path.join(a, '.worktrees', 'w'), { recursive: true });
    chat(db, '1', a); chat(db, '2', a); chat(db, '3', b); chat(db, '4', '/no/such/dir'); chat(db, '5', path.join(a, '.worktrees', 'w'));
    expect(seedProjects(db)).toBe(2);
    const p = listProjects(db).find((x) => x.path === a)!;
    updateProject(db, p.id, { name: 'Mine', hidden: true, color: '#112233' });
    expect(seedProjects(db)).toBe(0); // idempotent
    const again = listProjects(db, { includeHidden: true }).find((x) => x.path === a)!;
    expect(again).toMatchObject({ name: 'Mine', hidden: true, color: '#112233' });
    expect(listProjects(db, { includeHidden: true })).toHaveLength(2);
  });

  it('validates adds: absolute, existing, a directory; realpaths; duplicates unhide', () => {
    const db = openDb(':memory:');
    const d = tmp();
    const f = path.join(d, 'file.txt');
    fs.writeFileSync(f, 'x');
    expect(addProject(db, 'relative/dir')).toMatchObject({ ok: false });
    expect(addProject(db, '')).toMatchObject({ ok: false });
    expect(addProject(db, path.join(d, 'missing'))).toMatchObject({ ok: false });
    expect(addProject(db, f)).toMatchObject({ ok: false, detail: 'That path is not a folder.' });
    const link = path.join(tmp(), 'link');
    fs.symlinkSync(d, link);
    const r = addProject(db, link);
    expect(r.ok && r.project.path).toBe(d);
    expect(r.ok && r.project.name).toBe(path.basename(d));
    const id = (r as any).project.id;
    updateProject(db, id, { hidden: true });
    expect(listProjects(db)).toHaveLength(0);
    const again = addProject(db, d);
    expect(again.ok && again.project.hidden).toBe(false);
    expect(listProjects(db, { includeHidden: true })).toHaveLength(1);
  });

  it('sorts by last used, hides hidden, and touch adds a new folder', () => {
    const db = openDb(':memory:');
    const [a, b, c] = [tmp(), tmp(), tmp()];
    for (const [i, d] of [a, b, c].entries()) addProject(db, d, 100 + i);
    expect(listProjects(db).map((p) => p.path)).toEqual([c, b, a]); // never used: newest added first
    touchProject(db, a, 1000);
    touchProject(db, b, 2000);
    expect(listProjects(db).map((p) => p.path)).toEqual([b, a, c]);
    expect(lastUsedProject(db)).toBe(b);
    updateProject(db, listProjects(db)[0].id, { hidden: true });
    expect(listProjects(db).map((p) => p.path)).toEqual([a, c]);
    expect(lastUsedProject(db)).toBe(a);
    const d = tmp();
    touchProject(db, d, 3000);
    expect(listProjects(db)[0].path).toBe(d);
  });

  it('remove deletes the row only', () => {
    const db = openDb(':memory:');
    const d = tmp();
    const r = addProject(db, d);
    expect(removeProject(db, (r as any).project.id)).toBe(true);
    expect(removeProject(db, 999)).toBe(false);
    expect(fs.existsSync(d)).toBe(true);
    expect(listProjects(db, { includeHidden: true })).toHaveLength(0);
  });

  it('rejects a malformed color and keeps the rest of the patch', () => {
    const db = openDb(':memory:');
    const r = addProject(db, tmp()) as any;
    const u = updateProject(db, r.project.id, { color: 'red', name: ' New ' });
    expect(u).toMatchObject({ name: 'New', color: r.project.color });
  });
});
