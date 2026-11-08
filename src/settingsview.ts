// The Settings page: thirteen sections in the mock's frame C layout (a left nav and a
// pane that opens each section with what it does, what it needs and a status pill).
// Plain browser CSS/HTML/JS in strings, spliced verbatim by dashboard.ts like orchview.ts.
// String.raw so nothing here needs double escaping; it must never contain a dollar-brace
// or a backtick, and the page JS avoids backslashes and regex literals because
// dashboard.ts splices some of it into a non-raw template.
//
// Rows are driven by the settings registry: GET /api/settings returns every key with its
// label, help, default, options, source (env/stored/default) and restart flag, and a
// change is POST /api/settings {key: value}. The bespoke blocks (Slack connection,
// shortcut recorder, Helpers, Ship rows, Projects) call the routes of waves 1 and 2.
// Watchers is T20's: this page leaves a link to the Watchers tab.

import { KEYMAP } from './keymap.ts';

// What the Help list needs of the keymap; the page resolves `setting` rows itself.
const KEYMAP_JSON = JSON.stringify(KEYMAP.map((k) => ({ keys: k.keys, label: k.label, scope: k.scope, setting: k.setting ?? '' }))).split('<').join('');

export const SETTINGS_VIEW_CSS = String.raw`
  #settings-section { --sx-panel:#141826; --sx-card:#161a24; --sx-line:#232634; --sx-ctl:#1b1f2a; --sx-ctl-line:#2b3040; --sx-text:#e6e6e6; --sx-text2:#c4ccdc; --sx-muted:#8b93a7; --sx-on:#26304a; --sx-sel-line:#34406a; --sx-accent:#6ea2ff; --sx-accent-bg:rgba(110,162,255,.12); --sx-amber:#e8b04a; --sx-amber-bg:rgba(232,176,74,.14); --sx-green:#56d364; --sx-green-bg:rgba(86,211,100,.12); --sx-err-bg:rgba(229,72,77,.13); --sx-code:#0a0c11; --sx-mono:ui-monospace,SFMono-Regular,Menlo,monospace; }
  #settings-section .sxwrap { display:flex; margin-top:14px; border:1px solid var(--sx-line); border-radius:12px; overflow:hidden; background:#0d0f15; min-height:560px; }
  #settings-section .sxnav { width:200px; flex:none; border-right:1px solid var(--sx-line); background:var(--sx-panel); padding:10px 8px; display:flex; flex-direction:column; gap:1px; }
  #settings-section .sxnav button { display:flex; align-items:center; width:100%; text-align:left; background:transparent; border:0; color:var(--sx-muted); padding:7px 10px; border-radius:7px; font-size:13px; gap:8px; cursor:pointer; }
  #settings-section .sxnav button:hover { background:#151925; color:var(--sx-text2); }
  #settings-section .sxnav button.on { background:var(--sx-on); color:#fff; }
  #settings-section .sxnav button i { margin-left:auto; width:7px; height:7px; border-radius:50%; background:#3a4052; flex:none; }
  #settings-section .sxnav button i.ok { background:var(--sx-green); }
  #settings-section .sxnav button i.warn { background:var(--sx-amber); }
  #settings-section .sxpane { flex:1; min-width:0; padding:18px 24px 40px; overflow:auto; max-height:calc(100vh - 150px); }
  #settings-section .sxhead { border:1px solid var(--sx-line); background:var(--sx-card); border-radius:10px; padding:12px 14px; margin-bottom:14px; }
  #settings-section .sxhead .r1 { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  #settings-section .sxhead h2 { margin:0; font-size:18px; flex:1; color:var(--sx-text); font-weight:600; }
  #settings-section .sxhead dl { margin:8px 0 0; display:grid; grid-template-columns:90px 1fr; gap:3px 10px; font-size:12.5px; }
  #settings-section .sxhead dt { color:var(--sx-muted); font-weight:600; }
  #settings-section .sxhead dd { margin:0; color:var(--sx-text2); }
  #settings-section .sxgrp { margin:18px 0 6px; font-size:11.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--sx-muted); }
  #settings-section .sxset { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,340px); gap:14px; align-items:center; padding:10px 0; border-bottom:1px solid var(--sx-line); }
  #settings-section .sxset > div:first-child b { font-size:13px; font-weight:600; color:var(--sx-text); }
  #settings-section .sxset .h { display:block; color:var(--sx-muted); font-size:12px; font-weight:400; margin-top:1px; }
  #settings-section .sxset .ctl { display:flex; gap:8px; align-items:center; justify-content:flex-end; flex-wrap:wrap; }
  #settings-section .sxset .ctl input[type=text], #settings-section .sxset .ctl input[type=password], #settings-section .sxset .ctl select { min-width:0; flex:1; }
  #settings-section .sxset.full { grid-template-columns:1fr; }
  #settings-section .def { font-size:11.5px; color:var(--sx-muted); }
  #settings-section .def b { color:var(--sx-text2); font-weight:600; }
  #settings-section .rst { font-size:11px; color:var(--sx-amber); margin-left:4px; }
  @media (max-width:1100px) { #settings-section .sxset { grid-template-columns:1fr; } #settings-section .sxset .ctl { justify-content:flex-start; } }
  @media (max-width:760px) { #settings-section .sxwrap { flex-direction:column; } #settings-section .sxnav { width:auto; flex-direction:row; overflow-x:auto; border-right:0; border-bottom:1px solid var(--sx-line); } #settings-section .sxnav button { white-space:nowrap; width:auto; } #settings-section .sxpane { max-height:none; padding:14px 14px 32px; } }
  #settings-section .sxbtn { height:32px; border-radius:8px; border:1px solid var(--sx-ctl-line); background:var(--sx-ctl); color:var(--sx-text2); padding:0 12px; font-size:13px; white-space:nowrap; cursor:pointer; }
  #settings-section .sxbtn:hover { background:var(--sx-on); color:#fff; }
  #settings-section .sxbtn.pri { background:var(--sx-accent); border-color:var(--sx-accent); color:#08101f; font-weight:600; }
  #settings-section .sxbtn.pri:hover { filter:brightness(1.1); color:#08101f; }
  #settings-section .sxbtn.sm { height:26px; font-size:12px; padding:0 9px; border-radius:6px; }
  #settings-section .sxbtn.ghost { background:transparent; }
  #settings-section .sxbtn.danger { color:#ff8a8e; border-color:#5a2a2e; }
  #settings-section .sxbtn[disabled] { opacity:.4; cursor:not-allowed; filter:none; }
  #settings-section .pill { display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 9px; border-radius:11px; font-size:11.5px; font-weight:600; white-space:nowrap; }
  #settings-section .pill.ok { background:var(--sx-green-bg); color:var(--sx-green); }
  #settings-section .pill.warn { background:var(--sx-amber-bg); color:var(--sx-amber); }
  #settings-section .pill.err { background:var(--sx-err-bg); color:#ff8a8e; }
  #settings-section .pill.off { background:#1d212c; color:var(--sx-muted); }
  #settings-section .pill.opt { background:var(--sx-accent-bg); color:var(--sx-accent); }
  #settings-section input[type=text], #settings-section input[type=password], #settings-section input[type=number], #settings-section select { background:var(--sx-ctl); color:var(--sx-text); border:1px solid var(--sx-ctl-line); border-radius:8px; padding:0 10px; height:32px; font-size:13px; max-width:100%; font-family:inherit; }
  #settings-section input:focus, #settings-section select:focus { outline:1px solid var(--sx-accent); border-color:var(--sx-accent); }
  #settings-section input:disabled, #settings-section select:disabled { opacity:.5; }
  #settings-section .mono { font-family:var(--sx-mono); }
  #settings-section code, #settings-section .kbd { font-family:var(--sx-mono); font-size:12px; background:var(--sx-code); border:1px solid var(--sx-line); border-radius:5px; padding:0 5px; color:var(--sx-text2); }
  #settings-section .kbd { display:inline-block; padding:1px 7px; background:var(--sx-ctl); border-color:var(--sx-ctl-line); color:var(--sx-text); }
  #settings-section pre.sxpre { margin:10px 0 0; background:var(--sx-code); border:1px solid var(--sx-line); border-radius:8px; padding:10px 12px; font:12px/1.55 var(--sx-mono); color:var(--sx-text2); overflow:auto; max-height:230px; white-space:pre; }
  #settings-section .tg { position:relative; display:inline-block; width:36px; height:20px; flex:none; }
  #settings-section .tg input { position:absolute; opacity:0; inset:0; margin:0; cursor:pointer; z-index:2; width:100%; height:100%; }
  #settings-section .tg i { position:absolute; inset:0; background:#2b3040; border-radius:10px; transition:.15s; }
  #settings-section .tg i:after { content:""; position:absolute; left:2px; top:2px; width:16px; height:16px; border-radius:50%; background:#c4ccdc; transition:.15s; }
  #settings-section .tg input:checked + i { background:var(--sx-accent); }
  #settings-section .tg input:checked + i:after { left:18px; background:#fff; }
  #settings-section .tg input:disabled { cursor:not-allowed; }
  #settings-section .seg { display:inline-flex; height:30px; background:var(--sx-panel); border:1px solid var(--sx-ctl-line); border-radius:8px; padding:2px; gap:2px; flex-wrap:nowrap; }
  #settings-section .seg button { height:24px; background:transparent; border:0; color:var(--sx-muted); border-radius:6px; padding:0 10px; font-size:12px; font-weight:600; white-space:nowrap; cursor:pointer; }
  #settings-section .seg button.on { background:var(--sx-on); color:#fff; }
  #settings-section .seg button[disabled] { cursor:not-allowed; opacity:.5; }
  #settings-section .sxnote { border:1px solid var(--sx-ctl-line); background:var(--sx-panel); border-radius:8px; padding:9px 11px; font-size:12.5px; color:var(--sx-text2); margin:8px 0; }
  #settings-section .sxnote.warn { border-color:#5b4a1a; background:var(--sx-amber-bg); color:#f0cf8a; }
  #settings-section .sxnote.err { border-color:#5a2a2e; background:var(--sx-err-bg); color:#ffb0b3; }
  #settings-section .sxnote.ok { border-color:#1f4a28; background:var(--sx-green-bg); color:#9fe0aa; }
  #settings-section .sxtbl { overflow-x:auto; }
  #settings-section table { border-collapse:collapse; width:100%; font-size:12.5px; }
  #settings-section th { text-align:left; color:var(--sx-muted); font-weight:600; font-size:11.5px; padding:6px 8px; border-bottom:1px solid var(--sx-line); white-space:nowrap; }
  #settings-section td { padding:7px 8px; border-bottom:1px solid var(--sx-line); vertical-align:middle; color:var(--sx-text2); }
  #settings-section .sxrow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:10px; }
  #settings-section .sxmodal { position:fixed; inset:0; z-index:200; background:rgba(5,6,10,.72); display:flex; align-items:center; justify-content:center; padding:16px; }
  #settings-section .sxdlg { width:100%; max-width:440px; background:var(--sx-card); border:1px solid var(--sx-ctl-line); border-radius:12px; padding:18px; box-shadow:0 20px 60px rgba(0,0,0,.6); color:var(--sx-text2); font-size:13px; }
  #settings-section .sxdlg h3 { margin:0 0 8px; font-size:16px; color:var(--sx-text); }
  #settings-section .sxdlg .sxrow { justify-content:flex-end; margin-top:14px; }
  #settings-section .sxrec { display:inline-flex; align-items:center; gap:8px; height:32px; padding:0 14px; border:1px solid var(--sx-sel-line); background:#1a2033; border-radius:9px; font-size:14px; letter-spacing:.04em; color:var(--sx-text); min-width:60px; justify-content:center; }
  #settings-section .sxrec.live { border-color:var(--sx-amber); color:var(--sx-amber); }
  #settings-section .sxempty { color:var(--sx-muted); font-size:12.5px; padding:10px 0; }
`;

export const SETTINGS_VIEW_HTML = String.raw`
<section id="settings-section">
  <div id="settings-body"></div>
</section>
`;

export const SETTINGS_VIEW_JS = String.raw`
// ---- Settings tab ----------------------------------------------------------------
var SET=null,ALLP=null;
var SX={sec:'general',data:{},loaded:{},restart:{},pre:false,rec:false,modal:null,ax:null,cust:{},pollT:0,pwOpen:false,diag:false,cmds:false};
try{var _sx=lsGet('loom.settingsSec');if(_sx)SX.sec=_sx;}catch(e){}
var SX_KEYMAP=__SX_KEYMAP__;
var SX_URL={probe:'/api/probe',prompt:'/api/orchestrator/prompt-override',dir:'/api/slack/directory',slack:'/api/slack/status',plugin:'/api/plugin/status',ship:'/api/ship/projects',slackapp:'/api/shortcut/slack-app'};
var SX_SECS=[
 {id:'general',label:'General',what:'Sets the default agent, which models do background work, cost limits and where Loom finds its tools.',needs:'Claude Code installed and logged in. gh for PR features.'},
 {id:'projects',label:'Projects',what:'Lists the folders Loom groups chats by and starts new chats in.',needs:'At least one folder.'},
 {id:'terminal',label:'Terminal',what:'Chooses where a chat opens, how it looks and how Ghostty tabs are rehomed.',needs:'Ghostty: Accessibility and Automation. iTerm2 and Terminal.app: Automation.'},
 {id:'agents',label:'Agents & permissions',what:'Sets how chats, watcher workers and the orchestrator are launched, including whether they skip permission prompts.',needs:'Nothing, but Skip permissions carries real risk.'},
 {id:'slack',label:'Slack',what:'Connects Loom to Slack so it can send from the Outbox, poll parked threads and label channels.',needs:'A Slack user token (kept in the macOS Keychain) or the Claude Slack connector.'},
 {id:'shortcut',label:'Slack shortcut',what:'Jump to or start a chat for the Slack message under your pointer.',needs:'Slack desktop app and Accessibility. Needs Slack connected for names.'},
 {id:'outbox',label:'Outbox',what:'Controls how drafts from chats are reviewed, sent and followed up.',needs:'Slack connected (Direct app) to send; helpers installed to record drafts.'},
 {id:'ship',label:'Ship',what:'Lists the repos you ship from and the command the Ship button runs.',needs:'A git repo with a remote and gh logged in.'},
 {id:'orch',label:'Orchestrator',what:'Runs a supervising chat that summarises and manages your other chats.',needs:'Claude Code login. Optional Remote Control needs a supported account.'},
 {id:'watchers',label:'Watchers',what:'Watches a Slack channel, your live chats or pull requests, and starts a chat, messages one, notifies you or tells the orchestrator when a rule matches.',needs:'Slack source: Direct app. Pull requests: gh. Chats: nothing.'},
 {id:'helpers',label:'Helpers',what:'Manages the hooks and skills Loom installs into Claude Code.',needs:'Claude Code on this machine. Loom adds a local plugin; it never edits settings.json.'},
 {id:'advanced',label:'Advanced',what:'Low-level tmux, lane, resource and server settings. Most people never need these.',needs:'Nothing.'},
 {id:'help',label:'Help',what:'Replays the tour or setup, and lists keyboard shortcuts.',needs:'Nothing.'}
];
var SX_L={claude:'Claude Code',codex:'Codex',ask:'Ask every time',haiku:'Haiku',sonnet:'Sonnet',opus:'Opus',account:'Account default',inside:'Inside Loom',ghostty:'Ghostty',iterm2:'iTerm2',terminal:'Terminal.app',managed:'Managed windows',lanes:'Lanes',zoom:'Zoom',mirror:'Mirror',normal:'Normal',skip:'Skip permissions',send:'Send',park:'Send & park',close:'Send & close',needs_you:'Only when it asks a question',all:'On every report',off:'Off',direct:'Direct app',mcp:'MCP only',system:'System default',auto:'Automatic',on:'Always'};

function sxEsc(s){return esc(String(s==null?'':s));}
function sxs(k){return SET&&SET.settings?SET.settings[k]:null;}
function sxv(k){var s=sxs(k);return s?s.value:undefined;}
function sxJ(u,o){return fetch(u,o||{}).then(function(r){return r.json().catch(function(){return {ok:false,detail:'bad response'};});});}
function sxPost(u,b){return sxJ(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});}
function sxErr(j){return (j&&(j.hint||j.detail||j.error))||'failed';}
function sxBad(m){toast(m,'#8a2c2c');}
function sxRerender(force){if(tab!=='settings')return;var a=document.activeElement;if(!force&&a&&a.closest&&a.closest('#settings-body')&&(a.tagName==='INPUT'||a.tagName==='SELECT'))return;renderSettings();}
function sxLoad(name,force){if(!force&&SX.loaded[name])return;SX.loaded[name]=1;sxJ(SX_URL[name]).then(function(j){SX.data[name]=j;sxRerender();}).catch(function(){SX.data[name]={ok:false};sxRerender();});}
function sxLoadProjects(){fetch('/api/projects?all=1').then(function(r){return r.json();}).then(function(j){if(j.ok){ALLP=j.projects;sxRerender();}});}
function sxLoadSettings(){return fetch('/api/settings').then(function(r){return r.json();}).then(function(d){if(d.ok){SET=d;sxRerender();}else{var el=$('#settings-body');if(el)el.innerHTML='<p class="meta">'+sxEsc(sxErr(d))+'</p>';}}).catch(function(){var el=$('#settings-body');if(el)el.innerHTML='<p class="meta">server off?</p>';});}
function sxAx(){if(window.loomNative&&window.loomNative.axStatus){window.loomNative.axStatus().then(function(a){SX.ax=a;sxRerender();}).catch(function(){SX.ax={unavailable:true};});}else SX.ax={unavailable:true};}
function sxPrefetch(){if(SX.pre)return;SX.pre=true;sxLoad('slack',true);sxLoad('plugin',true);sxLoad('ship',true);sxLoad('slackapp',true);if(!ALLP)sxLoadProjects();sxAx();}
function sxPut(o){return sxPost('/api/settings',o).then(function(j){if(j.ok){SET=Object.assign(SET,j);(j.changed||[]).forEach(function(k){var s=sxs(k);if(s&&s.restart)SX.restart[k]=1;});
  if(o.terminal!==undefined&&j.terminal)DATA.terminal={kind:j.terminal.effective,label:j.terminal.label};
  if(o.default_agent!==undefined){DATA.defaultAgent=o.default_agent;if(typeof syncDefaultAgent==='function')syncDefaultAgent();}
  if(o.slack_mode!==undefined)DATA.slackMode=o.slack_mode;
  renderSettings();}else{sxBad(sxErr(j));renderSettings();}return j;}).catch(function(){sxBad('server off?');});}

/* ---- small builders ---- */
function sxGrp(t){return '<div class="sxgrp">'+sxEsc(t)+'</div>';}
function sxRow(title,help,ctl,full){return '<div class="sxset'+(full?' full':'')+'"><div><b>'+title+'</b>'+(help?'<span class="h">'+help+'</span>':'')+'</div>'+(ctl!==''?'<div class="ctl">'+ctl+'</div>':'')+'</div>';}
function sxNote(t,kind){return '<div class="sxnote'+(kind?' '+kind:'')+'">'+t+'</div>';}
function sxPill(cls,t){return '<span class="pill '+cls+'">'+sxEsc(t)+'</span>';}
function sxBtn(act,label,o){o=o||{};return '<button type="button" class="sxbtn'+(o.pri?' pri':'')+(o.sm===false?'':' sm')+(o.danger?' danger':'')+(o.ghost?' ghost':'')+'" data-act="'+act+'"'+(o.arg!=null?' data-arg="'+sxEsc(o.arg)+'"':'')+(o.dis?' disabled':'')+'>'+sxEsc(label)+'</button>';}
function sxLab(v,o){if(o&&o.labels&&o.labels[v]!=null)return o.labels[v];return SX_L[v]!=null?SX_L[v]:String(v);}
function sxOn(v){return v?'On':'Off';}
function sxDefTxt(s,o){var d=s['default'];if(o.defTxt!=null)return o.defTxt;
  if(s.type==='bool')return sxOn(d);
  if(s.type==='enum'){if(o.kind==='toggle01')return d==='1'?'On':'Off';return sxLab(d,o);}
  if(s.type==='list')return d&&d.length?d.join(':'):'none';
  if(s.type==='int'||s.type==='number')return String(d)+(o.unit?' '+o.unit:'');
  if(d===''||d==null)return '';
  return String(d);}
function sxKind(s){if(s.type==='bool')return 'toggle';if(s.type==='enum')return s.options&&s.options.length<=3?'seg':'select';if(s.type==='int'||s.type==='number')return 'num';if(s.type==='list')return 'list';return 'text';}
function sxCtl(k,s,o,dis){var v=s.value,kind=o.kind||sxKind(s),d=dis?' disabled':'';
  if(kind==='toggle')return '<label class="tg"><input type="checkbox" data-sx="'+k+'" data-t="bool"'+(v?' checked':'')+d+'><i></i></label>';
  if(kind==='toggle01')return '<label class="tg"><input type="checkbox" data-sx="'+k+'" data-t="01"'+(v==='1'?' checked':'')+d+'><i></i></label>';
  if(kind==='seg'){var opts=o.opts||s.options,cur=(v===''&&o.eff)?o.eff:v;return '<div class="seg">'+opts.map(function(x){return '<button type="button" data-sxseg="'+k+'" data-v="'+sxEsc(x)+'"'+(x===cur?' class="on"':'')+d+'>'+sxEsc(sxLab(x,o))+'</button>';}).join('')+'</div>';}
  if(kind==='select'){var os=o.opts||s.options,cur2=(v===''&&o.eff)?o.eff:v;return '<select data-sx="'+k+'" data-t="enum"'+d+'>'+os.map(function(x){return '<option value="'+sxEsc(x)+'"'+(x===cur2?' selected':'')+'>'+sxEsc(sxLab(x,o))+'</option>';}).join('')+'</select>';}
  if(kind==='num')return '<input type="number" data-sx="'+k+'" data-t="num" value="'+sxEsc(v)+'"'+(o.min!=null?' min="'+o.min+'"':'')+(o.max!=null?' max="'+o.max+'"':'')+(o.step?' step="'+o.step+'"':'')+' style="width:90px;flex:none"'+d+'>'+(o.unit?'<span class="def">'+sxEsc(o.unit)+'</span>':'');
  if(kind==='list')return '<input type="text" data-sx="'+k+'" data-t="list" class="mono" value="'+sxEsc((v||[]).join(':'))+'" placeholder="'+sxEsc(o.ph||'')+'"'+d+'>';
  return '<input type="text" data-sx="'+k+'" data-t="text"'+(o.mono?' class="mono"':'')+' value="'+sxEsc(v)+'" placeholder="'+sxEsc(o.ph||'')+'"'+(o.w?' style="max-width:'+o.w+'px"':'')+d+'>';}
function sxKey(k,o){o=o||{};var s=sxs(k);if(!s)return '';var envd=s.source==='env';
  var help=o.help!=null?sxEsc(o.help):sxEsc(s.help);
  var dt=sxDefTxt(s,o);if(dt&&o.noDef!==true)help+=' <span class="def">Default: <b>'+sxEsc(dt)+'</b>.</span>';
  if(o.note)help+=' '+o.note;
  if(s.restart)help+=' <span class="rst">Takes effect after a restart.</span>';
  var ctl=sxCtl(k,s,o,envd||o.dis)+(envd?sxPill('opt','set by environment: '+(s.env||''))+'':'')+(o.after||'');
  return sxRow(sxEsc(o.title||s.label),help,ctl);}
// A choice among presets plus a free text value (new thread folder, review skill).
function sxChoice(k,presets,o){o=o||{};var s=sxs(k);if(!s)return '';var v=s.value,envd=s.source==='env';var isP=presets.some(function(p){return p[0]===v;});var custom=!isP||!!SX.cust[k];
  var sel='<select data-sxch="'+k+'"'+(envd?' disabled':'')+'>'+presets.map(function(p){return '<option value="'+sxEsc(p[0])+'"'+(p[0]===v&&!custom?' selected':'')+'>'+sxEsc(p[1])+'</option>';}).join('')+'<option value="__custom"'+(custom?' selected':'')+'>'+sxEsc(o.customLabel||'Other…')+'</option></select>';
  var txt=custom?'<input type="text" data-sx="'+k+'" data-t="text" class="mono" value="'+sxEsc(isP?'':v)+'" placeholder="'+sxEsc(o.ph||'')+'"'+(envd?' disabled':'')+'>':'';
  var help=sxEsc(o.help!=null?o.help:s.help);var dt=o.defTxt;if(dt)help+=' <span class="def">Default: <b>'+sxEsc(dt)+'</b>.</span>';
  return sxRow(sxEsc(o.title||s.label),help,sel+txt);}
function sxFmtAcc(a){if(!a||a==='off')return 'Off';var m={command:'⌘',cmd:'⌘',commandorcontrol:'⌘',control:'⌃',ctrl:'⌃',alt:'⌥',option:'⌥',shift:'⇧'};return String(a).split('+').map(function(p){return m[p.toLowerCase()]||p;}).join('');}
function sxAgo(ms){var d=Date.now()-ms;if(d<60000)return 'just now';if(d<3600000)return Math.round(d/60000)+' minutes ago';if(d<86400000)return Math.round(d/3600000)+' hours ago';return Math.round(d/86400000)+' days ago';}
function sxWhen(ms){return ms?new Date(ms).toLocaleString():'';}
function sxProjName(p){var r=(ALLP||[]).filter(function(x){return x.path===p;})[0];return r?r.name:shortPath(p);}

/* ---- status pills (nav dot and section header) ---- */
function sxStatus(id){var sl=SX.data.slack,mode=sxv('slack_mode'),pl=SX.data.plugin,sh=SX.data.ship;
  if(id==='general')return ['ok','Ready'];
  if(id==='projects'){var n=(ALLP||[]).filter(function(p){return !p.hidden;}).length;return n?['ok',n+(n===1?' project':' projects')]:['warn','No folders yet'];}
  if(id==='terminal'){var t=SET.terminal;return ['ok',t?t.label:'Inside Loom'];}
  if(id==='agents'){var sk=['perm_chats','perm_watchers','perm_orchestrator'].filter(function(k){return sxv(k)==='skip';}).length;return sk?['warn','Skip permissions on']:['ok','Normal permissions'];}
  if(id==='slack'){if(mode==='off')return ['off','Off'];if(mode==='mcp')return ['ok','MCP only'];if(!sl)return ['off','Checking'];if(!sl.connected)return ['warn','Not connected'];var miss=sl.scopes&&sl.scopes.missing?sl.scopes.missing.length:0;return miss?['warn','Connected, '+miss+(miss===1?' scope missing':' scopes missing')]:['ok','Connected'];}
  if(id==='shortcut'){var hk=sxv('slack_goto_hotkey');return hk==='off'?['off','Off']:['ok',sxFmtAcc(hk)];}
  if(id==='outbox'){return mode==='direct'?['ok','On']:['off','Needs Slack (Direct app)'];}
  if(id==='ship'){if(!sh||!sh.projects)return ['off','Checking'];var e=sh.projects.filter(function(p){return p.enabled;}).length;return e?['ok',e+(e===1?' repo':' repos')]:['off','No repos'];}
  if(id==='orch')return sxv('orchestrator_enabled')==='1'?['ok','Enabled']:['off','Off'];
  if(id==='watchers')return sxv('watchers_enabled')?['ok','On']:['off','Off'];
  if(id==='helpers'){if(!pl)return ['off','Checking'];if(pl.status==='installed')return ['ok','Installed'];if(pl.status==='update_available')return ['warn','Update available'];if(pl.status==='not_installed')return ['warn','Not installed'];if(pl.status==='disabled')return ['warn','Disabled'];return ['err','Error'];}
  if(id==='advanced'){var ch=Object.keys(SET.settings).filter(function(k){var s=SET.settings[k];return s.section==='advanced'&&s.source==='stored'&&JSON.stringify(s.value)!==JSON.stringify(s['default']);}).length;return ch?['off',ch+' changed']:['ok','Defaults'];}
  return ['ok','Tour and setup'];}

/* ---- sections ---- */
function sxGeneral(){var cv=DATA.codexVisible;var aopts=cv||sxv('default_agent')==='codex'?['claude','codex','ask']:['claude','ask'];
  return sxGrp('Agents and models')+
   sxKey('default_agent',{kind:'seg',opts:aopts,title:'Default agent',help:'Used by New thread. Codex appears only when ~/.codex exists.'})+
   sxKey('summary_model',{kind:'select',title:'Summary model',help:'Writes each chat title, overview and state. Account default passes no model flag, so it uses your Claude Code default.',labels:{haiku:'Haiku',sonnet:'Sonnet',opus:'Opus',account:'Account default'}})+
   sxKey('analyze_cap',{title:'Chats summarised per pass',help:'Caps cost when many chats changed.',min:1,max:100})+
   sxKey('analyze_concurrency',{title:'Summaries at once',help:'Parallel summary calls.',min:1,max:6})+
   sxKey('active_window_days',{title:'Index window',help:'Chats older than this move to archive search.',unit:'days',min:1,max:60})+
   sxKey('codex_visible',{kind:'seg',title:'Show Codex',help:'Whether Codex appears in agent pickers.',labels:{auto:'Automatic',on:'Always',off:'Never'}})+
   sxGrp('Defaults')+
   sxChoice('new_thread_dir',[['last','Last folder you used'],['home','Home folder']],{title:'New thread starts in',help:'Where the New thread composer begins. Falls back to your home folder.',customLabel:'A fixed folder…',ph:'/absolute/path',defTxt:'Last folder you used'})+
   sxKey('notify_sound',{kind:'select',title:'Notification sound',help:'Played when a parked thread gets a reply.',labels:{off:'Off',system:'System default'},after:sxBtn('snd','▶ Preview')})+
   sxGrp('Tools Loom runs')+
   sxKey('claude_bin',{title:'Claude Code binary',help:'Detected through your shell when empty. Set it if Claude lives somewhere unusual, such as an nvm global.',note:sxDetected('claude'),ph:sxPr('claude')||'Detected automatically',mono:true,noDef:true,after:sxBtn('detect','Detect')})+
   sxKey('extra_path',{title:'Extra PATH entries',help:'Searched before launching claude, tmux, gh and node, separated by colons. Apps started from Finder do not inherit your shell PATH.',ph:'~/.local/bin:/opt/homebrew/bin'})+
   sxRow('GitHub CLI','PR status, checks and Ship.',sxGh());}
function sxPr(n){var p=SX.data.probe;return p&&p.ok&&p.probe[n]&&p.probe[n].found?p.probe[n].path||'':'';}
function sxDetected(n){var p=sxPr(n);return p?' <span class="def">Detected: <b>'+sxEsc(shortPath(p))+'</b>.</span>':'';}
function sxGh(){var p=SX.data.probe;if(!p)return sxPill('off','Checking');if(!p.ok)return sxPill('off','Could not check');var g=p.probe.gh;if(!g.found)return sxPill('warn','gh not found');var v=g.version?'gh '+g.version.raw:'gh';return g.auth&&g.auth.loggedIn?sxPill('ok',v+' · logged in'+(g.auth.hosts&&g.auth.hosts.length?' to '+g.auth.hosts[0]:'')):sxPill('warn',v+' · not logged in')+'<span class="def">Run gh auth login in a terminal.</span>';}
function sxProjects(){if(!ALLP)return '<p class="sxempty">loading…</p>';var cp=sxv('channel_projects')||{};
  var rows=ALLP.map(function(p){var ch=Object.keys(cp).filter(function(c){return cp[c]===p.path;}).join(', ');var n=DATA.chats.filter(function(c){return c.project_dir===p.path;}).length;
   return '<tr><td><input type="text" data-pname="'+p.id+'" value="'+sxEsc(p.name)+'" style="width:150px"></td><td><code>'+sxEsc(shortPath(p.path))+'</code></td><td>'+(ch?sxEsc(ch):'–')+'</td><td>'+n+'</td><td style="white-space:nowrap">'+(p.hidden?sxPill('off','Hidden')+' ':'')+sxBtn('phide',p.hidden?'Unhide':'Hide',{arg:p.id})+' '+sxBtn('prm','Remove',{arg:p.id,danger:true})+'</td></tr>';}).join('');
  var nat=window.loomNative&&window.loomNative.pickFolder;
  return (rows?'<div class="sxtbl"><table><tr><th>Name</th><th>Folder</th><th>Slack channels</th><th>Chats</th><th></th></tr>'+rows+'</table></div>':'<p class="sxempty">No folders yet. Add the folders you work in so New thread can start chats there.</p>')+
   '<div class="sxrow">'+(nat?'':'<input type="text" id="sx-newproj" class="mono" placeholder="/absolute/path/to/folder" style="width:300px">')+sxBtn('padd','+ Add folder…',{sm:false})+'<span class="def" id="sx-pmsg">Removing a project hides its chats from the list. It never deletes files or sessions.</span></div>';}
function sxAxRow(){var a=SX.ax;var pill=!a?sxPill('off','Checking'):a.unavailable?sxPill('off','Only in the Loom app'):a.helperDown?sxPill('warn','Helper not running'):a.trusted?sxPill('ok','Granted'):sxPill('warn','Not granted');
  return pill+(a&&!a.unavailable&&!a.trusted?sxBtn('axopen','Open System Settings'):'');}
function sxTerminal(){var T=SET.terminal||{};
  return sxKey('terminal',{kind:'select',title:'Open chats in',help:'Where Jump and Open in external terminal land.',eff:T.effective,noDef:true,note:T.stored?'':'<span class="def">Not set: using '+sxEsc(T.label||T.effective)+'.</span>'})+
   sxKey('launch_target',{kind:'seg',title:'Where new chats run',help:'Managed windows are created and closed by Loom, one tmux window per chat. Lanes are numbered tmux sessions you arrange yourself (see Advanced).',eff:(SET.launch_target||{}).effective,labels:{managed:'Managed windows',lanes:'Lanes'}})+
   sxGrp('Ghostty')+
   sxKey('ghostty_rehome',{title:'Re-home tabs after a restore',help:'After tmux restarts, reattach each session to its Ghostty tab. Applies only when Ghostty is the terminal.'})+
   sxKey('ghostty_attach_cmd',{title:'Attach command typed into a tab',help:'The command Loom types to attach a tab to its session.',mono:true,noDef:false})+
   sxRow('macOS permissions','Accessibility and Automation, needed to read and click Ghostty tabs.',sxAxRow())+
   sxGrp('Pane appearance')+
   sxKey('pane_labels',{title:'Pane labels (topic and stage)',help:'A short title and a stage glyph on each tmux pane border. Costs one small model call per change.',after:sxKey_sel('pane_label_model')})+
   sxKey('pane_tint',{title:'Tint stale panes',help:'Fade panes that have been idle. Colours derive from the base colour.',after:sxKey_text('pane_tint_base')});}
// Compact inline controls used inside another row.
function sxKey_sel(k){var s=sxs(k);return s?sxCtl(k,s,{kind:'select'},s.source==='env'):'';}
function sxKey_text(k){var s=sxs(k);return s?sxCtl(k,s,{mono:true,w:110},s.source==='env'):'';}
function sxAgents(){var skipOn=['perm_chats','perm_watchers','perm_orchestrator'].some(function(k){return sxv(k)==='skip';});
  return sxKey('perm_chats',{kind:'seg',title:'Chats started from Loom',help:'New thread, Resume and Branch.'})+
   sxKey('perm_watchers',{kind:'seg',title:'Watcher workers',help:'Chats a watcher starts on its own.'})+
   (skipOn?sxNote('Skip permissions launches claude with <code>--dangerously-skip-permissions</code>. Claude can run any command and edit any file without asking.','err'):'')+
   sxKey('rc_watchers',{title:'Remote Control for watcher workers',help:'Lets you steer them from the Claude app. Needs a supported account.'})+
   sxKey('orchestrator_trust',{title:'Trust the orchestrator folder in ~/.claude.json',help:'Lets the orchestrator run unattended. The trust entry is only added with your consent.'})+
   sxChoice('review_skill',[['loom:review','loom:review (generic, read-only)'],['none','None']],{title:'Review skill for watcher briefs',help:'Which skill a PR-review watcher tells its worker to load.',customLabel:'Another skill…',ph:'skill-name',defTxt:'loom:review'})+
   sxChoice('voice_skill',[['','None']],{title:'Voice skill for drafts',help:'Optional. A skill that writes drafts in your tone.',customLabel:'A skill…',ph:'skill-name',defTxt:'None'});}
function sxSlackSection(){var sl=SX.data.slack,mode=sxv('slack_mode'),st=sxs('slack_mode');
  var seg='<div class="seg">'+['direct','mcp','off'].map(function(m){return '<button type="button" data-act="smode" data-arg="'+m+'"'+(m===mode?' class="on"':'')+'>'+sxEsc(sxLab(m))+'</button>';}).join('')+'</div>';
  var h=sxRow('Connection','Direct app gives every feature. MCP only is reduced: no sending from the Outbox, no parked-thread polling, no names or previews.',seg);
  if(!sl)return h+'<p class="sxempty">loading…</p>';
  var env=sl.tokenSource==='env';var conn=sl.connected;
  var tok=conn?(env?sxPill('ok','Token from environment'):'<input type="password" disabled value="xoxp-••••••••••••••••" style="max-width:190px">'+sxBtn('stest','Test')+sxBtn('sreplace','Replace')+sxBtn('sdisc','Disconnect',{danger:true})):'';
  if(conn&&env)tok+=sxBtn('stest','Test');
  var form=(!conn||SX.pwOpen)?'<input type="password" id="sx-tok" placeholder="xoxp-…" autocomplete="off" style="max-width:220px">'+sxBtn('sconn',conn?'Save new token':'Connect',{pri:true})+sxBtn('smanifest','Copy app manifest'):'';
  h+=sxRow('Token',conn?(env?'Set by SLACK_USER_TOKEN, which wins over a stored token.':'Stored in your macOS Keychain and never shown again. Replace it to rotate.'):'Create a Slack app from the manifest, install it, and paste the User OAuth Token (starts with xoxp-).',(tok+(tok&&form?'<br>':'')+form),false);
  var idn=sl.identity;
  h+=sxRow('Workspace','The permalink slug is read from the token, not typed.',idn?sxPill('ok',(idn.user||'')+(idn.team?' · '+idn.team:''))+(idn.url?'<code>'+sxEsc(String(idn.url).split('https://').join(''))+'</code>':''):sxPill('off','Not connected'));
  if(conn&&sl.scopes){var sc=sl.scopes,miss=sc.missing||[];
   h+=sxRow('Granted scopes','Loom compares these with what it needs.',sxPill(miss.length?'warn':'ok',(sc.granted||0)+' of '+(sc.required||0))+miss.map(function(m){return sxPill('warn',m+' missing');}).join('')+(miss.length?sxBtn('sreauth','Re-authorise'):''));
   if(miss.length)h+=sxNote('Add <code>'+miss.map(sxEsc).join('</code> <code>')+'</code> to the Slack app and reinstall it. Re-authorise copies an updated app manifest to paste at api.slack.com/apps (Your Apps, the app, App Manifest). Features that need those scopes stay off until then.','warn');}
  h+=sxKey('slack_poll_parked',{title:'Poll parked threads for replies',help:'Checks threads you parked with Send & park.'});
  var dr=SX.data.dir;h+=sxRow('Directory and emoji cache','People, channels and custom emoji.'+(dr&&dr.fetchedAt?' Last refreshed '+sxEsc(sxAgo(dr.fetchedAt))+'.':' Not refreshed yet.'),sxBtn('sdir','Refresh now',{dis:mode!=='direct'}));
  h+=sxGrp('Channel to project map')+'<div class="def" style="margin-bottom:6px">The shortcut and watchers start chats in the project mapped to the channel.</div>';
  var cp=sxv('channel_projects')||{},ks=Object.keys(cp);var projs=(ALLP||[]).filter(function(p){return !p.hidden;});
  var cn=(SX.data.dir&&SX.data.dir.channels)||{};
  h+=ks.length?'<div class="sxtbl"><table><tr><th>Channel</th><th>Project</th><th></th></tr>'+ks.map(function(c){var nm=cn[c];var opts=projs.slice();if(!opts.some(function(p){return p.path===cp[c];}))opts.push({path:cp[c],name:sxProjName(cp[c])});return '<tr><td>'+(nm?'#'+sxEsc(nm)+' <span class="def">'+sxEsc(c)+'</span>':'<code>'+sxEsc(c)+'</code>')+'</td><td><select data-chsel="'+sxEsc(c)+'">'+opts.map(function(p){return '<option value="'+sxEsc(p.path)+'"'+(p.path===cp[c]?' selected':'')+'>'+sxEsc(p.name)+'</option>';}).join('')+'</select></td><td>'+sxBtn('chrm','Remove',{arg:c,danger:true})+'</td></tr>';}).join('')+'</table></div>':'<p class="sxempty">No mappings yet.</p>';
  h+='<div class="sxrow"><input type="text" id="sx-ch" class="mono" placeholder="Channel id (C0123ABCD)" style="width:200px"><select id="sx-chp">'+projs.map(function(p){return '<option value="'+sxEsc(p.path)+'">'+sxEsc(p.name)+'</option>';}).join('')+'</select>'+sxBtn('chadd','+ Map a channel')+'<span class="def" id="sx-chmsg"></span></div>';
  return h;}
function sxShortcut(){var hk=sxv('slack_goto_hotkey'),sa=SX.data.slackapp,pr=SX.practice,lr=sxv('slack_ax_last_result')||{};
  var recbox='<span class="sxrec'+(SX.rec?' live':'')+'" id="sx-rec">'+(SX.rec?'Press the keys…':sxEsc(sxFmtAcc(hk)))+'</span>';
  var h=sxRow('Shortcut','Global. Works while Slack is focused. Default ⌘⇧L. Needs a modifier key.',recbox+sxBtn('srec',SX.rec?'Cancel':'Record')+sxBtn('sreset','Reset',{ghost:true})+sxBtn('soff','Turn off',{ghost:true}));
  if(SX.recMsg)h+=sxNote(sxEsc(SX.recMsg),SX.recKind||'');
  h+=sxRow('Slack desktop app','The browser version cannot be read.',!sa?sxPill('off','Checking'):sa.found?sxPill('ok','Found'):sxPill('warn','Not found'));
  h+=sxRow('Accessibility','Lets Loom see which message is under the pointer.',sxAxRow());
  h+=sxKey('slack_paste_fallback',{title:'If the message cannot be read',help:'Slack changes its page structure now and then. The fallback asks you to paste the thread link.',after:'<span class="def">Show a paste-link box</span>'});
  var res='';if(pr&&pr.state==='armed')res=sxPill('warn','Waiting for the shortcut…')+sxBtn('pcancel','Cancel');
  else if(pr&&pr.state==='done'){var r=pr.result||{};res=sxPill(r.ok?'ok':'err',r.ok?('Read '+(r.author||'a message')+(r.channel?' in '+r.channel:'')+(r.wouldDo?' · would '+r.wouldDo:'')):(r.detail||'Could not read the message'))+sxBtn('parm','Practice again');}
  else if(pr&&pr.state==='timeout')res=sxPill('off','Timed out')+sxBtn('parm','Practice again');
  else res=sxBtn('parm','Practice');
  h+=sxRow('Practice','Arms the shortcut for 60 seconds. Hover a message in Slack and press it: Loom reports what it would do without doing it.',res);
  var last=lr&&Object.keys(lr).length?sxPill(lr.ok===false?'err':'ok',lr.detail||lr.result||(lr.ok===false?'Failed':'Worked'))+(lr.at?'<span class="def">'+sxEsc(sxWhen(lr.at))+'</span>':''):sxPill('off','No result yet');
  h+=sxRow('Last result','From the last time the shortcut ran.',last);
  return h;}
function sxOutbox(){var slOn=sxv('slack_mode')==='direct';
  return (slOn?'':sxNote('Slack is not connected as a Direct app, so the Outbox cannot send. Drafts can still be reviewed. Connect it in the Slack section.','warn'))+
   sxKey('outbox_primary',{kind:'select',title:'Main button does',help:'What the first button in the Outbox strip does.',labels:{send:'Send',park:'Send & park',close:'Send & close'}})+
   sxKey('outbox_confirm',{title:'Confirm before posting',help:'Shows channel, thread and text once more.'})+
   sxKey('auto_resume_parked',{title:'Reopen parked chats when a reply arrives',help:'Reopens each one in a managed pane with the reply as its first prompt. Off leaves a Resume button.'})+
   sxKey('outbox_slack_drafts',{title:'Also save to Slack Drafts',help:'Uses an unofficial Slack endpoint.'})+
   sxKey('outbox_chat_drafts',{title:'Let chats add drafts to the Outbox',help:'Needs the outbox hook and slack-drafting skill from Helpers, and a Direct Slack connection.',after:sxHelperPill('outbox-recording')})+
   sxKey('outbox_keep_days',{title:'Keep sent and discarded drafts',help:'Then they are removed from the Outbox.',unit:'days',min:1});}
function sxHelperPill(name){var pl=SX.data.plugin;if(!pl)return '';return pl.status==='not_installed'?sxPill('warn','Helpers not installed'):sxPill('ok','Installed');}
function sxShip(){var sh=SX.data.ship;if(!sh)return '<p class="sxempty">loading…</p>';var rows=sh.projects||[];
  var tb=rows.length?'<div class="sxtbl"><table><tr><th>Repo</th><th>Base branch</th><th>Ship command</th><th>Label staged work</th><th>Ship lock</th><th>On</th><th></th></tr>'+rows.map(function(p){var d=sxEsc(p.project_dir);
   return '<tr><td><code>'+sxEsc(shortPath(p.project_dir))+'</code><div class="def">'+sxEsc(p.repo_slug||'')+'</div></td><td><input type="text" data-ship="'+d+'" data-f="base_branch" value="'+sxEsc(p.base_branch)+'" style="width:90px"></td><td><input type="text" data-ship="'+d+'" data-f="ship_command" value="'+sxEsc(p.ship_command)+'" style="width:130px"></td><td><label class="tg"><input type="checkbox" data-ship="'+d+'" data-f="label_required"'+(p.label_required?' checked':'')+'><i></i></label></td><td><label class="tg"><input type="checkbox" data-ship="'+d+'" data-f="ship_lock"'+(p.ship_lock!==false?' checked':'')+'><i></i></label></td><td><label class="tg"><input type="checkbox" data-ship="'+d+'" data-f="enabled"'+(p.enabled?' checked':'')+'><i></i></label></td><td>'+sxBtn('shrm','Remove',{arg:p.project_dir,danger:true})+'</td></tr>';}).join('')+'</table></div><p class="def">Ship lock: while a ship runs from this repo, other chats can’t stage on its main branch.</p>':'<p class="sxempty">No repos yet. The first Ship click offers to add the current repo, or add one below.</p>';
  var have={};rows.forEach(function(p){have[p.project_dir]=1;});var cands=(ALLP||[]).filter(function(p){return !p.hidden&&!have[p.path];});
  return (sh.override?sxNote('<code>LOOM_SHIP_REPOS</code> is set in the environment and overrides this list.','warn'):'')+tb+
   '<div class="sxrow"><select id="sx-shipadd">'+cands.map(function(p){return '<option value="'+sxEsc(p.path)+'">'+sxEsc(p.name+' · '+shortPath(p.path))+'</option>';}).join('')+'</select>'+sxBtn('shadd','+ Add repo from Projects',{dis:!cands.length})+'<span class="def" id="sx-shmsg"></span></div>'+
   sxKey('trees_prune_after_ship',{title:'Prune merged worktrees after a ship',help:'When a ship lands, removes that repo’s worktrees that are merged, clean and not in use. Never forced; the result shows in the Trees tab.'})+
   sxNote('The Ship button runs the ship command in a new chat. A new row defaults to <code>'+sxEsc(sh.defaultCommand||'/loom:ship')+'</code>. There is no force option.');}
function sxOrch(){return sxKey('orchestrator_enabled',{kind:'toggle01',title:'Orchestrator',help:'A chat that supervises your other chats.'})+
   sxKey('perm_orchestrator',{kind:'seg',title:'Permission mode',help:'Same trade-off as chats.'})+
   sxKey('rc_orchestrator',{title:'Remote Control',help:'Drive it from the Claude app. Needs a supported account.'})+
   sxKey('orchestrator_notify',{kind:'select',title:'Notify me',help:'When the orchestrator pings you.',labels:{needs_you:'Only when it asks a question',all:'On every report',off:'Never'}})+
   sxKey('orchestrator_autostart',{title:'Start at launch',help:'Start it whenever Loom starts. Only matters when it is enabled.'})+
   sxPromptBlock();}
function sxPromptBlock(){var pr=SX.data.prompt;if(!pr)return '<p class="sxempty">loading…</p>';if(!pr.ok)return sxNote('Could not read the prompt.','err');
  return '<div class="sxset full"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><div><b>Orchestrator prompt</b><span class="h">Loaded each time it starts. Edits are kept in orchestrator/prompt.override.md in your Loom data folder; '+(pr.active==='override'?'a custom prompt is in use.':'the default prompt is in use.')+'</span></div>'+sxBtn('preset','Reset to default',{ghost:true,dis:pr.active!=='override'})+'</div><textarea id="sx-prompt" rows="9" spellcheck="false" style="width:100%;box-sizing:border-box;margin-top:8px;background:var(--sx-ctl);color:var(--sx-text);border:1px solid var(--sx-ctl-line);border-radius:8px;padding:8px 10px;font:12px/1.5 var(--sx-mono);resize:vertical">'+sxEsc(pr.active==='override'?pr.override:pr['default'])+'</textarea><div class="sxrow">'+sxBtn('psave','Save prompt',{pri:true,sm:false})+'<span class="def" id="sx-pmsg2">Applies the next time the orchestrator starts.</span></div></div>';}
function sxWatchers(){return sxNote('Watchers are edited on the Watchers tab: source, trigger, action, run mode, and a Test before anything fires.')+
   '<div class="sxrow">'+sxBtn('gowatch','Open the Watchers tab',{pri:true,sm:false})+'<span class="def">The master switch and safety limits live there too.</span></div>';}
var SX_ITEMS=[
 ['record-placement','Hook','Remembers which pane each chat runs in.',''],
 ['thread-ownership','Hook','Tells Loom which chat owns a Slack thread.','slack'],
 ['outbox-recording','Hook','Lets chats add drafts to the Outbox.','outbox'],
 ['ship-labels','Hook','Asks for a one-line label on staged work before Ship.','ship'],
 ['ship','Skill','The generic ship procedure the Ship button starts.',''],
 ['slack-drafting','Skill','How a chat writes and queues a Slack draft.','slack'],
 ['handling-slack-threads','Skill','Picks up a Slack thread as a ticket or as context.','slack'],
 ['tmux-route','Skill','Messages another pane by its name.',''],
 ['review','Skill','Generic read-only pull request review used by watchers.','']];
function sxGate(g){var sm=sxv('slack_mode');var sh=(SX.data.ship&&SX.data.ship.projects||[]).filter(function(p){return p.enabled&&p.label_required;}).length;
  if(g==='slack')return sm==='off'?'Inactive: Slack is off':'';
  if(g==='outbox')return sm==='off'?'Inactive: Slack is off':sxv('outbox_chat_drafts')?'':'Inactive: chat drafts are off';
  if(g==='ship')return sh?'':'Inactive: no repo requires labels';return '';}
function sxHelpers(){var pl=SX.data.plugin;if(!pl)return '<p class="sxempty">loading…</p>';var st=pl.status,inst=st==='installed'||st==='update_available';
  var vtxt=pl.installedVersion?'v'+pl.installedVersion:'';
  var rows=SX_ITEMS.map(function(it){var g=inst?sxGate(it[3]):'';var pill=!inst?sxPill('off','Not installed'):g?sxPill('off',g):st==='update_available'?sxPill('warn','Update available'):sxPill('ok','Installed '+vtxt);
   return '<tr><td><b>'+sxEsc(it[0])+'</b></td><td>'+it[1]+'</td><td>'+sxEsc(it[2])+'</td><td>'+pill+'</td></tr>';}).join('');
  var acts=[];if(st==='not_installed')acts.push(sxBtn('hinst','Install helpers',{pri:true,sm:false}));
  if(st==='update_available')acts.push(sxBtn('hupd','Update to v'+(pl.bundledVersion||''),{pri:true,sm:false}));
  if(inst||st==='disabled'||st==='error')acts.push(sxBtn('hrm','Remove',{sm:false,danger:true}));
  acts.push(sxBtn('hcmds',SX.cmds?'Hide commands':'View commands',{sm:false,ghost:true}));
  var cmds=SX.cmds&&pl.preview?'<pre class="sxpre">'+sxEsc((pl.preview.install||[]).map(function(c){return c.display;}).join(String.fromCharCode(10))+(pl.preview.note?String.fromCharCode(10,10)+pl.preview.note:''))+'</pre>':'';
  var leg=(pl.legacy||[]).length?sxGrp('Older hooks in ~/.claude/settings.json')+sxNote('These were added by hand before the plugin. Loom never edits that file, so remove them yourself once the plugin is installed or they run twice.','warn')+'<div class="sxtbl"><table><tr><th>Line</th><th>Event</th><th>Entry</th></tr>'+pl.legacy.map(function(l){return '<tr><td>'+l.line+'</td><td>'+sxEsc(l.event||'')+'</td><td><code>'+sxEsc(l.text)+'</code></td></tr>';}).join('')+'</table></div>':'';
  return (st==='error'?sxNote(sxEsc(pl.error||'The plugin manager reported an error.'),'err'):'')+(pl.sourceMissing?sxNote('This build is missing the bundled plugin files.','err'):'')+
   '<div class="sxtbl"><table><tr><th>Item</th><th>Kind</th><th>What it does</th><th>Status</th></tr>'+rows+'</table></div>'+
   '<div class="sxrow">'+acts.join('')+'</div>'+cmds+leg+
   (DATA.codexVisible?sxGrp('Codex')+sxKey('codex_hook',{title:'Codex notification hook',help:'Lets Loom add its hook to ~/.codex/hooks.json so Codex chats report their state.'}):'');}
function sxAdvanced(){var home='';var pl=SX.data.plugin;if(pl&&pl.marketplaceDir){var m=String(pl.marketplaceDir);var i=m.lastIndexOf('/');home=i>0?m.slice(0,i):m;}
  return sxNote('Most people never change these. Changes to the socket, prefix, directory or port take effect after Loom restarts.','warn')+
   sxGrp('tmux')+
   sxKey('tmux_socket',{title:'tmux socket',help:'Loom runs its own tmux server, separate from your default one.',mono:true,w:160})+
   sxKey('session_prefix',{title:'Session prefix',help:'Only sessions starting with this are snapshotted and restored. Renaming a session off the prefix silently disables crash recovery for it.',mono:true,w:120})+
   sxKey('tmux_tmpdir',{title:'tmux socket directory',help:'auto detects it through a login shell. Override only if your tmux uses a different directory.',mono:true,ph:'auto'})+
   sxKey('reap_idle_min',{title:'Reap idle panes after',help:'Closes finished managed panes.',unit:'minutes',min:1})+
   sxKey('min_free_mb',{title:'Pause new chats when memory is below',help:'0 uses the built-in rule (2 percent of memory, at least 300 MB).',unit:'MB free',min:0})+
   sxKey('max_load_per_cpu',{title:'Pause new chats when load per CPU is above',help:'Load average divided by CPU count.',step:'0.1',min:0})+
   sxGrp('Lanes')+
   sxKey('lane_view',{kind:'select',title:'Lane view',help:'How the terminal shows a chat whose tmux window has other panes. Zoom resizes the window to Loom and undoes it on close; Mirror leaves the window exactly as it is.',labels:{zoom:'Zoom the pane',mirror:'Mirror without changing the window'}})+
   sxKey('watcher_default_target',{title:'Default lane for watchers',help:'managed starts watcher chats in their own window; lane:name uses a free pane in that lane.',mono:true,w:160})+
   sxGrp('Server')+
   sxKey('port',{title:'Port',help:'Local dashboard address.',min:1024,max:65535,after:'<span class="def">http://localhost:'+sxEsc(sxv('port'))+'</span>'})+
   sxKey('find_chat_bin',{title:'Archive search tool',help:'The find-chat executable. Empty detects it; without one, search beyond the index window is hidden.',mono:true,ph:'Detected automatically',noDef:true,after:'<span class="def">'+(DATA.archiveSearch?'Found':'Not found')+'</span>'})+
   sxRow('Data folder','Read only. Set before launch with LOOM_HOME.',home?'<code>'+sxEsc(shortPath(home))+'</code>':sxPill('off','Unknown'))+
   sxRow('Diagnostics','Settings and counts with no tokens in them, for a bug report.',sxBtn('copydiag','Copy support info')+sxBtn('openlogs','Open logs'));}
function sxHelp(){var hk=sxv('slack_goto_hotkey');
  var rows=SX_KEYMAP.filter(function(k){return k.scope!=='dialog'||true;}).map(function(k){var keys=k.keys;if(k.setting){var v=sxv(k.setting);if(!v||v==='off')return '';keys=sxFmtAcc(v);}
   return '<tr><td><span class="kbd">'+sxEsc(keys)+'</span></td><td>'+sxEsc(k.label)+'</td></tr>';}).join('');
  var done=sxv('setup_completed_at'),origin=sxv('setup_origin'),tour=sxv('tour_completed_at')||sxv('tour_skipped_at');var ss=sxv('setup_state')||{};var steps=ss.steps?Object.keys(ss.steps):[];
  return '<div class="sxrow" style="margin-top:0">'+sxBtn('tour','Take the tour',{pri:true,sm:false})+sxBtn('setup','Run setup again',{sm:false})+'</div>'+
   sxGrp('Keyboard shortcuts')+'<div class="sxtbl"><table><tr><th>Shortcut</th><th>Action</th></tr>'+rows+'</table></div>'+
   sxGrp('Setup and tour')+
   sxRow('Setup','Recorded when the setup wizard finishes, or when an existing install was migrated.',done?sxPill('ok',(origin==='migrated'?'Migrated ':'Finished ')+sxWhen(done)):sxPill('warn','Not finished'))+
   sxRow('Setup steps','What the wizard recorded for each step.',steps.length?steps.map(function(s){return sxPill(ss.steps[s].status==='done'?'ok':'off',s);}).join(''):sxPill('off','None recorded'))+
   sxRow('Tour','Whether the guided tour has been taken or skipped.',tour?sxPill('ok',(sxv('tour_completed_at')?'Taken ':'Skipped ')+sxWhen(tour)):sxPill('off','Not taken'))+
   sxRow('Settings version','Loom upgrades older settings once and records the version.',sxPill('off','schema '+sxv('settings_schema')))+
   '<div class="def" style="margin-top:12px">Loom data is kept in your Loom data folder; see Advanced.</div>';}

/* ---- the page ---- */
function sxBody(id){if(id==='general')return sxGeneral();if(id==='projects')return sxProjects();if(id==='terminal')return sxTerminal();if(id==='agents')return sxAgents();if(id==='slack')return sxSlackSection();if(id==='shortcut')return sxShortcut();if(id==='outbox')return sxOutbox();if(id==='ship')return sxShip();if(id==='orch')return sxOrch();if(id==='watchers')return sxWatchers();if(id==='helpers')return sxHelpers();if(id==='advanced')return sxAdvanced();return sxHelp();}
function renderSettings(){var el=$('#settings-body');
  if(!SET){el.innerHTML='<p class="meta">loading…</p>';sxLoadSettings();return;}
  sxPrefetch();
  if(SX.sec==='general')sxLoad('probe');if(SX.sec==='orch')sxLoad('prompt');if(SX.sec==='slack')sxLoad('dir');
  var old=$('#sxpane'),top=old?old.scrollTop:0;
  var sec=SX_SECS.filter(function(s){return s.id===SX.sec;})[0]||SX_SECS[0];SX.sec=sec.id;
  var restartKeys=Object.keys(SX.restart);
  var nav=SX_SECS.map(function(s){var st=sxStatus(s.id);return '<button type="button" data-sec="'+s.id+'" class="'+(s.id===sec.id?'on':'')+'">'+sxEsc(s.label)+'<i class="'+(st[0]==='ok'||st[0]==='warn'?st[0]:'')+'"></i></button>';}).join('');
  var st=sxStatus(sec.id);
  var head='<div class="sxhead"><div class="r1"><h2>'+sxEsc(sec.label)+'</h2>'+sxPill(st[0],st[1])+'</div><dl><dt>What it does</dt><dd>'+sxEsc(sec.what)+'</dd><dt>What it needs</dt><dd>'+sxEsc(sec.needs)+'</dd></dl></div>';
  var rn=restartKeys.length?sxNote('Restart Loom to apply: '+restartKeys.map(function(k){return '<code>'+sxEsc(k)+'</code>';}).join(' ')+'. Quit it from the menu bar and open it again.','warn'):'';
  el.innerHTML='<div class="sxwrap"><div class="sxnav" id="sxnav">'+nav+'</div><div class="sxpane" id="sxpane">'+head+rn+sxBody(sec.id)+'</div></div>';
  var pane=$('#sxpane');pane.scrollTop=top;
  el.onclick=sxClick;el.onchange=sxChange;}
function sxClick(e){var t=e.target;
  var nb=t.closest&&t.closest('[data-sec]');if(nb&&nb.parentNode&&nb.parentNode.id==='sxnav'){SX.sec=nb.dataset.sec;try{lsSet('loom.settingsSec',SX.sec);}catch(x){}SX.recMsg='';sxStopRec();renderSettings();var p=$('#sxpane');if(p)p.scrollTop=0;return;}
  var sg=t.closest&&t.closest('[data-sxseg]');if(sg&&!sg.disabled){sxSet(sg.dataset.sxseg,sg.dataset.v);return;}
  var b=t.closest&&t.closest('[data-act]');if(!b||b.disabled)return;sxAct(b.dataset.act,b.dataset.arg,b);}
function sxChange(e){var t=e.target;
  if(t.dataset.chsel){fetch('/api/slack/channel-projects',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({channel:t.dataset.chsel,project:t.value})}).then(function(r){return r.json();}).then(function(j){if(!j.ok)sxBad(sxErr(j));sxLoadSettings();});return;}
  if(t.dataset.pname){sxPost('/api/projects/update',{id:+t.dataset.pname,name:t.value}).then(function(j){if(!j.ok)sxBad(sxErr(j));else{sxProjRefresh();}});return;}
  if(t.dataset.ship){var f=t.dataset.f,v=t.type==='checkbox'?t.checked:t.value;var o={project_dir:t.dataset.ship};o[f]=v;sxPost('/api/ship/projects/update',o).then(function(j){if(!j.ok)sxBad(sxErr(j));sxLoad('ship',true);});return;}
  if(t.dataset.sxch){var k=t.dataset.sxch;if(t.value==='__custom'){SX.cust[k]=true;renderSettings();return;}SX.cust[k]=false;sxSet(k,t.value);return;}
  if(t.dataset.sx){var kk=t.dataset.sx,ty=t.dataset.t,val;
   if(ty==='bool')val=t.checked;else if(ty==='01')val=t.checked?'1':'0';else if(ty==='num'){if(t.value==='')return;val=Number(t.value);}else if(ty==='list')val=t.value.split(':').map(function(x){return x.trim();}).filter(function(x){return x;});else val=t.value;
   sxSet(kk,val);}}
function sxProjRefresh(){reloadProjects();sxLoadProjects();}
function sxSet(k,v){
  if(k.indexOf('perm_')===0&&v==='skip'&&sxv(k)!=='skip'){var who=k==='perm_chats'?'chats started from Loom':k==='perm_watchers'?'watcher workers':'the orchestrator';
   sxConfirm({title:'Skip permissions for '+who,body:'These sessions will run with <code>--dangerously-skip-permissions</code>. Claude can run any command and edit any file without asking you first. Turn this on only on a machine and in folders you trust.',typed:'skip permissions',ok:'Turn on skip permissions',danger:true}).then(function(y){if(y){var o={};o[k]=v;sxPut(o);}else renderSettings();});return;}
  var o2={};o2[k]=v;sxPut(o2);}
function sxConfirm(o){return new Promise(function(res){
  var host=document.createElement('div');host.className='sxmodal';
  host.innerHTML='<div class="sxdlg" role="dialog" aria-modal="true"><h3>'+sxEsc(o.title)+'</h3><div>'+o.body+'</div>'+(o.typed?'<div style="margin-top:12px"><label class="def" for="sx-typed">Type <b>'+sxEsc(o.typed)+'</b> to confirm</label><br><input type="text" id="sx-typed" autocomplete="off" style="width:100%;margin-top:4px"></div>':'')+'<div class="sxrow"><button type="button" class="sxbtn" id="sx-no">Cancel</button><button type="button" class="sxbtn'+(o.danger?' danger':' pri')+'" id="sx-yes"'+(o.typed?' disabled':'')+'>'+sxEsc(o.ok||'Confirm')+'</button></div></div>';
  $('#settings-section').appendChild(host);
  var done=function(v){document.removeEventListener('keydown',kd,true);host.remove();res(v);};
  var kd=function(ev){if(ev.key==='Escape'){ev.stopPropagation();done(false);}};document.addEventListener('keydown',kd,true);
  host.onclick=function(ev){if(ev.target===host)done(false);};
  $('#sx-no').onclick=function(){done(false);};
  $('#sx-yes').onclick=function(){done(true);};
  var ti=$('#sx-typed');if(ti){ti.oninput=function(){$('#sx-yes').disabled=ti.value.trim().toLowerCase()!==o.typed;};ti.focus();}else $('#sx-yes').focus();
 });}
function sxStopRec(){SX.rec=false;if(SX.recH){window.removeEventListener('keydown',SX.recH,true);SX.recH=null;}}
function sxStartRec(){SX.rec=true;SX.recMsg='';SX.recH=function(ev){ev.preventDefault();ev.stopImmediatePropagation();
  if(ev.key==='Escape'){sxStopRec();renderSettings();return;}
  if(['Meta','Control','Alt','Shift'].indexOf(ev.key)>=0)return;
  sxPost('/api/shortcut/check',{event:{key:ev.key,code:ev.code,metaKey:ev.metaKey,ctrlKey:ev.ctrlKey,altKey:ev.altKey,shiftKey:ev.shiftKey}}).then(function(j){
   if(!j.ok||!j.recorded){SX.recMsg='That key combination needs a modifier such as Command or Option.';SX.recKind='warn';renderSettings();return;}
   if(j.level==='refuse'){SX.recMsg=j.detail;SX.recKind='err';renderSettings();return;}
   sxStopRec();SX.recMsg=j.level==='warn'?j.detail:'';SX.recKind='warn';sxPut({slack_goto_hotkey:j.accelerator});});};
  window.addEventListener('keydown',SX.recH,true);}
function sxPollPractice(){clearTimeout(SX.pollT);sxJ('/api/shortcut/practice').then(function(j){if(!j.ok)return;SX.practice=j.practice;sxRerender();if(j.practice&&j.practice.state==='armed'&&tab==='settings'&&SX.sec==='shortcut')SX.pollT=setTimeout(sxPollPractice,1500);});}
function sxAct(a,arg,btn){
  if(a==='prm'){sxConfirm({title:'Remove this project',body:'Loom stops listing its chats. Files and sessions are not touched.',ok:'Remove'}).then(function(y){if(y)sxPost('/api/projects/remove',{id:+arg}).then(function(){sxProjRefresh();});});return;}
  if(a==='phide'){var p=(ALLP||[]).filter(function(x){return x.id===+arg;})[0];if(p)sxPost('/api/projects/update',{id:p.id,hidden:!p.hidden}).then(function(){sxProjRefresh();});return;}
  if(a==='padd'){var inp=$('#sx-newproj');var pick=(window.loomNative&&window.loomNative.pickFolder)?window.loomNative.pickFolder().then(function(pp){return pp?sxPost('/api/projects',{path:pp}):null;}):Promise.resolve(sxPost('/api/projects',{path:(inp&&inp.value||'').trim()}));pick.then(function(j){if(!j)return;if(!j.ok){var m=$('#sx-pmsg');if(m)m.textContent=sxErr(j);return;}sxProjRefresh();});return;}
  if(a==='snd'){var cur=sxv('notify_sound');var sel2=$('[data-sx="notify_sound"]');sxPost('/api/sound/preview',{name:sel2?sel2.value:cur}).then(function(j){if(!j.ok)sxBad(sxErr(j));});return;}
  if(a==='detect'){sxJ('/api/probe?fresh=1').then(function(j){SX.data.probe=j;var pth=j.ok&&j.probe.claude&&j.probe.claude.found?j.probe.claude.path:'';if(!pth){sxBad('Claude Code was not found on this machine');sxRerender(true);return;}sxPut({claude_bin:pth});});return;}
  if(a==='sdir'){btn.disabled=true;btn.textContent='Refreshing…';sxPost('/api/slack/directory/refresh',{}).then(function(j){if(!j.ok)sxBad(sxErr(j));else toast('Refreshed '+j.people+' people, '+j.channels+' channels, '+j.emoji+' emoji');sxLoad('dir',true);});return;}
  if(a==='sreauth'){SX.pwOpen=true;sxAct('smanifest');renderSettings();return;}
  if(a==='psave'){var ta=$('#sx-prompt');if(!ta)return;var pd=SX.data.prompt;var txt3=ta.value;if(pd&&txt3.trim()===pd['default'].trim())txt3='';sxJ('/api/orchestrator/prompt-override',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({text:txt3})}).then(function(j){if(!j.ok)sxBad(sxErr(j));else toast(j.active==='override'?'Prompt saved':'Using the default prompt');sxLoad('prompt',true);});return;}
  if(a==='preset'){sxJ('/api/orchestrator/prompt-override',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({text:''})}).then(function(j){if(!j.ok)sxBad(sxErr(j));else toast('Using the default prompt');sxLoad('prompt',true);});return;}
  if(a==='openlogs'){sxPost('/api/logs/open',{}).then(function(j){if(!j.ok)sxBad(sxErr(j));});return;}
  if(a==='axopen'){if(window.loomNative&&window.loomNative.openAccessibility)window.loomNative.openAccessibility();setTimeout(sxAx,1500);return;}
  if(a==='smode'){sxPost('/api/slack/mode',{mode:arg}).then(function(j){if(!j.ok)sxBad(sxErr(j));return sxLoadSettings();}).then(function(){DATA.slackMode=sxv('slack_mode');sxLoad('slack',true);});return;}
  if(a==='sconn'){var tk=$('#sx-tok');var tv=tk?tk.value.trim():'';if(!tv){sxBad('Paste the token first');return;}sxPost('/api/slack/token',{token:tv}).then(function(j){if(!j.ok){sxBad(sxErr(j));return;}SX.pwOpen=false;toast('Slack connected');sxLoadSettings().then(function(){DATA.slackMode=sxv('slack_mode');sxLoad('slack',true);});});return;}
  if(a==='sreplace'){SX.pwOpen=!SX.pwOpen;renderSettings();return;}
  if(a==='stest'){sxPost('/api/slack/test',{}).then(function(j){if(!j.ok)sxBad(sxErr(j));else toast('Slack token works: '+((j.identity&&j.identity.team)||'connected'));sxLoad('slack',true);});return;}
  if(a==='sdisc'){sxConfirm({title:'Disconnect Slack',body:'Loom deletes the token from the Keychain and turns Slack off. Sending from the Outbox, parked-thread polling and names stop until you connect again.',ok:'Disconnect',danger:true}).then(function(y){if(y)sxPost('/api/slack/disconnect',{}).then(function(j){if(!j.ok)sxBad(sxErr(j));return sxLoadSettings();}).then(function(){DATA.slackMode='off';sxLoad('slack',true);});});return;}
  if(a==='smanifest'){sxJ('/api/slack/manifest').then(function(j){if(!j.ok){sxBad(sxErr(j));return;}var txt=j.text||'';if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt).then(function(){toast('Manifest copied. Paste it at api.slack.com/apps (Create New App, From a manifest).');},function(){sxBad('Could not copy');});});return;}
  if(a==='chadd'){var ch=($('#sx-ch').value||'').trim(),pj=$('#sx-chp').value;if(!ch||!pj){var m2=$('#sx-chmsg');if(m2)m2.textContent='Enter a channel id and pick a project';return;}fetch('/api/slack/channel-projects',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({channel:ch,project:pj})}).then(function(r){return r.json();}).then(function(j){if(!j.ok){sxBad(sxErr(j));return;}sxLoadSettings();});return;}
  if(a==='chrm'){fetch('/api/slack/channel-projects',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({channel:arg,project:''})}).then(function(r){return r.json();}).then(function(j){if(!j.ok){sxBad(sxErr(j));return;}sxLoadSettings();});return;}
  if(a==='srec'){if(SX.rec){sxStopRec();}else sxStartRec();renderSettings();return;}
  if(a==='sreset'){sxStopRec();SX.recMsg='';sxPut({slack_goto_hotkey:'Command+Shift+L'});return;}
  if(a==='soff'){sxStopRec();SX.recMsg='';sxPut({slack_goto_hotkey:'off'});return;}
  if(a==='parm'){sxPost('/api/shortcut/practice',{action:'arm'}).then(function(j){if(j.ok){SX.practice=j.practice;renderSettings();sxPollPractice();}});return;}
  if(a==='pcancel'){sxPost('/api/shortcut/practice',{action:'cancel'}).then(function(j){if(j.ok){SX.practice=j.practice;renderSettings();}});return;}
  if(a==='shadd'){var sel=$('#sx-shipadd');if(!sel||!sel.value)return;sxPost('/api/ship/projects',{path:sel.value}).then(function(j){if(!j.ok){var m3=$('#sx-shmsg');if(m3)m3.textContent=sxErr(j);return;}sxLoad('ship',true);});return;}
  if(a==='shrm'){sxConfirm({title:'Take this repo off Ship',body:'The Ship button stops offering it. The repo itself is not touched.',ok:'Remove'}).then(function(y){if(y)sxPost('/api/ship/projects/remove',{project_dir:arg}).then(function(){sxLoad('ship',true);});});return;}
  if(a==='gowatch'){tab='watch';stateFilter='all';onlyGroup=null;syncControls();liveToggle();chips();render();return;}
  if(a==='hcmds'){SX.cmds=!SX.cmds;renderSettings();return;}
  if(a==='hinst'||a==='hupd'){var pv=SX.data.plugin;var run=function(){btn.disabled=true;btn.textContent=a==='hinst'?'Installing…':'Updating…';sxPost('/api/plugin/'+(a==='hinst'?'install':'update'),{}).then(function(j){if(!j.ok)sxBad(sxErr(j));else toast(a==='hinst'?'Helpers installed':'Helpers updated');sxLoad('plugin',true);});};
   if(a==='hinst'&&pv&&pv.preview){sxConfirm({title:'Install the Loom helpers',body:'Loom adds a local plugin to Claude Code by running:<pre class="sxpre">'+sxEsc((pv.preview.install||[]).map(function(c){return c.display;}).join(String.fromCharCode(10)))+'</pre>It does not edit your settings.json. Remove undoes it.',ok:'Install'}).then(function(y){if(y)run();});}else run();return;}
  if(a==='hrm'){var pr=SX.data.plugin;sxConfirm({title:'Remove the Loom helpers',body:'Loom runs:<pre class="sxpre">'+sxEsc(((pr&&pr.preview&&pr.preview.remove)||[]).map(function(c){return c.display;}).join(String.fromCharCode(10)))+'</pre>Chats stop recording drafts, thread ownership and ship labels until you install them again.',ok:'Remove',danger:true}).then(function(y){if(y)sxPost('/api/plugin/remove',{}).then(function(j){if(!j.ok)sxBad(sxErr(j));sxLoad('plugin',true);});});return;}
  if(a==='tour'){if(typeof startTour==='function')startTour();else window.dispatchEvent(new CustomEvent('loom:start-tour'));return;}
  if(a==='setup'){if(typeof openWizard==='function')openWizard();else window.dispatchEvent(new CustomEvent('loom:open-wizard'));return;}
  if(a==='copydiag'){var snap={},ks=Object.keys(SET.settings);ks.forEach(function(k){var s=SET.settings[k];if(k==='slack_identity'||k==='slack_scopes_granted'||k==='channel_projects')return;snap[k]=s.value;});
   var txt2=JSON.stringify({settings:snap,chats:DATA.chats.length,projects:(ALLP||[]).length,slackMode:DATA.slackMode,codexVisible:!!DATA.codexVisible,archiveSearch:!!DATA.archiveSearch,helpers:SX.data.plugin?SX.data.plugin.status:null,page:location.origin},null,2);
   if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(txt2).then(function(){toast('Support info copied');},function(){sxBad('Could not copy');});return;}
}
`.split('__SX_KEYMAP__').join(KEYMAP_JSON);
