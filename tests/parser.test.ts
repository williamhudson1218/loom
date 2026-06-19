import { describe, it, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { parseJsonlFile, localDay, cleanText } from '../src/parser.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');

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
