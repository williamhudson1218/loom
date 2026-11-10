import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { channelOnly, formatLine, newPressId, PickLog } from '../src/picklog.ts';

const dirs: string[] = [];
function tmp(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'picklog-'));
  dirs.push(d);
  return path.join(d, 'pick.log');
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const AT = new Date('2026-11-10T20:00:00.123Z');

describe('formatLine', () => {
  it('is one line: time, press id, event, then key=value fields', () => {
    expect(formatLine(AT, 'p1', 'mousedown', { x: 120, y: -40, ipc_ms: 3.456, ok: true, phase: 'picking' })).toBe(
      '2026-11-10T20:00:00.123Z p1 mousedown x=120 y=-40 ipc_ms=3.5 ok=1 phase=picking\n',
    );
  });
  it('never writes message text, authors, context or prompts, whatever the caller passes', () => {
    const line = formatLine(AT, 'p1', 'hit', { text: 'secret plan', author: 'Alex', context: 'ctx', prompt: 'p', Title: 't', ok: true });
    expect(line).not.toMatch(/secret|Alex|ctx|title/i);
    expect(line).toContain('ok=1');
  });
  it('reduces a Slack link to its channel id', () => {
    const line = formatLine(AT, 'p1', 'goto-start', { channel: 'https://acme.slack.com/archives/C0ABC123/p1731270000123456?thread_ts=1.2' });
    expect(line).toContain('channel=C0ABC123');
    expect(line).not.toContain('p1731270000123456');
    expect(channelOnly('not a link')).toBe('');
  });
  it('keeps a value to one token, and caps it', () => {
    const line = formatLine(AT, 'p1', 'end', { reason: 'two words\nand a line', long: 'x'.repeat(500) });
    expect(line.trimEnd().split('\n')).toHaveLength(1);
    expect(line).toContain('reason=two_words_and_a_line');
    expect(line.length).toBeLessThan(220);
  });
  it('skips undefined fields', () => {
    expect(formatLine(AT, '', 'press', { act: 'open', t: undefined })).toBe('2026-11-10T20:00:00.123Z - press act=open\n');
  });
});

describe('PickLog', () => {
  it('appends', () => {
    const file = tmp();
    const log = new PickLog({ file, now: () => AT });
    log.write('p1', 'press');
    log.write('p1', 'shown', { d: 0 });
    expect(fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean)).toEqual(['2026-11-10T20:00:00.123Z p1 press', '2026-11-10T20:00:00.123Z p1 shown d=0']);
  });
  it('rotates to .1 once past the cap, keeping one old generation', () => {
    const file = tmp();
    const log = new PickLog({ file, maxBytes: 200, now: () => AT });
    for (let i = 0; i < 20; i++) log.write('p' + i, 'press', { i });
    expect(fs.statSync(file).size).toBeLessThanOrEqual(200);
    expect(fs.existsSync(file + '.1')).toBe(true);
    expect(fs.statSync(file + '.1').size).toBeLessThanOrEqual(200);
    expect(fs.readFileSync(file, 'utf-8')).toContain('p19 press i=19');
    expect(fs.existsSync(file + '.2')).toBe(false);
  });
  it('picks up an existing file size, so a restart still rotates', () => {
    const file = tmp();
    fs.writeFileSync(file, 'x'.repeat(190) + '\n');
    new PickLog({ file, maxBytes: 200, now: () => AT }).write('p1', 'press');
    expect(fs.readFileSync(file + '.1', 'utf-8')).toMatch(/^x+\n$/);
    expect(fs.readFileSync(file, 'utf-8')).toContain('p1 press');
  });
  it('never throws when the file cannot be written', () => {
    const dir = path.dirname(tmp());
    expect(() => new PickLog({ file: dir }).write('p1', 'press')).not.toThrow(); // a directory, not a file
  });
});

describe('newPressId', () => {
  it('is short and differs press to press', () => {
    const a = newPressId();
    const b = newPressId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^p[a-z0-9]{7}$/);
  });
});
