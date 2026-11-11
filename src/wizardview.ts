// The first-run setup wizard (design §6, mock frame A): a centred modal over the
// board with a step rail, a purpose + unlocks header on every step, and a footer
// of Back / Skip / Continue. It reads and writes through src/routes/wizard.ts
// and reuses the plugin, Slack, shortcut, ship and settings routes for the
// buttons that change something.
//
// Plain browser CSS/HTML/JS in strings, spliced verbatim by dashboard.ts like orchview.ts.
// String.raw so nothing here needs double escaping; it must never contain a dollar-brace
// or a backtick, and no backslashes (the page script is also spliced into a non-raw template).
// Everything is prefixed wz so it cannot collide with the dashboard's own classes.

export const WIZARD_VIEW_CSS = String.raw`
  #wz { --wz-bg:#0d0f15; --wz-panel:#141826; --wz-card:#161a24; --wz-line:#232634; --wz-ctl:#1b1f2a; --wz-ctl-line:#2b3040; --wz-text:#e6e6e6; --wz-text2:#c4ccdc; --wz-muted:#8b93a7; --wz-sel:#1a2033; --wz-sel-line:#34406a; --wz-hover:#151925; --wz-on:#26304a; --wz-accent:#6ea2ff; --wz-accent-bg:rgba(110,162,255,.12); --wz-amber:#e8b04a; --wz-amber-bg:rgba(232,176,74,.14); --wz-green:#56d364; --wz-green-bg:rgba(86,211,100,.12); --wz-err:#e5484d; --wz-err-bg:rgba(229,72,77,.13); --wz-code:#0a0c11; --wz-mono:ui-monospace,SFMono-Regular,Menlo,monospace;
    position:fixed; inset:0; z-index:90; display:none; align-items:center; justify-content:center; padding:24px 16px; background:rgba(5,6,10,.72); color:var(--wz-text); font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  #wz.open { display:flex; }
  #wz * { box-sizing:border-box; }
  #wz .wz-modal { width:100%; max-width:960px; height:min(700px,calc(100vh - 48px)); background:var(--wz-card); border:1px solid var(--wz-ctl-line); border-radius:14px; box-shadow:0 24px 80px rgba(0,0,0,.6); display:flex; overflow:hidden; position:relative; }
  #wz .wz-x { position:absolute; right:10px; top:10px; z-index:3; width:28px; height:28px; border-radius:8px; border:1px solid transparent; background:transparent; color:var(--wz-muted); font-size:16px; cursor:pointer; }
  #wz .wz-x:hover { background:var(--wz-on); color:#fff; }
  #wz .wz-rail { width:210px; flex:none; background:var(--wz-panel); border-right:1px solid var(--wz-line); padding:16px 10px; overflow:auto; }
  #wz .wz-lg { font-weight:700; font-size:15px; padding:0 8px 12px; display:flex; align-items:center; gap:8px; }
  #wz .wz-lg i { width:22px; height:22px; border-radius:6px; background:linear-gradient(135deg,#6ea2ff,#c9b4ff); display:inline-block; }
  #wz .wz-ri { display:flex; align-items:center; gap:9px; width:100%; background:transparent; border:0; text-align:left; padding:5px 8px; border-radius:7px; color:var(--wz-muted); font-size:12.5px; cursor:default; }
  #wz .wz-ri.go { cursor:pointer; }
  #wz .wz-ri.go:hover { background:var(--wz-hover); }
  #wz .wz-ri .n { width:20px; height:20px; border-radius:50%; border:1px solid var(--wz-ctl-line); display:inline-flex; align-items:center; justify-content:center; font-size:10.5px; flex:none; }
  #wz .wz-ri.cur { background:var(--wz-on); color:#fff; }
  #wz .wz-ri.cur .n { background:var(--wz-accent); border-color:var(--wz-accent); color:#08101f; font-weight:700; }
  #wz .wz-ri.done { color:var(--wz-text2); }
  #wz .wz-ri.done .n { background:var(--wz-green-bg); border-color:#1f4a28; color:var(--wz-green); }
  #wz .wz-ri.skipped .n { color:var(--wz-muted); }
  #wz .wz-ri.hid { opacity:.55; }
  #wz .wz-ri em { font-style:normal; font-size:10px; color:var(--wz-muted); margin-left:auto; }
  #wz .wz-body { flex:1; min-width:0; display:flex; flex-direction:column; }
  #wz .wz-bar { display:none; padding:12px 44px 0 16px; }
  #wz .wz-bar .t { font-size:12px; color:var(--wz-muted); }
  #wz .wz-bar .b { height:4px; background:var(--wz-ctl); border-radius:2px; overflow:hidden; margin-top:6px; }
  #wz .wz-bar .b i { display:block; height:100%; background:var(--wz-accent); }
  #wz .wz-head { padding:20px 44px 10px 26px; }
  #wz .wz-k { font-size:11.5px; color:var(--wz-muted); text-transform:uppercase; letter-spacing:.06em; }
  #wz .wz-head h2 { margin:2px 0 8px; font-size:21px; font-weight:700; display:flex; align-items:center; gap:10px; flex-wrap:wrap; color:var(--wz-text); }
  #wz .wz-why { color:var(--wz-text2); font-size:13.5px; }
  #wz .wz-why b, #wz .wz-unl b { color:var(--wz-muted); font-weight:600; font-size:11.5px; text-transform:uppercase; letter-spacing:.05em; margin-right:6px; }
  #wz .wz-unl { margin:10px 0 0; padding:9px 12px; background:var(--wz-accent-bg); border:1px solid var(--wz-sel-line); border-radius:8px; }
  #wz .wz-unl b { color:var(--wz-accent); margin:0; }
  #wz .wz-unl ul { margin:3px 0 0; padding-left:18px; color:var(--wz-text2); font-size:12.5px; }
  #wz .wz-cont { padding:6px 26px 14px; flex:1; overflow:auto; min-height:0; }
  #wz .wz-foot { display:flex; align-items:center; gap:8px; padding:12px 26px; border-top:1px solid var(--wz-line); background:var(--wz-panel); }
  #wz .wz-foot .sp { flex:1; }
  #wz .wz-foot .ct { color:var(--wz-muted); font-size:12px; }
  #wz .wz-err { margin:0 26px 10px; }
  #wz .stack > * + * { margin-top:10px; }
  #wz .btn { height:32px; border-radius:8px; border:1px solid var(--wz-ctl-line); background:var(--wz-ctl); color:var(--wz-text2); padding:0 12px; font:inherit; font-size:13px; white-space:nowrap; cursor:pointer; }
  #wz .btn:hover { background:var(--wz-on); color:#fff; }
  #wz .btn.pri { background:var(--wz-accent); border-color:var(--wz-accent); color:#08101f; font-weight:600; }
  #wz .btn.pri:hover { filter:brightness(1.1); color:#08101f; }
  #wz .btn.sm { height:26px; font-size:12px; padding:0 9px; border-radius:6px; }
  #wz .btn.ghost { background:transparent; }
  #wz .btn.danger { color:#ff8a8e; border-color:#5a2a2e; }
  #wz .btn[disabled] { opacity:.4; cursor:not-allowed; filter:none; }
  #wz .pill { display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 9px; border-radius:11px; font-size:11.5px; font-weight:600; white-space:nowrap; }
  #wz .pill.ok { background:var(--wz-green-bg); color:var(--wz-green); }
  #wz .pill.warn { background:var(--wz-amber-bg); color:var(--wz-amber); }
  #wz .pill.err { background:var(--wz-err-bg); color:#ff8a8e; }
  #wz .pill.off { background:#1d212c; color:var(--wz-muted); }
  #wz .pill.optl { background:var(--wz-accent-bg); color:var(--wz-accent); }
  #wz input[type=text], #wz input[type=password], #wz select, #wz textarea { background:var(--wz-ctl); color:var(--wz-text); border:1px solid var(--wz-ctl-line); border-radius:8px; padding:0 10px; height:32px; font:inherit; font-size:13px; max-width:100%; }
  #wz textarea { height:auto; padding:8px 10px; width:100%; font-family:var(--wz-mono); font-size:12px; }
  #wz input:focus, #wz select:focus, #wz button:focus-visible { outline:1px solid var(--wz-accent); border-color:var(--wz-accent); }
  #wz code, #wz .kbd { font-family:var(--wz-mono); font-size:12px; background:var(--wz-code); border:1px solid var(--wz-line); border-radius:5px; padding:0 5px; }
  #wz .kbd { display:inline-block; padding:1px 7px; background:var(--wz-ctl); border-color:var(--wz-ctl-line); color:var(--wz-text); }
  #wz pre { margin:0; background:var(--wz-code); border:1px solid var(--wz-line); border-radius:8px; padding:10px 12px; font:12px/1.55 var(--wz-mono); color:var(--wz-text2); overflow:auto; max-height:210px; white-space:pre; }
  #wz .tg { position:relative; display:inline-block; width:36px; height:20px; flex:none; }
  #wz .tg input { position:absolute; opacity:0; inset:0; margin:0; cursor:pointer; z-index:2; }
  #wz .tg i { position:absolute; inset:0; background:#2b3040; border-radius:10px; transition:.15s; }
  #wz .tg i:after { content:""; position:absolute; left:2px; top:2px; width:16px; height:16px; border-radius:50%; background:#c4ccdc; transition:.15s; }
  #wz .tg input:checked + i { background:var(--wz-accent); }
  #wz .tg input:checked + i:after { left:18px; background:#fff; }
  #wz .note { border:1px solid var(--wz-ctl-line); background:var(--wz-panel); border-radius:8px; padding:9px 11px; font-size:12.5px; color:var(--wz-text2); }
  #wz .note.warn { border-color:#5b4a1a; background:var(--wz-amber-bg); color:#f0cf8a; }
  #wz .note.err { border-color:#5a2a2e; background:var(--wz-err-bg); color:#ffb0b3; }
  #wz .note.ok { border-color:#1f4a28; background:var(--wz-green-bg); color:#9fe0aa; }
  #wz .def { font-size:11.5px; color:var(--wz-muted); }
  #wz .def b { color:var(--wz-text2); }
  #wz .lrow { display:flex; align-items:center; gap:10px; padding:9px 11px; border:1px solid var(--wz-line); border-radius:9px; background:var(--wz-bg); flex-wrap:wrap; }
  #wz .lrow .t { flex:1; min-width:150px; }
  #wz .lrow .t b { display:block; font-size:13px; color:var(--wz-text); }
  #wz .lrow .t span { font-size:12px; color:var(--wz-muted); }
  #wz .st { width:22px; height:22px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; flex:none; }
  #wz .st.y { background:var(--wz-green-bg); color:var(--wz-green); }
  #wz .st.n { background:var(--wz-err-bg); color:#ff8a8e; }
  #wz .st.o { background:#1d212c; color:var(--wz-muted); }
  #wz .st.w { background:var(--wz-amber-bg); color:var(--wz-amber); }
  #wz .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:10px; }
  #wz .opt { border:1px solid var(--wz-ctl-line); background:var(--wz-bg); border-radius:10px; padding:12px; cursor:pointer; position:relative; text-align:left; color:inherit; font:inherit; }
  #wz .opt:hover { background:var(--wz-hover); }
  #wz .opt.sel { border-color:var(--wz-accent); background:var(--wz-sel); }
  #wz .opt.dis { opacity:.5; cursor:not-allowed; }
  #wz .opt b { display:block; margin-bottom:2px; color:var(--wz-text); padding-right:70px; }
  #wz .opt .d { font-size:12px; color:var(--wz-muted); display:block; }
  #wz .opt ul { margin:6px 0 0; padding-left:16px; font-size:12px; color:var(--wz-text2); }
  #wz .opt .rec { position:absolute; top:8px; right:8px; }
  #wz .opt .ic { font-size:20px; margin-bottom:4px; }
  #wz .subs { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
  #wz .chk { display:flex; gap:9px; align-items:flex-start; font-size:13px; }
  #wz .chk input { margin-top:3px; }
  #wz .fld label { display:block; font-size:12px; color:var(--wz-muted); margin-bottom:3px; }
  #wz .fld input[type=text], #wz .fld input[type=password], #wz .fld select { width:100%; }
  #wz .g2 { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
  #wz .grp { margin:6px 0 4px; font-size:11.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--wz-muted); }
  #wz .grp span { text-transform:none; letter-spacing:0; font-weight:400; font-size:11.5px; margin-left:6px; }
  #wz table { border-collapse:collapse; width:100%; font-size:12.5px; }
  #wz th { text-align:left; color:var(--wz-muted); font-weight:600; font-size:11.5px; padding:6px 8px; border-bottom:1px solid var(--wz-line); white-space:nowrap; }
  #wz td { padding:7px 8px; border-bottom:1px solid var(--wz-line); vertical-align:middle; color:var(--wz-text2); }
  #wz .tblw { overflow-x:auto; }
  #wz .exp { border:1px solid var(--wz-line); border-radius:8px; }
  #wz .exp > button { width:100%; text-align:left; background:transparent; border:0; padding:8px 11px; color:var(--wz-text2); font:inherit; font-size:12.5px; cursor:pointer; }
  #wz .exp > div { display:none; padding:0 11px 11px; }
  #wz .exp.open > div { display:block; }
  #wz .flow { display:grid; grid-template-columns:1fr auto 1fr; gap:10px; align-items:center; }
  #wz .flow .box { border:1px dashed var(--wz-ctl-line); border-radius:9px; padding:9px 11px; font-size:12.5px; background:var(--wz-bg); }
  #wz .flow .ar { color:var(--wz-accent); font-size:20px; }
  #wz .slackmini { border:1px solid var(--wz-ctl-line); border-radius:10px; background:#1a1d29; padding:10px 12px; position:relative; font-size:12.5px; margin-top:12px; }
  #wz .slackmini .tb { position:absolute; right:10px; top:-14px; background:#232634; border:1px solid var(--wz-ctl-line); border-radius:8px; padding:2px 6px; display:flex; gap:6px; color:var(--wz-muted); font-size:12px; }
  #wz .slackmini .tb .hl { background:#2a2140; color:#c9b4ff; border-radius:5px; padding:0 6px; font-weight:600; }
  #wz .badge { display:inline-block; font-size:10.5px; border-radius:4px; padding:0 5px; margin-left:4px; font-weight:700; }
  #wz .badge.pr { background:#15301d; color:#9fe0aa; }
  #wz .badge.sl { background:#2a2140; color:#c9b4ff; }
  #wz .rec-box { display:inline-flex; align-items:center; gap:8px; height:38px; padding:0 14px; border:1px solid var(--wz-sel-line); background:var(--wz-sel); border-radius:9px; font-size:16px; letter-spacing:.04em; }
  #wz .rec-box.live { border-color:var(--wz-amber); }
  #wz .prac { border:1px dashed var(--wz-sel-line); border-radius:10px; padding:14px; background:var(--wz-sel); text-align:center; }
  #wz .prac.good { border-style:solid; border-color:#1f4a28; background:var(--wz-green-bg); }
  #wz .prac.bad { border-style:solid; border-color:#5a2a2e; background:var(--wz-err-bg); }
  #wz .pulse { display:inline-block; width:9px; height:9px; border-radius:50%; background:var(--wz-amber); margin-right:6px; animation:wzpl 1.2s infinite; }
  @keyframes wzpl { 50% { opacity:.25; } }
  #wz .sumgrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(250px,1fr)); gap:8px; }
  #wz .log { max-height:120px; overflow:auto; font-size:11px; }
  #wz .spin { display:inline-block; width:12px; height:12px; border:2px solid var(--wz-ctl-line); border-top-color:var(--wz-accent); border-radius:50%; animation:wzsp .8s linear infinite; vertical-align:-2px; margin-right:6px; }
  @keyframes wzsp { to { transform:rotate(360deg); } }
  #wzresume { position:fixed; right:18px; bottom:18px; z-index:80; display:none; align-items:center; gap:10px; padding:8px 8px 8px 14px; border-radius:12px; border:1px solid #34406a; background:#161a24; color:#e6e6e6; font:13px -apple-system,Segoe UI,Roboto,sans-serif; box-shadow:0 10px 30px rgba(0,0,0,.5); }
  #wzresume.on { display:flex; }
  #wzresume button { height:28px; padding:0 12px; border-radius:8px; border:1px solid #6ea2ff; background:#6ea2ff; color:#08101f; font-weight:600; font:inherit; font-weight:600; cursor:pointer; }
  @media (max-width:760px) {
    #wz .wz-rail { display:none; }
    #wz .wz-bar { display:block; }
    #wz .wz-modal { height:calc(100vh - 32px); }
    #wz .wz-head, #wz .wz-cont, #wz .wz-foot { padding-left:16px; padding-right:16px; }
    #wz .wz-head { padding-right:44px; }
    #wz .wz-err { margin-left:16px; margin-right:16px; }
    #wz .flow { grid-template-columns:1fr; }
    #wz .flow .ar { transform:rotate(90deg); text-align:center; }
    #wz .g2 { grid-template-columns:1fr; }
  }
`;

export const WIZARD_VIEW_HTML = String.raw`
<div id="wz" role="dialog" aria-modal="true" aria-labelledby="wz-title" aria-hidden="true">
  <div class="wz-modal">
    <button class="wz-x" id="wz-x" aria-label="Close setup" title="Close. Setup resumes where you left off.">&#10005;</button>
    <nav class="wz-rail" id="wz-rail" aria-label="Setup steps"></nav>
    <div class="wz-body">
      <div class="wz-bar"><div class="t" id="wz-bar-t"></div><div class="b"><i id="wz-bar-i"></i></div></div>
      <div class="wz-head">
        <div class="wz-k" id="wz-k"></div>
        <h2 id="wz-title"></h2>
        <div class="wz-why"><b>What this is for</b><span id="wz-why"></span></div>
        <div class="wz-unl"><b>What this unlocks</b><ul id="wz-unl"></ul></div>
      </div>
      <div class="wz-cont" id="wz-cont"></div>
      <div class="wz-err" id="wz-err"></div>
      <div class="wz-foot">
        <button class="btn" id="wz-back">Back</button>
        <span class="ct" id="wz-ct"></span>
        <span class="sp"></span>
        <button class="btn ghost" id="wz-skip">Skip</button>
        <button class="btn pri" id="wz-next">Continue</button>
      </div>
    </div>
  </div>
</div>
<div id="wzresume"><span>Setup is not finished.</span><button id="wzresume-go">Resume setup</button></div>
`;

export const WIZARD_VIEW_JS = String.raw`
// ---- Setup wizard ---------------------------------------------------------------
var WZ = { v: null, open: false, busy: false, S: null, loaded: {}, req: null, reqT: null, reqBusy: false, job: null, jobT: null,
  login: null, plugin: null, slack: null, slackSub: 0, manifest: null, slackBusy: false, slackMsg: null, tpl: null, ship: null,
  proj: null, ax: null, axT: null, axNative: false, axAsked: false, slackApp: null, rec: false, recRes: null, prac: null, pracT: null, summary: null, err: '' };

function wzEsc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (m) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]; }); }
function wzEl(id) { return document.getElementById(id); }
function wzJson(method, url, body) {
  var o = { method: method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) o.body = JSON.stringify(body);
  return fetch(url, o).then(function (r) { return r.json().then(function (j) { j.__status = r.status; return j; }); });
}
function wzGet(url) { return fetch(url).then(function (r) { return r.json(); }); }

function wzFmtKey(acc) {
  var sym = { command: '⌘', cmd: '⌘', commandorcontrol: '⌘', control: '⌃', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧' };
  return String(acc || '').split('+').map(function (p) { return sym[p.toLowerCase()] || p; }).join('');
}

/* ---------- boot, open, close ---------- */
function wzBoot() {
  wzGet('/api/wizard').then(function (v) {
    if (!v || !v.ok) return;
    WZ.v = v;
    if (v.show) wzOpen(); else wzResumePill();
  }).catch(function () {});
}
function wzResumePill() {
  var p = wzEl('wzresume');
  if (p) p.classList.toggle('on', !!(WZ.v && WZ.v.show) && !WZ.open);
}
// Called by Settings > Help ("Run setup again") with {rerun:true}, and by the Resume pill.
function openWizard(opts) {
  opts = opts || {};
  var go = function () { wzGet('/api/wizard').then(function (v) { WZ.v = v; wzOpen(); }); };
  if (opts.rerun) wzJson('POST', '/api/wizard/rerun', {}).then(function (r) { if (r && r.ok) { WZ.S = null; WZ.loaded = {}; go(); } });
  else go();
}
window.openWizard = openWizard;
function wzOpen() {
  WZ.open = true;
  WZ.err = '';
  if (!WZ.S) wzInitStaged();
  var w = wzEl('wz'); w.classList.add('open'); w.setAttribute('aria-hidden', 'false');
  wzResumePill();
  wzRender();
}
function wzClose() {
  wzStopTimers();
  WZ.open = false;
  var w = wzEl('wz'); w.classList.remove('open'); w.setAttribute('aria-hidden', 'true');
  wzJson('POST', '/api/wizard/close', {}).then(function (r) { if (r && r.ok) WZ.v = r.view; wzResumePill(); });
}
function wzStopTimers() {
  ['reqT', 'jobT', 'axT', 'pracT'].forEach(function (k) { if (WZ[k]) { clearInterval(WZ[k]); WZ[k] = null; } });
  if (WZ.rec) wzStopRecording();
}

/* ---------- staged values: kept in memory so Back never loses an edit ---------- */
function wzInitStaged() {
  var val = (WZ.v && WZ.v.values) || {};
  WZ.S = {
    claude_bin: val.claude_bin || '', showBin: false,
    projects: null, remove: [], pick: '',
    terminal: val.terminal || 'inside',
    perm: val.perm_chats === 'skip' ? 'skip' : 'normal', permW: val.perm_watchers === 'skip' ? 'skip' : 'normal', permO: val.perm_orchestrator === 'skip' ? 'skip' : 'normal', confirm: false,
    slackChoice: val.slack_mode === 'mcp' ? 'mcp' : val.slack_mode === 'direct' ? 'direct' : 'direct', readonly: false, token: '',
    hotkey: val.hotkey || 'Command+Shift+L', hotkeyDisplay: val.hotkey_display || wzFmtKey('Command+Shift+L'),
    ship: null,
    orchOn: !!val.orchestrator_enabled, orchNotify: val.orchestrator_notify || 'needs_you', orchTrust: !!val.orchestrator_trust, orchDir: val.orchestrator_dir || '',
    templates: {}
  };
}

/* ---------- rendering ---------- */
function wzCur() { return WZ.v.current; }
function wzRender() {
  if (!WZ.v) return;
  var v = WZ.v, st = v.step, id = v.current;
  wzStopTimers();
  wzEl('wz-k').textContent = 'Step ' + v.progress.index + ' of ' + v.progress.total;
  wzEl('wz-title').innerHTML = wzEsc(st.title) + (st.optional ? ' <span class="pill optl">Optional</span>' : '');
  wzEl('wz-why').textContent = st.why;
  wzEl('wz-unl').innerHTML = st.unlocks.map(function (u) { return '<li>' + wzEsc(u) + '</li>'; }).join('');
  wzEl('wz-bar-t').textContent = 'Step ' + v.progress.index + ' of ' + v.progress.total + ' · ' + st.title;
  wzEl('wz-bar-i').style.width = v.progress.percent + '%';
  wzRail();
  wzEl('wz-back').disabled = v.rail[0].current || WZ.busy;
  wzEl('wz-skip').style.display = st.skippable ? '' : 'none';
  wzEl('wz-skip').disabled = WZ.busy;
  wzEl('wz-err').innerHTML = WZ.err ? '<div class="note err">' + wzEsc(WZ.err) + '</div>' : '';
  var cont = wzEl('wz-cont');
  cont.innerHTML = '';
  var fn = WZ_STEPS[id];
  if (fn) fn(cont);
  cont.scrollTop = 0;
  wzFooter();
}
function wzRail() {
  var v = WZ.v;
  wzEl('wz-rail').innerHTML = '<div class="wz-lg"><i></i>Loom setup</div>' + v.rail.map(function (r, i) {
    var cls = 'wz-ri' + (r.current ? ' cur' : '') + (r.status === 'done' && !r.current ? ' done' : '') + (r.status === 'skipped' && !r.current ? ' skipped' : '') + (!r.visible ? ' hid' : '') + (r.reachable && !r.current ? ' go' : '');
    var mark = r.current ? String(i + 1) : r.status === 'done' ? '✓' : r.status === 'skipped' ? '–' : String(i + 1);
    var tag = !r.visible ? '<em>needs Slack</em>' : r.optional ? '<em>optional</em>' : '';
    return '<button class="' + cls + '" data-wz-go="' + r.id + '"' + (r.reachable && !r.current ? '' : ' tabindex="-1"') + '><span class="n">' + mark + '</span>' + wzEsc(r.title) + tag + '</button>';
  }).join('');
}
function wzFooter() {
  var id = wzCur(), next = wzEl('wz-next'), ct = wzEl('wz-ct');
  ct.textContent = '';
  next.disabled = WZ.busy;
  if (id === 'welcome') next.textContent = 'Get started';
  else if (id === 'done') { next.textContent = 'Take the tour'; wzEl('wz-skip').style.display = ''; wzEl('wz-skip').textContent = 'Not now'; }
  else { next.textContent = 'Continue'; wzEl('wz-skip').textContent = 'Skip'; }
  if (id === 'requirements') {
    var ok = WZ.req && WZ.req.ready;
    next.disabled = next.disabled || !ok;
    ct.textContent = ok ? '' : 'Install what is missing and log in to continue';
  }
  if (id === 'permissions' && (WZ.S.perm === 'skip' || WZ.S.permW === 'skip' || WZ.S.permO === 'skip') && !WZ.S.confirm) { next.disabled = true; ct.textContent = 'Tick the box to continue with Skip permissions'; }
}

/* ---------- actions ---------- */
function wzValues(id) {
  var S = WZ.S;
  if (id === 'requirements') return { claude_bin: S.claude_bin };
  if (id === 'projects') return { projects: (S.projects || []).map(function (p) { return { path: p.path, name: p.name }; }), remove: S.remove };
  if (id === 'terminal') return { terminal: S.terminal };
  if (id === 'permissions') return { perm_chats: S.perm, perm_watchers: S.permW, perm_orchestrator: S.permO, confirm_skip: S.confirm };
  if (id === 'slack') return { mode: S.slackChoice };
  if (id === 'shortcut') return { hotkey: S.hotkey };
  if (id === 'ship') return { ship: (S.ship || []).map(function (r) { return { path: r.path, enabled: r.enabled, base_branch: r.base, ship_command: r.command, label_required: r.label }; }) };
  if (id === 'orchestrator') return { enabled: S.orchOn, notify: S.orchNotify, trust: S.orchOn && S.orchTrust };
  if (id === 'watchers') return { templates: Object.keys(S.templates).filter(function (k) { return S.templates[k]; }) };
  return {};
}
function wzApply(r) {
  WZ.busy = false;
  if (r && r.view) WZ.v = r.view;
  if (r && r.ok) { WZ.err = ''; return true; }
  WZ.err = (r && r.detail) || 'That did not work.';
  return false;
}
function wzContinue() {
  var id = wzCur();
  if (id === 'done') return wzFinish(true);
  WZ.busy = true; wzFooter();
  wzJson('POST', '/api/wizard/continue', { step: id, values: wzValues(id) }).then(function (r) { wzApply(r); wzRender(); }).catch(function () { WZ.busy = false; WZ.err = 'Loom did not answer.'; wzRender(); });
}
function wzSkip() {
  var id = wzCur();
  if (id === 'done') return wzFinish(false);
  WZ.busy = true; wzFooter();
  wzJson('POST', '/api/wizard/skip', { step: id }).then(function (r) { wzApply(r); wzRender(); });
}
function wzBack() {
  WZ.busy = true;
  wzJson('POST', '/api/wizard/back', {}).then(function (r) { wzApply(r); wzRender(); });
}
function wzGo(id) {
  wzJson('POST', '/api/wizard/goto', { step: id }).then(function (r) { wzApply(r); wzRender(); });
}
function wzFinish(tour) {
  WZ.busy = true; wzFooter();
  wzJson('POST', '/api/wizard/finish', { tour: tour }).then(function (r) {
    if (!wzApply(r)) { wzRender(); return; }
    WZ.open = false;
    var w = wzEl('wz'); w.classList.remove('open'); w.setAttribute('aria-hidden', 'true');
    wzResumePill();
    if (tour) {
      if (typeof window.startTour === 'function') window.startTour(0);
      else document.dispatchEvent(new CustomEvent('loom:start-tour'));
    }
  });
}

/* ---------- step bodies ---------- */
var WZ_STEPS = {};

WZ_STEPS.welcome = function (c) {
  c.innerHTML = '<div class="stack">'
    + '<div class="note">Loom is a dashboard for your Claude Code sessions. It finds every chat on your machine, shows which are working, waiting on you or finished, and takes you to the right terminal in one click.</div>'
    + '<div class="cards">'
    + '<div class="opt" style="cursor:default"><div class="ic">&#9776;</div><b>One list</b><span class="d">Every chat across every project, grouped by what needs you.</span></div>'
    + '<div class="opt" style="cursor:default"><div class="ic">&#9654;</div><b>Run them here</b><span class="d">Each chat runs in tmux, so it survives closing the window.</span></div>'
    + '<div class="opt" style="cursor:default"><div class="ic">&#9993;</div><b>Slack and PRs</b><span class="d">Optional. Draft replies, watch channels, ship PRs, and jump from a Slack message to its chat with one shortcut.</span></div>'
    + '</div>'
    + '<div class="def">Setup takes about five minutes. Everything after Requirements is optional and can be changed later in Settings. Nothing is changed on your machine until you press an Install or Allow button.</div>'
    + '</div>';
};

/* -- requirements -- */
function wzReqRows() {
  var r = WZ.req;
  if (!r) return '<div class="def"><span class="spin"></span>Checking this Mac...</div>';
  return r.rows.map(function (row) {
    var mark = row.ok ? '<span class="st y">&#10003;</span>' : row.required ? '<span class="st n">&#10007;</span>' : '<span class="st o">&ndash;</span>';
    var btn = '';
    if (row.ok) btn = '<span class="pill ok">' + (row.id === 'login' ? 'Logged in' : 'Ready') + '</span>';
    else if (row.fix === 'brew-tmux' || row.fix === 'brew-gh') {
      var tool = row.fix === 'brew-tmux' ? 'tmux' : 'gh';
      var running = WZ.job && WZ.job.tool === tool && WZ.job.status === 'running';
      btn = row.fixBlocked ? '<span class="def" style="max-width:220px">' + wzEsc(row.fixBlocked) + '</span>'
        : '<button class="btn ' + (row.required ? 'pri ' : '') + 'sm" data-wz-install="' + tool + '"' + (running ? ' disabled' : '') + '>' + (running ? 'Installing...' : 'Install via Homebrew') + '</button>';
    } else if (row.fix === 'login') {
      btn = row.fixBlocked ? '<span class="def" style="max-width:220px">' + wzEsc(row.fixBlocked) + '</span>'
        : '<button class="btn pri sm" data-wz-login="1">Log in</button>';
    }
    var opt = row.required ? '' : ' <span class="pill optl">Optional</span>';
    return '<div class="lrow">' + mark + '<div class="t"><b>' + wzEsc(row.title) + opt + '</b><span>' + wzEsc(row.detail) + '</span></div>' + btn + '</div>';
  }).join('');
}
function wzReqDraw() {
  var el = wzEl('wz-reqrows');
  if (el) el.innerHTML = wzReqRows();
  var lg = wzEl('wz-reqlog');
  if (lg) {
    var j = WZ.job;
    lg.innerHTML = j ? '<div class="note ' + (j.status === 'failed' ? 'err' : j.status === 'done' ? 'ok' : '') + '"><b>brew install ' + wzEsc(j.tool) + '</b> ' + (j.status === 'running' ? '<span class="spin"></span>running' : j.status === 'done' ? 'finished' : 'failed (exit ' + wzEsc(j.code) + ')') + '<pre class="log">' + wzEsc(j.log || '') + '</pre></div>' : '';
  }
  var lo = wzEl('wz-reqlogin');
  if (lo) {
    var l = WZ.login;
    lo.innerHTML = l ? (l.ok ? '<div class="note ok">Opened <b>' + wzEsc(l.session) + '</b> in Loom&#39;s Terminals list. Finish signing in there, then come back: this page checks again by itself. <button class="btn sm" data-wz-openterm="1">Open it</button></div>' : '<div class="note err">' + wzEsc(l.detail) + '</div>') : '';
  }
  wzFooter();
}
function wzReqLoad(fresh) {
  if (WZ.reqBusy) return;
  WZ.reqBusy = true;
  wzGet('/api/wizard/requirements' + (fresh ? '?fresh=1' : '')).then(function (r) {
    WZ.reqBusy = false;
    if (wzCur() !== 'requirements') return;
    if (r && r.ok) { WZ.req = r; wzReqDraw(); }
  }).catch(function () { WZ.reqBusy = false; });
}
WZ_STEPS.requirements = function (c) {
  c.innerHTML = '<div class="stack"><div id="wz-reqrows" class="stack"></div><div id="wz-reqlog"></div><div id="wz-reqlogin"></div>'
    + '<div class="def">Required checks must pass to continue. Optional items can stay unchecked. Loom checks again every few seconds while this step is open.</div>'
    + '<div class="exp' + (WZ.S.showBin ? ' open' : '') + '" id="wz-binexp"><button data-wz-toggle="wz-binexp">&#9656; Claude Code installed somewhere unusual?</button><div>'
    + '<div class="fld"><label>Path to the claude program (leave empty to find it automatically)</label><div style="display:flex;gap:8px"><input type="text" id="wz-bin" data-wz-f="claude_bin" value="' + wzEsc(WZ.S.claude_bin) + '" placeholder="/path/to/claude" style="flex:1"><button class="btn" data-wz-recheck="1">Check again</button></div></div></div></div>'
    + '</div>';
  wzReqDraw();
  wzReqLoad(true);
  WZ.reqT = setInterval(function () { if (!document.hidden) wzReqLoad(false); }, 3000);
};

/* -- projects -- */
function wzProjLoad() {
  wzGet('/api/wizard/projects').then(function (r) {
    if (!r || !r.ok || wzCur() !== 'projects') return;
    if (WZ.S.projects === null) WZ.S.projects = r.projects.map(function (p) { return { path: p.path, name: p.name, existing: true }; });
    WZ.proj = r;
    wzProjDraw();
  });
}
function wzProjDraw() {
  var S = WZ.S, el = wzEl('wz-plist');
  if (!el) return;
  var rows = (S.projects || []).map(function (p, i) {
    return '<div class="lrow"><span class="st y">&#9636;</span><div class="t"><input type="text" data-wz-pname="' + i + '" value="' + wzEsc(p.name) + '" style="width:100%;max-width:240px" aria-label="Project name"><span style="display:block;margin-top:2px;font-family:var(--wz-mono)">' + wzEsc(p.path) + '</span></div><button class="btn sm danger" data-wz-prm="' + i + '">Remove</button></div>';
  }).join('');
  el.innerHTML = rows || '<div class="note">No projects yet. This is fine: you can add folders now, or later from the New thread dialog or Settings &rsaquo; Projects.</div>';
  var sg = wzEl('wz-psug');
  var have = {};
  (S.projects || []).forEach(function (p) { have[p.path] = true; });
  var sug = ((WZ.proj && WZ.proj.suggestions) || []).filter(function (s) { return !have[s.path]; });
  sg.innerHTML = sug.length ? '<div class="grp">Found in your Claude history<span>folders you have already used Claude Code in</span></div><div class="stack">' + sug.map(function (s, i) {
    return '<label class="chk"><input type="checkbox" data-wz-psug="' + i + '"><span><b>' + wzEsc(s.name) + '</b> <span class="def" style="font-family:var(--wz-mono)">' + wzEsc(s.path) + '</span></span></label>';
  }).join('') + '</div>' : '';
  WZ.sugList = sug;
}
function wzAddProject(path) {
  path = (path || '').trim();
  if (!path) return;
  var S = WZ.S;
  if ((S.projects || []).some(function (p) { return p.path === path; })) return;
  S.projects = (S.projects || []).concat([{ path: path, name: path.split('/').filter(Boolean).pop() || path, existing: false }]);
  S.remove = S.remove.filter(function (r) { return r !== path; });
  wzProjDraw();
}
WZ_STEPS.projects = function (c) {
  var native = !!(window.loomNative && window.loomNative.pickFolder);
  c.innerHTML = '<div class="stack"><div id="wz-plist" class="stack"></div>'
    + (native ? '<div><button class="btn" data-wz-pickfolder="1">+ Add folder...</button></div>'
      : '<div style="display:flex;gap:8px"><input type="text" id="wz-ppath" placeholder="/absolute/path/to/folder" style="flex:1" aria-label="Folder path"><button class="btn" data-wz-addpath="1">Add folder</button></div>')
    + '<div id="wz-psug"></div>'
    + '<div class="def">Names are labels only. Loom groups chats by the folder they were started in. You can add more later from the New thread dialog or Settings &rsaquo; Projects.</div></div>';
  wzProjDraw();
  wzProjLoad();
};

/* -- terminal -- */
WZ_STEPS.terminal = function (c) {
  var T = [
    ['inside', 'Inside Loom', 'Chats open in a built-in terminal tab. Nothing else to install or permit.', true],
    ['ghostty', 'Ghostty', 'Jump to the chat&#39;s tab in Ghostty. Needs Accessibility and Automation access.', false],
    ['iterm2', 'iTerm2', 'Jump to the chat&#39;s session in iTerm2. Needs Automation access.', false],
    ['terminal', 'Terminal.app', 'Use the macOS Terminal. Needs Automation access.', false]
  ];
  var note = WZ.S.terminal === 'inside' ? 'Inside Loom needs no macOS permissions. You can still attach from any terminal with <code>tmux -L loom attach</code>.'
    : '<b>' + wzEsc({ ghostty: 'Ghostty', iterm2: 'iTerm2', terminal: 'Terminal.app' }[WZ.S.terminal]) + '</b> needs macOS ' + (WZ.S.terminal === 'ghostty' ? 'Accessibility and Automation' : 'Automation') + ' permission, for the "Loom" rows in System Settings. ' + (WZ.S.terminal === 'ghostty' ? 'The next step grants Accessibility. ' : '') + 'macOS asks for Automation the first time Loom switches a tab.';
  c.innerHTML = '<div class="stack"><div class="cards" id="wz-term">' + T.map(function (t) {
    return '<button class="opt' + (WZ.S.terminal === t[0] ? ' sel' : '') + '" data-wz-term="' + t[0] + '">' + (t[3] ? '<span class="pill ok rec">Recommended</span>' : '') + '<b>' + t[1] + '</b><span class="d">' + t[2] + '</span></button>';
  }).join('') + '</div><div class="note" id="wz-termnote">' + note + '</div></div>';
};

/* -- macos access (macOS privacy permissions; not the Agent permissions step) -- */
WZ_STEPS.macos = function (c) {
  var term = WZ.S.terminal;
  c.innerHTML = '<div class="stack">'
    + '<div class="note">macOS lists Loom as <b>Loom</b> in System Settings &rsaquo; Privacy &amp; Security. Nothing here is required: Loom runs without it, and everything can be granted later from Settings.</div>'
    + '<div class="g2">' + wzAxRow()
    + '<div class="lrow"><span class="st o">&ndash;</span><div class="t"><b>Automation</b><span>' + (term === 'inside' ? 'Not needed while chats open inside Loom.' : 'macOS asks "Loom wants access to control ..." the first time Loom switches a terminal tab. Choose Allow.') + '</span></div><span class="pill off">Asked on first use</span></div></div>'
    + '<div class="def">Accessibility lets the Slack shortcut read which message is under the pointer, and lets Jump switch to the chat&#39;s tab in Ghostty. If Slack is connected, macOS may also ask once whether Loom can use its Keychain item; choose Always Allow.</div>'
    + '</div>';
  wzAxPoll();
};

/* -- permissions -- */
WZ_STEPS.permissions = function (c) {
  var S = WZ.S;
  var anySkip = S.perm === 'skip' || S.permW === 'skip' || S.permO === 'skip';
  c.innerHTML = '<div class="stack"><div class="cards" id="wz-perm">'
    + '<button class="opt' + (S.perm === 'normal' ? ' sel' : '') + '" data-wz-perm="normal"><span class="pill ok rec">Recommended</span><b>Normal</b><span class="d">Claude asks before running commands or editing files, using your Claude Code permission rules.</span><ul><li>Risk: you will see more prompts, and unattended chats stop to wait for you.</li></ul></button>'
    + '<button class="opt' + (S.perm === 'skip' ? ' sel' : '') + '" data-wz-perm="skip"><span class="pill err rec">Higher risk</span><b>Skip permissions</b><span class="d">Chats started from Loom run with <code>--dangerously-skip-permissions</code>. No prompts.</span><ul><li>Risk: a mistaken or injected instruction can delete files, push code or run any command as you, without asking.</li><li>Risk: applies to every chat Loom starts, including resumed ones.</li></ul></button>'
    + '</div>'
    + '<label class="chk" id="wz-skipconf" style="display:' + (anySkip ? 'flex' : 'none') + '"><input type="checkbox" data-wz-confirm="1"' + (S.confirm ? ' checked' : '') + '><span>I understand Claude can run commands and change files on this Mac without asking me, and I want Loom to start chats this way.</span></label>'
    + '<div class="exp' + (S.permW !== 'normal' || S.permO !== 'normal' ? ' open' : '') + '" id="wz-permx"><button data-wz-toggle="wz-permx">&#9656; Watcher workers and the orchestrator have their own switches</button><div>'
    + '<div class="g2"><div class="fld"><label>Watcher workers</label><select data-wz-f="permW"><option value="normal"' + (S.permW === 'normal' ? ' selected' : '') + '>Normal</option><option value="skip"' + (S.permW === 'skip' ? ' selected' : '') + '>Skip permissions</option></select></div>'
    + '<div class="fld"><label>Orchestrator</label><select data-wz-f="permO"><option value="normal"' + (S.permO === 'normal' ? ' selected' : '') + '>Normal</option><option value="skip"' + (S.permO === 'skip' ? ' selected' : '') + '>Skip permissions</option></select></div></div>'
    + '<div class="def" style="margin-top:6px">These run unattended, so Normal means they pause for an answer. Leave them on Normal unless you know you want otherwise.</div></div></div>'
    + '<div class="def">This only sets the default for chats Loom starts. Chats you start yourself in a terminal are unaffected.</div></div>';
};

/* -- plugin -- */
function wzPluginLoad() {
  wzGet('/api/plugin/status').then(function (s) { WZ.plugin = s; if (wzCur() === 'plugin') wzPluginDraw(); }).catch(function () {});
}
function wzPluginDraw() {
  var el = wzEl('wz-plugin');
  if (!el) return;
  var s = WZ.plugin;
  if (!s) { el.innerHTML = '<div class="def"><span class="spin"></span>Checking...</div>'; return; }
  var pill = { not_installed: ['off', 'Not installed'], installed: ['ok', 'Installed v' + (s.installedVersion || '')], update_available: ['warn', 'Update available'], disabled: ['warn', 'Disabled in Claude'], error: ['err', 'Error'] }[s.status] || ['off', s.status];
  var cmds = ((s.preview && s.preview.install) || []).map(function (c) { return c.display; }).join(String.fromCharCode(10));
  var legacy = (s.legacy || []).length ? '<div class="note warn"><b>' + s.legacy.length + ' older Loom hook entr' + (s.legacy.length === 1 ? 'y' : 'ies') + ' found in your Claude settings.</b> They do nothing once the plugin is installed and are safe to remove by hand. Loom never edits that file.</div>' : '';
  var res = WZ.pluginRes ? '<div class="note ' + (WZ.pluginRes.ok ? 'ok' : 'err') + '">' + (WZ.pluginRes.ok ? 'Installed. Running chats pick it up at their next start, or after /reload-plugins.' : wzEsc(WZ.pluginRes.detail || 'The install failed.')) + '</div>' : '';
  var installed = s.status === 'installed' || s.status === 'update_available';
  el.innerHTML = '<div class="exp' + (WZ.S.cmdOpen ? ' open' : '') + '" id="wz-plexp"><button data-wz-toggle="wz-plexp" data-wz-setf="cmdOpen">&#9656; Preview the exact commands Install runs</button><div><pre>' + wzEsc(cmds) + '</pre><div class="def" style="margin-top:6px">' + wzEsc((s.preview && s.preview.note) || '') + '</div></div></div>'
    + legacy + res
    + '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap"><button class="btn pri" data-wz-pluginstall="1"' + (installed || WZ.pluginBusy || s.sourceMissing ? ' disabled' : '') + '>' + (WZ.pluginBusy ? 'Installing...' : installed ? 'Installed' : 'Install Loom plugin') + '</button><span class="pill ' + pill[0] + '">' + wzEsc(pill[1]) + '</span><span class="def">Remove it any time from Settings &rsaquo; Helpers.</span></div>'
    + (s.sourceMissing ? '<div class="note err">This build of Loom has no plugin files to install.</div>' : '');
}
WZ_STEPS.plugin = function (c) {
  c.innerHTML = '<div class="stack"><div class="g2">'
    + '<div class="lrow" style="display:block"><b>Hooks</b><span class="def" style="display:block">Small scripts Claude Code runs at fixed moments.</span><ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--wz-text2)"><li><b>Thread ownership</b> remembers which chat owns which Slack thread</li><li><b>Outbox recording</b> makes Slack drafts show up in Loom&#39;s Outbox</li><li><b>Ship labels</b> records what each chat contributes to a ship</li><li><b>Pane state</b> records which tmux pane each chat lives in</li></ul></div>'
    + '<div class="lrow" style="display:block"><b>Skills</b><span class="def" style="display:block">Instructions Claude loads when relevant.</span><ul style="margin:6px 0 0;padding-left:18px;font-size:12.5px;color:var(--wz-text2)"><li><b>ship</b> lands staged work as a PR</li><li><b>slack-drafting</b> writes replies into the Outbox</li><li><b>handling-slack-threads</b> decides ticket versus context</li><li><b>tmux-route</b> sends messages between named panes</li><li><b>review</b> reads a PR without changing it</li></ul></div></div>'
    + '<div id="wz-plugin" class="stack"></div></div>';
  wzPluginDraw();
  wzPluginLoad();
};

/* -- slack -- */
function wzSlackLoad() {
  WZ.slackBusy = true;
  wzGet('/api/slack/status?probe=1').then(function (s) { WZ.slack = s; WZ.slackBusy = false; if (wzCur() === 'slack') wzSlackDraw(); }).catch(function () { WZ.slackBusy = false; });
  wzGet('/api/slack/manifest?readonly=' + (WZ.S.readonly ? '1' : '0')).then(function (m) { WZ.manifest = m; if (wzCur() === 'slack') wzSlackDraw(); });
}
var WZ_SCOPES = [
  ['channels:history groups:history im:history mpim:history', 'Read messages and thread replies in public, private, DM and group DM conversations', 'Watchers, parked-thread replies, thread previews'],
  ['channels:read groups:read im:read mpim:read', 'List conversations so channel ids show as #names', 'Channel labels, watcher channel picker'],
  ['users:read', 'Show names instead of user ids and identify you', 'Everything Slack'],
  ['chat:write', 'Post the draft you approve in the Outbox', 'Send, Send and park, Send and close'],
  ['im:write mpim:write', 'Open a DM before sending to a person', 'Outbox DMs'],
  ['files:read files:write', 'Read attachments in a thread, upload attachments from a draft', 'Outbox attachments'],
  ['search:read', 'Let your chats search Slack', 'Chats, not Loom itself'],
  ['reactions:write', 'Let your chats add or remove reactions', 'Chats, not Loom itself'],
  ['emoji:read', 'Load your workspace custom emoji so they render', 'Emoji in transcripts and previews']
];
function wzSlackDraw() {
  var el = wzEl('wz-slack');
  if (!el) return;
  var S = WZ.S, s = WZ.slack, ch = S.slackChoice;
  var cards = '<div class="cards" id="wz-slcards">'
    + '<button class="opt' + (ch === 'direct' ? ' sel' : '') + '" data-wz-slack="direct"><span class="pill ok rec">Full features</span><b>Direct app</b><span class="d">You create a small Slack app that only your account uses. Loom reads and posts with your own token.</span></button>'
    + '<button class="opt' + (ch === 'mcp' ? ' sel' : '') + '" data-wz-slack="mcp"><span class="pill warn rec">Reduced</span><b>MCP only</b><span class="d">Use the Claude Slack connector you already have. No Slack app to create, fewer features.</span></button>'
    + '<button class="opt' + (ch === 'skip' ? ' sel' : '') + '" data-wz-slack="skip"><b>Skip</b><span class="d">Leave Slack off. Chats and ship still work. Connect later in Settings &rsaquo; Slack.</span></button></div>';
  var sub = '';
  if (ch === 'direct') {
    var tabs = ['1 Create the app', '2 Install', '3 Paste token'];
    var connected = s && s.connected && s.mode === 'direct';
    var cid = s && s.clientId, envTk = s && s.tokenSource === 'env';
    // Connect Slack (the team's shared app, OAuth with PKCE) leads when a client id is set.
    if (cid && !envTk) {
      var oa = WZ.oauth;
      sub += '<div class="stack"><div class="lrow"><span class="st ' + (connected ? 'y' : 'w') + '">' + (connected ? '&#10003;' : '!') + '</span><div class="t"><b>Connect with your team&#39;s Slack app</b><span>Slack opens in your browser. Approve there and Loom stores your own token in the Keychain. Posts are sent as you.</span></div>'
        + (oa ? '<button class="btn sm" data-wz-oauthcancel="1">Cancel</button>' : '<button class="btn pri" data-wz-oauth="1">' + (connected ? 'Connect again' : s.reconnect ? 'Reconnect Slack' : 'Connect Slack') + '</button>') + '</div>'
        + (oa ? '<div class="def"><span class="spin"></span>Waiting for you to approve in Slack. <a href="' + wzEsc(oa.url) + '" target="_blank" rel="noopener">Open the Slack page</a> if it did not open.</div>' : '')
        + (WZ.oauthMsg ? '<div class="note ' + (WZ.oauthMsg.ok ? 'ok' : 'err') + '">' + wzEsc(WZ.oauthMsg.text) + '</div>' : '')
        + (connected && !WZ.oauthMsg ? '<div class="note ok"><span class="st y">&#10003;</span> Connected' + (s.identity ? ' as ' + wzEsc(s.identity.user || '') + ' in ' + wzEsc(s.identity.team || '') : '') + '.</div>' : '')
        + (WZ.ownApp ? '' : '<div><button class="btn sm" data-wz-ownapp="1">Use your own app instead</button></div>') + '</div>';
    } else if (!envTk) {
      sub += '<div class="fld" style="margin-bottom:8px"><label for="wz-cid">Team shared app client id (optional)</label><div style="display:flex;gap:8px;flex-wrap:wrap"><input type="text" id="wz-cid" autocomplete="off" spellcheck="false" placeholder="1234567890.1234567890" style="flex:1;min-width:200px"><button class="btn sm" data-wz-cidsave="1">Save</button></div><div class="def">If your team set up one shared Loom app in Slack, paste its client id to connect without creating your own app.</div>' + (WZ.cidErr ? '<div class="note err">' + wzEsc(WZ.cidErr) + '</div>' : '') + '</div>';
    }
    if (!cid || envTk || WZ.ownApp) {
    sub += '<div class="subs">' + tabs.map(function (t, i) { return '<button class="btn sm' + (WZ.slackSub === i ? ' pri' : '') + '" data-wz-sub="' + i + '">' + t + '</button>'; }).join('') + '</div>';
    if (WZ.slackSub === 0) {
      sub += '<div class="stack"><div class="def">Open <b>api.slack.com/apps</b> &rsaquo; Create New App &rsaquo; From a manifest, pick your workspace, and paste this. It requests user-token scopes only: Loom acts as you and never adds a bot to the workspace.</div>'
        + '<label class="chk"><input type="checkbox" data-wz-readonly="1"' + (S.readonly ? ' checked' : '') + '><span>Read-only: leave out the scopes that post, upload and react. Loom then only reads.</span></label>'
        + '<div style="position:relative"><pre id="wz-manifest">' + wzEsc(WZ.manifest && WZ.manifest.text ? WZ.manifest.text : 'Loading...') + '</pre><button class="btn sm" data-wz-copy="1" style="position:absolute;right:8px;top:8px">Copy manifest</button></div>'
        + '<div class="tblw"><table><tr><th>Scope</th><th>Why Loom asks for it</th><th>Needed for</th></tr>' + WZ_SCOPES.map(function (r) { return '<tr><td>' + r[0].split(' ').map(function (x) { return '<code>' + x + '</code>'; }).join(' ') + '</td><td>' + wzEsc(r[1]) + '</td><td>' + wzEsc(r[2]) + '</td></tr>'; }).join('') + '</table></div>'
        + '<div class="note warn">Read-only Loom (watchers, parked polling, labels) needs only the history and read scopes plus <code>users:read</code>.</div></div>';
    } else if (WZ.slackSub === 1) {
      sub += '<div class="stack"><div class="def">In the app&#39;s settings page choose <b>Install to Workspace</b> and approve. Slack shows the same scope list you just read. Then copy the <b>User OAuth Token</b>, which starts with <code>xoxp-</code>.</div>'
        + '<div class="lrow"><span class="st w">!</span><div class="t"><b>Some workspaces need an admin to approve apps</b><span>If you see &quot;Request to install&quot;, ask your Slack admin, or use MCP only.</span></div><a class="btn sm" href="https://api.slack.com/apps" target="_blank" rel="noopener" style="display:inline-flex;align-items:center;text-decoration:none">Open api.slack.com/apps</a></div></div>';
    } else {
      var envTok = s && s.tokenSource === 'env';
      sub += '<div class="stack">'
        + (envTok ? '<div class="note">The token comes from the <code>SLACK_USER_TOKEN</code> environment variable. Test it below.</div>' : '<div class="fld"><label for="wz-tok">User OAuth Token</label><div style="display:flex;gap:8px;flex-wrap:wrap"><input type="password" id="wz-tok" autocomplete="off" spellcheck="false" placeholder="xoxp-..." style="flex:1;min-width:200px"><button class="btn pri" data-wz-slacktest="1"' + (WZ.slackBusy ? ' disabled' : '') + '>Test</button></div></div>')
        + (envTok ? '<div><button class="btn pri" data-wz-slacktest="1">Test</button></div>' : '')
        + '<div class="def">&#128274; Stored in your macOS Keychain, item &quot;Loom Slack token&quot;. It is never written to Loom&#39;s data folder or sent anywhere except slack.com.</div>'
        + '<div id="wz-slackres">' + wzSlackRes() + '</div>'
        + (connected && !WZ.slackMsg ? '<div class="note ok"><span class="st y">&#10003;</span> Connected' + (s.identity ? ' as ' + wzEsc(s.identity.user || '') + ' in ' + wzEsc(s.identity.team || '') : '') + '.' + (s.scopes ? ' ' + wzEsc(s.scopes.text || '') : '') + '</div>' : '')
        + '</div>';
    }
    }
    if (!connected) sub += '<div class="def" style="margin-top:8px">Not connected yet. If you continue now, Slack stays off until ' + (cid ? 'you connect.' : 'the token Test passes.') + '</div>';
  } else if (ch === 'mcp') {
    var m = s && s.mcp;
    sub += '<div class="stack">'
      + (WZ.slackBusy || !s ? '<div class="def"><span class="spin"></span>Looking for the Claude Slack connector...</div>'
        : m && m.found ? '<div class="lrow"><span class="st y">&#10003;</span><div class="t"><b>Claude Slack connector detected</b><span>Found &quot;' + wzEsc(m.name || 'Slack') + '&quot; in your Claude Code MCP servers.</span></div><span class="pill ok">' + (m.connected ? 'Connected' : 'Found') + '</span></div>'
        : '<div class="lrow"><span class="st n">&#10007;</span><div class="t"><b>No Slack connector found</b><span>Nothing Slack-like in <code>claude mcp list</code>. Add the Slack connector in Claude Code, then check again, or choose another option.</span></div><button class="btn sm" data-wz-slackrecheck="1">Check again</button></div>')
      + '<div class="note warn"><b>These Loom features stay off with MCP only</b>, because Loom itself has no token to call Slack with:<ul style="margin:5px 0 0;padding-left:18px"><li>Slack watchers (no way to poll channels)</li><li>Parked-thread reply detection and the &quot;reply received&quot; notification</li><li>Send, Send and park and Send and close from Loom&#39;s Outbox. Chats can still post through the connector themselves.</li><li>Channel #names, people names and custom emoji in the sidebar and previews</li><li>Thread previews and unread counts</li></ul><div style="margin-top:6px">Still works: chats that read or post to Slack through the connector, and the shortcut that starts or jumps to a chat for a thread.</div></div></div>';
  } else {
    sub += '<div class="note">Slack stays off. The Outbox, watchers, the shortcut step and parked threads are hidden until you connect Slack in Settings.</div>';
  }
  el.innerHTML = cards + sub;
}
function wzSlackRes() {
  var m = WZ.slackMsg;
  if (!m) return '';
  if (m.busy) return '<div class="def"><span class="spin"></span>Testing...</div>';
  if (!m.ok) return '<div class="note err"><span class="st n">&#10007;</span> ' + wzEsc(m.hint || m.error || 'The test failed.') + '</div>';
  var sc = m.scopes || {};
  return '<div class="note ok"><span class="st y">&#10003;</span> Connected as ' + wzEsc((m.identity && m.identity.user) || '') + ' in ' + wzEsc((m.identity && m.identity.team) || '') + '. ' + wzEsc(sc.text || '') + (m.token ? ' Token ' + wzEsc(m.token) + '.' : '') + '</div>'
    + (sc.missing && sc.missing.length ? '<div class="note warn" style="margin-top:8px">Some features need scopes this token lacks (' + wzEsc(sc.missing.join(', ')) + '). Add them to the app and reinstall, or carry on without those features.</div>' : '');
}
function wzSlackTest() {
  var inp = wzEl('wz-tok'), tok = inp ? inp.value.trim() : '';
  var env = WZ.slack && WZ.slack.tokenSource === 'env';
  if (!env && !tok) { WZ.slackMsg = { ok: false, hint: 'Paste the User OAuth Token first.' }; wzSlackDraw(); return; }
  WZ.slackMsg = { busy: true }; wzSlackDraw();
  var p = env ? wzJson('POST', '/api/slack/test', { readonly: WZ.S.readonly }) : wzJson('POST', '/api/slack/token', { token: tok, readonly: WZ.S.readonly });
  p.then(function (r) {
    if (inp) inp.value = '';
    WZ.slackMsg = r;
    wzGet('/api/slack/status').then(function (s) { WZ.slack = Object.assign({}, WZ.slack || {}, s); wzSlackDraw(); });
  }).catch(function () { WZ.slackMsg = { ok: false, hint: 'Loom did not answer.' }; wzSlackDraw(); });
}
// Connect Slack from the wizard: same routes as Settings, polled until the callback reports.
function wzOAuthStop() { if (WZ.oauth && WZ.oauth.t) clearInterval(WZ.oauth.t); WZ.oauth = null; }
function wzOAuthStart() {
  wzOAuthStop(); WZ.oauthMsg = null;
  var w = window.loomNative ? null : window.open('about:blank', '_blank');
  wzJson('POST', '/api/slack/oauth/start', { readonly: WZ.S.readonly }).then(function (j) {
    if (!j.ok) { if (w) w.close(); WZ.oauthMsg = { ok: false, text: j.hint || j.error || 'Could not start Connect Slack.' }; wzSlackDraw(); return; }
    if (w) { try { w.location.href = j.url; } catch (e) { window.open(j.url, '_blank', 'noopener'); } } else window.open(j.url, '_blank', 'noopener');
    var o = { state: j.state, url: j.url, at: Date.now() }; WZ.oauth = o; wzSlackDraw();
    o.t = setInterval(function () {
      if (WZ.oauth !== o) return;
      if (Date.now() - o.at > 600000) { wzOAuthStop(); WZ.oauthMsg = { ok: false, text: 'Connect Slack timed out. Start it again.' }; wzSlackDraw(); return; }
      wzGet('/api/slack/status?oauth=' + encodeURIComponent(o.state)).then(function (st) {
        if (WZ.oauth !== o) return; var r = st && st.oauth; if (!r || r.state === 'pending') return;
        wzOAuthStop(); WZ.slack = Object.assign({}, WZ.slack || {}, st);
        WZ.oauthMsg = r.state === 'ok' ? null : { ok: false, text: r.hint || r.error || 'Slack sign-in did not finish.' };
        if (wzCur() === 'slack') wzSlackDraw();
      });
    }, 2000);
  }).catch(function () { if (w) w.close(); WZ.oauthMsg = { ok: false, text: 'Loom did not answer.' }; wzSlackDraw(); });
}
WZ_STEPS.slack = function (c) {
  c.innerHTML = '<div class="stack" id="wz-slack"></div>';
  wzSlackDraw();
  wzSlackLoad();
};

/* -- shortcut -- */
// What one Accessibility row shows, from the helper's live answer. Pure, so it is tested.
// a: {trusted, helperDown} or null (not answered yet); native: inside the Loom app; asked: Grant was pressed.
function wzAxView(a, native, asked) {
  if (!native) return { st: 'w', mark: '!', pill: 'off', label: 'Not checked', btn: '', text: 'Open this page in the Loom app to check Accessibility.' };
  if (!a) return { st: 'o', mark: '&hellip;', pill: 'off', label: 'Checking', btn: '', text: 'Checking...' };
  if (a.trusted) return { st: 'y', mark: '&#10003;', pill: 'ok', label: 'Granted', btn: '', text: 'Granted. "Loom" is switched on in Privacy &amp; Security &rsaquo; Accessibility.' };
  if (a.helperDown) return { st: 'n', mark: '&#10007;', pill: 'warn', label: 'Helper not running', btn: '', text: 'The part of Loom that holds this permission is not running. Quit and reopen Loom, then check again.' };
  return asked
    ? { st: 'w', mark: '!', pill: 'warn', label: 'Not granted', btn: 'open', text: 'Switch on "Loom" in System Settings &rsaquo; Privacy &amp; Security &rsaquo; Accessibility. This updates on its own.' }
    : { st: 'w', mark: '!', pill: 'warn', label: 'Not granted', btn: 'grant', text: 'Not granted. Grant access shows the macOS prompt and adds "Loom" to the Accessibility list, switched off.' };
}
function wzAxDraw() {
  var pill = wzEl('wz-axpill'), st = wzEl('wz-axst'), tx = wzEl('wz-axtx'), btn = wzEl('wz-axbtn');
  if (!pill) return;
  var v = wzAxView(WZ.ax, WZ.axNative, WZ.axAsked);
  st.className = 'st ' + v.st; st.innerHTML = v.mark;
  pill.className = 'pill ' + v.pill; pill.textContent = v.label;
  tx.innerHTML = v.text;
  btn.style.display = v.btn ? '' : 'none';
  btn.textContent = v.btn === 'grant' ? 'Grant access' : 'Open System Settings';
  btn.className = 'btn sm' + (v.btn === 'grant' ? ' pri' : '');
}
function wzAxRow() {
  return '<div class="lrow"><span class="st o" id="wz-axst">&hellip;</span><div class="t"><b>Accessibility access</b><span id="wz-axtx">Checking...</span></div><span class="pill off" id="wz-axpill">...</span><button class="btn sm" id="wz-axbtn" data-wz-grantax="1" style="display:none">Grant access</button></div>';
}
function wzAxPoll() {
  if (!(window.loomNative && window.loomNative.axStatus)) { WZ.axNative = false; wzAxDraw(); return; }
  WZ.axNative = true;
  var go = function () { window.loomNative.axStatus().then(function (a) { WZ.ax = a; wzAxDraw(); }).catch(function () {}); };
  go();
  WZ.axT = setInterval(function () { if (!document.hidden) go(); }, 1000);
}
function wzPracDraw() {
  var box = wzEl('wz-prac');
  if (!box) return;
  var p = WZ.prac, key = wzFmtKey(WZ.S.hotkey);
  var btns = '<div style="margin-top:8px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">';
  if (!p || p.state === 'idle' || p.state === 'timeout') {
    box.className = 'prac';
    box.innerHTML = '<div><b>Practice</b><br>' + (p && p.state === 'timeout' ? 'That timed out after a minute. ' : '') + 'Open Slack, hover any message, press <span class="kbd">' + wzEsc(key) + '</span>. Loom will tell you what it saw and what it would have done. Nothing happens in your chats.</div>' + btns + '<button class="btn sm pri" data-wz-pracarm="1">Start practice</button><button class="btn sm" data-wz-pracsim="1">Simulate pressing the shortcut</button></div>';
  } else if (p.state === 'armed') {
    box.className = 'prac';
    box.innerHTML = '<div><span class="pulse"></span><b>Waiting for the shortcut...</b><br>Open Slack, hover any message, press <span class="kbd">' + wzEsc(key) + '</span>.</div>' + btns + '<button class="btn sm" data-wz-pracsim="1">Simulate pressing the shortcut</button><button class="btn sm ghost" data-wz-praccancel="1">Cancel</button></div>';
  } else {
    var r = p.result || {};
    if (r.ok) {
      box.className = 'prac good';
      box.innerHTML = '<div><span class="st y">&#10003;</span> <b>It worked.</b><br><span class="def">Loom saw a message' + (r.author ? ' from ' + wzEsc(r.author) : '') + (r.channel ? ' in ' + wzEsc(r.channel) : '') + ' and would ' + (r.wouldDo === 'jump' ? 'jump to the chat that owns the thread' : 'start a chat' + (r.project ? ' in ' + wzEsc(r.project) : '')) + '.</span></div>' + btns + '<button class="btn sm" data-wz-pracarm="1">Practice again</button></div>';
    } else {
      box.className = 'prac bad';
      box.innerHTML = '<div><span class="st n">&#10007;</span> <b>Loom could not read a message.</b><br><span class="def">' + wzEsc(r.detail || 'The shortcut fired but nothing was under the pointer.') + ' Check Accessibility above, hover a message in the Slack desktop app, and try again.</span></div>' + btns + '<button class="btn sm" data-wz-pracarm="1">Try again</button></div>';
    }
  }
}
function wzPracPoll() {
  wzGet('/api/shortcut/practice').then(function (r) { if (r && r.ok) { WZ.prac = r.practice; if (wzCur() === 'shortcut') wzPracDraw(); } });
}
function wzPracAct(action) {
  wzJson('POST', '/api/shortcut/practice', { action: action }).then(function (r) {
    if (r && r.ok) { WZ.prac = r.practice; wzPracDraw(); }
    if (action === 'arm' && !WZ.pracT) WZ.pracT = setInterval(function () { if (WZ.prac && WZ.prac.state === 'armed') wzPracPoll(); }, 1000);
  });
}
function wzHkDraw() {
  var box = wzEl('wz-hk');
  if (!box) return;
  var S = WZ.S, r = WZ.recRes;
  box.innerHTML = WZ.rec ? 'Press keys...' : wzEsc(S.hotkey === 'off' ? 'Off' : wzFmtKey(S.hotkey));
  box.className = 'rec-box' + (WZ.rec ? ' live' : '');
  var w = wzEl('wz-hkwarn');
  if (!w) return;
  if (!r) { w.innerHTML = ''; return; }
  if (r.level === 'refuse') w.innerHTML = '<div class="note err">' + wzEsc(r.detail) + ' Pick another.</div>';
  else if (r.level === 'warn') w.innerHTML = '<div class="note warn">' + wzEsc(wzFmtKey(r.accelerator)) + ' is already used by Slack while Slack is focused. Loom&#39;s shortcut is global and would override it. <button class="btn sm" data-wz-hkuse="1">Keep it anyway</button></div>';
  else w.innerHTML = '<div class="note ok">' + wzEsc(wzFmtKey(r.accelerator)) + ' is free. <button class="btn sm pri" data-wz-hkuse="1">Use this shortcut</button></div>';
}
function wzStopRecording() {
  WZ.rec = false;
  document.removeEventListener('keydown', wzRecKey, true);
}
function wzRecKey(e) {
  if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); wzStopRecording(); WZ.recRes = null; wzHkDraw(); return; }
  if (e.key === 'Meta' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Shift') return;
  e.preventDefault(); e.stopPropagation();
  var ev = { key: e.key, code: e.code, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey };
  wzStopRecording();
  wzJson('POST', '/api/shortcut/check', { event: ev }).then(function (r) {
    if (!r || !r.ok || !r.recorded) { WZ.recRes = { level: 'refuse', detail: 'No shortcut was recorded.' }; }
    else WZ.recRes = r;
    wzHkDraw();
  });
}
function wzHkUse() {
  var r = WZ.recRes;
  if (!r || !r.accelerator) return;
  wzJson('PUT', '/api/settings', { slack_goto_hotkey: r.accelerator }).then(function (j) {
    if (j && j.ok) { WZ.S.hotkey = r.accelerator; WZ.recRes = null; WZ.err = ''; }
    else { WZ.err = (j && j.detail) || 'Loom could not use that shortcut.'; wzEl('wz-err').innerHTML = '<div class="note err">' + wzEsc(WZ.err) + '</div>'; }
    wzHkDraw(); wzPracDraw();
  });
}
function wzHkReset() {
  wzJson('PUT', '/api/settings', { slack_goto_hotkey: 'Command+Shift+L' }).then(function (j) {
    if (j && j.ok) { WZ.S.hotkey = 'Command+Shift+L'; WZ.recRes = null; }
    wzHkDraw(); wzPracDraw();
  });
}
WZ_STEPS.shortcut = function (c) {
  var mode = WZ.v.slackMode;
  c.innerHTML = '<div class="stack"><div class="flow"><div class="slackmini"><div class="tb"><span>&#128578;</span><span>&#128172;</span><span class="hl">' + wzEsc(wzFmtKey(WZ.S.hotkey)) + ' Loom</span></div><b>A teammate</b> <span class="def">10:42</span><br>Can someone check why the weekly export is short?</div>'
    + '<div class="ar">&rarr;</div><div class="box"><b>Loom decides:</b><br>Thread already has a chat &rarr; <span class="badge sl">jump to it</span><br>No chat yet &rarr; <span class="badge pr">start one in the project mapped to that channel</span></div></div>'
    + '<div class="g2"><div class="lrow" id="wz-slackapp"><span class="st o">&hellip;</span><div class="t"><b>Slack desktop app</b><span>Looking...</span></div></div>'
    + wzAxRow() + '</div>'
    + '<div class="fld"><label>Shortcut</label><div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><span class="rec-box" id="wz-hk"></span><button class="btn sm" data-wz-hkrec="1">Record new shortcut</button><button class="btn sm ghost" data-wz-hkreset="1">Reset to ' + wzEsc(wzFmtKey('Command+Shift+L')) + '</button></div><div id="wz-hkwarn" style="margin-top:8px"></div></div>'
    + '<div class="prac" id="wz-prac"></div>'
    + (mode === 'mcp' ? '<div class="def">With MCP only, the shortcut still reads the message and finds or starts the chat. It cannot post or read replies for you.</div>' : '')
    + '<div class="def">If Loom cannot read the message, the shortcut offers a box to paste the thread link instead.</div></div>';
  wzHkDraw();
  wzAxPoll();
  wzGet('/api/shortcut/slack-app').then(function (r) {
    var el = wzEl('wz-slackapp');
    if (!el || !r) return;
    el.innerHTML = r.found ? '<span class="st y">&#10003;</span><div class="t"><b>Slack desktop app</b><span>Found at ' + wzEsc(r.path) + '.</span></div>' : '<span class="st n">&#10007;</span><div class="t"><b>Slack desktop app</b><span>Not found. The browser version is not supported. <a href="https://slack.com/downloads" target="_blank" rel="noopener" style="color:var(--wz-accent)">Get the desktop app</a>.</span></div>';
  });
  wzPracPoll();
  setTimeout(wzPracDraw, 0);
  WZ.pracT = setInterval(function () { if (WZ.prac && WZ.prac.state === 'armed') wzPracPoll(); }, 1000);
};

/* -- ship -- */
function wzShipLoad() {
  wzGet('/api/wizard/ship').then(function (r) {
    if (!r || !r.ok || wzCur() !== 'ship') return;
    if (!WZ.S.ship) WZ.S.ship = r.options.map(function (o) { return { path: o.path, name: o.name, repo: o.repo, base: o.base, command: o.command, enabled: o.enabled, label: o.label_required }; });
    wzShipDraw();
  });
}
function wzShipDraw() {
  var el = wzEl('wz-shiptbl'), rows = WZ.S.ship;
  if (!el) return;
  if (!rows) { el.innerHTML = '<div class="def"><span class="spin"></span>Reading your projects...</div>'; return; }
  if (!rows.length) { el.innerHTML = '<div class="note">None of your projects has a GitHub remote, so there is nothing to ship from yet. Add a project in the Projects step, or add repos later in Settings &rsaquo; Ship.</div>'; return; }
  el.innerHTML = '<div class="tblw"><table><tr><th>Project</th><th>Repo</th><th>Base branch</th><th>Ship command</th><th>Label staged work</th><th>Ship</th></tr>'
    + rows.map(function (r, i) {
      return '<tr><td>' + wzEsc(r.name) + '</td><td><code>' + wzEsc(r.repo) + '</code></td><td><input type="text" style="width:90px" data-wz-ship="' + i + '" data-k="base" value="' + wzEsc(r.base) + '" aria-label="Base branch"></td><td><input type="text" style="width:130px" data-wz-ship="' + i + '" data-k="command" value="' + wzEsc(r.command) + '" aria-label="Ship command"></td>'
        + '<td><label class="tg"><input type="checkbox" data-wz-shipt="' + i + '" data-k="label"' + (r.label ? ' checked' : '') + ' aria-label="Label staged work"><i></i></label></td>'
        + '<td><label class="tg"><input type="checkbox" data-wz-shipt="' + i + '" data-k="enabled"' + (r.enabled ? ' checked' : '') + ' aria-label="Ship from this repo"><i></i></label></td></tr>';
    }).join('') + '</table></div>';
}
WZ_STEPS.ship = function (c) {
  c.innerHTML = '<div class="stack"><div id="wz-shiptbl"></div>'
    + '<div class="def"><b>Label staged work</b>: when on, a chat must say what its staged changes are for before it finishes, so the ship dialog can show who contributed what instead of just file names. Loom never force-pushes and the Ship button has no force option.</div>'
    + '<div class="def">Repos come from your Projects step. A project with no GitHub remote is not listed.</div></div>';
  wzShipDraw();
  wzShipLoad();
};

/* -- orchestrator -- */
function wzOrchDraw() {
  var S = WZ.S, el = wzEl('wz-orch');
  if (!el) return;
  el.innerHTML = '<div class="lrow"><div class="t"><b>Run the orchestrator</b><span>A dedicated chat that watches your other chats and can start, message and summarise them for you.</span></div><label class="tg"><input type="checkbox" data-wz-orch="1"' + (S.orchOn ? ' checked' : '') + ' aria-label="Run the orchestrator"><i></i></label></div>'
    + '<div class="note"><b>Remote Control</b> lets you drive a running chat from the Claude mobile app or claude.ai. It needs a supported Claude account and is off by default. You can turn it on for the orchestrator in Settings &rsaquo; Agents and permissions. If you do, anything that can reach your Claude account can send it instructions.</div>'
    + (S.orchOn ? '<div class="fld"><label>When the orchestrator wants your attention</label><select data-wz-f="orchNotify"><option value="needs_you"' + (S.orchNotify === 'needs_you' ? ' selected' : '') + '>Notify me only when it asks a question</option><option value="all"' + (S.orchNotify === 'all' ? ' selected' : '') + '>Notify me on every report</option><option value="off"' + (S.orchNotify === 'off' ? ' selected' : '') + '>Never notify, I will check the Orchestrator tab</option></select></div>'
      + '<label class="chk"><input type="checkbox" data-wz-orchtrust="1"' + (S.orchTrust ? ' checked' : '') + '><span>Trust the orchestrator folder so it can run unattended. This adds <code>' + wzEsc(S.orchDir) + '</code> as a trusted folder in <code>~/.claude.json</code>, when the orchestrator starts. Leave it unticked and Claude asks the first time instead.</span></label>' : '')
    + '<div class="def">Off, nothing is changed and no orchestrator chat is started.</div>';
}
WZ_STEPS.orchestrator = function (c) {
  c.innerHTML = '<div class="stack" id="wz-orch"></div>';
  wzOrchDraw();
};

/* -- watchers -- */
function wzTplLoad() {
  wzGet('/api/wizard/templates').then(function (r) { if (r && r.ok) { WZ.tpl = r.templates; if (wzCur() === 'watchers') wzTplDraw(); } });
}
function wzTplDraw() {
  var el = wzEl('wz-tpl');
  if (!el) return;
  var T = WZ.tpl;
  if (!T) { el.innerHTML = '<div class="def"><span class="spin"></span>Loading templates...</div>'; return; }
  var groups = [['slack', 'Slack channel', 'needs the Direct Slack app'], ['chats', 'Chats', 'your live sessions, starts in Shadow'], ['prs', 'Pull requests', 'needs gh, logged in']];
  var n = 0;
  var html = groups.map(function (g) {
    var items = T.filter(function (t) { return t.group === g[0]; });
    if (!items.length) return '';
    return '<div class="grp">' + g[1] + '<span>' + g[2] + '</span></div><div class="cards">' + items.map(function (t) {
      var on = !!WZ.S.templates[t.id] && t.available;
      if (on) n++;
      return '<button class="opt' + (on ? ' sel' : '') + (t.available ? '' : ' dis') + '" data-wz-tpl="' + wzEsc(t.id) + '"' + (t.available ? '' : ' aria-disabled="true"') + '><b>' + wzEsc(t.label) + '</b><span class="d">' + wzEsc(t.description) + '</span>' + (t.available ? '' : '<span class="pill off rec">' + wzEsc(t.blocked) + '</span>') + '</button>';
    }).join('') + '</div>';
  }).join('');
  el.innerHTML = html + '<div class="def" style="margin-top:8px">' + (n ? n + ' template' + (n === 1 ? '' : 's') + ' chosen. They are created switched off or in Shadow, so nothing acts until you have tested it in Settings &rsaquo; Watchers.' : 'No templates chosen. Watchers will be off. The same templates are in Settings &rsaquo; Watchers.') + '</div>';
}
WZ_STEPS.watchers = function (c) {
  c.innerHTML = '<div class="stack"><div class="def">A watcher is <b>Source &rarr; Trigger &rarr; Action</b>. The source can be a Slack channel, your live chats or pull requests. Pick starter templates (several allowed) or skip. Templates are created switched off or in Shadow, so nothing runs until you have tested it.</div><div id="wz-tpl"></div></div>';
  wzTplDraw();
  wzTplLoad();
};

/* -- done -- */
WZ_STEPS.done = function (c) {
  c.innerHTML = '<div class="stack"><div class="sumgrid" id="wz-sum"><div class="def"><span class="spin"></span>Summing up...</div></div>'
    + '<div class="def">Everything above can be changed in Settings (the gear, top right). The tour takes about a minute and covers the sidebar, chats, the Outbox, Ship and the Slack shortcut. Choose Not now to skip it; it stays in Settings &rsaquo; Help.</div></div>';
  var go = function (ax) {
    wzGet('/api/wizard/summary?ax=' + (ax ? '1' : '0')).then(function (r) {
      var el = wzEl('wz-sum');
      if (!el || !r || !r.ok) return;
      el.innerHTML = r.rows.map(function (x) { return '<div class="lrow"><span class="st ' + (x.on ? 'y' : 'o') + '">' + (x.on ? '&#10003;' : '&ndash;') + '</span><div class="t"><b>' + wzEsc(x.label) + '</b><span>' + wzEsc(x.detail) + '</span></div></div>'; }).join('');
    });
  };
  if (window.loomNative && window.loomNative.axStatus) window.loomNative.axStatus().then(function (a) { go(a && a.trusted); }).catch(function () { go(false); });
  else go(false);
};

/* ---------- one delegated handler ---------- */
function wzClick(e) {
  var t = e.target.closest ? e.target.closest('button, a, [data-wz-confirm], [data-wz-readonly], [data-wz-psug], [data-wz-orch], [data-wz-orchtrust], [data-wz-shipt]') : null;
  if (!t) return;
  var d = t.dataset || {}, S = WZ.S;
  if (t.id === 'wz-x') return wzClose();
  if (t.id === 'wz-back') return wzBack();
  if (t.id === 'wz-skip') return wzSkip();
  if (t.id === 'wz-next') return wzContinue();
  if (d.wzGo) return wzGo(d.wzGo);
  if (d.wzToggle) { var ex = wzEl(d.wzToggle); ex.classList.toggle('open'); if (d.wzSetf) S[d.wzSetf] = ex.classList.contains('open'); if (d.wzToggle === 'wz-binexp') S.showBin = ex.classList.contains('open'); return; }
  if (d.wzInstall) { WZ.job = { tool: d.wzInstall, status: 'running', log: '', code: null }; wzReqDraw(); return wzJson('POST', '/api/wizard/install', { tool: d.wzInstall }).then(function (r) { if (!r.ok) { WZ.job = { tool: d.wzInstall, status: 'failed', log: r.detail || 'Could not start the install.', code: null }; wzReqDraw(); return; } WZ.job = r.job; wzReqDraw(); wzJobPoll(r.job.id); }); }
  if (d.wzLogin) { return wzJson('POST', '/api/wizard/login', {}).then(function (r) { WZ.login = r; wzReqDraw(); }); }
  if (d.wzOpenterm) {
    var l = WZ.login;
    if (l && l.session) { wzClose(); if (typeof loadTerminals === 'function') loadTerminals(); setTimeout(function () { if (typeof selectTerminal === 'function') selectTerminal(l.session, l.window); }, 600); }
    return;
  }
  if (d.wzRecheck) { WZ.reqBusy = false; return wzJson('PUT', '/api/settings', { claude_bin: (WZ.S.claude_bin || '').trim() }).then(function (j) { if (j && j.ok === false) { WZ.err = j.detail || 'That path was not accepted.'; wzEl('wz-err').innerHTML = '<div class="note err">' + wzEsc(WZ.err) + '</div>'; } else { WZ.err = ''; wzEl('wz-err').innerHTML = ''; } wzReqLoad(true); }); }
  if (d.wzPickfolder) { return window.loomNative.pickFolder().then(function (p) { if (p) wzAddProject(p); }); }
  if (d.wzAddpath) { var pi = wzEl('wz-ppath'); wzAddProject(pi.value); pi.value = ''; return; }
  if (d.wzPrm !== undefined) { var row = S.projects[+d.wzPrm]; S.projects.splice(+d.wzPrm, 1); if (row && row.existing) S.remove.push(row.path); return wzProjDraw(); }
  if (d.wzPsug !== undefined) { if (t.checked) { var s = WZ.sugList[+d.wzPsug]; if (s) wzAddProject(s.path); } return; }
  if (d.wzTerm) { S.terminal = d.wzTerm; return wzRender(); }
  if (d.wzPerm) { S.perm = d.wzPerm; if (d.wzPerm === 'normal' && S.permW !== 'skip' && S.permO !== 'skip') S.confirm = false; wzRender(); return; }
  if (d.wzConfirm) { S.confirm = t.checked; return wzFooter(); }
  if (d.wzPluginstall) {
    WZ.pluginBusy = true; WZ.pluginRes = null; wzPluginDraw();
    return wzJson('POST', '/api/plugin/install', {}).then(function (r) { WZ.pluginBusy = false; WZ.pluginRes = r; WZ.plugin = r.status || WZ.plugin; wzPluginLoad(); wzPluginDraw(); });
  }
  if (d.wzSlack) { S.slackChoice = d.wzSlack; WZ.slackMsg = null; return wzSlackDraw(); }
  if (d.wzSub !== undefined) { WZ.slackSub = +d.wzSub; return wzSlackDraw(); }
  if (d.wzReadonly) { S.readonly = t.checked; return wzGet('/api/slack/manifest?readonly=' + (S.readonly ? '1' : '0')).then(function (m) { WZ.manifest = m; wzSlackDraw(); }); }
  if (d.wzCopy) { try { navigator.clipboard.writeText(WZ.manifest.text); t.textContent = 'Copied'; setTimeout(function () { t.textContent = 'Copy manifest'; }, 1400); } catch (x) { t.textContent = 'Select and copy'; } return; }
  if (d.wzSlacktest) return wzSlackTest();
  if (d.wzOauth) return wzOAuthStart();
  if (d.wzOauthcancel) { wzOAuthStop(); return wzSlackDraw(); }
  if (d.wzOwnapp) { WZ.ownApp = true; return wzSlackDraw(); }
  if (d.wzCidsave) { var ci = wzEl('wz-cid'), cv = ci ? ci.value.trim() : ''; return wzJson('PUT', '/api/settings', { slack_client_id: cv }).then(function (j) { if (j && j.ok === false) { WZ.cidErr = j.detail || 'That client id was not accepted.'; return wzSlackDraw(); } WZ.cidErr = ''; wzSlackLoad(); }); }
  if (d.wzSlackrecheck) return wzSlackLoad();
  if (d.wzOpenax) { if (window.loomNative && window.loomNative.openAccessibility) window.loomNative.openAccessibility(); return; }
  if (d.wzGrantax) {
    var N = window.loomNative || {};
    if (!WZ.axAsked && N.axRequest) { WZ.axAsked = true; N.axRequest().then(function (a) { WZ.ax = a; wzAxDraw(); }).catch(function () {}); return wzAxDraw(); }
    if (N.openAccessibility) N.openAccessibility();
    return;
  }
  if (d.wzHkrec) { if (WZ.rec) return; WZ.rec = true; WZ.recRes = null; wzHkDraw(); document.addEventListener('keydown', wzRecKey, true); return; }
  if (d.wzHkreset) return wzHkReset();
  if (d.wzHkuse) return wzHkUse();
  if (d.wzPracarm) return wzPracAct('arm');
  if (d.wzPraccancel) return wzPracAct('cancel');
  if (d.wzPracsim) return wzPracAct('simulate');
  if (d.wzShipt !== undefined) { S.ship[+d.wzShipt][d.k] = t.checked; return; }
  if (d.wzOrch) { S.orchOn = t.checked; return wzOrchDraw(); }
  if (d.wzOrchtrust) { S.orchTrust = t.checked; return; }
  if (d.wzTpl) { var tp = (WZ.tpl || []).filter(function (x) { return x.id === d.wzTpl; })[0]; if (tp && tp.available) { S.templates[d.wzTpl] = !S.templates[d.wzTpl]; wzTplDraw(); } return; }
}
function wzInput(e) {
  var t = e.target, d = t.dataset || {}, S = WZ.S;
  if (!S) return;
  if (d.wzF) { S[d.wzF] = t.value; if (d.wzF === 'permW' || d.wzF === 'permO') { var p = wzEl('wz-skipconf'); if (p) p.style.display = (S.perm === 'skip' || S.permW === 'skip' || S.permO === 'skip') ? 'flex' : 'none'; wzFooter(); } return; }
  if (d.wzPname !== undefined) { S.projects[+d.wzPname].name = t.value; return; }
  if (d.wzShip !== undefined) { S.ship[+d.wzShip][d.k] = t.value; return; }
}
function wzJobPoll(id) {
  if (WZ.jobT) clearInterval(WZ.jobT);
  WZ.jobT = setInterval(function () {
    wzGet('/api/wizard/install?id=' + encodeURIComponent(id)).then(function (r) {
      if (!r || !r.ok) return;
      WZ.job = r.job; wzReqDraw();
      if (r.job.status !== 'running') { clearInterval(WZ.jobT); WZ.jobT = null; WZ.reqBusy = false; wzReqLoad(true); }
    });
  }, 1000);
}
function wzKey(e) {
  if (!WZ.open) return;
  if (e.key === 'Escape' && !WZ.rec) { e.preventDefault(); e.stopPropagation(); wzClose(); return; }
  if (e.key === 'Tab') {
    var f = Array.prototype.slice.call(wzEl('wz').querySelectorAll('button:not([disabled]), input, select, textarea, a[href]')).filter(function (x) { return x.offsetParent !== null; });
    if (!f.length) return;
    var first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}
function wzInit() {
  var w = wzEl('wz');
  if (!w) return;
  w.addEventListener('click', wzClick);
  w.addEventListener('input', wzInput);
  w.addEventListener('change', wzInput);
  document.addEventListener('keydown', wzKey, true);
  // Settings > Help "Run setup again": starts at Welcome, resets only the wizard's own progress.
  window.addEventListener('loom:open-wizard', function () { openWizard({ rerun: true }); });
  wzEl('wzresume-go').addEventListener('click', function () { openWizard(); });
  wzBoot();
}
// The markup is spliced after the page script, so wait until the document is parsed.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wzInit); else setTimeout(wzInit, 0);
`;
