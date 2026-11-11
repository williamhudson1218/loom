import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { classify, listenOnFirstFree, localIdentity, pickPort, probeWhoami, type Identity, type PickDeps } from '../src/portpick.ts';
import { portRange } from '../src/serverport.ts';
import { readServerJson, removeServerJson, resolveLoomPort, writeServerJson } from '../src/serverjson.ts';
import { buildSharedManifest } from '../src/slackmanifest.ts';
import { createServer } from '../src/server.ts';

// Port choice never binds 4317 here: the real-listener tests use random high ports.

const mine: Identity = { app: 'loom', uid: 501, home_id: 'aaaa' };
const theirs: Identity = { app: 'loom', uid: 502, home_id: 'bbbb' };

/** A stubbed world: `busy` maps a port to what holds it. Everything else is free. */
function world(busy: Record<number, Identity | 'other'>): PickDeps & { bound: number[] } {
  const bound: number[] = [];
  return {
    mine,
    bound,
    tryBind: async (port) => {
      if (port in busy) return 'busy';
      bound.push(port);
      return 'bound';
    },
    probe: async (port) => (busy[port] && busy[port] !== 'other' ? (busy[port] as Identity) : null),
  };
}

describe('classify', () => {
  it('is mine only for a Loom with this uid on this data folder', () => {
    expect(classify(mine, mine)).toBe('mine');
    expect(classify(theirs, mine)).toBe('other');
    expect(classify({ ...mine, home_id: 'other-home' }, mine)).toBe('other');
    expect(classify({ ...mine, uid: 0 }, mine)).toBe('other');
    expect(classify({ uid: 501, home_id: 'aaaa' }, mine)).toBe('other');
    expect(classify(null, mine)).toBe('other');
  });
});

describe('pickPort', () => {
  const ports = portRange(4317);

  it('takes the first port when it is free', async () => {
    expect(await pickPort(ports, world({}))).toEqual({ kind: 'bound', port: 4317 });
  });

  it('refuses to start a second server when this user\'s own Loom holds the port', async () => {
    const w = world({ 4317: mine });
    expect(await pickPort(ports, w)).toEqual({ kind: 'running', port: 4317 });
    expect(w.bound).toEqual([]);
  });

  it('moves past another user\'s Loom', async () => {
    expect(await pickPort(ports, world({ 4317: theirs }))).toEqual({ kind: 'bound', port: 4318 });
  });

  it('moves past a program that is not Loom', async () => {
    expect(await pickPort(ports, world({ 4317: 'other', 4318: 'other' }))).toEqual({ kind: 'bound', port: 4319 });
  });

  it('still notices its own Loom after skipping others', async () => {
    expect(await pickPort(ports, world({ 4317: theirs, 4318: mine }))).toEqual({ kind: 'running', port: 4318 });
  });

  it('reports the range as exhausted when every port is held', async () => {
    const busy: Record<number, 'other'> = {};
    for (const p of ports) busy[p] = 'other';
    expect(await pickPort(ports, world(busy))).toEqual({ kind: 'exhausted', tried: ports });
  });
});

describe('portRange', () => {
  it('is ten ports from the base, 4317 to 4326 by default', () => {
    expect(portRange()).toHaveLength(10);
    expect(portRange()[0]).toBe(4317);
    expect(portRange()[9]).toBe(4326);
    expect(portRange(65530)).toEqual([65530, 65531, 65532, 65533, 65534, 65535]);
  });
});

describe('a real listener falls back', () => {
  const open: http.Server[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
  });

  const hold = async (handler?: http.RequestListener): Promise<number> => {
    const s = http.createServer(handler ?? ((_req, res) => { res.statusCode = 404; res.end('nope'); }));
    open.push(s);
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return (s.address() as { port: number }).port;
  };
  const whoami = (id: Identity): http.RequestListener => (req, res) => {
    if (req.url === '/api/whoami') {
      res.setHeader('content-type', 'application/json');
      return void res.end(JSON.stringify(id));
    }
    res.statusCode = 404;
    res.end();
  };
  const me = localIdentity(os.tmpdir());

  it('moves past a busy port that is not Loom', async () => {
    const p = await hold();
    const server = http.createServer();
    open.push(server);
    const choice = await listenOnFirstFree(server, [p, p + 1, p + 2, p + 3], me);
    expect(choice.kind).toBe('bound');
    if (choice.kind === 'bound') {
      expect(choice.port).toBeGreaterThan(p);
      expect((server.address() as { port: number }).port).toBe(choice.port);
    }
  });

  it('moves past another user\'s Loom', async () => {
    const p = await hold(whoami({ ...me, uid: me.uid + 1 }));
    const server = http.createServer();
    open.push(server);
    const choice = await listenOnFirstFree(server, [p, p + 1, p + 2, p + 3], me);
    expect(choice.kind).toBe('bound');
    if (choice.kind === 'bound') expect(choice.port).toBeGreaterThan(p);
  });

  it('does not bind when this user\'s own Loom holds the port', async () => {
    const p = await hold(whoami(me));
    const server = http.createServer();
    open.push(server);
    expect(await listenOnFirstFree(server, [p, p + 1], me)).toEqual({ kind: 'running', port: p });
    expect(server.listening).toBe(false);
  });

  it('is exhausted when the only port is taken', async () => {
    const p = await hold();
    const server = http.createServer();
    open.push(server);
    expect(await listenOnFirstFree(server, [p], me)).toEqual({ kind: 'exhausted', tried: [p] });
  });

  it('Loom\'s own /api/whoami answers with the identity the probe compares', async () => {
    const server = createServer();
    open.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as { port: number }).port;
    const found = await probeWhoami(port);
    expect(found).toMatchObject({ app: 'loom', uid: process.getuid?.() ?? -1 });
    expect(found).not.toHaveProperty('home');
  });
});

describe('server.json and client resolution', () => {
  const homes: string[] = [];
  const tmpHome = () => {
    const h = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-port-'));
    homes.push(h);
    return h;
  };
  afterEach(() => homes.splice(0).forEach((h) => fs.rmSync(h, { recursive: true, force: true })));
  const deadPid = () => spawnSync('true').pid!;
  const info = (port: number, pid = process.pid) => ({ port, pid, uid: process.getuid?.() ?? -1, startedAt: 1 });

  it('writes the port and removes it only for its own pid', () => {
    const h = tmpHome();
    writeServerJson(info(4318), h);
    expect(readServerJson(h)?.port).toBe(4318);
    removeServerJson(h, process.pid + 1);
    expect(readServerJson(h)?.port).toBe(4318);
    removeServerJson(h);
    expect(readServerJson(h)).toBeNull();
  });

  it('resolves $LOOM_PORT, then server.json, then the setting, then 4317', () => {
    const h = tmpHome();
    expect(resolveLoomPort({ env: {}, home: h })).toBe(4317);
    expect(resolveLoomPort({ env: {}, home: h, setting: 4400 })).toBe(4400);
    writeServerJson(info(4319), h);
    expect(resolveLoomPort({ env: {}, home: h, setting: 4400 })).toBe(4319);
    expect(resolveLoomPort({ env: { LOOM_PORT: '4325' }, home: h, setting: 4400 })).toBe(4325);
  });

  it('ignores a server.json whose process is gone, and a bad $LOOM_PORT', () => {
    const h = tmpHome();
    writeServerJson(info(4319, deadPid()), h);
    expect(resolveLoomPort({ env: {}, home: h })).toBe(4317);
    writeServerJson(info(4319), h);
    expect(resolveLoomPort({ env: { LOOM_PORT: 'abc' }, home: h })).toBe(4319);
    expect(resolveLoomPort({ env: { LOOM_PORT: '99999' }, home: h })).toBe(4319);
    fs.writeFileSync(path.join(h, 'server.json'), '{not json');
    expect(resolveLoomPort({ env: {}, home: h })).toBe(4317);
  });

  const py = (env: Record<string, string>) =>
    spawnSync('python3', ['-I', '-c', 'import sys; sys.path.insert(0, sys.argv[1]); import _common as c; print(c.loom_port())', path.resolve(__dirname, '../plugin/loom/hooks')], {
      env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), ...env },
      encoding: 'utf8',
    }).stdout.trim();

  it('the plugin\'s Python helper resolves in the same order', () => {
    const h = tmpHome();
    expect(py({ LOOM_HOME: h })).toBe('4317');
    writeServerJson(info(4319), h);
    expect(py({ LOOM_HOME: h })).toBe('4319');
    expect(py({ LOOM_HOME: h, LOOM_PORT: '4325' })).toBe('4325');
    expect(py({ LOOM_HOME: h, LOOM_PORT: 'junk' })).toBe('4319');
    writeServerJson(info(4319, deadPid()), h);
    expect(py({ LOOM_HOME: h })).toBe('4317');
  });

  it('scripts/loom-port.sh resolves in the same order', () => {
    const h = tmpHome();
    const sh = (env: Record<string, string>) =>
      spawnSync('bash', [path.resolve(__dirname, '../scripts/loom-port.sh')], { env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), ...env }, encoding: 'utf8' }).stdout.trim();
    expect(sh({ LOOM_HOME: h })).toBe('4317');
    writeServerJson(info(4320), h);
    expect(sh({ LOOM_HOME: h })).toBe('4320');
    expect(sh({ LOOM_HOME: h, LOOM_PORT: '4325' })).toBe('4325');
    writeServerJson(info(4320, deadPid()), h);
    expect(sh({ LOOM_HOME: h })).toBe('4317');
  });
});

describe('the shared Slack manifest', () => {
  it('registers a redirect for every port Loom may land on', () => {
    const urls = buildSharedManifest({ port: 4317 }).oauth_config.redirect_urls;
    expect(urls).toEqual(portRange(4317).map((p) => `http://localhost:${p}/slack/callback`));
    expect(urls).toContain('http://localhost:4326/slack/callback');
  });
});
