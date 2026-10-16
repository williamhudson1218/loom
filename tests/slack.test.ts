import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openThread, readThreads, slackDeepLink, threadOwners, threadsFor, type ThreadRec } from '../src/slack.ts';

const threads: Record<string, ThreadRec> = {
  'C1/1790000000.000100': { url: 'https://w.slack.com/archives/C1/p1790000000000100', session_id: 's1', stage: 'looking' },
  'C2/1790000000.000200': { url: 'https://w.slack.com/archives/C2/p1790000000000200', session_id: 's1' },
  'C3/1790000000.000300': { url: 'https://w.slack.com/archives/C3/p1790000000000300', session_id: 's2' },
};

describe('slack threads', () => {
  it('reads the hook state file and lists each owning session once', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-slack-'));
    const f = path.join(dir, 'slack-threads.json');
    fs.writeFileSync(f, JSON.stringify({ threads }));
    expect(Object.keys(readThreads(f))).toHaveLength(3);
    expect(threadOwners(readThreads(f)).sort()).toEqual(['s1', 's2']);
    expect(readThreads(path.join(dir, 'missing.json'))).toEqual({});
  });

  it('builds a slack:// deep link only when the team id is known', () => {
    expect(slackDeepLink('C1', '1.2', 'T9', 'https://x')).toBe('slack://channel?team=T9&id=C1&message=1.2');
    expect(slackDeepLink('C1', '1.2', '', 'https://x')).toBe('https://x');
  });

  it('returns a session’s threads without waiting on Slack, newest first', () => {
    const calls: string[][] = [];
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      return new Promise<string>(() => {}); // never answers: the panel must not wait on it
    };
    const out = threadsFor('s1', run, threads);
    expect(out.map((t) => t.key)).toEqual(['C2/1790000000.000200', 'C1/1790000000.000100']);
    expect(out[1].stage).toBe('looking');
    expect(out.every((t) => t.preview === null)).toBe(true);
    expect(calls.some((c) => c.includes('read-thread'))).toBe(true);
    expect(threadsFor('nobody', run, threads)).toEqual([]);
  });

  it('opens only threads it knows, falling back from the app link to the permalink', async () => {
    const opened: string[] = [];
    const run = async (cmd: string, args: string[]) => {
      if (cmd !== 'open') throw new Error('unexpected ' + cmd);
      opened.push(args[0]);
      if (args[0].startsWith('slack:')) throw new Error('no app');
      return '';
    };
    expect(await openThread('C9/1.1', run, threads)).toEqual({ ok: false, detail: 'unknown thread' });
    const r = await openThread('C1/1790000000.000100', run, threads);
    expect(r.ok).toBe(true);
    expect(opened[opened.length - 1]).toBe('https://w.slack.com/archives/C1/p1790000000000100');
  });
});
