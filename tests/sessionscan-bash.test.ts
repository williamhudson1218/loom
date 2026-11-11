import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bashWrittenFiles, chatEditedFiles, emptyScan, scanLines } from '../src/sessionscan.ts';

const R = '/repo';

describe('bashWrittenFiles: files a shell command writes or stages', () => {
  it('git add <paths>, relative to the cwd, ignoring flags and stage-everything forms', () => {
    expect(bashWrittenFiles('git add apps/a.ts packages/b.ts && git status', R).sort()).toEqual(['/repo/apps/a.ts', '/repo/packages/b.ts']);
    expect(bashWrittenFiles('git add -- apps/a.ts', R)).toEqual(['/repo/apps/a.ts']);
    expect(bashWrittenFiles('git add -A', R)).toEqual([]);
    // A multi-line git add with quoted Next.js paths (brackets, route groups, spaces).
    expect(bashWrittenFiles('cd /repo && git add -- \\\n  "apps/x/[id]/route.ts" "apps/(auth)/page.tsx" \\\n  \'apps/a b/c.ts\'', R).sort()).toEqual(['/repo/apps/(auth)/page.tsx', '/repo/apps/a b/c.ts', '/repo/apps/x/[id]/route.ts']);
    expect(bashWrittenFiles('git add "$F"', R)).toEqual([]);
    expect(bashWrittenFiles('git add .', R)).toEqual([]);
  });
  it('a leading cd moves the base', () => {
    expect(bashWrittenFiles('cd apps/client && git add src/x.ts', R)).toEqual(['/repo/apps/client/src/x.ts']);
  });
  it('python heredoc writes through a named path or a literal', () => {
    const cmd = "python3 - <<'EOF'\np='apps/client-app/src/lib/wageReportSort.ts'\ns=open(p).read()\ns=s.replace('a','b')\nopen(p,'w').write(s)\nEOF";
    expect(bashWrittenFiles(cmd, R)).toEqual(['/repo/apps/client-app/src/lib/wageReportSort.ts']);
    expect(bashWrittenFiles("python3 -c \"open('x/y.ts','w').write('')\"", R)).toEqual(['/repo/x/y.ts']);
  });
  it('a python read alone is not a write', () => {
    expect(bashWrittenFiles("python3 - <<'EOF'\np='apps/a.ts'\nprint(open(p).read())\nEOF", R)).toEqual([]);
  });
  it('sed -i, redirects and tee', () => {
    expect(bashWrittenFiles("sed -i '' 's/a/b/' src/a.ts src/b.ts", R).sort()).toEqual(['/repo/src/a.ts', '/repo/src/b.ts']);
    expect(bashWrittenFiles('echo hi > notes/out.md', R)).toEqual(['/repo/notes/out.md']);
    expect(bashWrittenFiles("cat > src/new.ts <<'EOF'\nx\nEOF", R)).toEqual(['/repo/src/new.ts']);
    expect(bashWrittenFiles('yarn test 2>&1 | tee logs/t.log', R)).toEqual(['/repo/logs/t.log']);
  });
  it('reads, fd redirects and variables are not owner signals', () => {
    expect(bashWrittenFiles('cat src/a.ts; grep -n x src/b.ts', R)).toEqual([]);
    expect(bashWrittenFiles('yarn jest 2>/dev/null', R)).toEqual([]);
    expect(bashWrittenFiles('yarn build > $LOG', R)).toEqual([]);
  });
});

describe('scanLines counts Bash writes as edits', () => {
  it('uses the transcript cwd for relative paths', () => {
    const line = JSON.stringify({ type: 'assistant', cwd: R, timestamp: '2026-11-08T08:16:00Z', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git add apps/a.ts' } }] } });
    const s = scanLines([line], emptyScan());
    expect(Object.keys(s.editedFiles)).toEqual(['/repo/apps/a.ts']);
  });
});

describe('chatEditedFiles folds in subagent transcripts', () => {
  it("a subagent's Edit counts for the chat that started it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loomscan-'));
    const main = path.join(dir, 'sess.jsonl');
    fs.writeFileSync(main, JSON.stringify({ type: 'assistant', cwd: R, timestamp: '2026-11-08T08:00:00Z', message: { content: [{ type: 'tool_use', id: 'a', name: 'Edit', input: { file_path: '/repo/one.ts' } }] } }) + '\n');
    fs.mkdirSync(path.join(dir, 'sess', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess', 'subagents', 'agent-x.jsonl'), JSON.stringify({ type: 'assistant', isSidechain: true, cwd: R, timestamp: '2026-11-08T08:05:00Z', message: { content: [{ type: 'tool_use', id: 'b', name: 'Write', input: { file_path: '/repo/two.ts' } }] } }) + '\n');
    expect(Object.keys(chatEditedFiles(main).last).sort()).toEqual(['/repo/one.ts', '/repo/two.ts']);
  });
});

describe('bashWrittenFiles: multi-step commands', () => {
  it('follows every cd, and a heredoc body is never read as shell', () => {
    const cmd = "cd /repo/apps/src && mkdir -p a/Review && cd a/Review && cat > reviewText.ts <<'EOF'\nexport const gt = (x: number) => x > limit.value;\nEOF\ncat > reviewIssues.ts <<'EOF'\nx\nEOF";
    expect(bashWrittenFiles(cmd, R).sort()).toEqual(['/repo/apps/src/a/Review/reviewIssues.ts', '/repo/apps/src/a/Review/reviewText.ts']);
  });
  it('a python heredoc after a cd resolves against that directory', () => {
    const cmd = "cd apps/x && python3 - <<'EOF'\ns=open('page.tsx').read()\nopen('page.tsx','w').write(s)\nEOF";
    expect(bashWrittenFiles(cmd, R)).toEqual(['/repo/apps/x/page.tsx']);
  });
});
