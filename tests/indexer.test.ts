import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat, listProjectJsonls, pruneOld, windowCutoff, isAnalyzerSession } from '../src/indexer.ts';
import { SUMMARY_PROMPT_PREAMBLE, TOOL_DIR } from '../src/paths.ts';
import type { ParsedChat } from '../src/types.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');

describe('upsertChat', () => {
  it('inserts dirty, then is unchanged at same mtime, then dirty again when mtime grows', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);

    expect(upsertChat(db, parsed, 1000, 5000)).toBe('inserted');
    let row = db.prepare(`SELECT summary_dirty, message_count FROM chats WHERE session_id=?`).get('sess-abc') as any;
    expect(row.summary_dirty).toBe(1);
    expect(row.message_count).toBe(5);

    // Same mtime -> no work.
    expect(upsertChat(db, parsed, 1000, 6000)).toBe('unchanged');

    // Simulate a summary having been written, then the file growing.
    db.prepare(`UPDATE chats SET summary_dirty=0 WHERE session_id=?`).run('sess-abc');
    expect(upsertChat(db, parsed, 2000, 7000)).toBe('updated');
    row = db.prepare(`SELECT summary_dirty FROM chats WHERE session_id=?`).get('sess-abc') as any;
    expect(row.summary_dirty).toBe(1);
    db.close();
  });
});

describe('isAnalyzerSession', () => {
  const base: ParsedChat = {
    session_id: 's', project_dir: '/Users/me/dev/proj', jsonl_path: '/x.jsonl',
    started_at: 0, ended_at: 0, last_active_at: 0, message_count: 2,
    activity: {}, files_touched: [], first_message: 'fix the bug', claude_auto_title: '', pr_url: '',
  };

  it('flags sessions whose first message is the analyzer prompt', () => {
    expect(isAnalyzerSession({ ...base, first_message: `${SUMMARY_PROMPT_PREAMBLE} ...` })).toBe(true);
  });

  it('flags sessions whose cwd is the tool dir', () => {
    expect(isAnalyzerSession({ ...base, project_dir: TOOL_DIR })).toBe(true);
  });

  it('does not flag normal user chats', () => {
    expect(isAnalyzerSession(base)).toBe(false);
  });
});

describe('windowCutoff / pruneOld', () => {
  it('removes only rows last active before the cutoff', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);

    const now = 100 * 86_400_000; // day 100 in epoch-ms
    const cutoff = windowCutoff(now, 7); // day 93

    // Row's last_active_at comes from the fixture (year 2026) → well before cutoff.
    db.prepare(`UPDATE chats SET last_active_at=? WHERE session_id=?`).run(50 * 86_400_000, 'sess-abc');
    expect(pruneOld(db, cutoff)).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM chats`).get()).toEqual({ n: 0 });

    // A fresh, in-window row survives.
    upsertChat(db, parsed, 2000, 6000);
    db.prepare(`UPDATE chats SET last_active_at=? WHERE session_id=?`).run(99 * 86_400_000, 'sess-abc');
    expect(pruneOld(db, cutoff)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) n FROM chats`).get()).toEqual({ n: 1 });
    db.close();
  });

  it('exempts saved chats from the window prune', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);

    const now = 100 * 86_400_000;
    const cutoff = windowCutoff(now, 7);

    // Far past the cutoff, but saved -> must survive.
    db.prepare(`UPDATE chats SET last_active_at=?, saved=1, saved_at=? WHERE session_id=?`)
      .run(50 * 86_400_000, now, 'sess-abc');
    expect(pruneOld(db, cutoff)).toBe(0);
    expect(db.prepare(`SELECT COUNT(*) n FROM chats`).get()).toEqual({ n: 1 });

    // Unsaving lets it prune again.
    db.prepare(`UPDATE chats SET saved=0, saved_at=0 WHERE session_id=?`).run('sess-abc');
    expect(pruneOld(db, cutoff)).toBe(1);
    expect(db.prepare(`SELECT COUNT(*) n FROM chats`).get()).toEqual({ n: 0 });
    db.close();
  });
});

describe('listProjectJsonls', () => {
  it('returns only top-level .jsonl files (nested dirs excluded)', () => {
    const found = listProjectJsonls(path.join(__dirname, 'fixtures-projects'));
    expect(found.every((f) => f.endsWith('.jsonl'))).toBe(true);
    expect(found.some((f) => f.endsWith('s1.jsonl'))).toBe(true);
    expect(found.some((f) => f.includes(`${path.sep}nested${path.sep}`))).toBe(false);
  });
});
