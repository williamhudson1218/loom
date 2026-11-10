import { beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { upsertChat } from '../src/indexer.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { buildLaunchCommand } from '../src/goto.ts';
import { LEGACY_LAUNCH_SETTINGS } from '../src/launch.ts';
import { parseSlackThread } from '../src/slackref.ts';
import { readAllThreads, threadOwners } from '../src/slack.ts';
import { findOwner, threadGoto, type GotoDeps } from '../src/slackgoto.ts';
import {
  autoStartThread,
  buildStartPrompt,
  claimFromFirstMessage,
  claimThread,
  dismissStart,
  getChannelProjects,
  getLastProject,
  getOwner,
  mostRecentProject,
  noteStart,
  ownerSessions,
  reassignThread,
  recentStarts,
  resolveStartProject,
  startProjectFor,
  setChannelProject,
  setLastProject,
  type AutoStartDeps,
  type StartedThread,
} from '../src/slackowner.ts';

const WS = 'https://acme-workspace.slack.com';
const ROOT = `${WS}/archives/C0TESTADV01/p1792688542707769`;
const REPLY = `${WS}/archives/C0TESTADV01/p1792690000123456?thread_ts=1792688542.707769&cid=C0TESTADV01`;
const ref = parseSlackThread(ROOT)!;

let db: Database.Database;
beforeEach(() => {
  db = openDb(':memory:');
});

describe('slack_threads table', () => {
  it('records a claim and reads it back by the parent key', () => {
    expect(claimThread(db, ref, { agent: 'claude', sessionId: 's1', projectDir: '/p', paneId: '%3', source: 'start', now: 10 })).toBe(true);
    expect(getOwner(db, ref.key)).toEqual({
      thread_key: 'C0TESTADV01/1792688542.707769', url: ROOT, agent: 'claude', session_id: 's1', project_dir: '/p', pane_id: '%3', source: 'start', created_at: 10,
    });
    expect(ownerSessions(db)).toEqual(['s1']);
  });

  it('first claim wins: a later chat that only pastes the link does not take the thread', () => {
    claimThread(db, ref, { agent: 'claude', sessionId: 'first', source: 'start' });
    expect(claimThread(db, ref, { agent: 'claude', sessionId: 'second', source: 'index' })).toBe(false);
    expect(getOwner(db, ref.key)?.session_id).toBe('first');
  });

  it('completes a pending row (started, session unknown) with the first matching chat, once', () => {
    claimThread(db, ref, { agent: 'codex', sessionId: '', paneId: '%9', source: 'pending' });
    expect(ownerSessions(db)).toEqual([]);
    expect(claimThread(db, ref, { agent: 'claude', sessionId: 'wrong-agent', source: 'index' })).toBe(false);
    expect(claimThread(db, ref, { agent: 'codex', sessionId: 'cx1', projectDir: '/p', source: 'index' })).toBe(true);
    expect(getOwner(db, ref.key)).toMatchObject({ session_id: 'cx1', source: 'start', pane_id: '%9', project_dir: '/p' });
    expect(claimThread(db, ref, { agent: 'codex', sessionId: 'cx2', source: 'index' })).toBe(false);
  });

  it('reassigns a thread to the restarted chat', () => {
    claimThread(db, ref, { agent: 'claude', sessionId: 'old', source: 'start' });
    reassignThread(db, ref, { agent: 'claude', sessionId: 'new', source: 'start' });
    expect(getOwner(db, ref.key)?.session_id).toBe('new');
  });

  it('claims from a chat\'s opening prompt, normalising a reply link to the parent', () => {
    const r = claimFromFirstMessage(db, { agent: 'claude', session_id: 's2', project_dir: '/p', first_message: `please look at ${REPLY} today` });
    expect(r?.key).toBe('C0TESTADV01/1792688542.707769');
    expect(getOwner(db, 'C0TESTADV01/1792688542.707769')).toMatchObject({ session_id: 's2', source: 'index', url: ROOT });
  });

  it('ignores an opening prompt with no Slack permalink', () => {
    expect(claimFromFirstMessage(db, { agent: 'claude', session_id: 's3', project_dir: '/p', first_message: 'fix the bug https://github.com/x/y/pull/1' })).toBeNull();
    expect(ownerSessions(db)).toEqual([]);
  });

  it('is written by the indexer when it first sees a transcript whose opening prompt links a thread', async () => {
    const parsed = await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl'));
    upsertChat(db, { ...parsed, session_id: 'idx-1', first_message: `look at ${REPLY}` }, 1000, 5000);
    expect(getOwner(db, ref.key)).toMatchObject({ session_id: 'idx-1', agent: 'claude', source: 'index' });
    // a re-index of the same chat, or a different chat quoting the link, changes nothing
    upsertChat(db, { ...parsed, session_id: 'idx-1', first_message: `look at ${REPLY}` }, 2000, 6000);
    upsertChat(db, { ...parsed, session_id: 'idx-2', first_message: `also ${ROOT}` }, 1000, 5000);
    expect(getOwner(db, ref.key)?.session_id).toBe('idx-1');
  });

  it('is visible to the board and the detail panel through readAllThreads (table merged over the state file)', () => {
    const shared = openDb(); // the throwaway LOOM_HOME db the routes use
    try {
      claimThread(shared, ref, { agent: 'claude', sessionId: 'merged-1', projectDir: '/p', source: 'start' });
      const all = readAllThreads();
      expect(all[ref.key]).toMatchObject({ session_id: 'merged-1', url: ROOT, cwd: '/p' });
      expect(threadOwners()).toContain('merged-1');
    } finally {
      shared.prepare(`DELETE FROM slack_threads WHERE thread_key = ?`).run(ref.key);
      shared.close();
    }
  });
});

describe('lookup order: table, then state file, then transcripts', () => {
  const stateRec = { 'C0TESTADV01/1792688542.707769': { url: ROOT, session_id: 'from-state', cwd: '/state' } };
  const calls: string[] = [];
  const deps = (o: Partial<Parameters<typeof findOwner>[1]> = {}) => ({
    owned: (k: string) => { calls.push('table'); return o.owned ? o.owned(k) : null; },
    threads: () => { calls.push('state'); return o.threads ? o.threads() : {}; },
    search: async () => { calls.push('search'); return { ok: true as const, results: [{ session_id: 'from-search', project_dir: '/s', jsonl_path: '/t', started_at: 0, ended_at: 1, message_count: 1, title: '', snippet: '', score: 1 }] }; },
    mentions: () => true,
  });
  beforeEach(() => { calls.length = 0; });

  it('the table wins over the state file and stops there', async () => {
    const d = deps({ owned: () => ({ session_id: 'from-table', cwd: '/table', pane_id: '' }), threads: () => stateRec });
    expect(await findOwner(ref, d)).toEqual({ session_id: 'from-table', cwd: '/table', source: 'table', pane_id: undefined });
    expect(calls).toEqual(['table']);
  });

  it('falls to the state file when the table has no row', async () => {
    expect(await findOwner(ref, deps({ threads: () => stateRec }))).toEqual({ session_id: 'from-state', cwd: '/state', source: 'state' });
    expect(calls).toEqual(['table', 'state']);
  });

  it('falls to the transcript search last', async () => {
    expect((await findOwner(ref, deps()))?.source).toBe('search');
    expect(calls).toEqual(['table', 'state', 'search']);
  });

  it('a table row with neither session nor pane is not an owner', async () => {
    expect((await findOwner(ref, deps({ owned: () => ({ session_id: '', cwd: '', pane_id: '' }) })))?.source).toBe('search');
  });

  it('a still-starting chat (pane known, session not) is the owner', async () => {
    expect(await findOwner(ref, deps({ owned: () => ({ session_id: '', cwd: '/p', pane_id: '%9' }) }))).toMatchObject({ session_id: '', source: 'table', pane_id: '%9' });
  });
});

describe('auto-start project resolution', () => {
  const valid = (d: string) => d.startsWith('/ok');
  it('prefers the channel mapping, then the last project, then the newest chat\'s', () => {
    const src = { mapping: { C1: '/ok/mapped' }, last: '/ok/last', recent: '/ok/recent', valid };
    expect(resolveStartProject('C1', src)).toEqual({ dir: '/ok/mapped', source: 'channel' });
    expect(resolveStartProject('C2', src)).toEqual({ dir: '/ok/last', source: 'last' });
    expect(resolveStartProject('C2', { ...src, last: null })).toEqual({ dir: '/ok/recent', source: 'recent' });
  });

  it('skips a candidate that is no longer a directory, falling through', () => {
    expect(resolveStartProject('C1', { mapping: { C1: '/gone' }, last: '/ok/last', recent: null, valid })).toEqual({ dir: '/ok/last', source: 'last' });
    expect(resolveStartProject('C1', { mapping: {}, last: '/gone', recent: '/gone2', valid })).toBeNull();
  });

  it('keeps the channel map, the last project and the newest chat in settings and the chats table', async () => {
    expect(getChannelProjects(db)).toEqual({});
    setChannelProject(db, 'C1', '/ok/a');
    setChannelProject(db, 'C2', '/ok/b');
    setChannelProject(db, 'C2', null);
    expect(getChannelProjects(db)).toEqual({ C1: '/ok/a' });
    db.prepare(`INSERT INTO settings(key, value) VALUES ('slack_channel_projects', 'not json')  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run();
    expect(getChannelProjects(db)).toEqual({});

    expect(getLastProject(db)).toBeNull();
    setLastProject(db, '/ok/last');
    expect(getLastProject(db)).toBe('/ok/last');

    expect(mostRecentProject(db)).toBeNull();
    const parsed = await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl'));
    upsertChat(db, { ...parsed, session_id: 'r1', project_dir: '/ok/newest', last_active_at: 9e12 }, 1, 2);
    expect(mostRecentProject(db)).toBe('/ok/newest');
  });
});

describe('buildStartPrompt', () => {
  it('carries the permalink and the quoted message', () => {
    const p = buildStartPrompt(ref, { text: 'Can you confirm WV?\nBefore Friday', author: 'Alex' });
    expect(p).toContain(`started from a Slack thread: ${ROOT}`);
    expect(p).toContain('from Alex');
    expect(p).toContain('> Can you confirm WV?\n> Before Friday');
  });
  it('is just the permalink when Loom could not read the message', () => {
    const p = buildStartPrompt(ref, {});
    expect(p).toContain(ROOT);
    expect(p).not.toContain('>');
  });
  it('adds the user context before the closing instruction, and is unchanged without it', () => {
    const plain = buildStartPrompt(ref, { text: 'hi', author: 'Alex' });
    expect(buildStartPrompt(ref, { text: 'hi', author: 'Alex' }, '   ')).toBe(plain);
    expect(plain).not.toContain('Context from the user');
    const p = buildStartPrompt(ref, { text: 'hi', author: 'Alex' }, 'Only the Q3 return\nnot Q2');
    expect(p).toContain('> hi\n\nContext from the user:\nOnly the Q3 return\nnot Q2\n\nRead the whole thread');
  });
});

describe('--session-id for a fresh Claude chat', () => {
  const base = { projectDir: '/p', sourceAgent: 'claude' as const, selectedAgent: 'claude' as const, fresh: true, prompt: 'hi' };
  it('is passed when a session id is given', () => {
    expect(buildLaunchCommand({ ...base, sessionId: 'abc-123' }, LEGACY_LAUNCH_SETTINGS)).toContain("claude --dangerously-skip-permissions --session-id 'abc-123'");
  });
  it('is absent otherwise, and for Codex', () => {
    expect(buildLaunchCommand({ ...base, sessionId: '' })).not.toContain('--session-id');
    expect(buildLaunchCommand({ ...base, sessionId: 'abc', sourceAgent: 'codex', selectedAgent: 'codex' })).not.toContain('--session-id');
  });
});

describe('autoStartThread', () => {
  // A real DB per call (autoStartThread closes what it opens) and a stub launcher:
  // nothing here starts a pane or a process.
  function setup(over: Partial<AutoStartDeps> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-autostart-'));
    const file = path.join(dir, 'm.db');
    const launches: Parameters<AutoStartDeps['launch']>[0][] = [];
    const deps: AutoStartDeps = {
      db: () => openDb(file),
      validDir: (d) => d.startsWith('/ok'),
      agent: () => 'claude',
      launch: (a) => { launches.push(a); return { ok: true, paneId: '%42', where: 'loom-managed · red-otter' }; },
      newSessionId: () => 'new-session-id',
      now: () => 1234,
      ...over,
    };
    const peek = () => openDb(file);
    return { deps, launches, peek };
  }

  it('starts in the channel\'s project, records ownership and remembers the project', () => {
    const { deps, launches, peek } = setup();
    const seed = peek();
    setChannelProject(seed, 'C0TESTADV01', '/ok/acme-app');
    setLastProject(seed, '/ok/other');
    seed.close();

    const r = autoStartThread(ref, { text: 'Can you confirm WV?', author: 'Alex' }, deps);
    expect(r).toMatchObject({
      ok: true, action: 'started', key: ref.key, agent: 'claude', session_id: 'new-session-id', pane_id: '%42',
      project_dir: '/ok/acme-app', project: 'acme-app', project_source: 'channel', quote: 'Can you confirm WV?', author: 'Alex', at: 1234,
    });
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ projectDir: '/ok/acme-app', agent: 'claude', sessionId: 'new-session-id' });
    expect(launches[0].prompt).toContain(ROOT);
    expect(launches[0].prompt).toContain('> Can you confirm WV?');

    const check = peek();
    expect(getOwner(check, ref.key)).toMatchObject({ session_id: 'new-session-id', source: 'start', pane_id: '%42', project_dir: '/ok/acme-app', created_at: 1234 });
    expect(getLastProject(check)).toBe('/ok/acme-app');
    check.close();
  });

  it('puts the user context into the launched prompt, and startProjectFor previews the same project', () => {
    const { deps, launches, peek } = setup();
    const seed = peek();
    setChannelProject(seed, 'C0TESTADV01', '/ok/acme-app');
    expect(startProjectFor(seed, 'C0TESTADV01', (d) => d.startsWith('/ok/'))).toEqual({ dir: '/ok/acme-app', source: 'channel' });
    seed.close();
    expect(launches).toHaveLength(0); // previewing launches nothing
    autoStartThread(ref, { text: 'hi' }, deps, { context: 'Start with Q3' });
    expect(launches[0].prompt).toContain('Context from the user:\nStart with Q3');
  });

  it('falls back to the last project used when the channel has no mapping', () => {
    const { deps, launches, peek } = setup();
    const seed = peek();
    setLastProject(seed, '/ok/last-used');
    seed.close();
    const r = autoStartThread(ref, {}, deps);
    expect(r).toMatchObject({ ok: true, project_dir: '/ok/last-used', project_source: 'last' });
    expect(launches[0].projectDir).toBe('/ok/last-used');
  });

  it('records a codex start as pending, since it cannot be given a session id', () => {
    const { deps, peek } = setup({ agent: () => 'codex' });
    const seed = peek();
    setLastProject(seed, '/ok/p');
    seed.close();
    const r = autoStartThread(ref, {}, deps);
    expect(r).toMatchObject({ ok: true, agent: 'codex', session_id: '' });
    const check = peek();
    expect(getOwner(check, ref.key)).toMatchObject({ session_id: '', source: 'pending', pane_id: '%42', agent: 'codex' });
    check.close();
  });

  it('refuses, launching nothing, when there is no project to start in', () => {
    const { deps, launches, peek } = setup();
    const r = autoStartThread(ref, {}, deps);
    expect(r).toMatchObject({ ok: false, reason: 'no_project' });
    expect(launches).toEqual([]);
    const check = peek();
    expect(getOwner(check, ref.key)).toBeNull();
    check.close();
  });

  it('writes no ownership when the launch fails', () => {
    const { deps, peek } = setup({ launch: () => ({ ok: false, detail: 'Not starting a new chat: only 0.1 GB of memory is free' }) });
    const seed = peek();
    setLastProject(seed, '/ok/p');
    seed.close();
    const r = autoStartThread(ref, {}, deps);
    expect(r).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('0.1 GB') });
    const check = peek();
    expect(getOwner(check, ref.key)).toBeNull();
    expect(getLastProject(check)).toBe('/ok/p');
    check.close();
  });

  it('Change project restarts in the chosen directory and hands the thread over', () => {
    const { deps, launches, peek } = setup();
    const seed = peek();
    setLastProject(seed, '/ok/first');
    seed.close();
    autoStartThread(ref, {}, deps);
    const r = autoStartThread(ref, {}, { ...deps, newSessionId: () => 'second-id' }, { projectDir: '/ok/second' });
    expect(r).toMatchObject({ ok: true, project_dir: '/ok/second', session_id: 'second-id' });
    expect(launches.map((l) => l.projectDir)).toEqual(['/ok/first', '/ok/second']);
    const check = peek();
    expect(getOwner(check, ref.key)).toMatchObject({ session_id: 'second-id', project_dir: '/ok/second' });
    check.close();
  });
});

describe('threadGoto starts a chat for an unowned thread', () => {
  const started: StartedThread = {
    ok: true, action: 'started', key: ref.key, url: ROOT, channel: ref.channel, agent: 'claude', session_id: 'sid', pane_id: '%5',
    where: 'loom-managed · blue-vanilla', project_dir: '/p', project: 'p', project_source: 'last', quote: '', author: '', at: 1,
  };
  const base = (over: Partial<GotoDeps> = {}): GotoDeps => ({
    threads: () => ({}),
    search: async () => ({ ok: true, results: [] }),
    mentions: () => false,
    live: () => ({}),
    projectDirOf: () => null,
    elsewhere: () => false,
    goto: () => ({ ok: true, detail: 'jumped' }),
    acquire: () => ({ ok: false, detail: 'not used' }),
    resume: () => ({ ok: true, detail: 'resumed' }),
    ...over,
  });

  it('calls start with the picked text, and reports action started', async () => {
    const seen: unknown[] = [];
    const r = await threadGoto(ROOT, base({ start: (rf, picked, o) => { seen.push([rf.key, picked, o]); return { ok: true, started }; } }), { picked: { text: 'hello', author: 'A' } });
    expect(r).toMatchObject({ ok: true, action: 'started', key: ref.key, session_id: 'sid', pane_id: '%5', started });
    expect(seen).toEqual([[ref.key, { text: 'hello', author: 'A' }, { pane: undefined }]]);
  });

  it('keeps the old no_owner report when nothing can start a chat', async () => {
    expect(await threadGoto(ROOT, base())).toMatchObject({ ok: false, reason: 'no_owner' });
  });

  it('surfaces a refused start (memory cap, no project) with its reason', async () => {
    const r = await threadGoto(ROOT, base({ start: () => ({ ok: false, reason: 'failed', detail: 'Not starting a new chat: only 0.1 GB of memory is free' }) }));
    expect(r).toMatchObject({ ok: false, reason: 'failed', detail: expect.stringContaining('0.1 GB') });
  });

  it('does not start when a chat already owns the thread; it jumps', async () => {
    let started_ = false;
    const r = await threadGoto(ROOT, base({
      owned: () => ({ session_id: 's-own', cwd: '/p', pane_id: '' }),
      live: () => ({ 'claude:s-own': { agent: 'claude', session_id: 's-own', pane_id: '%2', tmux_session: 'loom-tp-2', running: true } as never }),
      start: () => { started_ = true; return { ok: true, started }; },
    }));
    expect(r).toMatchObject({ ok: true, action: 'jumped', source: 'table', pane_id: '%2' });
    expect(started_).toBe(false);
  });

  it('a second press while a started chat is still unindexed jumps to its pane instead of starting another', async () => {
    let n = 0;
    const r = await threadGoto(ROOT, base({
      owned: () => ({ session_id: '', cwd: '/p', pane_id: '%9' }),
      live: () => ({ 'codex:x': { agent: 'codex', session_id: 'x', pane_id: '%9', tmux_session: 'loom-managed', running: true } as never }),
      start: () => { n++; return { ok: true, started }; },
    }));
    expect(r).toMatchObject({ ok: true, action: 'jumped', pane_id: '%9' });
    expect(n).toBe(0);
  });

  it('resumes an owned, not-running chat into a managed window without focusing Ghostty', async () => {
    const focus: boolean[] = [];
    const r = await threadGoto(ROOT, base({
      owned: () => ({ session_id: 's-own', cwd: process.cwd(), pane_id: '' }),
      acquire: () => ({ ok: true, paneId: '%11', managed: true }),
      resume: (_p, _d, _s, f) => { focus.push(f); return { ok: true, detail: 'resumed' }; },
    }));
    expect(r).toMatchObject({ ok: true, action: 'resumed', pane_id: '%11' });
    expect(focus).toEqual([false]);
  });
});

describe('start banner state', () => {
  const s = (key: string, at: number): StartedThread => ({
    ok: true, action: 'started', key, url: ROOT, channel: 'C1', agent: 'claude', session_id: 'sid', pane_id: '%5',
    where: 'w', project_dir: '/p', project: 'p', project_source: 'last', quote: '', author: '', at,
  });
  it('lists recent starts, newest first, until dismissed', () => {
    const now = Date.now();
    noteStart(s('K1/1.1', now - 2000));
    noteStart(s('K2/1.1', now - 1000));
    const keys = () => recentStarts(now).filter((x) => x.key.startsWith('K')).map((x) => x.key);
    expect(keys()).toEqual(['K2/1.1', 'K1/1.1']);
    dismissStart('K2/1.1', now - 1000);
    expect(keys()).toEqual(['K1/1.1']);
  });
  it('drops a start after six hours', () => {
    noteStart(s('K3/1.1', 1));
    expect(recentStarts(1 + 7 * 3_600_000).some((x) => x.key === 'K3/1.1')).toBe(false);
  });
});
