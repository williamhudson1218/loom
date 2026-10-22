import { describe, it, expect } from 'vitest';
import {
  PaneTopics, LABEL_SYSTEM, buildAsk, isHeadless, parseReply, planPane, recentActivity, topicRefreshDue, userPrompts,
  REFRESH_TOPIC_MS, REFRESH_GROWTH_BYTES, RECLASSIFY_STAGE_MS, TOPIC_OPTIONS, type PaneLabels, type PaneRow, type TopicDeps,
} from '../src/panetopics.ts';
import { agentSessionKey, type LiveInfo } from '../src/placements.ts';

const user = (content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', entrypoint: 'cli', message: { role: 'user', content }, ...extra });
const tool = (name: string, input: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
const say = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

describe('userPrompts', () => {
  it('keeps what the human typed and drops tool results, meta, sidechains and injected wrappers', () => {
    const t = [
      user('first ask'),
      user([{ type: 'tool_result', content: 'x' }]),
      user('hidden', { isMeta: true }),
      user('subagent', { isSidechain: true }),
      user('<system-reminder>noise</system-reminder>'),
      user([{ type: 'text', text: 'second <command-name>/x</command-name>ask' }]),
      '{"type":"user", broken',
    ].join('\n');
    expect(userPrompts(t)).toEqual(['first ask', 'second ask']);
  });
});

describe('recentActivity', () => {
  it('counts edits vs reads and flags shipping commands', () => {
    const t = [
      user('go'),
      tool('Read'), tool('Grep'), tool('Edit'), tool('Write'),
      tool('Bash', { command: 'yarn test foo' }),
      tool('Bash', { command: 'git commit -m x && git push' }),
      tool('Bash', { command: 'gh pr create --draft' }),
      tool('Bash', { command: 'gh run watch 1' }),
      say('Done. PR is up.'),
    ].join('\n');
    const a = recentActivity(t);
    expect(a).toMatchObject({ edits: 2, reads: 2, tests: 1, commit: true, push: true, prCreate: true, prReady: false, ciWatch: true });
    expect(a.lastFrom).toBe('assistant');
    expect(a.lastAssistantText).toBe('Done. PR is up.');
  });

  it('notices /ship typed as a prompt', () => {
    expect(recentActivity(user('/ship'), ['/ship']).ship).toBe(true);
  });

  it("keeps the assistant's own one-line descriptions of its tool calls, deduplicated, oldest first", () => {
    const t = [
      user('https://x.slack.com/archives/C1/p1'),
      tool('Bash', { command: 'ls', description: 'Look up the Slack CLI usage' }),
      tool('Bash', { command: 'node slack.mjs read-thread', description: 'Read the linked Slack thread' }),
      tool('Bash', { command: 'psql ...', description: 'List prod form tables to find the KS SIT revision rows' }),
      tool('Bash', { command: 'psql ...', description: 'List prod form tables to find the KS SIT revision rows' }),
      tool('Agent', { description: 'Research Delaware W-1 return rules', prompt: 'long brief' }),
      tool('Skill', { skill: 'review-pr', args: '3249' }),
      tool('Read', { file_path: '/a.ts' }),
    ].join('\n');
    expect(recentActivity(t).doings).toEqual([
      'Look up the Slack CLI usage',
      'Read the linked Slack thread',
      'List prod form tables to find the KS SIT revision rows',
      'Research Delaware W-1 return rules',
      '/review-pr 3249',
    ]);
  });
});

describe('isHeadless', () => {
  it('is true only for a non-cli entrypoint', () => {
    expect(isHeadless('{"entrypoint":"cli"}')).toBe(false);
    expect(isHeadless('{"entrypoint":"sdk-cli"}')).toBe(true);
    expect(isHeadless('{}')).toBe(false);
  });
});

describe('parseReply', () => {
  it('reads JSON wrapped in prose or a fence', () => {
    expect(parseReply('Sure:\n```json\n{"topic": "ACH Prenote Retry", "stage": "Shipping"}\n```')).toEqual({
      topic: 'ACH Prenote Retry', stage: 'shipping',
    });
  });

  it('validates each field on its own', () => {
    expect(parseReply('{"topic": "A label that is far too long to fit on a border", "stage": "thread"}')).toEqual({
      topic: null, stage: 'thread',
    });
    expect(parseReply('{"topic": "\\"Tmux Topics.\\"", "stage": "coding"}')).toEqual({ topic: 'Tmux Topics', stage: null });
    expect(parseReply('no json here')).toEqual({ topic: null, stage: null });
  });
});

describe('buildAsk', () => {
  it('carries the sticky label, the stage definitions and the prompts', () => {
    const a = recentActivity(tool('Edit'));
    const ask = buildAsk(['one', 'two'], a, 'Old Label', 4);
    expect(ask).toContain("Current topic: 'Old Label'");
    for (const s of ['discovery', 'implementation', 'shipping', 'thread', 'blocked']) expect(LABEL_SYSTEM).toContain(`- ${s}:`);
    expect(ask.indexOf('<chat>')).toBeLessThan(ask.indexOf('one'));
    expect(ask).toContain('1 edits');
    expect(ask).toContain('one\n---\ntwo');
  });

  it("carries the Slack threads the chat owns and the assistant's doings, so a bare link still names a subject", () => {
    const a = recentActivity(tool('Bash', { command: 'x', description: 'Find which tenant holds filing batch 2311' }));
    const ask = buildAsk(['https://x.slack.com/archives/C1/p1'], a, '', 0, ["#filings: @Will KS SIT can't be created"]);
    expect(ask).toContain("#filings: @Will KS SIT can't be created");
    expect(ask).toContain('Find which tenant holds filing batch 2311');
    expect(ask.indexOf('<chat>')).toBeLessThan(ask.indexOf('#filings'));
    expect(ask.indexOf('#filings')).toBeLessThan(ask.indexOf('</chat>'));
    // Nothing to say stays silent rather than printing empty headings.
    const bare = buildAsk(['hi'], recentActivity(''), '', 0);
    expect(bare).not.toMatch(/Slack threads this chat|descriptions of its recent tool calls/);
  });

  it('tells the namer the subject is never the medium the chat arrived by', () => {
    expect(LABEL_SYSTEM).toMatch(/Slack thread/);
    expect(LABEL_SYSTEM).toMatch(/placeholder/);
  });
});

const labels = (over: Partial<PaneLabels> = {}): PaneLabels => ({
  topic: 'T', stage: 'discovery', sid: 's1', topicAt: 0, topicOff: 100, stageAt: 0, stageSize: 100, ...over,
});

describe('planPane', () => {
  const now = 10 * REFRESH_TOPIC_MS;
  it('resets when a different session owns the pane, names when there is no topic', () => {
    expect(planPane(labels({ sid: 'old' }), 's1', 100, now).kind).toBe('reset');
    expect(planPane(labels({ topic: '' }), 's1', 100, now).kind).toBe('name');
  });

  it('does nothing while the transcript has not grown', () => {
    expect(planPane(labels(), 's1', 100, now).kind).toBe('none');
  });

  it('re-classifies stage after its interval once the transcript grew', () => {
    const fresh = labels({ topicAt: now, stageAt: now - RECLASSIFY_STAGE_MS + 1 });
    expect(planPane(fresh, 's1', 200, now).kind).toBe('none');
    expect(planPane(labels({ topicAt: now, stageAt: now - RECLASSIFY_STAGE_MS }), 's1', 200, now).kind).toBe('check');
  });
});

describe('topicRefreshDue', () => {
  const now = 10 * REFRESH_TOPIC_MS;
  it('needs both the time and three new prompts', () => {
    expect(topicRefreshDue(labels({ topicAt: now - REFRESH_TOPIC_MS }), 3, now)).toBe(true);
    expect(topicRefreshDue(labels({ topicAt: now - REFRESH_TOPIC_MS }), 2, now)).toBe(false);
    expect(topicRefreshDue(labels({ topicAt: now - 1000 }), 9, now)).toBe(false);
    expect(topicRefreshDue(labels({ topic: '' }), 0, now)).toBe(true);
  });

  it('also refreshes once an autonomous run has grown a lot with no new prompts', () => {
    const due = labels({ topicAt: now - REFRESH_TOPIC_MS });
    expect(topicRefreshDue(due, 0, now, REFRESH_GROWTH_BYTES)).toBe(true);
    expect(topicRefreshDue(due, 0, now, REFRESH_GROWTH_BYTES - 1)).toBe(false);
    expect(topicRefreshDue(labels({ topicAt: now - 1000 }), 0, now, 10 * REFRESH_GROWTH_BYTES)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

function live(paneId: string, sid: string, session = 'loom-tp-2'): Map<string, LiveInfo> {
  return new Map([[agentSessionKey('claude', sid), {
    agent: 'claude', session_id: sid, pane_id: paneId, tmux_session: session,
    window_index: '1', pane_index: '0', running: true, cwd: '/x',
  }]]);
}

function fakeDeps(transcript: string, reply = '{"topic":"Pane Topics","stage":"implementation"}', threads: string[] = []) {
  const opts = new Map<string, Record<string, string>>();
  const calls: string[] = [];
  const row = (paneId: string, session: string): PaneRow => {
    const o = opts.get(paneId) ?? {};
    return {
      pane_id: paneId, session_name: session, topic: o['@topic'] ?? '', stage: o['@stage'] ?? '', sid: o['@topic_sid'] ?? '',
      topicAt: Number(o['@topic_at'] ?? 0) * 1000, topicOff: Number(o['@topic_off'] ?? 0),
      stageAt: Number(o['@stage_at'] ?? 0) * 1000, stageSize: Number(o['@stage_size'] ?? 0),
    };
  };
  const panes: [string, string][] = [['%1', 'loom-tp-2'], ['%2', 'other']];
  const deps: TopicDeps = {
    readPanes: () => panes.map(([p, s]) => row(p, s)),
    setOpts: (p, o) => opts.set(p, { ...(opts.get(p) ?? {}), ...o }),
    unsetOpts: (p, names) => {
      const o = { ...(opts.get(p) ?? {}) };
      for (const n of names) delete o[n];
      opts.set(p, o);
    },
    transcriptPath: () => '/t.jsonl',
    stat: () => ({ size: transcript.length, mtimeMs: Date.now() }),
    readRange: (_f, from, to) => transcript.slice(from, to),
    haiku: async (ask) => {
      calls.push(ask);
      return reply;
    },
    threads: () => threads,
    log: () => {},
  };
  return { deps, opts, calls };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('PaneTopics', () => {
  it('names a live workspace chat once, with topic and stage', async () => {
    const { deps, opts, calls } = fakeDeps([user('build pane topics'), tool('Edit')].join('\n'));
    const t = new PaneTopics(deps, 'loom-');
    expect(t.tick(live('%1', 's1')).started).toBe(1);
    await settle();
    expect(opts.get('%1')).toMatchObject({ '@topic': 'Pane Topics', '@stage': 'implementation', '@topic_sid': 's1' });
    // Nothing grew: the next tick is free.
    expect(t.tick(live('%1', 's1')).started).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('renames at once when a new session takes the pane', async () => {
    const { deps, opts } = fakeDeps(user('hi'));
    const t = new PaneTopics(deps, 'loom-');
    t.tick(live('%1', 's1'));
    await settle();
    t.tick(live('%1', 's2'));
    expect(opts.get('%1')?.['@topic']).toBeUndefined();
    await settle();
    expect(opts.get('%1')).toMatchObject({ '@topic_sid': 's2', '@topic': 'Pane Topics' });
  });

  it('clears every option when the chat is no longer live', async () => {
    const { deps, opts } = fakeDeps(user('hi'));
    const t = new PaneTopics(deps, 'loom-');
    t.tick(live('%1', 's1'));
    await settle();
    expect(t.tick(new Map()).cleared).toBe(1);
    for (const o of TOPIC_OPTIONS) expect(opts.get('%1')?.[o]).toBeUndefined();
  });

  it('ignores panes outside the prefix and headless sessions', async () => {
    const { deps, calls } = fakeDeps(user('hi', { entrypoint: 'sdk-cli' }));
    const t = new PaneTopics(deps, 'loom-');
    t.tick(live('%2', 's9', 'other'));
    t.tick(live('%1', 's1'));
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('keeps the topic when only the stage is due', async () => {
    const { deps, opts } = fakeDeps(user('hi'), '{"topic":"Something Else","stage":"thread"}');
    const now = Date.now();
    opts.set('%1', {
      '@topic': 'Kept', '@stage': 'discovery', '@topic_sid': 's1', '@topic_at': String(Math.floor(now / 1000)),
      '@topic_off': '0', '@stage_at': String(Math.floor((now - RECLASSIFY_STAGE_MS) / 1000) - 1), '@stage_size': '1',
    });
    const t = new PaneTopics(deps, 'loom-');
    expect(t.tick(live('%1', 's1'), now).started).toBe(1);
    await settle();
    expect(opts.get('%1')).toMatchObject({ '@topic': 'Kept', '@stage': 'thread' });
  });
});

describe('PaneTopics on a chat opened from a link', () => {
  it('asks with the Slack thread the chat owns', async () => {
    const { deps, calls } = fakeDeps(
      [user('https://x.slack.com/archives/C1/p1'), tool('Bash', { command: 'x', description: 'Read the linked Slack thread' })].join('\n'),
      '{"topic":"KS SIT Tax Code","stage":"discovery"}',
      ["#filings: @Will KS SIT can't be created"],
    );
    const t = new PaneTopics(deps, 'loom-');
    t.tick(live('%1', 's1'));
    await settle();
    expect(calls[0]).toContain("KS SIT can't be created");
    expect(calls[0]).toContain('Read the linked Slack thread');
  });

  it('replaces a placeholder topic once the run has grown, even with no new prompts', async () => {
    const filler = Array.from({ length: 3000 }, () => tool('Bash', { command: 'psql', description: 'Find which tenant holds filing batch 2311' })).join('\n');
    const transcript = [user('https://x.slack.com/archives/C1/p1'), filler].join('\n');
    expect(transcript.length).toBeGreaterThan(REFRESH_GROWTH_BYTES);
    const { deps, opts, calls } = fakeDeps(transcript, '{"topic":"Filing Batch 2311","stage":"discovery"}');
    const now = Date.now();
    opts.set('%1', {
      '@topic': 'Slack Thread Link', '@stage': 'discovery', '@topic_sid': 's1',
      '@topic_at': String(Math.floor((now - REFRESH_TOPIC_MS) / 1000) - 1), '@topic_off': '100',
      '@stage_at': String(Math.floor(now / 1000)), '@stage_size': String(transcript.length),
    });
    const t = new PaneTopics(deps, 'loom-');
    expect(t.tick(live('%1', 's1'), now).started).toBe(1);
    await settle();
    expect(calls[0]).toContain("Current topic: 'Slack Thread Link'");
    expect(opts.get('%1')?.['@topic']).toBe('Filing Batch 2311');
  });
});

describe('PaneTopics on a long run', () => {
  it('finds the launch prompt when the tail holds only tool calls', async () => {
    const filler = Array.from({ length: 30000 }, () => tool('Read', { file_path: '/a/very/long/path/to/some/file.ts' })).join('\n');
    const { deps, opts, calls } = fakeDeps([user('author KSKCNS100'), filler].join('\n'));
    const t = new PaneTopics(deps, 'loom-');
    t.tick(live('%1', 's1'));
    await settle();
    expect(calls[0]).toContain('author KSKCNS100');
    expect(opts.get('%1')?.['@topic']).toBe('Pane Topics');
  });
});
