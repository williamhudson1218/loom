import { describe, expect, it } from 'vitest';
import { ANSWERS_SYSTEM, PRESEND_SYSTEM, PreSendWork, buildAnswersAsk, buildPreSendAsk, verdictKey, type PreSendRec } from '../src/actionsend.ts';
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
    const keys = [...s.rows.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0].startsWith(verdictKey('d0123456789ab', '', item(1).id) + '#')).toBe(true);
    // A second worker over the same store (a restart) reads the verdict and does not ask.
    const again = new PreSendWork({ fresh: async () => ({ ok: true, items: [item(1)] }), ask: (p) => (s.asks.push(p), Promise.resolve('{}')), enabled: () => true, store: { get: (k) => s.rows.get(k) ?? null, put: (k, r) => void s.rows.set(k, r) }, now: () => T });
    again.beginTick();
    expect(await settle(again, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: 'wait for #130' });
    expect(s.asks).toHaveLength(1);
    // The chat replaced the draft: a new revision is a new question.
    await settle(s.work, draft('d0123456789ab', { revised_at: '2026-11-01T10:00:00' }));
    expect(s.asks).toHaveLength(2);
  });

  it('a new message that sorts before the latest (another clock) is a new question, never acked under the old verdict', async () => {
    let items = [item(5)];
    const s = setup({ fresh: async () => ({ ok: true, items }) });
    expect(await settle(s.work, draft('d0123456789ab'))).toEqual({ decision: 'send', ack: [item(5).id] });
    items = [item(1), item(5)];
    const later = new PreSendWork({ fresh: async () => ({ ok: true, items }), ask: (p) => (s.asks.push(p), Promise.resolve('{"send":false,"reason":"hold"}')), enabled: () => true, store: { get: (k) => s.rows.get(k) ?? null, put: (k, r) => void s.rows.set(k, r) }, now: () => T });
    later.beginTick();
    expect(await settle(later, draft('d0123456789ab'))).toEqual({ decision: 'hold', why: 'hold' });
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

describe('the answers verdict', () => {
  const it0 = item(1);
  const SID = 'a00000000001';
  const run = async (s: ReturnType<typeof setup>, i = it0, q = 'is the filing approved?') => {
    let r = s.work.answers(SID, q, i);
    for (let k = 0; k < 4 && r === 'pending'; k++) {
      await s.work.idle();
      s.work.beginTick();
      r = s.work.answers(SID, q, i);
    }
    return r;
  };
  it('wraps the question and the reply as data and asks for answers true|false', () => {
    const p = buildAnswersAsk('is it approved?', it0);
    expect(p).toContain('<question>\nis it approved?\n</question>');
    expect(p).toMatch(/<reply>[\s\S]*the reviewer: message 1[\s\S]*<\/reply>/);
    expect(ANSWERS_SYSTEM).toContain('{"answers": true|false, "reason": "..."}');
  });
  it('the first call starts the ask and reads pending; the verdict is stored under answers|step|item', async () => {
    const s = setup({ reply: async () => '{"answers":true,"reason":"it says approved"}' });
    expect(s.work.answers(SID, 'q', it0)).toBe('pending');
    await s.work.idle();
    expect(s.work.answers(SID, 'q', it0)).toBe('yes');
    expect(s.rows.get(`answers|${SID}|${it0.id}`)?.reason).toBe('it says approved');
    expect(s.asks).toHaveLength(1);
  });
  it('no verdict is no', async () => {
    const s = setup({ reply: async () => '{"answers":false,"reason":"unrelated"}' });
    expect(await run(s)).toBe('no');
  });
  it('a stored verdict is reused without asking', async () => {
    const s = setup();
    s.rows.set(`answers|${SID}|${it0.id}`, { state: 'send', reason: 'r', at: T });
    expect(s.work.answers(SID, 'q', it0)).toBe('yes');
    expect(s.asks).toHaveLength(0);
  });
  it('model off, a bad reply and a failing model are unavailable, never yes', async () => {
    expect(await run(setup({ enabled: false }))).toBe('unavailable');
    expect(await run(setup({ reply: async () => 'no idea' }))).toBe('unavailable');
    expect(await run(setup({ reply: async () => { throw new Error('boom'); } }))).toBe('unavailable');
  });
  it('shares the per-tick budget with the pre-send asks', async () => {
    const s = setup({ perTick: 1, items: [item(1)] });
    expect(s.work.check(draft('d0123456789ab'))).toEqual({ decision: 'pending' });
    await s.work.idle();
    s.work.beginTick();
    expect(s.work.check(draft('d0123456789ab'))).toEqual({ decision: 'pending' }); // takes the one ask
    expect(s.work.answers(SID, 'q', it0)).toBe('pending'); // no budget left: waits, starts nothing
    expect(s.asks).toHaveLength(1);
  });
  it('the ask goes out with the answers system prompt', async () => {
    const systems: (string | undefined)[] = [];
    const rows = new Map<string, PreSendRec>();
    const w = new PreSendWork({ fresh: async () => ({ ok: true, items: [] }), ask: async (_p, sys) => (systems.push(sys), '{"answers":true,"reason":"y"}'), enabled: () => true, store: { get: (k) => rows.get(k) ?? null, put: (k, r) => void rows.set(k, r) }, now: () => T });
    w.beginTick();
    w.answers(SID, 'q', it0);
    await w.idle();
    expect(systems).toEqual([ANSWERS_SYSTEM]);
  });
});
