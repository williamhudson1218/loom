import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { WATCHER_VIEW_CSS, WATCHER_VIEW_HTML, WATCHER_VIEW_JS } from '../src/watcherview.ts';
import { TRIGGERS, getWatcher, insertWatcher, replaceWatcher, validateDraft, type WatcherDraft } from '../src/watchers/model.ts';
import { watcherView } from '../src/routes/watchers.ts';
import { renderDashboard } from '../src/dashboard.ts';

// The page functions that touch no DOM, loaded the way the browser loads them.
function page(): any {
  const ctx: any = vm.createContext({ String, JSON, Date, Object, Array, Promise });
  vm.runInContext(WATCHER_VIEW_JS, ctx);
  return ctx;
}
const CR = String.fromCharCode(13);
const NASTY = [
  '', '  leading blank line and spaces', 'tab\there, trailing spaces   ', 'quotes " \' and </textarea> and <b>&amp;</b>',
  'backslash \\ \\n not a newline, {{WATCHER}} {{TITLE}} ${not} `tick`', 'unicode: 日本語 é ✅ 👀', 'x'.repeat(19_000), '', '',
].join('\n');

function mem(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}
const base = (brief: string): WatcherDraft => ({
  label: 'Round trip', enabled: false, run_mode: 'shadow', source: { kind: 'slack', params: { channel: 'C0TESTCHAN', workspace: 'acme' } },
  trigger: { kind: 'phrase', params: { needle: 'deploy', any_author: false } },
  action: { kind: 'start_chat', params: { project_dir: '/tmp/proj', target: 'managed', brief_template: brief, perm: 'inherit' } },
  max_per_hour: 3, cooldown_min: 15, quiet_start: '22:00', quiet_end: '07:00',
});

describe('watchers view', () => {
  it('has no backslash, backtick or dollar-brace (it is spliced into a template string)', () => {
    for (const part of [WATCHER_VIEW_CSS, WATCHER_VIEW_HTML, WATCHER_VIEW_JS]) {
      expect(part).not.toContain('\\');
      expect(part).not.toContain('`');
      expect(part).not.toContain('${');
    }
  });

  it('is valid script, names nobody, and writes only with fetch (clientfetch adds the token)', () => {
    expect(() => new vm.Script(WATCHER_VIEW_JS)).not.toThrow();
    expect(WATCHER_VIEW_JS).not.toMatch(/Will|Tax Pilot|Superset|willhudson|loom-tp/);
    expect(WATCHER_VIEW_JS).not.toContain('XMLHttpRequest');
    expect(WATCHER_VIEW_JS).not.toContain('sendBeacon');
    const calls = WATCHER_VIEW_JS.split('fetch(').length - 1;
    expect(calls).toBe(2); // wvPost and wvGet, nothing else
    expect(WATCHER_VIEW_JS).toContain("method:'POST'");
  });

  it('offers every trigger the model knows, with its params', () => {
    const t = page().WV_TRIGGERS;
    for (const [src, list] of Object.entries(TRIGGERS)) {
      expect(t[src].map((x: any) => x.kind)).toEqual(Object.keys(list));
      for (const x of t[src]) expect(Object.keys(x.defaults)).toEqual(Object.keys((list as any)[x.kind].defaults));
    }
  });

  it('is wired into the page: the tab renders through wvRender', () => {
    const html = String((renderDashboard as any)({ chats: [], live: [] }));
    expect(html).toContain('function wvRender()');
    expect(html).toContain("if(typeof wvRender==='function'){wvRender();return;}");
  });

  it('loads the full brief and saves it back byte for byte, with and without an edit elsewhere', () => {
    const p = page();
    const db = mem();
    const id = insertWatcher(db, validateDraft(base(NASTY)).ok ? (validateDraft(base(NASTY)) as any).draft : (() => { throw new Error('invalid'); })(), 1000);
    const wire = JSON.parse(JSON.stringify(watcherView(db, getWatcher(db, id)!))); // what GET /api/watchers sends
    expect(wire.action.params.brief_template).toBe(NASTY);
    const draft = p.wvDraftOf(wire);
    // an edit that is not the brief
    draft.label = 'Round trip, renamed';
    draft.max_per_hour = 4;
    const v: any = validateDraft(JSON.parse(JSON.stringify(p.wvPayload(draft))), { forEnable: false });
    expect(v.ok).toBe(true);
    replaceWatcher(db, id, v.draft, 2000);
    const saved = getWatcher(db, id)!;
    expect(saved.action.params.brief_template).toBe(NASTY);
    expect(saved.label).toBe('Round trip, renamed');
    expect(saved.max_per_hour).toBe(4);
    // and the stored JSON text is the same bytes
    const row = db.prepare('SELECT action_params FROM watchers WHERE id = ?').get(id) as { action_params: string };
    expect(JSON.parse(row.action_params).brief_template).toBe(NASTY);
    db.close();
  });

  it('a CRLF brief survives a typed edit (the textarea folds CRLF to LF, wvEol puts it back)', () => {
    const p = page();
    const orig = 'one' + CR + '\ntwo' + CR + '\nthree';
    expect(p.wvEol(orig, 'one\ntwo\nthree!')).toBe('one' + CR + '\ntwo' + CR + '\nthree!');
    expect(p.wvEol('a\nb', 'a\nb!')).toBe('a\nb!'); // LF briefs are left alone
    expect(p.wvEol('a' + CR + '\nb\nc', 'a\nb\nc!')).toBe('a\nb\nc!'); // mixed endings: not guessed at
  });

  it('every draft the page can build validates: new, each source and trigger, each action', () => {
    const p = page();
    const blank = p.wvBlank();
    expect(validateDraft(blank).ok).toBe(true);
    for (const src of ['slack', 'chats', 'prs']) {
      for (const t of p.wvTrigs(src)) {
        const d = p.wvBlank();
        p.wvSetSource(d, src);
        p.wvSetTrigger(d, t.kind);
        for (const a of ['start_chat', 'message_chat', 'notify', 'tell_orch']) {
          p.wvSetAction(d, a);
          const r: any = validateDraft(JSON.parse(JSON.stringify(d)));
          expect(r.ok, `${src}/${t.kind}/${a}: ${r.detail}`).toBe(true);
        }
      }
    }
  });

  it('keeps the brief text when the action kind changes', () => {
    const p = page();
    const d = p.wvBlank();
    d.action.params.template = 'hello {{TITLE}}';
    p.wvSetAction(d, 'start_chat');
    expect(d.action.params.brief_template).toBe('hello {{TITLE}}');
    p.wvSetAction(d, 'tell_orch');
    expect(d.action.params.template).toBe('hello {{TITLE}}');
  });

  it('asks for confirmation only when skip permissions is newly chosen', () => {
    const p = page();
    const a = p.wvDraftOf(JSON.parse(JSON.stringify(watcherView(mem(), (() => { const db = mem(); return getWatcher(db, insertWatcher(db, (validateDraft(base('b')) as any).draft, 1))!; })()))));
    const b = JSON.parse(JSON.stringify(a));
    b.action.params.perm = 'skip';
    expect(p.wvNeedsSkipConfirm(b, a)).toBe(true);
    expect(p.wvNeedsSkipConfirm(b, b)).toBe(false);
    expect(p.wvNeedsSkipConfirm(a, a)).toBe(false);
  });
});

describe('recent fires paging', () => {
  it('shows 20 at a time with a Show more button', () => {
    expect(WATCHER_VIEW_JS).toContain('firesShown:20');
    expect(WATCHER_VIEW_JS).toContain('WV.fires.slice(0,WV.firesShown)');
    expect(WATCHER_VIEW_JS).toContain('WV.firesShown+=20');
    expect(WATCHER_VIEW_JS).toContain("'Show more'");
  });
});
