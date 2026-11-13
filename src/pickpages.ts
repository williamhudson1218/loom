// The pick overlay's pages (app/picker.ts loads each as a data: URL). Kept free
// of Electron so tests can parse them.

export const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;overflow:hidden;cursor:crosshair;user-select:none;
    /* not 0: macOS passes clicks through fully transparent pixels */
    background:rgba(0,0,0,0.01)}
  #box{position:fixed;display:none;border:2px solid #4c8dff;border-radius:6px;
    background:rgba(76,141,255,0.14);box-shadow:0 0 0 1px rgba(0,0,0,0.35);pointer-events:none}
  /* bottom, not top: top-center is under the camera notch on MacBooks */
  #hint{position:fixed;bottom:28px;left:50%;transform:translateX(-50%);padding:6px 12px;border-radius:8px;
    font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#fff;background:rgba(20,22,30,0.88);pointer-events:none;
    display:flex;align-items:center;gap:8px}
  #hint.err{background:rgba(138,43,46,0.95)}
  #spin{display:none;width:12px;height:12px;border:2px solid rgba(255,255,255,0.35);border-top-color:#fff;border-radius:50%;
    animation:spin .7s linear infinite}
  #hint.busy #spin{display:inline-block}
  @keyframes spin{to{transform:rotate(360deg)}}
  /* After "Open in Slack": the landed message, outlined like a hover, pulsed once and faded. */
  .fl{position:fixed;display:none;border:2px solid #4c8dff;border-radius:6px;background:rgba(76,141,255,0.14);
    box-shadow:0 0 0 1px rgba(0,0,0,0.35),0 0 0 4px rgba(76,141,255,0.35);pointer-events:none;opacity:0}
  .fl.on{display:block;animation:loomflash 1.1s ease-out forwards}
  @keyframes loomflash{0%{opacity:0}12%{opacity:1}38%{opacity:.45}60%{opacity:1}100%{opacity:0}}
  body.flashing{cursor:default}
  body.flashing #hint,body.flashing #box{display:none !important}
</style></head><body><div id="box"></div><div id="fl0" class="fl"></div><div id="fl1" class="fl"></div><div id="hint"><span id="spin"></span><span id="msg"></span></div><script>
  const { ipcRenderer } = require('electron');
  const origin = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  const box = document.getElementById('box'), hint = document.getElementById('hint'), msg = document.getElementById('msg');
  const IDLE = 'Click a Slack message to open its chat. Esc cancels.';
  const say = (text, cls) => { msg.textContent = text; hint.className = cls || ''; };
  say(IDLE);
  let timer = 0;
  // The windows are built once and reused (see prepareOverlays), so each pick starts
  // with a reset. Once that reset has been painted, say so: pick.log then shows when
  // this display could really take a click, not just when it was ordered in.
  ipcRenderer.on('reset', () => {
    clearTimeout(timer); box.style.display = 'none'; say(IDLE); document.body.style.cursor = 'crosshair';
    document.body.className = ''; for (const i of [0, 1]) { const f = document.getElementById('fl' + i); if (f) f.className = 'fl'; }
    requestAnimationFrame(() => requestAnimationFrame(() => ipcRenderer.send('loom-pick-painted', { d: origin.d, t: Date.now(), vis: document.visibilityState })));
  });
  // A message was picked: say so until the chat is on screen, so the wait is visible.
  ipcRenderer.on('busy', (_e, text) => {
    clearTimeout(timer); say(text, 'busy'); document.body.style.cursor = 'progress';
  });
  // The open failed: say why here, where the user is looking.
  ipcRenderer.on('error', (_e, text) => {
    clearTimeout(timer); say(text, 'err'); document.body.style.cursor = 'default';
  });
  ipcRenderer.on('rect', (_e, r) => {
    if (!r) { box.style.display = 'none'; return; }
    Object.assign(box.style, { display: 'block', left: (r.x - origin.x - 2) + 'px', top: (r.y - origin.y - 2) + 'px', width: r.w + 'px', height: r.h + 'px' });
  });
  // Flash rects (global screen points) once, then the main process hides the window.
  ipcRenderer.on('flash', (_e, rects) => {
    document.body.className = 'flashing';
    [0, 1].forEach((i) => {
      const f = document.getElementById('fl' + i);
      if (!f) return;
      const r = (rects || [])[i];
      f.className = 'fl';
      if (!r) return;
      Object.assign(f.style, { left: (r.x - origin.x - 2) + 'px', top: (r.y - origin.y - 2) + 'px', width: r.w + 'px', height: r.h + 'px' });
      void f.offsetWidth; // restart the animation
      f.className = 'fl on';
    });
  });
  ipcRenderer.on('hint', (_e, text) => {
    say(text);
    clearTimeout(timer);
    timer = setTimeout(() => { say(IDLE); }, 1800);
  });
  // First thing on a mousedown: tell the main process, with when and where (global
  // screen points), so the pick is resolved at the click, not wherever the pointer is
  // by the time the main process gets to it.
  window.addEventListener('mousedown', (e) => {
    ipcRenderer.send('loom-pick-click', { t: Date.now(), x: origin.x + e.clientX, y: origin.y + e.clientY, d: origin.d, button: e.button });
    e.preventDefault();
  });
  window.addEventListener('contextmenu', (e) => e.preventDefault());
</script></body></html>`;

export const PASTE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:18px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#e8eaf0;background:#161a24}
  p{margin:0 0 10px;line-height:1.4} input{width:100%;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid #3a4258;background:#0d0f15;color:inherit;font:inherit}
  #err{color:#ff8a8a;min-height:16px;margin:6px 0} .row{display:flex;gap:8px;justify-content:flex-end}
  button{padding:6px 14px;border-radius:6px;border:1px solid #3a4258;background:#222a3b;color:inherit;font:inherit} button.p{background:#4c8dff;border-color:#4c8dff;color:#fff}
</style></head><body><p id="why"></p><input id="u" placeholder="https://workspace.slack.com/archives/C.../p..." autofocus><div id="err"></div>
<div class="row"><button id="c">Cancel</button><button id="ok" class="p">Open chat</button></div><script>
  const { ipcRenderer } = require('electron');
  const init = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  const u = document.getElementById('u'); u.value = init.prefill || '';
  document.getElementById('why').textContent = init.why;
  const send = () => ipcRenderer.send('loom-paste-link', u.value.trim());
  document.getElementById('ok').onclick = send;
  document.getElementById('c').onclick = () => ipcRenderer.send('loom-paste-link', '');
  u.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); if (e.key === 'Escape') ipcRenderer.send('loom-paste-link', ''); });
  ipcRenderer.on('err', (_e, t) => { document.getElementById('err').textContent = t; });
</script></body></html>`;

export const NEW_THREAD_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;padding:18px;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#e8eaf0;background:#161a24}
  h1{font-size:14px;font-weight:600;margin:0 0 6px} p{margin:0 0 10px;line-height:1.4;color:#aab1c2}
  #where{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  label{display:block;margin:0 0 6px}
  textarea{width:100%;height:96px;box-sizing:border-box;padding:8px;border-radius:6px;border:1px solid #3a4258;background:#0d0f15;color:inherit;font:inherit;resize:none}
  .row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
  button{padding:6px 14px;border-radius:6px;border:1px solid #3a4258;background:#222a3b;color:inherit;font:inherit}
  button.p{background:#4c8dff;border-color:#4c8dff;color:#fff} .k{opacity:.7;font-size:11px;margin-left:4px}
</style></head><body><h1>No open chat for this thread</h1><p id="where"></p><p id="proj"></p>
<label for="ctx">Add context for Claude (optional)</label><textarea id="ctx" autofocus></textarea>
<div class="row"><button id="c">Cancel</button><button id="asis">Send as is</button><button id="go" class="p">Start with context<span class="k">⌘↩</span></button></div><script>
  const { ipcRenderer } = require('electron');
  const init = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  document.getElementById('where').textContent = init.where;
  document.getElementById('proj').textContent = init.project ? 'Starts a chat in ' + init.project + '.' : '';
  const ctx = document.getElementById('ctx');
  const answer = (v) => ipcRenderer.send('loom-new-thread', v);
  document.getElementById('go').onclick = () => answer({ start: true, context: ctx.value });
  document.getElementById('asis').onclick = () => answer({ start: true, context: '' });
  document.getElementById('c').onclick = () => answer({ start: false });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') answer({ start: false });
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); answer({ start: true, context: ctx.value }); }
  });
</script></body></html>`;

/** The prompt's one line about the thread: channel, then who wrote it and the start of what they wrote. */
export function newThreadWhere(info: { channel: string; channelName?: string; author?: string; text?: string }): string {
  const ch = info.channelName ? '#' + info.channelName : info.channel;
  const snippet = (info.text ?? '').replace(/\s+/g, ' ').trim();
  const short = snippet.length > 90 ? snippet.slice(0, 89) + '…' : snippet;
  const who = info.author ? info.author + (short ? ': ' : '') : '';
  return who || short ? `${ch} · ${who}${short}` : ch;
}
