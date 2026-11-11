import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AmbiguousSendError, snippetOf, type EmailAdapter, type EmailMessage } from './outboxemail.ts';
import { GoogleError, resolveGoogleAccount, type GoogleAccount } from './googleoauth.ts';

// The built-in email adapter: the same three calls as the email CLI
// (src/outboxemail.ts), made straight to the Gmail API with a connected
// account's token. Scopes are gmail.send + gmail.metadata (see src/googleoauth.ts),
// so `thread` reads headers, labels and the snippet, never bodies, and
// `addresses` is the account address.

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** messages.send with a JSON body takes about 5 MB of raw message; past that Loom refuses rather than half-sends. */
export const MAX_RAW_BYTES = 4_500_000;

export interface GmailDeps {
  accounts(): GoogleAccount[];
  /** An access token for the account; force = the last one was refused. */
  token(email: string, force?: boolean): Promise<string>;
  fetchImpl?: typeof fetch;
  readFile?: (p: string) => Buffer;
  now?: () => Date;
}

/* ------------------------------------------------------------------ MIME */

const CRLF = '\r\n';
const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded-word for a header value that is not plain ASCII. */
export function encodeHeader(s: string): string {
  if (ascii(s)) return s;
  return `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`;
}

/** "Name <a@b>" with a non-ASCII name encoded; a bare address unchanged. */
function encodeAddress(a: string): string {
  const m = /^\s*"?([^"<]*?)"?\s*<([^<>]+)>\s*$/.exec(a);
  if (!m || !m[1]) return a.trim();
  const name = m[1].trim();
  return `${ascii(name) ? (/[(),:;<>@[\]".]/.test(name) ? `"${name.replace(/"/g, '')}"` : name) : encodeHeader(name)} <${m[2].trim()}>`;
}

const addrList = (v: unknown): string =>
  (typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v.map(String) : [])
    .map((x) => x.trim())
    .filter(Boolean)
    .map(encodeAddress)
    .join(', ');

const b64lines = (b: Buffer): string => (b.toString('base64').match(/.{1,76}/g) ?? ['']).join(CRLF);

const MIME_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json', '.html': 'text/html', '.zip': 'application/zip',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const mimeOf = (p: string) => MIME_TYPES[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
const quoteName = (n: string) => (ascii(n) ? `"${n.replace(/["\\]/g, '')}"` : `"${encodeHeader(n)}"`);

/**
 * The RFC 2822 message for a send payload (the shape emailPayload() builds):
 * From, To, Cc, Bcc, Subject, Date, In-Reply-To, References, the body as
 * base64 text (or HTML), and attachments as multipart/mixed parts.
 */
export function buildMime(payload: Record<string, unknown>, from: string, o: { readFile?: (p: string) => Buffer; now?: Date; boundary?: string } = {}): string {
  const str = (k: string) => (typeof payload[k] === 'string' ? (payload[k] as string).trim() : '');
  for (const k of ['subject', 'inReplyTo', 'references']) if (/[\r\n]/.test(str(k))) throw new Error(`${k} must be one line`);
  const headers: string[] = [
    `From: ${encodeAddress(str('from') || from)}`,
    `To: ${addrList(payload.to)}`,
    ...(addrList(payload.cc) ? [`Cc: ${addrList(payload.cc)}`] : []),
    ...(addrList(payload.bcc) ? [`Bcc: ${addrList(payload.bcc)}`] : []),
    `Subject: ${encodeHeader(str('subject'))}`,
    `Date: ${(o.now ?? new Date()).toUTCString().replace('GMT', '+0000')}`,
    ...(str('inReplyTo') ? [`In-Reply-To: ${str('inReplyTo')}`] : []),
    ...(str('references') ? [`References: ${str('references')}`] : []),
    'MIME-Version: 1.0',
  ];
  const body = String(payload.body ?? '').replace(/\r?\n/g, CRLF);
  const textPart = [`Content-Type: text/${payload.html === true ? 'html' : 'plain'}; charset="UTF-8"`, 'Content-Transfer-Encoding: base64', '', b64lines(Buffer.from(body, 'utf8'))].join(CRLF);
  const atts = Array.isArray(payload.attachments) ? (payload.attachments as string[]) : [];
  if (!atts.length) return [...headers, textPart].join(CRLF);
  const read = o.readFile ?? ((p: string) => fs.readFileSync(p));
  const boundary = o.boundary ?? `loom_${randomBytes(12).toString('hex')}`;
  const parts = atts.map((p) => {
    const name = path.basename(p);
    return [`Content-Type: ${mimeOf(p)}; name=${quoteName(name)}`, `Content-Disposition: attachment; filename=${quoteName(name)}`, 'Content-Transfer-Encoding: base64', '', b64lines(read(p))].join(CRLF);
  });
  return [...headers, `Content-Type: multipart/mixed; boundary="${boundary}"`, '', ...[textPart, ...parts].map((p) => `--${boundary}${CRLF}${p}`), `--${boundary}--`, ''].join(CRLF);
}

/* --------------------------------------------------------------- the adapter */

interface GmailHeader { name?: string; value?: string }
interface GmailMsg { id?: string; internalDate?: string; labelIds?: string[]; snippet?: string; payload?: { headers?: GmailHeader[] } }

const header = (m: GmailMsg, name: string): string => m.payload?.headers?.find((h) => (h.name ?? '').toLowerCase() === name.toLowerCase())?.value ?? '';

/** Gmail's HTML-escaped snippet back to text. */
export function unescapeSnippet(s: string): string {
  return s.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** A threads.get answer as the rows the before-send check and parked replies read. */
export function threadMessages(j: { messages?: GmailMsg[] }): EmailMessage[] {
  return (Array.isArray(j?.messages) ? j.messages : []).map((m) => ({
    id: String(m.id ?? ''),
    from: header(m, 'From'),
    date: header(m, 'Date'),
    at: Number(m.internalDate) || Date.parse(header(m, 'Date')) || 0,
    snippet: snippetOf(unescapeSnippet(String(m.snippet ?? ''))),
    labels: Array.isArray(m.labelIds) ? m.labelIds : [],
  }));
}

const errText = async (r: Response): Promise<string> => {
  try {
    const j = (await r.json()) as { error?: { message?: string; status?: string } };
    return String(j?.error?.message || j?.error?.status || `HTTP ${r.status}`).slice(0, 200);
  } catch {
    return `HTTP ${r.status}`;
  }
};

export function gmailAdapter(deps: GmailDeps): EmailAdapter {
  const f = deps.fetchImpl ?? fetch;
  const acct = (label?: string) => resolveGoogleAccount(deps.accounts(), label);

  /** One authorised call; a 401 gets one fresh token and one retry (the request was refused, so nothing happened). */
  async function call(email: string, url: string, init: RequestInit = {}): Promise<Response> {
    let token = await deps.token(email);
    let r = await f(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 401) {
      token = await deps.token(email, true);
      r = await f(url, { ...init, headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
    }
    return r;
  }

  return {
    async send(payload, account) {
      const a = acct(account);
      const mime = buildMime(payload, a.email, { readFile: deps.readFile, now: deps.now?.() });
      const raw = Buffer.from(mime, 'utf8');
      if (raw.length > MAX_RAW_BYTES) throw new Error(`the email is ${Math.round(raw.length / 1e6)} MB; the built-in Gmail sender takes up to 4.5 MB. Use the Email CLI for larger attachments.`);
      const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
      const body = JSON.stringify({ raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) });
      let token: string;
      try {
        token = await deps.token(a.email);
      } catch (e) {
        throw new Error(e instanceof GoogleError ? e.code : (e as Error).message);
      }
      const post = (t: string) => f(`${GMAIL_API}/messages/send`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body, signal: AbortSignal.timeout(60_000) });
      let r: Response;
      try {
        r = await post(token);
        if (r.status === 401) r = await post(await deps.token(a.email, true));
      } catch (e) {
        if (e instanceof GoogleError) throw new Error(e.code);
        // The request may have reached Gmail before the connection dropped.
        throw new AmbiguousSendError('Gmail did not answer: ' + ((e as Error)?.message ?? e));
      }
      if (r.status >= 500) throw new AmbiguousSendError(`Gmail answered ${r.status}; the email may have been sent`);
      if (!r.ok) throw new Error('Gmail refused the email: ' + (await errText(r)));
      let j: { id?: string; threadId?: string };
      try {
        j = (await r.json()) as { id?: string; threadId?: string };
      } catch {
        throw new AmbiguousSendError('Gmail did not report a message id');
      }
      if (!j.id) throw new AmbiguousSendError('Gmail did not report a message id');
      return { messageId: j.id, threadId: j.threadId ?? '' };
    },
    async thread(threadId, account) {
      const a = acct(account);
      const q = new URLSearchParams([['format', 'metadata'], ['metadataHeaders', 'From'], ['metadataHeaders', 'Date'], ['metadataHeaders', 'Message-ID']]);
      let r: Response;
      try {
        r = await call(a.email, `${GMAIL_API}/threads/${encodeURIComponent(threadId)}?${q}`);
      } catch (e) {
        throw new Error(e instanceof GoogleError ? e.code : 'Gmail did not answer: ' + ((e as Error)?.message ?? e));
      }
      if (!r.ok) throw new Error('Gmail could not read the thread: ' + (await errText(r)));
      return threadMessages((await r.json()) as { messages?: GmailMsg[] });
    },
    async addresses(account) {
      return [acct(account).email];
    },
  };
}

/* ---------------------------------------------------------- which adapter */

export type EmailRoute = 'gmail' | 'cli' | null;

/**
 * Which way email drafts go. `auto` (the default) uses the built-in Gmail
 * sender once an account is connected, else the email CLI (the setting or the
 * default script). Nothing changes for someone with a CLI until they connect
 * Gmail; either route can be pinned with `email_via`.
 */
export function chooseEmailRoute(i: { via: string; gmailAccounts: number; cli: string }): EmailRoute {
  if (i.via === 'gmail') return i.gmailAccounts ? 'gmail' : null;
  if (i.via === 'cli') return i.cli ? 'cli' : null;
  if (i.gmailAccounts) return 'gmail';
  return i.cli ? 'cli' : null;
}
