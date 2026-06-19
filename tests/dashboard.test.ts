import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import path from 'node:path';
import { toChatViews, renderDashboard } from '../src/dashboard.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');

describe('dashboard', () => {
  it('builds views and renders self-contained HTML with the data blob', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);
    db.prepare(`UPDATE chats SET title='My Title', overview='ov', breakdown_json='["x","y"]', summary_dirty=0 WHERE session_id=?`).run('sess-abc');

    const views = toChatViews(db);
    expect(views.length).toBe(1);
    expect(views[0].title).toBe('My Title');
    expect(views[0].breakdown).toEqual(['x', 'y']);
    expect(views[0].summary_pending).toBe(false);

    const html = renderDashboard(views, 9999);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('My Title');
    // session_id is embedded in the data blob; the copy-id button + id chip are
    // assembled client-side from it (so only 'sess-abc' and the 'copy id' label
    // appear as literals in the static shell).
    expect(html).toContain('sess-abc');
    expect(html).toContain('copy id');
    db.close();
  });

  it('marks summary_pending for un-summarized chats', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000); // summary_dirty=1, no title
    const views = toChatViews(db);
    expect(views[0].summary_pending).toBe(true);
    db.close();
  });
});
