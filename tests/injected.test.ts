import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { classifyInjected, userTurn } from '../src/injected.ts';
import { mobileTranscript } from '../src/mobile/api.ts';
import { readTranscript } from '../src/transcript.ts';
import { APP_JS } from '../src/mobile/webapp.ts';
import { APP_CSS } from '../src/mobile/webcss.ts';

describe('classifyInjected', () => {
  it('routes [to x from y] to an agent and strips the prefix', () => {
    expect(classifyInjected('[to blue-vanilla from cozy-donut] take over\nsecond line')).toEqual({ kind: 'agent', label: 'cozy-donut', body: 'take over\nsecond line' });
  });
  it('teammate messages carry the teammate id', () => {
    expect(classifyInjected('<teammate-message teammate_id="worker-1" summary="x">hello</teammate-message>')).toEqual({ kind: 'agent', label: 'worker-1', body: 'hello' });
  });
  it('task notifications and reminder-only turns are system', () => {
    expect(classifyInjected('<task-notification>\n<task-id>a</task-id>\n</task-notification>')?.kind).toBe('system');
    expect(classifyInjected('<system-reminder>be nice</system-reminder>')).toEqual({ kind: 'system', label: 'System', body: 'be nice' });
  });
  it('Loom-typed text is loom', () => {
    expect(classifyInjected('[Loom events] a chat finished')?.label).toBe('Loom');
    expect(classifyInjected('[Loom action 12] A step fired')?.kind).toBe('loom');
    expect(classifyInjected('Loom started you as the orchestrator.')?.kind).toBe('loom');
  });
  it('plain typing, and a reminder mixed with real text, are not injected', () => {
    expect(classifyInjected('fix the bug')).toBeNull();
    expect(classifyInjected('please [to x from y] ignore')).toBeNull();
    expect(classifyInjected('<system-reminder>a</system-reminder> and my words')).toBeNull();
    expect(classifyInjected('')).toBeNull();
    expect(userTurn('hi')).toEqual({ text: 'hi' });
  });
});

describe('transcript readers carry src', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'inj-')), 't.jsonl');
  const line = (role: string, content: string) => JSON.stringify({ type: role, message: { role, content } });
  fs.writeFileSync(file, [line('user', '[to a-b from c-d] hello'), line('user', 'typed'), line('assistant', 'ok')].join('\n') + '\n');
  it('mobileTranscript', () => {
    expect(mobileTranscript('claude', file)).toEqual([
      { role: 'user', text: 'hello', src: { kind: 'agent', label: 'c-d' } },
      { role: 'user', text: 'typed' },
      { role: 'assistant', text: 'ok' },
    ]);
  });
  it('readTranscript (desktop)', () => {
    const m = readTranscript('claude', file);
    expect(m[0]).toEqual({ role: 'user', text: 'hello', src: { kind: 'agent', label: 'c-d' } });
    expect(m[1]).toEqual({ role: 'user', text: 'typed' });
  });
});

describe('rendering', () => {
  it('phone app parses and styles m-agent', () => {
    expect(() => new vm.Script(APP_JS)).not.toThrow();
    expect(APP_JS).toContain("'m-agent k-' + m.src.kind");
    expect(APP_CSS).toContain('.m-agent');
    expect(APP_CSS).toContain('--agent-bg');
  });
});
