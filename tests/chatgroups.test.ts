import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import { toChatViews, renderDashboard } from '../src/dashboard.ts';
import { GROUPING_JS } from '../src/grouping.ts';
import { SIDESORT_JS } from '../src/sidesort.ts';
import { chatGroupMap, createGroup, deleteGroup, listGroups, renameGroup, reorderGroups, setChatGroup } from '../src/chatgroups.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');
async function seeded(file = ':memory:') {
  const db = openDb(file);
  const chat = await parseJsonlFile(FIX);
  upsertChat(db, chat, 1000, 5000);
  return { db, agent: chat.agent, sid: chat.session_id };
}

describe('chat groups data layer', () => {
  it('creates groups with unique case-insensitive names, in creation order', async () => {
    const { db } = await seeded();
    expect(createGroup(db, '  Billing  ')).toMatchObject({ ok: true, group: { name: 'Billing' } });
    expect(createGroup(db, 'billing')).toMatchObject({ ok: false, code: 409 });
    expect(createGroup(db, '   ')).toMatchObject({ ok: false, code: 400 });
    createGroup(db, 'Alpha');
    expect(listGroups(db).map((g) => g.name)).toEqual(['Billing', 'Alpha']);
    db.close();
  });

  it('moves a chat in and out, one group at a time, and counts members', async () => {
    const { db, agent, sid } = await seeded();
    const a = createGroup(db, 'A') as { group: { id: number } };
    const b = createGroup(db, 'B') as { group: { id: number } };
    expect(setChatGroup(db, agent, sid, a.group.id)).toMatchObject({ ok: true, group: { name: 'A' } });
    expect(setChatGroup(db, agent, sid, b.group.id)).toMatchObject({ ok: true, group: { name: 'B' } });
    expect(listGroups(db).map((g) => g.count)).toEqual([0, 1]);
    expect(chatGroupMap(db).get(`${agent}:${sid}`)).toMatchObject({ name: 'B' });
    expect(setChatGroup(db, agent, sid, 999)).toMatchObject({ ok: false, code: 404 });
    expect(setChatGroup(db, agent, 'nope', a.group.id)).toMatchObject({ ok: false, code: 404 });
    expect(setChatGroup(db, agent, sid, null)).toMatchObject({ ok: true, group: null });
    expect(chatGroupMap(db).size).toBe(0);
    db.close();
  });

  it('renames (refusing a clash) and deleting returns the chats to ungrouped', async () => {
    const { db, agent, sid } = await seeded();
    const a = createGroup(db, 'A') as { group: { id: number } };
    createGroup(db, 'B');
    expect(renameGroup(db, a.group.id, 'b')).toMatchObject({ ok: false, code: 409 });
    expect(renameGroup(db, a.group.id, 'Renamed')).toMatchObject({ ok: true });
    expect(renameGroup(db, 999, 'x')).toMatchObject({ ok: false, code: 404 });
    setChatGroup(db, agent, sid, a.group.id);
    expect(deleteGroup(db, a.group.id)).toMatchObject({ ok: true });
    expect(listGroups(db).map((g) => g.name)).toEqual(['B']);
    expect(chatGroupMap(db).size).toBe(0);
    expect(deleteGroup(db, a.group.id)).toMatchObject({ ok: false, code: 404 });
    db.close();
  });

  it('survives a restart and reaches the board view', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-groups-'));
    const file = path.join(dir, 'loom.db');
    try {
      const first = await seeded(file);
      const g = createGroup(first.db, 'Keep') as { group: { id: number } };
      setChatGroup(first.db, first.agent, first.sid, g.group.id);
      first.db.close();
      const db = openDb(file);
      const view = toChatViews(db).find((v) => v.session_id === first.sid)!;
      expect(view.group).toEqual({ id: g.group.id, name: 'Keep' });
      expect(listGroups(db)).toEqual([{ id: g.group.id, name: 'Keep', count: 1 }]);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('splitUserGroups', () => {
  const { splitUserGroups } = new Function(`${GROUPING_JS}; return {splitUserGroups};`)() as {
    splitUserGroups: (rows: R[], groups: { id: number; name: string }[], f: (c: R) => number, keepEmpty: boolean) => { groups: { id: number; name: string; rows: R[] }[]; rest: R[] };
  };
  type R = { id: string; g: number };
  const rows: R[] = [{ id: 'a', g: 2 }, { id: 'b', g: 0 }, { id: 'c', g: 1 }, { id: 'd', g: 2 }, { id: 'e', g: 9 }];
  const groups = [{ id: 1, name: 'One' }, { id: 2, name: 'Two' }, { id: 3, name: 'Three' }];
  const f = (c: R) => c.g;

  it('keeps definition order, incoming row order, and sends unknown groups to the main list', () => {
    const sp = splitUserGroups(rows, groups, f, false);
    expect(sp.groups.map((g) => [g.name, g.rows.map((r) => r.id)])).toEqual([['One', ['c']], ['Two', ['a', 'd']]]);
    expect(sp.rest.map((r) => r.id)).toEqual(['b', 'e']);
  });
  it('shows empty groups only when asked', () => {
    expect(splitUserGroups(rows, groups, f, true).groups.map((g) => g.name)).toEqual(['One', 'Two', 'Three']);
  });
  it('orders each group by the same comparator as the main list', () => {
    const { sortComparator } = new Function(`${SIDESORT_JS}; return {sortComparator};`)() as {
      sortComparator: (m: string, f: Record<string, (c: { id: string; s: number }) => unknown>) => (a: { id: string; s: number }, b: { id: string; s: number }) => number;
    };
    const cmp = sortComparator('recent', { started: () => 0, stamp: (c) => c.s, key: (c) => c.id });
    const rs = [{ id: 'a', s: 1, g: 2 }, { id: 'b', s: 5, g: 0 }, { id: 'c', s: 3, g: 2 }, { id: 'd', s: 9, g: 2 }];
    const sp = splitUserGroups(rs as never, groups, (c) => (c as { g: number }).g, false);
    expect(sp.groups[0].rows.slice().sort(cmp as never).map((r) => (r as unknown as { id: string }).id)).toEqual(['d', 'c', 'a']);
  });
});

describe('sidebar wiring', () => {
  const html = renderDashboard([], 1000, {}, 'claude', [], [], '', null, [], {}, [{ id: 1, name: 'Billing', count: 0 }]);
  it('embeds the group list and renders user groups through the shared ordering and collapse code', () => {
    expect(html).toContain('"groups":[{"id":1,"name":"Billing","count":0}]');
    expect(html).toContain("orderRows(gk,g.rows,selKey)");
    expect(html).toContain("'ugrp:'+g.id");
  });
  it('keeps Stale to ungrouped chats: the stale split runs on what the groups left over', () => {
    expect(html.indexOf('splitUserGroups(rows')).toBeLessThan(html.indexOf('splitStale(rows,chatKey'));
  });
});

describe('chat group order', () => {
  const ids = (db: any) => listGroups(db).map((g) => g.name);
  it('reorders in one go, new groups land last, and rejects bad id lists', async () => {
    const { db } = await seeded();
    const a = (createGroup(db, 'A') as any).group.id;
    const b = (createGroup(db, 'B') as any).group.id;
    const c = (createGroup(db, 'C') as any).group.id;
    expect(reorderGroups(db, [c, a, b])).toEqual({ ok: true });
    expect(ids(db)).toEqual(['C', 'A', 'B']);
    createGroup(db, 'D');
    expect(ids(db)).toEqual(['C', 'A', 'B', 'D']);
    expect(reorderGroups(db, [a, b])).toMatchObject({ ok: false, code: 400 });
    expect(reorderGroups(db, [a, a, b, c])).toMatchObject({ ok: false, code: 400 });
    expect(reorderGroups(db, [a, b, c, 999])).toMatchObject({ ok: false, code: 400 });
    expect(reorderGroups(db, 'x')).toMatchObject({ ok: false, code: 400 });
    expect(ids(db)).toEqual(['C', 'A', 'B', 'D']);
    deleteGroup(db, c);
    createGroup(db, 'E');
    expect(ids(db)).toEqual(['A', 'B', 'D', 'E']);
    db.close();
  });

  it('backfills positions in id order for a database made before the column', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-groups-'));
    const file = path.join(dir, 'loom.db');
    try {
      const first = await seeded(file);
      createGroup(first.db, 'One');
      createGroup(first.db, 'Two');
      first.db.exec(`ALTER TABLE chat_groups DROP COLUMN position`);
      first.db.close();
      const db = openDb(file);
      expect(ids(db)).toEqual(['One', 'Two']);
      expect((db.prepare(`SELECT position FROM chat_groups ORDER BY id`).all() as any[]).map((r) => r.position)).toEqual([1, 2]);
      db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('drag helpers', () => {
  const lib = new Function(`${GROUPING_JS}; return { reorderIds, dropGroupOf, applyGroupHoldsTo, dndScrollSpeed };`)() as any;
  const key = (c: any) => c.agent + ':' + c.session_id;
  const G = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }];
  it('a dropped chat stays where it was dropped when a stale poll lands, until the write is confirmed', () => {
    const hold: any = { chats: { 'claude:s1': { gid: 2, until: 1000, acked: false } }, order: null };
    const stale = [{ agent: 'claude', session_id: 's1', group: G[0] }];
    lib.applyGroupHoldsTo(hold, stale, G, key, 10);
    expect(stale[0].group).toBe(G[1]);
    // The poll agrees but the write is not confirmed yet: keep holding (an older poll may still land).
    const agrees = [{ agent: 'claude', session_id: 's1', group: G[1] }];
    lib.applyGroupHoldsTo(hold, agrees, G, key, 20);
    expect(hold.chats['claude:s1']).toBeTruthy();
    hold.chats['claude:s1'].acked = true;
    lib.applyGroupHoldsTo(hold, agrees, G, key, 30);
    expect(hold.chats).toEqual({});
    // Out of every group, and expiry lets the server win.
    const h2: any = { chats: { 'claude:s1': { gid: 0, until: 100, acked: false } }, order: null };
    const rows = [{ agent: 'claude', session_id: 's1', group: G[0] }];
    lib.applyGroupHoldsTo(h2, rows, G, key, 50);
    expect(rows[0].group).toBeNull();
    rows[0].group = G[0];
    lib.applyGroupHoldsTo(h2, rows, G, key, 101);
    expect(rows[0].group).toBe(G[0]);
    expect(h2.chats).toEqual({});
  });
  it('a reorder stays put over a stale poll, and yields when the groups changed underneath', () => {
    const hold: any = { chats: {}, order: { ids: [3, 1, 2], until: 1000, acked: true } };
    expect(lib.applyGroupHoldsTo(hold, [], G, key, 10).map((g: any) => g.id)).toEqual([3, 1, 2]);
    expect(hold.order).toBeTruthy();
    expect(lib.applyGroupHoldsTo(hold, [], [G[2], G[0], G[1]], key, 20).map((g: any) => g.id)).toEqual([3, 1, 2]);
    expect(hold.order).toBeNull();
    const h2: any = { chats: {}, order: { ids: [3, 1, 2], until: 1000, acked: false } };
    expect(lib.applyGroupHoldsTo(h2, [], [G[0], G[1]], key, 10).map((g: any) => g.id)).toEqual([1, 2]);
  });
  it('drag autoscroll: still in the middle, faster toward and past each edge, capped', () => {
    expect(lib.dndScrollSpeed(100, 700, 400)).toBe(0);
    expect(lib.dndScrollSpeed(100, 700, 150)).toBeLessThan(0);
    expect(lib.dndScrollSpeed(100, 700, 110)).toBeLessThan(lib.dndScrollSpeed(100, 700, 150));
    expect(lib.dndScrollSpeed(100, 700, 20)).toBe(-22);
    expect(lib.dndScrollSpeed(100, 700, 690)).toBeGreaterThan(0);
    expect(lib.dndScrollSpeed(100, 700, 900)).toBe(22);
  });
  it('reorderIds places the dragged id before or after the target', () => {
    expect(lib.reorderIds([1, 2, 3], 3, 1, false)).toEqual([3, 1, 2]);
    expect(lib.reorderIds([1, 2, 3], 1, 3, true)).toEqual([2, 3, 1]);
    expect(lib.reorderIds([1, 2, 3], 1, 2, true)).toEqual([2, 1, 3]);
    expect(lib.reorderIds([1, 2, 3], 2, 2, true)).toEqual([1, 2, 3]);
    expect(lib.reorderIds([1, 2, 3], 9, 2, true)).toEqual([1, 2, 3]);
    expect(lib.reorderIds([1, 2, 3], 1, 9, true)).toEqual([1, 2, 3]);
  });
  it('dropGroupOf is 0 for ungrouped sections', () => {
    expect(lib.dropGroupOf('7')).toBe(7);
    expect(lib.dropGroupOf(undefined)).toBe(0);
    expect(lib.dropGroupOf('')).toBe(0);
  });
});
