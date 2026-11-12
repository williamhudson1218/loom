import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { Breaker, bounded, breakerError, isTimeout } from '../src/synctimeout.ts';
import { tmuxBreaker, tmuxTimeoutFor, TMUX_START_TIMEOUT_MS, TMUX_TIMEOUT_MS, tmux, tmuxQuiet } from '../src/tmux.ts';

describe('bounded', () => {
  it('adds a timeout and SIGKILL, and keeps what the caller set', () => {
    expect(bounded({ encoding: 'utf-8' })).toEqual({ encoding: 'utf-8', timeout: 5000, killSignal: 'SIGKILL' });
    expect(bounded({ timeout: 1000 }, 9000)).toEqual({ timeout: 1000, killSignal: 'SIGKILL' });
    expect(bounded({}, 9000).timeout).toBe(9000);
  });

  it('a hung child is cut off and reads as a timeout', () => {
    const t = Date.now();
    let err: unknown;
    try {
      execFileSync('/bin/sleep', ['10'], bounded({}, 300));
    } catch (e) {
      err = e;
    }
    expect(isTimeout(err)).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('a non-zero exit is not a timeout', () => {
    let err: unknown;
    try {
      execFileSync('/usr/bin/false', [], bounded({ stdio: 'ignore' as const }));
    } catch (e) {
      err = e;
    }
    expect(isTimeout(err)).toBe(false);
  });
});

describe('Breaker', () => {
  it('opens for its cooldown and reports the first trip only', () => {
    const b = new Breaker(10_000);
    expect(b.isOpen(0)).toBe(false);
    expect(b.trip(0)).toBe(true);
    expect(b.isOpen(9_999)).toBe(true);
    expect(b.trip(5_000)).toBe(false);
    expect(b.isOpen(14_999)).toBe(true);
    expect(b.isOpen(15_000)).toBe(false);
  });

  it('its error looks like a timeout to callers', () => {
    expect(isTimeout(breakerError('tmux'))).toBe(true);
  });
});

describe('tmux timeouts', () => {
  it('starting a server gets the longer bound', () => {
    expect(tmuxTimeoutFor(['list-panes', '-a'])).toBe(TMUX_TIMEOUT_MS);
    expect(tmuxTimeoutFor(['new-session', '-d'])).toBe(TMUX_START_TIMEOUT_MS);
  });

  it('an open breaker fails tmux() at once and tmuxQuiet() silently', () => {
    tmuxBreaker.trip(Date.now());
    try {
      const t = Date.now();
      expect(() => tmux(['list-sessions'])).toThrow(/not answering/);
      expect(() => tmuxQuiet(['list-sessions'])).not.toThrow();
      expect(Date.now() - t).toBeLessThan(100);
    } finally {
      tmuxBreaker.reset();
    }
  });
});
