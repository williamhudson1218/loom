import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { flashOpenedThread, flashTargets, permalinkChannel, permalinkTs, settled, visibleShare, FLASH_WAIT_MS, type FlashDeps, type ListedMessage } from '../src/slackflash.ts';
import { OVERLAY_HTML } from '../src/pickpages.ts';

// Shaped like loom-ax `list` output, measured against a real channel view
// 2026-11-13: rows scrolled above the list read as 1-point slivers at its top.
const BASE = 'https://example.slack.com/archives/C0TEST1/';
const D = [{ x: 0, y: 0, width: 1728, height: 1117 }];
const KEY = 'C0TEST1/1790000000.000200';
const msg = (p: string, y: number, h: number, extra: Partial<ListedMessage> = {}): ListedMessage => ({
  url: BASE + p, rect: { x: 514, y, w: 1209, h }, inThread: false, ...extra,
});
const channelView: ListedMessage[] = [
  msg('p1789999000000100', 153, 1),
  msg('p1790000000000200', 300, 180, { text: 'Can someone check the deploy log', author: 'Pat' }),
  msg('p1790000500000300', 480, 116, { text: 'Unrelated message here', author: 'Sam' }),
];

describe('permalink parsing', () => {
  it('reads the ts and channel of a root and a reply', () => {
    expect(permalinkTs(BASE + 'p1790000000000200')).toBe('1790000000.000200');
    expect(permalinkTs(BASE + 'p1790000000000300?thread_ts=1790000000.000200&cid=C0TEST1')).toBe('1790000000.000300');
    expect(permalinkChannel(BASE + 'p1790000000000200')).toBe('C0TEST1');
    expect(permalinkTs('https://example.com/nothing')).toBeNull();
  });
});

describe('visibleShare', () => {
  it('is the best share of the rect on any display', () => {
    expect(visibleShare({ x: 0, y: 0, w: 100, h: 100 }, D)).toBe(1);
    expect(visibleShare({ x: -50, y: 0, w: 100, h: 100 }, D)).toBe(0.5);
    expect(visibleShare({ x: 2000, y: 0, w: 100, h: 100 }, D)).toBe(0);
    expect(visibleShare({ x: 0, y: 0, w: 0, h: 100 }, D)).toBe(0);
  });
});

describe('flashTargets', () => {
  it('finds the root in the channel view by its permalink ts', () => {
    expect(flashTargets(channelView, KEY, null, D)).toEqual([{ x: 514, y: 300, w: 1209, h: 180 }]);
  });
  it('also outlines the open thread pane root, but never a reply', () => {
    const pane = [
      ...channelView,
      { url: BASE + 'p1790000000000200', rect: { x: 1730, y: 120, w: 400, h: 90 }, inThread: true },
      { url: BASE + 'p1790000000000900?thread_ts=1790000000.000200', rect: { x: 1730, y: 220, w: 400, h: 60 }, inThread: true },
    ];
    const wide = [{ x: 0, y: 0, width: 2200, height: 1117 }];
    expect(flashTargets(pane, KEY, null, wide)).toHaveLength(2);
  });
  it('flashes nothing when the root is scrolled out of view (a 1-point sliver)', () => {
    expect(flashTargets(channelView, 'C0TEST1/1789999000.000100', null, D)).toEqual([]);
  });
  it('flashes nothing when the root is mostly off every display', () => {
    const off = [msg('p1790000000000200', 1050, 180)];
    expect(flashTargets(off, KEY, null, D)).toEqual([]);
  });
  it('ignores the same ts in another channel', () => {
    const other = [{ ...channelView[1], url: 'https://example.slack.com/archives/C0OTHER/p1790000000000200' }];
    expect(flashTargets(other, KEY, null, D)).toEqual([]);
  });
  it('falls back to the cached text and author only when exactly one row fits', () => {
    const noTs = channelView.map((m) => ({ ...m, url: BASE + 'p1700000000000000' }));
    const root = { text: 'Can someone check the  deploy log', author: 'Pat' };
    expect(flashTargets(noTs, KEY, root, D)).toEqual([channelView[1].rect]);
    expect(flashTargets(noTs, KEY, { ...root, author: 'Someone else' }, D)).toEqual([]);
    expect(flashTargets([...noTs, noTs[1]], KEY, root, D)).toEqual([]);
    expect(flashTargets(noTs, KEY, { text: 'short', author: '' }, D)).toEqual([]);
  });
});

describe('settled', () => {
  const r = { x: 1, y: 100, w: 50, h: 30 };
  it('needs two matching reads', () => {
    expect(settled(null, [r])).toBe(false);
    expect(settled([r], [{ ...r, y: 101 }])).toBe(true);
    expect(settled([r], [{ ...r, y: 140 }])).toBe(false);
    expect(settled([r], [])).toBe(false);
  });
});

describe('flashOpenedThread', () => {
  function deps(reads: Array<{ ok: boolean; messages?: ListedMessage[] }>, front: boolean[] = []): FlashDeps & { flashed: unknown[]; reads: number } {
    let t = 0;
    const out = {
      flashed: [] as unknown[],
      reads: 0,
      list: async () => reads[Math.min(out.reads++, reads.length - 1)],
      slackFront: async () => front.length ? front.shift()! : true,
      displays: () => D,
      root: () => null,
      flash: (r: unknown) => void out.flashed.push(r),
      sleep: async (ms: number) => void (t += ms),
      now: () => t,
    };
    return out;
  }
  it('waits for Slack to finish scrolling, then flashes once', async () => {
    const moving = [msg('p1790000000000200', 900, 100)];
    const d = deps([{ ok: true, messages: moving }, { ok: true, messages: channelView }, { ok: true, messages: channelView }]);
    expect(await flashOpenedThread(KEY, d)).toBe('flashed');
    expect(d.flashed).toEqual([[{ x: 514, y: 300, w: 1209, h: 180 }]]);
    expect(d.reads).toBe(3);
  });
  it('waits for Slack to come to the front first', async () => {
    const d = deps([{ ok: true, messages: channelView }], [false, false, true, true]);
    expect(await flashOpenedThread(KEY, d)).toBe('flashed');
  });
  it('gives up quietly when Slack never comes forward', async () => {
    const d = deps([{ ok: true, messages: channelView }], Array(100).fill(false));
    expect(await flashOpenedThread(KEY, d)).toBe('not_front');
    expect(d.flashed).toEqual([]);
  });
  it('gives up quietly when the message is not on screen, or still moving at the deadline', async () => {
    expect(await flashOpenedThread('C0TEST1/1111111111.000000', deps([{ ok: true, messages: channelView }]))).toBe('not_found');
    let y = 0;
    const d = deps([]);
    d.list = async () => ({ ok: true, messages: [msg('p1790000000000200', (y += 50) % 900, 100)] });
    expect(await flashOpenedThread(KEY, d)).toBe('not_found');
    expect(d.flashed).toEqual([]);
  });
  it('gives up quietly without Accessibility, and on a throw', async () => {
    expect(await flashOpenedThread(KEY, deps([{ ok: false }]))).toBe('unreadable');
    const d = deps([]);
    d.list = async () => { throw new Error('helper gone'); };
    expect(await flashOpenedThread(KEY, d)).toBe('unreadable');
  });
  it('stops within the wait budget', async () => {
    const d = deps([{ ok: false }]);
    await flashOpenedThread(KEY, d);
    expect(d.now()).toBeLessThanOrEqual(FLASH_WAIT_MS + 500);
  });
});

describe('the overlay flash', () => {
  it('places each rect relative to its display and restarts the animation', () => {
    const handlers: Record<string, (e: unknown, v?: unknown) => void> = {};
    const el = () => ({ style: {} as Record<string, string>, textContent: '', className: '', offsetWidth: 0 });
    const els: Record<string, ReturnType<typeof el>> = { box: el(), hint: el(), msg: el(), spin: el(), fl0: el(), fl1: el() };
    const body = { style: {} as Record<string, string>, className: '' };
    const ctx = {
      require: () => ({ ipcRenderer: { send: () => {}, on: (c: string, f: (e: unknown, v?: unknown) => void) => (handlers[c] = f) } }),
      location: { hash: '#' + encodeURIComponent(JSON.stringify({ x: -1512, y: 0, d: 1 })) },
      document: { getElementById: (id: string) => els[id], body, visibilityState: 'visible' },
      window: { addEventListener: () => {} },
      requestAnimationFrame: (f: () => void) => f(),
      setTimeout: () => 0, clearTimeout: () => {}, Date, JSON, decodeURIComponent, Object,
    };
    vm.runInNewContext([...OVERLAY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)][0][1], ctx);
    handlers.flash({}, [{ x: -1000, y: 200, w: 300, h: 80 }]);
    expect(body.className).toBe('flashing');
    expect(els.fl0.className).toBe('fl on');
    expect(els.fl0.style).toMatchObject({ left: '510px', top: '198px', width: '300px', height: '80px' });
    expect(els.fl1.className).toBe('fl');
    handlers.reset({});
    expect(body.className).toBe('');
    expect(els.fl0.className).toBe('fl');
  });
});
