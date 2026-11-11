// The page's one error component. Every error card, toast and wizard failure
// renders through loomErrorHtml() (or gets a lerrCopyBtn() next to its own
// text), so every error carries a Copy details button. The button posts what
// failed, the message and any step output to POST /api/diagnostics, which adds
// the Loom version and commit, macOS version, arch, the claude CLI version and
// the tail of Loom's log, redacts it (src/diagnostics.ts) and hands back plain
// text for the clipboard. Settings > About > Copy diagnostics is the same call
// with no error in it.
//
// Plain browser CSS/JS in strings, spliced verbatim by dashboard.ts: no backtick,
// no dollar-brace and no backslash in them. Everything is prefixed lerr.

export const ERROR_VIEW_CSS = String.raw`
  .lerr { border:1px solid #5a2a2e; background:rgba(229,72,77,.13); color:#ffb0b3; border-radius:8px; padding:9px 11px; font-size:12.5px; line-height:1.45; display:flex; flex-direction:column; gap:7px; }
  .lerr .lerr-what { font-weight:600; color:#ffc9cb; }
  .lerr .lerr-msg { white-space:pre-wrap; word-break:break-word; }
  .lerr details { margin:0; }
  .lerr summary { cursor:pointer; color:#e3a0a3; font-size:12px; }
  .lerr pre { margin:6px 0 0; max-height:180px; overflow:auto; padding:7px 9px; border-radius:6px; background:#0a0c11; color:#c4ccdc; font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; white-space:pre-wrap; word-break:break-word; }
  .lerr .lerr-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .lerr-copy { height:24px; padding:0 10px; border-radius:6px; border:1px solid #7a3a3e; background:#2a1517; color:#ffd5d7; font:500 11.5px -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; cursor:pointer; white-space:nowrap; }
  .lerr-copy:hover { background:#3a1c1f; border-color:#a14a50; }
  .lerr-copy:focus-visible { outline:2px solid #6ea2ff; outline-offset:2px; }
  .lerr-copy.done { border-color:#2d6a3a; background:#12261a; color:#a6e3b4; }
  #toast.lerr-toast { pointer-events:auto; display:flex; align-items:center; gap:10px; max-width:min(640px, calc(100vw - 32px)); }
  #toast.lerr-toast .lerr-copy { height:22px; }
`;

export const ERROR_VIEW_JS = String.raw`
// ---- Errors: one component, every error gets Copy details ----------------------
var LERR = { n: 0, items: {}, order: [] };
function lerrEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
// Remember what an error was so its Copy details button can send it. Keeps the last 100.
function lerrReg(e) {
  var id = 'lerr' + (++LERR.n);
  LERR.items[id] = { what: String(e.what || ''), message: String(e.message || ''), output: String(e.output || '') };
  LERR.order.push(id);
  while (LERR.order.length > 100) delete LERR.items[LERR.order.shift()];
  return id;
}
// Step output as one string: a claude command's stdout and stderr, or a list of steps.
function lerrOutput(o) {
  if (!o) return '';
  if (typeof o === 'string') return o;
  if (Array.isArray(o)) return o.map(lerrOutput).filter(Boolean).join(String.fromCharCode(10, 10));
  var parts = [];
  if (o.display) parts.push('$ ' + o.display);
  if (o.code != null) parts.push('exit ' + o.code);
  if (o.output) parts.push(o.output);
  if (o.stdout) parts.push(o.stdout);
  if (o.stderr) parts.push(o.stderr);
  if (!parts.length) { try { return JSON.stringify(o, null, 2); } catch (x) { return String(o); } }
  return parts.join(String.fromCharCode(10));
}
// Just the button, for an error that already has its own layout (a toast, a pill row).
function lerrCopyBtn(e) {
  return '<button type="button" class="lerr-copy" data-lerr="' + lerrReg(e) + '" title="Copy what failed, the output, Loom and macOS versions and the recent log, for a bug report">Copy details</button>';
}
// The error card: e = { what, message, output, title }. title shows a bold first line.
function loomErrorHtml(e) {
  e = e || {};
  var out = lerrOutput(e.output);
  var reg = { what: e.what || e.title || '', message: e.message || '', output: out };
  return '<div class="lerr" role="alert">'
    + (e.title ? '<div class="lerr-what">' + lerrEsc(e.title) + '</div>' : '')
    + (e.message ? '<div class="lerr-msg">' + lerrEsc(e.message) + '</div>' : '')
    + (out ? '<details><summary>Output</summary><pre>' + lerrEsc(out) + '</pre></details>' : '')
    + '<div class="lerr-row">' + lerrCopyBtn(reg) + '</div></div>';
}
function lerrClip(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(function () { return lerrClipOld(text); });
  return lerrClipOld(text);
}
function lerrClipOld(text) {
  return new Promise(function (ok, bad) {
    var ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    var done = false; try { done = document.execCommand('copy'); } catch (x) { done = false; }
    ta.remove(); if (done) ok(); else bad(new Error('copy refused'));
  });
}
// The redacted bundle for e (or none: Copy diagnostics), as text.
function loomDiagnostics(e) {
  e = e || {};
  return fetch('/api/diagnostics', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ what: e.what || '', message: e.message || '', output: e.output || '' }) })
    .then(function (r) { return r.json(); })
    .then(function (j) { if (!j || !j.ok || typeof j.text !== 'string') throw new Error((j && j.detail) || 'no diagnostics'); return j.text; });
}
// Copy the bundle; the button says Copied, or why not. Falls back to the page's own
// view of the error if Loom does not answer, so the button never does nothing.
function loomCopyDetails(e, btn) {
  e = e || {};
  var label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Copying'; }
  var fallback = function () {
    var nl = String.fromCharCode(10);
    return ['Loom error: ' + (e.what || 'unknown'), '', 'Message: ' + (e.message || ''), '', e.output || '', '', 'Loom did not answer, so versions and the log are missing.', 'Page: ' + navigator.userAgent].join(nl);
  };
  return loomDiagnostics(e).catch(fallback).then(lerrClip).then(function () {
    if (btn) { btn.textContent = 'Copied'; btn.classList.add('done'); }
  }, function () {
    if (btn) btn.textContent = 'Could not copy';
  }).then(function () {
    if (btn) setTimeout(function () { btn.disabled = false; btn.textContent = label || 'Copy details'; btn.classList.remove('done'); }, 1600);
  });
}
// One listener for every Copy details button, in capture so a parent handler
// (the wizard, a card) cannot swallow the click first.
document.addEventListener('click', function (ev) {
  var b = ev.target && ev.target.closest ? ev.target.closest('[data-lerr]') : null;
  if (!b) return;
  ev.preventDefault(); ev.stopPropagation();
  loomCopyDetails(LERR.items[b.getAttribute('data-lerr')] || { what: 'unknown error' }, b);
}, true);
window.loomErrorHtml = loomErrorHtml;
window.lerrCopyBtn = lerrCopyBtn;
window.loomCopyDetails = loomCopyDetails;
`;
