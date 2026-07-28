import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseJsonlFile, localDay, cleanText } from '../src/parser.ts';
import { parseCodexJsonlFile } from '../src/codexParser.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');
const CODEX_FIX = path.join(__dirname, 'fixtures', 'codex-chat.jsonl');

describe('parseJsonlFile', () => {
  it('extracts core fields', async () => {
    const c = await parseJsonlFile(FIX);
    expect(c.session_id).toBe('sess-abc');
    expect(c.project_dir).toBe('/Users/me/dev/proj');
    expect(c.jsonl_path).toBe(FIX);
    expect(c.message_count).toBe(5); // 3 user + 2 assistant
    expect(c.first_message).toBe('first thing I said');
    expect(c.claude_auto_title).toBe('Stale auto title');
    expect(c.files_touched).toEqual(['/Users/me/dev/proj/a.ts', '/Users/me/dev/proj/b.ts']);
  });

  it('buckets user messages per local day', async () => {
    const c = await parseJsonlFile(FIX);
    const days = Object.keys(c.activity).sort();
    expect(days.length).toBe(2);
    const total = Object.values(c.activity).reduce((a, b) => a + b, 0);
    expect(total).toBe(3); // only user messages counted
  });

  it('localDay formats local YYYY-MM-DD', () => {
    const ts = new Date(2026, 5, 15, 12, 0, 0).getTime(); // local June 15 2026
    expect(localDay(ts)).toBe('2026-06-15');
  });

  it('detects the last GitHub PR url mentioned in the transcript', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-pr-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'user', sessionId: 's', cwd: '/x', timestamp: '2026-06-15T12:00:00.000Z', message: { role: 'user', content: 'review https://github.com/org/repo/pull/100' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-06-15T12:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Opened https://github.com/tax-pilot-org/tax-pilot-app/pull/787' }] } }),
      ].join('\n'),
    );
    const c = await parseJsonlFile(f);
    expect(c.pr_url).toBe('https://github.com/tax-pilot-org/tax-pilot-app/pull/787');
  });

  it('separates written files from merely-read files', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-written-'));
    const f = path.join(dir, 'c.jsonl');
    fs.writeFileSync(
      f,
      [
        JSON.stringify({ type: 'user', sessionId: 's', cwd: '/x', timestamp: '2026-07-27T12:00:00.000Z', message: { role: 'user', content: 'go' } }),
        JSON.stringify({
          type: 'assistant',
          timestamp: '2026-07-27T12:01:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', name: 'Read', input: { file_path: '/x/AGENTS.md' } },
              { type: 'tool_use', name: 'Edit', input: { file_path: '/x/a.ts' } },
              { type: 'tool_use', name: 'Write', input: { file_path: '/x/b.ts' } },
            ],
          },
        }),
      ].join('\n'),
    );
    const c = await parseJsonlFile(f);
    expect(c.files_written).toEqual(['/x/a.ts', '/x/b.ts']);
    // files_touched keeps its existing meaning: reads included.
    expect(c.files_touched).toEqual(['/x/AGENTS.md', '/x/a.ts', '/x/b.ts']);
  });
});

describe('parseCodexJsonlFile', () => {
  it('parses Codex metadata and conversation events', async () => {
    const c = await parseCodexJsonlFile(CODEX_FIX);
    expect(c).toMatchObject({
      agent: 'codex',
      session_id: '019f-test',
      project_dir: '/Users/me/dev/proj',
      first_message: 'fix the deployment',
      message_count: 2,
    });
  });
});

describe('cleanText', () => {
  it('unwraps a slash-command turn into readable text', () => {
    const raw = '<command-name>/clear</command-name> <command-message>clear</command-message> <command-args></command-args>';
    expect(cleanText(raw)).toBe('/clear');
  });

  it('leaves normal prose untouched', () => {
    expect(cleanText('  fix the dropdown bug  ')).toBe('fix the dropdown bug');
  });
});
