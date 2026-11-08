import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../src/db.ts';
import { getSetting, setSetting } from '../src/settingsSchema.ts';
import { analyzerConfig, modelArgs, summarizeDirty, defaultRunner, type ClaudeRunner } from '../src/analyzer.ts';
import { upsertChat } from '../src/indexer.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { PaneTopics, paneLabelConfig, type TopicDeps, type PaneRow } from '../src/panetopics.ts';
import { desiredTints, tintPalette, TINT_BG, DEFAULT_TINT_BASE } from '../src/panetint.ts';
import { attachCommand, buildAttachScript, planTabAttach } from '../src/ghostty.ts';
import { detectFindChat, findChatFromSettings } from '../src/findchat.ts';
import { codexVisible } from '../src/terminal.ts';
import { limitsFromSettings, reapTtlMs, planReap, DEFAULT_LIMITS } from '../src/managed.ts';
import type { LiveInfo } from '../src/placements.ts';
import path from 'node:path';

const NO_ENV = {} as NodeJS.ProcessEnv;
const dbs: Database.Database[] = [];
function fresh(newInstall = true): Database.Database {
  const db = openDb(':memory:');
  if (newInstall) db.prepare(`INSERT INTO settings(key, value) VALUES ('settings_schema', '2')`).run();
  dbs.push(db);
  return db;
}
afterEach(() => { while (dbs.length) dbs.pop()!.close(); });

describe('summary_model, caps and window', () => {
  it('new install defaults: haiku, 10, 2, 7', () => {
    const c = analyzerConfig(fresh());
    expect(c).toMatchObject({ summaryModel: 'haiku', cap: 10, concurrency: 2, windowDays: 7 });
  });
  it('migrated install keeps 25 / 3 and no model flag', () => {
    const c = analyzerConfig(fresh(false));
    expect(c).toMatchObject({ summaryModel: 'account', cap: 25, concurrency: 3 });
  });
  it('modelArgs: account passes nothing', () => {
    expect(modelArgs('account')).toEqual([]);
    expect(modelArgs('sonnet')).toEqual(['--model', 'sonnet']);
  });
  it('summarizeDirty hands the runner the configured model and bin', async () => {
    const db = fresh();
    setSetting(db, 'summary_model', 'sonnet');
    setSetting(db, 'claude_bin', '/opt/claude');
    upsertChat(db, await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl')), 1000, 5000);
    const seen: unknown[] = [];
    const runner: ClaudeRunner = async (_p, o) => {
      seen.push(o);
      return '{"title":"T","overview":"O","breakdown":["a"]}';
    };
    await summarizeDirty(db, runner, { now: 6000 });
    expect(seen[0]).toEqual({ model: 'sonnet', claudeBin: '/opt/claude' });
  });
  it('summarizeDirty honours analyze_cap', async () => {
    const db = fresh();
    setSetting(db, 'analyze_cap', 1);
    const base = await parseJsonlFile(path.join(__dirname, 'fixtures', 'sample-chat.jsonl'));
    upsertChat(db, base, 1000, 5000);
    upsertChat(db, { ...base, sessionId: 'other-session' } as typeof base, 1000, 5000);
    let n = 0;
    const runner: ClaudeRunner = async () => { n++; return '{"title":"T","overview":"O","breakdown":["a"]}'; };
    const r = await summarizeDirty(db, runner, { now: 6000 });
    expect(r.attempted).toBe(1);
    expect(n).toBeLessThanOrEqual(1);
  });
  it('the default runner is a function taking opts', () => {
    expect(typeof defaultRunner).toBe('function');
  });
});

function topicDeps() {
  const calls: { model?: string }[] = [];
  const unset: string[] = [];
  const labeled: PaneRow = {
    pane_id: '%1', session_name: 'loom-a', topic: 'Old', stage: 'thread', sid: 's1',
    topicAt: 0, topicOff: 0, stageAt: 0, stageSize: 0,
  };
  const deps: TopicDeps = {
    readPanes: () => [labeled],
    setOpts: () => {},
    unsetOpts: (p) => { unset.push(p); },
    transcriptPath: () => '/t.jsonl',
    stat: () => ({ size: 10, mtimeMs: Date.now() }),
    readRange: () => '',
    haiku: async (_a, model) => { calls.push({ model }); return ''; },
    threads: () => [],
    log: () => {},
  };
  return { deps, calls, unset };
}

describe('pane labels toggle and model', () => {
  it('settings: on / haiku for a new install; off clears borders and makes no model call', () => {
    const db = fresh();
    expect(paneLabelConfig(db)).toEqual({ enabled: true, model: 'haiku' });
    setSetting(db, 'pane_labels', false);
    setSetting(db, 'pane_label_model', 'sonnet');
    const cfg = paneLabelConfig(db);
    expect(cfg).toEqual({ enabled: false, model: 'sonnet' });
    const { deps, calls, unset } = topicDeps();
    const t = new PaneTopics(deps, 'loom-', () => paneLabelConfig(db));
    const r = t.tick(new Map<string, LiveInfo>());
    expect(r).toEqual({ started: 0, cleared: 1 });
    expect(unset).toEqual(['%1']);
    expect(calls).toEqual([]);
  });
});

function live(): Map<string, LiveInfo> {
  return new Map([['k', { pane_id: '%1', tmux_session: 'loom-a' } as LiveInfo]]);
}

describe('pane tint toggle and base', () => {
  const now = Date.now();
  const old = new Map([['k', now - 5 * 86_400_000]]);
  it('pane_tint: off for a new install, on when migrated', () => {
    expect(getSetting(fresh(), 'pane_tint')).toBe(false);
    expect(getSetting(fresh(false), 'pane_tint')).toBe(true);
    expect(getSetting(fresh(), 'pane_tint_base')).toBe('#1e1e2e');
  });
  it('default base reproduces the built-in palette', () => {
    expect(tintPalette(DEFAULT_TINT_BASE)).toEqual(TINT_BG);
    expect(desiredTints(live(), old, now, 'loom-').get('%1')).toBe(`bg=${TINT_BG.older}`);
  });
  it('enabled:false desires nothing', () => {
    expect(desiredTints(live(), old, now, 'loom-', { enabled: false }).size).toBe(0);
  });
  it('a custom base shifts the ramp with it', () => {
    const p = tintPalette('#000000');
    expect(p.older).not.toBe(TINT_BG.older);
    expect(desiredTints(live(), old, now, 'loom-', { base: '#000000' }).get('%1')).toBe(`bg=${p.older}`);
    expect(tintPalette('nonsense')).toEqual(TINT_BG);
  });
});

describe('ghostty_attach_cmd', () => {
  const tabs = [{ window_index: 1, tab_index: 1, title: '', tabbed: false, selected: true }] as never[];
  it('defaults to tmux attach -t; the setting replaces it', () => {
    expect(attachCommand('loom-a')).toBe('tmux attach -t loom-a');
    expect(attachCommand('loom-a', 'ta')).toBe('ta loom-a');
    expect(attachCommand('loom-a', '  ')).toBe('tmux attach -t loom-a');
    const plan = planTabAttach({ sessions: ['loom-a'], tabs, attached: [] });
    expect(buildAttachScript(plan)).toContain('keystroke "tmux attach -t loom-a"');
    expect(buildAttachScript(plan, 'myattach')).toContain('keystroke "myattach loom-a"');
  });
});

describe('find-chat detection', () => {
  it('configured path must exist; empty detects candidates; none hides', () => {
    expect(detectFindChat('/x/fc', (p) => p === '/x/fc')).toBe('/x/fc');
    expect(detectFindChat('/x/fc', () => false)).toBeNull();
    expect(detectFindChat('', () => false)).toBeNull();
    expect(detectFindChat('', (p) => p.endsWith('/find-chat'))).toMatch(/find-chat$/);
  });
  it('reads find_chat_bin from settings', () => {
    const db = fresh();
    expect(findChatFromSettings(db, () => false)).toBeNull();
    setSetting(db, 'find_chat_bin', '/y/fc');
    expect(findChatFromSettings(db, (p) => p === '/y/fc')).toBe('/y/fc');
  });
});

describe('codex_visible', () => {
  it('auto follows ~/.codex; on/off force', () => {
    const db = fresh();
    expect(codexVisible(db, () => false)).toBe(false);
    expect(codexVisible(db, (p) => p === '/h/.codex', '/h')).toBe(true);
    setSetting(db, 'codex_visible', 'on');
    expect(codexVisible(db, () => false)).toBe(true);
    setSetting(db, 'codex_visible', 'off');
    expect(codexVisible(db, () => true)).toBe(false);
  });
  it('a migrated install keeps showing Codex', () => {
    expect(codexVisible(fresh(false), () => false)).toBe(true);
  });
});

describe('reap and capacity settings', () => {
  it('reap_idle_min drives the ttl', () => {
    const db = fresh();
    expect(reapTtlMs(db)).toBe(10 * 60_000);
    setSetting(db, 'reap_idle_min', 3);
    expect(reapTtlMs(db)).toBe(180_000);
    const pane = { pane_id: '%9', tmux_session: 'loom-managed', window_index: 1, agent: null, command: 'zsh' } as never;
    expect(planReap([pane], new Map([['%9', 0]]), { now: 200_000, ttlMs: reapTtlMs(db) })).toEqual(['%9']);
    expect(planReap([pane], new Map([['%9', 0]]), { now: 100_000, ttlMs: reapTtlMs(db) })).toEqual([]);
  });
  it('min_free_mb 0 is the built-in rule; a value replaces the percentage', () => {
    const db = fresh();
    expect(limitsFromSettings(db, NO_ENV)).toEqual(DEFAULT_LIMITS);
    setSetting(db, 'min_free_mb', 2048);
    setSetting(db, 'max_load_per_cpu', 1);
    expect(limitsFromSettings(db, NO_ENV)).toMatchObject({ minFreeBytes: 2048 * 1024 * 1024, minFreeFraction: 0, maxLoadPerCpu: 1 });
  });
});
