import { describe, it, expect } from 'vitest';
import vm from 'node:vm';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import { renderDashboard, type ChatView, type LiveLoc } from '../src/dashboard.ts';
import { WATCHER_VIEW_JS } from '../src/watcherview.ts';
import { insertWatcher, setStandingSid, validateDraft, type WatcherDraft } from '../src/watchers/model.ts';
import { isStandingChat, splitStanding, standingRefs } from '../src/standingchats.ts';
import { termToken } from '../src/ptybridge.ts';
import { createServer } from '../src/server.ts';

const T0 = 1_700_000_000_000;
const draft = (label: string, standing = true): WatcherDraft => ({
  label, enabled: false, run_mode: 'shadow', source: { kind: 'work', params: { url: 'https://findings.example.com/api/audit', sweep_first: true } },
  trigger: { kind: 'finding', params: { rules: [] } },
  action: { kind: 'start_chat', params: { project_dir: '/work/app', target: 'managed', brief_template: 'go', perm: 'inherit', standing } },
  max_per_hour: 0, cooldown_min: 0,
});
const add = (db: Database.Database, label: string, standing = true): string => {
  const v = validateDraft(draft(label, standing));
  if (!v.ok) throw new Error('invalid draft');
  return insertWatcher(db, v.draft, T0);
};
const event = (db: Database.Database, watcherId: string, key: string, sid: string) =>
  db.prepare(`INSERT INTO watcher_events (watcher_id, event_key, detected_at, decision, result, session_id) VALUES (?, ?, ?, 'fired', 'started', ?)`).run(watcherId, key, T0, sid);
const view = (sid: string, over: Partial<ChatView> = {}): ChatView => ({
  agent: 'claude', session_id: sid, project: 'acme-app', project_dir: '/r', jsonl_path: `/nope/${sid}.jsonl`, title: `chat ${sid}`,
  claude_auto_title: '', pr_url: '', overview: '', state: '', breakdown: [], first_message: '', message_count: 3,
  started_at: T0, last_active_at: T0, last_turn_at: T0, activity: {}, summary_pending: false, saved: false, saved_at: 0, tags: [], ...over,
});
const loc = (sid: string, over: Partial<LiveLoc> = {}): LiveLoc => ({
  agent: 'claude', session_id: sid, pane_id: '%' + sid, tmux_session: 'loom-x-1', window_index: '1', pane_index: '0', running: true, ...over,
});
function mem(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db);
  return db;
}

describe('standing chat identification', () => {
  it('a watcher\'s current standing_sid and the sessions it started earlier are standing chats; nothing else is', () => {
    const db = mem();
    const pm = add(db, 'Findings PM');
    const other = add(db, 'Per-event', false);
    setStandingSid(db, pm, 'sid-now', T0);
    event(db, pm, 'k1', 'sid-old');
    event(db, pm, 'k2', 'sid-now');
    event(db, other, 'k3', '');
    const refs = standingRefs(db);
    expect(Object.fromEntries(refs)).toEqual({
      'sid-now': { watcher_id: pm, label: 'Findings PM', current: true },
      'sid-old': { watcher_id: pm, label: 'Findings PM', current: false },
    });
    expect(isStandingChat(refs, { agent: 'claude', session_id: 'sid-now' })).toBe(true);
    expect(isStandingChat(refs, { agent: 'codex', session_id: 'sid-now' })).toBe(false);
    expect(isStandingChat(refs, { agent: 'claude', session_id: 'sid-mine' })).toBe(false);
  });

  it('a deleted watcher\'s chats are ordinary chats again, and an old table without the column still reads the current one', () => {
    const db = mem();
    const pm = add(db, 'Findings PM');
    event(db, 'gone-watcher', 'k1', 'sid-orphan');
    setStandingSid(db, pm, 'sid-now', T0);
    expect([...standingRefs(db).keys()]).toEqual(['sid-now']);
    db.exec(`ALTER TABLE watcher_events DROP COLUMN session_id`);
    expect([...standingRefs(db).keys()]).toEqual(['sid-now']);
  });
});

describe('board filter', () => {
  const refs = new Map([
    ['sid-now', { watcher_id: 'w1', label: 'Findings PM', current: true }],
    ['sid-old', { watcher_id: 'w1', label: 'Findings PM', current: false }],
    ['sid-dead', { watcher_id: 'w1', label: 'Findings PM', current: false }],
  ]);
  it('keeps every standing chat off the board, and hands the running ones over, current first', () => {
    const views = [view('mine'), view('sid-old', { last_active_at: T0 + 9 }), view('sid-now'), view('sid-dead')];
    const live = { 'claude:mine': loc('mine'), 'claude:sid-now': loc('sid-now'), 'claude:sid-old': loc('sid-old') };
    const { board, standing } = splitStanding(views, live, refs);
    expect(board.map((v) => v.session_id)).toEqual(['mine']);
    expect(standing.map((s) => [s.chat.session_id, s.current, s.label])).toEqual([['sid-now', true, 'Findings PM'], ['sid-old', false, 'Findings PM']]);
  });
  it('with no standing watchers the board is untouched', () => {
    const views = [view('a'), view('b')];
    expect(splitStanding(views, {}, new Map()).board).toBe(views);
  });

  it('/api/data leaves the standing chat out of chats', async () => {
    const db = openDb();
    const parsed = await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl'));
    upsertChat(db, parsed, 1000, 5000);
    const w = add(db, 'Board filter test');
    try {
      const sids = async () => ((await getData()).chats as { session_id: string }[]).map((c) => c.session_id);
      expect(await sids()).toContain('sess-abc');
      setStandingSid(db, w, 'sess-abc', T0);
      const d = await getData();
      expect((d.chats as { session_id: string }[]).map((c) => c.session_id)).not.toContain('sess-abc');
      expect(d.standing).toEqual([]); // not running: nothing for the Watchers tab either
    } finally {
      db.prepare(`DELETE FROM watchers WHERE id = ?`).run(w);
      db.close();
    }
  });
});

async function getData(): Promise<Record<string, unknown>> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  try {
    const r = await fetch(`http://127.0.0.1:${address.port}/api/data`, { headers: { origin: `http://127.0.0.1:${address.port}`, 'x-loom-token': termToken() } });
    return (await r.json()) as Record<string, unknown>;
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---- The page ----------------------------------------------------------------
const html = String(renderDashboard([], Date.now(), {}, 'claude'));
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
/** One top-level `function name(...){...}` of the page script, as source (they are one line each). */
function fnSrc(name: string): string {
  const m = script.match(new RegExp(`^function ${name}\\(.*$`, 'm'));
  if (!m) throw new Error(`no function ${name}`);
  return m[0];
}

interface FakeEl { className: string; title: string; text: string; attrs: Record<string, string>; children: FakeEl[]; onclick: ((e?: unknown) => void) | null; textContent: string; appendChild(c: FakeEl): FakeEl; setAttribute(k: string, v: string): void }
function el(tag: string): FakeEl {
  const e: FakeEl = {
    className: '', title: '', text: '', attrs: { tag }, children: [], onclick: null,
    get textContent() { return this.text; },
    set textContent(v: string) { this.text = v; this.children = []; },
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
  };
  return e;
}
const all = (e: FakeEl): FakeEl[] => [e, ...e.children.flatMap(all)];

/** The watcher view with the Board's real status logic (dotCls, DOT_LABEL, st, disp) and a fake DOM. */
function page(data: { standing: unknown[]; live: Record<string, Partial<LiveLoc>> }) {
  const slot = el('div');
  const opened: string[] = [];
  const ctx: any = vm.createContext({
    String, JSON, Date, Object, Array, Promise, Number,
    document: { createElement: el, getElementById: (id: string) => (id === 'wv-stand' ? slot : null) },
    DATA: { chats: [], actions: {}, ...data },
    TERM_TOKEN: 'tok', mtab: 'transcript',
    chatKey: (c: ChatView) => c.agent + ':' + c.session_id,
    parkedOf: () => null, actAttention: () => false,
    openInBoard: (sid: string, agent: string) => opened.push(agent + ':' + sid),
    renderMain: () => opened.push('renderMain'),
  });
  vm.runInContext(['st', 'dotCls', 'disp', 'standingTurnCount'].map(fnSrc).join('\n') + '\n' + script.match(/^const DOT_LABEL=.*$/m)![0].replace('const ', 'var '), ctx);
  vm.runInContext(WATCHER_VIEW_JS, ctx);
  return { ctx, slot, opened };
}

describe('Watchers tab', () => {
  const turn = { watcher_id: 'w1', label: 'Findings PM', current: true, chat: view('sid-now', { title: 'Findings PM: weekly audit', state: 'waiting_on_user' }) };
  const busy = { watcher_id: 'w2', label: 'Other', current: true, chat: view('sid-busy', { title: 'Sweep', state: 'waiting_on_user' }) };

  it('shows the watcher\'s chat with the board\'s status dot and title, and opens it the way the board does', () => {
    const { ctx, slot, opened } = page({ standing: [turn, busy], live: { 'claude:sid-now': loc('sid-now'), 'claude:sid-busy': loc('sid-busy', { working: true }) } });
    ctx.WV.sel = 'w1';
    ctx.wvStandingSync();
    expect(slot.children).toHaveLength(1);
    const row = slot.children[0];
    expect(row.className).toBe('wvstand turn cur'); // cur: the one the Chat tab's terminal shows
    expect(row.attrs['data-sid']).toBe('sid-now');
    const parts = all(row);
    expect(parts.find((p) => p.className.startsWith('sdot'))!.className).toBe('sdot d-turn');
    expect(parts.find((p) => p.className === 't')!.text).toBe('Findings PM: weekly audit');
    expect(parts.find((p) => p.className === 'wvstl')!.text).toBe('Your turn');
    const openBtn = parts.find((p) => p.attrs['data-open'] === '1')!;
    let stopped = false;
    openBtn.onclick!({ stopPropagation: () => { stopped = true; } });
    expect(stopped).toBe(true); // Open on Board does not also pick the row for the terminal
    expect(opened).toEqual(['claude:sid-now', 'renderMain']);
    expect(ctx.mtab).toBe('terminal');
    // Clicking the row itself picks that chat for the embedded terminal.
    row.onclick!();
    expect(ctx.WV.termSid).toBe('sid-now');
    // A working chat gets the working dot; another watcher's chat is not shown here.
    ctx.WV.sel = 'w2';
    ctx.wvStandingSync();
    expect(all(slot.children[0]).find((p) => p.className.startsWith('sdot'))!.className).toBe('sdot d-working');
    ctx.WV.sel = 'new';
    ctx.wvStandingSync();
    expect(slot.children).toHaveLength(0);
  });

  it('the Watchers tab badge counts standing chats waiting on you', () => {
    const { ctx } = page({ standing: [turn, busy], live: { 'claude:sid-now': loc('sid-now'), 'claude:sid-busy': loc('sid-busy', { working: true }) } });
    expect(ctx.standingTurnCount(ctx.DATA.standing, ctx.dotCls)).toBe(1);
    expect(ctx.standingTurnCount([], ctx.dotCls)).toBe(0);
    expect(ctx.standingTurnCount(undefined, ctx.dotCls)).toBe(0);
    expect(fnSrc('watchBadge')).toContain('standingTurnCount(DATA.standing,dotCls)');
  });

  it('a notification or a jump to a standing chat still finds it', () => {
    expect(fnSrc('selChat')).toContain('chatAny(');
    expect(script).toContain("window.loomOpenChat=function(agent,sid,retried){\n  const c=chatAny(agent,sid);");
  });
});
