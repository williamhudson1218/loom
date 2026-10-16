import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOL_DIR } from './paths.ts';
import { CHANNELS_PATH, SLACK_CLI, THREADS_CLI, defaultRunner, type Runner } from './slack.ts';

// Slack drafts awaiting Will's okay, recorded by chats through
// `slack-threads outbox add` (~/.claude/state/slack-outbox.json). Loom reads the
// file directly and makes every change through the same CLI, so the CLI's lock
// is the only writer and a chat and Loom can never both "send" one draft: the
// status is re-read at send time and a draft that is no longer pending is refused.

export const OUTBOX_PATH = path.join(os.homedir(), '.claude', 'state', 'slack-outbox.json');

export interface Draft {
  id: string;
  session_id: string;
  channel: string;
  thread_ts?: string;
  thread_url?: string;
  messages: string[];
  status: string; // pending | sent | discarded | superseded
  created_at: string;
  permalink?: string;
  label?: string; // the channel's #name / @dm from the hook's cache, added on read
}

export function readOutbox(file: string = OUTBOX_PATH): Record<string, Draft> {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf-8')) as { drafts?: Record<string, Draft> };
    return d.drafts ?? {};
  } catch {
    return {};
  }
}

export function pendingDrafts(file: string = OUTBOX_PATH, labelsFile: string = CHANNELS_PATH): Draft[] {
  let labels: Record<string, string> = {};
  try {
    labels = JSON.parse(fs.readFileSync(labelsFile, 'utf-8'));
  } catch {
    /* unlabeled: the raw destination shows instead */
  }
  return Object.values(readOutbox(file))
    .filter((d) => d.status === 'pending' && Array.isArray(d.messages) && d.messages.length)
    .map((d) => ({ ...d, label: labels[d.channel] ?? d.channel }))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The exact payload `slack.mjs send` posts. One message is `text`; several are a burst. */
export function sendPayload(d: Pick<Draft, 'channel' | 'thread_ts'>, messages: string[]): Record<string, unknown> {
  return {
    channel: d.channel,
    ...(messages.length === 1 ? { text: messages[0] } : { messages }),
    ...(d.thread_ts ? { thread_ts: d.thread_ts } : {}),
  };
}

export interface SendResult {
  ok: boolean;
  detail: string;
  dry?: boolean;
  permalink?: string;
  rendered?: string;
}

/**
 * Post a draft as Will, exactly as the confirm dialog showed it, then mark it
 * sent. `dry` swaps `send` for `preview`, which renders the same payload and
 * touches nothing — the draft stays pending.
 */
export async function sendDraft(
  id: string,
  messages: string[],
  opts: { dry?: boolean; run?: Runner; file?: string } = {},
): Promise<SendResult> {
  const run = opts.run ?? defaultRunner;
  const d = readOutbox(opts.file)[id];
  if (!d) return { ok: false, detail: 'no such draft' };
  if (d.status !== 'pending') return { ok: false, detail: `already ${d.status}` };
  const clean = messages.map((m) => (typeof m === 'string' ? m.trim() : '')).filter(Boolean);
  if (!clean.length || clean.length !== messages.length) return { ok: false, detail: 'every message needs text' };
  const tmpDir = path.join(TOOL_DIR, 'outbox-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const payloadFile = path.join(tmpDir, `${id}-${Date.now()}.json`);
  // preview renders `text` only, so a dry run of a burst previews each message.
  const payloads = opts.dry ? clean.map((m) => sendPayload(d, [m])) : [sendPayload(d, clean)];
  try {
    const outs: string[] = [];
    for (const p of payloads) {
      fs.writeFileSync(payloadFile, JSON.stringify(p));
      outs.push(await run('node', [SLACK_CLI, opts.dry ? 'preview' : 'send', '--file', payloadFile]));
    }
    if (opts.dry) return { ok: true, dry: true, detail: 'dry run: nothing posted', rendered: outs.join('\n---\n') };
    let permalink = '';
    try {
      permalink = String(JSON.parse(outs[0]).permalink ?? '');
    } catch {
      /* posted; the permalink is a nicety */
    }
    try {
      await run(THREADS_CLI, ['outbox', 'sent', id, '--by', 'loom', ...(permalink ? ['--permalink', permalink] : [])]);
    } catch (e) {
      // The message IS out. Say so loudly rather than report a failure that invites a resend.
      return { ok: true, permalink, detail: 'posted, but marking it sent failed: ' + (e as Error).message };
    }
    return { ok: true, permalink, detail: 'posted' };
  } catch (e) {
    return { ok: false, detail: 'send failed: ' + (e as Error).message };
  } finally {
    fs.rmSync(payloadFile, { force: true });
  }
}

export async function discardDraft(id: string, run: Runner = defaultRunner, file?: string): Promise<SendResult> {
  const d = readOutbox(file)[id];
  if (!d) return { ok: false, detail: 'no such draft' };
  if (d.status !== 'pending') return { ok: false, detail: `already ${d.status}` };
  try {
    await run(THREADS_CLI, ['outbox', 'discard', id]);
    return { ok: true, detail: 'discarded' };
  } catch (e) {
    return { ok: false, detail: 'discard failed: ' + (e as Error).message };
  }
}
