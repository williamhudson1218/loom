import { createHash } from 'node:crypto';

// After a sign-in finishes in the browser (Connect Slack, Connect Gmail, the
// GitHub device login), Loom comes back to the front by itself, so the person
// is not left on a browser tab. The Electron main process registers the raiser
// (app/main.ts); the server alone (no app) has none, and the tab says to close it.
// The page in Loom already polls the flow's status, so it shows the connected
// state as soon as the window is in front.

export type ConnectKind = 'slack' | 'google' | 'github';

// Why there is also a loom:// link: since macOS 14, activation is cooperative.
// An app in the background asking to come forward (app.focus({ steal: true }),
// which is activateIgnoringOtherApps) is often ignored while the browser is the
// active app, and that is exactly when a sign-in finishes. A loom:// URL opened
// by the browser is the browser handing activation to Loom, which macOS honours.
// So the done page opens loom://connected/<service> on load and offers it as a
// "Return to Loom" button; Loom registers the scheme (CFBundleURLTypes in
// app/package.json) and raises its window on open-url. The URL carries no data
// Loom acts on beyond raising its own window, so any page opening it is harmless.
export const LOOM_SCHEME = 'loom';
export const returnUrl = (kind: ConnectKind): string => `${LOOM_SCHEME}://connected/${kind}`;

/** A loom:// URL Loom understands: the service it names, or '' for a bare loom:// (still raises). Null for anything else. */
export function parseLoomUrl(url: string): ConnectKind | '' | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== LOOM_SCHEME + ':') return null;
  const m = /^\/?([a-z]+)$/.exec(u.pathname);
  const kind = u.host === 'connected' && m ? m[1] : '';
  return kind === 'slack' || kind === 'google' || kind === 'github' ? kind : '';
}

/** What raising needs from Electron, so the order can be tested without it. */
export interface RaiseTarget {
  window(): { isMinimized(): boolean; restore(): void; show(): void; focus(): void; moveTop?(): void } | null;
  createWindow(): void;
  /** app.show(): un-hides an app hidden with Cmd-H. macOS only. */
  showApp?(): void;
  /** app.focus({ steal: true }). */
  focusApp(): void;
}

/** Bring Loom's window to the front: un-hide the app, restore a minimised window, show, focus, then ask macOS to activate. */
export function raiseLoom(t: RaiseTarget): void {
  t.showApp?.();
  const w = t.window();
  if (!w) t.createWindow();
  else {
    if (w.isMinimized()) w.restore();
    w.show();
    w.moveTop?.();
    w.focus();
  }
  t.focusApp();
}

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
  'body{font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#17171b;color:#e8e8ee}main{max-width:420px;padding:24px 16px}h1{font-size:18px;margin:0 0 8px}p{margin:0 0 16px;color:#b8b8c4}a.btn{display:inline-block;padding:8px 16px;border-radius:8px;background:#3b6df6;color:#fff;text-decoration:none;font-weight:600}a.btn:hover{background:#2f5ee0}.small{font-size:13px;color:#8a8a96;margin-top:16px}';
// On success: hand activation to Loom through loom:// (the browser may ask once),
// then try to close the tab. Browsers only let a script close a tab a script
// opened, so the close mostly does nothing, and the page says so.
export const DONE_SCRIPT =
  "var a=document.getElementById('back');if(a){location.href=a.getAttribute('href');}setTimeout(function(){try{window.close();}catch(e){}},1500);";

const sha = (s: string): string => `'sha256-${createHash('sha256').update(s).digest('base64')}'`;

/**
 * The page the browser tab shows when a sign-in comes back to Loom. Dark, plain,
 * no external resources. On success it tries to close itself.
 */
export function connectDonePage(o: { service: string; kind: ConnectKind; ok: boolean; text: string }): string {
  const title = `${o.service} ${o.ok ? 'connected' : 'not connected'}`;
  const csp = `default-src 'none'; style-src ${sha(DONE_STYLE)}; script-src ${sha(DONE_SCRIPT)}; base-uri 'none'; form-action 'none'`;
  const back = `<a class="btn" id="${o.ok ? 'back' : 'back-manual'}" href="${returnUrl(o.kind)}">Return to Loom</a>`;
  const note = o.ok ? '<p class="small">If your browser asks, allow it to open Loom. You can close this tab.</p>' : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${csp}"><title>${esc(title)} · Loom</title><style>${DONE_STYLE}</style></head>
<body><main><h1>${esc(title)}</h1><p>${esc(o.text)}</p>${back}${note}</main>${o.ok ? `<script>${DONE_SCRIPT}</script>` : ''}</body></html>`;
}
