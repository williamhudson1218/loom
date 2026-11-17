import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { getWatcher, insertWatcher, validateDraft, type WatcherDraft } from '../src/watchers/model.ts';
import { decide } from '../src/watchers/engine.ts';
import { enteringNeeds, needReasons, needText, watcherNeeds } from '../src/watchers/attention.ts';
import { WATCHER_VIEW_JS } from '../src/watcherview.ts';
import { renderDashboard } from '../src/dashboard.ts';

function mem(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}
const draft = (label: string, o: Partial<WatcherDraft> = {}): WatcherDraft => ({
  label, enabled: true, run_mode: 'shadow', source: { kind: 'slack', params: { channel: 'C0TESTCHAN', workspace: 'acme' } },
  trigger: { kind: 'phrase', params: { needle: 'deploy', any_author: false } },
  action: { kind: 'notify', params: { template: '{{TITLE}}' } },
  max_per_hour: 0, cooldown_min: 0, quiet_start: '', quiet_end: '', ...o,
});
function add(db: Database.Database, d: WatcherDraft): string {
  const v: any = validateDraft(d, { forEnable: false });
  if (!v.ok) throw new Error(v.detail);
  const id = insertWatcher(db, v.draft, 1);
  db.prepare('UPDATE watchers SET enabled = ? WHERE id = ?').run(d.enabled ? 1 : 0, id);
  return id;
}
function page(): any {
  const ctx: any = vm.createContext({});
  vm.runInContext(WATCHER_VIEW_JS, ctx);
  return ctx;
}

describe('when a watcher needs you', () => {
  it('your turn always; review and poll error only while it is on', () => {
    expect(needReasons({ enabled: true, turn: true, review: 3, error: true })).toEqual(['turn', 'review', 'error']);
    expect(needReasons({ enabled: false, turn: false, review: 3, error: true })).toEqual([]);
    expect(needReasons({ enabled: false, turn: true, review: 0, error: false })).toEqual(['turn']);
    expect(needReasons({ enabled: true, turn: false, review: 0, error: false })).toEqual([]);
  });

  it('the page applies the same rule (wvNeeds) as the tray and the notification (needReasons)', () => {
    const p = page();
    for (const enabled of [true, false])
      for (const turn of [true, false])
        for (const review of [0, 2])
          for (const error of [true, false]) {
            const w = { enabled, shadow_unreviewed: review, last_error: error ? 'HTTP 502' : '' };
            expect(p.wvNeeds(w, turn ? 'd-turn' : 'd-working'), JSON.stringify({ enabled, turn, review, error })).toEqual(needReasons({ enabled, turn, review, error }));
          }
  });

  it('reads as "<label>: <reason>"', () => {
    expect(needText({ label: 'Work PM', reasons: ['turn'], review: 0 })).toBe('Work PM: your turn');
    expect(needText({ label: 'Slack #filings', reasons: ['review'], review: 3 })).toBe('Slack #filings: 3 matches to review');
    expect(needText({ label: 'Audit findings', reasons: ['error'], review: 0 })).toBe('Audit findings: poll error');
    expect(needText({ label: 'X', reasons: ['review', 'error'], review: 1 })).toBe('X: 1 match to review, poll error');
  });

  it('finds them in the database: a standing chat on your turn, Shadow matches, a failed poll', () => {
    const db = mem();
    const pm = add(db, draft('Work PM', { action: { kind: 'start_chat', params: { project_dir: '/tmp/p', target: 'managed', brief_template: 'b', perm: 'inherit', standing: true } } as any }));
    db.prepare(`UPDATE watchers SET standing_sid = 'sid-pm' WHERE id = ?`).run(pm);
    const filings = add(db, draft('Slack #filings'));
    for (const k of ['a', 'b', 'c']) decide(db, getWatcher(db, filings)!, { key: k, subject: 'slack:' + k, title: 't', permalink: '', vars: {} } as any, { now: 1000 });
    const audit = add(db, draft('Audit findings'));
    db.prepare(`UPDATE watchers SET last_error = 'HTTP 502' WHERE id = ?`).run(audit);
    const paused = add(db, draft('Paused', { enabled: false }));
    db.prepare(`UPDATE watchers SET last_error = 'old' WHERE id = ?`).run(paused);
    add(db, draft('Quiet'));

    const views = [{ agent: 'claude', session_id: 'sid-pm', state: 'waiting_on_user' }];
    const needs = watcherNeeds(db, views, (k) => k === 'claude:sid-pm');
    expect(needs.map(needText).sort()).toEqual(['Audit findings: poll error', 'Slack #filings: 3 matches to review', 'Work PM: your turn']);
    // not live, or not its turn: the standing chat does not count
    expect(watcherNeeds(db, views, () => false).some((n) => n.id === pm)).toBe(false);
    expect(watcherNeeds(db, [{ ...views[0], state: 'done' }], () => true).some((n) => n.id === pm)).toBe(false);
    db.close();
  });

  it('notifies once on the way in: not at startup, not again while it stays', () => {
    const n = (id: string) => ({ id, label: id, reasons: ['error' as const], review: 0 });
    let r = enteringNeeds(null, [n('a')]);
    expect(r.entered).toEqual([]); // the first check only records
    r = enteringNeeds(r.next, [n('a'), n('b')]);
    expect(r.entered.map((x) => x.id)).toEqual(['b']);
    r = enteringNeeds(r.next, [n('a'), { ...n('b'), reasons: ['error', 'review'] as any }]);
    expect(r.entered).toEqual([]); // a new reason is not a new entry
    r = enteringNeeds(r.next, [n('a')]);
    r = enteringNeeds(r.next, [n('a'), n('b')]);
    expect(r.entered.map((x) => x.id)).toEqual(['b']); // left and came back: notified again
  });
});

describe('the signal in the page', () => {
  it('badge: one per watcher that needs you, amber when they are all only poll errors', () => {
    const p = page();
    p.DATA = { standing: [] };
    p.WATCH = { watchers: [{ id: 'a', enabled: true, shadow_unreviewed: 2, last_error: '' }, { id: 'b', enabled: true, shadow_unreviewed: 0, last_error: 'x' }, { id: 'c', enabled: true, shadow_unreviewed: 0, last_error: '' }] };
    expect(p.wvBadge()).toEqual({ n: 2, amber: false });
    p.WATCH.watchers[0].shadow_unreviewed = 0;
    expect(p.wvBadge()).toEqual({ n: 1, amber: true });
    const html = String(renderDashboard([], Date.now()));
    expect(html).toContain("if(typeof wvBadge==='function'&&(WATCH.watchers||[]).length)return wvBadge().n;");
    expect(html).toContain("d[0]==='watch'&&watchBadgeAmber()?' amber':''");
  });

  it('the list pins a Needs you group on top, with the reason on each row', () => {
    const p = page();
    expect(p.wvRowLine2({ enabled: true, shadow_unreviewed: 3, last_error: '' }, '').map((x: string[]) => x[1])).toEqual(['3 matches to review']);
    expect(p.wvRowLine2({ enabled: true, shadow_unreviewed: 0, last_error: 'x' }, 'd-turn').map((x: string[]) => x[1])).toEqual(['Chat waiting on you', 'Poll error']);
    expect(WATCHER_VIEW_JS).toContain("var nh=wvEl('div','wvgrp needs','Needs you · '+need.length)");
  });

  it('a notification click opens the Watchers tab on that watcher', () => {
    const main = fs.readFileSync(new URL('../app/main.ts', import.meta.url), 'utf8');
    expect(main).toContain("target && 'watcher' in target");
    expect(main).toContain('window.loomOpenWatcher(');
    expect(WATCHER_VIEW_JS).toContain("window.loomOpenWatcher=function(id){WV.pendingSel=String(id||'');tab='watch';");
    expect(WATCHER_VIEW_JS).toContain('if(WV.pendingSel&&wvById(WV.pendingSel))');
  });

  it('the tab fits the window: the root is sized to it and the panes scroll inside', () => {
    expect(WATCHER_VIEW_JS).toContain("window.addEventListener('resize',wvFit);");
    expect(WATCHER_VIEW_JS).toContain('r.style.height=h+');
    // Workers started lives in the left column now, not under the page
    expect(WATCHER_VIEW_JS).toContain("wvAdd(left,list,sp);");
  });
});
