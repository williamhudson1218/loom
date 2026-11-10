import { describe, expect, it } from 'vitest';
import { PENDING_VIEW_JS } from '../src/pendingview.ts';
import { renderDashboard } from '../src/dashboard.ts';

// Runs the page's Resume + pending code against stub page globals, with a fetch
// whose replies the test releases by hand, so "before the request resolves" can
// be asserted.
function page(chats: { agent: string; session_id: string }[] = []) {
  const els: Record<string, { id: string; className: string; innerHTML: string; onclick?: () => void; remove: () => void }> = {};
  const chatmain = {
    appendChild: (e: { id: string }) => {
      els['#' + e.id] = e as never;
    },
  };
  const doc = {
    createElement: () => {
      const e = { id: '', className: '', innerHTML: '', remove: () => delete els['#' + e.id] };
      return e;
    },
  };
  const $ = (q: string) => (q === '#chatmain' ? chatmain : els[q] ?? null);
  const calls: { url: string; resolve: (j: unknown) => void }[] = [];
  const beacons: { event: string; fields: Record<string, unknown> }[] = [];
  const fetchStub = (url: string, opts?: { body?: string }) => {
    if (url === '/api/pick-log') {
      const b = JSON.parse(opts?.body ?? '{}');
      beacons.push({ event: b.event, fields: b.fields });
      return Promise.resolve({ json: () => ({ ok: true }) });
    }
    return new Promise((res) => calls.push({ url, resolve: (j) => res({ json: () => j }) }));
  };
  const log: string[] = [];
  const DATA = { chats, live: {} as Record<string, unknown> };
  const lib = new Function(
    '$', 'document', 'fetch', 'DATA', 'esc', 'chatKey', 'refresh', 'renderMain', 'flash', 'launchVerb', 'openInBoard', 'setTimeout', 'window',
    `var mtab='transcript', TERM_TOKEN='tok', onlyGroup=null;${PENDING_VIEW_JS}
     return { doLaunch, setPending, pendingLiveFor, get mtab(){return mtab;}, get pending(){return PENDING;}, PENDING_LIVE };`,
  )(
    $, doc, fetchStub, DATA, (s: string) => String(s), (c: { agent: string; session_id: string }) => c.agent + ':' + c.session_id,
    () => { log.push('refresh'); return Promise.resolve(); },
    () => log.push('renderMain'),
    (_el: unknown, msg: string) => log.push('flash:' + msg),
    () => 'Resume',
    (sid: string) => log.push('open:' + sid),
    () => 0,
    {} as Record<string, unknown>,
  );
  const picker = { dataset: {} as Record<string, string>, innerHTML: '' };
  return { lib, els, calls, beacons, log, DATA, picker };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('Resume on the board', () => {
  it('says "Resuming…" on the click, before the request resolves', () => {
    const p = page();
    p.lib.doLaunch('s1', 'claude', '', {}, p.picker, 'resume', '', 'claude');
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].url).toMatch(/^\/resume\?session=s1&agent=claude&lane=&trace=r[a-z0-9]+$/);
    expect(p.els['#mpending'].innerHTML).toContain('Resuming…');
    expect(p.els['#mpending'].innerHTML).toContain('mpspin');
    expect(p.beacons.map((b) => b.event)).toEqual(['resume-click']);
  });
  it('opens the terminal on the pane the reply names, without waiting for the board to see it live', async () => {
    const p = page();
    p.lib.doLaunch('s1', 'claude', '', {}, p.picker, 'resume', '', 'claude');
    p.calls[0].resolve({ ok: true, detail: 'resumed; no focus', pane_id: '%77', managed: true });
    await tick();
    expect(p.lib.mtab).toBe('terminal');
    expect(p.lib.PENDING_LIVE['claude:s1'].pane_id).toBe('%77');
    expect(p.lib.pendingLiveFor({ agent: 'claude', session_id: 's1' })).toMatchObject({ pane_id: '%77', pending: true });
    expect(p.els['#mpending']).toBeUndefined();
    expect(p.log).toContain('renderMain');
    expect(p.log.indexOf('renderMain')).toBeLessThan(p.log.indexOf('refresh'));
    expect(p.beacons.map((b) => b.event)).toEqual(['resume-click', 'resume-reply', 'resume-view']);
  });
  it('drops the stand-in pane once the board sees the chat live', () => {
    const p = page();
    p.lib.PENDING_LIVE['claude:s1'] = { pane_id: '%77', at: Date.now() };
    p.DATA.live['claude:s1'] = { pane_id: '%77' };
    expect(p.lib.pendingLiveFor({ agent: 'claude', session_id: 's1' })).toBeNull();
    expect(p.lib.PENDING_LIVE['claude:s1']).toBeUndefined();
  });
  it('shows a failure in the main area, with a way to dismiss it', async () => {
    const p = page();
    p.lib.doLaunch('s1', 'claude', '', {}, p.picker, 'resume', '', 'claude');
    p.calls[0].resolve({ ok: false, detail: 'machine is short of memory' });
    await tick();
    const el = p.els['#mpending'];
    expect(el.className).toBe('err');
    expect(el.innerHTML).toContain('Could not resume this chat');
    expect(el.innerHTML).toContain('machine is short of memory');
    expect(el.innerHTML).not.toContain('mpspin');
    expect(p.lib.mtab).toBe('transcript');
  });
  it('a branch keeps the old flow: no stand-in pane (its session id is new)', async () => {
    const p = page();
    p.lib.doLaunch('s1', 'claude', '', {}, p.picker, 'branch', '', 'claude');
    expect(p.els['#mpending']).toBeUndefined();
    p.calls[0].resolve({ ok: true, pane_id: '%9' });
    await tick();
    expect(p.lib.PENDING_LIVE['claude:s1']).toBeUndefined();
  });
});

describe('the page script', () => {
  it('inlines the pending view and refreshes when the window is shown again', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude', [], [], 'tok');
    expect(html).toContain('window.loomOpenResumed=function');
    expect(html).toContain('window.loomFocusNow=function');
    expect(html).toContain("document.addEventListener('visibilitychange'");
    expect(html).toContain('#chatmain.empty > :not(#mempty):not(#mpending)');
  });
});

describe('the terminal follows the selected chat', () => {
  it('re-aligns its view on every render of the same chat and when taken from the warm pool', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude', [], [], 'tok');
    expect(html).toContain("if(termKey===key){alignTerm();return;}");
    expect(html).toContain('try{e.fit.fit();}catch(x){}alignTerm();e.term.focus();');
    expect(html).toContain("termWs.send(JSON.stringify({t:'a'}))");
  });
});
