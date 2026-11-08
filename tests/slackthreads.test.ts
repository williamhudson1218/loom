import { describe, it, expect } from 'vitest';
import { mergeChatThreads, primaryThread, refsFromText, slackCounts, threadLabel, type MergeInput } from '../src/slackthreads.ts';
import { SLACK_MENU_PURE_JS } from '../src/slackmenu.ts';
import { CHAT_MENU_JS } from '../src/chatmenu.ts';
import { renderDashboard } from '../src/dashboard.ts';

const base = (o: Partial<MergeInput> = {}): MergeInput => ({
  owned: [], drafts: [], parked: null, mentions: [],
  channelLabel: (c) => ({ C1: '#ops', C2: '#dev', D1: '@sam' })[c] ?? c,
  rootText: () => null,
  ...o,
});
const U = (c: string, ts: string) => `https://x.slack.com/archives/${c}/p${ts.replace('.', '')}`;

describe('threadLabel', () => {
  it('uses the first 60 chars of the parent on one line', () => {
    const l = threadLabel('  line one\n\nline   two ' + 'x'.repeat(100), '#a', '1700000000.000100');
    expect(l.length).toBe(60);
    expect(l.endsWith('…')).toBe(true);
    expect(l.startsWith('line one line two')).toBe(true);
  });
  it('falls back to channel and date with no text', () => {
    expect(threadLabel(null, '#ops', '1700000000.000100')).toBe('#ops thread 2023-11-14');
    expect(threadLabel('   ', '@kam', 'bad')).toBe('@kam thread');
  });
});

describe('mergeChatThreads', () => {
  const k1 = 'C1/1700000100.000100', k2 = 'C2/1700000200.000100', k3 = 'D1/1700000300.000100', k4 = 'C1/1700000050.000100';
  it('dedupes by key, strongest role wins, flags set from their own source', () => {
    const out = mergeChatThreads(base({
      owned: [{ key: k1, url: U('C1', '1700000100.000100'), source: 'index', at: 5000, preview: 'ach retry' }],
      drafts: [{ key: k1, url: U('C1', '1700000100.000100'), at: 9000 }, { key: k3, url: U('D1', '1700000300.000100'), at: 8000 }],
      parked: { key: k3, url: U('D1', '1700000300.000100'), at: 7000 },
      mentions: [{ key: k1, url: '' }, { key: k2, url: U('C2', '1700000200.000100') }],
    }));
    expect(out.map((t) => t.key)).toEqual([k1, k3, k2]);
    expect(out[0]).toMatchObject({ role: 'owner', draft: true, parked: false, label: 'ach retry', channelLabel: '#ops' });
    expect(out[1]).toMatchObject({ role: 'draft', draft: true, parked: true, channelLabel: '@sam' });
    expect(out[2]).toMatchObject({ role: 'replying', pending: true });
  });
  it('puts owned and started first, then most recent first', () => {
    const out = mergeChatThreads(base({
      owned: [
        { key: k4, url: '', source: 'index', at: 1000, preview: 'old owned' },
        { key: k1, url: '', source: 'send', at: 4000, preview: 'started' },
      ],
      drafts: [{ key: k3, url: '', at: 99_000_000_000_000 }],
      mentions: [{ key: k2, url: '' }],
    }));
    expect(out.map((t) => [t.key, t.role])).toEqual([[k1, 'started'], [k4, 'owner'], [k3, 'draft'], [k2, 'replying']]);
  });
  it('labels from the fetched root, then the fallback', () => {
    const out = mergeChatThreads(base({ mentions: [{ key: k2, url: '' }, { key: k3, url: '' }], rootText: (k) => (k === k2 ? 'hello world' : null) }));
    const by = Object.fromEntries(out.map((t) => [t.key, t]));
    expect(by[k2]).toMatchObject({ label: 'hello world', pending: false });
    expect(by[k3].label).toBe('@sam thread 2023-11-14');
  });
  it('picks the primary: draft, then parked, then newest owned', () => {
    const owned = [{ key: k1, url: '', source: 'index', at: 4000, preview: 'a' }, { key: k4, url: '', source: 'index', at: 1000, preview: 'b' }];
    expect(primaryThread(mergeChatThreads(base({ owned })))!.key).toBe(k1);
    expect(primaryThread(mergeChatThreads(base({ owned, parked: { key: k2, url: '', at: 1 } })))!.key).toBe(k2);
    expect(primaryThread(mergeChatThreads(base({ owned, parked: { key: k2, url: '', at: 1 }, drafts: [{ key: k3, url: '', at: 1 }] })))!.key).toBe(k3);
    expect(primaryThread([])).toBeNull();
  });
});

describe('transcript mentions and counts', () => {
  it('finds distinct threads, newest mention first, reply links resolve to their root', () => {
    const t = `see ${U('C1', '1700000100.000100')} and https://x.slack.com/archives/C2/p1700000999000200?thread_ts=1700000200.000100&cid=C2 then ${U('C1', '1700000100.000100')}`;
    expect(refsFromText(t).map((r) => r.key)).toEqual(['C1/1700000100.000100', 'C2/1700000200.000100']);
  });
  it('counts owned, draft and parked threads once each', () => {
    const owned = { 'C1/1700000100.000100': { session_id: 's1' }, 'C2/1700000200.000100': { session_id: 's1' }, 'C1/1700000500.000100': { session_id: 's2' } };
    const c = slackCounts(owned, [{ session_id: 's1', thread_url: U('C1', '1700000100.000100') }, { session_id: 's3', thread_url: U('D1', '1700000300.000100') }], [{ session_id: 's1', thread_url: U('D1', '1700000300.000100') }]);
    expect(c).toEqual({ s1: 3, s2: 1, s3: 1 });
  });
});

const lib = new Function(`${SLACK_MENU_PURE_JS}; return { slackRefOf, slackThreadList, slackPrimary, slackBtnMode, slackAgeOf, slackNav };`)() as any;

describe('page-side split-button rules', () => {
  const t = (key: string, role: string, extra: object = {}) => ({ key, url: '', channel: key.split('/')[0], ts: key.split('/')[1], role, channelLabel: '#c', label: key, lastAt: Number(key.split('/')[1].split('.')[0]) * 1000, draft: false, parked: false, pending: false, ...extra });
  it('mode follows the count', () => {
    expect([0, 1, 2, 5].map(lib.slackBtnMode)).toEqual(['none', 'single', 'split', 'split']);
  });
  it('parses permalinks with string methods', () => {
    expect(lib.slackRefOf('https://x.slack.com/archives/C9/p1700000100000100')).toMatchObject({ key: 'C9/1700000100.000100', channel: 'C9' });
    expect(lib.slackRefOf('https://x.slack.com/archives/C9/p1700000999000200?thread_ts=1700000100.000100').key).toBe('C9/1700000100.000100');
    expect(lib.slackRefOf('https://x.com/nope')).toBeNull();
  });
  it('adds the board-known draft and parked threads without duplicating', () => {
    const base = [t('C1/1700000100.000100', 'owner'), t('C2/1700000200.000100', 'owner')];
    const l = lib.slackThreadList(base, { key: 'C2/1700000200.000100', url: 'https://x.slack.com/archives/C2/p1700000200000100' }, 'https://x.slack.com/archives/C3/p1700000300000100', 0);
    expect(l.map((x: any) => [x.key, x.role, x.draft, x.parked])).toEqual([
      ['C2/1700000200.000100', 'owner', true, false], ['C1/1700000100.000100', 'owner', false, false], ['C3/1700000300.000100', 'parked', false, true],
    ]);
    expect(base[1].draft).toBe(false);
  });
  it('main button opens draft, then parked, then newest owned', () => {
    const a = t('C1/1700000100.000100', 'owner'), b = t('C2/1700000200.000100', 'owner'), p = t('C3/1700000300.000100', 'parked', { parked: true }), d = t('C4/1700000400.000100', 'draft', { draft: true });
    expect(lib.slackPrimary([b, a]).key).toBe(b.key);
    expect(lib.slackPrimary([b, a, p]).key).toBe(p.key);
    expect(lib.slackPrimary([b, a, p, d]).key).toBe(d.key);
    expect(lib.slackPrimary([])).toBeNull();
  });
  it('keyboard navigation wraps', () => {
    expect([lib.slackNav(2, 'ArrowDown', 3), lib.slackNav(0, 'ArrowUp', 3), lib.slackNav(1, 'Home', 3), lib.slackNav(1, 'End', 3), lib.slackNav(1, 'x', 3)]).toEqual([0, 2, 0, 2, 1]);
  });
  it('ages are compact', () => {
    expect([lib.slackAgeOf(0, 1e6), lib.slackAgeOf(1e6 - 30_000, 1e6), lib.slackAgeOf(1e6 - 300_000, 1e6), lib.slackAgeOf(1e6 - 7_200_000, 1e6), lib.slackAgeOf(1e6 - 3 * 86_400_000, 1e6)]).toEqual(['', 'now', '5m', '2h', '3d']);
  });
});

describe('menu and page wiring', () => {
  const items = new Function(`${CHAT_MENU_JS}; return chatMenuItems;`)() as (x: object) => any[];
  it('Open Slack thread is a submenu only with two or more threads', () => {
    const s = (x: object) => items({ hasSlack: true, ...x }).find((i) => i.key === 'slack');
    expect(s({ slackCount: 1 })).toMatchObject({ submenu: false, hint: '' });
    expect(s({ slackCount: 3 })).toMatchObject({ submenu: true, hint: '3 ▸' });
  });
  it('the page embeds the picker and the Slack dropdown', () => {
    const html = renderDashboard([], 1);
    expect(html).toContain('id="slackdd"');
    expect(html).toContain('function slackThreadsOf(c)');
    expect(html).toContain("Slack'+(slackCountOf(c)>1");
  });
});

import { isOrchestratorRef } from '../src/orchsession.ts';
import { provisionalViews, LiveIndexer } from '../src/liveindex.ts';

describe('the orchestrator stays out of chat lists', () => {
  const dir = '/home/x/.loom/orchestrator';
  const run = (args: string[]) => (args.includes('%9') ? 'orchestrator\n' : '\n');
  it('is recognised by session id, cwd or pane role', () => {
    expect(isOrchestratorRef({ session_id: 'o1' }, 'o1', { dir })).toBe(true);
    expect(isOrchestratorRef({ session_id: 'a', cwd: dir }, '', { dir })).toBe(true);
    expect(isOrchestratorRef({ session_id: 'a', project_dir: dir + '/sub' }, '', { dir })).toBe(true);
    expect(isOrchestratorRef({ session_id: 'a', pane_id: '%9' }, '', { dir, run })).toBe(true);
    expect(isOrchestratorRef({ session_id: 'a', pane_id: '%3', cwd: '/home/x/dev' }, 'o1', { dir, run })).toBe(false);
  });
  it('gets no provisional row and is never live-indexed', () => {
    const live = { 'claude:o1': { agent: 'claude', session_id: 'o1', cwd: dir, pane_id: '%9' }, 'claude:c1': { agent: 'claude', session_id: 'c1', cwd: '/home/x/dev', pane_id: '%3' } };
    const exclude = (l: any) => isOrchestratorRef(l, '', { dir, run });
    const opts = { locate: () => null, firstPrompt: () => '', mtimeOf: () => 1, exclude };
    expect(provisionalViews([], live, [], 5, opts).map((v) => v.session_id)).toEqual(['c1']);
    const indexed: string[] = [];
    const ix = new LiveIndexer({ locate: (sid: string) => `/t/${sid}.jsonl`, mtimeOf: () => 5, index: async (f: string) => { indexed.push(f); } } as any);
    ix.tick(Object.values(live), new Map(), 1000, exclude);
    expect(indexed).toEqual(['/t/c1.jsonl']);
  });
});
