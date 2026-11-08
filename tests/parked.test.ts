import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PARKED_SCHEMA_SQL,
  addresseesOf,
  checkDelayMs,
  firstLine,
  getParked,
  listParked,
  parkChat,
  pollParked,
  repliesAfter,
  resumePrompt,
  sendAndPark,
  sendThen,
  markChatDone,
  restoreChat,
  CLOSE_GRACE_MS,
  unparkChat,
  waitingLabel,
  type ParkedRow,
  type SlackMsg,
} from '../src/parked.ts';
import type { Draft } from '../src/outbox.ts';
import { buildLaunchCommand, closeSession } from '../src/goto.ts';
import { configureTmuxSocket } from '../src/tmux.ts';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import { toChatViews } from '../src/dashboard.ts';
import { applySettings, autoResumeParked } from '../src/settings.ts';

const ME = 'UWILL';
const SENT_TS = '1000000100.000100';

const db = () => {
  const d = new Database(':memory:');
  d.exec(PARKED_SCHEMA_SQL);
  d.exec(`CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  return d;
};

const park = (d: Database.Database, over: Partial<Parameters<typeof parkChat>[1]> = {}, now = 1_000_000_000_000) =>
  parkChat(d, { agent: 'claude', sessionId: 's1', draftId: 'd1', channel: 'C1', threadTs: '1000000000.000100', threadUrl: 'https://w.slack.com/archives/C1/p1000000000000100', permalink: '', waitingOn: ['Jemelee'], sentTs: SENT_TS, sentAt: now, ...over }, now);

describe('reply detection', () => {
  const m = (ts: string, o: Partial<SlackMsg> = {}): SlackMsg => ({ ts, user: 'UJEM', text: 'hi', ...o });

  it('counts the first human reply after what Will posted', () => {
    const r = repliesAfter([m('1000000000.000100', { user: ME }), m(SENT_TS, { user: ME }), m('1000000200.000100', { text: 'on it' })], { me: ME, sentTs: SENT_TS });
    expect(r.map((x) => x.text)).toEqual(['on it']);
  });

  it('ignores Will’s own posts', () => {
    expect(repliesAfter([m('1000000300.000100', { user: ME })], { me: ME, sentTs: SENT_TS })).toEqual([]);
  });

  it('ignores bots and apps, however they identify', () => {
    const msgs = [m('1000000300.000100', { bot_id: 'B1' }), m('1000000301.000100', { subtype: 'bot_message' }), m('1000000302.000100', { user: undefined })];
    expect(repliesAfter(msgs, { me: ME, sentTs: SENT_TS })).toEqual([]);
  });

  it('ignores join notices but keeps a broadcast reply', () => {
    const msgs = [m('1000000300.000100', { subtype: 'channel_join' }), m('1000000301.000100', { subtype: 'thread_broadcast', text: 'real' })];
    expect(repliesAfter(msgs, { me: ME, sentTs: SENT_TS }).map((x) => x.text)).toEqual(['real']);
  });

  it('does not count replies before sent_at, or the sent message itself', () => {
    const msgs = [m('1000000050.000100'), m(SENT_TS)];
    expect(repliesAfter(msgs, { me: ME, sentTs: SENT_TS })).toEqual([]);
  });

  it('flattens mentions and cuts long first lines', () => {
    expect(firstLine('\n  <@UJEM> thanks, see <https://x.test|this>\nmore', { UJEM: 'Jemelee' })).toBe('@Jemelee thanks, see this');
    expect(firstLine('a'.repeat(300), {}, 20)).toHaveLength(20);
  });
});

describe('poll backoff', () => {
  it('checks every 2 minutes at first, then backs off with age', () => {
    expect(checkDelayMs(10 * 60_000)).toBe(120_000);
    expect(checkDelayMs(2 * 3600_000)).toBe(300_000);
    expect(checkDelayMs(10 * 3600_000)).toBe(900_000);
    expect(checkDelayMs(48 * 3600_000)).toBe(1_800_000);
    expect(checkDelayMs(100 * 3600_000)).toBe(3_600_000);
  });
});

describe('park and unpark state', () => {
  it('parks waiting, lists it, and unparks cleanly', () => {
    const d = db();
    park(d);
    expect(getParked(d, 'claude', 's1')).toMatchObject({ state: 'waiting', waiting_on: ['Jemelee'], sent_ts: SENT_TS });
    expect(listParked(d)).toHaveLength(1);
    expect(unparkChat(d, 'claude', 's1')).toBe(true);
    expect(getParked(d, 'claude', 's1')).toBeUndefined();
    expect(unparkChat(d, 'claude', 's1')).toBe(false);
  });

  it('labels the wait: who and how long', () => {
    const r = { waiting_on: ['Jemelee'], sent_at: 0 };
    expect(waitingLabel(r, 2 * 3600_000)).toBe('waiting on Jemelee · 2h');
    expect(waitingLabel({ ...r, waiting_on: ['A', 'B'] }, 5 * 60_000)).toBe('waiting on A, B · 5m');
    expect(waitingLabel({ ...r, waiting_on: [] }, 3 * 86400_000)).toBe('waiting on a reply · 3d');
  });
});

describe('pollParked', () => {
  const NOW = 1_000_000_000_000 + 10 * 60_000;
  const reply: SlackMsg = { ts: '1000000400.000100', user: 'UJEM', text: 'Done, try it now.\nsecond line' };
  const base = (over = {}) => ({ me: ME, names: { UJEM: 'Jemelee' }, notify: () => {}, now: NOW, replies: async () => [reply], ...over });

  it('moves a chat to replied, with the first line and a notification', async () => {
    const d = db();
    park(d);
    const notes: string[][] = [];
    const hit = await pollParked(d, base({ notify: (t: string, b: string) => notes.push([t, b]) }));
    expect(hit).toHaveLength(1);
    expect(getParked(d, 'claude', 's1')).toMatchObject({ state: 'replied', reply_user: 'Jemelee', reply_ts: reply.ts, reply_text: reply.text, reply_count: 1 });
    expect(notes).toEqual([['Jemelee replied', 'Done, try it now.']]);
  });

  it('hands the parked chat to notify as the click target', async () => {
    const d = db();
    park(d);
    const targets: unknown[] = [];
    await pollParked(d, base({ notify: (_t: string, _b: string, tg: unknown) => targets.push(tg) }));
    expect(targets).toEqual([{ agent: 'claude', sid: 's1' }]);
  });

  it('stays waiting when only Will, bots and older messages are there', async () => {
    const d = db();
    park(d);
    await pollParked(d, base({ replies: async () => [{ ts: '1000000400.000100', user: ME, text: 'bump' }, { ts: '1000000401.000100', bot_id: 'B', user: 'UB', text: 'build' }, { ts: '1000000001.000100', user: 'UJEM', text: 'earlier' }] }));
    expect(getParked(d, 'claude', 's1')?.state).toBe('waiting');
  });

  it('skips a thread that is not due yet and stamps the ones it looks at', async () => {
    const d = db();
    park(d);
    let calls = 0;
    const deps = base({ replies: async () => { calls++; return []; } });
    await pollParked(d, deps);
    await pollParked(d, { ...deps, now: NOW + 30_000 });
    expect(calls).toBe(1);
    await pollParked(d, { ...deps, now: NOW + 130_000 });
    expect(calls).toBe(2);
  });

  it('survives a Slack error and tries again later', async () => {
    const d = db();
    park(d);
    await pollParked(d, base({ replies: async () => { throw new Error('ratelimited'); } }));
    expect(getParked(d, 'claude', 's1')?.state).toBe('waiting');
  });

  it('auto-resume reopens the chat with the reply and unparks it', async () => {
    const d = db();
    park(d);
    const prompts: string[] = [];
    await pollParked(d, base({ autoResume: true, resume: async (r: ParkedRow) => { prompts.push(resumePrompt(r)); return { ok: true, detail: 'resumed' }; } }));
    expect(getParked(d, 'claude', 's1')).toBeUndefined();
    expect(prompts[0]).toContain('Jemelee replied');
    expect(prompts[0]).toContain('> Done, try it now.');
    expect(prompts[0]).toContain('/p1000000400000100?thread_ts=1000000000.000100&cid=C1');
  });

  it('a failed auto-resume leaves the chat in Your turn for the Resume button', async () => {
    const d = db();
    park(d);
    await pollParked(d, base({ autoResume: true, resume: async () => ({ ok: false, detail: 'no pane' }) }));
    expect(getParked(d, 'claude', 's1')?.state).toBe('replied');
  });

  it('never auto-resumes with the setting off', async () => {
    const d = db();
    park(d);
    let resumed = false;
    await pollParked(d, base({ autoResume: false, resume: async () => { resumed = true; return { ok: true, detail: '' }; } }));
    expect(resumed).toBe(false);
  });
});

describe('Send & park (stubbed sender)', () => {
  const draft: Draft = { id: 'd1', session_id: 's1', channel: 'C1', thread_ts: '1000000000.000100', thread_url: 'https://w.slack.com/archives/C1/p1000000000000100', messages: ['<@UJEM> can you look?'], status: 'pending', created_at: '2026-11-06T09:00:00' };
  const mk = (over: Record<string, unknown> = {}) => {
    const log = { sent: [] as string[][], closed: [] as string[] };
    const deps = {
      readDraft: (id: string) => (id === 'd1' ? draft : undefined),
      send: async (_id: string, m: string[]) => { log.sent.push(m); return { ok: true, detail: 'posted', permalink: 'https://w.slack.com/archives/C1/p1000000200000100?thread_ts=1000000000.000100&cid=C1' }; },
      closePane: (a: string, s: string) => { log.closed.push(a + ':' + s); return { found: true, ok: true }; },
      names: { UJEM: 'Jemelee' },
      now: 1_000_000_200_500,
      ...over,
    };
    return { deps, log };
  };

  it('posts, closes the pane the Save-for-later way, and parks with who and where', async () => {
    const d = db();
    const { deps, log } = mk();
    const r = await sendAndPark(d, 'd1', draft.messages, deps);
    expect(r).toMatchObject({ ok: true, parked: true, closed: true, waiting_on: ['Jemelee'] });
    expect(log.sent).toEqual([draft.messages]);
    expect(log.closed).toEqual(['claude:s1']);
    expect(getParked(d, 'claude', 's1')).toMatchObject({ state: 'waiting', channel: 'C1', thread_ts: '1000000000.000100', sent_ts: '1000000200.000100', waiting_on: ['Jemelee'] });
  });

  it('a dry run posts nothing, closes nothing, parks nothing', async () => {
    const d = db();
    const { deps, log } = mk({ send: async () => ({ ok: true, dry: true, detail: 'dry run: nothing posted' }) });
    const r = await sendAndPark(d, 'd1', draft.messages, deps);
    expect(r.parked).toBeUndefined();
    expect(log.closed).toEqual([]);
    expect(listParked(d)).toEqual([]);
  });

  it('a failed send leaves the chat open and unparked', async () => {
    const d = db();
    const { deps, log } = mk({ send: async () => ({ ok: false, detail: 'send failed: boom' }) });
    expect((await sendAndPark(d, 'd1', draft.messages, deps)).ok).toBe(false);
    expect(log.closed).toEqual([]);
    expect(listParked(d)).toEqual([]);
  });

  it('a top-level post parks on the thread it started', async () => {
    const d = db();
    const top: Draft = { ...draft, thread_ts: undefined, thread_url: undefined, channel: 'C9', messages: ['hi team'] };
    const { deps } = mk({ readDraft: () => top, send: async () => ({ ok: true, detail: 'posted', permalink: 'https://w.slack.com/archives/C9/p1000000300000200' }) });
    await sendAndPark(d, 'd1', top.messages, deps);
    expect(getParked(d, 'claude', 's1')).toMatchObject({ channel: 'C9', thread_ts: '1000000300.000200', sent_ts: '1000000300.000200', waiting_on: [] });
  });

  it('with no thread to watch the message stays sent and the chat stays open', async () => {
    const d = db();
    const top: Draft = { ...draft, thread_ts: undefined, thread_url: undefined, channel: 'C9' };
    const { deps, log } = mk({ readDraft: () => top, send: async () => ({ ok: true, detail: 'posted' }) });
    const r = await sendAndPark(d, 'd1', top.messages, deps);
    expect(r).toMatchObject({ ok: true, parked: false });
    expect(r.detail).toContain('not parked');
    expect(log.closed).toEqual([]);
  });

  it('a chat with no live pane still parks (nothing to close)', async () => {
    const d = db();
    const { deps } = mk({ closePane: () => ({ found: false, ok: false }) });
    const r = await sendAndPark(d, 'd1', draft.messages, deps);
    expect(r).toMatchObject({ parked: true, closed: false });
  });

  it('addresses a DM’s other party when the text mentions nobody', () => {
    expect(addresseesOf(['hi'], 'D1', { D1: 'jake' })).toEqual(['jake']);
    expect(addresseesOf(['<@UA> <@UB> <@UA>'], 'C1', { UA: 'Ann' })).toEqual(['Ann', 'UB']);
  });
});

describe('resume prompt and launch', () => {
  it('names the replier, links the reply and quotes it', () => {
    const d = db();
    park(d);
    d.prepare(`UPDATE parked_chats SET state='replied', reply_user='Jemelee', reply_ts='1000000400.000100', reply_text='line one\nline two'`).run();
    const p = resumePrompt(getParked(d, 'claude', 's1')!);
    expect(p).toContain('Jemelee replied');
    expect(p).toContain('> line one\n> line two');
    expect(p).toContain('https://w.slack.com/archives/C1/p1000000400000100?thread_ts=1000000000.000100&cid=C1');
  });

  it('a resume carries the prompt as its first turn; a plain resume does not', () => {
    const input = { projectDir: '/p', sessionId: 'abc', sourceAgent: 'claude' as const, selectedAgent: 'claude' as const };
    expect(buildLaunchCommand(input)).not.toContain("$'");
    const withPrompt = buildLaunchCommand({ ...input, prompt: 'Jemelee replied\nok' });
    expect(withPrompt).toContain('claude --resume');
    expect(withPrompt).toContain('Jemelee replied');
    expect(withPrompt).toContain('\\n');
  });
});

describe('auto-resume setting', () => {
  it('is off until set', () => {
    const d = db();
    expect(autoResumeParked(d)).toBe(false);
    expect(applySettings(d, { auto_resume_parked: 'yes' }).ok).toBe(false);
    d.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('slack_watchers','off')`).run();
    expect(applySettings(d, { auto_resume_parked: true }).ok).toBe(true);
    expect(autoResumeParked(d)).toBe(true);
    applySettings(d, { auto_resume_parked: false });
    expect(autoResumeParked(d)).toBe(false);
  });
});

// The real close path (Save for later's closeSession), on a throwaway tmux server only.
describe('closing the pane, on a throwaway tmux socket', () => {
  const sock = `loom-test-${process.pid}`;
  const marker = path.join(os.tmpdir(), `loom-park-${process.pid}`);
  const had = process.env.LOOM_TMUX_SOCKET;
  afterEach(() => {
    try { execFileSync('tmux', ['-L', sock, 'kill-server'], { stdio: 'ignore' }); } catch { /* none running */ }
    fs.rmSync(marker, { force: true });
    // kill-server leaves the socket file behind.
    fs.rmSync(path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${process.getuid?.() ?? 0}`, sock), { force: true });
    if (had === undefined) delete process.env.LOOM_TMUX_SOCKET; else process.env.LOOM_TMUX_SOCKET = had;
    configureTmuxSocket(null);
  });

  it('sends Ctrl-C twice to the chat’s pane', async () => {
    process.env.LOOM_TMUX_SOCKET = sock;
    execFileSync('tmux', ['-L', sock, '-f', path.join(__dirname, 'fixtures', 'tmux-test.conf'), 'new-session', '-d', '-s', 'park-test', '-x', '80', '-y', '24', `sh -c 'sh -c "trap \\"echo closed > ${marker}; exit 0\\" INT; while :; do sleep 0.1; done"; sleep 30'`]);
    const pane = execFileSync('tmux', ['-L', sock, 'list-panes', '-a', '-F', '#{pane_id}'], { encoding: 'utf-8' }).trim().split('\n')[0];
    await new Promise((r) => setTimeout(r, 400));
    expect(closeSession(pane, 'claude').ok).toBe(true);
    for (let i = 0; i < 20 && !fs.existsSync(marker); i++) await new Promise((r) => setTimeout(r, 100));
    expect(fs.existsSync(marker)).toBe(true);
  });
});

// The three outcomes of the confirm step, with a stubbed sender and a stubbed pane closer.
describe('Send / Send & park / Send & close (stubbed sender)', () => {
  const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');
  const SID = 'sess-abc';
  const draft: Draft = { id: 'd1', session_id: SID, channel: 'C1', thread_ts: '1000000000.000100', thread_url: 'https://w.slack.com/archives/C1/p1000000000000100', messages: ['<@UJEM> ok?'], status: 'pending', created_at: '2026-11-06T09:00:00' };
  const permalink = 'https://w.slack.com/archives/C1/p1000000200000100?thread_ts=1000000000.000100&cid=C1';
  async function setup(over: Record<string, unknown> = {}) {
    const d = openDb(':memory:');
    d.exec(PARKED_SCHEMA_SQL);
    upsertChat(d, await parseJsonlFile(FIX), 1000, 5000);
    d.prepare(`INSERT INTO slack_threads (thread_key, url, agent, session_id, source, created_at) VALUES ('C1:1000000000.000100', ?, 'claude', ?, 'index', 1)`).run(draft.thread_url, SID);
    const log = { sent: [] as string[][], closed: [] as string[] };
    const deps = {
      readDraft: (id: string) => (id === 'd1' ? draft : undefined),
      send: async (_id: string, m: string[]) => { log.sent.push(m); return { ok: true, detail: 'posted', permalink }; },
      closePane: (a: string, s: string) => { log.closed.push(a + ':' + s); return { found: true, ok: true }; },
      names: { UJEM: 'Jemelee' },
      now: Date.now(),
      ...over,
    };
    return { d, deps, log };
  }
  const board = (d: ReturnType<typeof openDb>) => toChatViews(d).filter((c) => !c.done).map((c) => c.session_id);
  const history = (d: ReturnType<typeof openDb>) => toChatViews(d).map((c) => c.session_id);

  it('Send posts and leaves the chat exactly as it is', async () => {
    const { d, deps, log } = await setup();
    const r = await sendThen(d, 'none', 'd1', draft.messages, deps);
    expect(r.ok).toBe(true);
    expect(log.sent).toEqual([draft.messages]);
    expect(log.closed).toEqual([]);
    expect(listParked(d)).toEqual([]);
    expect(d.prepare(`SELECT COUNT(*) AS n FROM chat_hidden`).get()).toEqual({ n: 0 });
    expect(board(d)).toEqual([SID]);
  });

  it('Send & park posts, closes the pane and parks', async () => {
    const { d, deps, log } = await setup();
    const r = await sendThen(d, 'park', 'd1', draft.messages, deps);
    expect(r).toMatchObject({ ok: true, parked: true, closed: true });
    expect(log.closed).toEqual(['claude:' + SID]);
    expect(getParked(d, 'claude', SID)?.state).toBe('waiting');
    expect(d.prepare(`SELECT COUNT(*) AS n FROM chat_hidden`).get()).toEqual({ n: 0 });
  });

  it('Send & close posts, closes the pane, ends reply watching and takes the chat off the board but not out of history', async () => {
    const { d, deps, log } = await setup();
    park(d, { sessionId: SID });
    expect(getParked(d, 'claude', SID)).toBeTruthy();
    const r = await sendThen(d, 'close', 'd1', draft.messages, deps);
    expect(r).toMatchObject({ ok: true, done: true, closed: true });
    expect(log.sent).toEqual([draft.messages]);
    expect(log.closed).toEqual(['claude:' + SID]);
    expect(getParked(d, 'claude', SID)).toBeUndefined();
    expect(board(d)).toEqual([]);
    expect(history(d)).toEqual([SID]);
    expect(toChatViews(d)[0].done).toBe(true);
    // Thread ownership survives, so the Slack hotkey still finds the chat.
    expect(d.prepare(`SELECT session_id FROM slack_threads WHERE thread_key = 'C1:1000000000.000100'`).get()).toEqual({ session_id: SID });
    // Restore to board reverses it.
    expect(restoreChat(d, 'claude', SID)).toBe(true);
    expect(board(d)).toEqual([SID]);
    expect(restoreChat(d, 'claude', SID)).toBe(false);
  });

  it('a closed chat returns by itself once it is active again (Resume)', async () => {
    const { d } = await setup();
    const last = (d.prepare(`SELECT last_active_at AS t FROM chats`).get() as { t: number }).t;
    markChatDone(d, 'claude', SID, last);
    expect(toChatViews(d)[0].done).toBe(true);
    d.prepare(`UPDATE chats SET last_active_at = ?`).run(last + CLOSE_GRACE_MS + 1);
    expect(toChatViews(d)[0].done).toBe(false);
  });

  it('Remove from board (no via) still hides the chat from history too', async () => {
    const { d } = await setup();
    d.prepare(`INSERT INTO chat_hidden (agent, session_id, hidden_at) VALUES ('claude', ?, ?)`).run(SID, Date.now() + 1e9);
    expect(history(d)).toEqual([]);
    expect(restoreChat(d, 'claude', SID)).toBe(false);
  });

  for (const after of ['none', 'park', 'close'] as const) {
    it(`a failed post leaves everything untouched (${after})`, async () => {
      const { d, deps, log } = await setup({ send: async () => ({ ok: false, detail: 'slack said no' }) });
      park(d, { sessionId: SID });
      const r = await sendThen(d, after, 'd1', draft.messages, deps);
      expect(r).toMatchObject({ ok: false, detail: 'slack said no' });
      expect(log.closed).toEqual([]);
      expect(getParked(d, 'claude', SID)).toBeTruthy();
      expect(d.prepare(`SELECT COUNT(*) AS n FROM chat_hidden`).get()).toEqual({ n: 0 });
      expect(board(d)).toEqual([SID]);
    });
  }

  it('a dry run closes and marks nothing', async () => {
    const { d, deps, log } = await setup({ send: async () => ({ ok: true, dry: true, detail: 'dry run' }) });
    await sendThen(d, 'close', 'd1', draft.messages, deps);
    expect(log.closed).toEqual([]);
    expect(d.prepare(`SELECT COUNT(*) AS n FROM chat_hidden`).get()).toEqual({ n: 0 });
  });

  it('a chat with no live pane is still marked done', async () => {
    const { d, deps } = await setup({ closePane: () => ({ found: false, ok: false }) });
    const r = await sendThen(d, 'close', 'd1', draft.messages, deps);
    expect(r).toMatchObject({ ok: true, done: true, closed: false });
    expect(board(d)).toEqual([]);
  });
});
