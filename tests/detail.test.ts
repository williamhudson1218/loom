import { describe, expect, it } from 'vitest';
import {
  branchFileStates,
  ciState,
  parseNameStatus,
  parsePorcelainZ,
  parsePrUrl,
  prLookup,
  sessionFileStates,
  toPrInfo,
  whereFor,
} from '../src/detail.ts';
import { emptyScan, runningBackground, scanLines } from '../src/sessionscan.ts';
import { renderMarkdown } from '../src/markdown.ts';
import { renderDashboard } from '../src/dashboard.ts';

const line = (o: unknown) => JSON.stringify(o);
const asst = (content: unknown[], ts = '2026-10-16T10:00:00Z') =>
  line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content } });
const user = (content: unknown, ts = '2026-10-16T10:00:01Z') =>
  line({ type: 'user', timestamp: ts, message: { role: 'user', content } });

describe('sessionscan', () => {
  it('collects every file the session edited, across all four edit tools', () => {
    const s = scanLines([
      asst([{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/r/a.ts' } }]),
      asst([{ type: 'tool_use', id: 't2', name: 'Write', input: { file_path: '/r/b.ts' } }]),
      asst([{ type: 'tool_use', id: 't3', name: 'MultiEdit', input: { file_path: '/r/c.ts' } }]),
      asst([{ type: 'tool_use', id: 't4', name: 'NotebookEdit', input: { notebook_path: '/r/d.ipynb' } }]),
      asst([{ type: 'tool_use', id: 't5', name: 'Read', input: { file_path: '/r/e.ts' } }]),
    ], emptyScan());
    expect(Object.keys(s.editedFiles).sort()).toEqual(['/r/a.ts', '/r/b.ts', '/r/c.ts', '/r/d.ipynb']);
  });

  it('ignores sidechain (subagent) edits — they are not this session’s own', () => {
    const s = scanLines([line({ type: 'assistant', isSidechain: true, message: { content: [{ type: 'tool_use', id: 'x', name: 'Edit', input: { file_path: '/r/z.ts' } }] } })], emptyScan());
    expect(s.editedFiles).toEqual({});
  });

  it('keeps only the latest todo list and the last assistant prose', () => {
    const s = scanLines([
      asst([{ type: 'tool_use', id: 'a', name: 'TodoWrite', input: { todos: [{ content: 'old', status: 'pending' }] } }]),
      asst([{ type: 'text', text: 'first' }]),
      asst([{ type: 'tool_use', id: 'b', name: 'TodoWrite', input: { todos: [{ content: 'new', status: 'in_progress', activeForm: 'Doing new' }] } }]),
      asst([{ type: 'text', text: 'second' }]),
    ], emptyScan());
    expect(s.todos).toEqual([{ content: 'new', status: 'in_progress', activeForm: 'Doing new' }]);
    expect(s.lastAssistant?.text).toBe('second');
  });

  it('tracks a background task from its acknowledgement until its notification', () => {
    const s = emptyScan();
    scanLines([
      asst([{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { command: 'yarn test', description: 'Run tests', run_in_background: true } }]),
      user([{ type: 'tool_result', tool_use_id: 'bg1', content: 'Command running in background with ID: b123.' }]),
      asst([{ type: 'tool_use', id: 'fg1', name: 'Agent', input: { description: 'Look around' } }]),
      user([{ type: 'tool_result', tool_use_id: 'fg1', content: [{ type: 'text', text: 'Here is what I found' }] }]),
      asst([{ type: 'tool_use', id: 'bg2', name: 'Agent', input: { description: 'Build it' } }]),
      user([{ type: 'tool_result', tool_use_id: 'bg2', content: [{ type: 'text', text: 'Async agent launched successfully.' }] }]),
    ], s);
    expect(runningBackground(s, Date.parse('2026-10-16T10:05:00Z')).map((t) => t.desc)).toEqual(['Run tests', 'Build it']);
    // The notice arrives as a queue operation, not a user turn.
    scanLines([line({ type: 'queue-operation', content: '<task-notification>\n<task-id>b123</task-id>\n<tool-use-id>bg1</tool-use-id>\n<status>completed</status>' })], s);
    expect(runningBackground(s, Date.parse('2026-10-16T10:05:00Z')).map((t) => t.desc)).toEqual(['Build it']);
  });

  it('drops a background bash stopped with TaskStop', () => {
    const s = scanLines([
      asst([{ type: 'tool_use', id: 'bg1', name: 'Bash', input: { description: 'Serve', run_in_background: true } }]),
      user([{ type: 'tool_result', tool_use_id: 'bg1', content: 'Command running in background with ID: b77.' }]),
      asst([{ type: 'tool_use', id: 's1', name: 'TaskStop', input: { task_id: 'b77' } }]),
    ], emptyScan());
    expect(runningBackground(s, Date.parse('2026-10-16T10:05:00Z'))).toEqual([]);
  });
});

describe('detail git parsing', () => {
  it('reads name-status, taking the new path of a rename', () => {
    expect(parseNameStatus('M\tsrc/a.ts\nR100\told.ts\tnew.ts\nA\tb.ts\n')).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'new.ts' },
      { status: 'A', path: 'b.ts' },
    ]);
  });

  it('reads -z porcelain, skipping a rename’s original path', () => {
    const m = parsePorcelainZ(' M src/a.ts\0M  src/b.ts\0R  new name.ts\0old.ts\0?? scratch.md\0');
    expect([...m.keys()]).toEqual(['src/a.ts', 'src/b.ts', 'new name.ts', 'scratch.md']);
    expect(m.get('src/b.ts')).toEqual({ x: 'M', y: ' ' });
  });

  it('marks a shared-checkout session’s own files against git, and nothing else', () => {
    const status = parsePorcelainZ(' M src/a.ts\0M  src/b.ts\0?? src/c.ts\0 M src/not-mine.ts\0');
    const files = sessionFileStates(
      ['/repo/src/a.ts', '/repo/src/b.ts', '/repo/src/c.ts', '/repo/src/d.ts', '/repo/src/e.ts', '/repo/scripts/local/x.ts', '/tmp/scratch.md'],
      '/repo',
      status,
      new Set(['src/d.ts']),
      new Set(['scripts/local/x.ts']),
    );
    expect(files.map((f) => [f.path, f.state])).toEqual([
      ['src/a.ts', 'uncommitted'],
      ['src/c.ts', 'untracked'],
      ['src/b.ts', 'staged'],
      ['src/d.ts', 'committed'],
      ['src/e.ts', 'unchanged'],
      ['scripts/local/x.ts', 'ignored'],
      ['/tmp/scratch.md', 'outside'],
    ]);
  });

  it('overlays uncommitted state on a branch’s committed files', () => {
    const files = branchFileStates(parseNameStatus('M\tsrc/a.ts\nA\tsrc/b.ts\n'), parsePorcelainZ(' M src/a.ts\0'));
    expect(files.map((f) => [f.path, f.state])).toEqual([['src/a.ts', 'uncommitted'], ['src/b.ts', 'committed']]);
  });

  it('classifies a worktree, a branch on the primary checkout, and main', async () => {
    const git = (top: string, branch: string) => async (args: string[]) => {
      if (args[0] === 'rev-parse' && args.includes('--show-toplevel')) return `${top}\n${branch}\n`;
      if (args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
      if (args[0] === 'rev-list') return '3\t5\n';
      return '';
    };
    const root = () => '/repo';
    expect(await whereFor('/', git('/repo/.worktrees/x', 'feat-x'), root)).toMatchObject({ kind: 'worktree', branch: 'feat-x', base: 'origin/main', behind: 3, ahead: 5 });
    expect(await whereFor('/', git('/repo', 'feat-y'), root)).toMatchObject({ kind: 'branch', branch: 'feat-y' });
    expect(await whereFor('/', git('/repo', 'main'), root)).toMatchObject({ kind: 'main', ahead: 0, behind: 0 });
  });
});

describe('PR summary', () => {
  it('folds a check rollup into one CI state', () => {
    expect(ciState([])).toBe('none');
    expect(ciState([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { state: 'SUCCESS' }])).toBe('pass');
    expect(ciState([{ status: 'IN_PROGRESS', conclusion: '' }, { status: 'COMPLETED', conclusion: 'SUCCESS' }])).toBe('pending');
    expect(ciState([{ status: 'IN_PROGRESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' }])).toBe('fail');
  });

  it('reads the repo and number off a PR url', () => {
    expect(parsePrUrl('https://github.com/tax-pilot-org/tax-pilot-app/pull/3110')).toEqual({ repo: 'tax-pilot-org/tax-pilot-app', number: 3110 });
    expect(parsePrUrl('nope')).toBeNull();
  });

  it('answers loading on a miss without waiting, then serves the cached result', async () => {
    let calls = 0;
    const gh = async () => {
      calls++;
      return JSON.stringify({ number: 7, title: 'T', url: 'u', state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [] });
    };
    expect(prLookup('7', '/r', 'o/unique-repo', gh)).toEqual({ loading: true, ref: '7' });
    await new Promise((r) => setTimeout(r, 10));
    expect(prLookup('7', '/r', 'o/unique-repo', gh)).toEqual(toPrInfo({ number: 7, title: 'T', url: 'u', state: 'OPEN', isDraft: true, reviewDecision: 'REVIEW_REQUIRED', statusCheckRollup: [] }));
    expect(calls).toBe(1);
  });
});

describe('markdown', () => {
  it('escapes before formatting, so transcript text cannot inject markup', () => {
    expect(renderMarkdown('<script>x</script> **bold** `a<b`')).toBe('<p>&lt;script&gt;x&lt;/script&gt; <b>bold</b> <code>a&lt;b</code></p>');
  });

  it('renders headings, lists, fences and links', () => {
    const html = renderMarkdown('## Head\n\n- one\n- two\n\n```\ncode <x>\n```\n[PR](https://github.com/o/r/pull/1)');
    expect(html).toContain('<h4>Head</h4>');
    expect(html).toContain('<ul><li>one</li><li>two</li></ul>');
    expect(html).toContain('<pre>code &lt;x&gt;</pre>');
    expect(html).toContain('<a href="https://github.com/o/r/pull/1" target="_blank" rel="noopener">PR</a>');
  });
});

describe('detail panel shell', () => {
  it('ships the panel column, its fetch, and the waiting-on-you empty state', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('id="boardwrap"');
    expect(html).toContain('id="detail"');
    expect(html).toContain('/api/detail?session=');
    expect(html).toContain('/api/tails?keys=');
    expect(html).toContain('Waiting on you');
  });
});

describe('light cards', () => {
  it('drops the button row from board cards; open and save ride the title line, PR the meta line', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    const card = html.slice(html.indexOf('function card(c){'), html.indexOf("$('#gen').textContent"));
    expect(card).not.toContain('class="resume"');
    expect(card).not.toContain('copy id');
    expect(card).not.toContain('branchbtn');
    expect(card).toContain('class="ico open"');
    expect(card).toContain('class="ico savebtn"');
    expect(card).toContain("' · <span class=\"prn\"");
  });
});

describe('markdown quotes', () => {
  it('renders a run of > lines as one blockquote', () => {
    expect(renderMarkdown('> one\n> two\n\nafter')).toBe('<blockquote><p>one<br>two</p></blockquote><p>after</p>');
  });
});
