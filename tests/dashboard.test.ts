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

  it('surfaces saved / saved_at on the view', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);

    // Default: not saved.
    expect(toChatViews(db)[0].saved).toBe(false);
    expect(toChatViews(db)[0].saved_at).toBe(0);

    db.prepare(`UPDATE chats SET saved=1, saved_at=4242 WHERE session_id=?`).run('sess-abc');
    const v = toChatViews(db)[0];
    expect(v.saved).toBe(true);
    expect(v.saved_at).toBe(4242);
    db.close();
  });

  it('ships the Board/Saved tab + save scaffolding in the static shell', () => {
    const html = renderDashboard([], 9999);
    expect(html).toContain('id="tabs"'); // segmented Board/Saved switch container
    expect(html).toContain('function renderTabs('); // tab renderer
    expect(html).toContain("tab='board'"); // default view state
    expect(html).toContain('id="restorebtn"'); // Restore workspace (moved to header actions)
    expect(html).toContain('/save?session='); // client save endpoint
    expect(html).toContain('/unsave?session='); // client unsave endpoint
  });

  // Archive hits are fetched from /api/search and turned into cards entirely in the
  // browser, so their rendering can't be asserted here — only that the shell ships
  // the scaffolding those client functions need. Behaviour is covered by
  // scripts/check-dashboard.sh (syntax of the served JS) and end-to-end use.
  it('ships the archive-search scaffolding in the static shell', () => {
    const html = renderDashboard([], 9999);
    expect(html).toContain('id="archive"'); // results container
    expect(html).toContain('id="deep"'); // the "search all history" affordance
    expect(html).toContain('/api/search?q='); // client calls the archive endpoint
    expect(html).toContain('function acard('); // archive card builder
    expect(html).toContain('function renderArchive('); // archive section renderer
  });
});
