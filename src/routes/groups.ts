import type Database from 'better-sqlite3';
import { openDb as realOpenDb } from '../db.ts';
import { createGroup, deleteGroup, listGroups, renameGroup, reorderGroups, setChatGroup, type GroupResult } from '../chatgroups.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Sidebar chat groups. Every write is a browser-guarded POST (the route table gates
// it before the handler runs); the reply carries the full group list so the page
// never has to refetch the board to redraw.
//   POST /api/groups         {name, session?, agent?}  create; with a chat, also move it in
//   POST /api/groups/rename  {id, name}
//   POST /api/groups/delete  {id}                      its chats go back to ungrouped
//   POST /api/groups/order   {ids: number[]}           every group id once, in the new order
//   POST /api/chat-group     {session, agent, group_id|null}

function withDb<T>(f: (db: Database.Database) => T): T {
  const db = realOpenDb();
  try {
    return f(db);
  } finally {
    db.close();
  }
}

const isAgent = (v: unknown): v is 'claude' | 'codex' => v === 'claude' || v === 'codex';

function reply(ctx: RouteCtx, db: Database.Database, r: GroupResult<object>): void {
  if (!r.ok) return ctx.json(r.code, { ok: false, detail: r.detail });
  ctx.json(200, { ...r, groups: listGroups(db) });
}

async function postCreate(ctx: RouteCtx): Promise<void> {
  const b = (await ctx.body()) ?? {};
  withDb((db) => {
    const made = createGroup(db, b.name);
    if (!made.ok) return reply(ctx, db, made);
    if (typeof b.session === 'string' && isAgent(b.agent)) {
      const m = setChatGroup(db, b.agent, b.session, made.group.id);
      if (!m.ok) return reply(ctx, db, m);
    }
    reply(ctx, db, made);
  });
}

async function postRename(ctx: RouteCtx): Promise<void> {
  const b = (await ctx.body()) ?? {};
  withDb((db) => reply(ctx, db, renameGroup(db, b.id, b.name)));
}

async function postDelete(ctx: RouteCtx): Promise<void> {
  const b = (await ctx.body()) ?? {};
  withDb((db) => reply(ctx, db, deleteGroup(db, b.id)));
}

async function postOrder(ctx: RouteCtx): Promise<void> {
  const b = (await ctx.body()) ?? {};
  withDb((db) => reply(ctx, db, reorderGroups(db, b.ids)));
}

async function postSet(ctx: RouteCtx): Promise<void> {
  const b = (await ctx.body()) ?? {};
  if (typeof b.session !== 'string' || !isAgent(b.agent)) return ctx.json(400, { ok: false, detail: 'session and a valid agent are required' });
  const agent = b.agent;
  const session = b.session;
  withDb((db) => reply(ctx, db, setChatGroup(db, agent, session, b.group_id)));
}

export const routes: RouteDef[] = [
  { method: 'POST', path: '/api/groups', kind: 'browser', handler: postCreate },
  { method: 'POST', path: '/api/groups/rename', kind: 'browser', handler: postRename },
  { method: 'POST', path: '/api/groups/delete', kind: 'browser', handler: postDelete },
  { method: 'POST', path: '/api/groups/order', kind: 'browser', handler: postOrder },
  { method: 'POST', path: '/api/chat-group', kind: 'browser', handler: postSet },
];
