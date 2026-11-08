import type Database from 'better-sqlite3';
import type { Agent } from './types.ts';

// Chat tags: user-named labels with a colour from a fixed palette. A tag is a row
// in `tags` (the name is unique, case-insensitively); a chat carries tags through
// `chat_tags`. Keyed by tag id so renaming never touches the assignments.

/** Hues that read on the dark theme (used as text on a tinted chip). */
export const TAG_PALETTE = ['#79b1ff', '#7ee0a0', '#e8b84b', '#ff8086', '#c9a9ff', '#5fd7d7', '#ffa66b', '#f08fd0'] as const;

export interface TagInfo {
  name: string;
  color: string;
  count: number;
}

export type TagResult<T = object> = ({ ok: true } & T) | { ok: false; detail: string; code: 400 | 404 | 409 };

const bad = (detail: string, code: 400 | 404 | 409 = 400) => ({ ok: false as const, detail, code });

export function cleanTagName(v: unknown): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}

export function isTagColor(v: unknown): v is string {
  return typeof v === 'string' && (TAG_PALETTE as readonly string[]).includes(v);
}

export function listTags(db: Database.Database): TagInfo[] {
  return db
    .prepare(
      `SELECT t.name, t.color, (SELECT COUNT(*) FROM chat_tags ct WHERE ct.tag_id = t.id) AS count
       FROM tags t ORDER BY t.name COLLATE NOCASE`,
    )
    .all() as TagInfo[];
}

/** The palette colour used least so far (ties go to the earlier palette slot). */
export function nextTagColor(db: Database.Database): string {
  const used = new Map<string, number>();
  for (const r of db.prepare(`SELECT color FROM tags`).all() as { color: string }[]) used.set(r.color, (used.get(r.color) ?? 0) + 1);
  let best: string = TAG_PALETTE[0];
  for (const c of TAG_PALETTE) if ((used.get(c) ?? 0) < (used.get(best) ?? 0)) best = c;
  return best;
}

export function createTag(db: Database.Database, nameIn: unknown, colorIn?: unknown, now = Date.now()): TagResult<{ tag: { name: string; color: string } }> {
  const name = cleanTagName(nameIn);
  if (!name) return bad('a tag needs a name');
  if (colorIn !== undefined && colorIn !== '' && !isTagColor(colorIn)) return bad('color must be one of the palette');
  if (db.prepare(`SELECT 1 FROM tags WHERE name = ?`).get(name)) return bad('a tag with that name exists', 409);
  const color = isTagColor(colorIn) ? colorIn : nextTagColor(db);
  db.prepare(`INSERT INTO tags (name, color, created_at) VALUES (?, ?, ?)`).run(name, color, now);
  return { ok: true, tag: { name, color } };
}

/** Rename and/or recolour. `name` finds the tag (case-insensitive). */
export function updateTag(db: Database.Database, nameIn: unknown, patch: { newName?: unknown; color?: unknown }): TagResult<{ tag: { name: string; color: string } }> {
  const name = cleanTagName(nameIn);
  const row = db.prepare(`SELECT id, name, color FROM tags WHERE name = ?`).get(name) as { id: number; name: string; color: string } | undefined;
  if (!row) return bad('unknown tag', 404);
  let next = row.name;
  if (patch.newName !== undefined) {
    next = cleanTagName(patch.newName);
    if (!next) return bad('a tag needs a name');
    const clash = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(next) as { id: number } | undefined;
    if (clash && clash.id !== row.id) return bad('a tag with that name exists', 409);
  }
  let color = row.color;
  if (patch.color !== undefined) {
    if (!isTagColor(patch.color)) return bad('color must be one of the palette');
    color = patch.color;
  }
  db.prepare(`UPDATE tags SET name = ?, color = ? WHERE id = ?`).run(next, color, row.id);
  return { ok: true, tag: { name: next, color } };
}

export function deleteTag(db: Database.Database, nameIn: unknown): TagResult {
  const row = db.prepare(`SELECT id FROM tags WHERE name = ?`).get(cleanTagName(nameIn)) as { id: number } | undefined;
  if (!row) return bad('unknown tag', 404);
  db.transaction(() => {
    db.prepare(`DELETE FROM chat_tags WHERE tag_id = ?`).run(row.id);
    db.prepare(`DELETE FROM tags WHERE id = ?`).run(row.id);
  })();
  return { ok: true };
}

/** Replace a chat's tag set. Every name must already exist. */
export function setChatTags(db: Database.Database, agent: Agent, sessionId: string, names: unknown): TagResult<{ tags: string[] }> {
  if (!Array.isArray(names)) return bad('tags must be a list of names');
  const ids: { id: number; name: string }[] = [];
  for (const n of names) {
    const row = db.prepare(`SELECT id, name FROM tags WHERE name = ?`).get(cleanTagName(n)) as { id: number; name: string } | undefined;
    if (!row) return bad(`unknown tag: ${String(n)}`, 404);
    if (!ids.some((x) => x.id === row.id)) ids.push(row);
  }
  if (!db.prepare(`SELECT 1 FROM chats WHERE agent = ? AND session_id = ?`).get(agent, sessionId)) return bad('unknown session', 404);
  db.transaction(() => {
    db.prepare(`DELETE FROM chat_tags WHERE agent = ? AND session_id = ?`).run(agent, sessionId);
    const ins = db.prepare(`INSERT INTO chat_tags (agent, session_id, tag_id) VALUES (?, ?, ?)`);
    for (const t of ids) ins.run(agent, sessionId, t.id);
  })();
  return { ok: true, tags: ids.map((t) => t.name).sort((a, b) => a.localeCompare(b)) };
}

/** `<agent>:<session>` -> tag names (name order), for every tagged chat. */
export function chatTagMap(db: Database.Database): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const rows = db
    .prepare(`SELECT ct.agent, ct.session_id, t.name FROM chat_tags ct JOIN tags t ON t.id = ct.tag_id ORDER BY t.name COLLATE NOCASE`)
    .all() as { agent: string; session_id: string; name: string }[];
  for (const r of rows) {
    const k = `${r.agent}:${r.session_id}`;
    (out.get(k) ?? out.set(k, []).get(k)!).push(r.name);
  }
  return out;
}
