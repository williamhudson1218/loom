import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { REDRAFT_TTL_MS, buildRedraftPrompt, clearMark, keepMark, newMark, readMarks, redraftActive, redraftView, setMark } from '../src/redraft.ts';
import { applyEvent } from '../src/events.ts';
import { OUTBOX_PURE_JS, OUTBOX_VIEW_JS } from '../src/outboxview.ts';
import { CORE_ROUTES } from '../src/routes/index.ts';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-redraft-')), 'marks.json');
const items = [
  { id: 'slack:1', author: 'Dana', snippet: 'Can we also cover the "QA" case?\nThanks' },
  { id: 'slack:2', author: 'Lee', snippet: 'x'.repeat(500) },
];

describe('buildRedraftPrompt', () => {
  const p = buildRedraftPrompt({ id: 'd7', url: 'https://example.slack.com/archives/C1/p1', items });
  it('is one line led by the draft id, with the thread and the count', () => {
    expect(p.startsWith('redraft d7: the thread https://example.slack.com/archives/C1/p1 has 2 new messages since you drafted this reply: ')).toBe(true);
    expect(p).not.toContain('\n');
  });
  it('quotes each message with its author, flattened and trimmed', () => {
    expect(p).toContain(`[1] Dana: "Can we also cover the 'QA' case? Thanks"`);
    expect(p).toContain('[2] Lee: "' + 'x'.repeat(299) + '…"');
  });
  it('names the replace and keep commands', () => {
    expect(p).toContain('`loom outbox update d7 --text-file <file>`');
    expect(p).toContain('`loom outbox keep d7`');
    expect(p).toContain('Re-read the whole thread first');
  });
  it('says "message" for one and caps the quoted list', () => {
    expect(buildRedraftPrompt({ id: 'a', url: '', items: [items[0]] })).toContain('has 1 new message since');
    const many = Array.from({ length: 9 }, (_, i) => ({ id: 's' + i, author: 'A', snippet: 'm' + i }));
    const q = buildRedraftPrompt({ id: 'a', url: 'u', items: many });
    expect(q).toContain('[6] A: "m5"');
    expect(q).not.toContain('[7]');
    expect(q).toContain('(+3 more, read the thread)');
  });
});

describe('redraft state transitions', () => {
  const NOW = 1_000_000;
  const d = { status: 'pending', revised_at: '' };
  const m = newMark(d, items, NOW);
  it('is active until the chat replaces, keeps, the draft goes, or 15 minutes pass', () => {
    expect(redraftActive(m, d, NOW + 1000)).toBe(true);
    expect(redraftActive(m, { ...d, revised_at: '2026-11-13T10:00:00' }, NOW + 1000)).toBe(false); // replaced
    expect(redraftActive(m, { ...d, status: 'superseded' }, NOW + 1000)).toBe(false);
    expect(redraftActive({ ...m, state: 'kept' }, d, NOW + 1000)).toBe(false);
    expect(redraftActive(m, d, NOW + REDRAFT_TTL_MS)).toBe(false);
    expect(redraftActive(undefined, d, NOW)).toBe(false);
  });
  it('view: active, then forgotten on timeout (offer again), but remembered after a replace or keep', () => {
    expect(redraftView(m, d, NOW + 10)).toMatchObject({ active: true, n: 2, ids: ['slack:1', 'slack:2'] });
    expect(redraftView(m, d, NOW + REDRAFT_TTL_MS + 1)).toBeUndefined();
    expect(redraftView(m, { ...d, revised_at: 'later' }, NOW + REDRAFT_TTL_MS + 1)).toMatchObject({ active: false });
    expect(redraftView({ ...m, state: 'kept' }, d, NOW + REDRAFT_TTL_MS + 1)).toMatchObject({ active: false, kept: true });
  });
  it('persists, keeps and cancels through the file', () => {
    const f = tmp();
    setMark('d1', m, f);
    setMark('d2', m, f, new Set(['d2'])); // drops marks of drafts that are gone
    expect(Object.keys(readMarks(f))).toEqual(['d2']);
    expect(keepMark('d2', f)).toBe(true);
    expect(readMarks(f).d2.state).toBe('kept');
    expect(keepMark('d2', f)).toBe(false);
    expect(keepMark('nope', f)).toBe(false);
    expect(clearMark('d2', f)).toBe(true);
    expect(clearMark('d2', f)).toBe(false);
    expect(readMarks(tmp())).toEqual({});
  });
  it('the outbox.keep event marks it kept', () => {
    const f = tmp();
    setMark('d3', m, f);
    const db = new Database(':memory:');
    expect(applyEvent(db, { kind: 'outbox.keep', id: 'd3' }, { redraft: f })).toEqual({ ok: true, detail: 'kept' });
    expect(readMarks(f).d3.state).toBe('kept');
  });
});

describe('the card', () => {
  const lib = new Function(`${OUTBOX_PURE_JS}; return { redraftState };`)() as { redraftState: (d: object, items: { id: string }[], local?: boolean) => string };
  const it1 = [{ id: 'a' }, { id: 'b' }];
  it('offers Redraft only for new messages, holds while active, then notes the outcome', () => {
    expect(lib.redraftState({}, [])).toBe('none');
    expect(lib.redraftState({}, it1)).toBe('offer');
    expect(lib.redraftState({}, it1, true)).toBe('active');
    expect(lib.redraftState({ redraft: { active: true, ids: ['a'] } }, [])).toBe('active');
    expect(lib.redraftState({ redraft: { active: false, ids: ['a', 'b'] } }, it1)).toBe('asked');
    expect(lib.redraftState({ redraft: { active: false, ids: ['a', 'b'], kept: true } }, it1)).toBe('kept');
    expect(lib.redraftState({ redraft: { active: false, ids: ['a'] } }, it1)).toBe('offer'); // a newer message
  });
  it('wires the button, the held Send and the routes', () => {
    expect(OUTBOX_VIEW_JS).toContain('data-dact="redraft"');
    expect(OUTBOX_VIEW_JS).toContain('/api/outbox/redraft-cancel');
    expect(OUTBOX_VIEW_JS).toContain('rdOn?');
    // The button sits in the action row right after Send, not in the yellow box; Send is demoted while it is offered.
    expect(OUTBOX_VIEW_JS).toContain(">Send</button>'+redraftCtl(d,warn.items)+'<button data-dact=\"edit\">");
    expect(OUTBOX_VIEW_JS).toContain("' demoted'");
    expect(OUTBOX_VIEW_JS).toContain('data-dact="redraft-busy"');
    for (const r of ['/api/outbox/redraft', '/api/outbox/redraft-cancel']) expect(CORE_ROUTES.some((x) => x.path === r && x.method === 'POST')).toBe(true);
  });
});
