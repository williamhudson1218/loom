import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discardDraft, pendingDrafts, sendDraft, sendPayload } from '../src/outbox.ts';

function outboxFile(drafts: Record<string, unknown>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-'));
  const f = path.join(dir, 'slack-outbox.json');
  fs.writeFileSync(f, JSON.stringify({ drafts }));
  return f;
}

const base = { session_id: 's1', channel: 'C1', created_at: '2026-10-16T09:00:00', messages: ['hello'] };

describe('outbox', () => {
  it('lists only pending drafts, oldest first, labelled from the channel cache', () => {
    const f = outboxFile({
      a: { ...base, id: 'a', status: 'sent' },
      b: { ...base, id: 'b', status: 'pending', created_at: '2026-10-16T09:05:00' },
      c: { ...base, id: 'c', status: 'pending', channel: 'C2' },
      d: { ...base, id: 'd', status: 'pending', messages: [] },
    });
    const labels = path.join(path.dirname(f), 'labels.json');
    fs.writeFileSync(labels, JSON.stringify({ C1: '#general' }));
    expect(pendingDrafts(f, labels).map((d) => [d.id, d.label])).toEqual([['c', 'C2'], ['b', '#general']]);
  });

  it('posts exactly the confirmed text to the draft’s destination, then marks it sent', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending', thread_ts: '1.2' } });
    const calls: string[][] = [];
    let posted: unknown = null;
    const run = async (cmd: string, args: string[]) => {
      calls.push([cmd, ...args]);
      if (args[1] === 'send') {
        posted = JSON.parse(fs.readFileSync(args[3], 'utf-8'));
        return JSON.stringify({ ok: true, permalink: 'https://w.slack.com/p1' });
      }
      return '';
    };
    const r = await sendDraft('x', ['edited text'], { run, file: f });
    expect(r).toMatchObject({ ok: true, permalink: 'https://w.slack.com/p1' });
    expect(posted).toEqual({ channel: 'C1', text: 'edited text', thread_ts: '1.2' });
    expect(calls[1].slice(1)).toEqual(['outbox', 'sent', 'x', '--by', 'loom', '--permalink', 'https://w.slack.com/p1']);
  });

  it('dry run previews and never sends or marks anything', async () => {
    const f = outboxFile({ x: { ...base, id: 'x', status: 'pending' } });
    const verbs: string[] = [];
    const run = async (_cmd: string, args: string[]) => {
      verbs.push(args[1]);
      return 'rendered';
    };
    const r = await sendDraft('x', ['one', 'two'], { run, file: f, dry: true });
    expect(r).toMatchObject({ ok: true, dry: true });
    expect(verbs).toEqual(['preview', 'preview']);
  });

  it('refuses a draft that is gone, already handled, or emptied', async () => {
    const f = outboxFile({ s: { ...base, id: 's', status: 'sent' }, p: { ...base, id: 'p', status: 'pending' } });
    const run = async () => {
      throw new Error('must not run');
    };
    expect(await sendDraft('nope', ['x'], { run, file: f })).toMatchObject({ ok: false, detail: 'no such draft' });
    expect(await sendDraft('s', ['x'], { run, file: f })).toMatchObject({ ok: false, detail: 'already sent' });
    expect(await sendDraft('p', ['x', '  '], { run, file: f })).toMatchObject({ ok: false });
    expect(await discardDraft('s', run, f)).toMatchObject({ ok: false, detail: 'already sent' });
  });

  it('sends several messages as one burst', () => {
    expect(sendPayload({ channel: '@d' }, ['a', 'b'])).toEqual({ channel: '@d', messages: ['a', 'b'] });
  });
});
