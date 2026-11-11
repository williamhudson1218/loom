import { describe, it, expect } from 'vitest';
import { connectionStates, makeGhCache, type ConnInputs, type GhState } from '../src/connections.ts';

const base: ConnInputs = { slackMode: 'off', slackReconnect: '', gh: 'unknown', emailSetting: '', emailCli: '', emailCliExists: false };
const by = (i: Partial<ConnInputs>) => Object.fromEntries(connectionStates({ ...base, ...i }).map((c) => [c.id, c]));

describe('connection states', () => {
  it('is grey everywhere when nothing is set up', () => {
    const c = by({});
    expect(['slack', 'github', 'gmail'].map((k) => c[k].state)).toEqual(['off', 'off', 'off']);
  });
  it('maps Slack mode and reconnect', () => {
    expect(by({ slackMode: 'direct' }).slack.state).toBe('ok');
    expect(by({ slackMode: 'mcp' }).slack.state).toBe('ok');
    expect(by({ slackMode: 'direct', slackReconnect: 'refresh_failed' }).slack.state).toBe('warn');
    expect(by({ slackMode: 'off', slackReconnect: 'refresh_failed' }).slack.state).toBe('warn');
  });
  it('maps gh results', () => {
    expect(by({ gh: 'ok' }).github.state).toBe('ok');
    expect(by({ gh: 'unauth' }).github.state).toBe('warn');
    expect(by({ gh: 'missing' }).github.state).toBe('off');
  });
  it('maps the email CLI setting', () => {
    expect(by({ emailCli: '/x/gmail.mjs', emailCliExists: true }).gmail.state).toBe('ok');
    expect(by({ emailSetting: '/nope', emailCli: '/nope', emailCliExists: false }).gmail.state).toBe('warn');
    expect(by({}).gmail.state).toBe('off');
  });
  it('points each click at a settings section and says the state in words', () => {
    const c = by({ gh: 'unauth' });
    expect([c.slack.section, c.github.section, c.gmail.section]).toEqual(['slack', 'github', 'outbox']);
    expect(c.github.detail).toMatch(/not signed in/);
  });
});

describe('gh cache', () => {
  it('runs gh once per TTL, answers at once from the cache and refreshes in the background', async () => {
    let t = 0;
    let runs = 0;
    let result: GhState = 'ok';
    const cache = makeGhCache(async () => { runs++; return result; }, 1000, () => t);
    expect(cache.get()).toBe('unknown'); // first call starts the run, answers unknown
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.get()).toBe('ok');
    cache.get(); cache.get();
    expect(runs).toBe(1); // polls inside the TTL never re-run it
    t = 2000; result = 'unauth';
    expect(cache.get()).toBe('ok'); // stale value served while it refreshes
    await new Promise((r) => setTimeout(r, 0));
    expect(cache.get()).toBe('unauth');
    expect(runs).toBe(2);
  });
});
