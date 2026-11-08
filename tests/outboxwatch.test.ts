import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { OutboxWatch, startedThreads, draftSendStates, eventsOfLine, postsDraft, type TranscriptEvent } from '../src/outboxwatch.ts';
import { readOutbox, type Draft } from '../src/outbox.ts';

const CH = 'C0TESTOUT01';
const TS = '1793985656.300399';
const draft = (o: Partial<Draft> = {}): Draft => ({ id: 'd1', session_id: 's1', channel: CH, thread_ts: TS, messages: ['hello there from the chat'], status: 'pending', created_at: '2026-11-06T10:00:00Z', ...o });
const T = Date.parse('2026-11-06T10:05:00Z');

const bashUse = (id: string, command: string, ts = T): TranscriptEvent => ({ kind: 'use', id, ts, name: 'Bash', input: { command } });
const result = (id: string, o: Partial<TranscriptEvent> = {}): TranscriptEvent => ({ kind: 'result', id, ts: T + 1000, isError: false, text: '{"ok":true}', ...o });

describe('postsDraft', () => {
  it('matches a Bash call that names the channel and thread_ts', () => {
    const cmd = `python3 -c "import json;json.dump({'channel':'${CH}','thread_ts':'${TS}','messages':['a','b']},open('/tmp/p.json','w'))" && node ~/.claude/tools/slack send --file /tmp/p.json`;
    expect(postsDraft({ name: 'Bash', input: { command: cmd } }, draft())).toBe(true);
  });
  it('ignores Bash calls that do not post: other thread, no slack, preview, read', () => {
    const d = draft();
    expect(postsDraft({ name: 'Bash', input: { command: `slack send ${CH} 1700000000.000001` } }, d)).toBe(false);
    expect(postsDraft({ name: 'Bash', input: { command: `echo ${CH} ${TS}` } }, d)).toBe(false);
    expect(postsDraft({ name: 'Bash', input: { command: `node slack preview --file x # ${CH} ${TS}` } }, d)).toBe(false);
    expect(postsDraft({ name: 'Bash', input: { command: `slack-threads outbox sent d1 ${CH} ${TS}` } }, d)).toBe(false);
  });
  it('a re-read of the thread is not a send (the festive-atlas false "Sending…")', () => {
    const d = draft();
    const read = `gh pr view 4044 --json state; node ~/.claude/tools/slack/slack.mjs read-thread --channel ${CH} --ts ${TS} 2>&1 | tail -40`;
    expect(postsDraft({ name: 'Bash', input: { command: read } }, d)).toBe(false);
    expect(postsDraft({ name: 'Bash', input: { command: `curl -s slack.com/api/conversations.replies?channel=${CH}&ts=${TS}` } }, d)).toBe(false);
    expect(postsDraft({ name: 'mcp__claude_ai_Slack__slack_read_thread', input: { channel_id: CH, message_ts: TS } }, d)).toBe(false);
    expect(postsDraft({ name: 'Bash', input: { command: `node ~/.claude/tools/slack/slack.mjs send --channel ${CH} --thread-ts ${TS} --text-file m1.md` } }, d)).toBe(true);
  });
  it('ignores calls made before the draft was recorded', () => {
    const d = draft();
    const early = bashUse('tu0', `node ~/.claude/tools/slack/slack.mjs send --channel ${CH} --thread-ts ${TS}`, Date.parse(d.created_at) - 30_000);
    expect(draftSendStates([early], [d]).get(d.id)).toBeUndefined();
  });
  it('matches the Slack MCP send tool by channel_id + thread_ts', () => {
    const name = 'mcp__claude_ai_Slack__slack_send_message';
    expect(postsDraft({ name, input: { channel_id: CH, thread_ts: TS, message: 'x' } }, draft())).toBe(true);
    expect(postsDraft({ name, input: { channel_id: CH, thread_ts: '1.2', message: 'x' } }, draft())).toBe(false);
    expect(postsDraft({ name, input: { channel_id: 'C999', thread_ts: TS, message: 'x' } }, draft())).toBe(false);
    expect(postsDraft({ name: 'mcp__claude_ai_Slack__slack_send_message_draft', input: { channel_id: CH, thread_ts: TS } }, draft())).toBe(false);
    expect(postsDraft({ name: 'mcp__claude_ai_Slack__slack_read_thread', input: { channel_id: CH, thread_ts: TS } }, draft())).toBe(false);
  });
  it('an unthreaded draft also needs the opening of one of its messages', () => {
    const d = draft({ thread_ts: undefined });
    const name = 'mcp__claude_ai_Slack__slack_send_message';
    expect(postsDraft({ name, input: { channel_id: CH, message: 'Hello there from the chat, thanks' } }, d)).toBe(true);
    expect(postsDraft({ name, input: { channel_id: CH, message: 'something else entirely' } }, d)).toBe(false);
  });
});

describe('draftSendStates', () => {
  const cmd = `node slack send --file p.json # ${CH} ${TS}`;
  it('call with no result yet is sending', () => {
    expect(draftSendStates([bashUse('t1', cmd)], [draft()]).get('d1')).toEqual({ state: 'sending' });
  });
  it('clean result is sent', () => {
    expect(draftSendStates([bashUse('t1', cmd), result('t1')], [draft()]).get('d1')?.state).toBe('sent');
  });
  it('error result, or ok:false output, is failed with a note', () => {
    expect(draftSendStates([bashUse('t1', cmd), result('t1', { isError: true, text: 'exit 1' })], [draft()]).get('d1')).toEqual({ state: 'failed', note: 'Send failed in chat' });
    expect(draftSendStates([bashUse('t1', cmd), result('t1', { text: '{"ok": false, "error": "channel_not_found"}' })], [draft()]).get('d1')?.state).toBe('failed');
  });
  it('a retry after a failure goes back to sending, then sent', () => {
    const evs = [bashUse('t1', cmd), result('t1', { isError: true }), bashUse('t2', cmd)];
    expect(draftSendStates(evs, [draft()]).get('d1')?.state).toBe('sending');
    expect(draftSendStates([...evs, result('t2')], [draft()]).get('d1')?.state).toBe('sent');
  });
  it('ignores a post from before the draft existed', () => {
    expect(draftSendStates([bashUse('t1', cmd, Date.parse('2026-11-06T09:00:00Z')), result('t1')], [draft()]).size).toBe(0);
  });
});

describe('eventsOfLine', () => {
  it('reads tool_use and tool_result blocks from transcript lines', () => {
    const use = JSON.stringify({ type: 'assistant', timestamp: '2026-11-06T10:05:00Z', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } });
    const res = JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'boom' }] }] } });
    expect(eventsOfLine(use)).toEqual([{ kind: 'use', id: 'tu1', ts: T, name: 'Bash', input: { command: 'ls' } }]);
    expect(eventsOfLine(res)[0]).toMatchObject({ kind: 'result', id: 'tu1', isError: true, text: 'boom' });
    expect(eventsOfLine('not json')).toEqual([]);
  });
});

describe('OutboxWatch transitions', () => {
  let dir: string, outbox: string, jsonl: string;
  const line = (c: unknown[], type = 'assistant') => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content: c } }) + '\n';
  const setStatus = (st: string) => fs.writeFileSync(outbox, JSON.stringify({ drafts: { d1: draft({ status: st }) } }));
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outboxwatch-'));
    outbox = path.join(dir, 'o.json');
    jsonl = path.join(dir, 's1.jsonl');
    fs.writeFileSync(jsonl, '');
    fs.writeFileSync(outbox, JSON.stringify({ drafts: { d1: draft({ created_at: '2020-01-01T00:00:00Z' }) } }));
  });
  const mk = () => {
    const rec: string[] = [];
    const w = new OutboxWatch({ file: outbox, transcriptOf: () => jsonl, reconcileOne: async (id) => { rec.push(id); return []; } });
    return { w, rec };
  };
  const stat = () => readOutbox(outbox).d1;
  const cmd = `node slack send # ${CH} ${TS}`;

  it('pending -> sending -> sent (marks it sent by the chat, reports it as recently sent)', async () => {
    const { w, rec } = mk();
    await w.tick();
    expect(w.stateOf('d1')).toBeUndefined();
    fs.appendFileSync(jsonl, line([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: cmd } }]));
    await w.tick();
    expect(w.stateOf('d1')).toEqual({ state: 'sending' });
    expect(rec).toEqual(['d1']); // thread reconcile fires right away for the sending draft
    fs.appendFileSync(jsonl, line([{ type: 'tool_result', tool_use_id: 'tu1', content: '{"ok":true}' }], 'user'));
    await w.tick();
    expect(stat()).toMatchObject({ status: 'sent', sent_by: 'chat' });
    expect(w.stateOf('d1')).toBeUndefined();
    expect(w.recentlySent()).toEqual(['d1']);
  });

  it('sending -> failed on an error result, nothing is marked', async () => {
    const { w } = mk();
    fs.appendFileSync(jsonl, line([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: cmd } }]));
    fs.appendFileSync(jsonl, line([{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'Exit code 1' }], 'user'));
    await w.tick();
    expect(w.stateOf('d1')).toEqual({ state: 'failed', note: 'Send failed in chat' });
    expect(stat().status).toBe('pending');
    expect(w.recentlySent()).toEqual([]);
  });

  it('a draft Loom itself is posting is never marked by the transcript scan', async () => {
    fs.writeFileSync(outbox, JSON.stringify({ drafts: { d1: draft({ created_at: '2020-01-01T00:00:00Z', send_started_at: Date.now() }) } }));
    const { w } = mk();
    fs.appendFileSync(jsonl, line([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: cmd } }]));
    fs.appendFileSync(jsonl, line([{ type: 'tool_result', tool_use_id: 'tu1', content: '{"ok":true}' }], 'user'));
    await w.tick();
    expect(stat()).toMatchObject({ status: 'pending' });
    expect(w.recentlySent()).toEqual([]);
  });

  it('sendingSince reports when a chat started posting, only while it is sending', async () => {
    let t = 5_000_000;
    const w = new OutboxWatch({ file: outbox, now: () => t, transcriptOf: () => jsonl, reconcileOne: async () => [] });
    expect(w.sendingSince('d1')).toBeUndefined();
    fs.appendFileSync(jsonl, line([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: cmd } }]));
    await w.tick();
    expect(w.sendingSince('d1')).toBe(5_000_000);
    t += 1000;
    fs.appendFileSync(jsonl, line([{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: 'x' }], 'user'));
    await w.tick();
    expect(w.sendingSince('d1')).toBeUndefined();
  });

  it('a draft settled elsewhere drops its state', async () => {
    const { w } = mk();
    fs.appendFileSync(jsonl, line([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: cmd } }]));
    await w.tick();
    expect(w.stateOf('d1')?.state).toBe('sending');
    setStatus('sent');
    await w.tick();
    expect(w.stateOf('d1')).toBeUndefined();
  });

  it('reconciles a sending draft at most every 5 s', async () => {
    let t = 1_000_000;
    const rec: string[] = [];
    const w = new OutboxWatch({ file: outbox, now: () => t, transcriptOf: () => jsonl, reconcileOne: async (id) => { rec.push(id); return []; } });
    fs.appendFileSync(jsonl, line([{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: cmd } }]));
    await w.tick(); t += 1000; await w.tick();
    expect(rec).toHaveLength(1);
    t += 5000; await w.tick();
    expect(rec).toHaveLength(2);
    t += 70_000; await w.tick();
    expect(rec).toHaveLength(2); // past the one-minute window
  });
});

describe('startedThreads', () => {
  const root = 'https://acme.slack.com/archives/C0TESTDST01/p1793990180251589';
  const sent = (cmd: string, text: string, id = 'u1'): TranscriptEvent[] => [bashUse(id, cmd), result(id, { text })];
  const ok = (permalink: string) => JSON.stringify({ ok: true, channel: 'C0TESTDST01', ts: '1793990180.251589', permalink });

  it('a top-level send with a clean result starts a thread', () => {
    const r = startedThreads(sent('node ~/.claude/tools/slack/slack.mjs send --file m.json', ok(root)));
    expect(r.map((x) => x.key)).toEqual(['C0TESTDST01/1793990180.251589']);
  });
  it('falls back to channel + ts when the permalink is missing', () => {
    const r = startedThreads(sent('node slack.mjs send --file m.json', '{"ok":true,"channel":"C0TESTDST01","ts":"1793990180.251589"}'));
    expect(r.map((x) => x.key)).toEqual(['C0TESTDST01/1793990180.251589']);
  });
  it('a reply (thread_ts in the command, or a permalink to another root) starts nothing', () => {
    expect(startedThreads(sent('node slack.mjs send --file m.json # thread_ts 1.2', ok(root)))).toEqual([]);
    expect(startedThreads(sent('node slack.mjs send --file m.json', ok(root + '?thread_ts=1793990100.000100&cid=C0TESTDST01')))).toEqual([]);
  });
  it('failed sends, previews, reads and DMs start nothing', () => {
    expect(startedThreads([bashUse('u1', 'node slack.mjs send --file m.json'), result('u1', { isError: true, text: ok(root) })])).toEqual([]);
    expect(startedThreads(sent('node slack.mjs send --file m.json', '{"ok":false,"error":"x"}'))).toEqual([]);
    expect(startedThreads(sent('node slack.mjs preview --file m.json', ok(root)))).toEqual([]);
    expect(startedThreads(sent('node slack.mjs read-channel --channel C1', ok(root)))).toEqual([]);
    expect(startedThreads(sent('node slack.mjs send --file m.json', ok('https://acme.slack.com/archives/D0123ABCD/p1793990180251589')))).toEqual([]);
  });
  it('the MCP send tool counts when it is not a reply', () => {
    const mcp = (input: Record<string, unknown>): TranscriptEvent[] => [{ kind: 'use', id: 'm1', ts: T, name: 'mcp__claude_ai_Slack__slack_send_message', input }, result('m1', { text: `Sent: ${root}` })];
    expect(startedThreads(mcp({ channel_id: 'C0TESTDST01', message: 'hi' })).length).toBe(1);
    expect(startedThreads(mcp({ channel_id: 'C0TESTDST01', message: 'hi', thread_ts: '1.2' }))).toEqual([]);
  });
});

describe('OutboxWatch claims started threads', () => {
  it('claims once per thread for a live chat without any draft', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outboxwatch-'));
    const jsonl = path.join(dir, 's9.jsonl');
    const line = (c: unknown[], type: string) => JSON.stringify({ type, timestamp: new Date().toISOString(), message: { content: c } }) + '\n';
    fs.writeFileSync(jsonl, line([{ type: 'tool_use', id: 'u1', name: 'Bash', input: { command: 'node slack.mjs send --file m.json' } }], 'assistant')
      + line([{ type: 'tool_result', tool_use_id: 'u1', content: '{"ok":true,"channel":"C0TESTDST01","ts":"1793990180.251589","permalink":"https://a.slack.com/archives/C0TESTDST01/p1793990180251589"}' }], 'user'));
    const got: string[] = [];
    const w = new OutboxWatch({ file: path.join(dir, 'none.json'), transcriptOf: () => jsonl, liveSessionIds: () => ['s9'], claimStarted: (ref, sid) => { got.push(`${sid}:${ref.key}`); } });
    await w.tick();
    fs.appendFileSync(jsonl, line([{ type: 'text', text: 'done slack' }], 'assistant'));
    await w.tick();
    expect(got).toEqual(['s9:C0TESTDST01/1793990180.251589']);
  });
});
