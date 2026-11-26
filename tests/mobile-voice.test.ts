import { describe, expect, it, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DeviceStore, setDeviceStore } from '../src/mobile/devices.ts';
import type { MobileChat, MobileMsg } from '../src/mobile/api.ts';
import type { LiveLoc } from '../src/dashboard.ts';
import type { RouteCtx } from '../src/routes/index.ts';
import {
  VOICE_ROUTES, VOICE, alreadySpeakable, buildSummaryAsk, checkWav, cleanTranscript, fallbackSummary, pruneAudio, resetVoiceForTests, setVoiceDeps, speakable, turnSince, turnText,
  type VoiceDeps,
} from '../src/mobile/voice.ts';
import { KOKORO_FILES, WHISPER_MODEL, installJob, silentWav, resetInstallJob, setVoiceDir, startVoiceInstall, voicePaths, voiceStatus, type InstallDeps } from '../src/mobile/voice-setup.ts';
import { VOICE_CSS, VOICE_JS } from '../src/mobile/voiceapp.ts';
import { DEVICES_VIEW_JS } from '../src/devicesview.ts';

// Conversation mode. Nothing here runs whisper, Kokoro, `say` or a model: the voice deps
// are fakes, and the handlers are driven through a bare HTTP server (the gate's own
// checks on /m/api are covered in mobile-auth.test.ts).

function wav(o: { rate?: number; channels?: number; bits?: number; samples?: number } = {}): Buffer {
  const rate = o.rate ?? 16000, ch = o.channels ?? 1, bits = o.bits ?? 16, n = o.samples ?? 16000;
  const data = n * ch * (bits / 8);
  const b = Buffer.alloc(44 + data);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + data, 4);
  b.write('WAVE', 8, 'latin1');
  b.write('fmt ', 12, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(ch, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * ch * (bits / 8), 28);
  b.writeUInt16LE(ch * (bits / 8), 32);
  b.writeUInt16LE(bits, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(data, 40);
  return b;
}

describe('checkWav', () => {
  it('takes 16 kHz mono 16-bit PCM', () => {
    expect(checkWav(wav())).toBeNull();
    expect(checkWav(silentWav(16000))).toBeNull();
  });
  it('refuses other formats and junk', () => {
    expect(checkWav(wav({ rate: 44100 }))).toMatch(/16 kHz/);
    expect(checkWav(wav({ channels: 2 }))).toMatch(/mono/);
    expect(checkWav(wav({ bits: 8 }))).toMatch(/16-bit/);
    expect(checkWav(wav({ samples: 100 }))).toMatch(/too short/);
    expect(checkWav(Buffer.from('not a wav at all, just some bytes here to pass the length'))).toMatch(/not a WAV/);
  });
});

describe('text shaping', () => {
  it('drops whisper markers and its stock filler on silence', () => {
    expect(cleanTranscript(' [BLANK_AUDIO]\n')).toBe('');
    expect(cleanTranscript(' Thank you.')).toBe('');
    expect(cleanTranscript(' (music) Run the tests again. ')).toBe('Run the tests again.');
  });

  const msgs: MobileMsg[] = [
    { role: 'user', text: 'first ask' },
    { role: 'assistant', text: 'old answer' },
    { role: 'user', text: 'fix the bug' },
    { role: 'tool', text: 'Bash: run the tests' },
    { role: 'assistant', text: 'Fixed it in `src/a.ts`:\n```ts\n' + 'x'.repeat(500) + '\n```\nShould I push?' },
  ];
  it('takes the turn since the last user message', () => {
    const t = turnSince(msgs);
    expect(t.lastUser).toBe('fix the bug');
    expect(t.turn.map((m) => m.role)).toEqual(['tool', 'assistant']);
    expect(turnSince([{ role: 'assistant', text: 'hi' }])).toEqual({ lastUser: '', turn: [{ role: 'assistant', text: 'hi' }] });
  });
  it('shortens long code blocks and keeps the newest text', () => {
    const s = turnText(turnSince(msgs).turn);
    expect(s).toContain('[tool] Bash: run the tests');
    expect(s).toContain('[code block]');
    expect(s).toContain('Should I push?');
    expect(turnText([{ role: 'assistant', text: 'a'.repeat(50) + 'END' }], 20)).toMatch(/^….*END$/);
  });
  it('builds the ask with the screen only when given', () => {
    expect(buildSummaryAsk('do it', 'did it', '')).not.toContain('<screen>');
    const a = buildSummaryAsk('do it', 'did it', 'Do you want to proceed?');
    expect(a).toContain('<turn>\ndid it\n</turn>');
    expect(a).toContain('<screen>');
    expect(a).toContain('The user last said: "do it"');
  });
  it('keeps code, links and paths out of the spoken text', () => {
    const s = speakable('**Done.** See `foo()` in /Users/x/dev/app/src/a.ts and https://example.com/pr/1\n```js\nrm -rf /\n```\n# Next');
    expect(s).toBe('Done. See foo() in a file and a link Next');
  });
  it('speaks a short plain reply as it is, and nothing with code, paths or links', () => {
    const a = (text: string): MobileMsg[] => [{ role: 'tool', text: 'Bash: x' }, { role: 'assistant', text }];
    expect(alreadySpeakable(a('All tests pass.  Want me to push it?'))).toBe('All tests pass. Want me to push it?');
    for (const bad of ['Changed `foo`.', 'See https://x.io', 'Edited src/a/b.ts', '**Done**', '- one\n- two', 'x'.repeat(300)]) expect(alreadySpeakable(a(bad)), bad).toBe('');
    expect(alreadySpeakable([{ role: 'tool', text: 'Bash: x' }])).toBe('');
  });
  it('falls back to the last thing the agent said, and the prompt', () => {
    expect(fallbackSummary([{ role: 'assistant', text: 'One. Two! Three?' }], false)).toBe('One. Two!');
    expect(fallbackSummary([], true)).toBe('The agent finished its turn. It is waiting for your permission to continue.');
  });
});

/* ------------------------------------------------------------ the routes */

const audioDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-voice-audio-'));
const live = (over: Partial<LiveLoc> = {}): LiveLoc => ({ agent: 'claude', session_id: 's1', pane_id: '%7', tmux_session: 'loom-work', window_index: '1', pane_index: '0', running: true, working: false, name: 'blue-vanilla', stage: 'implementation', ...over });
const chat = (over: Partial<MobileChat> = {}): MobileChat => ({ agent: 'claude', session_id: 's1', title: 'Fix it', project: 'demo', state: 'waiting_on_user', jsonl_path: '/nonexistent.jsonl', last_active_at: 1, last_turn_at: 1, live: live(), ...over });

let server: http.Server;
let port = 0;
let cookie = '';
let ready = true;
let working = false;
let pending = false;
let asks: string[] = [];
let askReply: () => Promise<string> = async () => 'It fixed the bug. Should it push?';
let spoken: string[] = [];
let heard: number[] = [];
let warmed = 0;
let messages: MobileMsg[] = [];
let screen = 'Bash command\n  git push\nDo you want to proceed?\n❯ 1. Yes\n';

function fakeVoice(): Partial<VoiceDeps> {
  return {
    chats: () => [chat({ live: live({ working }) })],
    tmux: (args) => (args[0] === 'capture-pane' ? screen : ''),
    messages: () => messages,
    canReply: () => true,
    ask: async (p) => {
      asks.push(p);
      return askReply();
    },
    transcribe: async (b) => {
      heard.push(b.length);
      return 'run the tests';
    },
    speak: async (t) => {
      spoken.push(t);
      const id = 'ab'.repeat(16);
      fs.writeFileSync(path.join(audioDir, id + '.m4a'), Buffer.from('0123456789'));
      return { id };
    },
    status: () => ({ ready, tts: 'kokoro', whisper: { bin: ready ? '/x/whisper-cli' : null, model: ready }, kokoro: { ready, venv: ready, model: ready } }),
    audioDir: () => audioDir,
    pendingTool: () => pending,
  };
}

beforeAll(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-voice-dev-'));
  const store = new DeviceStore({ file: path.join(dir, 'devices.json') });
  setDeviceStore(store);
  const code = store.startPairing().code;
  const r = store.requestPairing(code, 'Phone');
  if (!r.ok) throw new Error(r.detail);
  store.approve(r.pending_id);
  cookie = store.pairStatus(r.pending_id, r.claim).cookie!;
  setVoiceDeps(fakeVoice());
  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const route = VOICE_ROUTES.find((x) => x.path === url.pathname && x.method === req.method);
    if (!route) {
      res.writeHead(404);
      return void res.end();
    }
    const ctx: RouteCtx = {
      req,
      res,
      url,
      json: (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      },
      body: () =>
        new Promise((resolve) => {
          let s = '';
          req.on('data', (c) => (s += c));
          req.on('end', () => {
            try {
              resolve(JSON.parse(s));
            } catch {
              resolve(null);
            }
          });
        }),
    };
    Promise.resolve(route.handler!(ctx)).catch((e) => ctx.json(500, { detail: String(e) }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});
afterAll(async () => {
  setDeviceStore(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
beforeEach(() => {
  ready = true;
  working = false;
  pending = false;
  asks = [];
  spoken = [];
  heard = [];
  warmed = 0;
  askReply = async () => 'It fixed the bug. Should it push?';
  messages = [
    { role: 'user', text: 'fix the bug' },
    { role: 'assistant', text: 'Fixed.' },
  ];
  resetVoiceForTests(() => warmed++);
});

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Record<string, unknown>;
  raw: Buffer;
}
function call(method: string, p: string, body?: Buffer | string, headers: Record<string, string> = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, agent: false, headers: { cookie: `loom_device=${cookie}`, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let j: Record<string, unknown> = {};
        try {
          j = JSON.parse(raw.toString());
        } catch {
          /* audio */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: j, raw });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}
const post = (p: string, b: unknown) => call('POST', p, JSON.stringify(b), { 'content-type': 'application/json' });

describe('voice routes', () => {
  it('are all device routes under /m/api/voice', () => {
    expect(VOICE_ROUTES.every((r) => r.kind === 'device' && r.path.startsWith('/m/api/voice/'))).toBe(true);
  });

  it('status says ready and warms the voice, or points at the Mac setup', async () => {
    const a = await call('GET', '/m/api/voice/status');
    expect(a.body).toEqual({ ready: true, tts: 'kokoro' });
    expect(warmed).toBe(1);
    ready = false;
    const b = await call('GET', '/m/api/voice/status');
    expect(b.body.ready).toBe(false);
    expect(String(b.body.hint)).toContain('Settings › Devices › Conversation mode');
  });

  it('transcribes a good WAV and refuses anything else', async () => {
    const ok = await call('POST', '/m/api/voice/transcribe', wav(), { 'content-type': 'audio/wav' });
    expect(ok.status).toBe(200);
    expect(ok.body.text).toBe('run the tests');
    expect(heard).toEqual([wav().length]);
    expect((await call('POST', '/m/api/voice/transcribe', wav({ rate: 48000 }))).status).toBe(415);
    ready = false;
    expect((await call('POST', '/m/api/voice/transcribe', wav())).status).toBe(503);
  });

  it('refuses a recording over the cap', async () => {
    const big = Buffer.alloc(VOICE.maxWavBytes + 10);
    expect((await call('POST', '/m/api/voice/transcribe', big)).status).toBe(413);
  });

  it('reports the turn: working, the prompt, what was said since the user', async () => {
    working = true;
    let r = await call('GET', '/m/api/voice/turn?key=claude:s1');
    expect(r.body).toEqual({ working: true, at_prompt: false, since_user: 1, last_user: 'fix the bug', can_reply: true, live_status: null });
    working = false;
    pending = true;
    r = await call('GET', '/m/api/voice/turn?key=claude:s1');
    expect(r.body.at_prompt).toBe(true);
    expect((await call('GET', '/m/api/voice/turn?key=claude:nope')).status).toBe(404);
  });

  it('reads a busy pane as working, with its spinner line, before the board catches up', async () => {
    const was = screen;
    screen = '⏺ Reading the file\n\n✶ Pondering… (4s · ↓ 90 tokens · esc to interrupt)\n\n> \n';
    try {
      const r = await call('GET', '/m/api/voice/turn?key=claude:s1');
      expect(r.body).toMatchObject({ working: true, at_prompt: false, live_status: { text: 'Pondering… 4s · 90 tokens' } });
    } finally {
      screen = was;
    }
  });

  it('speaks a short plain reply without asking the model', async () => {
    messages = [{ role: 'user', text: 'status?' }, { role: 'assistant', text: 'Tests are green. Should I merge?' }];
    const r = await post('/m/api/voice/summary', { key: 'claude:s1' });
    expect(r.body.text).toBe('Tests are green. Should I merge?');
    expect(asks).toHaveLength(0);
  });

  it('summarizes the turn once, speaks it, and reuses it for the same turn', async () => {
    messages = [{ role: 'user', text: 'fix the bug' }, { role: 'tool', text: 'Bash: test' }, { role: 'assistant', text: 'Fixed it in `src/a.ts`.' }];
    const a = await post('/m/api/voice/summary', { key: 'claude:s1' });
    expect(a.body).toEqual({ ok: true, text: 'It fixed the bug. Should it push?', audio: 'ab'.repeat(16) });
    expect(asks).toHaveLength(1);
    expect(asks[0]).toContain('Fixed it in');
    expect(asks[0]).not.toContain('<screen>');
    expect(spoken).toEqual(['It fixed the bug. Should it push?']);
    await post('/m/api/voice/summary', { key: 'claude:s1' });
    expect(asks).toHaveLength(1);
  });

  it('shows the model the screen at a permission prompt, and falls back when the model fails', async () => {
    pending = true;
    askReply = async () => {
      throw new Error('offline');
    };
    const r = await post('/m/api/voice/summary', { key: 'claude:s1' });
    expect(asks[0]).toContain('Do you want to proceed?');
    expect(r.body.text).toBe('Fixed. It is waiting for your permission to continue.');
  });

  it('serves the audio whole and by range, and nothing else', async () => {
    await post('/m/api/voice/summary', { key: 'claude:s1' });
    const id = 'ab'.repeat(16);
    const full = await call('GET', '/m/api/voice/audio?id=' + id);
    expect(full.status).toBe(200);
    expect(full.headers['content-type']).toBe('audio/mp4');
    expect(full.raw.toString()).toBe('0123456789');
    const part = await call('GET', '/m/api/voice/audio?id=' + id, undefined, { range: 'bytes=0-1' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 0-1/10');
    expect(part.raw.toString()).toBe('01');
    expect((await call('GET', '/m/api/voice/audio?id=../../etc/passwd')).status).toBe(404);
    expect((await call('GET', '/m/api/voice/audio?id=' + 'cd'.repeat(16))).status).toBe(404);
  });

  it('prunes old audio', () => {
    const f = path.join(audioDir, 'ef'.repeat(16) + '.m4a');
    fs.writeFileSync(f, 'x');
    pruneAudio(audioDir, Date.now() + VOICE.audioTtlMs + 1000);
    expect(fs.existsSync(f)).toBe(false);
  });
});

/* ------------------------------------------------------------ setup */

describe('voice setup', () => {
  let dir = '';
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'loom-voice-'));
    setVoiceDir(dir);
    resetInstallJob();
  });
  afterAll(() => setVoiceDir(null));

  it('reads the status from the files', () => {
    const none = voiceStatus({ which: () => null, exists: () => false });
    expect(none).toEqual({ ready: false, whisper: { bin: null, model: false }, kokoro: { ready: false, venv: false, model: false }, tts: 'macos' });
    const p = voicePaths();
    fs.mkdirSync(p.models, { recursive: true });
    fs.writeFileSync(path.join(p.models, WHISPER_MODEL.file), '');
    fs.truncateSync(path.join(p.models, WHISPER_MODEL.file), WHISPER_MODEL.bytes);
    const s = voiceStatus({ which: (n) => (n === 'whisper-cli' ? '/opt/x/whisper-cli' : null), exists: () => false });
    expect(s.ready).toBe(true);
    expect(s.tts).toBe('macos');
  });

  function fakeInstall(have: Record<string, string>): { d: InstallDeps; runs: string[] } {
    const runs: string[] = [];
    const sizes = new Map<string, number>();
    const all = [WHISPER_MODEL, ...KOKORO_FILES];
    const d: InstallDeps = {
      run: async (bin, args) => {
        runs.push([path.basename(bin), ...args.filter((a) => !a.startsWith('/') && !a.startsWith('http'))].join(' '));
        if (bin.endsWith('curl')) {
          const part = args[args.indexOf('-o') + 1];
          fs.writeFileSync(part, '');
          const f = all.find((x) => part.endsWith(x.file + '.part'))!;
          sizes.set(part.replace(/\.part$/, ''), f.bytes);
        }
        if (args[0] === '-m' && args[1] === 'venv') have.venv = 'yes';
      },
      which: (n) => have[n] ?? null,
      exists: (p) => (p.endsWith('/bin/python') ? !!have.venv : p.endsWith('/bin/brew') ? !!have.brew : false),
      size: (p) => sizes.get(p) ?? 0,
    };
    return { d, runs };
  }
  const settle = async () => {
    for (let i = 0; i < 100 && installJob()?.running; i++) await new Promise((r) => setTimeout(r, 5));
  };

  it('installs whisper with brew, downloads the models and builds the Kokoro venv', async () => {
    const { d, runs } = fakeInstall({ brew: '/opt/homebrew/bin/brew', 'python3.12': '/opt/homebrew/bin/python3.12' });
    const j = startVoiceInstall(d);
    expect(startVoiceInstall(d)).toBe(j); // one at a time
    await settle();
    expect(j.steps.map((s) => s.state)).toEqual(['done', 'done', 'done']);
    expect(runs[0]).toBe('brew install whisper-cpp');
    expect(runs.filter((r) => r.startsWith('curl'))).toHaveLength(3);
    expect(runs).toContain('python3.12 -m venv');
    expect(runs.some((r) => r.includes('pip install') && r.includes('kokoro-onnx'))).toBe(true);
    expect(fs.existsSync(path.join(voicePaths().models, WHISPER_MODEL.file))).toBe(true);
  });

  it('skips what is there and reports what it cannot do', async () => {
    const { d, runs } = fakeInstall({ 'whisper-cli': '/opt/homebrew/bin/whisper-cli' });
    const j = startVoiceInstall(d);
    await settle();
    expect(j.steps[0].state).toBe('skipped');
    expect(j.steps[1].state).toBe('done');
    expect(j.steps[2].state).toBe('error');
    expect(j.steps[2].detail).toMatch(/Python 3.10/);
    expect(runs.some((r) => r.startsWith('brew'))).toBe(false);
    expect(runs.some((r) => r.startsWith('whisper-cli -m'))).toBe(true); // the Metal warm-up
    expect(j.running).toBe(false);
  });

  it('needs Homebrew for whisper', async () => {
    const { d } = fakeInstall({});
    const j = startVoiceInstall(d);
    await settle();
    expect(j.steps[0].state).toBe('error');
    expect(j.steps[0].detail).toMatch(/Homebrew/);
  });
});

/* ------------------------------------------------------------ the scripts */

describe('the Talk overlay script', () => {
  it('has no backtick or dollar-brace, and parses', () => {
    for (const s of [VOICE_JS, VOICE_CSS]) {
      expect(s).not.toContain('`');
      expect(s).not.toContain('${');
    }
    expect(() => new vm.Script(VOICE_JS)).not.toThrow();
  });

  it('encodes the WAV the Mac accepts', async () => {
    const ctx: Record<string, unknown> = { window: {}, Blob, document: {}, navigator: {} };
    vm.createContext(ctx);
    vm.runInContext(VOICE_JS, ctx);
    const T = (ctx.window as { LoomTalk: { _wav: (s: Float32Array, r: number) => Blob; _resample: (c: Float32Array[], r: number, o: number) => Float32Array } }).LoomTalk;
    const at48 = new Float32Array(48000).map((_, i) => Math.sin(i / 10) * 0.5);
    const s16 = T._resample([at48.subarray(0, 24000), at48.subarray(24000)], 48000, 16000);
    expect(s16.length).toBe(16000);
    const blob = T._wav(s16, 16000);
    expect(checkWav(Buffer.from(await blob.arrayBuffer()))).toBeNull();
  });
});

describe('Settings › Devices conversation mode row', () => {
  const render = (voice: unknown): string => {
    const ctx: Record<string, unknown> = {
      sxEsc: (x: unknown) => String(x),
      sxGrp: (t: string) => `<h>${t}</h>`,
      sxBtn: (a: string, l: string) => `[${a}:${l}]`,
      sxNote: (t: string) => t,
      sxRow: (t: string, d: string, r: string) => `${t}|${r}`,
      sxPill: (k: string, t: string) => `(${t})`,
      sxRerender: () => {},
      sxJ: () => Promise.resolve(null),
      window: {},
      document: {},
    };
    vm.createContext(ctx);
    vm.runInContext(DEVICES_VIEW_JS, ctx);
    return vm.runInContext('devVoice(' + JSON.stringify(voice) + ')', ctx) as string;
  };
  const none = { ready: false, tts: 'macos', whisper: { bin: null, model: false }, kokoro: { ready: false, venv: false, model: false }, install: null };

  it('offers the install when nothing is there', () => {
    const h = render(none);
    expect(h).toContain('<h>Conversation mode</h>');
    expect(h).toContain('(Not set up)');
    expect(h).toContain('[dev_voice:Install voice models]');
  });
  it('shows progress and errors while installing', () => {
    const h = render({ ...none, install: { running: true, steps: [{ state: 'done' }, { state: 'running', detail: 'downloading', progress: 0.42 }, { state: 'pending' }], error: '' } });
    expect(h).toContain('(Installing)');
    expect(h).toContain('downloading · 42%');
    const e = render({ ...none, install: { running: false, steps: [{ state: 'error', detail: 'Homebrew is not installed' }, { state: 'pending' }, { state: 'pending' }], error: '' } });
    expect(e).toContain('Homebrew is not installed');
  });
  it('is quiet once everything is ready', () => {
    const h = render({ ready: true, tts: 'kokoro', whisper: { bin: '/x', model: true }, kokoro: { ready: true, venv: true, model: true }, install: null });
    expect(h).toContain('(Ready)');
    expect(h).not.toContain('[dev_voice');
  });
});
