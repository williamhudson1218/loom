import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execText, guardTick, SingleFlight, TtlCache } from '../src/asyncexec.ts';
import { psTableAsync, resetPsCache } from '../src/placements.ts';
import { outboxCacheSize, readOutbox, readOutboxShared, updateDraft } from '../src/outbox.ts';
import { dedupedGh } from '../src/pipeline.ts';
import { githubRemotesOf, githubRepoOf, isPlaceholderRepo, pickPrUrl } from '../src/prpick.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { probeChatView } from '../src/ptybridge.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('SingleFlight', () => {
  it('runs one call per key while it is in flight, then fresh again', async () => {
    const f = new SingleFlight<string>();
    let calls = 0;
    let release!: (v: string) => void;
    const slow = () => {
      calls++;
      return new Promise<string>((r) => (release = r));
    };
    const a = f.run('k', slow);
    const b = f.run('k', slow);
    expect(calls).toBe(1);
    release('x');
    expect(await a).toBe('x');
    expect(await b).toBe('x');
    expect(f.size).toBe(0);
    const c = f.run('k', slow);
    expect(calls).toBe(2);
    release('y');
    expect(await c).toBe('y');
  });

  it('keeps different keys apart, and a failure reaches every waiter then clears', async () => {
    const f = new SingleFlight<number>();
    let n = 0;
    const [x, y] = await Promise.all([f.run('a', async () => ++n), f.run('b', async () => ++n)]);
    expect(new Set([x, y])).toEqual(new Set([1, 2]));
    const boom = () => Promise.reject(new Error('nope'));
    await expect(Promise.all([f.run('e', boom), f.run('e', boom)])).rejects.toThrow('nope');
    expect(f.size).toBe(0);
  });
});

describe('TtlCache', () => {
  it('reuses within the ttl, collapses concurrent loads, reloads after', async () => {
    let now = 0;
    const c = new TtlCache<number>(100, () => now);
    let loads = 0;
    const load = async () => ++loads;
    const [a, b] = await Promise.all([c.get(load), c.get(load)]);
    expect([a, b, loads]).toEqual([1, 1, 1]);
    now = 50;
    expect(await c.get(load)).toBe(1);
    now = 150;
    expect(await c.get(load)).toBe(2);
    // reuse:false skips the cached value but still joins an in-flight load
    const [d, e] = await Promise.all([c.get(load, { reuse: false }), c.get(load, { reuse: false })]);
    expect([d, e, loads]).toEqual([3, 3, 3]);
  });
});

describe('psTableAsync', () => {
  it('runs one ps for concurrent callers', async () => {
    resetPsCache();
    let runs = 0;
    let release!: (v: string) => void;
    const fake = () => {
      runs++;
      return new Promise<string>((r) => (release = r));
    };
    const a = psTableAsync(fake);
    const b = psTableAsync(fake);
    expect(runs).toBe(1);
    release('  1     0 /sbin/launchd\n');
    expect(await a).toContain('launchd');
    expect(await b).toContain('launchd');
    resetPsCache();
  });
});

describe('execText', () => {
  it('reports its own timeout as ETIMEDOUT, like execFileSync', async () => {
    await expect(execText('/bin/sleep', ['5'], { timeout: 50 })).rejects.toMatchObject({ code: 'ETIMEDOUT' });
  });
  it('resolves stdout', async () => {
    expect((await execText('/bin/echo', ['hi'])).trim()).toBe('hi');
  });
});

describe('guardTick', () => {
  it('skips a firing while the previous run is still going', async () => {
    let runs = 0;
    let release!: () => void;
    const t = guardTick(() => {
      runs++;
      return new Promise<void>((r) => (release = r));
    });
    const first = t();
    await t();
    await t();
    expect(runs).toBe(1);
    expect(t.running()).toBe(true);
    release();
    await first;
    expect(t.running()).toBe(false);
    const again = t();
    expect(runs).toBe(2);
    release();
    await again;
  });

  it('routes errors to onError and frees the guard', async () => {
    const errs: unknown[] = [];
    const t = guardTick(async () => {
      throw new Error('bad');
    }, (e) => errs.push(e));
    await t();
    await t();
    expect(errs).toHaveLength(2);
  });
});

describe('readOutboxShared', () => {
  const draft = { id: 'd1', session_id: 's1', channel: 'C1', created_at: '2026-10-16T09:00:00', messages: ['hello'], status: 'pending' };
  const file = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-outbox-cache-'));
    const f = path.join(dir, 'outbox.json');
    fs.writeFileSync(f, JSON.stringify({ drafts: { d1: draft } }));
    return f;
  };

  it('parses once while the file is unchanged, and again after a write', () => {
    const f = file();
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = ((...a: Parameters<typeof JSON.parse>) => {
      parses++;
      return parse(...a);
    }) as typeof JSON.parse;
    try {
      const a = readOutboxShared(f);
      const b = readOutboxShared(f);
      expect(b).toBe(a);
      expect(parses).toBe(1);
      expect(outboxCacheSize()).toBeGreaterThan(0);
    } finally {
      JSON.parse = parse;
    }
    expect(updateDraft('d1', ['changed'], f).ok).toBe(true);
    expect(readOutboxShared(f).d1.messages).toEqual(['changed']);
  });

  it('notices a change made by another process (new inode, size or mtime)', () => {
    const f = file();
    expect(readOutboxShared(f).d1.messages).toEqual(['hello']);
    const tmp = `${f}.other`;
    fs.writeFileSync(tmp, JSON.stringify({ drafts: { d1: { ...draft, messages: ['from the CLI'] } } }));
    fs.renameSync(tmp, f);
    expect(readOutboxShared(f).d1.messages).toEqual(['from the CLI']);
  });

  it('readOutbox still hands out a private copy', () => {
    const f = file();
    const shared = readOutboxShared(f);
    const own = readOutbox(f);
    own.d1.status = 'sent';
    expect(shared.d1.status).toBe('pending');
    expect(readOutboxShared(f).d1.status).toBe('pending');
  });
});

describe('dedupedGh', () => {
  it('collapses identical concurrent gh calls, keeps distinct ones apart', async () => {
    const calls: string[] = [];
    const gh = async (args: string[]) => {
      calls.push(args.join(' '));
      await tick();
      return '{"jobs":[]}';
    };
    const g = dedupedGh(gh);
    await Promise.all([
      g(['run', 'view', '42', '--json', 'jobs'], '/h'),
      g(['run', 'view', '42', '--json', 'jobs'], '/h'),
      g(['run', 'view', '43', '--json', 'jobs'], '/h'),
    ]);
    expect(calls.sort()).toEqual(['run view 42 --json jobs', 'run view 43 --json jobs']);
    // Settled: the next call runs again.
    await g(['run', 'view', '42', '--json', 'jobs'], '/h');
    expect(calls).toHaveLength(3);
  });
});

describe('PR URL pick', () => {
  it('reads owner/repo from every remote URL form', () => {
    expect(githubRepoOf('git@github.com:Acme-Co/Web-App.git')).toBe('acme-co/web-app');
    expect(githubRepoOf('https://github.com/acme-co/web-app')).toBe('acme-co/web-app');
    expect(githubRepoOf('ssh://git@github.com/acme-co/web-app.git')).toBe('acme-co/web-app');
    expect(githubRepoOf('https://gitlab.com/acme-co/web-app.git')).toBeNull();
  });

  it('flags example repos', () => {
    for (const r of ['org/repo', 'owner/repo', 'octocat/hello-world', 'your-org/your-repo']) expect(isPlaceholderRepo(r)).toBe(true);
    expect(isPlaceholderRepo('acme-co/web-app')).toBe(false);
  });

  it("takes the last PR in the chat's own repo, skipping a later example", () => {
    const urls = ['https://github.com/acme-co/web-app/pull/7', 'https://github.com/other/thing/pull/9', 'https://github.com/org/repo/pull/123'];
    expect(pickPrUrl(urls, ['acme-co/web-app'])).toBe('https://github.com/acme-co/web-app/pull/7');
    expect(pickPrUrl(urls.slice(1), ['acme-co/web-app'])).toBe('');
    // Remotes unknown: the last one that is not a placeholder.
    expect(pickPrUrl(urls, null)).toBe('https://github.com/other/thing/pull/9');
  });

  it('finds the remotes of a checkout, a subfolder and a linked worktree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prpick-'));
    const repo = path.join(root, 'repo');
    fs.mkdirSync(path.join(repo, '.git', 'worktrees', 'wt'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.git', 'config'), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:me/web-app.git\n[remote "upstream"]\n\turl = https://github.com/Acme-Co/web-app.git\n[branch "main"]\n\tremote = origin\n');
    fs.writeFileSync(path.join(repo, '.git', 'worktrees', 'wt', 'commondir'), '../..\n');
    const wt = path.join(root, 'wt');
    fs.mkdirSync(wt);
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(repo, '.git', 'worktrees', 'wt')}\n`);
    expect(githubRemotesOf(repo)?.sort()).toEqual(['acme-co/web-app', 'me/web-app']);
    expect(githubRemotesOf(path.join(repo, 'src'))?.sort()).toEqual(['acme-co/web-app', 'me/web-app']);
    expect(githubRemotesOf(wt)?.sort()).toEqual(['acme-co/web-app', 'me/web-app']);
    expect(githubRemotesOf(path.join(root, 'nothing-here'))).toBeNull();
  });

  it("parseJsonlFile no longer makes an example URL a chat's PR", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-prpick-parse-'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/acme-co/web-app.git\n');
    const f = path.join(root, 's.jsonl');
    fs.writeFileSync(f, [
      JSON.stringify({ type: 'user', sessionId: 's', cwd: root, timestamp: '2026-06-15T12:00:00.000Z', message: { role: 'user', content: 'opened https://github.com/acme-co/web-app/pull/41' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-06-15T12:01:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'e.g. https://github.com/org/repo/pull/123' }] } }),
    ].join('\n') + '\n');
    expect((await parseJsonlFile(f)).pr_url).toBe('https://github.com/acme-co/web-app/pull/41');
  });
});

describe('probeChatView', () => {
  it('reads all four answers in one call and reports a moved view', async () => {
    const seen: string[][] = [];
    const run = async (args: string[]) => {
      seen.push(args);
      return '@2\n@5\n0\n1 1\n';
    };
    expect(await probeChatView('loom-view-x', '%3', run)).toEqual({ moved: true, zoomed: false, paneZoomedActive: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].filter((a) => a === ';')).toHaveLength(3);
  });

  it('is null when tmux fails, so the caller falls back to the sync path', async () => {
    expect(await probeChatView('loom-view-x', '%3', async () => Promise.reject(new Error('no pane')))).toBeNull();
    expect(await probeChatView('not-a-view', '%3', async () => '')).toBeNull();
  });
});
