import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readThreads } from '../src/slack.ts';
import { findOwner, parseSlackThread, pickedThread, preferredLane, threadGoto, transcriptMentions, type GotoDeps } from '../src/slackgoto.ts';
import type { ArchiveHit } from '../src/findchat.ts';
import type { LiveLoc } from '../src/dashboard.ts';

const WS = 'https://tax-pilot-workspace.slack.com';

describe('parseSlackThread', () => {
  it('normalises a root permalink to channel/ts', () => {
    expect(parseSlackThread(`${WS}/archives/C0BPBJU0BAL/p1792688542707769`)).toEqual({
      key: 'C0BPBJU0BAL/1792688542.707769',
      url: `${WS}/archives/C0BPBJU0BAL/p1792688542707769`,
      channel: 'C0BPBJU0BAL',
      ts: '1792688542.707769',
      linkTs: '1792688542.707769',
    });
  });

  it('takes the thread from thread_ts on a reply link, not the reply', () => {
    const r = parseSlackThread(`${WS}/archives/C0BPBJU0BAL/p1792690000123456?thread_ts=1792688542.707769&cid=C0BPBJU0BAL`);
    expect(r?.key).toBe('C0BPBJU0BAL/1792688542.707769');
    expect(r?.url).toBe(`${WS}/archives/C0BPBJU0BAL/p1792688542707769`);
    expect(r?.linkTs).toBe('1792690000.123456');
  });

  it('accepts cid before thread_ts, and an encoded dot', () => {
    expect(parseSlackThread(`${WS}/archives/C1/p1792690000123456?cid=C1&thread_ts=1792688542%2E707769`)?.ts).toBe('1792688542.707769');
  });

  it('ignores a malformed thread_ts, as the hook does', () => {
    expect(parseSlackThread(`${WS}/archives/C1/p1792690000123456?thread_ts=17926&cid=C1`)?.ts).toBe('1792690000.123456');
    expect(parseSlackThread(`${WS}/archives/C1/p1792690000123456?thread_ts=`)?.ts).toBe('1792690000.123456');
  });

  it('finds the link inside surrounding text and Slack angle brackets', () => {
    expect(parseSlackThread(`  see <${WS}/archives/D08QHHVELBS/p1792085635640389>\n`)?.key).toBe('D08QHHVELBS/1792085635.640389');
  });

  it('rejects anything that is not a Slack message permalink', () => {
    expect(parseSlackThread('')).toBeNull();
    expect(parseSlackThread('https://github.com/x/y/pull/1')).toBeNull();
    expect(parseSlackThread(`${WS}/archives/C1`)).toBeNull();
    expect(parseSlackThread('http://w.slack.com/archives/C1/p1792690000123456')).toBeNull();
  });
});

function hit(session_id: string, ended_at: number, jsonl_path = '/t/' + session_id + '.jsonl'): ArchiveHit {
  return { session_id, project_dir: '/proj/' + session_id, jsonl_path, started_at: 0, ended_at, message_count: 5, title: '', snippet: '', score: 1 };
}

function stateFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-slackgoto-'));
  const f = path.join(dir, 'slack-threads.json');
  fs.writeFileSync(f, JSON.stringify({
    threads: {
      'C0BPBJU0BAL/1792688542.707769': { url: `${WS}/archives/C0BPBJU0BAL/p1792688542707769`, session_id: 'owner-1', cwd: '/Users/w/dev/tax-pilot-app', claimed_at: '2026-10-20T10:00:00', stage: 'looking' },
    },
    recent_acks: {},
  }));
  return f;
}

describe('pickedThread', () => {
  const root = `${WS}/archives/C0BPBJU0BAL/p1793133196766809`;
  it('a channel message is its own parent', () => {
    expect(pickedThread({ url: root, inThread: false })?.key).toBe('C0BPBJU0BAL/1793133196.766809');
  });
  it('a reply resolves to thread_ts, whatever the pane says', () => {
    const url = `${WS}/archives/C0BPBJU0BAL/p1793135607595459?thread_ts=1793133196.766809&cid=C0BPBJU0BAL`;
    expect(pickedThread({ url, inThread: true, rootUrl: null })?.url).toBe(root);
    expect(pickedThread({ url, inThread: true, rootUrl: `${WS}/archives/C0BPBJU0BAL/p1700000000000000` })?.url).toBe(root);
  });
  it('a thread-pane reply without thread_ts takes the pane root', () => {
    const url = `${WS}/archives/C0BPBJU0BAL/p1793135607595459`;
    expect(pickedThread({ url, inThread: true, rootUrl: root })?.key).toBe('C0BPBJU0BAL/1793133196.766809');
    expect(pickedThread({ url, inThread: false, rootUrl: root })?.key).toBe('C0BPBJU0BAL/1793135607.595459');
    expect(pickedThread({ url, inThread: true, rootUrl: null })?.key).toBe('C0BPBJU0BAL/1793135607.595459');
  });
  it('rejects a non-permalink', () => {
    expect(pickedThread({ url: 'https://example.com', inThread: false })).toBeNull();
  });
});

describe('findOwner', () => {
  const noSearch = async () => { throw new Error('search must not run'); };

  it('uses the slack-threads state first, reply link or root', async () => {
    const f = stateFixture();
    const deps = { threads: () => readThreads(f), search: noSearch, mentions: () => true };
    const reply = parseSlackThread(`${WS}/archives/C0BPBJU0BAL/p1792690000123456?thread_ts=1792688542.707769&cid=C0BPBJU0BAL`)!;
    expect(await findOwner(reply, deps)).toEqual({ session_id: 'owner-1', cwd: '/Users/w/dev/tax-pilot-app', source: 'state' });
  });

  it('falls back to transcript search on the parent only, verified, most recent wins', async () => {
    const queries: string[] = [];
    const deps = {
      threads: () => ({}),
      search: async (q: string) => {
        queries.push(q);
        return { ok: true as const, results: [hit('old', 100), hit('new', 300), hit('fake', 900)] };
      },
      // 'fake' only matched loosely: its transcript never mentions the link.
      mentions: (p: string, needles: string[]) => !p.includes('fake') && needles[0] === 'C0BPBJU0BAL/p1792688542707769',
    };
    const reply = parseSlackThread(`${WS}/archives/C0BPBJU0BAL/p1792690000123456?thread_ts=1792688542.707769`)!;
    expect(await findOwner(reply, deps)).toEqual({ session_id: 'new', cwd: '/proj/new', source: 'search' });
    expect(queries).toEqual(['p1792688542707769']); // never the reply's own ts
  });

  it('returns null when neither knows the thread, and survives a failed search', async () => {
    const deps = { threads: () => ({}), search: async () => ({ ok: false as const, detail: 'find-chat not installed' }), mentions: () => true };
    expect(await findOwner(parseSlackThread(`${WS}/archives/C1/p1792690000123456`)!, deps)).toBeNull();
  });

  it('transcriptMentions reads the file for the needle', () => {
    const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'loom-slackgoto-')), 's.jsonl');
    fs.writeFileSync(f, '{"text":"see https://w.slack.com/archives/C1/p1792690000123456"}\n');
    expect(transcriptMentions(f, ['C1/p1792690000123456'])).toBe(true);
    expect(transcriptMentions(f, ['C2/p1792690000123456'])).toBe(false);
    expect(transcriptMentions('/nope.jsonl', ['x'])).toBe(false);
  });
});

function loc(session_id: string, tmux_session: string, cwd: string, pane_id = '%9'): LiveLoc {
  return { agent: 'claude', session_id, pane_id, tmux_session, window_index: '1', pane_index: '0', running: true, cwd };
}

describe('threadGoto', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-slackgoto-proj-'));
  const link = `${WS}/archives/C0BPBJU0BAL/p1792688542707769`;

  function deps(over: Partial<GotoDeps> = {}): GotoDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      threads: () => ({ 'C0BPBJU0BAL/1792688542.707769': { url: link, session_id: 'owner-1', cwd: dir } }),
      search: async () => ({ ok: true, results: [] }),
      mentions: () => true,
      live: () => ({}),
      projectDirOf: () => null,
      elsewhere: () => false,
      goto: (p, s) => (calls.push(`goto ${p} ${s}`), { ok: true, detail: 'tmux ok' }),
      acquire: (d, lane) => (calls.push(`acquire ${d} ${lane}`), { ok: true, paneId: '%42' }),
      resume: (p, d, sid) => (calls.push(`resume ${p} ${d} ${sid}`), { ok: true, detail: 'resumed' }),
      ...over,
    };
  }

  it('jumps to a live owner without resuming', async () => {
    const d = deps({ live: () => ({ 'claude:owner-1': loc('owner-1', 'loom-tp-3', dir, '%7') }) });
    const r = await threadGoto(link, d);
    expect(r).toMatchObject({ ok: true, action: 'jumped', pane_id: '%7', session_id: 'owner-1', source: 'state' });
    expect(d.calls).toEqual(['goto %7 loom-tp-3']);
  });

  it('resumes a stale owner in its own cwd, in the lane already running that project', async () => {
    const d = deps({ live: () => ({ 'claude:a': loc('a', 'loom-tp-2', dir), 'claude:b': loc('b', 'loom-tp-4', dir + '/.worktrees/x'), 'claude:c': loc('c', 'loom-bugs-1', '/elsewhere') }) });
    const r = await threadGoto(link, d);
    expect(r).toMatchObject({ ok: true, action: 'resumed', pane_id: '%42' });
    expect(d.calls).toEqual([`acquire ${dir} tp`, `resume %42 ${dir} owner-1`]);
  });

  it('prefers the board’s project dir, and an explicit pane skips acquiring one', async () => {
    const d = deps({ projectDirOf: () => os.tmpdir() });
    await threadGoto(link, d, { pane: '%5' });
    expect(d.calls).toEqual([`resume %5 ${os.tmpdir()} owner-1`]);
  });

  it('a pasted reply link resolves to the parent thread before lookup', async () => {
    const seen: string[] = [];
    const d = deps({ threads: () => new Proxy({}, { get: (_t, k) => (seen.push(String(k)), undefined) }) });
    const queries: string[] = [];
    d.search = async (q) => (queries.push(q), { ok: true, results: [] });
    const r = await threadGoto(`${WS}/archives/C0BPBJU0BAL/p1792690000123456?thread_ts=1792688542.707769&cid=C0BPBJU0BAL`, d);
    expect(r).toMatchObject({ ok: false, reason: 'no_owner', key: 'C0BPBJU0BAL/1792688542.707769' });
    expect(seen).toEqual(['C0BPBJU0BAL/1792688542.707769']);
    expect(queries).toEqual(['p1792688542707769']);
  });

  it('reports the failure cases without touching tmux', async () => {
    const d = deps({ threads: () => ({}) });
    expect(await threadGoto('hello', d)).toMatchObject({ ok: false, reason: 'not_slack' });
    expect(await threadGoto(link, d)).toMatchObject({ ok: false, reason: 'no_owner', detail: 'No chat owns this thread' });
    expect(await threadGoto(link, deps({ elsewhere: () => true }))).toMatchObject({ ok: false, reason: 'elsewhere' });
    expect(await threadGoto(link, deps({ threads: () => ({ 'C0BPBJU0BAL/1792688542.707769': { url: link, session_id: 'x', cwd: '/gone/dir' } }) }))).toMatchObject({ ok: false, reason: 'no_dir' });
    expect(await threadGoto(link, deps({ acquire: () => ({ ok: false, detail: 'no lane sessions found' }) }))).toMatchObject({ ok: false, reason: 'no_pane' });
    expect(d.calls).toEqual([]);
  });
});

describe('preferredLane', () => {
  it('is empty when no live chat shares the project', () => {
    expect(preferredLane('/p', {})).toBe('');
    expect(preferredLane('/p', { 'claude:a': loc('a', 'loom-tp-code', '/p') })).toBe(''); // not a lane
    expect(preferredLane('/p', { 'claude:a': loc('a', 'loom-tp-2', '/pother') })).toBe('');
  });
});
