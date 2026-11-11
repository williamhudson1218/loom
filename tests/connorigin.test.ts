import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { githubOrigin, homeTilde, readOrigins, recordOrigin, slackOrigin } from '../src/connorigin.ts';

describe('connection origins', () => {
  it('says connected only for what a Loom flow recorded, and found for the rest', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-origin-'));
    expect(slackOrigin({ connected: true, tokenSource: 'keychain', teamId: 'T1' }, readOrigins(dir))).toBe('earlier');
    expect(githubOrigin('octo', readOrigins(dir))).toBe('found');
    recordOrigin('slack', 'connect', 'T1', dir);
    recordOrigin('github', 'loom', 'octo', dir);
    const o = readOrigins(dir);
    expect(slackOrigin({ connected: true, tokenSource: 'keychain', teamId: 'T1' }, o)).toBe('connect');
    expect(slackOrigin({ connected: true, tokenSource: 'keychain', teamId: 'T2' }, o)).toBe('earlier'); // another workspace's token
    expect(slackOrigin({ connected: true, tokenSource: 'env', teamId: 'T1' }, o)).toBe('env');
    expect(slackOrigin({ connected: false, tokenSource: 'none' }, o)).toBeNull();
    recordOrigin('slack', 'pasted', 'T1', dir);
    expect(slackOrigin({ connected: true, tokenSource: 'keychain', teamId: 'T1' }, readOrigins(dir))).toBe('pasted');
    expect(githubOrigin('octo', o)).toBe('loom');
    expect(githubOrigin('someone-else', o)).toBe('found'); // gh switched accounts outside Loom
    expect(githubOrigin(null, o)).toBeNull();
  });
  it('shows the home folder as ~', () => {
    expect(homeTilde('/Users/sam/.claude/tools/gmail/gmail.mjs', '/Users/sam')).toBe('~/.claude/tools/gmail/gmail.mjs');
    expect(homeTilde('/opt/x', '/Users/sam')).toBe('/opt/x');
    expect(homeTilde('/Users/samantha/x', '/Users/sam')).toBe('/Users/samantha/x');
  });
});
