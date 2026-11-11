import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE_HOME } from './paths.ts';

// The email half of the outbox: a draft may be an email, sent as the person
// through a Gmail-CLI-compatible script (the `email_cli` setting) when they press
// Send. Loom never holds mail credentials: the script does, and Loom only runs it.
//
// The script contract is small, so another mail tool can stand in:
//   <cli> send --account <label>       JSON payload on stdin -> {messageId, threadId} on stdout
//   <cli> thread --id <threadId> --account <label>   -> [{id, from, date, internalDate, labelIds, body}]
//   <cli> send-as --account <label>    -> [{sendAsEmail}]  (the addresses that count as "me")
// (--account is left off for the default account.) A `send` that prints
// GMAIL_SEND_REQUEST_ISSUED on stderr before failing may have sent: Loom then keeps
// the draft claimed rather than inviting a second send.

export interface DraftEmail {
  /** The account: a CLI label (token.<label>.json) or a connected Gmail account's label or address; absent = the default account. */
  account?: string;
  /** A send-as address to send from; absent = the account's primary address. */
  from?: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  /** Plain text, or HTML when `html` is true. */
  body: string;
  html?: boolean;
  /** A reply: the Gmail thread id and the Message-ID header it answers. */
  threadId?: string;
  inReplyTo?: string;
  references?: string;
  /** The thread's subject, for the card ("Reply in thread: ..."). */
  thread_subject?: string;
  /** Append the account's Gmail signature. */
  signature?: boolean;
  /** Absolute paths attached to the message. */
  attachments?: string[];
}

/** Recorded the moment the CLI answers, so a retry never sends it again. */
export interface SentEmail {
  messageId: string;
  threadId: string;
  at: string;
}

const ADDR_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
// A CLI label (token.<label>.json) or a connected Gmail account's label or address.
const ACCOUNT_RE = /^[A-Za-z0-9_.@+-]{1,64}$/;
export const MAX_RECIPIENTS = 50;
export const MAX_ATTACHMENTS = 10;

/** "Name <a@b.c>" or "a@b.c": the address, lowercased, or '' when there is none. */
export function addressOf(s: string): string {
  const m = /<([^<>]+)>/.exec(s);
  const a = (m ? m[1] : s).trim().toLowerCase();
  return ADDR_RE.test(a) ? a : '';
}

const list = (v: unknown): string[] | null => {
  if (v === undefined || v === null || v === '') return [];
  const raw = typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null;
  if (!raw || !raw.every((x) => typeof x === 'string')) return null;
  return (raw as string[]).map((x) => x.trim()).filter(Boolean);
};

/** An email exactly as it will send, or the reason it is not one. */
export function cleanEmail(v: unknown): { ok: true; email: DraftEmail } | { ok: false; detail: string } {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, detail: 'email must be an object' };
  const to = list(r.to);
  const cc = list(r.cc);
  const bcc = list(r.bcc);
  if (!to || !cc || !bcc) return { ok: false, detail: 'email.to, .cc and .bcc must be addresses' };
  if (!to.length && !cc.length && !bcc.length) return { ok: false, detail: 'email needs at least one recipient' };
  if (!to.length) return { ok: false, detail: 'email.to needs at least one address' };
  const all = [...to, ...cc, ...bcc];
  if (all.length > MAX_RECIPIENTS) return { ok: false, detail: `at most ${MAX_RECIPIENTS} recipients` };
  const bad = all.find((a) => !addressOf(a));
  if (bad) return { ok: false, detail: `not an email address: ${bad}` };
  const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
  if (!subject) return { ok: false, detail: 'email.subject is required' };
  if (/[\r\n]/.test(subject)) return { ok: false, detail: 'email.subject must be one line' };
  const body = typeof r.body === 'string' ? r.body.replace(/\r\n/g, '\n').replace(/^\n+|\s+$/g, '') : '';
  if (!body) return { ok: false, detail: 'email.body is required' };
  const account = typeof r.account === 'string' ? r.account.trim() : '';
  if (account && !ACCOUNT_RE.test(account)) return { ok: false, detail: 'email.account must be an account label or address (letters, digits, . _ - @ +)' };
  const from = typeof r.from === 'string' ? r.from.trim() : '';
  if (from && !addressOf(from)) return { ok: false, detail: 'email.from must be an address' };
  const str = (k: string) => (typeof r[k] === 'string' ? (r[k] as string).trim() : '');
  const threadId = str('threadId');
  const inReplyTo = str('inReplyTo');
  const references = str('references');
  if (threadId && !/^[0-9a-f]{6,32}$/i.test(threadId)) return { ok: false, detail: 'email.threadId must be a Gmail thread id' };
  if ((threadId && !inReplyTo) || (inReplyTo && !threadId)) return { ok: false, detail: 'a reply needs both threadId and inReplyTo (the Message-ID it answers)' };
  if (inReplyTo && !/^<[^<>\s]+>$/.test(inReplyTo)) return { ok: false, detail: 'email.inReplyTo must be a Message-ID like <abc@mail.example.com>' };
  if (/[\r\n]/.test(references)) return { ok: false, detail: 'email.references must be one line' };
  const atts = r.attachments === undefined || r.attachments === null ? [] : r.attachments;
  if (!Array.isArray(atts) || atts.length > MAX_ATTACHMENTS || !atts.every((a) => typeof a === 'string' && path.isAbsolute(a))) {
    return { ok: false, detail: `email.attachments must be absolute paths, up to ${MAX_ATTACHMENTS}` };
  }
  const ts = str('thread_subject').slice(0, 300);
  return {
    ok: true,
    email: {
      ...(account ? { account } : {}),
      ...(from ? { from } : {}),
      to,
      ...(cc.length ? { cc } : {}),
      ...(bcc.length ? { bcc } : {}),
      subject,
      body,
      ...(r.html === true ? { html: true } : {}),
      ...(threadId ? { threadId, inReplyTo } : {}),
      ...(references ? { references } : {}),
      ...(ts ? { thread_subject: ts } : {}),
      ...(r.signature === true ? { signature: true } : {}),
      ...(atts.length ? { attachments: atts as string[] } : {}),
    },
  };
}

/** What the CLI's `send` reads on stdin. */
export function emailPayload(e: DraftEmail, body: string = e.body): Record<string, unknown> {
  return {
    ...(e.from ? { from: e.from } : {}),
    to: e.to.join(', '),
    ...(e.cc?.length ? { cc: e.cc.join(', ') } : {}),
    ...(e.bcc?.length ? { bcc: e.bcc.join(', ') } : {}),
    subject: e.subject,
    body,
    ...(e.html ? { html: true } : {}),
    ...(e.threadId ? { threadId: e.threadId, inReplyTo: e.inReplyTo } : {}),
    ...(e.references || e.inReplyTo ? { references: e.references || e.inReplyTo } : {}),
    ...(e.signature ? { signature: true } : {}),
    ...(e.attachments?.length ? { attachments: e.attachments } : {}),
  };
}

/** One line for a confirm / a dry run. */
export function emailSummary(e: DraftEmail): string {
  const n = e.to.length + (e.cc?.length ?? 0) + (e.bcc?.length ?? 0);
  return `${e.threadId ? 'Reply' : 'Email'} "${e.subject}" to ${e.to.join(', ')}${n > e.to.length ? ` (+${n - e.to.length} cc/bcc)` : ''}${e.account ? ` from the ${e.account} account` : ''}`;
}

/* ---------------------------------------------------------------- the adapter */

export interface EmailMessage {
  id: string;
  from: string;
  date: string;
  /** ms since epoch, when the CLI reports it. */
  at: number;
  snippet: string;
  labels?: string[];
}

/** The mail calls Loom makes. Tests pass a stub. */
export interface EmailAdapter {
  send(payload: Record<string, unknown>, account?: string): Promise<{ messageId: string; threadId: string }>;
  thread(threadId: string, account?: string): Promise<EmailMessage[]>;
  /** The addresses that are the account itself (its send-as list). */
  addresses(account?: string): Promise<string[]>;
}

/** A send whose request reached the mail server before it failed: it may have gone out. */
export class AmbiguousSendError extends Error {
  ambiguous = true;
}

export const SEND_ISSUED_MARK = 'GMAIL_SEND_REQUEST_ISSUED';

/** Runs the CLI with args and stdin; resolves stdout, rejects with stderr. Tests pass a stub. */
export type CliRun = (args: string[], input?: string) => Promise<{ code: number; out: string; err: string }>;

export function cliRunner(cli: string): CliRun {
  return (args, input) =>
    new Promise((resolve, reject) => {
      // A .mjs/.js script runs under this Node; anything else is executed directly.
      const node = /\.(m?js|cjs)$/.test(cli);
      const p = spawn(node ? process.execPath : cli, node ? [cli, ...args] : args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
      let out = '';
      let err = '';
      const timer = setTimeout(() => p.kill('SIGTERM'), 90_000);
      p.stdout.on('data', (b: Buffer) => { out += b; });
      p.stderr.on('data', (b: Buffer) => { err += b; });
      p.on('error', (e) => { clearTimeout(timer); reject(new Error(`email CLI: ${e.message}`)); });
      p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
      p.stdin.end(input ?? '');
    });
}

const acct = (a?: string) => (a ? ['--account', a] : []);
const tail = (s: string) => s.trim().split('\n').filter((l) => !l.includes(SEND_ISSUED_MARK)).slice(-3).join(' ').replace(/^ERROR:\s*/, '');
const parse = <T>(s: string, what: string): T => {
  try {
    return JSON.parse(s) as T;
  } catch {
    throw new Error(`email CLI ${what} did not print JSON`);
  }
};

export function cliAdapter(run: CliRun): EmailAdapter {
  return {
    async send(payload, account) {
      const r = await run(['send', ...acct(account)], JSON.stringify(payload));
      if (r.code !== 0) {
        const why = tail(r.err || r.out) || `exited ${r.code}`;
        if (r.err.includes(SEND_ISSUED_MARK)) throw new AmbiguousSendError(why);
        throw new Error(why);
      }
      const j = parse<{ messageId?: string; threadId?: string }>(r.out, 'send');
      if (!j.messageId) {
        // Exit 0 with no id: the request went out, so it may well have sent.
        throw new AmbiguousSendError('the email CLI did not report a message id');
      }
      return { messageId: j.messageId, threadId: j.threadId ?? '' };
    },
    async thread(threadId, account) {
      const r = await run(['thread', '--id', threadId, ...acct(account)]);
      if (r.code !== 0) throw new Error(tail(r.err || r.out) || `exited ${r.code}`);
      const list = parse<{ id?: string; from?: string; date?: string; internalDate?: string | number; labelIds?: string[]; body?: string; snippet?: string }[]>(r.out, 'thread');
      return (Array.isArray(list) ? list : []).map((m) => ({
        id: String(m.id ?? ''),
        from: String(m.from ?? ''),
        date: String(m.date ?? ''),
        at: Number(m.internalDate) || Date.parse(String(m.date ?? '')) || 0,
        snippet: snippetOf(String(m.snippet ?? m.body ?? '')),
        labels: Array.isArray(m.labelIds) ? m.labelIds : [],
      }));
    },
    async addresses(account) {
      const r = await run(['send-as', ...acct(account)]);
      if (r.code !== 0) throw new Error(tail(r.err || r.out) || `exited ${r.code}`);
      const list = parse<{ sendAsEmail?: string }[]>(r.out, 'send-as');
      return (Array.isArray(list) ? list : []).map((s) => String(s.sendAsEmail ?? '').toLowerCase()).filter(Boolean);
    },
  };
}

/** The first lines of a message, quoted history dropped, for a "new messages" row. */
export function snippetOf(body: string, max = 160): string {
  const lines: string[] = [];
  for (const l of body.replace(/\r\n/g, '\n').split('\n')) {
    if (/^On .{4,200} wrote:$/.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l.trim())) break;
    if (/^\s*>/.test(l)) continue;
    lines.push(l.trim());
  }
  const s = lines.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* ---------------------------------------------------------------- the setting */

export const DEFAULT_EMAIL_CLI = path.join(CLAUDE_HOME, 'tools', 'gmail', 'gmail.mjs');

/** The email CLI to use: the setting when set, else the default script when it exists, else '' (email off). */
export function resolveEmailCli(setting: string, exists: (p: string) => boolean = fs.existsSync, fallback: string = DEFAULT_EMAIL_CLI): string {
  const s = setting.trim();
  if (s) return s.startsWith('~/') ? path.join(path.dirname(CLAUDE_HOME), s.slice(2)) : s;
  return exists(fallback) ? fallback : '';
}

export const EMAIL_OFF_DETAIL =
  'Email is off: no Gmail account is connected and no email CLI is set up. Connect Gmail in Settings > Outbox (or set "Email CLI" to a Gmail-CLI-compatible script), then send again.';

const addrCache = new Map<string, { at: number; list: string[] }>();
export const ADDR_TTL_MS = 10 * 60_000;

/** The account's own addresses, cached ten minutes per account. */
export async function ownAddresses(a: EmailAdapter, account?: string, now: number = Date.now()): Promise<string[]> {
  const k = account ?? '';
  const hit = addrCache.get(k);
  if (hit && now - hit.at < ADDR_TTL_MS) return hit.list;
  const list = await a.addresses(account);
  addrCache.set(k, { at: now, list });
  return list;
}

export function clearAddressCache(): void {
  addrCache.clear();
}

/** A Gmail link to the thread (the default signed-in account; Gmail routes it). */
export const gmailThreadUrl = (threadId: string): string => (threadId ? `https://mail.google.com/mail/#all/${threadId}` : '');
