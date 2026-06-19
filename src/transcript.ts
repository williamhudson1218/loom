import fs from 'node:fs';

export interface Msg {
  role: 'user' | 'assistant';
  text: string;
}

// Only real conversation text — user prompts and assistant prose. Tool calls and
// tool results (which arrive as content blocks / user-role messages) are dropped so
// the panel reads like a chat, not a tool log.
function textOnly(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content as any[]) {
      if (b?.type === 'text' && typeof b.text === 'string') parts.push(b.text.trim());
    }
    return parts.join('\n').trim();
  }
  return '';
}

// Read the tail of a session JSONL and return the recent user/assistant messages.
// Tail-reading bounds the work regardless of how large the transcript is.
export function readTranscript(jsonlPath: string, opts: { bytes?: number; limit?: number } = {}): Msg[] {
  const bytes = opts.bytes ?? 400_000;
  const limit = opts.limit ?? 200;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(jsonlPath);
  } catch {
    return [];
  }
  const start = Math.max(0, stat.size - bytes);
  let text: string;
  try {
    const fd = fs.openSync(jsonlPath, 'r');
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    text = buf.toString('utf-8');
  } catch {
    return [];
  }
  let lines = text.split('\n');
  if (start > 0) lines = lines.slice(1); // drop the partial first line
  const msgs: Msg[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.type === 'user' && o.message?.role === 'user' && !o.isMeta) {
      const t = textOnly(o.message.content);
      if (t) msgs.push({ role: 'user', text: t });
    } else if (o?.type === 'assistant' && o.message?.role === 'assistant') {
      const t = textOnly(o.message.content);
      if (t) msgs.push({ role: 'assistant', text: t });
    }
  }
  return msgs.slice(-limit);
}
