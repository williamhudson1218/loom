import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { applySchema } from '../src/schema.ts';
import { SAFE_LAUNCH_SETTINGS } from '../src/launch.ts';
import type { LanePane, WorldState } from '../src/compact.ts';
import { clearInvocableCache, discoverInvocables, hasInvocable, parseFrontmatter } from '../src/watchers/invocables.ts';
import { getWatcher, insertWatcher, validateDraft, type Match, type Watcher, type WatcherDraft } from '../src/watchers/model.ts';
import { act, decide, drainQueue, type EngineDeps } from '../src/watchers/engine.ts';
import { relayFromWatcher, renderBrief, renderPrompt } from '../src/watchers/actions.ts';
import { invocablesHandler } from '../src/routes/watchers.ts';

const NOW = 1_800_000_000_000;
let tmp: string;
let home: string;
let proj: string;
let db: Database.Database;

const write = (p: string, text: string) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
};

beforeEach(() => {
  clearInvocableCache();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-inv-'));
  home = path.join(tmp, 'home');
  proj = path.join(tmp, 'proj');
  db = new Database(':memory:');
  applySchema(db);
  // user skill (through a symlink), user command, nested user command
  write(path.join(tmp, 'elsewhere', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review a pull request\n---\nbody');
  fs.mkdirSync(path.join(home, '.claude', 'skills'), { recursive: true });
  fs.symlinkSync(path.join(tmp, 'elsewhere', 'review'), path.join(home, '.claude', 'skills', 'review'));
  write(path.join(home, '.claude', 'skills', 'no-skill-file', 'README.md'), 'x');
  write(path.join(home, '.claude', 'commands', 'ship.md'), '---\ndescription: "Ship the batch"\n---\n');
  write(path.join(home, '.claude', 'commands', 'ops', 'deploy.md'), 'no frontmatter');
  // plugin
  const inst = path.join(tmp, 'plugcache', 'superpowers', '1.0.0');
  write(path.join(inst, 'skills', 'brainstorming', 'SKILL.md'), '---\nname: brainstorming\ndescription: >\n  Use before creative work\n  and planning.\n---\n');
  write(path.join(inst, 'commands', 'plan.md'), '---\ndescription: Make a plan\n---\n');
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'superpowers@market': [{ scope: 'user', installPath: inst }], 'gone@market': [{ installPath: path.join(tmp, 'missing') }] } }));
  // project
  write(path.join(proj, '.claude', 'skills', 'local-skill', 'SKILL.md'), '---\nname: local-skill\ndescription: Only here\n---\n');
  write(path.join(proj, '.claude', 'commands', 'local-cmd.md'), 'x');
});

const found = (kind: 'skill' | 'command', name: string, dir = proj) => hasInvocable(kind, name, dir, { home });

describe('discovery', () => {
  it('finds user (symlinked), plugin and project skills and commands', () => {
    const all = discoverInvocables(proj, { home });
    const brief = all.map((i) => `${i.kind}:${i.name}:${i.source}`);
    expect(brief).toEqual([
      'skill:local-skill:project',
      'skill:review:user',
      'skill:superpowers:brainstorming:plugin',
      'command:local-cmd:project',
      'command:ops:deploy:user',
      'command:ship:user',
      'command:superpowers:plan:plugin',
    ]);
    expect(all.find((i) => i.name === 'review')!.description).toBe('Review a pull request');
    expect(all.find((i) => i.name === 'ship')!.description).toBe('Ship the batch');
    expect(all.find((i) => i.name === 'superpowers:brainstorming')!.description).toBe('Use before creative work and planning.');
  });
  it('leaves out project ones without a project folder', () => {
    expect(discoverInvocables('', { home }).some((i) => i.source === 'project')).toBe(false);
    expect(found('skill', 'local-skill', '')).toBe(false);
    expect(found('skill', 'local-skill')).toBe(true);
  });
  it('caches for 30 seconds', () => {
    let t = 1000;
    const o = { home, now: () => t };
    expect(discoverInvocables(proj, o).some((i) => i.name === 'late')).toBe(false);
    write(path.join(home, '.claude', 'commands', 'late.md'), 'x');
    t += 29_000;
    expect(discoverInvocables(proj, o).some((i) => i.name === 'late')).toBe(false);
    t += 2_000;
    expect(discoverInvocables(proj, o).some((i) => i.name === 'late')).toBe(true);
  });
  it('parses frontmatter, and a file without any', () => {
    expect(parseFrontmatter('no frontmatter')).toEqual({ name: '', description: '' });
    expect(parseFrontmatter("---\nname: 'x'\ndescription: y: z\n---\n")).toEqual({ name: 'x', description: 'y: z' });
  });
  it('the route lists them for a project', () => {
    const out: unknown[] = [];
    invocablesHandler({ json: (_c: number, b: unknown) => out.push(b), url: new URL('http://x/api/watchers/invocables?project=' + encodeURIComponent(proj)) } as never);
    expect((out[0] as { ok: boolean; invocables: unknown[] }).ok).toBe(true);
    expect(Array.isArray((out[0] as { invocables: unknown[] }).invocables)).toBe(true);
  });
});

describe('rendering the prompt', () => {
  const vars = { URL: 'https://x/pr/1', TITLE: 'Fix it' };
  it('skill with arguments and notes', () => {
    const p = { invoke: { kind: 'skill', name: 'review', args: '{{URL}} {{TITLE}}' }, notes: 'Read only.\nThen {{TITLE}}.' };
    expect(renderPrompt(p, 'brief_template', vars)).toBe('/review https://x/pr/1 Fix it\n\nRead only.\nThen Fix it.');
  });
  it('command without notes or arguments has no trailing space or blank line', () => {
    expect(renderPrompt({ invoke: { kind: 'command', name: 'ship', args: '' } }, 'brief_template', vars)).toBe('/ship');
    expect(renderPrompt({ invoke: { kind: 'command', name: 'ship', args: '--force' }, notes: '  ' }, 'brief_template', vars)).toBe('/ship --force');
  });
  it('message_chat keeps the notes on the same line', () => {
    expect(renderPrompt({ invoke: { kind: 'skill', name: 'review', args: '{{URL}}' }, notes: 'Be brief.' }, 'template', vars, true)).toBe('/review https://x/pr/1 Additional instructions: Be brief.');
  });
  it('without invoke it is byte-identical to the free-text template', () => {
    const t = 'Look at {{TITLE}}\r\n{{URL}}  \n\n{{UNKNOWN}} ';
    expect(renderPrompt({ brief_template: t, notes: 'ignored' }, 'brief_template', vars)).toBe(renderBrief(t, vars));
    expect(renderPrompt({ template: t }, 'template', vars)).toBe(renderBrief(t, vars));
    expect(renderPrompt({ invoke: { kind: 'bogus' }, template: t }, 'template', vars)).toBe(renderBrief(t, vars));
  });
  it('relay without the watcher prefix keeps the slash command first', () => {
    const sent: string[] = [];
    const rd = { focused: () => null, resolve: () => ({ agent: 'claude' as const, session_id: 's', pane_id: '%1', label: 'p' }), send: (_p: string, t: string) => { sent.push(t); return { ok: true, detail: '' }; }, now: () => NOW };
    relayFromWatcher(db, rd, 'W', 'claude', 's', '/review  a\nb', { bare: true });
    relayFromWatcher(db, rd, 'W', 'claude', 's', 'plain');
    expect(sent).toEqual(['/review a b', '[from Loom watcher "W"] plain']);
  });
});

const draft = (action: WatcherDraft['action']): WatcherDraft => ({
  label: 'W', enabled: false, run_mode: 'live',
  source: { kind: 'chats', params: {} }, trigger: { kind: 'done_idle', params: { min: 1 } }, action, max_per_hour: 0, cooldown_min: 0,
});
const startAction = (invoke: unknown, extra: Record<string, unknown> = {}): WatcherDraft['action'] => ({ kind: 'start_chat', params: { project_dir: proj, target: 'managed', brief_template: '', perm: 'inherit', invoke, ...extra } });

describe('save-time validation', () => {
  const opts = { invocable: (k: 'skill' | 'command', n: string, d: string) => hasInvocable(k, n, d, { home }) };
  it('accepts a discovered skill, command and a project one', () => {
    expect(validateDraft(draft(startAction({ kind: 'skill', name: 'review', args: '{{URL}}' }, { notes: 'x' })), opts)).toMatchObject({ ok: true });
    expect(validateDraft(draft(startAction({ kind: 'command', name: 'superpowers:plan', args: '' })), opts)).toMatchObject({ ok: true });
    expect(validateDraft(draft(startAction({ kind: 'skill', name: 'local-skill', args: '' })), opts)).toMatchObject({ ok: true });
  });
  it('rejects a name that is not discovered, with a clear error', () => {
    const r = validateDraft(draft(startAction({ kind: 'skill', name: 'nope', args: '' })), opts);
    expect(r).toMatchObject({ ok: false });
    expect((r as { detail: string }).detail).toBe(`skill nope was not found for ${proj}; choose one from the list`);
    // a skill is not a command
    expect(validateDraft(draft(startAction({ kind: 'command', name: 'review', args: '' })), opts)).toMatchObject({ ok: false });
    // a project skill is not offered to a different project
    expect(validateDraft(draft(startAction({ kind: 'skill', name: 'local-skill', args: '' }, { project_dir: path.join(tmp, 'other') })), opts)).toMatchObject({ ok: false });
  });
  it('message_chat checks user and plugin ones only', () => {
    const msg = (name: string) => draft({ kind: 'message_chat', params: { template: '', invoke: { kind: 'skill', name, args: '' } } });
    expect(validateDraft(msg('review'), opts)).toMatchObject({ ok: true });
    expect(validateDraft(msg('local-skill'), opts)).toMatchObject({ ok: false });
  });
  it('rejects a malformed invoke and invoke on other actions', () => {
    expect(validateDraft(draft(startAction({ kind: 'weird', name: 'x', args: '' })))).toMatchObject({ ok: false });
    expect(validateDraft(draft(startAction({ kind: 'skill', name: '', args: '' })))).toMatchObject({ ok: false });
    expect(validateDraft(draft(startAction({ kind: 'skill', name: 'a b', args: '' })))).toMatchObject({ ok: false });
    expect(validateDraft(draft({ kind: 'notify', params: { template: 'x', invoke: { kind: 'skill', name: 'review', args: '' } } }))).toMatchObject({ ok: false });
  });
  it('an invoke makes an empty brief valid for enabling; a plain empty brief still is not', () => {
    expect(validateDraft({ ...draft(startAction({ kind: 'skill', name: 'review', args: '' })), enabled: true }, { ...opts, forEnable: true })).toMatchObject({ ok: true });
    expect(validateDraft({ ...draft(startAction(undefined)), enabled: true }, { forEnable: true })).toMatchObject({ ok: false });
  });
  it('a watcher without invoke is stored exactly as before', () => {
    const v = validateDraft(draft({ kind: 'start_chat', params: { project_dir: proj, target: 'managed', brief_template: 'b', perm: 'inherit' } }), opts);
    expect(v).toMatchObject({ ok: true });
    expect((v as { draft: WatcherDraft }).draft.action.params).toEqual({ project_dir: proj, target: 'managed', brief_template: 'b', perm: 'inherit' });
  });
});

function deps(over: Partial<EngineDeps> = {}): EngineDeps & { launches: [string, string][]; relays: unknown[][] } {
  const launches: [string, string][] = [];
  const relays: unknown[][] = [];
  const pane: LanePane = { pane_id: '%5', tmux_session: 'loom-tp-2', window_index: '1', pane_index: '0', command: 'zsh', name: 'n5', group: '', agent: false };
  return {
    now: () => NOW, history: async () => [], slackOn: () => true, slackSelf: () => '', threadOwner: () => null, chats: () => [], prs: () => [],
    world: (): WorldState => ({ panes: [pane], focused: null }),
    launch: async (p, c) => { launches.push([p, c]); },
    acquireManaged: () => ({ ok: false, detail: 'no' }), launchSettings: () => SAFE_LAUNCH_SETTINGS,
    relay: (...a) => { relays.push(a); return { status: 'sent', detail: 'sent' }; },
    notify: () => true, tellOrch: () => true, dryRun: false, briefsDir: path.join(tmp, 'briefs'),
    invocable: (k, n, d) => hasInvocable(k, n, d, { home }),
    launches, relays, ...over,
  };
}

const add = (d: WatcherDraft): Watcher => {
  const v = validateDraft(d);
  if (!v.ok) throw new Error(v.detail);
  return getWatcher(db, insertWatcher(db, v.draft, NOW))!;
};
const match = (over: Partial<Match> = {}): Match => ({ key: 'k1', subject: 'chat:claude:s1', title: 'T', permalink: 'https://x/1', vars: { URL: 'https://x/1', TITLE: 'T' }, chat: { agent: 'claude', session_id: 's1' }, ...over });
const events = () => db.prepare(`SELECT decision, result, detail FROM watcher_events ORDER BY id`).all();

describe('fire time', () => {
  it('start_chat with a skill writes /name args + notes as the brief and launches', async () => {
    const w = add({ ...draft(startAction({ kind: 'skill', name: 'review', args: '{{URL}}' }, { notes: 'Read only.', target: 'lane:tp' })), source: { kind: 'chats', params: {} } });
    decide(db, w, match(), { now: NOW });
    const d = deps();
    expect(await drainQueue(db, getWatcher(db, w.id)!, d)).toEqual({ started: 1, waiting: 0 });
    const brief = (db.prepare(`SELECT brief_path FROM watcher_events`).get() as { brief_path: string }).brief_path;
    expect(fs.readFileSync(brief, 'utf-8')).toBe('/review https://x/1\n\nRead only.');
    expect(d.launches).toHaveLength(1);
  });
  it('start_chat fails the event, and starts nothing, when the skill is gone', async () => {
    const w = add(draft(startAction({ kind: 'skill', name: 'removed', args: '' }, { target: 'lane:tp' })));
    decide(db, w, match(), { now: NOW });
    const d = deps();
    expect(await drainQueue(db, getWatcher(db, w.id)!, d)).toEqual({ started: 0, waiting: 0 });
    expect(d.launches).toEqual([]);
    expect(events()).toEqual([{ decision: 'fired', result: 'failed', detail: 'skill removed not found' }]);
  });
  it('start_chat fails for a missing command with the command wording', async () => {
    const w = add(draft(startAction({ kind: 'command', name: 'removed', args: '' }, { target: 'lane:tp' })));
    decide(db, w, match(), { now: NOW });
    await drainQueue(db, getWatcher(db, w.id)!, deps());
    expect(events()).toEqual([{ decision: 'fired', result: 'failed', detail: 'command removed not found' }]);
  });
  const msgW = (invoke: unknown) => add(draft({ kind: 'message_chat', params: { template: '', invoke, notes: 'Be brief.' } as Record<string, unknown> }));
  const fire = (w: Watcher, m: Match, d: EngineDeps) => {
    const r = decide(db, w, m, { now: NOW })!;
    return act(db, w, r.id, m, d);
  };
  it('message_chat sends /name args first, without the watcher prefix', () => {
    const w = msgW({ kind: 'skill', name: 'review', args: '{{URL}}' });
    const d = deps();
    expect(fire(w, match(), d)).toBe('sent');
    expect(d.relays).toEqual([[w.label, 'claude', 's1', '/review https://x/1 Additional instructions: Be brief.', { bare: true }]]);
  });
  it('message_chat fails cleanly when the skill is gone', () => {
    const w = msgW({ kind: 'skill', name: 'removed', args: '' });
    const d = deps();
    expect(fire(w, match(), d)).toBe('failed');
    expect(d.relays).toEqual([]);
    expect(events()).toEqual([{ decision: 'fired', result: 'failed', detail: 'skill removed not found' }]);
  });
  it('message_chat refuses a Codex chat for a skill or command', () => {
    const w = msgW({ kind: 'command', name: 'ship', args: '' });
    const d = deps();
    expect(fire(w, match({ chat: { agent: 'codex', session_id: 'c1' } }), d)).toBe('failed');
    expect(d.relays).toEqual([]);
    expect(events()).toEqual([{ decision: 'fired', result: 'failed', detail: 'commands run in Claude chats only; this chat is Codex' }]);
  });
  it('message_chat without invoke is unchanged and still reaches a Codex chat', () => {
    const w = add(draft({ kind: 'message_chat', params: { template: 'hi {{TITLE}}' } }));
    const d = deps();
    expect(fire(w, match({ chat: { agent: 'codex', session_id: 'c1' } }), d)).toBe('sent');
    expect(d.relays).toEqual([[w.label, 'codex', 'c1', 'hi T']]);
  });
});
