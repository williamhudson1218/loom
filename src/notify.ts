import { execFile } from 'node:child_process';
import { openDb } from './db.ts';
import { getSetting } from './settingsSchema.ts';

/** What a notification is about; a click brings the user there. */
export type NotifyTarget = { agent: string; sid: string } | { pr: string } | { orch: true } | undefined;

export interface NotifyInput {
  title: string;
  body: string;
  target?: NotifyTarget;
}

type AppNotifier = (n: NotifyInput & { sound: string }) => void;

let appNotifier: AppNotifier | null = null;

/** The Electron app registers its own notifier so a click can open the chat. Pass null to unregister. */
export function setAppNotifier(fn: AppNotifier | null): void {
  appNotifier = fn;
}

/** The AppleScript for a notification with the `notify_sound` setting: off = silent, system = the default sound. */
export function notifyScript(title: string, body: string, sound: string): string {
  const esc = (t: string) => t.replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 240);
  const name = sound === 'off' ? '' : sound === 'system' ? 'default' : sound;
  return `display notification "${esc(body)}" with title "${esc(title)}"` + (name ? ` sound name "${esc(name)}"` : '');
}

export function notifySound(): string {
  try {
    const db = openDb();
    try {
      return getSetting(db, 'notify_sound') as string;
    } finally {
      db.close();
    }
  } catch {
    return 'system';
  }
}

/** Notify the user. In the app a click opens the target; otherwise (CLI, tests) osascript, which cannot. */
export function notifyUser(n: NotifyInput, opts: { sound?: string; run?: typeof execFile } = {}): void {
  const sound = opts.sound ?? notifySound();
  if (appNotifier) {
    try {
      appNotifier({ ...n, sound });
      return;
    } catch {
      /* fall through to the osascript path */
    }
  }
  (opts.run ?? execFile)('osascript', ['-e', notifyScript(n.title, n.body, sound)], () => {});
}
