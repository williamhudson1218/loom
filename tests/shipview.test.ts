import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.ts';
import { parsePorcelainZ } from '../src/detail.ts';
import { groupNextShip, type ChatEdits, type ShipBoard } from '../src/ships.ts';
import {
  applyOverrides, buildShipDetail, guessOwner, loadAllOverrides, mergeLabel, parseNumstatZ, readLabelsFile, setOverride, setShipLabel,
  shipConfirmText, shipDisabledReason, shipPrompt,
} from '../src/shipview.ts';
import { safeRepoPath, startShipSession } from '../src/shipdetail.ts';

const edits = (key: string, files: Record<string, [number, number]>): ChatEdits => ({
  key,
  edits: Object.fromEntries(Object.entries(files).map(([p, [first, last]]) => [p, { first, last }])),
  shipCmds: [],
});

describe('parseNumstatZ', () => {
  it('reads added/deleted per file, binary as dashes, paths with spaces and tabs intact', () => {
    const out = ['3\t1\ta.ts', '-\t-\timg.png', '0\t12\tdir/with space.ts', '1\t1\tweird\tname.ts', ''].join('\0');
    expect(parseNumstatZ(out)).toEqual([
      { path: 'a.ts', added: 3, deleted: 1, binary: false },
      { path: 'img.png', added: 0, deleted: 0, binary: true },
      { path: 'dir/with space.ts', added: 0, deleted: 12, binary: false },
      { path: 'weird\tname.ts', added: 1, deleted: 1, binary: false },
    ]);
    expect(parseNumstatZ('')).toEqual([]);
  });
});

describe('label merge: db over file over title', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shiplab-'));
  const file = path.join(dir, 'ship-labels.json');
  fs.writeFileSync(file, JSON.stringify({ s1: { label: 'from file', repo: '/r', at: 1 }, s2: { label: 'other repo', repo: '/elsewhere', at: 1 }, s3: { label: '  ', repo: '/r', at: 1 } }));
  const db = openDb(':memory:');
  const f = readLabelsFile(file);

  it('falls back to the title, then file, then the db wins', () => {
    expect(mergeLabel(db, f, 'zzz', '/r', 'Chat title')).toEqual({ label: 'Chat title', source: 'title' });
    expect(mergeLabel(db, f, 'zzz', '/r', '')).toEqual({ label: '', source: 'none' });
    expect(mergeLabel(db, f, 's1', '/r/', 'Chat title')).toEqual({ label: 'from file', source: 'file' });
    setShipLabel(db, 's1', '/r', 'from db');
    expect(mergeLabel(db, f, 's1', '/r', 'Chat title')).toEqual({ label: 'from db', source: 'db' });
  });
  it('ignores a file entry for another repo or an empty label, and clearing the db row restores the file', () => {
    expect(mergeLabel(db, f, 's2', '/r', 'T').source).toBe('title');
    expect(f.s3).toBeUndefined();
    setShipLabel(db, 's1', '/r', '   ');
    expect(mergeLabel(db, f, 's1', '/r', 'T').source).toBe('file');
  });
  it('tolerates a missing or malformed file', () => {
    expect(readLabelsFile(path.join(dir, 'nope.json'))).toEqual({});
    fs.writeFileSync(path.join(dir, 'bad.json'), '{oops');
    expect(readLabelsFile(path.join(dir, 'bad.json'))).toEqual({});
  });
});

describe('attribution overrides and the unattributed guess', () => {
  it('guesses the chat that most recently edited the path', () => {
    const chats = [edits('claude:A', { 'x.ts': [1, 10] }), edits('claude:B', { 'x.ts': [2, 20] }), edits('claude:C', { 'y.ts': [1, 99] })];
    expect(guessOwner('x.ts', chats)).toEqual({ key: 'claude:B', at: 20 });
    expect(guessOwner('nothing.ts', chats)).toBeNull();
    expect(guessOwner('x.ts', [edits('claude:Z', { 'x.ts': [1, 5] }), edits('claude:A', { 'x.ts': [1, 5] })])?.key).toBe('claude:A');
  });

  it('moves a path to the assigned chat, exclusively, and persists in manager.db', () => {
    const db = openDb(':memory:');
    setOverride(db, '/r', 'a.ts', 'claude:B');
    setOverride(db, '/r', 'u.ts', 'claude:A');
    const ov = loadAllOverrides(db);
    expect(ov).toHaveLength(2);
    const chats = [edits('claude:A', { 'a.ts': [1, 2] }), edits('claude:B', { 'b.ts': [1, 2] })];
    const out = applyOverrides(chats, ov, 100);
    expect(Object.keys(out[0].edits).sort()).toEqual(['u.ts']);
    expect(Object.keys(out[1].edits).sort()).toEqual(['a.ts', 'b.ts']);
    expect(chats[0].edits['a.ts']).toBeDefined(); // input untouched
    // an unknown chat gets a row, and the ship grouping honors it
    const status = parsePorcelainZ(['M  a.ts', 'M  u.ts', 'M  loose.ts', ''].join('\0'));
    const g = groupNextShip(status, applyOverrides([], [{ repo: '/r', path: 'a.ts', key: 'claude:N' }], 5));
    expect(g.chats.map((c) => c.key)).toEqual(['claude:N']);
    expect(g.unattributed.map((f) => f.path).sort()).toEqual(['loose.ts', 'u.ts']);
    setOverride(db, '/r', 'a.ts', '');
    expect(loadAllOverrides(db).map((o) => o.path)).toEqual(['u.ts']);
  });
});

describe('buildShipDetail grouping', () => {
  const status = parsePorcelainZ(['M  a.ts', ' M b.ts', 'MM c.ts', '?? d.ts', 'M  e.ts', ''].join('\0'));
  const next = groupNextShip(status, [edits('claude:A', { 'a.ts': [1, 2], 'c.ts': [1, 2] }), edits('claude:B', { 'b.ts': [1, 2] })]);
  const board = { repo: '/r', slug: 'o/r', base: 'main', command: '/ship', labelRequired: true, generatedAt: 1, onMain: true, next, lock: null, shipped: [], byChat: {} } as ShipBoard;
  const stat = (p: string, a: number, d: number) => ({ path: p, added: a, deleted: d, binary: false });

  it('puts numstat on each file, totals the staged set, lists unstaged-touched, and keeps unattributed last with a guess', () => {
    const d = buildShipDetail({
      board,
      staged: [stat('a.ts', 3, 1), stat('c.ts', 2, 2), stat('e.ts', 5, 0)],
      unstaged: [stat('b.ts', 1, 1), stat('c.ts', 4, 0)],
      titles: { 'claude:A': 'Chat A' },
      labels: { 'claude:A': { label: 'did the A thing', source: 'db' } },
      guesses: { 'e.ts': { key: 'claude:Z', at: 9 } },
    });
    expect(d.totals).toEqual({ staged: 3, added: 10, deleted: 3, unstaged: 2 });
    expect(d.chats.map((c) => c.key)).toEqual(['claude:A']); // B staged nothing
    expect(d.onlyUnstagedChats).toBe(1);
    const a = d.chats[0];
    expect(a.label).toBe('did the A thing');
    expect(a.staged.map((f) => [f.path, f.added, f.deleted])).toEqual([['a.ts', 3, 1], ['c.ts', 2, 2]]);
    expect(a.unstaged.map((f) => [f.path, f.state, f.added])).toEqual([['c.ts', 'partial', 4]]);
    expect(d.unattributed.map((f) => [f.path, f.guess?.key ?? null])).toEqual([['e.ts', 'claude:Z'], ['d.ts', null]]);
    expect(d.gate.ok).toBe(true);
    expect(d.confirm).toContain('commits the 3 staged files as one batch');
    expect(d.commands).toEqual({ plain: '/ship' });
  });
});

describe('ship command, prompt and disabled rules', () => {
  const lock = { stale: false, holderKey: 'claude:H', pane: 'loom-tp-3:1.2', sessionId: 'H' };
  it('builds the prompt and confirm text', () => {
    expect(shipPrompt()).toBe('/loom:ship');
    expect(shipPrompt('/ship')).toBe('/ship');
    expect(shipConfirmText('/r', 1, '/ship')).toBe('Starts a new Claude session in /r running /ship. It commits the 1 staged file as one batch, opens a ship/ PR and merges it when CI and review are green.');
  });
  it('is disabled with a reason: lock held (with holder), nothing staged, off main; stale lock does not block', () => {
    expect(shipDisabledReason({ onMain: true, staged: 4, lock })).toMatchObject({ ok: false, holder: { key: 'claude:H', pane: 'loom-tp-3:1.2' } });
    expect(shipDisabledReason({ onMain: true, staged: 0, lock: null })).toEqual({ ok: false, reason: 'Nothing is staged.' });
    expect(shipDisabledReason({ onMain: false, staged: 2, lock: null }).ok).toBe(false);
    expect(shipDisabledReason({ onMain: true, staged: 2, lock: { ...lock, stale: true } }).ok).toBe(true);
    expect(shipDisabledReason({ onMain: true, staged: 2, lock: null })).toEqual({ ok: true, reason: '' });
  });
  it('launches through the thread starter with the exact prompt and cwd, using a stub (no session)', () => {
    const calls: any[] = [];
    const start = ((i: any) => (calls.push(i), { ok: true, detail: 'started', pane_id: '%9', where: 'loom-x · pane 0' })) as any;
    const d = { repo: '/r', command: '/ship', onMain: true, totals: { staged: 2, added: 0, deleted: 0, unstaged: 0 }, lock: null };
    expect(startShipSession(d, { start })).toEqual({ ok: true, paneId: '%9', where: 'loom-x · pane 0', prompt: '/ship' });
    expect(calls[0]).toMatchObject({ prompt: '/ship', projectDir: '/r', agent: 'claude' });
    startShipSession(d, { start });
    expect(calls[1].prompt).toBe('/ship');
  });
  it('refuses to launch when disabled, and surfaces a launch failure', () => {
    let n = 0;
    const start = (() => (n++, { ok: false, detail: 'no panes' })) as any;
    expect(startShipSession({ repo: '/r', onMain: true, totals: { staged: 0, added: 0, deleted: 0, unstaged: 0 }, lock: null }, { start })).toMatchObject({ ok: false, status: 409 });
    expect(startShipSession({ repo: '/r', onMain: true, totals: { staged: 1, added: 0, deleted: 0, unstaged: 0 }, lock: { sessionId: 'H', pane: '', holderKey: '', stale: false } as any }, { start })).toMatchObject({ ok: false });
    expect(n).toBe(0);
    expect(startShipSession({ repo: '/r', onMain: true, totals: { staged: 1, added: 0, deleted: 0, unstaged: 0 }, lock: null }, { start })).toEqual({ ok: false, status: 409, detail: 'no panes' });
  });
  it('rejects option-looking and escaping diff paths', () => {
    expect(['a/b.ts', 'x y.ts'].every(safeRepoPath)).toBe(true);
    expect(['', '-rf', '/etc/passwd', '../x', 'a/../../x'].some(safeRepoPath)).toBe(false);
  });
});
