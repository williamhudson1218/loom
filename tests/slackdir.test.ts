import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readDirectory, refreshDirectory } from '../src/slackdir.ts';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'loom-dir-'));
const fakeFetch = (routes: Record<string, unknown>): typeof fetch =>
  (async (url: string) => {
    const method = new URL(url).pathname.split('/').pop()!;
    const body = routes[method];
    if (body instanceof Error) throw body;
    return { status: 200, json: async () => body } as Response;
  }) as unknown as typeof fetch;

describe('slack directory', () => {
  it('reads channel names from the hook cache without the #', () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'ch.json'), JSON.stringify({ C1: '#ops', D1: '@alex' }));
    expect(readDirectory(path.join(dir, 'none.json'), path.join(dir, 'ch.json')).channels).toEqual({ C1: 'ops', D1: 'alex' });
  });

  it('collects users, the sender and custom emoji, and writes a cache', async () => {
    const dir = tmp();
    const file = path.join(dir, 'd.json');
    const d = await refreshDirectory({
      token: 't', file, labelsFile: path.join(dir, 'x'),
      fetchImpl: fakeFetch({
        'users.list': { ok: true, members: [{ id: 'U1', name: 'will', profile: { display_name: 'Will H', image_48: 'https://a/b.png' } }, { id: 'U2', deleted: true, name: 'gone' }, { id: 'U3', name: 'amy', real_name: 'Amy', profile: {} }] },
        'auth.test': { ok: true, user_id: 'U1', user: 'will' },
        'emoji.list': { ok: true, emoji: { party: 'https://e/p.png', yes: 'alias:party' } },
      }),
    });
    expect(d.users).toEqual({ U1: 'Will H', U3: 'Amy' });
    expect(d.me).toEqual({ id: 'U1', name: 'Will H', avatar: 'https://a/b.png' });
    expect(d.custom.party).toBe('https://e/p.png');
    expect(readDirectory(file, path.join(dir, 'x')).users.U1).toBe('Will H');
  });

  it('keeps what it had when a call fails', async () => {
    const dir = tmp();
    const file = path.join(dir, 'd.json');
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: 1, users: { U1: 'Kept' }, custom: { a: 'https://x' }, me: { id: 'U1', name: 'Kept', avatar: '' } }));
    const d = await refreshDirectory({ token: 't', file, labelsFile: path.join(dir, 'x'), fetchImpl: fakeFetch({ 'users.list': new Error('offline'), 'emoji.list': { ok: false, error: 'missing_scope' } }) });
    expect(d.users).toEqual({ U1: 'Kept' });
    expect(d.custom).toEqual({ a: 'https://x' });
  });
});
