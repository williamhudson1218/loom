import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { lastTurnAtFromTail, lastTurnAtFromTailAsync, parseJsonlFile, TranscriptCache } from '../src/parser.ts';
import { compactPlacements, readPlacements } from '../src/placements.ts';
import { boardDataEtag, createServer, sendBoardData } from '../src/server.ts';
import { termToken } from '../src/ptybridge.ts';

const tmpDir = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A transcript exercising every field ParsedChat derives: ids, timestamps over two
// days, turns vs non-turn records, titles (ai then custom then ai), a meta and a
// tool_result user record, file tools, PR links (own repo, another repo, a
// placeholder), multibyte text, a CRLF line and a malformed line.
function transcript(cwd: string): string {
  const rec = (o: object) => JSON.stringify(o);
  const lines = [
    rec({ type: 'file-history-snapshot', timestamp: '2026-06-15T09:00:00.000Z' }),
    rec({ type: 'user', sessionId: 'sess-inc', cwd, timestamp: '2026-06-15T10:00:00.000Z', message: { role: 'user', content: 'Fix the café 🚀 build <command-name>/x</command-name>' } }),
    rec({ type: 'ai-title', aiTitle: 'First AI title' }),
    rec({ type: 'assistant', timestamp: '2026-06-15T10:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/w/a.ts' } }, { type: 'tool_use', name: 'Edit', input: { file_path: '/w/b.ts' } }] } }),
    rec({ type: 'user', isMeta: true, timestamp: '2026-06-15T10:02:00.000Z', message: { role: 'user', content: 'meta' } }),
    rec({ type: 'user', timestamp: '2026-06-15T10:03:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'see https://github.com/org/repo/pull/123' }] } }),
    'not json at all {',
    rec({ type: 'assistant', timestamp: '2026-06-15T10:04:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Opened https://github.com/acme-co/web-app/pull/41 — ünïcödé' }] } }) + '\r',
    rec({ type: 'ai-title', aiTitle: 'Second AI title' }),
    rec({ type: 'custom-title', customTitle: 'Custom title ✓' }),
    rec({ type: 'user', timestamp: '2026-06-16T08:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: 'and https://github.com/other-co/lib/pull/7' }] } }),
    rec({ type: 'assistant', timestamp: '2026-06-16T08:01:00.000Z', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/w/c.ts' } }] } }),
    rec({ type: 'ai-title', aiTitle: 'Late AI title' }),
    rec({ type: 'system', timestamp: '2026-06-17T00:00:00.000Z' }),
  ];
  return lines.join('\n') + '\n';
}

function gitCheckout(remote: string | null): string {
  const dir = tmpDir('loom-inc-repo-');
  if (remote) {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
  }
  return dir;
}

/** Grow `file` to `full` in the given byte cuts, checking incremental == whole-file parse after each. */
async function growAndCompare(file: string, full: Buffer, cuts: number[], cache: TranscriptCache): Promise<void> {
  fs.writeFileSync(file, '');
  let at = 0;
  for (const cut of [...cuts, full.length]) {
    if (cut <= at) continue;
    fs.appendFileSync(file, full.subarray(at, cut));
    at = cut;
    expect(await cache.parse(file)).toEqual(await parseJsonlFile(file));
  }
}

describe('TranscriptCache (incremental transcript parsing)', () => {
  for (const [label, remote] of [['remotes known', 'git@github.com:acme-co/web-app.git'], ['no checkout', null]] as const) {
    it(`matches a whole-file parse at every step of growth, split lines included (${label})`, async () => {
      const cwd = gitCheckout(remote);
      const full = Buffer.from(transcript(cwd));
      const file = path.join(tmpDir('loom-inc-'), 'sess-inc.jsonl');
      // Cuts mid-line, mid multibyte character, right after and right before newlines.
      const nl: number[] = [];
      full.forEach((b, i) => b === 0x0a && nl.push(i));
      const emoji = full.indexOf(Buffer.from('🚀'));
      const cuts = [5, emoji + 1, emoji + 3, nl[1], nl[1] + 1, nl[3] - 10, nl[5] + 2, nl[7] - 1, nl[7], nl[9] + 30, nl[12] + 1, full.length - 3];
      await growAndCompare(file, full, cuts, new TranscriptCache());
      // Tiny read chunks: the same, with every line spanning several reads.
      await growAndCompare(file, full, cuts, new TranscriptCache({ chunkBytes: 7 }));
      // One byte at a time over a stretch with a multibyte character in it.
      await growAndCompare(file, full, Array.from({ length: 40 }, (_, i) => emoji - 20 + i), new TranscriptCache({ chunkBytes: 3 }));

      const c = await new TranscriptCache().parse(file);
      expect(c.session_id).toBe('sess-inc');
      expect(c.message_count).toBe(6);
      expect(c.claude_auto_title).toBe('Custom title ✓');
      expect(c.files_written).toEqual(['/w/b.ts', '/w/c.ts']);
      expect(c.pr_url).toBe(remote ? 'https://github.com/acme-co/web-app/pull/41' : 'https://github.com/other-co/lib/pull/7');
    });
  }

  it('reads only the appended bytes on a later call', async () => {
    const cwd = gitCheckout(null);
    const file = path.join(tmpDir('loom-inc-'), 's.jsonl');
    const full = Buffer.from(transcript(cwd));
    const half = full.indexOf(0x0a, full.length >> 1) + 1;
    fs.writeFileSync(file, full.subarray(0, half));
    const cache = new TranscriptCache();
    await cache.parse(file);
    fs.appendFileSync(file, full.subarray(half));
    const orig = fs.promises.open;
    let asked = 0;
    (fs.promises as { open: typeof fs.promises.open }).open = (async (...a: Parameters<typeof fs.promises.open>) => {
      const fh = await orig(...a);
      const read = fh.read.bind(fh);
      (fh as unknown as { read: (buf: Buffer, off: number, len: number, pos: number) => unknown }).read = (buf: Buffer, off: number, len: number, pos: number) => {
        asked += len;
        return read(buf, off, len, pos);
      };
      return fh;
    }) as typeof fs.promises.open;
    try {
      expect(await cache.parse(file)).toEqual(await parseJsonlFile(file));
    } finally {
      (fs.promises as { open: typeof fs.promises.open }).open = orig;
    }
    // The appended tail plus the 64-byte rewrite guard, never the whole file again.
    expect(asked).toBe(full.length - half + 64);
  });

  it('starts over when the file is truncated, replaced or rewritten in place', async () => {
    const cwd = gitCheckout(null);
    const dir = tmpDir('loom-inc-');
    const file = path.join(dir, 's.jsonl');
    const full = transcript(cwd);
    const cache = new TranscriptCache();
    fs.writeFileSync(file, full);
    await cache.parse(file);

    const lines = full.split('\n');
    fs.writeFileSync(file, lines.slice(0, 4).join('\n') + '\n'); // shrank (same inode)
    expect(await cache.parse(file)).toEqual(await parseJsonlFile(file));

    fs.writeFileSync(path.join(dir, 'next'), lines.slice(8).join('\n')); // a new inode
    fs.renameSync(path.join(dir, 'next'), file);
    expect(await cache.parse(file)).toEqual(await parseJsonlFile(file));

    // Rewritten in place (same inode) with different bytes just before the old end, then grown.
    const now = fs.readFileSync(file, 'utf-8');
    fs.writeFileSync(file, now.replace('2026-06-17', '2026-06-18') + lines.slice(1, 3).join('\n') + '\n');
    expect(await cache.parse(file)).toEqual(await parseJsonlFile(file));
  });

  it('counts a complete last line with no newline, once, as the whole-file parse does', async () => {
    const file = path.join(tmpDir('loom-inc-'), 's.jsonl');
    const a = JSON.stringify({ type: 'user', sessionId: 's', cwd: '/x', timestamp: '2026-06-15T10:00:00.000Z', message: { role: 'user', content: 'one' } });
    const b = JSON.stringify({ type: 'assistant', timestamp: '2026-06-15T10:01:00.000Z', message: { role: 'assistant', content: 'two' } });
    const cache = new TranscriptCache();
    fs.writeFileSync(file, a + '\n' + b);
    expect((await cache.parse(file)).message_count).toBe(2);
    expect(await cache.parse(file)).toEqual(await parseJsonlFile(file));
    fs.appendFileSync(file, '\n');
    expect((await cache.parse(file)).message_count).toBe(2);
    expect(await cache.parse(file)).toEqual(await parseJsonlFile(file));
  });

  it('keeps at most `max` files and shares one read between concurrent callers', async () => {
    const dir = tmpDir('loom-inc-');
    const cache = new TranscriptCache({ max: 2 });
    const full = transcript('/x');
    const files = ['a', 'b', 'c'].map((n) => path.join(dir, `${n}.jsonl`));
    for (const f of files) fs.writeFileSync(f, full);
    for (const f of files) await cache.parse(f);
    expect(cache.size).toBe(2);
    const [x, y] = await Promise.all([cache.parse(files[0]), cache.parse(files[0])]);
    expect(x).toBe(y);
    expect(x).toEqual(await parseJsonlFile(files[0]));
  });
});

describe('lastTurnAtFromTailAsync', () => {
  it('agrees with the synchronous tail read', async () => {
    const file = path.join(tmpDir('loom-tail-'), 's.jsonl');
    fs.writeFileSync(file, transcript('/x'));
    expect(await lastTurnAtFromTailAsync(file)).toBe(lastTurnAtFromTail(file));
    expect(await lastTurnAtFromTailAsync(file, 300)).toBe(lastTurnAtFromTail(file, 300));
    expect(await lastTurnAtFromTailAsync('/no/such.jsonl')).toBe(0);
  });
});

describe('compactPlacements', () => {
  const row = (sid: string, pane: string, ts: number, agent: string | null = 'claude') =>
    JSON.stringify({ ...(agent ? { agent } : {}), session_id: sid, pane_id: pane, tmux_session: 'loom-a', window_index: '1', pane_index: '0', cwd: '/x', ts }) + '\n';
  const history = () => {
    let s = '';
    for (let i = 0; i < 40; i++) s += row(`s${i % 5}`, `%${i}`, i) + (i === 7 ? 'garbage\n' : '') + (i === 9 ? row('legacy', '%L', i, null) : '');
    return s;
  };
  const plain = (m: ReadonlyMap<string, unknown>) => JSON.parse(JSON.stringify([...m]));

  it('rewrites the log to the rows readPlacements keeps, in the same order', () => {
    const file = path.join(tmpDir('loom-cpl-'), 'placements.jsonl');
    fs.writeFileSync(file, history());
    const before = plain(readPlacements(file));
    const r = compactPlacements(file, { minBytes: 0 });
    expect(r && r.after < r.before).toBe(true);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(6);
    expect(plain(readPlacements(file))).toEqual(before);
    // Already compact: nothing to do.
    expect(compactPlacements(file, { minBytes: 0 })).toBeNull();
  });

  it('leaves a small or mostly-live log alone', () => {
    const file = path.join(tmpDir('loom-cpl-'), 'placements.jsonl');
    fs.writeFileSync(file, history());
    expect(compactPlacements(file)).toBeNull(); // under the size floor
    expect(compactPlacements(file, { minBytes: 0, minRatio: 100 })).toBeNull();
    expect(compactPlacements(path.join(path.dirname(file), 'missing.jsonl'), { minBytes: 0 })).toBeNull();
  });

  it('keeps rows appended while it runs, and a line still being written', () => {
    const file = path.join(tmpDir('loom-cpl-'), 'placements.jsonl');
    const partial = row('s1', '%PARTIAL', 99);
    fs.writeFileSync(file, history() + partial.slice(0, 15));
    compactPlacements(file, {
      minBytes: 0,
      beforeRename: () => fs.appendFileSync(file, partial.slice(15) + row('late', '%late', 100)),
    });
    const m = readPlacements(file);
    expect(m.get('claude:s1')?.pane_id).toBe('%PARTIAL');
    expect(m.get('claude:late')?.pane_id).toBe('%late');
    expect(fs.readdirSync(path.dirname(file))).toEqual(['placements.jsonl']); // no temp file left
  });
});

describe('/api/data ETag', () => {
  it('is a hash of the body, stable for the same body', () => {
    expect(boardDataEtag('{"a":1}')).toBe(boardDataEtag('{"a":1}'));
    expect(boardDataEtag('{"a":1}')).not.toBe(boardDataEtag('{"a":2}'));
  });

  it('answers a matching If-None-Match with a bodiless 304, anything else with the body and a fresh generatedAt', async () => {
    const payload = JSON.stringify({ defaultAgent: 'claude', chats: [{ session_id: 'a' }] });
    const server = http.createServer((req, res) => sendBoardData(req, res, payload));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const url = `http://127.0.0.1:${address.port}/`;
    try {
      const first = await fetch(url);
      expect(first.status).toBe(200);
      const etag = first.headers.get('etag') ?? '';
      expect(etag).toBe(boardDataEtag(payload));
      const body = (await first.json()) as Record<string, unknown>;
      expect(typeof body.generatedAt).toBe('number');
      expect(body.chats).toEqual([{ session_id: 'a' }]);

      const again = await fetch(url, { headers: { 'if-none-match': etag } });
      expect(again.status).toBe(304);
      expect(await again.text()).toBe('');

      const stale = await fetch(url, { headers: { 'if-none-match': '"nope"' } });
      expect(stale.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('/api/data carries the ETag of its body', async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('server did not bind');
    const headers = { origin: `http://127.0.0.1:${address.port}`, 'x-loom-token': termToken() };
    try {
      const r = await fetch(`http://127.0.0.1:${address.port}/api/data`, { headers: { ...headers, 'if-none-match': '"nope"' } });
      expect(r.status).toBe(200);
      const text = await r.text();
      // The tag covers the body without its per-response generatedAt.
      const { generatedAt, ...rest } = JSON.parse(text) as Record<string, unknown>;
      expect(typeof generatedAt).toBe('number');
      expect(r.headers.get('etag')).toBe(boardDataEtag(JSON.stringify(rest)));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
