import { describe, expect, it } from 'vitest';
import { ChatJudge, buildJudgeAsk, parseVerdict, tailText, verdictKey, type VerdictRec, type VerdictStore } from '../src/orchjudge.ts';
import type { ChatFact } from '../src/orchsweep.ts';
import type { OrchItem } from '../src/orchestrator.ts';
import type { Msg } from '../src/transcript.ts';

const T = 1_700_000_000_000;
const item = (id: number, over: Partial<OrchItem> = {}): OrchItem => ({
  id, kind: 'needs_you', ref_type: 'chat', ref_id: `claude:s${id}`, title: `Approve ${id}`, why: '', who: '',
  opened_at: T, updated_at: T, resolved_at: 0, resolved_why: '', ...over,
});
const chat = (over: Partial<ChatFact> = {}): ChatFact => ({ onBoard: true, closed: true, live: false, working: false, lastTurnAt: T, lastActiveAt: T, ...over });
const msgs: Msg[] = [{ role: 'user', text: 'ship it' }, { role: 'assistant', text: 'Merged.' }];

function setup(reply: (p: string) => Promise<string>, opts?: { perSweep?: number; enabled?: boolean; messages?: Msg[] }) {
  const rows = new Map<string, VerdictRec>();
  const store: VerdictStore = { get: (k) => rows.get(k) ?? null, put: (k, r) => void rows.set(k, r) };
  const asks: string[] = [];
  const judge = new ChatJudge(
    { ask: (p) => (asks.push(p), reply(p)), messages: () => opts?.messages ?? msgs, enabled: () => opts?.enabled ?? true, store, now: () => T + 1 },
    { tailChars: 8000, perSweep: opts?.perSweep ?? 3, timeoutMs: 1000 },
  );
  judge.beginSweep();
  return { judge, rows, asks };
}

describe('the ask and the reply', () => {
  it('keeps the newest turns inside the budget', () => {
    const long: Msg[] = Array.from({ length: 50 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `turn ${i} ` + 'x'.repeat(90) }));
    const t = tailText(long, 1000);
    expect(t.length).toBeLessThanOrEqual(1000);
    expect(t.endsWith('x')).toBe(true);
    expect(t).toContain('turn 49');
    expect(t).not.toContain('turn 0 ');
    expect(tailText([{ role: 'user', text: 'y'.repeat(50) }], 20).length).toBe(20);
  });

  it('quotes the item and the chat as data', () => {
    const a = buildJudgeAsk({ kind: 'blocked', title: 'Account number', why: 'asked the vendor', who: "the vendor" }, 'USER: hi');
    expect(a).toContain('<item>');
    expect(a).toContain('waiting on the vendor');
    expect(a).toContain('<chat>');
  });

  it('parses a fenced verdict and refuses anything unclear', () => {
    expect(parseVerdict('```json\n{"resolved": true, "reason": "approved in chat"}\n```')).toEqual({ resolved: true, reason: 'approved in chat' });
    expect(parseVerdict('{"resolved": "yes"}')).toBeNull();
    expect(parseVerdict('no idea')).toBeNull();
    expect(parseVerdict('{"resolved": false}')).toEqual({ resolved: false, reason: 'still open' });
  });
});

describe('ChatJudge', () => {
  it('asks once, answers pending meanwhile, then serves the cached verdict', async () => {
    const { judge, asks } = setup(async () => '{"resolved": true, "reason": "merged"}');
    expect(judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'pending' });
    expect(judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'pending' });
    await judge.idle();
    expect(judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'resolved', reason: 'merged' });
    expect(asks).toHaveLength(1);
  });

  it('asks again only when the chat or the item changed', async () => {
    const { judge, asks } = setup(async () => '{"resolved": false, "reason": "unanswered"}');
    judge.verdict(item(1), 'claude:s1', chat());
    await judge.idle();
    judge.beginSweep();
    expect(judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'open', reason: 'unanswered' });
    expect(judge.verdict(item(1), 'claude:s1', chat({ lastActiveAt: T + 5 }))).toEqual({ state: 'pending' });
    await judge.idle();
    judge.beginSweep();
    judge.verdict(item(1, { updated_at: T + 9 }), 'claude:s1', chat({ lastActiveAt: T + 5 }));
    await judge.idle();
    expect(asks).toHaveLength(3);
  });

  it('starts at most perSweep asks per sweep', async () => {
    const { judge, asks } = setup(async () => '{"resolved": true, "reason": "x"}', { perSweep: 2 });
    for (let i = 1; i <= 5; i++) judge.verdict(item(i), `claude:s${i}`, chat());
    expect(asks).toHaveLength(2);
    await judge.idle();
    judge.beginSweep();
    for (let i = 1; i <= 5; i++) judge.verdict(item(i), `claude:s${i}`, chat());
    expect(asks).toHaveLength(4);
  });

  it('reads unavailable after a failed call, a bad reply, a missing transcript, or with labels off', async () => {
    const fail = setup(async () => { throw new Error('rate limited'); });
    fail.judge.verdict(item(1), 'claude:s1', chat());
    await fail.judge.idle();
    expect(fail.judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'unavailable' });
    expect(fail.rows.get(verdictKey(1, 'claude:s1'))?.state).toBe('failed');

    const junk = setup(async () => 'sure!');
    junk.judge.verdict(item(1), 'claude:s1', chat());
    await junk.judge.idle();
    expect(junk.judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'unavailable' });

    const empty = setup(async () => '{"resolved": true, "reason": "x"}', { messages: [] });
    empty.judge.verdict(item(1), 'claude:s1', chat());
    await empty.judge.idle();
    expect(empty.asks).toHaveLength(0);
    expect(empty.judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'unavailable' });

    const off = setup(async () => '{"resolved": true, "reason": "x"}', { enabled: false });
    expect(off.judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'unavailable' });
    expect(off.asks).toHaveLength(0);
  });

  it('serves a verdict stored by an earlier process without asking', () => {
    const { judge, rows, asks } = setup(async () => '{}');
    rows.set(verdictKey(1, 'claude:s1'), { activity_at: T, item_updated_at: T, state: 'open', reason: 'stored', at: T });
    expect(judge.verdict(item(1), 'claude:s1', chat())).toEqual({ state: 'open', reason: 'stored' });
    expect(asks).toHaveLength(0);
  });
});
