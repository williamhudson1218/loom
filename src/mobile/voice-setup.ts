import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { TOOL_DIR } from '../paths.ts';
import { resolveTool, toolEnv } from '../toolpath.ts';

// Conversation mode's local models (src/mobile/voice.ts uses them). Everything lives
// under ~/.loom/voice:
//   models/ggml-large-v3-turbo-q5_0.bin   whisper.cpp speech-to-text (whisper-cli from Homebrew)
//   kokoro-venv/                          a private Python venv with kokoro-onnx
//   models/kokoro-v1.0.onnx, voices-v1.0.bin   the Kokoro voice (Apache-2.0)
//   tmp/                                  short-lived audio, pruned by voice.ts
// Without Kokoro the voice falls back to macOS `say`; without whisper there is no
// conversation mode. Settings › Devices shows the status and runs the install below.

export const WHISPER_MODEL = {
  file: 'ggml-large-v3-turbo-q5_0.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
  bytes: 574_041_195,
};
const KOKORO_BASE = 'https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/';
export const KOKORO_FILES = [
  { file: 'kokoro-v1.0.onnx', url: KOKORO_BASE + 'kokoro-v1.0.onnx', bytes: 325_532_387 },
  { file: 'voices-v1.0.bin', url: KOKORO_BASE + 'voices-v1.0.bin', bytes: 28_214_398 },
];

export interface VoicePaths {
  dir: string;
  models: string;
  tmp: string;
  venv: string;
  python: string;
}

let dirOverride: string | null = null;
/** Tests point the voice dir at a temp dir. */
export function setVoiceDir(d: string | null): void {
  dirOverride = d;
}

export function voicePaths(): VoicePaths {
  const dir = dirOverride ?? path.join(TOOL_DIR, 'voice');
  const venv = path.join(dir, 'kokoro-venv');
  return { dir, models: path.join(dir, 'models'), tmp: path.join(dir, 'tmp'), venv, python: path.join(venv, 'bin', 'python') };
}

/** A finished download: present and at least 90% of the size we expect (sizes drift a little between releases). */
function haveFile(p: string, bytes: number): boolean {
  try {
    return fs.statSync(p).size >= bytes * 0.9;
  } catch {
    return false;
  }
}

export interface VoiceStatus {
  /** whisper-cli and its model: conversation mode works. */
  ready: boolean;
  whisper: { bin: string | null; model: boolean };
  kokoro: { ready: boolean; venv: boolean; model: boolean };
  /** The voice the phone hears. */
  tts: 'kokoro' | 'macos';
}

export interface StatusDeps {
  which: (name: string) => string | null;
  exists: (p: string) => boolean;
}

const realStatusDeps: StatusDeps = { which: (n) => resolveTool(n), exists: (p) => fs.existsSync(p) };

export function whisperBin(d: StatusDeps = realStatusDeps): string | null {
  return d.which('whisper-cli');
}

export function voiceStatus(d: StatusDeps = realStatusDeps): VoiceStatus {
  const p = voicePaths();
  const bin = whisperBin(d);
  const model = haveFile(path.join(p.models, WHISPER_MODEL.file), WHISPER_MODEL.bytes);
  const venv = d.exists(p.python);
  const kmodel = KOKORO_FILES.every((f) => haveFile(path.join(p.models, f.file), f.bytes));
  const kokoro = venv && kmodel;
  return { ready: !!bin && model, whisper: { bin, model }, kokoro: { ready: kokoro, venv, model: kmodel }, tts: kokoro ? 'kokoro' : 'macos' };
}

/* ------------------------------------------------------------ the installer */

export type StepState = 'pending' | 'running' | 'done' | 'skipped' | 'error';
export interface InstallStep {
  key: 'whisper' | 'model' | 'kokoro';
  label: string;
  state: StepState;
  detail: string;
  /** 0..1 while a download runs. */
  progress?: number;
}
export interface InstallJob {
  running: boolean;
  started_at: number;
  finished_at: number;
  steps: InstallStep[];
  error: string;
}

export interface InstallDeps {
  /** Run a command to completion; rejects with the tail of its output on a non-zero exit. */
  run: (bin: string, args: string[], opts?: { cwd?: string }) => Promise<void>;
  which: (name: string) => string | null;
  exists: (p: string) => boolean;
  size: (p: string) => number;
}

function tailOf(s: string): string {
  return s.trim().split('\n').slice(-3).join(' ').slice(-300);
}

export const realInstallDeps: InstallDeps = {
  run: (bin, args, opts = {}) =>
    new Promise((resolve, reject) => {
      // HOMEBREW_NO_AUTO_UPDATE keeps `brew install` from first updating every tap.
      const env = { ...toolEnv(bin), HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_INSTALL_CLEANUP: '1', PIP_DISABLE_PIP_VERSION_CHECK: '1' };
      const p = spawn(bin, args, { cwd: opts.cwd ?? os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      const keep = (b: Buffer) => {
        out = (out + b.toString()).slice(-4000);
      };
      p.stdout.on('data', keep);
      p.stderr.on('data', keep);
      p.on('error', (e) => reject(new Error(`${path.basename(bin)}: ${e.message}`)));
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}: ${tailOf(out)}`))));
    }),
  which: (n) => resolveTool(n),
  exists: (p) => fs.existsSync(p),
  size: (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  },
};

let job: InstallJob | null = null;

export function installJob(): InstallJob | null {
  return job;
}

/** Tests. */
export function resetInstallJob(): void {
  job = null;
}

const PYTHONS = ['python3.13', 'python3.12', 'python3.11', 'python3.10'];

/** A Python new enough for kokoro-onnx (3.10+). macOS's own python3 is 3.9. */
function findPython(d: InstallDeps): string | null {
  for (const n of PYTHONS) {
    const p = d.which(n);
    if (p) return p;
  }
  return null;
}

/** curl with resume into <file>.part, renamed on success; progress read from the part file's size. */
async function download(d: InstallDeps, step: InstallStep, dest: string, url: string, bytes: number, share: [number, number] = [0, 1]): Promise<void> {
  if (haveFileWith(d, dest, bytes)) return;
  const part = dest + '.part';
  const t = setInterval(() => {
    step.progress = share[0] + (share[1] - share[0]) * Math.min(1, d.size(part) / bytes);
  }, 500);
  try {
    await d.run('/usr/bin/curl', ['-fsSL', '--retry', '3', '-C', '-', '-o', part, url]);
  } finally {
    clearInterval(t);
  }
  fs.renameSync(part, dest);
}

/** A second of silence as 16 kHz mono 16-bit WAV. */
export function silentWav(samples: number): Buffer {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8, 'latin1');
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36, 'latin1');
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

function haveFileWith(d: InstallDeps, p: string, bytes: number): boolean {
  return d.size(p) >= bytes * 0.9;
}

async function runStep(step: InstallStep, fn: () => Promise<'done' | 'skipped'>): Promise<boolean> {
  step.state = 'running';
  try {
    step.state = await fn();
    step.progress = undefined;
    return true;
  } catch (e) {
    step.state = 'error';
    step.detail = (e as Error).message.slice(0, 400);
    return false;
  }
}

/**
 * Install whatever is missing, in the background. Returns the job at once; a second call
 * while one runs returns the running job. Kokoro failing leaves the macOS voice in place,
 * so it is the last step and does not fail the whole job's usefulness.
 */
export function startVoiceInstall(d: InstallDeps = realInstallDeps): InstallJob {
  if (job?.running) return job;
  const p = voicePaths();
  const steps: InstallStep[] = [
    { key: 'whisper', label: 'whisper.cpp (Homebrew)', state: 'pending', detail: '' },
    { key: 'model', label: 'Speech model (large-v3-turbo, 574 MB)', state: 'pending', detail: '' },
    { key: 'kokoro', label: 'Kokoro voice (Python venv + 350 MB model)', state: 'pending', detail: '' },
  ];
  const j: InstallJob = { running: true, started_at: Date.now(), finished_at: 0, steps, error: '' };
  job = j;
  const run = async () => {
    fs.mkdirSync(p.models, { recursive: true });
    await runStep(steps[0], async () => {
      if (d.which('whisper-cli')) return 'skipped';
      const brew = d.which('brew') ?? (d.exists('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : d.exists('/usr/local/bin/brew') ? '/usr/local/bin/brew' : null);
      if (!brew) throw new Error('Homebrew is not installed. Install it from brew.sh, then try again.');
      steps[0].detail = 'brew install whisper-cpp';
      await d.run(brew, ['install', 'whisper-cpp']);
      steps[0].detail = '';
      return 'done';
    });
    await runStep(steps[1], async () => {
      const dest = path.join(p.models, WHISPER_MODEL.file);
      const had = haveFileWith(d, dest, WHISPER_MODEL.bytes);
      if (!had) await download(d, steps[1], dest, WHISPER_MODEL.url, WHISPER_MODEL.bytes);
      // whisper.cpp compiles its Metal shaders on the very first run (~20 s): pay that here, not on the first Talk.
      const bin = d.which('whisper-cli');
      if (bin && !had) {
        steps[1].detail = 'warming up';
        const f = path.join(p.models, 'warmup.wav');
        fs.writeFileSync(f, silentWav(16000));
        try {
          await d.run(bin, ['-m', dest, '-f', f, '-l', 'en', '-nt', '-np']);
        } catch {
          /* only a warm-up */
        } finally {
          fs.rmSync(f, { force: true });
        }
        steps[1].detail = '';
      }
      return had ? 'skipped' : 'done';
    });
    await runStep(steps[2], async () => {
      const filesThere = KOKORO_FILES.every((f) => haveFileWith(d, path.join(p.models, f.file), f.bytes));
      if (filesThere && d.exists(p.python)) return 'skipped';
      if (!d.exists(p.python)) {
        const uv = d.which('uv');
        const py = findPython(d);
        if (uv) {
          steps[2].detail = 'uv venv';
          await d.run(uv, ['venv', '--python', '3.12', p.venv]);
          steps[2].detail = 'installing kokoro-onnx';
          await d.run(uv, ['pip', 'install', '--python', p.python, 'kokoro-onnx', 'soundfile']);
        } else if (py) {
          steps[2].detail = 'python venv';
          await d.run(py, ['-m', 'venv', p.venv]);
          steps[2].detail = 'installing kokoro-onnx';
          await d.run(p.python, ['-m', 'pip', 'install', '-q', 'kokoro-onnx', 'soundfile']);
        } else throw new Error('Needs Python 3.10 or newer (brew install python@3.12) or uv. Using the macOS voice for now.');
      }
      const total = KOKORO_FILES.reduce((n, f) => n + f.bytes, 0);
      let at = 0;
      for (const f of KOKORO_FILES) {
        steps[2].detail = 'downloading ' + f.file;
        await download(d, steps[2], path.join(p.models, f.file), f.url, f.bytes, [at / total, (at + f.bytes) / total]);
        at += f.bytes;
      }
      steps[2].detail = '';
      return 'done';
    });
  };
  run()
    .catch((e) => {
      j.error = (e as Error).message;
    })
    .finally(() => {
      j.running = false;
      j.finished_at = Date.now();
    });
  return j;
}

/** Settings › Devices: the status plus the install job, all plain facts. */
export function voiceSetupView(d: StatusDeps = realStatusDeps) {
  return { ...voiceStatus(d), install: job };
}
