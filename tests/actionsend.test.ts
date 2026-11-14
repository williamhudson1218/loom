import { describe, expect, it } from 'vitest';
import { PRESEND_SYSTEM, PreSendWork, buildPreSendAsk, verdictKey, type PreSendRec } from '../src/actionsend.ts';
import type { Draft } from '../src/outbox.ts';
import type { FreshItem, FreshResult } from '../src/outboxfresh.ts';

const T = 1_700_000_000_000;
const draft = (id: string, over: Partial<Draft> = {}): Draft => ({
  id, session_id: 's1', channel: 'C0123456789', thread_ts: '1700000000.000100', messages: ['Shipped: acme/app#123 is live.'],
  status: 'pending', created_at: '2026-11-01T09:00:00', revised_at: '', ...over,
});
const item = (n: number): FreshItem => ({ id: `slack:1700000000.00020${n}`, kind: 'slack', author: 'the reviewer', at: T + n, snippet: `message ${n}` });

function setup(opts: { items?: FreshItem[]; fresh?: (d: Draft) => Promise<FreshResult>; reply?: (p: string) => Promise<string>; enabled?: boolean; perTick?: number } = {}) {
  const rows = new Map<string, PreSendRec>();
  const asks: string[] = [];
  const fetches: string[] = [];
  const work = new PreSendWork(
    {
      fresh: opts.fresh ?? (async (d) => (fetches.push(d.id), { ok: true, items: opts.items ?? [] })),
      ask: (p) => (asks.push(p), (opts.reply ?? (async () => '{"send":true,"reason":"nothing new that matters"}'))(p)),
      enabled: () => opts.enabled ?? true,
      store: { get: (k) => rows.get(k) ?? null, put: (k, r) => void rows.set(k, r) },
      now: () => T,
    },
    { perTick: opts.perTick ?? 3 },
  );
  work.beginTick();
  return { work, rows, asks, fetches };
}

/** Drive one draft to a decision: check, let the background work settle, check again. */
async function settle(work: PreSendWork, d: Draft) {
  for (let i = 0; i < 5; i++) {
    const r = work.check(d);
    if (r.decision !== 'pending') return r;
    await work.idle();
    work.beginTick();
  }
  return work.check(d);
}

describe('the pre-send ask', () => {
  it('wraps the draft and the new messages as data and asks the one question', () => {
    const p = buildPreSendAsk('Shipped!', [item(1)]);
    expect(p).toContain('<draft>\nShipped!\n</draft>');
    expect(p).toMatch(/<new>[\s\S]*the reviewer: message 1[\s\S]*<\/new>/);
    expect(PRESEND_SYSTEM).toContain('Does anything here mean this reply should not go out as written?');
    expect(PRESEND_SYSTEM).toContain('{"send": true|false, "reason": "..."}');
    expect(PRESEND_SYSTEM).toMatch(/at most 15 words/);
  });
  it('keys a verdict by draft, revision and latest thread ts', () => {
    expect(verdictKey('d0123456789ab', '2026-11-01T09:05:00', 'slack:1.2')).toBe('d0123456789ab|2026-11-01T09:05:00|slack:1.2');
  });
});

describe('PreSendWork', () => {
  it('no new messages: send with no ack, and the model is never asked', async () => {
    const s = setup();
    expect(s.work.check(draft('d0123456789ab'))).toEqual({ decision: 'pending' });
    expect(await settle(s.work, draft('d0123456789ab'))).toEqual({ decision: 'send', ack: [] });
    expect(s.asks).toEqual([]);
  });

  it('new messages and the model says send: send, acking exactly those messages', async () => {
    const s = setup({ items: [item(1), item(2)] });
    expect(await settle(s.work, draft('d0123456789ab'))).toEqual({ decision: 'send', ack: [item(1).id, item(2).id] });
    expect(s.asks).toHaveLength(1);
  });

  it('new messages and the model says do not send: hold with its reason', async () => {
    const s = setup({ items: [item(1)], reply: async () => '{"send":false,"reason":"the reviewer asked to wait for #130"}' });
    expect(await settle(s.work, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: 'the reviewer asked to wait for #130' });
  });

  it('model off with new messages: hold, without asking', async () => {
    const s = setup({ items: [item(1), item(2)], enabled: false });
    expect(await settle(s.work, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: "couldn't check 2 new messages; review before sending" });
    expect(s.asks).toEqual([]);
  });

  it('model off with no new messages still sends', async () => {
    const s = setup({ enabled: false });
    expect(await settle(s.work, draft('d0123456789ab'))).toEqual({ decision: 'send', ack: [] });
  });

  it('model erroring or replying nonsense with new messages: hold', async () => {
    const a = setup({ items: [item(1)], reply: async () => { throw new Error('timeout'); } });
    expect(await settle(a.work, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: "couldn't check 1 new message; review before sending" });
    const b = setup({ items: [item(1)], reply: async () => 'I think it is fine' });
    expect(await settle(b.work, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: "couldn't check 1 new message; review before sending" });
  });

  it('a fresh fetch error holds, even with no items', async () => {
    const s = setup({ fresh: async () => ({ ok: false, error: 'channel_not_found', items: [] }) });
    expect(await settle(s.work, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: "couldn't read the thread: channel_not_found" });
    const t = setup({ fresh: async () => { throw new Error('network down'); } });
    expect(await settle(t.work, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: "couldn't read the thread: network down" });
  });

  it('reuses a cached verdict for the same key, and asks again when revised_at changes', async () => {
    const s = setup({ items: [item(1)], reply: async () => '{"send":false,"reason":"wait for #130"}' });
    await settle(s.work, draft('d0123456789ab'));
    expect(s.asks).toHaveLength(1);
    expect([...s.rows.keys()]).toEqual([verdictKey('d0123456789ab', '', item(1).id)]);
    // A second worker over the same store (a restart) reads the verdict and does not ask.
    const again = new PreSendWork({ fresh: async () => ({ ok: true, items: [item(1)] }), ask: (p) => (s.asks.push(p), Promise.resolve('{}')), enabled: () => true, store: { get: (k) => s.rows.get(k) ?? null, put: (k, r) => void s.rows.set(k, r) }, now: () => T });
    again.beginTick();
    expect(await settle(again, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: 'wait for #130' });
    expect(s.asks).toHaveLength(1);
    // The chat replaced the draft: a new revision is a new question.
    await settle(s.work, draft('d0123456789ab', { revised_at: '2026-11-01T10:00:00' }));
    expect(s.asks).toHaveLength(2);
  });

  it('starts at most perTick asks in one tick; the fourth draft reads pending', async () => {
    const s = setup({ items: [item(1)], reply: () => new Promise(() => {}) });
    const ds = ['d000000000001', 'd000000000002', 'd000000000003', 'd000000000004'].map((id) => draft(id));
    for (const d of ds) expect(s.work.check(d)).toEqual({ decision: 'pending' });
    await new Promise((r) => setTimeout(r, 0)); // the fresh fetches settle; the asks never do
    s.work.beginTick();
    for (const d of ds) expect(s.work.check(d)).toEqual({ decision: 'pending' });
    expect(s.asks).toHaveLength(3);
  });

  it('never blocks: the first check returns pending before the fetch resolves', () => {
    const s = setup({ fresh: () => new Promise(() => {}) });
    expect(s.work.check(draft('d0123456789ab'))).toEqual({ decision: 'pending' });
    expect(s.work.check(draft('d0123456789ab'))).toEqual({ decision: 'pending' });
  });
});
