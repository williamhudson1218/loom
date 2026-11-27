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
// Claude Code wraps a peer's message: an optional "Another Claude session sent a message:" line,
// the tag, then a footer about peers not granting permissions. Only the tag's inside is shown.
const TEAMMATE = /^(?:Another Claude session sent a message:\s*)?<teammate-message\b([^>]*)>([\s\S]*?)(?:<\/teammate-message>[\s\S]*)?$/;
const TASK_NOTE = /^<task-notification\b/;
const SHELL_IN = /^<bash-input>([\s\S]*?)<\/bash-input>\s*$/;
const SHELL_OUT = /^<bash-stdout>([\s\S]*?)<\/bash-stdout>\s*(?:<bash-stderr>([\s\S]*?)<\/bash-stderr>)?\s*$/;
// Harness notes Claude Code puts inside relayed text; never meant for a reader.
const HARNESS_NOTES = [
  /<artifact-content-authored-by-others\s*\/>\s*/g,
  /^This agent read Artifact content written by people other than you[^\n]*\n?/gm,
  /^\[harness:[^\n]*\]\s*\n?/gm,
];

function clean(body: string): string {
  let b = body;
  for (const re of HARNESS_NOTES) b = b.replace(re, '');
  return b.trim();
}

const tagText = (t: string, tag: string): string => (new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>').exec(t)?.[1] ?? '').trim();

/** A teammate message's body: plain text, or the JSON status envelope an idle subagent sends. */
function teammateBody(raw: string): string {
  const t = raw.trim();
  if (t.startsWith('{')) {
    try {
      const j = JSON.parse(t) as { type?: string; result?: string; summary?: string };
      if (typeof j.result === 'string' && j.result.trim()) return clean(j.result);
      if (typeof j.summary === 'string' && j.summary.trim()) return clean(j.summary);
      if (j.type === 'idle_notification') return 'Finished its turn.';
    } catch {
      /* not JSON after all */
    }
  }
  return clean(t);
}
const REMINDER_ONLY = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*)+$/;
const LOOM_TAG = /^\[(Loom events|Loom action \d+|Loom [^\]]{1,40})\]\s*/;
const LOOM_STARTED = /^Loom (?:re)?started you\b/;

const decode = (s: string): string => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

export function classifyInjected(text: string): Injected | null {
  const t = (text ?? '').trim();
  if (!t) return null;
  const route = ROUTE.exec(t);
  if (route) return { kind: 'agent', label: route[2], body: t.slice(route[0].length).trim() };
  const tm = TEAMMATE.exec(t);
  if (tm) {
    const id = /teammate_id="([^"]*)"/.exec(tm[1]);
    return { kind: 'agent', label: id?.[1] || 'teammate', body: teammateBody(tm[2]) };
  }
  if (TASK_NOTE.test(t)) {
    const status = tagText(t, 'status');
    const summary = tagText(t, 'summary');
    return { kind: 'system', label: status ? 'Task ' + status : 'Task', body: summary || 'Background task finished.' };
  }
  const sin = SHELL_IN.exec(t);
  if (sin) return { kind: 'system', label: 'Shell', body: '$ ' + decode(sin[1].trim()) };
  const sout = SHELL_OUT.exec(t);
  if (sout) return { kind: 'system', label: 'Shell output', body: decode([sout[1], sout[2]].filter((x) => x && x.trim()).join('\n').trim()) || '(no output)' };
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
