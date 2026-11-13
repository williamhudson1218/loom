import { describe, it, expect } from 'vitest';
import { JUMP_PURE_JS, JUMP_VIEW_JS } from '../src/jumpbox.ts';
import { pageBindings } from '../src/keymap.ts';

type It = { label: string; hay?: string; id?: string; ts?: number; keep?: boolean };
type Sec = { id: string; title: string; items: It[]; loading?: boolean };
const api = new Function(`${JUMP_PURE_JS}; return {jumpScore,jumpFilter,jumpSections,jumpFlat,jumpAge,jumpPenalty,jumpActions};`)() as {
  jumpPenalty: (ts: number, now?: number) => number;
  jumpScore: (l: string, h: string, q: string) => number;
  jumpFilter: (i: It[], q: string, n?: number, now?: number) => It[];
  jumpSections: (c: It[], m: It[], a: It[], q: string, o?: { archWanted?: boolean; archLoading?: boolean; now?: number }) => Sec[];
  jumpFlat: (s: Sec[]) => It[];
  jumpAge: (ts: number, now?: number) => string;
  jumpActions: (it: { kind: string } | null, meta?: boolean) => { act: string; hint: string } | null;
};

describe('jump box ranking', () => {
  it('matches everything on an empty query', () => {
    expect(api.jumpScore('Anything', '', '')).toBe(0);
  });
  it('scores label prefix < word start < inside label < hay only, and rejects a miss', () => {
    expect(api.jumpScore('Settings', '', 'set')).toBe(0);
    expect(api.jumpScore('Go to Settings', '', 'set')).toBe(1);
    expect(api.jumpScore('Offsetting', '', 'set')).toBe(2);
    expect(api.jumpScore('Restore', 'rebuild tmux', 'tmux')).toBe(3);
    expect(api.jumpScore('Restore', 'rebuild', 'zzz')).toBe(-1);
  });
  it('requires every token and treats regex characters literally', () => {
    expect(api.jumpScore('Fix ACH retry', 'tax-pilot', 'ach pilot')).toBe(1 + 3);
    expect(api.jumpScore('Fix ACH retry', '', 'ach zzz')).toBe(-1);
    expect(api.jumpScore('a (b) c', '', '(b')).toBeGreaterThanOrEqual(0);
    expect(api.jumpScore('abc', '', '.*')).toBe(-1);
  });
  it('sorts best first and keeps input order on ties', () => {
    const items = [{ label: 'zz ach' }, { label: 'ach one' }, { label: 'ach two' }];
    expect(api.jumpFilter(items, 'ach').map((i) => i.label)).toEqual(['ach one', 'ach two', 'zz ach']);
    expect(api.jumpFilter(items, 'ach', 1)).toHaveLength(1);
  });
  it('orders sections chats, commands, archived and drops empty groups', () => {
    const chats = [{ label: 'billing chat' }];
    const cmds = [{ label: 'Settings' }, { label: 'Go to Board' }];
    const arch = [{ label: 'old billing' }];
    const s = api.jumpSections(chats, cmds, arch, 'bil', { archWanted: true });
    expect(s.map((x) => x.id)).toEqual(['chats', 'arch']);
    const all = api.jumpSections(chats, cmds, arch, '', { archWanted: false });
    expect(all.map((x) => x.id)).toEqual(['chats', 'cmds']);
    expect(api.jumpFlat(all).map((i) => i.label)).toEqual(['billing chat', 'Settings', 'Go to Board']);
  });
  it('shows an archived section with a loading row before hits arrive', () => {
    const s = api.jumpSections([], [], [], 'xyz', { archWanted: true, archLoading: true });
    expect(s).toEqual([{ id: 'arch', title: 'Archived', items: [], loading: true }]);
    expect(api.jumpSections([], [], [], 'x', { archWanted: false, archLoading: false })).toEqual([]);
  });
});

describe('jump box archived age', () => {
  const now = 1_800_000_000_000;
  it('renders compact relative age from the last update', () => {
    expect(api.jumpAge(now - 30_000, now)).toBe('now');
    expect(api.jumpAge(now - 5 * 60_000, now)).toBe('5m');
    expect(api.jumpAge(now - 3 * 3600_000, now)).toBe('3h');
    expect(api.jumpAge(now - 2 * 86400_000, now)).toBe('2d');
    expect(api.jumpAge(now - 21 * 86400_000, now)).toBe('3w');
  });
  it('accepts epoch seconds and blanks unknown times', () => {
    expect(api.jumpAge((now - 3 * 3600_000) / 1000, now)).toBe('3h');
    expect(api.jumpAge(0, now)).toBe('');
  });
});

describe('jump box wiring', () => {
  it('parses as page JS', () => {
    expect(() => new Function(`${JUMP_PURE_JS}\n${JUMP_VIEW_JS}`)).not.toThrow();
  });
  it('registers ⌘K in the keymap as a page binding', () => {
    expect(pageBindings().some((k) => k.action === 'jump' && k.match?.key === 'k' && k.match.meta)).toBe(true);
  });
});

describe('jump box recency', () => {
  const now = Date.parse('2026-11-12T12:00:00Z');
  const day = 86400000;
  it('ranks a recent match above an old one with the same text score', () => {
    const items = [
      { label: 'ach retry', ts: now - 60 * day },
      { label: 'ach prenote', ts: now - 1 * day },
    ];
    expect(api.jumpFilter(items, 'ach', 8, now).map((i) => i.label)).toEqual(['ach prenote', 'ach retry']);
  });
  it('still lets a clearly better text match beat a slightly newer weak one', () => {
    const items = [
      { label: 'xxach', ts: now - 1 * day },
      { label: 'ach exact', ts: now - 30 * day },
    ];
    expect(api.jumpFilter(items, 'ach', 8, now)[0].label).toBe('ach exact');
  });
  it('accepts epoch seconds and does not dock items with no time', () => {
    expect(api.jumpPenalty(0, now)).toBe(0);
    expect(api.jumpPenalty((now - 60 * day) / 1000, now)).toBe(1.5);
  });
  it('ranks archived hits by recency too and keeps body-only matches', () => {
    const arch = [
      { label: 'zzz old', ts: now - 90 * day, keep: true },
      { label: 'zzz new', ts: now - 2 * day, keep: true },
    ];
    const s = api.jumpSections([], [], arch, 'unrelated', { archWanted: true, now });
    expect(s[0].items.map((i) => i.label)).toEqual(['zzz new', 'zzz old']);
  });
});

describe('jump box row actions', () => {
  it('archived chats resume on Enter and preview on Cmd+Enter', () => {
    expect(api.jumpActions({ kind: 'arch' })).toEqual({ act: 'resume', hint: 'Resume' });
    expect(api.jumpActions({ kind: 'arch' }, true)).toEqual({ act: 'preview', hint: 'Preview' });
  });
  it('open chats and commands keep their single action', () => {
    expect(api.jumpActions({ kind: 'chat' }, true)?.act).toBe('open');
    expect(api.jumpActions({ kind: 'cmd' })?.act).toBe('run');
    expect(api.jumpActions(null)).toBeNull();
  });
});
