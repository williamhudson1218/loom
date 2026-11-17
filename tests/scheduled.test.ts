import Database from 'better-sqlite3';
import { describe, it, expect } from 'vitest';
import { applySchema } from '../src/schema.ts';
import { addStep, setStep } from '../src/actions.ts';
import { scheduledList } from '../src/routes/actions.ts';
import { SCHED_PURE_JS } from '../src/scheduledview.ts';
import { renderDashboard } from '../src/dashboard.ts';

type S = { id: string; session_id: string; position: number; trigger_type: string; at: number; status: string; current: boolean };
const api = new Function(`${SCHED_PURE_JS}; return { schedGroups, schedIn, schedBadge };`)() as {
  schedGroups: (s: S[]) => Record<'needs' | 'timed' | 'waiting' | 'queued', S[]>;
  schedIn: (at: number, now: number) => string;
  schedBadge: (s: S[]) => number;
};

const st = (over: Partial<S>): S => ({ id: 'a', session_id: 's1', position: 1, trigger_type: 'pr_merged', at: 0, status: 'waiting', current: true, ...over });

describe('Scheduled grouping', () => {
  it('puts held, failed and due first, timed steps by time, then waiting and queued', () => {
    const g = api.schedGroups([
      st({ id: 'q', current: false, position: 2 }),
      st({ id: 'late', trigger_type: 'clock', at: 900 }),
      st({ id: 'held', status: 'held' }),
      st({ id: 'soon', trigger_type: 'clock', at: 100, session_id: 's2' }),
      st({ id: 'w' }),
      st({ id: 'due', status: 'due', trigger_type: 'clock', at: 50 }),
    ]);
    expect(g.needs.map((s) => s.id).sort()).toEqual(['due', 'held']);
    expect(g.timed.map((s) => s.id)).toEqual(['soon', 'late']);
    expect(g.waiting.map((s) => s.id)).toEqual(['w']);
    expect(g.queued.map((s) => s.id)).toEqual(['q']);
    expect(api.schedBadge([st({ status: 'failed' }), st({})])).toBe(1);
  });

  it('says how long until a time, and now once it has passed', () => {
    const now = 1_000_000;
    expect(api.schedIn(now - 1, now)).toBe('now');
    expect(api.schedIn(now + 3 * 60_000, now)).toBe('in 3m');
    expect(api.schedIn(now + (14 * 60 + 5) * 60_000, now)).toBe('in 14h 5m');
    expect(api.schedIn(now + 2 * 60 * 60_000, now)).toBe('in 2h');
    expect(api.schedIn(now + 72 * 60 * 60_000, now)).toBe('in 3d');
  });
});

describe('scheduledList', () => {
  it('lists every open step across chats, marks the current one, and skips done and removed', () => {
    const db = new Database(':memory:');
    applySchema(db);
    const add = (id: string, session_id: string, when: string) =>
      addStep(db, { id, session_id, title: id, when, then: 'wake:"go"', ask_first: false, created_by: 'chat', at: new Date(2026, 10, 16, 21, 0).getTime() });
    add('a1', 's1', 'at:07:00');
    add('a2', 's1', 'pr-merged:acme/app#1');
    add('b1', 's2', 'manual');
    add('b2', 's2', 'now');
    setStep(db, 'b1', { status: 'done' });
    add('c1', 's3', 'manual');
    setStep(db, 'c1', { status: 'removed' });
    const { steps, watchers } = scheduledList(db);
    expect(steps.map((s) => [s.id, s.current])).toEqual([['a1', true], ['a2', false], ['b2', true]]);
    const a1 = steps.find((s) => s.id === 'a1')!;
    expect(a1.trigger_type).toBe('clock');
    expect(a1.at).toBe(new Date(2026, 10, 17, 7, 0).getTime());
    expect(a1.summary).toBe('At 7:00am Tue Nov 17 → wake the chat');
    expect(watchers).toEqual([]);
  });
});

describe('Scheduled tab', () => {
  it('is a header tab with its own section, rendered by renderSched', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain("['sched','◷ Scheduled',");
    expect(html).toContain('<section id="sched-section"');
    expect(html).toContain("if(tab==='sched'){renderSched();return;}");
    expect(html).toContain("fetch('/api/actions/scheduled')");
  });
});
