import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { correctionEntry, correctionsPath, insertEntry, isRealEdit, learnFromEdit } from '../src/voicelearn.ts';
import { readOutbox, sendDraft, slackPoster, type Draft } from '../src/outbox.ts';
import { SETTINGS_VIEW_JS } from '../src/settingsview.ts';
import { applyEvent } from '../src/events.ts';
import { openDb } from '../src/db.ts';
import { getSetting } from '../src/settingsSchema.ts';

const HEADER = [
  '# Voice corrections log',
  '',
  'Newest first. Each entry: what was drafted, what was sent or said instead, and the rule now.',
  '',
  'Format: `## YYYY-MM-DD — <where>: <lesson>`, then `Before:`, `After:` and `Note:` lines.',
  '',
  '---',
  '',
  '## 2026-01-01 — #general: older entry',
  'Before: "a"',
  'After: "b"',
  'Note: kept below',
  '',
].join('\n');

function skillsDir(files: Record<string, string> = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-voice-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

const AT = new Date(2026, 10, 17, 12).getTime();

describe('corrections append', () => {
  it('writes a dated before/after entry at the top, under the header', () => {
    const dir = skillsDir({ 'sam-voice/corrections.md': HEADER });
    const r = learnFromEdit({ enabled: true, skill: 'sam-voice', before: ['Happy to help! I think we should ship it.'], after: ['lets ship it'], where: '#eng', at: AT, skillsDir: dir });
    expect(r.written).toBe(true);
    const out = fs.readFileSync(path.join(dir, 'sam-voice/corrections.md'), 'utf8');
    const lines = out.split('\n');
    const sep = lines.indexOf('---');
    expect(lines.slice(sep + 1, sep + 6)).toEqual([
      '',
      '## 2026-11-17 — #eng: edited before sending',
      'Before: "Happy to help! I think we should ship it."',
      'After: "lets ship it"',
      'Note: recorded from an Outbox edit; add the lesson when you next tune.',
    ]);
    // The older entry is still there, below the new one.
    expect(out.indexOf('older entry')).toBeGreaterThan(out.indexOf('edited before sending'));
    expect(out.startsWith('# Voice corrections log')).toBe(true);
  });

  it('joins a burst and flattens newlines', () => {
    expect(correctionEntry({ before: ['one\n\ntwo', 'three'], after: ['x'], where: '', at: AT })).toContain('Before: "one / two" + "three"');
    expect(correctionEntry({ before: ['a'], after: ['b'], where: '', at: AT })).toContain('— Outbox: edited');
  });

  it('skips whitespace-only edits', () => {
    expect(isRealEdit(['hello  there\n'], ['hello there'])).toBe(false);
    const dir = skillsDir({ 'sam-voice/corrections.md': HEADER });
    const r = learnFromEdit({ enabled: true, skill: 'sam-voice', before: ['hello  there'], after: [' hello there\n'], where: '#eng', at: AT, skillsDir: dir });
    expect(r).toMatchObject({ written: false, reason: 'no real edit' });
    expect(fs.readFileSync(path.join(dir, 'sam-voice/corrections.md'), 'utf8')).toBe(HEADER);
  });

  it('skips a missing corrections.md, an empty voice skill, a plugin skill and the setting off', () => {
    const dir = skillsDir({ 'sam-voice/SKILL.md': '# x' });
    const base = { before: ['a'], after: ['b'], where: '#eng', at: AT, skillsDir: dir };
    expect(learnFromEdit({ ...base, enabled: true, skill: 'sam-voice' })).toMatchObject({ written: false, reason: 'no corrections.md' });
    expect(fs.existsSync(path.join(dir, 'sam-voice/corrections.md'))).toBe(false);
    expect(learnFromEdit({ ...base, enabled: true, skill: '' })).toMatchObject({ written: false, reason: 'no voice skill' });
    expect(correctionsPath('loom:voice', dir)).toBeNull();
    expect(correctionsPath('../etc', dir)).toBeNull();
    expect(learnFromEdit({ ...base, enabled: false, skill: 'sam-voice' })).toMatchObject({ written: false, reason: 'off' });
  });

  it('inserts under the title paragraph when there is no --- line', () => {
    const out = insertEntry('# Log\n\nNewest first.\n\n## 2026-01-01 — x: old\nBefore: "a"\n', 'NEW\n');
    expect(out).toBe('# Log\n\nNewest first.\n\nNEW\n\n## 2026-01-01 — x: old\nBefore: "a"\n');
  });
});

describe('sendDraft reports what was sent against what Claude drafted', () => {
  it('passes the stored draft and the edited text to onSent after a full send', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-'));
    const file = path.join(dir, 'outbox.json');
    fs.writeFileSync(file, JSON.stringify({ drafts: { x: { id: 'x', session_id: 's1', channel: 'C0TESTOUT01', created_at: '2026-11-17T09:00:00', status: 'pending', messages: ['Claude wrote this'] } } }));
    let n = 0;
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const method = String(url).replace('https://slack.com/api/', '').split('?')[0];
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const out = method === 'chat.postMessage' ? { ok: true, channel: body.channel, ts: `1793990000.00000${++n}` } : { ok: true, permalink: 'https://acme.slack.com/archives/C0TESTOUT01/p1793990000000001' };
      return { status: 200, headers: new Headers(), json: async () => out } as Response;
    }) as typeof fetch;
    const seen: { before: string[]; after: string[] }[] = [];
    const r = await sendDraft('x', ['i wrote this'], {
      file,
      slack: { ...slackPoster({ token: 'xoxp-test-token', fetchImpl }), sleep: async () => {} },
      onSent: (d: Draft, sent: string[]) => seen.push({ before: d.messages, after: sent }),
    });
    expect(r.ok).toBe(true);
    expect(seen).toEqual([{ before: ['Claude wrote this'], after: ['i wrote this'] }]);
    expect(readOutbox(file).x.status).toBe('sent');
  });
});

/** The page's own button-state function, run as the page would. */
function voiceTune(sl: unknown): [boolean, string] {
  const src = /function sxVoiceTune\(sl\)\{[\s\S]*?\n {2}return \[false,[^\n]*\}/.exec(SETTINGS_VIEW_JS)?.[0];
  if (!src) throw new Error('sxVoiceTune not found in the settings page');
  return vm.runInNewContext(src + ';sxVoiceTune(SL)', { SL: sl }) as [boolean, string];
}

describe('Settings: Tune my voice button', () => {
  it('is on with a Loom token that can search, or with the Claude connector', () => {
    expect(voiceTune({ ok: true, mode: 'direct', scopes: { missing: [] } })[0]).toBe(true);
    expect(voiceTune({ ok: true, mode: 'mcp' })[0]).toBe(true);
  });

  it('is off, with a plain reason, when Slack is not connected and no connector is set up', () => {
    const [on, why] = voiceTune({ ok: true, mode: 'off', connected: false });
    expect(on).toBe(false);
    expect(why).toMatch(/not connected/);
  });

  it('asks for a reconnect when the token lacks search:read', () => {
    const [on, why] = voiceTune({ ok: true, mode: 'direct', scopes: { missing: ['search:read'] } });
    expect(on).toBe(false);
    expect(why).toMatch(/Reconnect Slack/);
  });

  it('waits while the status loads, and starts the voice-tuning skill', () => {
    expect(voiceTune(undefined)[0]).toBe(false);
    expect(SETTINGS_VIEW_JS).toContain("openComposer({prompt:'/loom:voice-tuning'})");
    expect(SETTINGS_VIEW_JS).toContain("'voice_learn_from_edits'");
  });

  it('states where the messages go, under the button and in the learn-from-edits help', () => {
    expect(SETTINGS_VIEW_JS).toContain('Reads your own recent Slack messages through your Slack connection, on this computer. Your Claude session analyzes them like any chat. The voice skill is saved in ~/.claude/skills. Nothing is sent to Loom or anyone else, and nothing is posted to Slack.');
    expect(SETTINGS_VIEW_JS).toContain('sxNote(sxEsc(SX_VOICE_PRIVACY))');
    expect(SETTINGS_VIEW_JS).toMatch(/Learn from Outbox edits[^}]*locally to your voice skill’s corrections file/);
  });
});

describe('setting.set event (loom settings set)', () => {
  it('sets voice_skill and refuses any other key', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-db-'));
    const db = openDb(path.join(home, 'manager.db'));
    try {
      expect(applyEvent(db, { kind: 'setting.set', key: 'voice_skill', value: 'sam-voice' })).toMatchObject({ ok: true });
      expect(getSetting(db, 'voice_skill')).toBe('sam-voice');
      expect(applyEvent(db, { kind: 'setting.set', key: 'perm_chats', value: 'skip' })).toMatchObject({ ok: false });
      expect(getSetting(db, 'perm_chats')).not.toBe('skip');
      expect(applyEvent(db, { kind: 'setting.set', key: 'voice_skill', value: 'bad name!' })).toMatchObject({ ok: false });
      expect(getSetting(db, 'voice_learn_from_edits')).toBe(true);
    } finally {
      db.close();
    }
  });
});
