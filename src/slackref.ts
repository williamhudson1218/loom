// A Slack message permalink, normalised to its thread parent. Kept apart from
// slackgoto.ts so the indexer and the ownership table can use it without
// pulling in the launch machinery.

// Mirrors URL_RE and thread_keys() in ~/.claude/hooks/slack-threads.py exactly,
// because the hook's keys are what the state file is keyed by: a link that
// normalises differently here would never find its owner.
const URL_RE = /https:\/\/[\w-]+\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d{10})(\d{6})(\?[^\s>)\]|]*)?/;

export interface ThreadRef {
  key: string; // `<channel>/<root ts>`, the state file's key
  url: string; // the root's own permalink
  channel: string;
  ts: string; // the thread root
  linkTs: string; // the message the link pointed at: a reply's own ts, or the root
}

/**
 * The thread a Slack permalink belongs to, or null if the text holds none. A
 * reply link carries its root in `?thread_ts=`, and the thread is that root,
 * not the reply. Only the first link in the text counts.
 */
export function parseSlackThread(text: string): ThreadRef | null {
  const m = URL_RE.exec(text || '');
  if (!m) return null;
  const [whole, channel, sec, frac, query] = m;
  const linkTs = `${sec}.${frac}`;
  let ts = linkTs;
  if (query) {
    // parse_qs drops blank values and takes the first; URLSearchParams.get is the
    // same first value, and the shape check rejects the blank.
    const root = new URLSearchParams(query.slice(1)).get('thread_ts');
    if (root && /^\d{10}\.\d{6}$/.test(root)) ts = root;
  }
  const base = whole.split('/archives/')[0];
  return { key: `${channel}/${ts}`, url: `${base}/archives/${channel}/p${ts.replace('.', '')}`, channel, ts, linkTs };
}
