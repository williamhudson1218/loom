// The keymap registry: the single list of every keyboard binding Loom has. Three
// things read it, so a stale entry cannot exist:
//   1. the dashboard's page keydown dispatcher (entries with bound:'page'),
//   2. the Electron menu accelerators (entries with an `accelerator`; app/main.ts
//      reads menuAccelerators()),
//   3. the Settings > Help shortcut list and the tour copy (keymapForPage()).
// Entries bound elsewhere ('native' = Electron, 'outbox' / 'dialog' = a handler
// local to one surface) are listed for display only; tests/keymap pins each
// 'page' entry to an action in the dashboard and each dashboard action to an entry.

export type KeyScope = 'global' | 'page' | 'dialog';
export type KeyBound = 'page' | 'native' | 'dialog';

export interface KeyMatch {
  key: string; // KeyboardEvent.key, lower-cased for letters
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
  /** true: fires only with no modifier held and not while typing in a field */
  plain?: boolean;
}

export interface KeyBinding {
  /** Stable id; for bound:'page' it is the key into the page's KEY_ACTIONS table. */
  action: string;
  /** Display string, e.g. ⌘, */
  keys: string;
  scope: KeyScope;
  label: string;
  bound: KeyBound;
  match?: KeyMatch;
  /** Electron accelerator, when the binding is also a menu item. */
  accelerator?: string;
  /** Display keys come from a setting (the user's own binding), not from `keys`. */
  setting?: string;
}

export const KEYMAP: KeyBinding[] = [
  { action: 'settings', keys: '⌘,', scope: 'global', label: 'Open Settings', bound: 'page',
    match: { key: ',', meta: true }, accelerator: 'Command+,' },
  { action: 'newThread', keys: '⌘N', scope: 'global', label: 'New thread', bound: 'page',
    match: { key: 'n', meta: true }, accelerator: 'Command+N' },
  { action: 'dismiss', keys: 'Esc', scope: 'page', label: 'Close the open menu or deselect the chat', bound: 'page',
    match: { key: 'Escape' } },
  { action: 'slackPick', keys: '⌘⇧L', scope: 'global', label: 'Pick a Slack message to open its chat', bound: 'native',
    setting: 'slack_goto_hotkey' },
  { action: 'dialogConfirm', keys: 'Enter', scope: 'dialog', label: 'Confirm in a dialog', bound: 'dialog' },
  { action: 'launchThread', keys: '⌘↵', scope: 'dialog', label: 'Start the thread (new thread composer)', bound: 'dialog' },
  { action: 'outboxPost', keys: 'Enter', scope: 'dialog', label: 'Outbox: post and keep the chat', bound: 'dialog' },
  { action: 'outboxPostPark', keys: '⌥Enter', scope: 'dialog', label: 'Outbox: post and park the chat', bound: 'dialog' },
  { action: 'outboxPostClose', keys: '⇧Enter', scope: 'dialog', label: 'Outbox: post and close the chat', bound: 'dialog' },
];

/** Bindings the page dispatcher handles itself, in registry order. */
export function pageBindings(map: KeyBinding[] = KEYMAP): KeyBinding[] {
  return map.filter((k) => k.bound === 'page' && k.match);
}

/** The Electron menu list: what app/main.ts should turn into accelerators. */
export function menuAccelerators(map: KeyBinding[] = KEYMAP): { action: string; accelerator: string; label: string }[] {
  return map.filter((k) => k.accelerator).map((k) => ({ action: k.action, accelerator: k.accelerator!, label: k.label }));
}

/** Electron accelerator ("Command+Shift+L") to the symbols a person reads (⌘⇧L). */
export function formatAccelerator(acc: string): string {
  const sym: Record<string, string> = { command: '⌘', cmd: '⌘', commandorcontrol: '⌘', control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧' };
  return acc.split('+').map((p) => sym[p.toLowerCase()] ?? p).join('');
}

/** The list the Help view and the tour render. `settings` resolves `setting` rows. */
export function keymapForPage(settings: Record<string, string | undefined> = {}, map: KeyBinding[] = KEYMAP): { keys: string; label: string; scope: KeyScope }[] {
  const out: { keys: string; label: string; scope: KeyScope }[] = [];
  for (const k of map) {
    let keys = k.keys;
    if (k.setting) {
      const v = settings[k.setting];
      if (!v) continue; // a binding the user has not set is not a shortcut yet
      keys = formatAccelerator(v);
    }
    out.push({ keys, label: k.label, scope: k.scope });
  }
  return out;
}

/** The page-side registry, embedded in the dashboard (match rules only). */
export function pageKeymapJson(): string {
  return JSON.stringify(pageBindings().map((k) => ({ action: k.action, match: k.match })));
}
