import type http from 'node:http';
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { createServer } from '../src/server.ts';
import { ensureCliToken, readCliToken } from '../src/routes/index.ts';
import { setSoundDeps } from '../src/routes/cli.ts';
import { SETTINGS, DEFAULT_QUIET_HOURS, type QuietHours } from '../src/settingsSchema.ts';
import {
  COALESCE_MS, REMINDER_MS, SETTLE_MS, SYSTEM_SOUND, SoundCoordinator, decideSound, inQuietHours, parseFocusLine, paneFocused,
  soundFile, soundsSilenced, type SoundCtx, type SoundDeps, type SoundEvent,
} from '../src/sounds.ts';

const NOQUIET: QuietHours = { enabled: false, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6] };
const ctx = (o: Partial<SoundCtx> = {}): SoundCtx => ({
  doneSound: 'Purr', blockedSound: 'Hero', minTurnS: 30, quiet: NOQUIET, mutedUntil: 0, background: false, focused: false, lastPlayedAt: 0, ...o,
});
const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime(); // a Wednesday, noon, local
const done = (turnS: number | undefined = 120, o: Partial<SoundEvent> = {}): SoundEvent => ({
  kind: 'done', session_id: 's1', pane: '%1', ...(turnS === undefined ? {} : { turn_started_at: NOW - turnS * 1000 }), ...o,
});
const blocked = (o: Partial<SoundEvent> = {}): SoundEvent => ({ kind: 'blocked', session_id: 's1', pane: '%1', ...o });
const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo, d, h, mi).getTime();

describe('decideSound', () => {
  it('plays the configured sound for a long finished turn', () => {
    expect(decideSound(done(), ctx(), NOW)).toEqual({ play: 'Purr', reason: 'ok' });
    expect(decideSound(blocked(), ctx(), NOW)).toEqual({ play: 'Hero', reason: 'ok' });
  });

  it('system means the system sound', () => {
    expect(decideSound(done(), ctx({ doneSound: 'system' }), NOW).play).toBe(SYSTEM_SOUND);
  });

  it('a kind set to off is silent, and only that kind', () => {
    expect(decideSound(done(), ctx({ doneSound: 'off' }), NOW)).toEqual({ play: null, reason: 'setting-off' });
    expect(decideSound(blocked(), ctx({ doneSound: 'off' }), NOW).play).toBe('Hero');
    expect(decideSound(blocked(), ctx({ blockedSound: 'off' }), NOW)).toEqual({ play: null, reason: 'setting-off' });
  });

  it('muted until a later time is silent; an expired mute is not', () => {
    expect(decideSound(done(), ctx({ mutedUntil: NOW + 1 }), NOW)).toEqual({ play: null, reason: 'muted' });
    expect(decideSound(done(), ctx({ mutedUntil: NOW }), NOW).play).toBe('Purr');
    expect(decideSound(blocked(), ctx({ mutedUntil: NOW + 60_000 }), NOW).reason).toBe('muted');
  });

  it('quiet hours are silent', () => {
    const q = { ...NOQUIET, enabled: true, start: '11:00', end: '13:00' };
    expect(decideSound(done(), ctx({ quiet: q }), NOW)).toEqual({ play: null, reason: 'quiet-hours' });
  });

  it('a background chat is silent', () => {
    expect(decideSound(done(), ctx({ background: true }), NOW)).toEqual({ play: null, reason: 'background' });
    expect(decideSound(blocked(), ctx({ background: true }), NOW).reason).toBe('background');
  });

  it('a chat you are looking at is silent', () => {
    expect(decideSound(done(), ctx({ focused: true }), NOW)).toEqual({ play: null, reason: 'focused' });
    expect(decideSound(blocked(), ctx({ focused: true }), NOW).reason).toBe('focused');
  });

  it('a short turn is silent, the threshold is inclusive, and a blocked sound ignores turn length', () => {
    expect(decideSound(done(10), ctx(), NOW)).toEqual({ play: null, reason: 'short-turn' });
    expect(decideSound(done(30), ctx(), NOW).play).toBe('Purr');
    expect(decideSound(done(29), ctx(), NOW).reason).toBe('short-turn');
    expect(decideSound(done(10), ctx({ minTurnS: 5 }), NOW).play).toBe('Purr');
    expect(decideSound(blocked({ turn_started_at: NOW - 1000 }), ctx(), NOW).play).toBe('Hero');
  });

  it('a turn of unknown length plays', () => {
    expect(decideSound(done(undefined), ctx(), NOW).play).toBe('Purr');
  });

  it('coalesces within five seconds of the last sound', () => {
    expect(decideSound(done(), ctx({ lastPlayedAt: NOW - COALESCE_MS + 1 }), NOW)).toEqual({ play: null, reason: 'coalesced' });
    expect(decideSound(done(), ctx({ lastPlayedAt: NOW - COALESCE_MS }), NOW).play).toBe('Purr');
  });

  it('a blocked chat is never swallowed by a finished one, but two blocks still coalesce', () => {
    const recent = NOW - 1000;
    expect(decideSound(blocked(), ctx({ lastPlayedAt: recent, lastPlayedKind: 'done' }), NOW).play).toBe('Hero');
    expect(decideSound(blocked(), ctx({ lastPlayedAt: recent, lastPlayedKind: 'blocked' }), NOW).reason).toBe('coalesced');
    expect(decideSound(done(), ctx({ lastPlayedAt: recent, lastPlayedKind: 'blocked' }), NOW).reason).toBe('coalesced');
  });

  it('rules run in order: off, then mute, then background, then focus', () => {
    const all = ctx({ doneSound: 'off', mutedUntil: NOW + 1, background: true, focused: true });
    expect(decideSound(done(), all, NOW).reason).toBe('setting-off');
    expect(decideSound(done(), { ...all, doneSound: 'Purr' }, NOW).reason).toBe('muted');
    expect(decideSound(done(), { ...all, doneSound: 'Purr', mutedUntil: 0 }, NOW).reason).toBe('background');
    expect(decideSound(done(), { ...all, doneSound: 'Purr', mutedUntil: 0, background: false }, NOW).reason).toBe('focused');
  });
});

describe('inQuietHours', () => {
  const q = (o: Partial<QuietHours>): QuietHours => ({ enabled: true, start: '22:00', end: '07:00', days: [0, 1, 2, 3, 4, 5, 6], ...o });
  // 2026-11-16 is a Monday, 2026-11-17 a Tuesday.
  it('is never on when disabled', () => {
    expect(inQuietHours(q({ enabled: false }), at(2026, 10, 16, 23, 0))).toBe(false);
  });
  it('a same-day window is [start, end)', () => {
    const w = q({ start: '09:00', end: '17:00' });
    expect(inQuietHours(w, at(2026, 10, 16, 8, 59))).toBe(false);
    expect(inQuietHours(w, at(2026, 10, 16, 9, 0))).toBe(true);
    expect(inQuietHours(w, at(2026, 10, 16, 16, 59))).toBe(true);
    expect(inQuietHours(w, at(2026, 10, 16, 17, 0))).toBe(false);
  });
  it('a window that wraps midnight covers both sides of it', () => {
    expect(inQuietHours(q({}), at(2026, 10, 16, 21, 59))).toBe(false);
    expect(inQuietHours(q({}), at(2026, 10, 16, 22, 0))).toBe(true);
    expect(inQuietHours(q({}), at(2026, 10, 16, 23, 59))).toBe(true);
    expect(inQuietHours(q({}), at(2026, 10, 17, 0, 0))).toBe(true);
    expect(inQuietHours(q({}), at(2026, 10, 17, 6, 59))).toBe(true);
    expect(inQuietHours(q({}), at(2026, 10, 17, 7, 0))).toBe(false);
  });
  it('days name the day the window starts on: the early hours belong to the evening before', () => {
    const monNight = q({ days: [1] });
    expect(inQuietHours(monNight, at(2026, 10, 16, 23, 0))).toBe(true); // Monday 23:00
    expect(inQuietHours(monNight, at(2026, 10, 17, 3, 0))).toBe(true); // Tuesday 03:00, still Monday's night
    expect(inQuietHours(monNight, at(2026, 10, 16, 3, 0))).toBe(false); // Monday 03:00 is Sunday's night
    expect(inQuietHours(monNight, at(2026, 10, 17, 23, 0))).toBe(false); // Tuesday 23:00
    expect(inQuietHours(q({ days: [0] }), at(2026, 10, 16, 3, 0))).toBe(true); // Sunday's night runs into Monday
  });
  it('an empty window (start = end) or no days is never quiet', () => {
    expect(inQuietHours(q({ start: '08:00', end: '08:00' }), at(2026, 10, 16, 8, 0))).toBe(false);
    expect(inQuietHours(q({ days: [] }), at(2026, 10, 16, 23, 0))).toBe(false);
  });
  it('soundsSilenced reports the mute before quiet hours', () => {
    const w = q({ start: '11:00', end: '13:00' });
    expect(soundsSilenced({ mutedUntil: NOW + 1, quiet: w }, NOW)).toBe('muted');
    expect(soundsSilenced({ mutedUntil: 0, quiet: w }, NOW)).toBe('quiet-hours');
    expect(soundsSilenced({ mutedUntil: 0, quiet: NOQUIET }, NOW)).toBeNull();
  });
});

describe('focus', () => {
  it('parses tmux’s pane_active window_active session_attached', () => {
    expect(parseFocusLine('1 1 1\n')).toBe(true);
    expect(parseFocusLine('1 1 2')).toBe(true);
    expect(parseFocusLine('0 1 1')).toBe(false);
    expect(parseFocusLine('1 0 1')).toBe(false);
    expect(parseFocusLine('1 1 0')).toBe(false);
    expect(parseFocusLine('')).toBe(false);
  });
  const run = (front: string | null, line: string, calls: string[][] = []) =>
    paneFocused('%3', { front: async () => front, tmux: (a) => (calls.push(a), line) });
  it('needs a terminal in front and the pane active in an attached window', async () => {
    expect(await run('com.mitchellh.ghostty', '1 1 1')).toBe(true);
    expect(await run('com.apple.Terminal', '1 1 1')).toBe(true);
    expect(await run('com.mitchellh.ghostty', '0 1 1')).toBe(false); // another pane of the window is active
    expect(await run('com.mitchellh.ghostty', '1 1 0')).toBe(false); // nobody attached
    expect(await run('com.google.Chrome', '1 1 1')).toBe(false); // looking at a browser
    expect(await run(null, '1 1 1')).toBe(false);
  });
  it('asks tmux about that pane only, and not at all when a browser is in front', async () => {
    const calls: string[][] = [];
    await run('com.mitchellh.ghostty', '1 1 1', calls);
    expect(calls[0].slice(0, 4)).toEqual(['display-message', '-p', '-t', '%3']);
    const none: string[][] = [];
    await run('com.google.Chrome', '1 1 1', none);
    expect(none).toEqual([]);
  });
  it('a missing pane or a tmux failure is not focus', async () => {
    expect(await paneFocused('', { front: async () => 'com.mitchellh.ghostty', tmux: () => '1 1 1' })).toBe(false);
    expect(await paneFocused('%1', { front: async () => 'com.mitchellh.ghostty', tmux: () => { throw new Error('no server'); } })).toBe(false);
  });
});

describe('soundFile', () => {
  it('refuses anything that is not a plain sound name', () => {
    expect(soundFile('off')).toBeNull();
    expect(soundFile('../../etc/passwd')).toBeNull();
    expect(soundFile('a b')).toBeNull();
    expect(soundFile('NoSuchSoundHere')).toBeNull();
  });
});

describe('the sound settings', () => {
  const def = (k: string) => SETTINGS.find((d) => d.key === k)!;
  it('quiet_hours validates its shape', () => {
    const v = def('quiet_hours').validate;
    expect(v(DEFAULT_QUIET_HOURS).ok).toBe(true);
    expect(v({ enabled: true, start: '23:30', end: '06:15', days: [5, 6, 5] })).toEqual({ ok: true, value: { enabled: true, start: '23:30', end: '06:15', days: [5, 6] } });
    for (const bad of [null, 'x', { ...DEFAULT_QUIET_HOURS, enabled: 'yes' }, { ...DEFAULT_QUIET_HOURS, start: '25:00' }, { ...DEFAULT_QUIET_HOURS, end: '7:00' }, { ...DEFAULT_QUIET_HOURS, days: [7] }, { ...DEFAULT_QUIET_HOURS, days: 'all' }]) {
      expect(v(bad).ok, JSON.stringify(bad)).toBe(false);
    }
  });
  it('defaults: Purr and Hero, 30 seconds, quiet hours off, not muted', () => {
    expect(def('sound_chat_done').defaultNew).toBe('Purr');
    expect(def('sound_chat_blocked').defaultNew).toBe('Hero');
    expect(def('sound_min_turn_s').defaultNew).toBe(30);
    expect(def('quiet_hours').defaultNew).toMatchObject({ enabled: false });
    expect(def('sounds_muted_until').defaultNew).toBe(0);
    expect(def('sounds_muted_until').internal).toBe(true);
  });
  it('a sound setting takes off, system or a mac sound only', () => {
    expect(def('sound_chat_done').validate('Glass').ok).toBe(true);
    expect(def('sound_chat_done').validate('off').ok).toBe(true);
    expect(def('sound_chat_done').validate('Boing').ok).toBe(false);
  });
});

/* ------------------------------------------------------------ the coordinator */

interface Rig {
  now: number;
  played: string[];
  timers: { at: number; fn: () => void; id: number; live: boolean }[];
  settings: Partial<SoundCtx>;
  background: boolean;
  focused: boolean;
  blockedStill: boolean;
  deps: SoundDeps;
  advance(ms: number): Promise<void>;
}

function rig(): Rig {
  const r: Rig = {
    now: NOW, played: [], timers: [], settings: {}, background: false, focused: false, blockedStill: true,
    deps: undefined as unknown as SoundDeps,
    async advance(ms) {
      const end = r.now + ms;
      for (;;) {
        const next = r.timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.live = false;
        r.now = next.at;
        next.fn();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
      r.now = end;
    },
  };
  let id = 0;
  r.deps = {
    settings: () => ({ doneSound: 'Purr', blockedSound: 'Hero', minTurnS: 30, quiet: NOQUIET, mutedUntil: 0, ...r.settings }),
    isBackground: () => r.background,
    isFocused: () => r.focused,
    stillBlocked: () => r.blockedStill,
    play: (n) => r.played.push(n),
    now: () => r.now,
    setTimer: (fn, ms) => {
      const t = { at: r.now + ms, fn, id: ++id, live: true };
      r.timers.push(t);
      return t.id;
    },
    clearTimer: (h) => {
      const t = r.timers.find((x) => x.id === h);
      if (t) t.live = false;
    },
  };
  return r;
}

describe('SoundCoordinator', () => {
  it('plays a done sound after the settle window', async () => {
    const r = rig();
    const c = new SoundCoordinator(r.deps);
    expect(await c.submit(done(120, { turn_started_at: r.now - 120_000 }))).toEqual({ play: 'Purr', reason: 'ok' });
    expect(r.played).toEqual([]);
    await r.advance(SETTLE_MS);
    expect(r.played).toEqual(['Purr']);
    c.stop();
  });

  it('blocked wins over done in the same window, whichever lands first', async () => {
    for (const order of [['done', 'blocked'], ['blocked', 'done']] as const) {
      const r = rig();
      const c = new SoundCoordinator(r.deps);
      for (const k of order) await c.submit(k === 'done' ? done(120, { turn_started_at: r.now - 120_000 }) : blocked());
      await r.advance(SETTLE_MS);
      expect(r.played, order.join()).toEqual(['Hero']);
      c.stop();
    }
  });

  it('plays at most one sound per five-second window', async () => {
    const r = rig();
    const c = new SoundCoordinator(r.deps);
    await c.submit(done(120, { turn_started_at: r.now - 120_000 }));
    await c.submit(done(120, { session_id: 's2', turn_started_at: r.now - 120_000 }));
    await r.advance(SETTLE_MS);
    expect(r.played).toEqual(['Purr']);
    const late = await c.submit(done(120, { session_id: 's3', turn_started_at: r.now - 120_000 }));
    expect(late.reason).toBe('coalesced');
    await r.advance(COALESCE_MS);
    await c.submit(done(120, { session_id: 's4', turn_started_at: r.now - 120_000 }));
    await r.advance(SETTLE_MS);
    expect(r.played).toEqual(['Purr', 'Purr']);
    c.stop();
  });

  it('a focused chat is silent and does not use up the window', async () => {
    const r = rig();
    r.focused = true;
    const c = new SoundCoordinator(r.deps);
    expect((await c.submit(done(120, { turn_started_at: r.now - 120_000 }))).reason).toBe('focused');
    r.focused = false;
    await c.submit(done(120, { turn_started_at: r.now - 120_000 }));
    await r.advance(SETTLE_MS);
    expect(r.played).toEqual(['Purr']);
    c.stop();
  });

  it('only asks about focus once everything cheaper has said yes', async () => {
    const r = rig();
    let asked = 0;
    r.deps.isFocused = () => (asked++, false);
    const c = new SoundCoordinator(r.deps);
    r.background = true;
    await c.submit(blocked());
    r.background = false;
    await c.submit(done(5, { turn_started_at: r.now - 5000 }));
    expect(asked).toBe(0);
    c.stop();
  });

  describe('the blocked reminder', () => {
    it('plays once more after ten minutes if the chat is still blocked, and never again', async () => {
      const r = rig();
      const c = new SoundCoordinator(r.deps);
      await c.submit(blocked());
      await r.advance(SETTLE_MS);
      expect(r.played).toEqual(['Hero']);
      await r.advance(REMINDER_MS);
      await r.advance(SETTLE_MS);
      expect(r.played).toEqual(['Hero', 'Hero']);
      await r.advance(REMINDER_MS * 3);
      expect(r.played).toEqual(['Hero', 'Hero']);
      c.stop();
    });

    it('a second blocked report for the same block does not restart or add a reminder', async () => {
      const r = rig();
      const c = new SoundCoordinator(r.deps);
      await c.submit(blocked());
      await r.advance(6_000);
      await c.submit(blocked());
      await r.advance(SETTLE_MS);
      await r.advance(REMINDER_MS);
      await r.advance(SETTLE_MS);
      expect(r.played).toEqual(['Hero', 'Hero']);
      c.stop();
    });

    it('stays quiet when the chat went back to working', async () => {
      const r = rig();
      const c = new SoundCoordinator(r.deps);
      await c.submit(blocked());
      await r.advance(SETTLE_MS);
      r.blockedStill = false;
      await r.advance(REMINDER_MS + SETTLE_MS);
      expect(r.played).toEqual(['Hero']);
      c.stop();
    });

    it('a finished turn ends the block', async () => {
      const r = rig();
      const c = new SoundCoordinator(r.deps);
      await c.submit(blocked());
      await r.advance(SETTLE_MS + 6_000);
      await c.submit(done(undefined, { turn_started_at: r.now - 5000 }));
      await r.advance(REMINDER_MS + SETTLE_MS);
      expect(r.played).toEqual(['Hero']);
      c.stop();
    });

    it('quiet hours, mute and focus still apply when the reminder fires', async () => {
      for (const [name, apply] of [
        ['muted', (r: Rig) => (r.settings.mutedUntil = r.now + 3_600_000)],
        ['quiet', (r: Rig) => (r.settings.quiet = { ...NOQUIET, enabled: true, start: '00:00', end: '23:59' })],
        ['focused', (r: Rig) => (r.focused = true)],
      ] as const) {
        const r = rig();
        const c = new SoundCoordinator(r.deps);
        await c.submit(blocked());
        await r.advance(SETTLE_MS);
        apply(r);
        await r.advance(REMINDER_MS);
        await r.advance(SETTLE_MS);
        expect(r.played, name).toEqual(['Hero']);
        c.stop();
      }
    });

    it('a block that was not played (focused) still gets its reminder if you walk away', async () => {
      const r = rig();
      r.focused = true;
      const c = new SoundCoordinator(r.deps);
      await c.submit(blocked());
      await r.advance(SETTLE_MS);
      expect(r.played).toEqual([]);
      r.focused = false;
      await r.advance(REMINDER_MS);
      await r.advance(SETTLE_MS);
      expect(r.played).toEqual(['Hero']);
      c.stop();
    });
  });
});

/* ------------------------------------------------------------ the route */

describe('POST /api/cli/sound-event', () => {
  let server: http.Server;
  let port = 0;
  const seen: SoundEvent[] = [];
  beforeAll(async () => {
    ensureCliToken();
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => {
    setSoundDeps(null);
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(() => {
    seen.length = 0;
    const r = rig();
    r.deps.isBackground = (ev) => (seen.push(ev), !ev.pane);
    setSoundDeps(r.deps);
  });
  afterEach(() => setSoundDeps(null));

  const post = async (body: unknown, headers: Record<string, string> = { 'x-loom-cli-token': readCliToken() }) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/cli/sound-event`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any };
  };

  it('needs the CLI token', async () => {
    expect((await post({ event: 'done', session_id: 's', pane: '%1' }, {})).status).toBe(403);
  });

  it('answers with the decision and passes the event through', async () => {
    const r = await post({ event: 'done', session_id: 's1', pane: '%4', turn_started_at: NOW });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true });
    expect(seen).toEqual([{ kind: 'done', session_id: 's1', pane: '%4', turn_started_at: NOW }]);
  });

  it('a chat outside tmux is background', async () => {
    expect((await post({ event: 'blocked', session_id: 's1', pane: '' })).body).toEqual({ ok: true, play: null, reason: 'background' });
  });

  it('rejects a bad event, pane or session', async () => {
    expect((await post({ event: 'loud', session_id: 's', pane: '%1' })).status).toBe(400);
    expect((await post({ event: 'done', session_id: 's', pane: 'main:1.0' })).status).toBe(400);
    expect((await post({ event: 'done', session_id: 'x'.repeat(300), pane: '%1' })).status).toBe(400);
  });
});
