import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import path from 'node:path';
import { toChatViews } from '../src/dashboard.ts';
import { GROUPING_JS } from '../src/grouping.ts';
import {
  TAG_PALETTE, chatTagMap, createTag, deleteTag, listTags, nextTagColor, setChatTags, updateTag,
} from '../src/tags.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');
async function seeded() {
  const db = openDb(':memory:');
  upsertChat(db, await parseJsonlFile(FIX), 1000, 5000);
  return db;
}

describe('tags data layer', () => {
  it('creates tags with unique, case-insensitive names and an automatic palette colour', () => {
    const db = openDb(':memory:');
    const a = createTag(db, '  ach  ');
    expect(a).toMatchObject({ ok: true, tag: { name: 'ach' } });
    expect(TAG_PALETTE).toContain((a as { tag: { color: string } }).tag.color);
    expect(createTag(db, 'ACH')).toMatchObject({ ok: false, code: 409 });
    expect(createTag(db, '   ')).toMatchObject({ ok: false, code: 400 });
    expect(createTag(db, 'x', '#123456')).toMatchObject({ ok: false, code: 400 });
    expect(createTag(db, 'blue', TAG_PALETTE[0])).toMatchObject({ ok: true, tag: { color: TAG_PALETTE[0] } });
    db.close();
  });

  it('spreads automatic colours across the palette before repeating', () => {
    const db = openDb(':memory:');
    const colors = TAG_PALETTE.map((_, i) => (createTag(db, `t${i}`) as { tag: { color: string } }).tag.color);
    expect(new Set(colors).size).toBe(TAG_PALETTE.length);
    expect(nextTagColor(db)).toBe(TAG_PALETTE[0]);
    db.close();
  });

  it('renames and recolours, refusing a clash or an off-palette colour', () => {
    const db = openDb(':memory:');
    createTag(db, 'a');
    createTag(db, 'b');
    expect(updateTag(db, 'a', { newName: 'alpha', color: TAG_PALETTE[3] })).toMatchObject({ ok: true, tag: { name: 'alpha', color: TAG_PALETTE[3] } });
    expect(updateTag(db, 'alpha', { newName: 'B' })).toMatchObject({ ok: false, code: 409 });
    expect(updateTag(db, 'alpha', { color: 'red' })).toMatchObject({ ok: false, code: 400 });
    expect(updateTag(db, 'nope', { newName: 'z' })).toMatchObject({ ok: false, code: 404 });
    // Renaming to a different case of itself is allowed.
    expect(updateTag(db, 'alpha', { newName: 'ALPHA' })).toMatchObject({ ok: true });
    expect(listTags(db).map((t) => t.name)).toEqual(['ALPHA', 'b']);
    db.close();
  });

  it('assigns tags to a chat, shows them on the view, and keeps them across a rename', async () => {
    const db = await seeded();
    createTag(db, 'ach');
    createTag(db, 'forms');
    expect(setChatTags(db, 'claude', 'sess-abc', ['forms', 'ach', 'ach'])).toEqual({ ok: true, tags: ['ach', 'forms'] });
    expect(toChatViews(db)[0].tags).toEqual(['ach', 'forms']);
    expect(listTags(db).find((t) => t.name === 'ach')?.count).toBe(1);

    updateTag(db, 'ach', { newName: 'achievers' });
    expect(toChatViews(db)[0].tags).toEqual(['achievers', 'forms']);
    expect(chatTagMap(db).get('claude:sess-abc')).toEqual(['achievers', 'forms']);

    expect(setChatTags(db, 'claude', 'sess-abc', ['ghost'])).toMatchObject({ ok: false, code: 404 });
    expect(setChatTags(db, 'claude', 'nope', [])).toMatchObject({ ok: false, code: 404 });
    expect(setChatTags(db, 'claude', 'sess-abc', 'forms')).toMatchObject({ ok: false, code: 400 });
    expect(setChatTags(db, 'claude', 'sess-abc', [])).toEqual({ ok: true, tags: [] });
    expect(toChatViews(db)[0].tags).toEqual([]);
    db.close();
  });

  it('deleting a tag removes it from every chat', async () => {
    const db = await seeded();
    createTag(db, 'a');
    setChatTags(db, 'claude', 'sess-abc', ['a']);
    expect(deleteTag(db, 'a')).toEqual({ ok: true });
    expect(toChatViews(db)[0].tags).toEqual([]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM chat_tags`).get()).toEqual({ n: 0 });
    expect(deleteTag(db, 'a')).toMatchObject({ ok: false, code: 404 });
    db.close();
  });
});

describe('groupChats (sidebar grouping)', () => {
  type Row = { id: string; saved?: boolean; working?: boolean; turn?: boolean; live?: boolean; tags?: string[]; fresh: number };
  const groupChats = new Function(`${GROUPING_JS}; return groupChats;`)() as (
    rows: Row[], mode: string, f: Record<string, (c: Row) => unknown>,
  ) => { name: string; tag: string; rows: Row[] }[];
  const f = {
    saved: (c: Row) => !!c.saved, working: (c: Row) => !!c.working, turn: (c: Row) => !!c.turn, live: (c: Row) => !!c.live,
    tags: (c: Row) => c.tags ?? [], fresh: (c: Row) => c.fresh,
  };
  const ids = (g: { rows: Row[] }) => g.rows.map((r) => r.id);

  const rows: Row[] = [
    { id: 'recent-old', fresh: 10 },
    { id: 'working', working: true, live: true, fresh: 50, tags: ['b'] },
    { id: 'turn', turn: true, live: true, fresh: 40, tags: ['a', 'b'] },
    { id: 'saved', saved: true, fresh: 5, tags: ['a'] },
    { id: 'recent-new', fresh: 30, tags: ['a'] },
  ];

  it('status mode is the original grouping and keeps the incoming order', () => {
    const g = groupChats(rows, 'status', f);
    expect(g.map((x) => x.name)).toEqual(['Working', 'Your turn', 'Saved for later', 'Recent']);
    expect(ids(g[3])).toEqual(['recent-old', 'recent-new']); // not re-sorted
  });

  it('parked chats: waiting joins Waiting on others, a reply joins Your turn, even when not live', () => {
    const parked: Record<string, string> = { w: 'waiting', r: 'replied' };
    const fp = { ...f, parked: (c: Row) => parked[c.id] ?? '' };
    const g = groupChats([{ id: 'w', fresh: 1 }, { id: 'r', fresh: 2 }, { id: 'x', fresh: 3 }], 'status', fp);
    expect(g.map((x) => [x.name, ids(x)])).toEqual([['Your turn', ['r']], ['Waiting on others', ['w']], ['Recent', ['x']]]);
  });

  it('tag mode: tag-name order, Untagged last, a chat with two tags in both sections', () => {
    const g = groupChats(rows, 'tag', f);
    expect(g.map((x) => x.name)).toEqual(['a', 'b', 'Untagged']);
    expect(ids(g[0])).toContain('turn');
    expect(ids(g[1])).toContain('turn');
    expect(ids(g[2])).toEqual(['recent-old']);
  });

  it('tag mode sorts a section Working, Your turn, then recency', () => {
    const g = groupChats(
      [
        { id: 'old', fresh: 1, tags: ['t'] },
        { id: 'new', fresh: 9, tags: ['t'] },
        { id: 'turn', fresh: 2, turn: true, live: true, tags: ['t'] },
        { id: 'work', fresh: 0, working: true, live: true, tags: ['t'] },
      ],
      'tag', f,
    );
    expect(ids(g[0])).toEqual(['work', 'turn', 'new', 'old']);
  });

  it('orders tag names case-insensitively and omits empty sections', () => {
    const g = groupChats([{ id: 'x', fresh: 1, tags: ['beta', 'Alpha'] }], 'tag', f);
    expect(g.map((x) => x.name)).toEqual(['Alpha', 'beta']);
    expect(groupChats([], 'tag', f)).toEqual([]);
  });
});
