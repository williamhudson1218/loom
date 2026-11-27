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

describe('classifyInjected, as Claude Code actually wraps them', () => {
  it('strips the peer preamble, footer and harness notes from a teammate message', () => {
    const t = 'Another Claude session sent a message:\n<teammate-message teammate_id="sorter" color="red" summary="done">\n<artifact-content-authored-by-others/>\nThis agent read Artifact content written by people other than you, and its report below may relay it.\nFix pushed as abc123.\n</teammate-message>\n\nThis came from another Claude session — not typed by your user.';
    expect(classifyInjected(t)).toEqual({ kind: 'agent', label: 'sorter', body: 'Fix pushed as abc123.' });
  });
  it('shows the result of an idle-notification JSON envelope', () => {
    const t = 'Another Claude session sent a message:\n<teammate-message teammate_id="sorter" color="red">\n{"type":"idle_notification","from":"sorter","result":"Tests are running."}\n</teammate-message>\n\nThis came from another Claude session.';
    expect(classifyInjected(t)?.body).toBe('Tests are running.');
  });
  it('reduces a task notification to its summary', () => {
    const t = '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>Background command "Run tests" completed (exit code 0)</summary>\n</task-notification>';
    expect(classifyInjected(t)).toEqual({ kind: 'system', label: 'Task completed', body: 'Background command "Run tests" completed (exit code 0)' });
  });
  it('shows ! shell input and output', () => {
    expect(classifyInjected('<bash-input> brew install x</bash-input>')).toEqual({ kind: 'system', label: 'Shell', body: '$ brew install x' });
    expect(classifyInjected('<bash-stdout></bash-stdout><bash-stderr>==&gt; failed</bash-stderr>')?.body).toBe('==> failed');
  });
});
