import { describe, it, expect, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import path from 'node:path';
import { openDb, getDefaultAgent, getLaneView, getSlackHotkey, getTmuxSocket, watchersFeatureOn, DEFAULT_SLACK_HOTKEY } from '../src/db.ts';
import {
  SETTINGS,
  SETTING_KEYS,
  applySettingsPatch,
  getSetting,
  isAccelerator,
  onSettingChanged,
  resolveSetting,
  settingDef,
  settingsRegistryView,
  setSetting,
  type SettingChange,
  type SettingKey,
} from '../src/settingsSchema.ts';
import { autoResumeParked, settingsGet, settingsPut } from '../src/settings.ts';
import { getChannelProjects } from '../src/slackowner.ts';
import { ACTIVE_WINDOW_DAYS, ANALYZE_CAP, ANALYZE_CONCURRENCY, CLAUDE_HOME } from '../src/paths.ts';
import { DEFAULT_LIMITS, REAP_AFTER_MS } from '../src/managed.ts';
import { DEFAULT_SOCKET } from '../src/tmux.ts';

const NO_ENV = { env: {} as NodeJS.ProcessEnv };
const dbs: Database.Database[] = [];
function fresh(schema?: number): Database.Database {
  const db = openDb(':memory:', { migrate: false }); // these tests set the schema themselves
  if (schema !== undefined) db.prepare(`INSERT INTO settings(key, value) VALUES ('settings_schema', ?)`).run(String(schema));
  dbs.push(db);
  return db;
}
const putRow = (db: Database.Database, k: string, v: string) =>
  db.prepare(`INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(k, v);
const rowOf = (db: Database.Database, k: string) => (db.prepare(`SELECT value FROM settings WHERE key = ?`).get(k) as { value: string } | undefined)?.value;

afterEach(() => {
  while (dbs.length) dbs.pop()!.close();
});

// Every key in design §3, by section. A key added to or dropped from the
// registry has to be added or dropped here too.
const DESIGN_KEYS = [
  'default_agent', 'summary_model', 'analyze_cap', 'analyze_concurrency', 'active_window_days', 'new_thread_dir', 'notify_sound',
  'claude_bin', 'extra_path', 'codex_visible',
  'terminal', 'launch_target', 'lane_view', 'ghostty_rehome', 'ghostty_attach_cmd', 'pane_labels', 'pane_label_model', 'pane_tint', 'pane_tint_base',
  'perm_chats', 'perm_watchers', 'perm_orchestrator', 'rc_watchers', 'review_skill', 'voice_skill',
  'slack_mode', 'slack_identity', 'slack_scopes_granted', 'slack_client_id', 'slack_reconnect', 'slack_poll_parked', 'channel_projects', 'slack_goto_hotkey', 'slack_paste_fallback', 'slack_goto_confirm_new', 'slack_ax_last_result',
  'outbox_primary', 'outbox_confirm', 'auto_resume_parked', 'outbox_slack_drafts', 'outbox_chat_drafts', 'email_cli', 'outbox_keep_days',
  'orchestrator_enabled', 'orchestrator_autostart', 'orchestrator_notify', 'orchestrator_trust', 'orchestrator_session_id', 'orchestrator_pane_id',
  'watchers_enabled', 'watcher_brief_prune_days', 'watchers_ignore_self', 'watcher_default_target',
  'plugin_state', 'codex_hook',
  'last_project_dir', // kept beside new_thread_dir=last
  'tmux_socket', 'session_prefix', 'tmux_tmpdir', 'reap_idle_min', 'min_free_mb', 'max_load_per_cpu', 'port', 'find_chat_bin',
  'settings_schema', 'setup_state', 'setup_completed_at', 'setup_origin', 'tour_completed_at', 'tour_skipped_at',
  'trees_prune_after_ship',
];

// What an UNSET key does today, on a DB from before the registry. Each value is
// what the pre-registry code did with no row (the comment names where), so an
// existing install sees no change until its migration writes rows.
const TODAY: Record<string, unknown> = {
  default_agent: 'claude', // db.getDefaultAgent
  summary_model: 'account', // analyzer passes no --model
  analyze_cap: ANALYZE_CAP,
  analyze_concurrency: ANALYZE_CONCURRENCY,
  active_window_days: ACTIVE_WINDOW_DAYS,
  new_thread_dir: 'last', // last_project_dir, home fallback
  notify_sound: 'Hero', // server.ts osascript sound name
  claude_bin: '', // detected
  extra_path: [],
  codex_visible: 'on', // Codex is always offered
  terminal: '', // auto: terminal.resolveTerminal picks ghostty on lanes, else inside
  launch_target: '', // auto: lanes when lane sessions exist
  lane_view: 'zoom',
  ghostty_rehome: true,
  ghostty_attach_cmd: 'tmux attach -t', // ghostty.ts on the default socket (a shell alias of this before)
  pane_labels: true,
  pane_label_model: 'haiku', // panetopics.ts --model haiku
  pane_tint: true,
  pane_tint_base: '#1e1e2e',
  perm_chats: 'skip', // goto.ts --dangerously-skip-permissions
  perm_watchers: 'skip', // watchers.ts
  perm_orchestrator: 'skip', // orchsession.ts
  rc_watchers: true, // watchers.ts --remote-control
  review_skill: 'loom:review', // nothing read it; the migration takes an install's own from its briefs
  voice_skill: '', // likewise
  slack_mode: 'direct', // Slack ran whenever its CLI was present
  slack_identity: {},
  slack_scopes_granted: [],
  slack_client_id: '',
  slack_reconnect: '',
  slack_poll_parked: true,
  channel_projects: {},
  slack_goto_hotkey: DEFAULT_SLACK_HOTKEY,
  slack_paste_fallback: true,
  slack_goto_confirm_new: true,
  slack_ax_last_result: {},
  outbox_primary: 'send',
  outbox_confirm: true,
  auto_resume_parked: false, // settings.autoResumeParked: on only when 'on'
  outbox_slack_drafts: false,
  outbox_chat_drafts: true,
  email_cli: '',
  outbox_keep_days: 14,
  orchestrator_enabled: '1', // orchestrator.enabled: off only when '0'
  orchestrator_autostart: true,
  orchestrator_notify: 'needs_you',
  orchestrator_trust: true, // setup.sh pretrusts the folder
  orchestrator_session_id: '',
  orchestrator_pane_id: '',
  watchers_enabled: true, // db.watchersFeatureOn: off only when slack_watchers='off'
  watcher_brief_prune_days: 0, // briefs are never pruned
  watchers_ignore_self: true,
  watcher_default_target: 'managed', // the migration takes an install's lane from its watcher spawns
  plugin_state: {},
  codex_hook: true, // setup.sh installs it when Codex is present
  tmux_socket: DEFAULT_SOCKET, // tmux.ts: no -L flag
  session_prefix: 'loom-', // paths.SESSION_PREFIX
  tmux_tmpdir: '/tmp', // app/main.ts forces it
  reap_idle_min: REAP_AFTER_MS / 60_000,
  min_free_mb: 0, // the 2% / 300 MB rule
  max_load_per_cpu: DEFAULT_LIMITS.maxLoadPerCpu,
  port: 4317, // server.SERVER_PORT
  find_chat_bin: path.join(CLAUDE_HOME, 'tools', 'find-chat', 'bin', 'find-chat'), // paths.FIND_CHAT_BIN default
  last_project_dir: '',
  settings_schema: 1,
  setup_state: {},
  setup_completed_at: 0,
  setup_origin: '',
  tour_completed_at: 0,
  tour_skipped_at: 0,
  trees_prune_after_ship: true, // new, and on for existing installs too (asked for as the default)
};

// A new install (settings_schema = 2) with nothing stored: design §3 "New".
const NEW_USER: Record<string, unknown> = {
  default_agent: 'claude', summary_model: 'haiku', analyze_cap: 10, analyze_concurrency: 2, active_window_days: 7, new_thread_dir: 'last',
  notify_sound: 'system', claude_bin: '', extra_path: [], codex_visible: 'auto',
  terminal: 'inside', launch_target: 'managed', lane_view: 'zoom', ghostty_rehome: false, ghostty_attach_cmd: 'tmux attach -t', pane_labels: true,
  pane_label_model: 'haiku', pane_tint: false, pane_tint_base: '#1e1e2e',
  perm_chats: 'normal', perm_watchers: 'normal', perm_orchestrator: 'normal', rc_watchers: false,
  review_skill: 'loom:review', voice_skill: '',
  slack_mode: 'off', slack_poll_parked: true, channel_projects: {}, slack_goto_hotkey: 'Command+Shift+L', slack_paste_fallback: true, slack_goto_confirm_new: true,
  outbox_primary: 'send', outbox_confirm: true, auto_resume_parked: false, outbox_slack_drafts: false, outbox_chat_drafts: true, email_cli: '', outbox_keep_days: 14,
  orchestrator_enabled: '0', orchestrator_autostart: true, orchestrator_notify: 'needs_you', orchestrator_trust: false,
  watchers_enabled: false, watcher_brief_prune_days: 14, watchers_ignore_self: true, watcher_default_target: 'managed',
  codex_hook: false,
  tmux_socket: 'loom', session_prefix: 'loom-', tmux_tmpdir: 'auto', reap_idle_min: 10, port: 4317, find_chat_bin: '',
  settings_schema: 2,
};

describe('settings registry: coverage', () => {
  it('has every key in design §3, and nothing else', () => {
    expect([...SETTING_KEYS].sort()).toEqual([...DESIGN_KEYS].sort());
    expect(new Set(SETTING_KEYS).size).toBe(SETTING_KEYS.length);
  });

  it('every key carries the metadata, and both defaults pass its own validation', () => {
    for (const d of SETTINGS) {
      expect(d.label, d.key).toBeTruthy();
      expect(d.help, d.key).toBeTruthy();
      expect(typeof d.restart, d.key).toBe('boolean');
      expect(d.validate(d.defaultNew), `${d.key} defaultNew`).toMatchObject({ ok: true });
      // '' is the legacy "auto" for terminal and launch_target; nothing else may fail.
      if (!(d.key === 'terminal' || d.key === 'launch_target')) expect(d.validate(d.legacyUnset), `${d.key} legacyUnset`).toMatchObject({ ok: true });
    }
  });

  it('marks the keys the running process reads once as needing a restart', () => {
    const restart = SETTINGS.filter((d) => d.restart).map((d) => d.key).sort();
    expect(restart).toEqual(['port', 'session_prefix', 'slack_goto_hotkey', 'tmux_socket', 'tmux_tmpdir']);
  });
});

describe('settings registry: an unmigrated DB behaves exactly as today', () => {
  it.each(DESIGN_KEYS)('%s unset reads as today', (key) => {
    const db = fresh();
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(key); // openDb seeds default_agent
    expect(key in TODAY).toBe(true);
    expect(resolveSetting(db, key as SettingKey, NO_ENV)).toEqual({ value: TODAY[key], source: 'default' });
  });

  it('the old getters return what they returned before', () => {
    const db = fresh();
    expect(getDefaultAgent(db)).toBe('claude');
    expect(getLaneView(db)).toBe('zoom');
    expect(getSlackHotkey(db)).toBe('Command+Shift+L');
    expect(getTmuxSocket(db)).toBe('default');
    expect(watchersFeatureOn(db)).toBe(true);
    expect(autoResumeParked(db)).toBe(false);
  });

  it('rows an existing install already has are read the way the old code read them', () => {
    const db = fresh();
    putRow(db, 'terminal', ' ghostty ');
    putRow(db, 'launch_target', 'managed');
    putRow(db, 'default_agent', 'codex');
    putRow(db, 'slack_goto_hotkey', 'Control+Alt+K');
    putRow(db, 'auto_resume_parked', 'on');
    putRow(db, 'tmux_socket', 'loom');
    putRow(db, 'lane_view', 'mirror');
    putRow(db, 'orchestrator_enabled', '0');
    putRow(db, 'orchestrator_notify', 'off');
    putRow(db, 'orchestrator_pane_id', '%72');
    putRow(db, 'slack_channel_projects', JSON.stringify({ C123ABC: '/x/proj' }));
    expect(getSetting(db, 'terminal', NO_ENV)).toBe('ghostty');
    expect(getSetting(db, 'launch_target', NO_ENV)).toBe('managed');
    expect(getDefaultAgent(db)).toBe('codex');
    expect(getSlackHotkey(db)).toBe('Control+Alt+K');
    expect(autoResumeParked(db)).toBe(true);
    expect(getTmuxSocket(db)).toBe('loom');
    expect(getLaneView(db)).toBe('mirror');
    expect(getSetting(db, 'orchestrator_enabled', NO_ENV)).toBe('0');
    expect(getSetting(db, 'orchestrator_notify', NO_ENV)).toBe('off');
    expect(getSetting(db, 'orchestrator_pane_id', NO_ENV)).toBe('%72');
    // channel_projects lives in the row slackowner.ts already reads.
    expect(getSetting(db, 'channel_projects', NO_ENV)).toEqual({ C123ABC: '/x/proj' });
    expect(getChannelProjects(db)).toEqual({ C123ABC: '/x/proj' });
  });

  it('watchers_enabled follows the old slack_watchers row until it has one of its own', () => {
    const db = fresh();
    putRow(db, 'slack_watchers', 'OFF');
    expect(watchersFeatureOn(db)).toBe(false);
    putRow(db, 'slack_watchers', 'anything-else');
    expect(watchersFeatureOn(db)).toBe(true); // only 'off' was ever off
    putRow(db, 'slack_watchers', 'off');
    putRow(db, 'watchers_enabled', 'on');
    expect(watchersFeatureOn(db)).toBe(true);
  });

  it('a row that does not parse reads as unset, as the old parse-or-default getters did', () => {
    const db = fresh();
    putRow(db, 'lane_view', 'sideways');
    putRow(db, 'default_agent', 'gpt');
    putRow(db, 'slack_goto_hotkey', '   ');
    putRow(db, 'tmux_socket', '');
    putRow(db, 'analyze_cap', 'lots');
    putRow(db, 'channel_projects', '{not json');
    expect(getLaneView(db)).toBe('zoom');
    expect(getDefaultAgent(db)).toBe('claude');
    expect(getSlackHotkey(db)).toBe('Command+Shift+L');
    expect(getTmuxSocket(db)).toBe('default');
    expect(resolveSetting(db, 'analyze_cap', NO_ENV)).toEqual({ value: 25, source: 'default' });
  });
});

describe('settings registry: a new install', () => {
  it.each(Object.keys(NEW_USER))('%s unset reads as the new-user default', (key) => {
    const db = fresh(2);
    expect(getSetting(db, key as SettingKey, NO_ENV)).toEqual(NEW_USER[key]);
  });

  it('does not read pre-registry row names once migrated', () => {
    const db = fresh(2);
    putRow(db, 'slack_watchers', 'on');
    expect(watchersFeatureOn(db)).toBe(false);
  });
});

describe('settings registry: environment overrides', () => {
  it('env beats the stored row, and reports itself as the source', () => {
    const db = fresh();
    putRow(db, 'tmux_socket', 'loom');
    expect(resolveSetting(db, 'tmux_socket', { env: { LOOM_TMUX_SOCKET: 'other' } })).toEqual({ value: 'other', source: 'env' });
    expect(resolveSetting(db, 'tmux_socket', { env: { LOOM_TMUX_SOCKET: 'bad name!' } })).toEqual({ value: 'loom', source: 'stored' });
    expect(resolveSetting(db, 'tmux_socket', { env: false })).toEqual({ value: 'loom', source: 'stored' });
  });

  it('each existing env var maps to its key', () => {
    const db = fresh();
    const env = {
      LOOM_PORT: '5000',
      LOOM_SESSION_PREFIX: '',
      FIND_CHAT_BIN: '/opt/fc',
      LOOM_ORCHESTRATOR: '0',
      LOOM_WATCHERS_OFF: '1',
      LOOM_MIN_FREE_MB: '512',
      LOOM_MAX_LOAD_PER_CPU: '1.5',
      TMUX_TMPDIR: '/private/tmp',
    } as NodeJS.ProcessEnv;
    expect(getSetting(db, 'port', { env })).toBe(5000);
    expect(getSetting(db, 'session_prefix', { env })).toBe(''); // empty prefix = every session, as before
    expect(getSetting(db, 'find_chat_bin', { env })).toBe('/opt/fc');
    expect(getSetting(db, 'orchestrator_enabled', { env })).toBe('0');
    expect(getSetting(db, 'watchers_enabled', { env })).toBe(false);
    expect(getSetting(db, 'min_free_mb', { env })).toBe(512);
    expect(getSetting(db, 'max_load_per_cpu', { env })).toBe(1.5);
    expect(getSetting(db, 'tmux_tmpdir', { env })).toBe('/private/tmp');
  });

  it('unusable env values are ignored, as the old readers ignored them', () => {
    const db = fresh();
    const env = { LOOM_PORT: 'abc', LOOM_MIN_FREE_MB: '-1', LOOM_ORCHESTRATOR: 'yes', LOOM_WATCHERS_OFF: '0' } as NodeJS.ProcessEnv;
    expect(resolveSetting(db, 'port', { env }).source).toBe('default');
    expect(resolveSetting(db, 'min_free_mb', { env }).source).toBe('default');
    expect(getSetting(db, 'orchestrator_enabled', { env })).toBe('1');
    expect(getSetting(db, 'watchers_enabled', { env })).toBe(true);
  });

  it('the old getters ignore env, as before (their callers apply it)', () => {
    const db = fresh();
    const prev = process.env.LOOM_TMUX_SOCKET;
    process.env.LOOM_TMUX_SOCKET = 'envsock';
    try {
      expect(getTmuxSocket(db)).toBe('default');
    } finally {
      if (prev === undefined) delete process.env.LOOM_TMUX_SOCKET;
      else process.env.LOOM_TMUX_SOCKET = prev;
    }
  });
});

describe('settings registry: writes and validation', () => {
  it('stores booleans as on/off and lists/objects as JSON, in the row the old code reads', () => {
    const db = fresh();
    expect(setSetting(db, 'auto_resume_parked', true)).toMatchObject({ ok: true, changed: true });
    expect(rowOf(db, 'auto_resume_parked')).toBe('on');
    setSetting(db, 'extra_path', ['/opt/bin', '~/bin']);
    expect(rowOf(db, 'extra_path')).toBe('["/opt/bin","~/bin"]');
    setSetting(db, 'channel_projects', { C1: '/p' });
    expect(rowOf(db, 'slack_channel_projects')).toBe('{"C1":"/p"}');
    expect(rowOf(db, 'channel_projects')).toBeUndefined();
    setSetting(db, 'orchestrator_enabled', '0');
    expect(rowOf(db, 'orchestrator_enabled')).toBe('0');
  });

  it('PUT rejects unknown keys, internal keys and malformed values, and writes nothing', () => {
    const db = fresh();
    const before = db.prepare(`SELECT key, value FROM settings ORDER BY key`).all();
    const cases: Record<string, unknown>[] = [
      { nope: 1 },
      { settings_schema: 2 },
      { orchestrator_pane_id: '%1' },
      { setup_completed_at: 1 },
      { lane_view: 'zoom', analyze_cap: 0 }, // a good key does not save a bad one
      { analyze_cap: 2.5 },
      { analyze_cap: '10' },
      { analyze_concurrency: 7 },
      { pane_tint: 'on' },
      { terminal: 'kitty' },
      { terminal: '' },
      { tmux_socket: 'bad name!' },
      { pane_tint_base: 'red' },
      { slack_goto_hotkey: 'Command+Shift' },
      { slack_goto_hotkey: 'Hyper+L' },
      { notify_sound: 'Boing' },
      { new_thread_dir: 'relative/dir' },
      { claude_bin: 'claude' },
      { extra_path: '/opt/bin' },
      { extra_path: ['relative'] },
      { channel_projects: { 'not-an-id': '/p' } },
      { channel_projects: ['C1'] },
      { watcher_default_target: 'lane:' },
      { review_skill: 'has space' },
      { max_load_per_cpu: 0 },
      { port: 80 },
      { slack_watchers: 'yes' },
    ];
    for (const body of cases) expect(applySettingsPatch(db, body), JSON.stringify(body)).toMatchObject({ ok: false });
    expect(applySettingsPatch(db, null)).toMatchObject({ ok: false });
    expect(applySettingsPatch(db, [1])).toMatchObject({ ok: false });
    expect(db.prepare(`SELECT key, value FROM settings ORDER BY key`).all()).toEqual(before);
  });

  it('PUT accepts good values, maps slack_watchers, and reports changed keys and restart', () => {
    const db = fresh();
    expect(applySettingsPatch(db, { lane_view: 'mirror', analyze_cap: 40, slack_watchers: false })).toEqual({
      ok: true,
      restart: false,
      changed: ['lane_view', 'analyze_cap', 'watchers_enabled'],
    });
    expect(watchersFeatureOn(db)).toBe(false);
    expect(applySettingsPatch(db, { tmux_socket: 'loom' })).toEqual({ ok: true, restart: true, changed: ['tmux_socket'] });
    expect(applySettingsPatch(db, { tmux_socket: 'loom' })).toEqual({ ok: true, restart: false, changed: [] });
    // Writing today's effective value explicitly is not a change.
    expect(applySettingsPatch(db, { notify_sound: 'Hero' })).toEqual({ ok: true, restart: false, changed: [] });
    expect(applySettingsPatch(db, { slack_goto_hotkey: 'off', voice_skill: '', review_skill: 'none', watcher_default_target: 'lane:ops' })).toMatchObject({ ok: true });
    expect(applySettingsPatch(db, { slack_goto_hotkey: 'CmdOrCtrl+Alt+F5' })).toMatchObject({ ok: true });
  });

  it('onSettingChanged hears each committed change once, and not a no-op write', () => {
    const db = fresh();
    const seen: SettingChange[] = [];
    const off = onSettingChanged((c) => seen.push(c));
    try {
      applySettingsPatch(db, { pane_tint: false, lane_view: 'zoom' });
      setSetting(db, 'summary_model', 'haiku');
      setSetting(db, 'summary_model', 'haiku');
      applySettingsPatch(db, { analyze_cap: 0 }); // rejected
    } finally {
      off();
    }
    setSetting(db, 'summary_model', 'opus'); // after unsubscribe
    expect(seen).toEqual([
      { key: 'pane_tint', value: false, previous: true },
      { key: 'summary_model', value: 'haiku', previous: 'account' },
    ]);
  });

  it('a throwing listener does not fail the write', () => {
    const db = fresh();
    const off = onSettingChanged(() => {
      throw new Error('boom');
    });
    try {
      expect(setSetting(db, 'pane_labels', false)).toMatchObject({ ok: true, changed: true });
    } finally {
      off();
    }
  });
});

describe('settings registry: the API view', () => {
  it('GET lists every key with value, source and restart, and keeps the old view fields', () => {
    const db = fresh();
    putRow(db, 'lane_view', 'mirror');
    const r = settingsGet(db, { lanes: false, env: { LOOM_PORT: '5001' } });
    expect(r.status).toBe(200);
    const s = r.body.settings as Record<string, { value: unknown; source: string; restart: boolean }>;
    expect(Object.keys(s).sort()).toEqual([...DESIGN_KEYS].sort());
    for (const k of DESIGN_KEYS) {
      expect(s[k], k).toHaveProperty('value');
      expect(['env', 'stored', 'default'], k).toContain(s[k].source);
      expect(typeof s[k].restart, k).toBe('boolean');
    }
    expect(s.lane_view).toMatchObject({ value: 'mirror', source: 'stored', restart: false });
    expect(s.port).toMatchObject({ value: 5001, source: 'env', restart: true, env: 'LOOM_PORT' });
    expect(s.perm_chats).toMatchObject({ value: 'skip', source: 'default', options: ['normal', 'skip'] });
    expect(s.settings_schema).toMatchObject({ internal: true });
    // the page's current fields are still there
    expect(r.body).toMatchObject({ ok: true, lane_view: { effective: 'mirror' }, terminal: { effective: 'inside' } });
  });

  it('GET never carries a Slack token', () => {
    const db = fresh();
    setSetting(db, 'slack_identity', { team: 'T', user: 'u' });
    const body = JSON.stringify(settingsGet(db, { lanes: false, env: { SLACK_USER_TOKEN: 'xoxp-1-secret' } }).body);
    expect(body).not.toMatch(/xox[abposr]-/);
  });

  it('PUT returns 400 with a reason, or 200 with the refreshed view', () => {
    const db = fresh();
    expect(settingsPut(db, { nope: true }, { lanes: false })).toMatchObject({ status: 400, body: { ok: false, detail: expect.stringContaining('nope') } });
    const r = settingsPut(db, { launch_target: 'managed', perm_chats: 'normal' }, { lanes: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, restart: false, changed: ['launch_target', 'perm_chats'], launch_target: { stored: 'managed' } });
    expect((r.body.settings as Record<string, { value: unknown }>).perm_chats.value).toBe('normal');
  });

  it('the registry view reports the default in force for the DB’s schema', () => {
    expect(settingsRegistryView(fresh(), {}).perm_watchers.default).toBe('skip');
    expect(settingsRegistryView(fresh(2), {}).perm_watchers.default).toBe('normal');
  });
});

describe('isAccelerator', () => {
  it('accepts Electron accelerators and rejects the rest', () => {
    for (const a of ['Command+Shift+L', 'Control+Alt+K', 'CmdOrCtrl+F5', 'F12', 'Alt+Space', 'Shift+/']) expect(isAccelerator(a), a).toBe(true);
    for (const a of ['', 'Command+', 'Command+Shift', 'Command+Command+L', 'Hyper+L', 'Command+LL']) expect(isAccelerator(a), a).toBe(false);
  });

  it('every default hotkey is valid', () => {
    expect(isAccelerator(settingDef('slack_goto_hotkey').defaultNew as string)).toBe(true);
  });
});
