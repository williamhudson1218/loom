import { describe, it, expect } from 'vitest';
import { JUMP_PURE_JS, JUMP_VIEW_JS } from '../src/jumpbox.ts';
import { pageBindings } from '../src/keymap.ts';

type It = { label: string; hay?: string; id?: string };
type Sec = { id: string; title: string; items: It[]; loading?: boolean };
const api = new Function(`${JUMP_PURE_JS}; return {jumpScore,jumpFilter,jumpSections,jumpFlat};`)() as {
  jumpScore: (l: string, h: string, q: string) => number;
  jumpFilter: (i: It[], q: string, n?: number) => It[];
  jumpSections: (c: It[], m: It[], a: It[], q: string, o?: { archWanted?: boolean; archLoading?: boolean }) => Sec[];
  jumpFlat: (s: Sec[]) => It[];
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

describe('jump box wiring', () => {
  it('parses as page JS', () => {
    expect(() => new Function(`${JUMP_PURE_JS}\n${JUMP_VIEW_JS}`)).not.toThrow();
  });
  it('registers ⌘K in the keymap as a page binding', () => {
    expect(pageBindings().some((k) => k.action === 'jump' && k.match?.key === 'k' && k.match.meta)).toBe(true);
  });
});
