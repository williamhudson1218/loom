import type Database from 'better-sqlite3';
import type { Agent } from './types.ts';

// Sidebar chat groups: user-named sections a chat can be moved into. A group is a
// row in `chat_groups` (name unique, case-insensitively; id order is creation
// order, which is also the order the sidebar shows them); a chat belongs to at
// most one through `chat_group_members`, keyed by agent + session id like tags.
// Collapsed state is a per-viewer UI preference and lives with the other sidebar
// collapse state in the page (keyed by group id, so a rename keeps it).

export interface GroupInfo {
  id: number;
  name: string;
  count: number;
}

export type GroupResult<T = object> = ({ ok: true } & T) | { ok: false; detail: string; code: 400 | 404 | 409 };

const bad = (detail: string, code: 400 | 404 | 409 = 400) => ({ ok: false as const, detail, code });

export function cleanGroupName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}

export function listGroups(db: Database.Database): GroupInfo[] {
  return db
    .prepare(`SELECT g.id, g.name, (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id = g.id) AS count FROM chat_groups g ORDER BY g.position, g.id`)
    .all() as GroupInfo[];
}

export function createGroup(db: Database.Database, nameIn: unknown, now = Date.now()): GroupResult<{ group: { id: number; name: string } }> {
  const name = cleanGroupName(nameIn);
  if (!name) return bad('a group needs a name');
  if (db.prepare(`SELECT 1 FROM chat_groups WHERE name = ?`).get(name)) return bad('a group with that name exists', 409);
  const id = Number(db.prepare(`INSERT INTO chat_groups (name, created_at, position) VALUES (?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM chat_groups))`).run(name, now).lastInsertRowid);
  return { ok: true, group: { id, name } };
}

export function renameGroup(db: Database.Database, id: unknown, nameIn: unknown): GroupResult<{ group: { id: number; name: string } }> {
  const gid = Number(id);
  if (!db.prepare(`SELECT 1 FROM chat_groups WHERE id = ?`).get(gid)) return bad('unknown group', 404);
  const name = cleanGroupName(nameIn);
  if (!name) return bad('a group needs a name');
  const clash = db.prepare(`SELECT id FROM chat_groups WHERE name = ?`).get(name) as { id: number } | undefined;
  if (clash && clash.id !== gid) return bad('a group with that name exists', 409);
  db.prepare(`UPDATE chat_groups SET name = ? WHERE id = ?`).run(name, gid);
  return { ok: true, group: { id: gid, name } };
}

/** Deleting a group returns its chats to the ungrouped list. */
export function deleteGroup(db: Database.Database, id: unknown): GroupResult {
  const gid = Number(id);
  if (!db.prepare(`SELECT 1 FROM chat_groups WHERE id = ?`).get(gid)) return bad('unknown group', 404);
  db.transaction(() => {
    db.prepare(`DELETE FROM chat_group_members WHERE group_id = ?`).run(gid);
    db.prepare(`DELETE FROM chat_groups WHERE id = ?`).run(gid);
  })();
  return { ok: true };
}

/** Rewrite the display order: ids must be exactly the existing groups, each once. One transaction. */
export function reorderGroups(db: Database.Database, ids: unknown): GroupResult {
  if (!Array.isArray(ids) || !ids.every((v) => Number.isInteger(v))) return bad('ids must be a list of group ids');
  const want = ids as number[];
  const have = (db.prepare(`SELECT id FROM chat_groups`).all() as { id: number }[]).map((r) => r.id);
  if (new Set(want).size !== want.length) return bad('duplicate group id');
  if (want.length !== have.length || !want.every((i) => have.includes(i))) return bad('ids must list every group exactly once');
  const set = db.prepare(`UPDATE chat_groups SET position = ? WHERE id = ?`);
  db.transaction(() => want.forEach((id, i) => set.run(i + 1, id)))();
  return { ok: true };
}

/** Move a chat into a group, or out of every group with groupId null. */
export function setChatGroup(db: Database.Database, agent: Agent, sessionId: string, groupId: unknown): GroupResult<{ group: { id: number; name: string } | null }> {
  if (groupId === null || groupId === undefined) {
    db.prepare(`DELETE FROM chat_group_members WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
    return { ok: true, group: null };
  }
  const g = db.prepare(`SELECT id, name FROM chat_groups WHERE id = ?`).get(Number(groupId)) as { id: number; name: string } | undefined;
  if (!g) return bad('unknown group', 404);
  if (!db.prepare(`SELECT 1 FROM chats WHERE agent = ? AND session_id = ?`).get(agent, sessionId)) return bad('unknown session', 404);
  db.prepare(
    `INSERT INTO chat_group_members (agent, session_id, group_id) VALUES (?, ?, ?)
     ON CONFLICT(agent, session_id) DO UPDATE SET group_id = excluded.group_id`,
  ).run(agent, sessionId, g.id);
  return { ok: true, group: g };
}

/** `<agent>:<session>` -> its group, for every grouped chat. */
export function chatGroupMap(db: Database.Database): Map<string, { id: number; name: string }> {
  const out = new Map<string, { id: number; name: string }>();
  const rows = db
    .prepare(`SELECT m.agent, m.session_id, g.id, g.name FROM chat_group_members m JOIN chat_groups g ON g.id = m.group_id`)
    .all() as { agent: string; session_id: string; id: number; name: string }[];
  for (const r of rows) out.set(`${r.agent}:${r.session_id}`, { id: r.id, name: r.name });
  return out;
}
