import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';
import { applySchema } from '../src/schema.ts';
import {
  parseWhen, parseThen, addStep, listSteps, getStep, setStep, openChains, setCloseWhenDone, chatFlags, stepSummary, newStepId, type ActionItem,
} from '../src/actions.ts';

const S = 's1';
let db: Database.Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

const add = (id: string, over: Partial<Parameters<typeof addStep>[1]> = {}) =>
  addStep(db, { id, session_id: S, title: 'T', when: 'now', then: 'none', ask_first: false, created_by: 'chat', at: 1000, ...over });

describe('parseWhen', () => {
  it('reads a PR reference or URL', () => {
    expect(parseWhen('pr-merged:acme/app#123')).toEqual({ type: 'pr_merged', params: { repo: 'acme/app', number: 123 } });
    expect(parseWhen('pr-shipped:https://github.com/acme/app/pull/123')).toEqual({ type: 'pr_shipped', params: { repo: 'acme/app', number: 123 } });
    expect(parseWhen('pr-merged:acme#x')).toHaveProperty('error');
  });

  it('reads a Slack reply with from= and a trailing answers= that keeps its commas', () => {
    expect(
      parseWhen('slack-reply:https://acme.slack.com/archives/C0123456789/p1700000000000100,from=the reviewer,answers=can we ship Friday, or Monday?'),
    ).toEqual({
      type: 'slack_reply',
      params: {
        thread_url: 'https://acme.slack.com/archives/C0123456789/p1700000000000100',
        channel: 'C0123456789',
        thread_ts: '1700000000.000100',
        from: 'the reviewer',
        answers: 'can we ship Friday, or Monday?',
      },
    });
    expect(parseWhen('slack-reply:https://example.com/x')).toHaveProperty('error');
  });

  it('reads draft-sent, now, manual, and refuses the rest', () => {
    expect(parseWhen('draft-sent:d0123456789ab')).toEqual({ type: 'draft_sent', params: { draft_id: 'd0123456789ab' } });
    expect(parseWhen('draft-sent:nope')).toHaveProperty('error');
    expect(parseWhen('now')).toEqual({ type: 'now', params: {} });
    expect(parseWhen('manual')).toEqual({ type: 'manual', params: {} });
    expect(parseWhen('tomorrow')).toHaveProperty('error');
  });
});

describe('parseThen', () => {
  it('reads send-draft, wake and none', () => {
    expect(parseThen('send-draft:d0123456789ab')).toEqual({ type: 'send_draft', params: { draft_id: 'd0123456789ab' } });
    expect(parseThen('wake:"merge it and watch the deploy"')).toEqual({ type: 'wake_chat', params: { instruction: 'merge it and watch the deploy' } });
    expect(parseThen('wake:""')).toHaveProperty('error');
    expect(parseThen('none')).toEqual({ type: 'none', params: {} });
    expect(parseThen('shrug')).toHaveProperty('error');
  });
});

describe('store', () => {
  it('appends positions per session and is idempotent on id', () => {
    expect(add('a00000000001')).toEqual({ ok: true, detail: 'added' });
    add('a00000000002');
    add('a00000000003', { session_id: 'other' });
    expect(add('a00000000002')).toEqual({ ok: true, detail: 'exists' });
    expect(listSteps(db, S).map((s) => [s.id, s.position])).toEqual([['a00000000001', 1], ['a00000000002', 2]]);
    expect(listSteps(db, 'other')[0].position).toBe(1);
  });

  it('stores a bad spec as a failed step rather than dropping it', () => {
    add('a00000000001', { when: 'tomorrow' });
    const s = getStep(db, 'a00000000001')!;
    expect(s.status).toBe('failed');
    expect(s.status_why).toMatch(/^couldn't read --when 'tomorrow': /);
    expect([s.trigger_type, s.action_type]).toEqual(['manual', 'none']);
    add('a00000000002', { then: 'bogus' });
    expect(getStep(db, 'a00000000002')).toMatchObject({ status: 'failed', action_type: 'none', trigger_type: 'now' });
  });

  it('round-trips params and booleans, and hides removed steps unless asked', () => {
    add('a00000000001', { when: 'pr-merged:acme/app#123', then: 'wake:"go"', ask_first: true });
    add('a00000000002');
    expect(getStep(db, 'a00000000001')).toMatchObject({ trigger_params: { repo: 'acme/app', number: 123 }, action_params: { instruction: 'go' }, ask_first: true, status: 'waiting' });
    expect(setStep(db, 'a00000000002', { status: 'removed', removed_from: 'waiting' })).toBe(true);
    expect(listSteps(db, S).map((s) => s.id)).toEqual(['a00000000001']);
    expect(listSteps(db, S, { all: true })).toHaveLength(2);
    expect(setStep(db, 'a0000000nope', { status: 'done' })).toBe(false);
  });

  it('openChains covers sessions with an unfinished step, and keeps their done steps', () => {
    add('a00000000001');
    add('a00000000002');
    add('a00000000003', { session_id: 'finished' });
    setStep(db, 'a00000000001', { status: 'done' });
    setStep(db, 'a00000000003', { status: 'done' });
    const chains = openChains(db);
    expect([...chains.keys()]).toEqual([S]);
    expect(chains.get(S)!.map((s) => s.id)).toEqual(['a00000000001', 'a00000000002']);
  });

  it('tracks close-when-done per chat; turning it on clears closed_at', () => {
    expect(chatFlags(db, S)).toEqual({ close_when_done: false, closed_at: 0 });
    setCloseWhenDone(db, S, true, 5);
    expect(chatFlags(db, S).close_when_done).toBe(true);
    db.prepare(`UPDATE action_chats SET closed_at = 9 WHERE session_id = ?`).run(S);
    setCloseWhenDone(db, S, false, 6);
    expect(chatFlags(db, S)).toEqual({ close_when_done: false, closed_at: 9 });
    setCloseWhenDone(db, S, true, 7);
    expect(chatFlags(db, S)).toEqual({ close_when_done: true, closed_at: 0 });
  });

  it('mints a step id', () => {
    expect(newStepId()).toMatch(/^a[0-9a-f]{12}$/);
  });
});

describe('stepSummary', () => {
  const mk = (when: string, then: string) => {
    add('a00000000001', { when, then });
    const s = getStep(db, 'a00000000001') as ActionItem;
    db.prepare(`DELETE FROM action_items`).run();
    return stepSummary(s);
  };
  it('describes trigger and action', () => {
    expect(mk('pr-merged:acme/app#123', 'send-draft:d0123456789ab')).toBe('When PR #123 merges → send draft');
    expect(mk('pr-shipped:acme/app#123', 'wake:"x"')).toBe('When acme/app#123 ships → wake the chat');
    expect(mk('slack-reply:https://acme.slack.com/archives/C0123456789/p1700000000000100,from=the reviewer', 'none')).toBe('When the reviewer replies → none');
    expect(mk('manual', 'none')).toBe('To do');
  });
});
