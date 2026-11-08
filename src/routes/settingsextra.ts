import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { openDb } from '../db.ts';
import { TOOL_DIR } from '../paths.ts';
import { getSetting } from '../settingsSchema.ts';
import { probeEnvironment, clearProbeMemo } from '../probe.ts';
import { ORCH_PROMPT, ORCH_PROMPT_OVERRIDE, orchDir } from '../orchsession.ts';
import { refreshDirectory } from '../slackdir.ts';
import { slackFeatureOn } from '../slackmode.ts';
import type { RouteCtx, RouteDef } from './index.ts';

// Small rows of Settings that need the server: the environment probe, the orchestrator
// prompt override, the Slack directory refresh, the sound preview and the log folder.
// Every write is `browser` kind; tests/auth.test.ts sweeps this list.

const overridePath = () => path.join(orchDir(TOOL_DIR), ORCH_PROMPT_OVERRIDE);

function withDb<T>(fn: (db: ReturnType<typeof openDb>) => T): T {
  const db = openDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

async function probe({ json, url }: RouteCtx): Promise<void> {
  const { claudeBin, extraPath } = withDb((db) => ({
    claudeBin: getSetting(db, 'claude_bin', { env: false }) as string,
    extraPath: getSetting(db, 'extra_path', { env: false }) as string[],
  }));
  if (url.searchParams.get('fresh') === '1') clearProbeMemo();
  const r = await probeEnvironment({ claudeBin: claudeBin || undefined, extraPath });
  json(200, { ok: true, probe: r });
}

function getOverride({ json }: RouteCtx): void {
  let text = '';
  try {
    text = fs.readFileSync(overridePath(), 'utf-8');
  } catch {
    /* none */
  }
  json(200, { ok: true, override: text, default: ORCH_PROMPT, active: text.trim() ? 'override' : 'default', path: overridePath() });
}

async function putOverride({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  if (!b || typeof b.text !== 'string') return json(400, { ok: false, detail: 'text is required' });
  if (b.text.length > 64_000) return json(400, { ok: false, detail: 'prompt is too long' });
  const p = overridePath();
  if (!b.text.trim()) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* already gone */
    }
  } else {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, b.text.endsWith('\n') ? b.text : b.text + '\n');
  }
  json(200, { ok: true, active: b.text.trim() ? 'override' : 'default' });
}

async function refreshDir({ json }: RouteCtx): Promise<void> {
  if (!slackFeatureOn('directory')) return json(409, { ok: false, error: 'slack_off', hint: 'Slack is not connected as a Direct app.' });
  try {
    const d = await refreshDirectory();
    json(200, { ok: true, fetchedAt: d.fetchedAt, people: Object.keys(d.users).length, channels: Object.keys(d.channels).length, emoji: Object.keys(d.custom).length });
  } catch (e) {
    json(502, { ok: false, detail: (e as Error).message.slice(0, 200) });
  }
}

const SOUND_RE = /^[A-Za-z]{2,20}$/;

async function previewSound({ json, body }: RouteCtx): Promise<void> {
  const b = await body();
  const name = typeof b?.name === 'string' ? b.name : withDb((db) => getSetting(db, 'notify_sound', { env: false }) as string);
  if (name === 'off') return json(200, { ok: true, played: false });
  if (name !== 'system' && !SOUND_RE.test(name)) return json(400, { ok: false, detail: 'unknown sound' });
  const file = name === 'system' ? '/System/Library/Sounds/Funk.aiff' : `/System/Library/Sounds/${name}.aiff`;
  if (!fs.existsSync(file)) return json(404, { ok: false, detail: 'that sound is not installed' });
  execFile('afplay', [file], () => {});
  json(200, { ok: true, played: true });
}

function openLogs({ json }: RouteCtx): void {
  execFile('open', [TOOL_DIR], () => {});
  json(200, { ok: true, path: TOOL_DIR });
}

export const routes: RouteDef[] = [
  { method: 'GET', path: '/api/probe', kind: 'read', handler: probe },
  { method: 'GET', path: '/api/orchestrator/prompt-override', kind: 'read', handler: getOverride },
  { method: 'PUT', path: '/api/orchestrator/prompt-override', kind: 'browser', handler: putOverride },
  { method: 'POST', path: '/api/slack/directory/refresh', kind: 'browser', handler: refreshDir },
  { method: 'POST', path: '/api/sound/preview', kind: 'browser', handler: previewSound },
  { method: 'POST', path: '/api/logs/open', kind: 'browser', handler: openLogs },
];
