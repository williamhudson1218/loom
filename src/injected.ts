// Classifies a user-role transcript turn that Will did not type: a message from another Loom
// agent (`[to <name> from <sender>]`, sent with `loom route send`), text Loom itself typed into
// the pane, or a Claude Code injection (teammate message, task notification, system reminder).
// One function, used server-side by every transcript reader, so clients never carry the regexes.

export interface InjectedSrc {
  kind: 'agent' | 'loom' | 'system';
  /** The small label shown above the bubble: a worker name, "Loom", "Task", "System". */
  label: string;
}

export interface Injected extends InjectedSrc {
  /** The text to display: the routing prefix or wrapper tags stripped. */
  body: string;
}

const ROUTE = /^\[to\s+([^\]\s]+)\s+from\s+([^\]\s]+)\]\s*/i;
const TEAMMATE = /^<teammate-message\b([^>]*)>([\s\S]*?)(?:<\/teammate-message>\s*)?$/;
const TASK_NOTE = /^<task-notification\b/;
const REMINDER_ONLY = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/;
const LOOM_TAG = /^\[(Loom events|Loom action \d+|Loom [^\]]{1,40})\]\s*/;
const LOOM_STARTED = /^Loom (?:re)?started you\b/;

export function classifyInjected(text: string): Injected | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const route = ROUTE.exec(t);
  if (route) return { kind: 'agent', label: route[2], body: t.slice(route[0].length).trim() };
  const tm = TEAMMATE.exec(t);
  if (tm) {
    const id = /teammate_id="([^"]*)"/.exec(tm[1]);
    return { kind: 'agent', label: id?.[1] || 'teammate', body: tm[2].trim() };
  }
  if (TASK_NOTE.test(t)) return { kind: 'system', label: 'Task', body: t };
  if (REMINDER_ONLY.test(t)) return { kind: 'system', label: 'System', body: t.replace(/<\/?system-reminder>/g, '').trim() };
  const tag = LOOM_TAG.exec(t);
  if (tag) return { kind: 'loom', label: 'Loom', body: t };
  if (LOOM_STARTED.test(t)) return { kind: 'loom', label: 'Loom', body: t };
  return null;
}

/** The `{text, src}` pair a reader emits for a user turn: the body, plus src when it was injected. */
export function userTurn(text: string): { text: string; src?: InjectedSrc } {
  const c = classifyInjected(text);
  return c ? { text: c.body || text, src: { kind: c.kind, label: c.label } } : { text };
}
