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
import { chatGroupMap, createGroup, deleteGroup, listGroups, renameGroup, setChatGroup } from '../src/chatgroups.ts';

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
