import { describe, expect, it } from 'vitest';
import { findOrphanShells, parseEtime, parsePs, sweepOrphanShells } from '../src/orphans.ts';

const PS = [
  ' 100     1 ??        17-10:18:00 tmux',
  ' 201   100 ttys001   10-02:00:00 -zsh', // orphan: no pane on ttys001
  ' 202   100 ttys002      05:00:00 -zsh', // live pane
  ' 203   100 ttys003         00:30 -zsh', // too young: maybe a pane mid-creation
  ' 204   100 ttys004      01:00:00 node', // not a shell
  ' 205   999 ttys005      01:00:00 -zsh', // another parent (Ghostty tab)
  ' 206   100 ttys006      01:00:00 -zsh', // pane pid listed, tty differs
].join('\n');
const PANES = [{ tty: '/dev/ttys002', pid: 202 }, { tty: '/dev/ttys009', pid: 206 }];

describe('orphaned shells', () => {
  it('parses ps etime', () => {
    expect(parseEtime('00:30')).toBe(30);
    expect(parseEtime('05:00:00')).toBe(5 * 3600);
    expect(parseEtime('10-02:00:00')).toBe(10 * 86400 + 2 * 3600);
    expect(parseEtime('junk')).toBeNaN();
  });

  it('finds only an old shell of the tmux server on a tty no pane owns', () => {
    const o = findOrphanShells(parsePs(PS), 100, PANES);
    expect(o.map((x) => x.pid)).toEqual([201]);
    expect(o[0]).toMatchObject({ tty: 'ttys001', comm: '-zsh' });
  });

  it('finds nothing without a server pid', () => {
    expect(findOrphanShells(parsePs(PS), 0, PANES)).toEqual([]);
  });

  const run = (panes: string) => (args: string[]) => (args[0] === 'display-message' ? '100\n' : args[0] === 'list-panes' ? panes : '');

  it('a sweep kills and logs the orphans', () => {
    const killed: number[] = [];
    const logs: string[] = [];
    const r = sweepOrphanShells({ run: run('/dev/ttys002 202\n/dev/ttys009 206\n'), ps: () => PS, kill: (p) => killed.push(p), log: (m) => logs.push(m) });
    expect(killed).toEqual([201]);
    expect(r.map((x) => x.pid)).toEqual([201]);
    expect(logs[0]).toMatch(/killed -zsh pid 201 on ttys001/);
  });

  it('kills nothing when the pane list comes back empty', () => {
    const killed: number[] = [];
    sweepOrphanShells({ run: run(''), ps: () => PS, kill: (p) => killed.push(p), log: () => {} });
    expect(killed).toEqual([]);
  });

  it('never throws', () => {
    expect(sweepOrphanShells({ run: () => { throw new Error('no server'); }, ps: () => PS, kill: () => {}, log: () => {} })).toEqual([]);
  });
});
