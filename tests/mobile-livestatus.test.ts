import { describe, expect, it } from 'vitest';
import { elapsedSeconds, paneLiveStatus, parseLiveStatus, parseSpinnerLine } from '../src/mobile/livestatus.ts';

const NOW = 1_000_000_000;

describe('parseSpinnerLine', () => {
  it('cleans Claude Code spinner lines', () => {
    const cases: [string, string, number][] = [
      ['✻ Cogitating… (12s · ↓ 340 tokens · esc to interrupt)', 'Cogitating… 12s · 340 tokens', 12],
      ['✳ Waddling… (8s · ↓ 203 tokens · thinking)', 'Waddling… 8s · 203 tokens · thinking', 8],
      ['· Waddling… (3s · ↓ 102 tokens · thought for 1s)', 'Waddling… 3s · 102 tokens', 3],
      ['✢ Waddling… (13s · ↓ 690 tokens)', 'Waddling… 13s · 690 tokens', 13],
      ['✽ Running stop hooks… (1m 8s · ↑ 2.1k tokens · esc to interrupt)', 'Running stop hooks… 1m 8s · 2.1k tokens', 68],
      ['* Pondering… (2h 3m · esc to interrupt · ctrl+t to hide todos)', 'Pondering… 2h 3m', 7380],
      ['✶ Thinking… (45s)', 'Thinking… 45s', 45],
    ];
    for (const [line, text, secs] of cases) expect(parseSpinnerLine(line, NOW), line).toEqual({ text, since: NOW - secs * 1000 });
  });

  it('ignores finished turns, tool lines and prose', () => {
    for (const line of [
      '✻ Cooked for 25s · done 11:42 PM',
      '✻ Cooked for 1m 59s · done 11:14 PM',
      '⏺ Bash(yarn vitest run)',
      '  ⎿  Running… (3s)',
      'The tests are running… (see below)',
      '> Thinking… (12s)',
      '  -- INSERT -- ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ])
      expect(parseSpinnerLine(line, NOW), line).toBeNull();
  });

  it('adds up elapsed times', () => {
    expect(elapsedSeconds('12s')).toBe(12);
    expect(elapsedSeconds('1m 8s')).toBe(68);
    expect(elapsedSeconds('2h 3m')).toBe(7380);
  });
});

describe('parseLiveStatus', () => {
  const screen = [
    '⏺ Running the test suite.',
    '',
    '⏺ Bash(yarn vitest run)',
    '  ⎿  Running…',
    '',
    '✳ Waddling… (14s · ↓ 706 tokens · thinking)',
    '',
    '╭──────────────╮',
    '│ >            │',
    '╰──────────────╯',
    '  -- INSERT -- ⏵⏵ bypass permissions on · 2 background tasks',
  ].join('\n');

  it('finds the spinner above the prompt box', () => {
    expect(parseLiveStatus(screen, NOW)).toEqual({ text: 'Waddling… 14s · 706 tokens · thinking', since: NOW - 14_000 });
  });

  it('is null for an idle pane and for a spinner scrolled out of the tail', () => {
    expect(parseLiveStatus('✻ Cooked for 9s · done 8:58 PM\n\n> \n', NOW)).toBeNull();
    const old = '✳ Waddling… (14s)\n' + Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    expect(parseLiveStatus(old, NOW)).toBeNull();
  });

  it('captures only a real pane id and swallows tmux failures', () => {
    const calls: string[][] = [];
    const tmux = (a: string[]) => {
      calls.push(a);
      return screen;
    };
    expect(paneLiveStatus(tmux, '%12', NOW)?.text).toBe('Waddling… 14s · 706 tokens · thinking');
    expect(calls).toEqual([['capture-pane', '-p', '-t', '%12']]);
    expect(paneLiveStatus(tmux, 'loom-x:1.0', NOW)).toBeNull();
    expect(paneLiveStatus(() => { throw new Error('no server'); }, '%1', NOW)).toBeNull();
  });
});
