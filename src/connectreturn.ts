import { createHash } from 'node:crypto';

// After a sign-in finishes in the browser (Connect Slack, Connect Gmail, the
// GitHub device login), Loom comes back to the front by itself, so the person
// is not left on a browser tab. The Electron main process registers the raiser
// (app/main.ts); the server alone (no app) has none, and the tab says to close it.
// The page in Loom already polls the flow's status, so it shows the connected
// state as soon as the window is in front.

export type ConnectKind = 'slack' | 'google' | 'github';

let raiser: ((kind: ConnectKind) => void) | null = null;

export function setConnectRaiser(fn: ((kind: ConnectKind) => void) | null): void {
  raiser = fn;
}

/** Bring Loom forward after a successful sign-in. Never throws. */
export function returnToLoom(kind: ConnectKind): void {
  try {
    raiser?.(kind);
  } catch {
    /* the tab still says what happened */
  }
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export const DONE_STYLE =
  'body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#17171b;color:#e8e8ee}main{max-width:420px;padding:24px 16px}h1{font-size:18px;margin:0 0 8px}p{margin:0;color:#b8b8c4}';
// Browsers only let a script close a tab a script opened, so this mostly does
// nothing; the text already says to close the tab. Loom is in front either way.
export const DONE_SCRIPT = 'setTimeout(function(){try{window.close();}catch(e){}},800);';

const sha = (s: string): string => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/**
 * The page the browser tab shows when a sign-in comes back to Loom. Dark, plain,
 * no external resources. On success it tries to close itself.
 */
export function connectDonePage(o: { service: string; ok: boolean; text: string }): string {
  const title = `${o.service} ${o.ok ? 'connected' : 'not connected'}`;
  const csp = `default-src 'none'; style-src ${sha(DONE_STYLE)}; script-src ${sha(DONE_SCRIPT)}; base-uri 'none'; form-action 'none'`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(title)} · Loom</title><style>${DONE_STYLE}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(o.text)}</p></main>${o.ok ? `<script>${DONE_SCRIPT}</script>` : ''}</body></html>`;
}
