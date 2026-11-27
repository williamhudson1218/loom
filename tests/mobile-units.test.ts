import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPublicKey, verify } from 'node:crypto';
import { CODE_ALPHABET, CODE_TTL_MS, DeviceStore, PENDING_TTL_MS, cleanName, deviceCookie, formatCode } from '../src/mobile/devices.ts';
import { encryptPayload, generateVapidKeys, loadVapidKeys, sendPush, validSubscription, vapidAuthorization } from '../src/mobile/webpush.ts';
import { applyServe, clearLeftoverServe, serveIsLoomOnly, tailscaleStatus, type TailscaleDeps } from '../src/mobile/tailscale.ts';
import { DraftWatch, PushDispatcher, chatEventPush, inPushQuiet, parseHidIdle, type PushDeps } from '../src/mobile/push-triggers.ts';
import { draftKind, draftUrl, statusOf, paneTopics, isClaudeCommand, mobileTranscript, outboxPayload, sessionsPayload, toolLine, type MobileChat } from '../src/mobile/api.ts';
import type { Device } from '../src/mobile/devices.ts';
import type { Draft } from '../src/outbox.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-mobile-u-'));

describe('DeviceStore pairing', () => {
  const mk = () => {
    let now = 1_000_000;
    const s = new DeviceStore({ file: path.join(tmp(), 'devices.json'), now: () => now });
    return { s, tick: (ms: number) => (now += ms) };
  };

  it('makes 8-character codes from the unambiguous alphabet, one live at a time', () => {
    const { s } = mk();
    const a = s.startPairing();
    expect(a.code).toMatch(new RegExp(`^[${CODE_ALPHABET}]{8}$`));
    expect(formatCode(a.code)).toMatch(/^.{4}-.{4}$/);
    const b = s.startPairing();
    expect(s.liveCode()?.code).toBe(b.code);
    if (a.code !== b.code) expect(s.requestPairing(a.code, 'x').ok).toBe(false);
  });

  it('expires the code after five minutes and pending requests after ten', () => {
    const { s, tick } = mk();
    const c = s.startPairing();
    tick(CODE_TTL_MS);
    expect(s.requestPairing(c.code, 'late')).toMatchObject({ ok: false, status: 400 });
    const c2 = s.startPairing();
    const r = s.requestPairing(formatCode(c2.code).toLowerCase(), 'phone');
    expect(r.ok).toBe(true);
    expect(s.pendingRequests().length).toBe(1);
    tick(PENDING_TTL_MS);
    expect(s.pendingRequests()).toEqual([]);
    if (r.ok) expect(s.pairStatus(r.pending_id, r.claim).state).toBe('expired');
  });

  it('a correct code is used up, so a second phone cannot ride it', () => {
    const { s } = mk();
    const c = s.startPairing();
    expect(s.requestPairing(c.code, 'one').ok).toBe(true);
    expect(s.requestPairing(c.code, 'two').ok).toBe(false);
  });

  it('only approval mints a device, and a revoke before collection means no cookie', () => {
    const { s } = mk();
    const c = s.startPairing();
    const r = s.requestPairing(c.code, 'phone');
    if (!r.ok) throw new Error('pair');
    expect(s.devices()).toEqual([]);
    const dev = s.approve(r.pending_id)!;
    expect(s.devices().length).toBe(1);
    s.revoke(dev.id);
    expect(s.pairStatus(r.pending_id, r.claim).state).toBe('expired');
  });

  it('verifies cookies by hash and touches last_seen at most once a minute', () => {
    const { s, tick } = mk();
    const r = s.requestPairing(s.startPairing().code, 'p');
    if (!r.ok) throw new Error('pair');
    s.approve(r.pending_id);
    const { cookie } = s.pairStatus(r.pending_id, r.claim);
    const dev = s.verify(cookie)!;
    expect(dev.name).toBe('p');
    expect(s.verify(cookie!.slice(0, -1) + (cookie!.endsWith('A') ? 'B' : 'A'))).toBeNull();
    const seen = dev.last_seen_at;
    tick(30_000);
    s.touch(dev.id);
    expect(s.get(dev.id)!.last_seen_at).toBe(seen);
    tick(31_000);
    s.touch(dev.id);
    expect(s.get(dev.id)!.last_seen_at).toBeGreaterThan(seen);
  });

  it('reads a corrupt file as no devices (fails closed)', () => {
    const file = path.join(tmp(), 'devices.json');
    fs.writeFileSync(file, '{not json');
    expect(new DeviceStore({ file }).devices()).toEqual([]);
    expect(new DeviceStore({ file }).verify('0123456789abcdef.' + 'A'.repeat(43))).toBeNull();
  });

  it('cleans names and parses the cookie header', () => {
    expect(cleanName('  <b>My\u0000 phone</b> ')).toBe('bMy phone/b');
    expect(cleanName('')).toBe('Phone');
    expect(cleanName('x'.repeat(99)).length).toBe(40);
    expect(deviceCookie('a=1; loom_device=abc.def; b=2')).toBe('abc.def');
    expect(deviceCookie(undefined)).toBeNull();
  });
});

describe('Web Push encryption (RFC 8291)', () => {
  it('matches the Appendix A test vector byte for byte', () => {
    const out = encryptPayload(
      'When I grow up, I want to be a watermelon',
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'), asPrivate: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url') },
    );
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('signs a VAPID JWT the public key verifies, with a generic subject and the endpoint origin as aud', () => {
    const k = generateVapidKeys();
    const auth = vapidAuthorization('https://web.push.apple.com/abc', k, 1_700_000_000_000);
    const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(auth)!;
    expect(m[4]).toBe(k.publicKey);
    const claims = JSON.parse(Buffer.from(m[2], 'base64url').toString());
    expect(claims).toEqual({ aud: 'https://web.push.apple.com', exp: 1_700_000_000 + 12 * 3600, sub: 'https://localhost' });
    const pub = Buffer.from(k.publicKey, 'base64url');
    const key = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${m[1]}.${m[2]}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(m[3], 'base64url'))).toBe(true);
  });

  it('keeps the VAPID keypair 0600 and stable', () => {
    const file = path.join(tmp(), 'vapid.json');
    const a = loadVapidKeys(file);
    expect(loadVapidKeys(file)).toEqual(a);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('accepts only https subscriptions on the known push services', () => {
    const keys = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
    for (const ok of ['https://web.push.apple.com/x', 'https://fcm.googleapis.com/fcm/send/x', 'https://updates.push.services.mozilla.com/x', 'https://wns2-par02p.notify.windows.com/x']) {
      expect(validSubscription({ endpoint: ok, keys }), ok).not.toBeNull();
    }
    for (const bad of ['http://web.push.apple.com/x', 'https://evil.example/x', 'https://push.apple.com.evil.example/x', 'https://evilpush.apple.com/x', 'https://localhost/x', 'https://u:p@web.push.apple.com/x', 'https://web.push.apple.com:8443/x']) {
      expect(validSubscription({ endpoint: bad, keys }), bad).toBeNull();
    }
    expect(validSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'AAAA', auth: keys.auth } })).toBeNull();
  });

  it('sends with the aes128gcm headers', async () => {
    const calls: { url: string; headers: Record<string, string>; body: Buffer }[] = [];
    const sub = validSubscription({ endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' } })!;
    const status = await sendPush(sub, { title: 't', body: 'b', url: '/m/', tag: 'x' }, generateVapidKeys(), async (url, init) => {
      calls.push({ url, headers: init.headers, body: init.body });
      return { status: 201 };
    });
    expect(status).toBe(201);
    expect(calls[0].headers['content-encoding']).toBe('aes128gcm');
    expect(calls[0].headers.authorization).toMatch(/^vapid t=/);
    expect(calls[0].body.readUInt32BE(16)).toBe(4096);
  });
});

describe('tailscale serve control', () => {
  const fake = (over: { exists?: boolean; status?: string; serveCode?: number } = {}) => {
    const runs: string[][] = [];
    const deps: TailscaleDeps = {
      exists: (f) => (over.exists ?? true) && f === '/opt/homebrew/bin/tailscale',
      run: async (_bin, args) => {
        runs.push(args);
        if (args[0] === 'status') return { code: 0, stdout: over.status ?? JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'mac.example-tailnet.ts.net.' } }), stderr: '' };
        return { code: over.serveCode ?? 0, stdout: '', stderr: over.serveCode ? 'serve: permission denied' : '' };
      },
    };
    return { deps, runs };
  };

  it('degrades to no-tailscale, logged-out, error without throwing', async () => {
    expect(await tailscaleStatus(fake({ exists: false }).deps)).toMatchObject({ ok: false, state: 'no-tailscale' });
    expect(await tailscaleStatus(fake({ status: JSON.stringify({ BackendState: 'NeedsLogin' }) }).deps)).toMatchObject({ ok: false, state: 'logged-out' });
    expect(await tailscaleStatus(fake({ status: 'garbage' }).deps)).toMatchObject({ ok: false, state: 'error' });
    expect(await tailscaleStatus(fake({ status: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'evil.example.' } }) }).deps)).toMatchObject({ ok: false, state: 'error' });
    expect((await applyServe(true, 4317, fake({ exists: false }).deps)).access).toMatchObject({ on: true, state: 'no-tailscale' });
  });

  it('serves the loopback port over 443, never funnel, and turns it off', async () => {
    const f = fake();
    expect(await applyServe(true, 4318, f.deps)).toEqual({ access: { on: true, state: 'on', url: 'https://mac.example-tailnet.ts.net/m/' }, host: 'mac.example-tailnet.ts.net' });
    expect(f.runs[1]).toEqual(['serve', '--bg', '--https=443', 'http://127.0.0.1:4318']);
    await applyServe(false, 4318, f.deps);
    expect(f.runs[3]).toEqual(['serve', '--https=443', 'off']);
    expect(f.runs.flat().some((a) => /funnel/i.test(a))).toBe(false);
    expect((await applyServe(true, 4318, fake({ serveCode: 1 }).deps)).access).toMatchObject({ state: 'error', detail: 'serve: permission denied' });
  });
});

describe('leftover serve at startup (Phone access off)', () => {
  const ports = [4317, 4318];
  const web = (handlers: Record<string, { Proxy?: string; Path?: string }>, hostPort = 'mac.example-tailnet.ts.net:443') => JSON.stringify({ TCP: { '443': { HTTPS: true } }, Web: { [hostPort]: { Handlers: handlers } } });
  const fake = (status: string, exists = true) => {
    const runs: string[][] = [];
    const deps: TailscaleDeps = {
      exists: (f) => exists && f === '/opt/homebrew/bin/tailscale',
      run: async (_b, args) => {
        runs.push(args);
        return { code: 0, stdout: args[1] === 'status' ? status : '', stderr: '' };
      },
    };
    return { deps, runs };
  };

  it('turns off 443 when it proxies only to a Loom port', async () => {
    const f = fake(web({ '/': { Proxy: 'http://127.0.0.1:4318' } }));
    expect(await clearLeftoverServe(ports, f.deps)).toBe(true);
    expect(f.runs).toEqual([['serve', 'status', '--json'], ['serve', '--https=443', 'off']]);
  });

  it('leaves every other serve config alone', async () => {
    const others = [
      web({ '/': { Proxy: 'http://127.0.0.1:3000' } }),
      web({ '/': { Proxy: 'http://127.0.0.1:4317' }, '/grafana': { Proxy: 'http://127.0.0.1:3000' } }),
      web({ '/': { Path: '/srv/www' } }),
      web({ '/': { Proxy: 'http://127.0.0.1:4317' } }, 'mac.example-tailnet.ts.net:8443'),
      web({ '/': { Proxy: 'http://localhost.evil:4317' } }),
      JSON.stringify({ TCP: { '443': { TCPForward: '127.0.0.1:4317' } } }),
      '{}',
      'not json',
    ];
    for (const st of others) {
      const f = fake(st);
      expect(await clearLeftoverServe(ports, f.deps), st).toBe(false);
      expect(f.runs, st).toEqual([['serve', 'status', '--json']]);
    }
    expect(serveIsLoomOnly(web({ '/': { Proxy: 'http://127.0.0.1:4317/' } }), ports)).toBe(true);
  });

  it('does nothing without tailscale', async () => {
    const f = fake('', false);
    expect(await clearLeftoverServe(ports, f.deps)).toBe(false);
    expect(f.runs).toEqual([]);
  });
});

describe('push dispatch', () => {
  const sub = { endpoint: 'https://web.push.apple.com/a', keys: { p256dh: 'x', auth: 'y' } };
  const dev = (id: string, prefs: Partial<Device['prefs']> = {}, push = true): Device => ({ id, name: id, hash: '', created_at: 0, last_seen_at: 0, prefs: { turn: true, blocked: true, drafts: true, watcher: false, away: false, quiet: false, ...prefs }, ...(push ? { push: { ...sub, endpoint: sub.endpoint + id } } : {}) });
  const mk = (devices: Device[], o: { idle?: number | null; status?: number; now?: number } = {}) => {
    const sends: string[] = [];
    const dropped: string[] = [];
    let now = o.now ?? new Date(2026, 0, 5, 12, 0).getTime();
    const deps: PushDeps = {
      devices: () => devices,
      vapid: () => generateVapidKeys(),
      send: async (s) => {
        sends.push(s.endpoint);
        return o.status ?? 201;
      },
      dropEndpoint: (e) => dropped.push(e),
      hidIdleMs: async () => (o.idle === undefined ? 999_999 : o.idle),
      now: () => now,
    };
    return { d: new PushDispatcher(deps), sends, dropped, tick: (ms: number) => (now += ms) };
  };
  const ev = (kind: 'turn' | 'blocked' | 'draft' | 'watcher') => ({ kind, title: 't', body: 'b', url: '/m/', tag: 'x' });

  it('follows per-device prefs and skips devices without a subscription', async () => {
    const { d } = mk([dev('a'), dev('b', { turn: false }), dev('c', {}, false)]);
    const r = await d.dispatch(ev('turn'));
    expect(r.sent).toEqual(['a']);
    expect(r.skipped).toEqual({ b: 'pref-off', c: 'no-subscription' });
    expect((await mk([dev('w')]).d.dispatch(ev('watcher'))).skipped.w).toBe('pref-off');
  });

  it('away: skips while the Mac is in use; quiet: 22-07 except blocked', async () => {
    expect((await mk([dev('a', { away: true })], { idle: 5_000 }).d.dispatch(ev('turn'))).skipped.a).toBe('at-mac');
    expect((await mk([dev('a', { away: true })], { idle: 600_000 }).d.dispatch(ev('turn'))).sent).toEqual(['a']);
    const night = new Date(2026, 0, 5, 23, 30).getTime();
    expect(inPushQuiet(night)).toBe(true);
    expect((await mk([dev('a', { quiet: true })], { now: night }).d.dispatch(ev('turn'))).skipped.a).toBe('quiet');
    expect((await mk([dev('a', { quiet: true })], { now: night }).d.dispatch(ev('blocked'))).sent).toEqual(['a']);
  });

  it('coalesces within 5 s unless a block follows a non-block, and drops gone subscriptions', async () => {
    const m = mk([dev('a')]);
    await m.d.dispatch(ev('turn'));
    expect((await m.d.dispatch(ev('draft'))).skipped.a).toBe('coalesced');
    expect((await m.d.dispatch(ev('blocked'))).sent).toEqual(['a']);
    m.tick(6000);
    expect((await m.d.dispatch(ev('turn'))).sent).toEqual(['a']);
    const g = mk([dev('a')], { status: 410 });
    expect((await g.d.dispatch(ev('turn'))).skipped.a).toBe('gone');
    expect(g.dropped).toEqual([sub.endpoint + 'a']);
  });

  it('parses HIDIdleTime', () => {
    expect(parseHidIdle('  |   "HIDIdleTime" = 123456789000\n')).toBe(123456);
    expect(parseHidIdle('nothing')).toBeNull();
  });
});

describe('push triggers', () => {
  const tdeps = { chat: (sid: string) => (sid === 's1' ? { key: 'claude:s1', topic: 'Fix the widget', name: 'blue-vanilla', line: 'Ready to ship?' } : null), minTurnS: () => 20, now: () => 100_000 };

  it('suppresses background chats, reminders, short turns and chats that are not live', () => {
    expect(chatEventPush({ kind: 'done', session_id: 's1', pane: '%1' }, true, tdeps)).toBeNull();
    expect(chatEventPush({ kind: 'blocked', session_id: 's1', pane: '%1', reminder: true }, false, tdeps)).toBeNull();
    expect(chatEventPush({ kind: 'done', session_id: 's1', pane: '%1', turn_started_at: 95_000 }, false, tdeps)).toBeNull();
    expect(chatEventPush({ kind: 'done', session_id: 'gone', pane: '%1' }, false, tdeps)).toBeNull();
  });

  it('builds the payload: title, name · line, deep link', () => {
    expect(chatEventPush({ kind: 'done', session_id: 's1', pane: '%1', turn_started_at: 1 }, false, tdeps)).toEqual({ kind: 'turn', title: 'Your turn: Fix the widget', body: 'blue-vanilla · Ready to ship?', url: '/m/#s=claude%3As1', tag: 's-claude:s1' });
    expect(chatEventPush({ kind: 'blocked', session_id: 's1', pane: '%1' }, false, tdeps)?.title).toBe('Blocked: Fix the widget');
  });

  it('pushes only drafts that appear after the first look', () => {
    const w = new DraftWatch();
    const d = (id: string) => ({ id, label: '#general', channel: 'C1', messages: ['hello there'] });
    expect(w.next([d('a')])).toEqual([]);
    const out = w.next([d('a'), d('b')], () => 'cozy-donut');
    expect(out).toEqual([{ kind: 'draft', title: 'New draft: #general', body: 'cozy-donut · hello there', url: '/m/#outbox', tag: 'd-b' }]);
    expect(w.next([d('a'), d('b')])).toEqual([]);
  });
});

describe('sessions and transcripts for the phone', () => {
  const live = (o: object = {}) => ({ agent: 'claude' as const, session_id: 'x', pane_id: '%1', tmux_session: 'loom-a', window_index: '1', pane_index: '2', running: true, ...o });
  const c = (sid: string, state: string, at: number, l: object = {}): MobileChat => ({ agent: 'claude', session_id: sid, title: sid, project: 'p', state, jsonl_path: '', last_active_at: at, last_turn_at: 0, live: live(l) });

  it('classifies like the desktop sidebar: parked, saved, working, your turn, else recent', () => {
    const at = (state: string, o: Partial<MobileChat> = {}, l: object = {}) => statusOf({ ...c('x', state, 1, l), ...o });
    expect(at('waiting_on_user', {}, { working: true })).toBe('working');
    expect(at('waiting_on_user')).toBe('turn');
    expect(at('done')).toBe('recent');
    expect(at('pending')).toBe('recent');
    expect(at('done', {}, { stage: 'blocked' })).toBe('recent');
    expect(at('done', { parked: 'waiting' }, { working: true })).toBe('waiting');
    expect(at('done', { parked: 'replied' })).toBe('turn');
    expect(at('waiting_on_user', { saved: true })).toBe('saved');
  });

  it('lays out Recent first, then user groups in their order, then the other status sections; newest first everywhere', () => {
    const G1 = { id: 7, name: 'Billing' }, G2 = { id: 3, name: 'Infra' }, GONE = { id: 99, name: 'Deleted' };
    const chats = [
      c('t-old', 'waiting_on_user', 10), c('t-new', 'waiting_on_user', 30), c('w-old', 'done', 1, { working: true }), c('w-new', 'done', 50, { working: true }),
      c('r', 'done', 5), { ...c('p', 'done', 6), parked: 'waiting' as const },
      { ...c('g1-a', 'waiting_on_user', 20), group: G1 }, { ...c('g1-b', 'done', 40, { working: true }), group: G1 },
      { ...c('g2', 'done', 2), group: G2 }, { ...c('orphan', 'done', 3), group: GONE },
      c('tie-b', 'done', 4), c('tie-a', 'done', 4),
    ];
    const p = sessionsPayload(chats, () => 'tail', [{ session_id: 't-new' }, { session_id: 't-new' }, { session_id: 'g2' }], new Map(), [G2, G1, { id: 5, name: 'Empty' }]);
    expect(p.sections.map((s) => [s.key, s.name, s.kind, s.sessions.map((r) => r.key.slice(7))])).toEqual([
      ['recent', 'Recent', 'status', ['r', 'tie-a', 'tie-b', 'orphan']],
      ['g:3', 'Infra', 'group', ['g2']],
      ['g:7', 'Billing', 'group', ['g1-b', 'g1-a']],
      ['working', 'Working', 'status', ['w-new', 'w-old']],
      ['turn', 'Your turn', 'status', ['t-new', 't-old']],
      ['waiting', 'Waiting on others', 'status', ['p']],
    ]);
    expect(p.sections.filter((s) => s.kind === 'group').map((s) => s.group_id)).toEqual([3, 7]);
    expect(p.sections.filter((s) => s.kind === 'status').every((s) => s.group_id === undefined)).toBe(true);
    expect(p.groups).toEqual([G2, G1, { id: 5, name: 'Empty' }]);
    expect(p.counts).toEqual({ working: 3, turn: 3, waiting: 1, saved: 0, recent: 5 });
    expect(p.outbox_pending).toBe(3);
    const rows = p.sections.flatMap((s) => s.sessions);
    expect(rows.find((r) => r.key === 'claude:t-new')!.drafts).toBe(2);
    expect(rows.find((r) => r.key === 'claude:g2')!.drafts).toBe(1);
    expect(rows.find((r) => r.key === 'claude:w-new')!.tail).toBe('');
    expect(rows.find((r) => r.key === 'claude:g1-a')).toMatchObject({ group: 'turn', tail: 'tail' });
    expect(rows[0].pane).toBe('loom-a:1.2');
  });

  it('reads pane topics from one list-panes call, and survives tmux failing', () => {
    const calls: string[][] = [];
    const t = paneTopics((a) => {
      calls.push(a);
      return '%1\tShip it\n%2\t\nbogus\tx\n%3\tTopic with\ttab\n';
    });
    expect([...t]).toEqual([['%1', 'Ship it'], ['%3', 'Topic with\ttab']]);
    expect(calls.length).toBe(1);
    expect(paneTopics(() => { throw new Error('no server'); }).size).toBe(0);
    const p = sessionsPayload([c('a', 'waiting_on_user', 1, { pane_id: '%1' }), c('b', 'waiting_on_user', 2, { pane_id: '%2' })], () => '', [], new Map([['%1', 'Ship it']]));
    expect(p.sections.flatMap((s) => s.sessions).map((s) => s.topic)).toEqual(['b', 'Ship it']);
  });

  it('recognises Claude panes only by their command', () => {
    for (const ok of ['2.1.233', 'claude', '10.0.1\n']) expect(isClaudeCommand(ok), ok).toBe(true);
    for (const no of ['zsh', 'node', 'nvim', 'codex', '2.1', '', 'claude-x']) expect(isClaudeCommand(no), no).toBe(false);
  });

  it('reads the transcript with tool calls as one-liners', () => {
    const file = path.join(tmp(), 't.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: 'fix it' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'Bash', input: { command: 'yarn test', description: 'Run the tests' } }] } },
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
      { type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/repo/a.ts' } }, { type: 'text', text: 'Done.' }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(mobileTranscript('claude', file)).toEqual([
      { role: 'user', text: 'fix it' },
      { role: 'assistant', text: 'Looking.' },
      { role: 'tool', text: 'Bash: Run the tests' },
      { role: 'tool', text: 'Read: /repo/a.ts' },
      { role: 'assistant', text: 'Done.' },
    ]);
    expect(toolLine('Grep', {})).toBe('Grep');
  });

  it('keeps thinking blocks that carry text and drops signature-only ones', () => {
    const file = path.join(tmp(), 'think.jsonl');
    const lines = [
      { type: 'user', message: { role: 'user', content: 'why is it red?' } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'abc' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '  The lint step fails first.  ', signature: 'def' }, { type: 'text', text: 'Lint.' }] } },
    ];
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
    expect(mobileTranscript('claude', file)).toEqual([
      { role: 'user', text: 'why is it red?' },
      { role: 'thinking', text: 'The lint step fails first.' },
      { role: 'assistant', text: 'Lint.' },
    ]);
  });

  it('names draft kinds', () => {
    const base = { id: 'd', session_id: 's', channel: 'C1', messages: ['x'], status: 'pending', created_at: '' } as Draft;
    expect(draftKind({ ...base, thread_ts: '1.2' })).toBe('thread');
    expect(draftKind({ ...base, channel: 'D123' })).toBe('dm');
    expect(draftKind(base)).toBe('channel');
    expect(draftKind({ ...base, channel: '', messages: [], kind: 'email', email: { to: ['a@example.com'], subject: 's', body: 'b' } })).toBe('email');
    expect(draftKind({ ...base, channel: '', messages: [], review: { repo: 'o/r', pr: 1, commit_id: 'c', event: 'COMMENT', body: 'b', comments: [] } })).toBe('review');
  });
});

describe('outboxPayload order', () => {
  it('lists drafts newest first', async () => {
    const d = (id: string, created_at: string) => ({ id, session_id: 's', channel: 'C1', messages: ['x'], status: 'pending', created_at }) as Draft;
    const out = await outboxPayload([d('a', '2026-11-26T09:00:00'), d('c', '2026-11-26T11:00:00'), d('b', '2026-11-26T10:00:00')], []);
    expect(out.drafts.map((x) => x.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('draftUrl', () => {
  const base = { id: 'd', session_id: 's', channel: 'C1ABC', messages: ['x'], status: 'pending', created_at: '' } as Draft;
  it('links the thread, else the channel, else the PR', () => {
    expect(draftUrl({ ...base, thread_url: 'https://example.slack.com/archives/C1ABC/p1700000000000100' })).toBe('https://example.slack.com/archives/C1ABC/p1700000000000100');
    expect(draftUrl(base)).toBe('https://slack.com/app_redirect?channel=C1ABC');
    expect(draftUrl({ ...base, channel: '', messages: [], review: { repo: 'acme/app', pr: 12 } } as unknown as Draft)).toBe('https://github.com/acme/app/pull/12');
  });
  it('gives nothing for email or an odd url', () => {
    expect(draftUrl({ ...base, kind: 'email', channel: '' })).toBeUndefined();
    expect(draftUrl({ ...base, channel: '', thread_url: 'javascript:alert(1)' })).toBeUndefined();
  });
});
