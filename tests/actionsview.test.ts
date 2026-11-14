import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ACTIONS_PURE_JS, ACTIONS_VIEW_CSS, ACTIONS_VIEW_JS } from '../src/actionsview.ts';
import { routes, setActionsDeps, actionSummary } from '../src/routes/actions.ts';
import { applySchema } from '../src/schema.ts';
import { addStep, getStep, listSteps } from '../src/actions.ts';
import { renderDashboard } from '../src/dashboard.ts';
import { ROUTES } from '../src/routes/index.ts';
import type { RouteCtx } from '../src/routes/index.ts';

const lib = new Function(`${ACTIONS_PURE_JS}; return { stepPill, stepButtons, railTab, railTabFor, actAttention };`)() as {
  stepPill: (s: string) => { label: string; cls: string };
  stepButtons: (s: object) => string[];
  railTab: (drafts: unknown[], steps: unknown[], remembered: string) => string;
  railTabFor: (drafts: unknown[], steps: unknown[], pick: string, remembered: string) => string;
  actAttention: (a: unknown) => boolean;
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

describe('railTabFor', () => {
  const d = [{ id: 'd0123456789ab' }];
  it('keeps a manual pick only while its tab has content', () => {
    expect(lib.railTabFor(d, [{ status: 'waiting' }], 'outbox', '')).toBe('outbox');
    expect(lib.railTabFor([], [{ status: 'waiting' }], 'outbox', '')).toBe('actions'); // outbox emptied
    expect(lib.railTabFor(d, [], 'actions', '')).toBe('actions'); // the add form lives there
  });
  it('a step that goes held, failed or due pulls the rail back to Actions over a pick', () => {
    for (const status of ['held', 'failed', 'due']) expect(lib.railTabFor(d, [{ status }], 'outbox', 'outbox')).toBe('actions');
  });
  it('falls back to the remembered tab, then the default', () => {
    expect(lib.railTabFor(d, [{ status: 'waiting' }], '', 'actions')).toBe('actions');
    expect(lib.railTabFor(d, [{ status: 'waiting' }], '', '')).toBe('outbox');
  });
});

describe('row tint', () => {
  it('attention is the your-turn tint on the row itself, ahead of the waiting-on-you check', () => {
    expect(lib.actAttention({ open: 1, attention: true })).toBe(true);
    expect(lib.actAttention({ open: 1, attention: false })).toBe(false);
    expect(lib.actAttention(undefined)).toBe(false);
    const html = renderDashboard([], 1);
    expect(html).toContain("if(L.working)return 'd-working';if(actAttention((DATA.actions||{})[c.session_id]))return 'd-turn';");
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
  const DRAFTS: Record<string, { status: string; revised_at: string }> = { d0123456789ab: { status: 'pending', revised_at: 'R1' } };
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
      draft: (id) => DRAFTS[id] ?? null,
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

  it('run finishes a none step; on a due send_draft step it only approves, and a wake step is not available yet', async () => {
    withDb((db) => {
      addStep(db, { id: 'a00000000001', session_id: 'sess-3', title: 'Plain', when: 'manual', then: 'none', ask_first: false, created_by: 'chat', at: 1 });
      addStep(db, { id: 'a00000000002', session_id: 'sess-3', title: 'Send', when: 'manual', then: 'send-draft:d0123456789ab', ask_first: false, created_by: 'chat', at: 1 });
      addStep(db, { id: 'a00000000007', session_id: 'sess-3', title: 'Wake', when: 'manual', then: 'wake:"go"', ask_first: false, created_by: 'chat', at: 1 });
    });
    expect((await call('POST', '/api/actions/run', { id: 'a00000000001' })).body.ok).toBe(true);
    expect(withDb((db) => getStep(db, 'a00000000001')?.status)).toBe('done');
    // A waiting send step has nothing to run.
    expect((await call('POST', '/api/actions/run', { id: 'a00000000002' })).code).toBe(409);
    expect((await call('POST', '/api/actions/retry', { id: 'a00000000002' })).code).toBe(409);
    withDb((db) => db.prepare(`UPDATE action_items SET status = 'due', fired_at = 5 WHERE id = 'a00000000002'`).run());
    expect((await call('POST', '/api/actions/run', { id: 'a00000000002' })).body.ok).toBe(true);
    expect(withDb((db) => getStep(db, 'a00000000002'))).toMatchObject({ status: 'waiting', status_why: 'checking the thread before sending', approved_rev: 'R1' });
    expect(withDb((db) => getStep(db, 'a00000000002')?.fired_at)).toBeGreaterThan(0);
    const w = await call('POST', '/api/actions/run', { id: 'a00000000007' });
    expect(w.code).toBe(409);
    expect(w.body.detail).toBe('not available yet');
  });

  it('retry on a held send_draft step goes back to waiting and drops its Run approval', async () => {
    withDb((db) => {
      addStep(db, { id: 'a00000000006', session_id: 'sess-6', title: 'Send', when: 'now', then: 'send-draft:d0123456789ab', ask_first: true, created_by: 'chat', at: 1 });
      db.prepare(`UPDATE action_items SET status='held', status_why='held: wait', held_rev='r1', fired_at=9 WHERE id='a00000000006'`).run();
    });
    expect((await call('POST', '/api/actions/retry', { id: 'a00000000006' })).body.ok).toBe(true);
    expect(withDb((db) => getStep(db, 'a00000000006'))).toMatchObject({ status: 'waiting', held_rev: '', fired_at: 0, attempts: 1 });
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
  const view = new Function('esc', `${ACTIONS_PURE_JS}; ${ACTIONS_VIEW_JS}; return { stepRowHtml, actionsBodyHtml, railHeadHtml, stepLine, actChip, ACT_ERR };`)(esc) as any;
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
  it('shows a 409 detail inline on the row', () => {
    view.ACT_ERR[base.id] = 'not available yet';
    expect(view.stepRowHtml({ ...base, status: 'due' })).toContain('<div class="act-err" role="alert">not available yet</div>');
    delete view.ACT_ERR[base.id];
  });
  it('the body ends with the add form, and the tabs carry both counts', () => {
    expect(view.actionsBodyHtml([])).toContain('data-actadd');
    const head = view.railHeadHtml('actions', [{}, {}], [base, { ...base, status: 'done' }]);
    expect(head).toContain('data-otab="actions"');
    expect(head).toContain('>1</span>'); // one open step
    expect(head).toContain('>2</span>'); // two drafts
  });
});
