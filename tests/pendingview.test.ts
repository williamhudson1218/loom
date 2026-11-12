import { describe, expect, it, vi } from 'vitest';
import { PENDING_VIEW_JS } from '../src/pendingview.ts';
import { renderDashboard } from '../src/dashboard.ts';

// Runs the page's Resume + pending code against stub page globals, with a fetch
// whose replies the test releases by hand, so "before the request resolves" can
// be asserted.
function page(chats: { agent: string; session_id: string }[] = [], extraDoc: Record<string, unknown> = {}) {
  const els: Record<string, { id: string; className: string; innerHTML: string; onclick?: () => void; remove: () => void }> = {};
  const chatmain = {
    appendChild: (e: { id: string }) => {
      els['#' + e.id] = e as never;
    },
  };
  const doc = {
    ...extraDoc,
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
  const win: Record<string, unknown> = {};
  const timers: (() => void)[] = [];
  let refreshes = 0;
  const lib = new Function(
    '$', 'document', 'fetch', 'DATA', 'esc', 'chatKey', 'refresh', 'renderMain', 'flash', 'launchVerb', 'openInBoard', 'setTimeout', 'window',
    `var mtab='transcript', TERM_TOKEN='tok', onlyGroup=null;${PENDING_VIEW_JS}
     return { doLaunch, setPending, pendingLiveFor, get mtab(){return mtab;}, get pending(){return PENDING;}, PENDING_LIVE };`,
  )(
    $, doc, fetchStub, DATA, (s: string) => String(s), (c: { agent: string; session_id: string }) => c.agent + ':' + c.session_id,
    () => { log.push('refresh'); refreshes++; return Promise.resolve(); },
    () => log.push('renderMain'),
    (_el: unknown, msg: string) => log.push('flash:' + msg),
    () => 'Resume',
    (sid: string) => log.push('open:' + sid),
    (fn: () => void) => { timers.push(fn); return 0; },
    win,
  );
  const picker = { dataset: {} as Record<string, string>, innerHTML: '' };
  return { lib, els, calls, beacons, log, DATA, picker, win, timers, get refreshes() { return refreshes; } };
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

describe('a chat resumed by the Slack hotkey', () => {
  type Open = (agent: string, sid: string, pane: string) => boolean;
  const flush = async () => { for (let i = 0; i < 5; i++) await tick(); };
  it('shows Opening and keeps looking when the chat is not on the board yet, then opens it', async () => {
    const p = page();
    const open = p.win.loomOpenResumed as Open;
    expect(open('claude', 's1', '%5')).toBe(true);
    expect(p.els['#mpending'].className).toBe('');
    expect(p.els['#mpending'].innerHTML).toContain('Opening this chat');
    await flush();
    expect(p.refreshes).toBeGreaterThan(0);
    p.DATA.chats.push({ agent: 'claude', session_id: 's1' });
    p.timers.shift()?.();
    await flush();
    expect(p.log).toContain('open:s1');
    expect(p.els['#mpending']).toBeUndefined();
    expect(p.lib.PENDING_LIVE['claude:s1'].pane_id).toBe('%5');
  });
  it('gives up after 25 seconds, not a minute, with an error naming the pane that Dismiss clears', async () => {
    const p = page();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000_000);
    (p.win.loomOpenResumed as Open)('claude', 's1', '%5');
    await flush();
    now.mockReturnValue(1_000_000 + 20_000);
    p.timers.shift()?.();
    await flush();
    expect(p.els['#mpending'].className).toBe('');
    now.mockReturnValue(1_000_000 + 26_000);
    p.timers.shift()?.();
    await flush();
    now.mockRestore();
    expect(p.els['#mpending'].className).toBe('err');
    expect(p.els['#mpending'].innerHTML).toContain('did not appear on the board within 25 seconds');
    expect(p.els['#mpending'].innerHTML).toContain('pane %5');
    expect(p.els['#mpending'].innerHTML).toContain('id="mppane"');
    expect(p.els['#mpending'].innerHTML).toContain('id="mpclose"');
    expect(p.els['#mpending'].innerHTML).not.toContain('!');
    expect(p.timers).toHaveLength(0); // it stops polling
    p.lib.setPending(null);
    expect(p.els['#mpending']).toBeUndefined();
  });
  it('fails at once, with the pane output, when the resumed chat exited (No conversation found)', async () => {
    const g = globalThis as Record<string, unknown>;
    g.snapFetch = () => Promise.resolve({ screen: '\x1b[1m❯\x1b[0m claude --resume d43a5f94\nNo conversation found with session ID: d43a5f94\n❯ ' });
    try {
      const p = page();
      (p.win.loomOpenResumed as Open)('claude', 'd43a5f94-0000', '%1327');
      await flush();
      expect(p.els['#mpending'].className).toBe('err');
      expect(p.els['#mpending'].innerHTML).toContain('exited as soon as it started');
      expect(p.lib.pending.output).toContain('No conversation found with session ID: d43a5f94');
      expect(p.lib.pending.output).not.toContain('\x1b');
      expect(p.lib.pending.pane).toBe('%1327');
      expect(p.timers).toHaveLength(0);
    } finally {
      delete g.snapFetch;
    }
  });
  it('Escape and a click outside the card clear a waiting card, and the poll stops', async () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const p = page([], { addEventListener: (type: string, fn: (e: unknown) => void) => { handlers[type] = fn; } });
    (p.win.loomOpenResumed as Open)('claude', 's1', '');
    expect(p.els['#mpending']).toBeDefined();
    handlers.keydown({ key: 'Escape' });
    expect(p.els['#mpending']).toBeUndefined();
    const before = p.refreshes;
    p.timers.shift()?.();
    await flush();
    expect(p.refreshes).toBe(before);
    (p.win.loomOpenResumed as Open)('claude', 's2', '');
    const inCard = { closest: (q: string) => (q === '.mpcard' ? {} : null) };
    handlers.click({ target: inCard });
    expect(p.els['#mpending']).toBeDefined();
    const outside = { closest: () => null };
    handlers.click({ target: outside });
    expect(p.els['#mpending']).toBeUndefined();
  });
  it('a chat the hotkey started waits the same way, and a failure says started, not resumed', async () => {
    type OpenHow = (agent: string, sid: string, pane: string, retried: boolean, how: string) => boolean;
    const p = page();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(2_000_000);
    expect((p.win.loomOpenResumed as OpenHow)('claude', 'abcd1234-0000', '%1397', false, 'started')).toBe(true);
    expect(p.els['#mpending'].innerHTML).toContain('Opening this chat');
    await flush();
    now.mockReturnValue(2_000_000 + 26_000);
    p.timers.shift()?.();
    await flush();
    now.mockRestore();
    expect(p.els['#mpending'].className).toBe('err');
    expect(p.els['#mpending'].innerHTML).toContain('Loom started session abcd1234 in pane %1397');
    expect(p.els['#mpending'].innerHTML).not.toContain('resumed');
  });
  it('stops looking once the card is dismissed or replaced', async () => {
    const p = page();
    (p.win.loomOpenResumed as Open)('claude', 's1', '');
    await flush();
    p.lib.setPending(null);
    const before = p.refreshes;
    p.timers.shift()?.();
    await flush();
    expect(p.refreshes).toBe(before);
    expect(p.els['#mpending']).toBeUndefined();
  });
});

describe('the page script', () => {
  it('inlines the pending view and refreshes when the window is shown again', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude', [], [], 'tok');
    expect(html).toContain('window.loomOpenResumed=function');
    expect(html).toContain('window.loomFocusNow=function');
    expect(html).toContain("document.addEventListener('visibilitychange'");
    expect(html).toContain('#chatmain.empty > :not(#mempty):not(#mpending)');
    expect(html).toContain('#mpending.err { pointer-events:none;');
    expect(html).toContain("t.closest('#mpclose')");
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
