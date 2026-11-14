import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACTIONS_PURE_JS, ACTIONS_VIEW_CSS, ACTIONS_VIEW_JS } from '../src/actionsview.ts';
import { routes, setActionsDeps, actionSummary } from '../src/routes/actions.ts';
import { applySchema } from '../src/schema.ts';
import { addStep, getStep, listSteps } from '../src/actions.ts';
import { ROUTES } from '../src/routes/index.ts';
import type { RouteCtx } from '../src/routes/index.ts';

const lib = new Function(`${ACTIONS_PURE_JS}; return { stepPill, stepButtons, railTab };`)() as {
  stepPill: (s: string) => { label: string; cls: string };
  stepButtons: (s: object) => string[];
  railTab: (drafts: unknown[], steps: unknown[], remembered: string) => string;
};
const step = (over: object) => ({ status: 'waiting', trigger_type: 'manual', action_type: 'none', ...over });

describe('stepButtons', () => {
  it('gives a due manual step run and check, and a done step nothing', () => {
    const b = lib.stepButtons(step({ status: 'due' }));
    expect(b).toContain('run');
    expect(b).toContain('check');
    expect(lib.stepButtons(step({ status: 'done' }))).toEqual([]);
    expect(lib.stepButtons(step({ status: 'removed' }))).toEqual([]);
  });
  it('offers check only for manual triggers, retry only when failed or held', () => {
    expect(lib.stepButtons(step({ trigger_type: 'pr_merged' }))).not.toContain('check');
    expect(lib.stepButtons(step({ status: 'failed' }))).toContain('retry');
    expect(lib.stepButtons(step({ status: 'held' }))).toContain('retry');
    expect(lib.stepButtons(step({ status: 'waiting' }))).not.toContain('retry');
    expect(lib.stepButtons(step({ status: 'waiting' }))).toEqual(['check', 'askfirst', 'remove']);
  });
});

describe('stepPill', () => {
  it('maps every status to its own label and class', () => {
    const all = ['waiting', 'due', 'running', 'held', 'done', 'failed', 'removed'].map((s) => lib.stepPill(s));
    expect(new Set(all.map((p) => p.cls)).size).toBe(7);
    expect(all.every((p) => p.label)).toBe(true);
  });
});

describe('railTab', () => {
  const d = [{ id: 'd0123456789ab' }];
  it('picks actions when a step is held even with drafts', () => {
    expect(lib.railTab(d, [{ status: 'held' }], 'outbox')).toBe('actions');
    expect(lib.railTab(d, [{ status: 'due' }], '')).toBe('actions');
    expect(lib.railTab(d, [{ status: 'failed' }], '')).toBe('actions');
  });
  it('otherwise uses the remembered tab, then outbox with drafts, then actions', () => {
    expect(lib.railTab(d, [{ status: 'waiting' }], 'actions')).toBe('actions');
    expect(lib.railTab(d, [{ status: 'waiting' }], 'outbox')).toBe('outbox');
    expect(lib.railTab(d, [{ status: 'waiting' }], '')).toBe('outbox');
    expect(lib.railTab([], [{ status: 'waiting' }], '')).toBe('actions');
    expect(lib.railTab([], [{ status: 'waiting' }], 'outbox')).toBe('actions');
  });
});

describe('the panel source', () => {
  it('is plain browser JS with no dollar-brace', () => {
    for (const s of [ACTIONS_PURE_JS, ACTIONS_VIEW_JS, ACTIONS_VIEW_CSS]) expect(s.includes('${')).toBe(false);
    expect(() => new Function(ACTIONS_PURE_JS + ACTIONS_VIEW_JS)).not.toThrow();
  });
});

describe('routes', () => {
  let dir = '';
  let file = '';
  let now = 1000;
  const SID = 'sess-1';
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-actroutes-'));
    file = path.join(dir, 'a.db');
    setActionsDeps({
      openDb: () => {
        const db = new Database(file);
        applySchema(db);
        return db;
      },
      now: () => now,
    });
  });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  const find = (m: string, p: string) => routes.find((r) => r.method === m && r.path === p)!;
  async function call(m: string, p: string, body?: object, query = ''): Promise<{ code: number; body: any }> {
    let out = { code: 0, body: null as any };
    const ctx = {
      url: new URL('http://127.0.0.1' + p + query),
      json: (code: number, b: unknown) => (out = { code, body: b }),
      body: async () => body ?? null,
    } as unknown as RouteCtx;
    await find(m, p).handler!(ctx);
    return out;
  }
  const withDb = <T,>(f: (db: Database.Database) => T) => {
    const db = new Database(file);
    applySchema(db);
    try {
      return f(db);
    } finally {
      db.close();
    }
  };

  it('registers the browser rows and the one read in the route table', () => {
    const rows = ROUTES.filter((r) => r.path.startsWith('/api/actions'));
    expect(rows.filter((r) => r.kind === 'read').map((r) => r.path)).toEqual(['/api/actions']);
    expect(rows.filter((r) => r.kind === 'browser').map((r) => r.path).sort()).toEqual(
      ['add', 'ask-first', 'check', 'remove', 'retry', 'run', 'undo'].map((x) => '/api/actions/' + x),
    );
  });

  it('add, check, remove and undo round-trip', async () => {
    expect((await call('POST', '/api/actions/add', { session: SID, title: '  Call the agency ' })).body.ok).toBe(true);
    let list = (await call('GET', '/api/actions', undefined, '?session=' + SID)).body;
    expect(list.ok).toBe(true);
    expect(list.close_when_done).toBe(false);
    expect(list.steps).toHaveLength(1);
    const s = list.steps[0];
    expect(s).toMatchObject({ title: 'Call the agency', trigger_type: 'manual', action_type: 'none', created_by: 'user', status: 'waiting' });
    expect(s.id).toMatch(/^a[0-9a-f]{12}$/);

    now = 2000;
    expect((await call('POST', '/api/actions/check', { id: s.id })).body.ok).toBe(true);
    expect(withDb((db) => getStep(db, s.id))).toMatchObject({ status: 'done', done_at: 2000 });
    expect(withDb((db) => db.prepare(`SELECT kind, target FROM orchestrator_log`).all())).toEqual([{ kind: 'action', target: SID }]);
    expect((await call('POST', '/api/actions/check', { id: s.id })).code).toBe(409);

    expect((await call('POST', '/api/actions/remove', { id: s.id })).body.ok).toBe(true);
    list = (await call('GET', '/api/actions', undefined, '?session=' + SID)).body;
    expect(list.steps[0]).toMatchObject({ status: 'removed', removed_from: 'done' });
    expect((await call('POST', '/api/actions/undo', { id: s.id })).body.ok).toBe(true);
    expect(withDb((db) => getStep(db, s.id))).toMatchObject({ status: 'done', removed_from: '' });
  });

  it('rejects an empty title, a missing session and an unknown step', async () => {
    expect((await call('POST', '/api/actions/add', { session: SID, title: '  ' })).code).toBe(400);
    expect((await call('POST', '/api/actions/add', { title: 'x' })).code).toBe(400);
    expect((await call('POST', '/api/actions/check', { id: 'a000000000ff' })).code).toBe(404);
  });

  it('ask-first flips the flag', async () => {
    await call('POST', '/api/actions/add', { session: 'sess-2', title: 'x' });
    const id = withDb((db) => listSteps(db, 'sess-2')[0].id);
    await call('POST', '/api/actions/ask-first', { id, on: true });
    expect(withDb((db) => getStep(db, id)?.ask_first)).toBe(true);
    await call('POST', '/api/actions/ask-first', { id, on: false });
    expect(withDb((db) => getStep(db, id)?.ask_first)).toBe(false);
  });

  it('run finishes a none step, and answers 409 for a send_draft step for now', async () => {
    withDb((db) => {
      addStep(db, { id: 'a00000000001', session_id: 'sess-3', title: 'Plain', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
      addStep(db, { id: 'a00000000002', session_id: 'sess-3', title: 'Send', when: 'manual', then: 'send-draft:d0123456789ab', ask_first: false, created_by: 'chat', at: 1 });
    });
    expect((await call('POST', '/api/actions/run', { id: 'a00000000001' })).body.ok).toBe(true);
    expect(withDb((db) => getStep(db, 'a00000000001')?.status)).toBe('done');
    const r = await call('POST', '/api/actions/run', { id: 'a00000000002' });
    expect(r.code).toBe(409);
    expect(r.body.detail).toBe('not available yet');
    expect((await call('POST', '/api/actions/retry', { id: 'a00000000002' })).code).toBe(409);
    expect(withDb((db) => getStep(db, 'a00000000002')?.status)).toBe('waiting');
  });

  it('retry on a failed step goes back to waiting, clears why and hold, and counts the attempt', async () => {
    withDb((db) => {
      addStep(db, { id: 'a00000000003', session_id: 'sess-4', title: 'R', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
      db.prepare(`UPDATE action_items SET status='failed', status_why='boom', held_rev='r1', attempts=1 WHERE id='a00000000003'`).run();
    });
    expect((await call('POST', '/api/actions/retry', { id: 'a00000000003' })).body.ok).toBe(true);
    expect(withDb((db) => getStep(db, 'a00000000003'))).toMatchObject({ status: 'waiting', status_why: '', held_rev: '', attempts: 2 });
    expect((await call('POST', '/api/actions/retry', { id: 'a00000000003' })).code).toBe(409);
  });

  it('actionSummary counts open steps and flags held or failed ones', () => {
    withDb((db) => {
      addStep(db, { id: 'a00000000004', session_id: 'sess-5', title: 'A', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
      addStep(db, { id: 'a00000000005', session_id: 'sess-5', title: 'B', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
      db.prepare(`UPDATE action_items SET status='held' WHERE id='a00000000005'`).run();
      db.prepare(`UPDATE action_items SET status='done' WHERE session_id='sess-1'`).run();
      const sum = actionSummary(db);
      expect(sum['sess-5']).toEqual({ open: 2, attention: true });
      expect(sum['sess-1']).toBeUndefined();
    });
  });
});

describe('panel markup', () => {
  const esc = (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  const view = new Function('esc', `${ACTIONS_PURE_JS}; ${ACTIONS_VIEW_JS}; return { stepRowHtml, actionsBodyHtml, railHeadHtml, stepLine, actChip };`)(esc) as any;
  const base = { id: 'a00000000001', title: 'Reply <b>', trigger_type: 'manual', trigger_params: {}, action_type: 'none', action_params: {}, ask_first: false, status: 'waiting', status_why: '' };

  it('escapes the title and shows the pill, summary and why', () => {
    const h = view.stepRowHtml({ ...base, status: 'failed', status_why: 'bad ref' });
    expect(h).toContain('Reply &lt;b>');
    expect(h).toContain('st-failed');
    expect(h).toContain('To do');
    expect(h).toContain('bad ref');
    expect(h).toContain('data-act="retry"');
  });
  it('links a held send_draft step to its outbox card, and shows Undo for a removed one', () => {
    const h = view.stepRowHtml({ ...base, status: 'held', trigger_type: 'draft_sent', trigger_params: { draft_id: 'd0123456789ab' }, action_type: 'send_draft', action_params: { draft_id: 'd0123456789ab' } });
    expect(h).toContain('data-act="draft" data-draft="d0123456789ab"');
    expect(h).toContain('When draft d0123456789ab is sent');
    expect(view.stepRowHtml({ ...base, status: 'removed' })).toContain('data-act="undo"');
  });
  it('the body ends with the add form, and the tabs carry both counts', () => {
    expect(view.actionsBodyHtml([])).toContain('data-actadd');
    const head = view.railHeadHtml('actions', [{}, {}], [base, { ...base, status: 'done' }]);
    expect(head).toContain('data-otab="actions"');
    expect(head).toContain('>1</span>'); // one open step
    expect(head).toContain('>2</span>'); // two drafts
  });
});
