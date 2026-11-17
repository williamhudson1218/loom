import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { WATCHER_VIEW_CSS, WATCHER_VIEW_HTML, WATCHER_VIEW_JS } from '../src/watcherview.ts';
import { TRIGGERS, getWatcher, insertWatcher, pollNow, replaceWatcher, validateDraft, type WatcherDraft } from '../src/watchers/model.ts';
import { pollEveryMs, watcherView } from '../src/routes/watchers.ts';
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
    for (const src of ['slack', 'chats', 'prs', 'work']) {
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

describe('standing chat terminal on the Watchers tab', () => {
  const chat = (sid: string) => ({ agent: 'claude', session_id: sid });
  const list = [
    { watcher_id: 'w1', current: true, chat: chat('cur') },
    { watcher_id: 'w1', current: false, chat: chat('old') },
  ];
  const live = { 'claude:cur': { pane_id: '%42' }, 'claude:old': { pane_id: '%7' } };

  it('plans the current chat, or the one picked, keyed so it never collides with the board or orchestrator', () => {
    const p = page();
    expect(p.wvTermPlan(list, '', live, 'tok')).toMatchObject({ pane: '%42', key: 'wv|%42' });
    expect(p.wvTermPlan(list, 'old', live, 'tok')).toMatchObject({ pane: '%7', key: 'wv|%7' });
    expect(p.wvTermPlan(list, 'gone', live, 'tok').pane).toBe('%42');
  });

  it('says plainly why there is no terminal instead of showing a blank box', () => {
    const p = page();
    expect(p.wvTermPlan([], '', live, 'tok')).toEqual({ msg: expect.stringContaining('No chat is running') });
    const nopane = p.wvTermPlan(list, '', {}, 'tok');
    expect(nopane.key).toBeUndefined();
    expect(nopane.msg).toContain('no live pane');
    const notoken = p.wvTermPlan(list, '', live, '');
    expect(notoken.key).toBeUndefined();
    expect(notoken.msg).toContain('Open on Board');
  });

  it('gives a standing watcher a Chat tab, opened first; others open on History', () => {
    const p = page();
    const standing = { action: { kind: 'start_chat', params: { standing: true } } };
    const oneShot = { action: { kind: 'start_chat', params: { standing: false } } };
    expect(p.wvHasChat(standing, [])).toBe(true);
    expect(p.wvHasChat(oneShot, [])).toBe(false);
    expect(p.wvHasChat(oneShot, list)).toBe(true); // switched off standing, but its chat still runs
    expect(p.wvHasChat({ action: { kind: 'notify', params: {} } }, [])).toBe(false);
    expect(p.wvPaneFor('', true)).toBe('chat');
    expect(p.wvPaneFor('', false)).toBe('history');
    expect(p.wvPaneFor('chat', false)).toBe('history');
    expect(p.wvPaneFor('settings', true)).toBe('settings');
  });

  it('opens with openTerm into its own host and closes on leaving the tab', () => {
    expect(WATCHER_VIEW_JS).toContain('openTerm(plan.pane,WV.termHost);termKey=plan.key;');
    expect(WATCHER_VIEW_JS).toContain("if(termKey.indexOf('wv|')===0)closeTerm();");
    const html = String(renderDashboard([], Date.now()));
    expect(html).toContain("function render(){if(tab!=='watch'&&typeof wvLeave==='function')wvLeave();");
    // a late board poll must not take the terminal back while the Watchers tab shows it
    expect(html).toContain("if(tab==='watch'&&termKey.indexOf('wv|')===0)return;");
    // a parked view reopened in a different host moves there
    expect(html).toContain('if(e.col.parentNode!==el){el.appendChild(e.col);');
  });

  it('list rows read at a glance: last poll time, off when off', () => {
    const p = page();
    const now = 10_000_000;
    expect(p.wvPollText({ enabled: false, last_poll_at: now }, now)).toBe('Off');
    expect(p.wvPollText({ enabled: true, last_poll_at: 0 }, now)).toBe('Not polled yet');
    expect(p.wvPollText({ enabled: true, last_poll_at: now - 20_000 }, now)).toBe('Polled just now');
    expect(p.wvPollText({ enabled: true, last_poll_at: now - 5 * 60_000 }, now)).toBe('Polled 5 min ago');
    expect(p.wvAgo(now - 3 * 3_600_000, now)).toBe('3 h ago');
    expect(p.wvAgo(now - 72 * 3_600_000, now)).toBe('3 d ago');
  });
});

describe('watchers tab layout text', () => {
  const W = (o: any) => ({ enabled: true, run_mode: 'live', source: { kind: 'slack', params: {} }, poll_every_ms: 60_000, last_poll_at: 0, shadow_unreviewed: 0, last_error: '', skip_permissions: false, ...o });
  const now = 10_000_000;

  it('list row: "<source kind> · every N · polled X ago", and a second line only when something wants you', () => {
    const p = page();
    expect(p.wvRowLine1(W({ last_poll_at: now - 120_000 }), now)).toBe('Slack · every 1 min · polled 2 min ago');
    expect(p.wvRowLine1(W({ source: { kind: 'prs', params: {} }, poll_every_ms: 15_000, enabled: false }), now)).toBe('Pull requests · every 15 s · not polling');
    expect(p.wvRowLine1(W({ source: { kind: 'work', params: {} }, poll_every_ms: 900_000 }), now)).toBe('Findings endpoint · every 15 min · not polled yet');
    expect(p.wvRowLine2(W({}), 'd-working')).toEqual([]);
    expect(p.wvRowLine2(W({ shadow_unreviewed: 1, last_error: 'x' }), 'd-turn').map((x: string[]) => x[1])).toEqual(['1 match to review', 'Poll error', 'Chat waiting on you']);
  });

  it('header line says what the action does: standing chat, lane, skill', () => {
    const p = page();
    const d = { action: { kind: 'start_chat', params: { standing: true, project_dir: '/p/web', target: 'lane:main', invoke: { kind: 'skill', name: 'triage', args: '' } } } };
    expect(p.wvActionLine(d, [{ path: '/p/web', name: 'web' }])).toBe('Standing chat · web · lane main · /triage');
    expect(p.wvActionLine({ action: { kind: 'start_chat', params: { project_dir: '', target: 'managed' } } }, [])).toBe('New chat per match · new managed window · brief');
    expect(p.wvActionLine({ action: { kind: 'notify', params: {} } }, [])).toBe('Mac notification');
  });

  it('Settings cards collapse to a one-line summary', () => {
    const p = page();
    p.WV.chan = { C1: 'ops' };
    const d = p.wvBlank();
    d.source.params = { channel: 'C1', workspace: 'acme' };
    d.trigger.params = { needle: 'deploy failed', any_author: true };
    expect(p.wvSourceSum(d)).toBe('#ops in acme');
    expect(p.wvTriggerSum(d)).toContain('Phrase: "deploy failed"');
    expect(p.wvTriggerSum(d)).toContain('Include posts by bots');
    expect(p.wvLimitsSum(d)).toBe('6 per hour · 60 min cooldown · no quiet hours');
    d.quiet_start = '22:00'; d.quiet_end = '07:00'; d.max_per_hour = 0;
    expect(p.wvLimitsSum(d)).toBe('No hourly cap · 60 min cooldown · quiet 22:00 to 07:00');
  });

  it('Chat status line: pane name and the last batch', () => {
    const p = page();
    const fires = [{ result: 'failed', detected_at: now - 60_000 }, { result: 'started', detected_at: now - 20 * 60_000 }];
    expect(p.wvChatMeta({ pane_id: '%4', name: 'blue-vanilla' }, fires, now)).toBe('pane blue-vanilla · last batch 20 min ago');
    expect(p.wvChatMeta({ pane_id: '%4' }, [], now)).toBe('pane %4');
    expect(p.wvChatMeta(null, [], now)).toBe('');
  });

  it('Run now asks the server to poll on the next tick; delete lives in More', () => {
    expect(WATCHER_VIEW_JS).toContain("wvPost('/api/watchers/run-now',{id:WV.sel})");
    expect(WATCHER_VIEW_JS).toContain("mn.id='wv-menu'");
    expect(WATCHER_VIEW_JS.indexOf("del.id='wv-delete';mn.appendChild(del)")).toBeGreaterThan(0);
  });
});

describe('run now', () => {
  it('clears the schedule of an enabled watcher, refuses a paused one', () => {
    const db = mem();
    const id = insertWatcher(db, (validateDraft({ ...base('b'), enabled: true }) as any).draft, 1);
    db.prepare('UPDATE watchers SET enabled = 1, next_poll_at = 999999 WHERE id = ?').run(id);
    expect(pollNow(db, id)).toBe('ok');
    expect((db.prepare('SELECT next_poll_at FROM watchers WHERE id = ?').get(id) as any).next_poll_at).toBe(0);
    db.prepare('UPDATE watchers SET enabled = 0, next_poll_at = 5 WHERE id = ?').run(id);
    expect(pollNow(db, id)).toBe('off');
    expect((db.prepare('SELECT next_poll_at FROM watchers WHERE id = ?').get(id) as any).next_poll_at).toBe(5);
    expect(pollNow(db, 'nope')).toBe('missing');
    db.close();
  });

  it('the page is told how often each source polls', () => {
    expect(pollEveryMs('slack')).toBe(60_000);
    expect(pollEveryMs('work')).toBe(15 * 60_000);
    expect(pollEveryMs('chats')).toBe(15_000);
    expect(pollEveryMs('prs')).toBe(15_000);
    const db = mem();
    const id = insertWatcher(db, (validateDraft(base('b')) as any).draft, 1);
    expect(watcherView(db, getWatcher(db, id)!).poll_every_ms).toBe(60_000);
    db.close();
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
