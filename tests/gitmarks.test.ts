import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildGitMarks, markFromStates, markFromStatus, marksFromNext, parseRevParse } from '../src/gitmarks.ts';
import { GITMARK_JS } from '../src/gitmarkview.ts';
import { parsePorcelainZ } from '../src/detail.ts';
import type { NextShip, ShipBoard } from '../src/ships.ts';
import type { ChatView } from '../src/dashboard.ts';

const z = (...rows: string[]) => rows.map((r) => r + '\0').join('');
const NOW = Date.parse('2026-11-08T12:00:00Z');
const view = (sid: string, dir: string, extra: Partial<ChatView> = {}) =>
  ({ agent: 'claude', session_id: sid, project_dir: dir, last_active_at: NOW - 60_000, jsonl_path: '/nonexistent/' + sid + '.jsonl', ...extra }) as ChatView;

describe('git mark state', () => {
  it('ranks untracked > unstaged > staged > clean, and counts partial as unstaged', () => {
    expect(markFromStates([])).toEqual({ state: 'clean', staged: 0, unstaged: 0, untracked: 0 });
    expect(markFromStates(['staged', 'staged']).state).toBe('staged');
    expect(markFromStates(['staged', 'partial'])).toEqual({ state: 'unstaged', staged: 1, unstaged: 1, untracked: 0 });
    expect(markFromStates(['staged', 'unstaged', 'untracked'])).toEqual({ state: 'untracked', staged: 1, unstaged: 1, untracked: 1 });
  });

  it('a worktree owns its whole status', () => {
    const m = markFromStatus(parsePorcelainZ(z('M  a.ts', 'MM b.ts', '?? c.ts')));
    expect(m).toEqual({ state: 'untracked', staged: 1, unstaged: 1, untracked: 1, worktree: true });
    expect(markFromStatus(new Map()).state).toBe('clean');
  });

  it('a shared checkout gives each chat its own files, and a chat with none is clean', () => {
    const next: NextShip = {
      chats: [{ key: 'claude:A', files: [{ path: 'a', state: 'staged' }, { path: 'b', state: 'staged' }], staged: 2, unstaged: 0 }],
      unattributed: [{ path: 'x', state: 'untracked' }],
      shared: [],
      staged: 2,
      unstaged: 1,
    };
    const m = marksFromNext(next, ['claude:A', 'claude:B']);
    expect(m['claude:A']).toEqual({ state: 'staged', staged: 2, unstaged: 0, untracked: 0 });
    expect(m['claude:B'].state).toBe('clean'); // the unattributed untracked file is not B's
  });

  it('tells a linked worktree from the primary checkout', () => {
    expect(parseRevParse('/r\n/r/.git\n/r/.git\n')).toEqual({ top: '/r', worktree: false });
    expect(parseRevParse('/r/.worktrees/x\n/r/.git/worktrees/x\n/r/.git\n')).toEqual({ top: '/r/.worktrees/x', worktree: true });
    expect(parseRevParse('')).toBeNull();
  });
});

describe('buildGitMarks', () => {
  const locs: Record<string, string> = {
    '/r': '/r\n/r/.git\n/r/.git\n',
    '/r/apps': '/r\n/r/.git\n/r/.git\n',
    '/r/.worktrees/w': '/r/.worktrees/w\n/r/.git/worktrees/w\n/r/.git\n',
    '/o': '/o\n/o/.git\n/o/.git\n',
  };
  const statuses: Record<string, string> = { '/r/.worktrees/w': z(' M a.ts', 'A  b.ts'), '/o': z('M  one.ts', '?? stray.ts') };
  const calls: string[] = [];
  const git = async (args: string[], cwd: string) => {
    calls.push(args[0] + ' ' + cwd);
    if (args[0] === 'rev-parse') {
      if (!(cwd in locs)) throw new Error('not a git repository');
      return locs[cwd];
    }
    if (args[0] === 'status') return statuses[cwd] ?? '';
    throw new Error('unexpected ' + args.join(' '));
  };
  const board = {
    repo: '/r',
    onMain: true,
    next: { chats: [{ key: 'claude:S', files: [{ path: 'x', state: 'partial' }], staged: 1, unstaged: 0 }], unattributed: [], shared: [], staged: 1, unstaged: 0 },
  } as unknown as ShipBoard;

  it('marks worktree, Ship-repo and other shared chats; leaves no-repo chats unmarked', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitmarks-'));
    const jsonl = path.join(dir, 'O.jsonl');
    fs.writeFileSync(jsonl, JSON.stringify({ type: 'assistant', cwd: '/o', timestamp: '2026-11-08T08:00:00Z', message: { content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/o/one.ts' } }] } }) + '\n');
    const views = [
      view('W', '/r/.worktrees/w'),
      view('S', '/r/apps'),
      view('T', '/r'),
      view('O', '/o', { jsonl_path: jsonl }),
      view('N', '/tmp/nowhere'),
      view('OLD', '/r', { last_active_at: NOW - 30 * 86_400_000 }),
    ];
    calls.length = 0;
    const m = await buildGitMarks(views, {}, [board], git, NOW);
    expect(m['claude:W']).toEqual({ state: 'unstaged', staged: 1, unstaged: 1, untracked: 0, worktree: true });
    expect(m['claude:S']).toEqual({ state: 'unstaged', staged: 0, unstaged: 1, untracked: 0 }); // partial counts as unstaged
    expect(m['claude:T'].state).toBe('clean');
    expect(m['claude:O']).toEqual({ state: 'staged', staged: 1, unstaged: 0, untracked: 0 }); // stray.ts is not O's
    expect(m['claude:N']).toBeUndefined();
    expect(m['claude:OLD']).toBeUndefined();
    // The Ship repo reuses the board: no status of its own.
    expect(calls.filter((c) => c.startsWith('status'))).toEqual(['status /r/.worktrees/w', 'status /o']);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('gitMarkHtml', () => {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const { gitMarkHtml } = new Function('esc', `${GITMARK_JS}; return { gitMarkHtml };`)(esc) as { gitMarkHtml: (m: unknown) => string };

  it('renders one glyph per state with counts in the tooltip', () => {
    expect(gitMarkHtml(undefined)).toBe('');
    expect(gitMarkHtml({ state: 'clean', staged: 0, unstaged: 0, untracked: 0 })).toBe('<span class="smk gclean" title="clean: no changed files">○</span>');
    expect(gitMarkHtml({ state: 'staged', staged: 3, unstaged: 0, untracked: 0 })).toContain('class="smk gok" title="3 staged (this chat’s files)">✓<');
    expect(gitMarkHtml({ state: 'unstaged', staged: 1, unstaged: 2, untracked: 0, worktree: true })).toContain('class="smk gwip" title="1 staged · 2 unstaged (worktree)">●<');
    expect(gitMarkHtml({ state: 'untracked', staged: 3, unstaged: 1, untracked: 2 })).toContain('title="3 staged · 1 unstaged · 2 untracked (this chat’s files)">◌<');
  });
});
