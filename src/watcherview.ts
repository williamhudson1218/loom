// The Watchers tab and its editor (§9.3, mock frame C): a list on the left and one
// editor on the right (1 Source, 2 Trigger, 3 Action, 4 Run mode, 5 Safety, Test,
// "Would have fired (Shadow)" with Mark reviewed, Recent fires), with the master
// switch, brief prune days and ignore-my-own-posts at the top.
// Plain browser CSS/HTML/JS in strings, spliced verbatim by dashboard.ts like orchview.ts.
// String.raw so nothing here needs double escaping; it must never contain a dollar-brace,
// a backtick or a backslash, and the page JS uses no regex literals (dashboard.ts splices
// some page script into a non-raw template).
//
// The editor keeps one draft object. A text field is copied into the draft only when
// the person types in it, so a brief that is loaded and saved untouched is sent back
// exactly as the server gave it (a textarea would otherwise fold CRLF to LF).
// Every write is a plain fetch(); clientfetch.ts puts the launch token on it.

import { TRIGGERS } from './watchers/model.ts';

const TRIGGER_JSON = JSON.stringify(
  Object.fromEntries(Object.entries(TRIGGERS).map(([src, ts]) => [src, Object.entries(ts).map(([kind, t]) => ({ kind, label: t.label, defaults: t.defaults }))])),
)
  .split('<')
  .join('');

export const WATCHER_VIEW_CSS = String.raw`
  #watch-section { --wv-card:#161a24; --wv-line:#232634; --wv-ctl:#1b1f2a; --wv-ctl-line:#2b3040; --wv-text:#e6e6e6; --wv-text2:#c4ccdc; --wv-muted:#8b93a7; --wv-on:#26304a; --wv-accent:#6ea2ff; --wv-amber:#e8b04a; --wv-green:#56d364; --wv-red:#ee7b7b; }
  #watch-section .wvtop { margin-top:14px; border:1px solid var(--wv-line); border-radius:12px; background:var(--wv-card); padding:4px 16px; }
  #watch-section .wvset { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:14px; align-items:center; padding:9px 0; border-bottom:1px solid var(--wv-line); }
  #watch-section .wvset:last-child { border-bottom:0; }
  #watch-section .wvset b { font-size:13px; font-weight:600; color:var(--wv-text); }
  #watch-section .wvset .h { display:block; color:var(--wv-muted); font-size:12px; margin-top:1px; }
  #watch-section .wvset .ctl { display:flex; gap:8px; align-items:center; }
  #watch-section .wvnote { margin:12px 0 0; padding:9px 12px; border:1px solid #5a4a22; background:rgba(232,176,74,.1); color:#e8c98a; border-radius:8px; font-size:12.5px; }
  #watch-section .wvnote.err { border-color:#6a2d2d; background:rgba(238,123,123,.1); color:#f0a4a4; }
  #watch-section .wvwrap { display:grid; grid-template-columns:290px minmax(0,1fr); gap:16px; margin-top:14px; align-items:start; }
  @media (max-width:900px) { #watch-section .wvwrap { grid-template-columns:minmax(0,1fr); } }
  #watch-section .wvgrp { margin:0 0 6px; font-size:11.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; color:var(--wv-muted); }
  #watch-section .wvli { display:block; width:100%; text-align:left; border:1px solid var(--wv-line); background:var(--wv-card); color:var(--wv-text); border-radius:9px; padding:8px 10px; margin-bottom:6px; cursor:pointer; font:inherit; }
  #watch-section .wvli:hover { border-color:#34406a; }
  #watch-section .wvli.sel { background:var(--wv-on); border-color:#34406a; }
  #watch-section .wvli b { display:block; font-size:13px; font-weight:600; margin-bottom:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #watch-section .wvli .pl { display:flex; gap:5px; flex-wrap:wrap; }
  #watch-section .wvpill { display:inline-flex; align-items:center; height:18px; padding:0 8px; border-radius:9px; font-size:11px; font-weight:600; background:#23262f; color:#9aa3b2; white-space:nowrap; }
  #watch-section .wvpill.ok { background:rgba(86,211,100,.14); color:#7ee08a; }
  #watch-section .wvpill.warn { background:rgba(232,176,74,.16); color:#e8b04a; }
  #watch-section .wvpill.err { background:rgba(238,123,123,.16); color:#f0908f; }
  #watch-section .wvpill.rev { background:rgba(110,162,255,.16); color:#8db6ff; }
  #watch-section .wvcard { border:1px solid var(--wv-line); background:var(--wv-card); border-radius:10px; padding:12px 14px; margin-bottom:12px; }
  #watch-section .wvcard h4 { margin:0 0 8px; font-size:13px; color:var(--wv-text); font-weight:600; }
  #watch-section .wvrow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  #watch-section .wvg2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; }
  #watch-section .wvfld { margin-bottom:10px; min-width:0; }
  #watch-section .wvfld label { display:block; font-size:12px; font-weight:600; color:var(--wv-text2); margin-bottom:3px; }
  #watch-section .wvfld .h { display:block; font-size:11.5px; color:var(--wv-muted); margin-top:3px; }
  #watch-section .wvdef { font-size:12px; color:var(--wv-muted); }
  #watch-section input[type=text], #watch-section input[type=number], #watch-section select, #watch-section textarea { box-sizing:border-box; width:100%; background:var(--wv-ctl); color:var(--wv-text); border:1px solid var(--wv-ctl-line); border-radius:7px; padding:6px 9px; font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif; }
  #watch-section textarea { font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; resize:vertical; }
  #watch-section input.wvname { font-weight:600; flex:1; min-width:180px; width:auto; }
  #watch-section input.wvnum { width:90px; }
  #watch-section input.wvtime { width:90px; }
  #watch-section .wvpickl { max-height:200px; overflow:auto; border:1px solid var(--wv-ctl-line); border-radius:7px; margin-top:6px; background:var(--wv-ctl); }
  #watch-section .wvpi { display:block; width:100%; text-align:left; font:inherit; font-size:12.5px; padding:6px 10px; border:0; border-bottom:1px solid var(--wv-line); background:transparent; color:var(--wv-text2); cursor:pointer; }
  #watch-section .wvpi:hover, #watch-section .wvpi.sel { background:var(--wv-on); }
  #watch-section .wvpi.sel { color:#fff; }
  #watch-section .wvpi b { font-weight:600; }
  #watch-section .wvpi .d { display:block; font-size:11.5px; color:var(--wv-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #watch-section .wvbtn { font:inherit; font-size:12.5px; padding:5px 12px; border:1px solid var(--wv-ctl-line); border-radius:7px; background:var(--wv-ctl); color:var(--wv-text2); cursor:pointer; white-space:nowrap; }
  #watch-section .wvbtn:hover:not(:disabled) { border-color:#4d5b80; color:#fff; }
  #watch-section .wvbtn:disabled { opacity:.5; cursor:default; }
  #watch-section .wvbtn.pri { background:#2b4a8a; border-color:#3a5fae; color:#fff; }
  #watch-section .wvbtn.danger { color:#f0908f; border-color:#5a2d2d; }
  #watch-section .wvbtn.sm { padding:3px 9px; font-size:12px; }
  #watch-section .wvseg { display:inline-flex; border:1px solid var(--wv-ctl-line); border-radius:8px; overflow:hidden; }
  #watch-section .wvseg button { font:inherit; font-size:12.5px; padding:5px 14px; border:0; border-right:1px solid var(--wv-ctl-line); background:var(--wv-ctl); color:var(--wv-muted); cursor:pointer; }
  #watch-section .wvseg button:last-child { border-right:0; }
  #watch-section .wvseg button.on { background:var(--wv-on); color:#fff; }
  #watch-section .wvtog { display:inline-flex; align-items:center; gap:7px; cursor:pointer; font-size:12.5px; color:var(--wv-text2); }
  #watch-section .wvchips { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:4px; }
  #watch-section .wvchip { font:11.5px ui-monospace,Menlo,monospace; padding:2px 7px; border-radius:6px; background:var(--wv-ctl); border:1px solid var(--wv-ctl-line); color:var(--wv-text2); cursor:pointer; }
  #watch-section .wvchip:hover { border-color:#4d5b80; color:#fff; }
  #watch-section table.wvt { width:100%; border-collapse:collapse; font-size:12.5px; }
  #watch-section table.wvt th { text-align:left; color:var(--wv-muted); font-weight:600; font-size:11.5px; padding:4px 8px; border-bottom:1px solid var(--wv-line); }
  #watch-section table.wvt td { padding:6px 8px; border-bottom:1px solid var(--wv-line); color:var(--wv-text2); vertical-align:top; }
  #watch-section table.wvt a { color:var(--wv-accent); text-decoration:none; }
  #watch-section .wvmsg { font-size:12.5px; color:var(--wv-muted); }
  #watch-section .wvmsg.err { color:var(--wv-red); }
  #watch-section .wvmsg.ok { color:#7ee08a; }
  #watch-section .wvempty { padding:18px 6px; color:var(--wv-muted); font-size:13px; }
  #watch-section .wvdirty { color:var(--wv-amber); font-size:12px; font-weight:600; }
  #watch-section .wvstand { display:flex; gap:7px; align-items:center; min-width:0; margin:0 0 5px; padding:4px 7px; border:1px solid var(--wv-line); border-radius:7px; background:var(--wv-ctl); cursor:pointer; font-size:12px; color:var(--wv-text2); }
  #watch-section .wvstand:hover { border-color:#4d5b80; }
  #watch-section .wvstand.turn { border-color:#3a5fae; background:rgba(110,162,255,.1); }
  #watch-section .wvstand .sdot { margin-top:0; }
  #watch-section .wvstand .t { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #watch-section .wvstand .wvstl { color:var(--wv-muted); font-size:11.5px; white-space:nowrap; }
  #watch-section .wvstand.turn .wvstl { color:#8db6ff; font-weight:600; }
  #watch-section .wvstand.cur { border-color:#4d5b80; }
  #watch-section #wv-stand { margin-bottom:8px; }
  #watch-section .wvli .l1 { display:flex; gap:7px; align-items:center; min-width:0; margin-bottom:2px; }
  #watch-section .wvli .l1 b { flex:1; min-width:0; margin:0; }
  #watch-section .wvli .l1 .sdot { margin-top:0; flex:0 0 8px; width:8px; }
  #watch-section .wvon { flex:none; width:8px; height:8px; border-radius:50%; background:#4a5060; }
  #watch-section .wvon.y { background:var(--wv-green); }
  #watch-section .wvli .sub { display:block; font-size:12px; color:var(--wv-muted); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin:0 0 6px 15px; }
  #watch-section .wvli .pl { margin-left:15px; align-items:center; }
  #watch-section .wvago { font-size:11.5px; color:var(--wv-muted); white-space:nowrap; }
  #watch-section .wvgrp.sub2 { margin:14px 0 6px; }
  #watch-section .wvfold { display:flex; align-items:center; gap:6px; width:100%; margin:10px 0 0; padding:4px 0; border:0; background:transparent; color:var(--wv-muted); font:inherit; font-size:12.5px; cursor:pointer; text-align:left; }
  #watch-section .wvfold:hover { color:var(--wv-text); }
  #watch-section .wvfold .car { display:inline-block; width:10px; transition:transform .12s; }
  #watch-section .wvfold.open .car { transform:rotate(90deg); }
  #watch-section .wvfold.grp { margin:20px 0 6px; font-size:11.5px; font-weight:700; letter-spacing:.07em; text-transform:uppercase; }
  #watch-section .wvhead2 { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:8px; }
  #watch-section .wvhead2 .sp { flex:1; }
  #watch-section .wvtabs { display:flex; gap:2px; margin:0 0 12px; border-bottom:1px solid var(--wv-line); }
  #watch-section .wvtab { font:inherit; font-size:13px; padding:7px 14px; border:0; border-bottom:2px solid transparent; margin-bottom:-1px; background:transparent; color:var(--wv-muted); cursor:pointer; display:inline-flex; gap:7px; align-items:center; }
  #watch-section .wvtab:hover { color:var(--wv-text); }
  #watch-section .wvtab.on { color:#fff; border-bottom-color:var(--wv-accent); }
  #watch-section .wvtab .sdot { margin-top:0; }
  #watch-section .wvtab .n { font-size:11px; padding:0 6px; border-radius:8px; background:rgba(110,162,255,.16); color:#8db6ff; }
  #watch-section .wvli.off { opacity:.55; }
  #watch-section .wvli .l1 .wvpill { height:16px; font-size:10.5px; padding:0 6px; }
  #watch-section .sdot.d-none { background:transparent; border:1px solid #4a5060; box-sizing:border-box; }
  #watch-section .wvli .sub.l2 { margin-top:-3px; }
  #watch-section .wvli .sub .rev, #watch-section .wvli .sub .turn { color:#8db6ff; font-weight:600; }
  #watch-section .wvli .sub .err { color:var(--wv-red); }
  #watch-section .wvhd .wvtitle { font-size:15px; font-weight:600; color:var(--wv-text); max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #watch-section .wvrow .sp { flex:1; }
  #watch-section .wvsubline { margin-top:6px; font-size:12.5px; color:var(--wv-muted); }
  #watch-section .wvmorewrap { position:relative; }
  #watch-section .wvmenu { position:absolute; right:0; top:100%; margin-top:4px; z-index:4; display:flex; flex-direction:column; gap:4px; min-width:140px; padding:6px; border:1px solid var(--wv-ctl-line); border-radius:8px; background:var(--wv-card); box-shadow:0 6px 18px rgba(0,0,0,.4); }
  #watch-section .wvmenu .wvbtn { text-align:left; }
  #watch-section .wvsech { display:flex; gap:12px; align-items:center; min-width:0; }
  #watch-section .wvsech h4 { margin:0; flex:none; width:64px; }
  #watch-section .wvsum { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; color:var(--wv-text2); }
  #watch-section .wvsec.open .wvsech { margin-bottom:10px; }
  #watch-section .wvmeta { color:var(--wv-muted); font-size:11.5px; white-space:nowrap; }
  #watch-section .wvtabs .mtab .n { margin-left:6px; font-size:11px; padding:0 6px; border-radius:8px; background:rgba(110,162,255,.16); color:#8db6ff; }
  #watch-section #wv-msgs { height:calc(100vh - 310px); min-height:320px; overflow-y:auto; display:flex; flex-direction:column; gap:9px; padding:2px 2px 16px; }
  #watch-section #wv-msgs .msg { max-width:100%; align-self:stretch; box-sizing:border-box; flex:none; }
  #watch-section #wv-txmsg { margin-bottom:8px; }
  #watch-section .wvgrp.needs { color:#8db6ff; margin:2px 0 6px; }
  #watch-section .wvsp { padding:6px 2px; border-bottom:1px solid var(--wv-line); font-size:12px; }
  #watch-section .wvsp1 { display:flex; gap:6px; align-items:center; min-width:0; }
  #watch-section .wvsp1 .wvago { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  #watch-section .wvsp2 { color:var(--wv-text2); margin-top:3px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  #watch-section .wvsp2 a { color:var(--wv-accent); text-decoration:none; }
  #watch-section #wvroot.wvfit { display:flex; flex-direction:column; box-sizing:border-box; overflow:hidden; }
  #watch-section #wvroot.wvfit .wvtop, #watch-section #wvroot.wvfit #wvnote { flex:none; }
  #watch-section #wvroot.wvfit .wvwrap { flex:1 1 auto; min-height:0; grid-template-rows:minmax(0,1fr); align-items:stretch; }
  #watch-section #wvroot.wvfit #wvleft { min-height:0; overflow-y:auto; padding-right:2px; }
  #watch-section #wvroot.wvfit #wvright { min-height:0; display:flex; flex-direction:column; overflow:hidden; }
  #watch-section #wvroot.wvfit #wvright > * { flex:none; }
  #watch-section #wvroot.wvfit #wv-testcard { max-height:40%; overflow-y:auto; }
  #watch-section #wvroot.wvfit #wvright > [id^=wv-pane-] { flex:1 1 auto; min-height:0; overflow-y:auto; }
  #watch-section #wvroot.wvfit #wv-pane-terminal, #watch-section #wvroot.wvfit #wv-pane-transcript { display:flex; flex-direction:column; overflow:hidden; }
  #watch-section #wvroot.wvfit #wv-termhost { flex:1 1 auto; height:auto; min-height:0; box-sizing:border-box; }
  #watch-section #wvroot.wvfit #wv-msgs { flex:1 1 auto; height:auto; min-height:0; }
  #watch-section #wv-termhost { height:calc(100vh - 290px); min-height:340px; padding:6px 0 0 8px; border-radius:10px; border:1px solid #232634; background:#07080c; overflow:hidden; }
  #watch-section #wv-termmsg { padding:28px 16px; text-align:center; color:var(--wv-muted); font-size:13px; border:1px dashed var(--wv-line); border-radius:10px; }
`;

export const WATCHER_VIEW_HTML = String.raw`

`;

export const WATCHER_VIEW_JS = String.raw`
var WV_TRIGGERS=__WV_TRIGGERS__;
var WV_SRC=[['slack','Slack channel'],['chats','Chats'],['prs','Pull requests'],['work','Findings endpoint']];
var WV_ACT=[['start_chat','Start a chat with a brief'],['message_chat','Send a message into the matching chat'],['notify','Notify me (Mac notification)'],['tell_orch','Tell the orchestrator']];
var WV_CHIPS={slack:['WATCHER','TITLE','URL','TEXT','AUTHOR','CHANNEL'],chats:['WATCHER','CHAT_TITLE','PROJECT','PANE','IDLE_MIN','PERCENT'],prs:['WATCHER','TITLE','PR','PR_TITLE','URL','CHECK'],work:['WATCHER','TITLE','RULE','TICKET','SUBJECT','DETAIL','CLEAR','BATCH_FILE','COUNT']};
var WV_LABELS={bot_ids:['Bot ids','Comma separated Slack bot ids (B...).'],user_ids:['User ids','Comma separated Slack user ids (U...).'],needle:['Phrase','Slack bot posts match the exact text; people posts ignore case.'],repos:['Repos','Comma separated owner/name. Empty means any repo.'],exclude_user_ids:['Ignore these user ids','Comma separated. Your own id is always ignored when "Ignore my own posts" is on.'],any_author:['Include posts by bots','Off means people only.'],min:['Minutes',''],min_sec:['Seconds waiting',''],max_h:['Ignore after (hours)','Chats waiting longer than this are old news.'],fraction:['Fraction of context used','0.85 means 85 percent.']};
var WV={built:false,sel:'',draft:null,orig:null,dirty:false,tpls:[],have:{},chan:{},projects:[],lanes:[],cfg:{},test:null,testing:false,shadow:[],fires:[],msg:'',msgErr:false,skipOk:false,confirmDel:false,editorFor:'__none__',loaded:false,link:'',linkMsg:'',firesShown:20,inv:{},invQ:'',chipTarget:'wv-brief',pane:'',termSid:'',termHost:null,optsOpen:false,addOpen:false,spawnsOpen:false,open:{},moreOpen:false};

/* ---- pure helpers (no DOM; the unit tests run these) ---- */
function wvClone(o){return JSON.parse(JSON.stringify(o));}
function wvNl(){return String.fromCharCode(10);}
function wvEol(orig,val){var crlf=String.fromCharCode(13)+wvNl();if(String(orig).indexOf(crlf)>=0&&String(orig).split(crlf).join('').indexOf(wvNl())<0)return String(val).split(wvNl()).join(crlf);return val;}
function wvList(s){return String(s).split(wvNl()).join(',').split(',').map(function(x){return x.trim();}).filter(function(x){return x;});}
function wvListText(a){return (a||[]).join(', ');}
function wvDraftOf(w){return {label:w.label,enabled:!!w.enabled,run_mode:w.run_mode==='live'?'live':'shadow',source:wvClone(w.source),trigger:{kind:w.trigger.kind,params:wvClone(w.trigger.params||{})},action:wvClone(w.action),max_per_hour:w.max_per_hour,cooldown_min:w.cooldown_min,quiet_start:w.quiet_start||'',quiet_end:w.quiet_end||'',template_id:w.template_id||''};}
function wvPayload(d){return wvClone(d);}
function wvBlank(){return {label:'New watcher',enabled:false,run_mode:'shadow',source:{kind:'slack',params:{channel:'',workspace:''}},trigger:{kind:'phrase',params:{needle:'',any_author:false}},action:{kind:'notify',params:{template:'{{TITLE}}'}},max_per_hour:6,cooldown_min:60,quiet_start:'',quiet_end:'',template_id:''};}
function wvWatches(w){var p=w.source.params||{};var k=w.source.kind;if(k==='slack'){var n=p.channel&&WV.chan[p.channel];return (n?'#'+String(n).split('#').join(''):(p.channel||'no channel chosen'))+' - '+(w.trigger.label||w.trigger.kind);}if(k==='chats'){var pr=(p.projects||[]);return (pr.length?'chats in '+pr.join(', '):'your chats')+' - '+(w.trigger.label||w.trigger.kind);}if(k==='work'){return (p.url?String(p.url).replace('https://','').replace('http://',''):'no endpoint set')+' - '+(w.trigger.label||w.trigger.kind);}var r=(p.repos||[]);return (r.length?r.join(', '):'your pull requests')+' - '+(w.trigger.label||w.trigger.kind);}
function wvTrigs(src){return WV_TRIGGERS[src]||[];}
function wvTrigDef(src,kind){var l=wvTrigs(src);for(var i=0;i<l.length;i++)if(l[i].kind===kind)return l[i];return l[0];}
function wvSetSource(d,src){var srcDefaults={slack:{channel:'',workspace:''},chats:{projects:[],tags:[]},prs:{repos:[],mine_only:true},work:{url:'',sweep_first:false}};d.source={kind:src,params:srcDefaults[src]};var t=wvTrigs(src)[0];d.trigger={kind:t.kind,params:wvClone(t.defaults)};}
function wvSetTrigger(d,kind){var t=wvTrigDef(d.source.kind,kind);d.trigger={kind:t.kind,params:wvClone(t.defaults)};}
function wvSetAction(d,kind){var old=d.action.params||{};var tmpl=old.template!=null?old.template:(old.brief_template||'');if(kind==='start_chat')d.action={kind:kind,params:{project_dir:old.project_dir||'',target:old.target||'managed',brief_template:old.brief_template!=null?old.brief_template:tmpl,perm:old.perm||'inherit',standing:old.standing===true}};else d.action={kind:kind,params:{template:old.template!=null?old.template:tmpl}};wvCarryInvoke(d,old);}
function wvCarryInvoke(d,old){var ap=d.action.params;if((d.action.kind==='start_chat'||d.action.kind==='message_chat')&&old.invoke){ap.invoke=wvClone(old.invoke);ap.notes=old.notes||'';}}
function wvInvMode(ap){return ap.invoke&&ap.invoke.kind?ap.invoke.kind:'brief';}
function wvSetInvMode(ap,mode){if(mode==='brief'){delete ap.invoke;return;}var cur=ap.invoke||{};ap.invoke={kind:mode,name:cur.kind===mode?cur.name:'',args:cur.args||''};if(ap.notes==null)ap.notes='';}
function wvInvKey(d){return d.action.kind==='start_chat'?(d.action.params.project_dir||''):'';}
function wvInvShort(t){t=String(t||'');return t.length>140?t.slice(0,137)+'...':t;}
function wvInvMatch(list,kind,q){var n=String(q||'').trim().toLowerCase();return list.filter(function(i){return i.kind===kind&&(!n||i.name.toLowerCase().indexOf(n)>=0||String(i.description||'').toLowerCase().indexOf(n)>=0);});}
function wvActionText(d){return d.action.kind==='start_chat'?d.action.params.brief_template:d.action.params.template;}
function wvNeedsSkipConfirm(d,orig){return d.action.kind==='start_chat'&&d.action.params.perm==='skip'&&!(orig&&orig.action.kind==='start_chat'&&orig.action.params.perm==='skip');}
function wvActLabel(kind){for(var i=0;i<WV_ACT.length;i++)if(WV_ACT[i][0]===kind)return WV_ACT[i][1];return kind;}
function wvResultPill(e){var m={held_quiet:['warn','Held: quiet hours'],held_cap:['warn','Held: hourly cap'],held_cooldown:['warn','Held: cooldown'],held_capacity:['warn','Held: no free window']};if(m[e.decision])return m[e.decision];var r={started:['ok','Started'],sent:['ok','Sent'],notified:['ok','Notified'],told:['ok','Told orchestrator'],queued:['warn','Queued'],failed:['err','Failed']};if(r[e.result])return r[e.result];return e.decision==='would_fire'?['rev','Would fire']:['',e.decision];}
function wvAgo(ms,now){if(!ms)return '';var s=Math.max(0,Math.round((now-ms)/1000));if(s<60)return 'just now';var m=Math.round(s/60);if(m<60)return m+' min ago';var h=Math.round(m/60);if(h<48)return h+' h ago';return Math.round(h/24)+' d ago';}
function wvPollText(w,now){if(!w.enabled)return 'Off';if(!w.last_poll_at)return 'Not polled yet';return 'Polled '+wvAgo(w.last_poll_at,now);}
function wvEvery(ms){if(!ms)return '';if(ms<60000)return 'every '+Math.round(ms/1000)+' s';return 'every '+Math.round(ms/60000)+' min';}
var WV_SRCNAME={slack:'Slack',chats:'Chats',prs:'Pull requests',work:'Findings endpoint'};
/* The list row's first muted line: "<source kind> · every N min · polled X ago". */
function wvRowLine1(w,now){var p=[WV_SRCNAME[w.source.kind]||w.source.kind];var e=wvEvery(w.poll_every_ms);if(e)p.push(e);p.push(w.enabled?wvPollText(w,now).toLowerCase():'not polling');return p.join(' · ');}
/* The second line, only when something wants attention: [class, text] parts. */
/* A watcher needs you when its standing chat is on your turn, or (while it is on) it has Shadow matches to
   review or its last poll failed. The same rule as src/watchers/attention.ts needReasons, which the tray and
   the notification use. */
function wvNeeds(w,dot){var o=[];if(dot==='d-turn')o.push('turn');if(w.enabled&&w.shadow_unreviewed>0)o.push('review');if(w.enabled&&w.last_error)o.push('error');return o;}
function wvNeedWords(w,reasons){return reasons.map(function(r){return r==='turn'?'your turn':r==='review'?w.shadow_unreviewed+(w.shadow_unreviewed===1?' match':' matches')+' to review':'poll error';});}
function wvDotOf(id){var st=wvStandingOf(id);return st.length&&typeof dotCls==='function'?dotCls(st[0].chat):'';}
/* The Watchers tab badge: watchers that need you; amber when every one of them is only a poll error. */
function wvBadge(){var n=0,onlyErr=true;(WATCH.watchers||[]).forEach(function(w){var r=wvNeeds(w,wvDotOf(w.id));if(!r.length)return;n++;if(r.length!==1||r[0]!=='error')onlyErr=false;});return {n:n,amber:n>0&&onlyErr};}
/* The row's second line: why it needs you, then skip permissions. */
function wvRowLine2(w,dot){var o=[];var r=wvNeeds(w,dot);wvNeedWords(w,r).forEach(function(t,i){o.push([r[i]==='error'?'err':r[i]==='turn'?'turn':'rev',r[i]==='turn'?'Chat waiting on you':r[i]==='error'?'Poll error':t]);});if(w.skip_permissions)o.push(['err','Skip permissions']);return o;}
/* The header's muted line: what the action does, e.g. "Standing chat · lane main · /triage". */
function wvActionLine(d,projects){var a=d.action,p=a.params||{};var inv=p.invoke&&p.invoke.name?'/'+p.invoke.name:'';var o=[];
  if(a.kind==='start_chat'){o.push(p.standing===true?'Standing chat':'New chat per match');var nm='';(projects||[]).forEach(function(x){if(x.path===p.project_dir)nm=x.name;});if(p.project_dir)o.push(nm||p.project_dir);o.push(p.target&&p.target!=='managed'?'lane '+String(p.target).slice(5):'new managed window');o.push(inv||'brief');}
  else if(a.kind==='message_chat'){o.push('Messages the matching chat');o.push(inv||'message');}
  else if(a.kind==='notify')o.push('Mac notification');
  else o.push('Tells the orchestrator');
  return o.join(' · ');}
/* One-line summaries for the collapsed Settings cards. */
function wvSourceSum(d){var p=d.source.params||{};var k=d.source.kind;if(k==='slack'){var n=p.channel&&WV.chan[p.channel];return (n?'#'+String(n).split('#').join(''):(p.channel||'No channel chosen'))+(p.workspace?' in '+p.workspace:'');}if(k==='chats'){return ((p.projects||[]).length?'Chats in '+p.projects.join(', '):'All chats')+((p.tags||[]).length?', tagged '+p.tags.join(' or '):'');}if(k==='work')return p.url||'No endpoint set';return ((p.repos||[]).length?p.repos.join(', '):'Any repo')+(p.mine_only===false?', any author':', mine only');}
function wvTriggerSum(d){var t=wvTrigDef(d.source.kind,d.trigger.kind);var o=[t?t.label:d.trigger.kind];var tp=d.trigger.params||{};Object.keys(tp).forEach(function(k){var v=tp[k];var lab=(WV_LABELS[k]||[k])[0];if(Array.isArray(v)){if(v.length)o.push(lab+': '+v.join(', '));}else if(typeof v==='boolean'){if(v)o.push(lab);}else if(v!==''&&v!=null)o.push(lab+': '+(typeof v==='string'?'"'+v+'"':v));});return o.join(' · ');}
function wvLimitsSum(d){var o=[d.max_per_hour?d.max_per_hour+' per hour':'No hourly cap',d.cooldown_min?d.cooldown_min+' min cooldown':'No cooldown'];o.push(d.quiet_start&&d.quiet_end?'quiet '+d.quiet_start+' to '+d.quiet_end:'no quiet hours');return o.join(' · ');}
/* The Chat tab's status line after the turn state: "pane blue-vanilla · last batch 20 min ago". */
function wvChatMeta(L,fires,now){var o=[];if(L&&(L.name||L.pane_id))o.push('pane '+(L.name||L.pane_id));var last=0;(fires||[]).forEach(function(e){if(!last&&(e.result==='started'||e.result==='sent'))last=e.detected_at;});if(last)o.push('last batch '+wvAgo(last,now));return o.join(' · ');}
/* Does this watcher keep a standing chat (so the editor gets a Chat tab)? */
function wvHasChat(w,standing){return !!(w&&((w.action&&w.action.kind==='start_chat'&&w.action.params&&w.action.params.standing===true)||(standing&&standing.length)));}
/* Which editor tab shows: a standing chat opens on Terminal (Transcript when it cannot have one, as on the Board). */
function wvPaneFor(cur,hasChat,canTerm){var chat=cur==='terminal'||cur==='transcript';if(chat&&!hasChat)return 'history';if(cur==='terminal'&&!canTerm)return 'transcript';if(cur)return cur;return hasChat?(canTerm?'terminal':'transcript'):'history';}
/* What the Chat tab shows: the chosen (else the current) standing chat's live pane, or a plain reason there is none. */
function wvTermPlan(list,sid,live,token){
  if(!list||!list.length)return {msg:'No chat is running for this watcher. Its standing chat starts on the next match it acts on.'};
  var s=list[0];for(var i=0;i<list.length;i++)if(list[i].chat.session_id===sid)s=list[i];
  var L=live&&live[s.chat.agent+':'+s.chat.session_id];var pane=L&&L.pane_id;
  if(!pane)return {chat:s,msg:'This chat has no live pane right now.'};
  if(!token)return {chat:s,msg:'The terminal needs the running Loom app. Use Open on Board instead.'};
  return {chat:s,pane:pane,key:'wv|'+pane};
}
function wvTimeText(ms,now){var d=new Date(ms),n=new Date(now),p=function(x){return (x<10?'0':'')+x;};var hm=p(d.getHours())+':'+p(d.getMinutes());if(d.toDateString()===n.toDateString())return hm;var y=new Date(now-86400000);if(d.toDateString()===y.toDateString())return 'Yesterday '+hm;var mo=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];return mo[d.getMonth()]+' '+d.getDate()+' '+hm;}

/* ---- tiny DOM builders ---- */
function wvEl(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function wvAdd(p){for(var i=1;i<arguments.length;i++)if(arguments[i])p.appendChild(arguments[i]);return p;}
function wvPost(path,body){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body||{})}).then(function(r){return r.json().catch(function(){return {ok:false,detail:'bad response'};});}).catch(function(e){return {ok:false,detail:String(e&&e.message||e)};});}
function wvGet(path){return fetch(path).then(function(r){return r.json();}).catch(function(){return null;});}
function wvBtn(text,cls,fn){var b=wvEl('button','wvbtn'+(cls?' '+cls:''),text);b.type='button';if(fn)b.onclick=fn;return b;}
function wvFld(label,ctl,help){var f=wvEl('div','wvfld');if(label)f.appendChild(wvEl('label','',label));f.appendChild(ctl);if(help)f.appendChild(wvEl('span','h',help));return f;}
function wvDirty(){WV.dirty=true;wvSync();}
function wvText(get,set,opts){opts=opts||{};var i=wvEl('input');i.type=opts.num?'number':'text';if(opts.cls)i.className=opts.cls;if(opts.ph)i.placeholder=opts.ph;if(opts.step)i.step=opts.step;if(opts.min!=null)i.min=opts.min;i.value=get();i.oninput=function(){set(i.value);wvDirty();};return i;}
function wvSel(options,cur,set,after){var s=wvEl('select');options.forEach(function(o){var op=wvEl('option','',o[1]);op.value=o[0];if(o[2])op.disabled=true;s.appendChild(op);});s.value=cur;if(s.value!==cur&&options.length)s.selectedIndex=-1;s.onchange=function(){set(s.value);wvDirty();if(after)after();};return s;}
function wvArea(get,set,rows,id){var t=wvEl('textarea');t.rows=rows;t.spellcheck=false;if(id)t.id=id;t.value=get();t.oninput=function(){set(wvEol(get(),t.value));wvDirty();};return t;}
function wvToggle(label,get,set){var l=wvEl('label','wvtog');var c=wvEl('input');c.type='checkbox';c.checked=!!get();c.onchange=function(){set(c.checked);wvDirty();};l.appendChild(c);l.appendChild(wvEl('span','',label));return l;}
function wvSeg(pairs,cur,set){var s=wvEl('div','wvseg');pairs.forEach(function(p){var b=wvEl('button',cur===p[0]?'on':'',p[1]);b.type='button';b.onclick=function(){set(p[0]);};s.appendChild(b);});return s;}

/* ---- loading ---- */
function wvById(id){var l=WATCH.watchers||[];for(var i=0;i<l.length;i++)if(l[i].id===id)return l[i];return null;}
function wvLoadStatic(){
  return Promise.all([wvGet('/api/watchers/templates'),wvGet('/api/slack/directory'),wvGet('/api/projects'),wvGet('/api/lanes?all=1'),wvGet('/api/settings')]).then(function(r){
    if(r[0]&&r[0].ok){WV.tpls=r[0].templates||[];WV.have=r[0].have||{};}
    if(r[1]&&r[1].channels)WV.chan=r[1].channels;
    if(r[2]&&r[2].projects)WV.projects=r[2].projects;
    if(Array.isArray(r[3]))WV.lanes=r[3].map(function(x){return x.lane;});
    if(r[4]&&r[4].settings)WV.cfg=r[4].settings;
    WV.loaded=true;
  });
}
function wvCfg(k,fallback){var s=WV.cfg[k];return s&&s.value!=null?s.value:fallback;}
function wvLoadEvents(){
  var id=WV.sel;if(!id||id==='new'){WV.shadow=[];WV.fires=[];wvDrawEvents();return Promise.resolve();}
  return Promise.all([wvGet('/api/watchers/events?id='+encodeURIComponent(id)+'&kind=shadow&limit=100'),wvGet('/api/watchers/events?id='+encodeURIComponent(id)+'&kind=fires&limit=200')]).then(function(r){
    if(WV.sel!==id)return;
    WV.shadow=(r[0]&&r[0].events)||[];WV.fires=(r[1]&&r[1].events)||[];wvDrawEvents();wvStandingSync();
  });
}

/* ---- the page ---- */
function wvBuild(){
  var s=document.getElementById('watch-section');s.textContent='';
  var top=wvEl('div','wvtop');top.id='wvtop';
  var note=wvEl('div');note.id='wvnote';
  var wrap=wvEl('div','wvwrap');
  var left=wvEl('div');left.id='wvleft';var list=wvEl('div');list.id='wvlist';var sp=wvEl('div');sp.id='wvspawns';wvAdd(left,list,sp);
  var right=wvEl('div');right.id='wvright';
  var root=wvEl('div');root.id='wvroot';wvAdd(wrap,left,right);wvAdd(root,top,note,wrap);s.appendChild(root);WV.built=true;
  window.addEventListener('resize',wvFit);
}
/* The tab fits the window: the page never scrolls; the list and the editor scroll inside (and the terminal,
   which fills what is left under the tabs, refits through openTerm's own ResizeObserver). Narrow windows,
   where the two columns stack, scroll as a page instead. */
function wvFit(){
  var r=document.getElementById('wvroot'),s=document.getElementById('watch-section');if(!r||!s||s.style.display==='none')return;
  if(window.innerWidth<=900){r.classList.remove('wvfit');r.style.height='';return;}
  r.classList.add('wvfit');var top=r.getBoundingClientRect().top+(window.scrollY||0);var pb=parseFloat(getComputedStyle(s).paddingBottom)||0;
  var h=Math.max(300,Math.floor(window.innerHeight-top-pb));if(r.style.height!==h+'px')r.style.height=h+'px';
}
function wvDrawTop(){
  var top=document.getElementById('wvtop');if(!top)return;top.textContent='';
  function setting(key,val){return wvPost('/api/settings',(function(){var o={};o[key]=val;return o;})()).then(function(j){if(j&&j.ok===false){WV.msg=j.detail||'could not save the setting';WV.msgErr=true;}return wvGet('/api/settings').then(function(r){if(r&&r.settings)WV.cfg=r.settings;wvDrawTop();wvDrawNote();});});}
  var on=wvCfg('watchers_enabled',false);
  function row(title,help,ctl){var r=wvEl('div','wvset');var a=wvEl('div');a.appendChild(wvEl('b','',title));a.appendChild(wvEl('span','h',help));var c=wvEl('div','ctl');c.appendChild(ctl);r.appendChild(a);r.appendChild(c);return r;}
  var tg=wvEl('label','wvtog');var cb=wvEl('input');cb.type='checkbox';cb.id='wv-master';cb.checked=!!on;cb.onchange=function(){setting('watchers_enabled',cb.checked);};tg.appendChild(cb);tg.appendChild(wvEl('span','',on?'On':'Off'));
  var mc=wvEl('div','wvrow');mc.appendChild(tg);var ob=wvBtn(WV.optsOpen?'Hide options':'Options','sm',function(){WV.optsOpen=!WV.optsOpen;wvDrawTop();});ob.id='wv-opts';mc.appendChild(ob);
  top.appendChild(row('Watchers','Master switch. Nothing below runs while it is off.',mc));
  if(!WV.optsOpen)return;
  var days=wvEl('input');days.type='number';days.min=0;days.className='wvnum';days.id='wv-prune';days.value=wvCfg('watcher_brief_prune_days',0);days.onchange=function(){setting('watcher_brief_prune_days',Number(days.value)||0);};
  var dw=wvEl('div','wvrow');dw.appendChild(days);dw.appendChild(wvEl('span','wvdef','days (0 keeps them)'));
  var ig=wvEl('label','wvtog');var ic=wvEl('input');ic.type='checkbox';ic.id='wv-ignore';ic.checked=wvCfg('watchers_ignore_self',true)!==false;ic.onchange=function(){setting('watchers_ignore_self',ic.checked);};ig.appendChild(ic);ig.appendChild(wvEl('span','',ic.checked?'On':'Off'));
  wvAdd(top,row('Prune per-match briefs after','Each match that starts a chat writes a brief to the watchers folder in your Loom data folder.',dw),row('Ignore my own posts','Excludes your Slack user id on every Slack watcher.',ig));
}
function wvDrawNote(){
  var n=document.getElementById('wvnote');if(!n)return;n.textContent='';n.className='';
  var parts=[];
  if(!wvCfg('watchers_enabled',false))parts.push('Watchers are switched off. Nothing runs until the master switch is on.');
  if(WATCH.dryRun)parts.push('Dry run (LOOM_WATCHERS_DRYRUN=1): matches are recorded in Shadow and nothing is started or sent.');
  if(!parts.length)return;
  n.className='wvnote';n.textContent=parts.join(' ');
}
function wvSelect(id){
  if(WV.dirty&&id!==WV.sel){WV.msg='Unsaved changes. Save or Discard them before opening another watcher.';WV.msgErr=true;wvSync();return;}
  if(id!==WV.sel){WV.pane='';WV.termSid='';WV.open={};WV.moreOpen=false;}
  WV.sel=id;WV.firesShown=20;WV.test=null;WV.msg='';WV.confirmDel=false;WV.skipOk=false;WV.dirty=false;WV.editorFor='__none__';
  if(id==='new'){WV.draft=wvBlank();WV.orig=null;}
  else{var w=wvById(id);WV.draft=w?wvDraftOf(w):null;WV.orig=w?wvDraftOf(w):null;}
  wvDrawList();wvDrawEditor();wvLoadEvents();
}
function wvDrawList(){
  var left=document.getElementById('wvlist');if(!left)return;left.textContent='';
  var ws=WATCH.watchers||[];var now=Date.now();
  var nb=wvBtn('+ New watcher','',function(){wvSelect('new');});nb.id='wv-new';nb.style.width='100%';nb.style.marginBottom='4px';left.appendChild(nb);
  if(!ws.length&&WV.sel!=='new')left.appendChild(wvEl('div','wvempty','No watchers yet. Add one, or start from a template.'));
  var need=ws.filter(function(w){return wvNeeds(w,wvDotOf(w.id)).length>0;});var rest=ws.filter(function(w){return need.indexOf(w)<0;});
  if(need.length){var nh=wvEl('div','wvgrp needs','Needs you · '+need.length);nh.id='wv-needs';left.appendChild(nh);need.forEach(wvRow);if(rest.length)left.appendChild(wvEl('div','wvgrp sub2','Watchers'));}
  rest.forEach(wvRow);
  // One compact row: the standing chat's status dot, label, Live/Shadow, On/Off; then one or two muted lines.
  function wvRow(w){
    var b=wvEl('button','wvli'+(w.id===WV.sel?' sel':'')+(w.enabled?'':' off'));b.type='button';b.setAttribute('data-wid',w.id);
    var st=wvStandingOf(w.id);var cls=st.length&&typeof dotCls==='function'?dotCls(st[0].chat):'';
    var l1=wvEl('span','l1');var sd=wvEl('span','sdot '+(cls||'d-none'));if(cls){sd.setAttribute('data-standing','1');sd.title='Standing chat: '+((typeof DOT_LABEL!=='undefined'&&DOT_LABEL[cls])||'running');}else sd.title='No standing chat';l1.appendChild(sd);
    l1.appendChild(wvEl('b','',w.label));
    l1.appendChild(wvEl('span','wvpill '+(w.run_mode==='shadow'?'warn':'ok'),w.run_mode==='shadow'?'Shadow':'Live'));
    l1.appendChild(wvEl('span','wvpill '+(w.enabled?'ok':''),w.enabled?'On':'Off'));
    b.appendChild(l1);
    b.appendChild(wvEl('span','sub',wvRowLine1(w,now)));
    var l2=wvRowLine2(w,cls);if(l2.length){var s2=wvEl('span','sub l2');l2.forEach(function(x,i){if(i)s2.appendChild(wvEl('span','',' · '));s2.appendChild(wvEl('span',x[0],x[1]));});b.appendChild(s2);}
    b.onclick=function(){wvSelect(w.id);};left.appendChild(b);
  }
  var fold=wvBtn('','',function(){WV.addOpen=!WV.addOpen;wvDrawList();});fold.className='wvfold'+(WV.addOpen?' open':'');fold.id='wv-addfold';fold.appendChild(wvEl('span','car','>'));fold.appendChild(wvEl('span','','Other ways to add a watcher'));left.appendChild(fold);
  if(!WV.addOpen)return;
  // from template
  var tf=wvEl('div','wvfld');tf.style.marginTop='8px';tf.appendChild(wvEl('label','','Start from a template'));
  var groups=['Slack','Chats','Pull requests'];
  var ts=wvEl('select');ts.id='wv-tpl';var o0=wvEl('option','','Choose a template...');o0.value='';ts.appendChild(o0);
  groups.forEach(function(g){var og=wvEl('optgroup');og.label=g;WV.tpls.forEach(function(t){if(t.group!==g)return;var needsSlack=t.needs==='slack_direct'&&!WV.have.slack_direct;var needsOrch=t.needs==='orchestrator'&&!WV.have.orchestrator;var op=wvEl('option','',t.label+(needsSlack?' (needs Slack, Direct)':needsOrch?' (needs the orchestrator)':t.needs==='gh'?' (needs gh)':''));op.value=t.id;op.title=t.description;og.appendChild(op);});ts.appendChild(og);});
  ts.onchange=function(){var id=ts.value;if(!id)return;ts.disabled=true;wvPost('/api/watchers/from-template',{template_id:id}).then(function(j){ts.disabled=false;ts.value='';if(!j.ok){WV.msg=j.detail||'could not create it';WV.msgErr=true;wvSync();return;}return wvRefresh().then(function(){WV.dirty=false;wvSelect(j.watcher.id);WV.msg='Created from the template, switched off and in Shadow. Fill it in, Test it, then enable it.';WV.msgErr=false;wvSync();});});};
  tf.appendChild(ts);left.appendChild(tf);
  // watch posts like this
  var pc=wvEl('div','wvcard');pc.style.marginTop='12px';pc.appendChild(wvEl('h4','','Watch posts like this'));
  pc.appendChild(wvEl('div','wvdef','Paste a Slack link to a post. Loom fills the channel, author and a matching rule.'));
  var pi=wvEl('input');pi.type='text';pi.id='wv-link';pi.placeholder='https://workspace.slack.com/archives/C0.../p17...';pi.style.margin='8px 0 6px';pi.value=WV.link;pi.oninput=function(){WV.link=pi.value;};
  var pm=wvEl('div','wvmsg'+(WV.linkMsg&&WV.linkMsg.indexOf('Filled')!==0?' err':''),WV.linkMsg);pm.id='wv-linkmsg';
  var pb=wvBtn('Create from this post','pri sm',function(){
    if(!WV.link.trim())return;pb.disabled=true;
    wvPost('/api/watchers/from-permalink',{url:WV.link.trim()}).then(function(j){pb.disabled=false;
      if(!j.ok){WV.linkMsg=j.detail==='slack_off'?'Slack is not connected (Direct), so a post cannot be read.':(j.detail||'could not read that post');wvDrawList();return;}
      WV.linkMsg='Filled from the post by '+(j.author||'unknown')+'. Review it, then Save.';
      if(WV.dirty){WV.dirty=false;}
      WV.sel='new';WV.draft=wvDraftOf(Object.assign({max_per_hour:6,cooldown_min:60,quiet_start:'',quiet_end:'',template_id:''},j.draft));WV.orig=null;WV.test=null;WV.editorFor='__none__';WV.dirty=true;wvDrawList();wvDrawEditor();wvLoadEvents();});});
  wvAdd(pc,pi,pm,pb);left.appendChild(pc);
}
function wvRefresh(){return wvGet('/api/watchers').then(function(d){if(d&&d.ok){WATCH=d;renderTabs();}});}

function wvSync(){
  var m=document.getElementById('wv-msg');if(m){m.textContent=WV.msg;m.className='wvmsg'+(WV.msg?(WV.msgErr?' err':' ok'):'');}
  var sv=document.getElementById('wv-save');var dc=document.getElementById('wv-discard');var dp=document.getElementById('wv-dirty');
  if(sv){var need=WV.draft&&wvNeedsSkipConfirm(WV.draft,WV.orig)&&!WV.skipOk;sv.disabled=!(WV.dirty||WV.sel==='new')||need;}
  if(dc)dc.style.display=WV.dirty||WV.sel==='new'?'':'none';
  if(sv)sv.style.display=WV.dirty||WV.sel==='new'?'':'none';
  if(dp)dp.textContent=WV.dirty?'Unsaved changes':'';
}
function wvSave(onFail){
  var d=WV.draft;if(!d)return;var isNew=WV.sel==='new';
  var body={watcher:wvPayload(d)};if(!isNew)body.id=WV.sel;if(wvNeedsSkipConfirm(d,WV.orig))body.confirm_skip=WV.skipOk;
  var sv=document.getElementById('wv-save');if(sv)sv.disabled=true;
  wvPost(isNew?'/api/watchers/create':'/api/watchers/update',body).then(function(j){
    if(!j.ok){WV.msg=j.detail||'could not save';WV.msgErr=true;if(onFail)onFail();wvSync();return;}
    WV.dirty=false;WV.sel=j.watcher.id;WV.skipOk=false;
    return wvRefresh().then(function(){var w=wvById(WV.sel);WV.draft=w?wvDraftOf(w):WV.draft;WV.orig=w?wvDraftOf(w):null;WV.msg='Saved.';WV.msgErr=false;WV.editorFor='__none__';wvDrawList();wvDrawEditor();wvLoadEvents();});
  });
}
function wvDrawEditor(){
  var right=document.getElementById('wvright');if(!right)return;
  var d=WV.draft;
  right.textContent='';WV.editorFor=WV.sel;
  if(!d){
    var e=wvEl('div','wvcard');e.appendChild(wvEl('div','wvempty',(WATCH.watchers||[]).length?'Choose a watcher on the left.':'Add a watcher, or start from a template. A watcher is Source, then Trigger, then Action.'));right.appendChild(e);wvTermSync();return;
  }
  var isNew=WV.sel==='new';
  var w0=isNew?null:wvById(WV.sel);
  // Header: label, mode, what it does; Test, Run now, Pause, More, then Discard and Save while there are edits.
  var hc=wvEl('div','wvcard wvhd');var hr=wvEl('div','wvrow');
  hr.appendChild(wvEl('b','wvtitle',d.label||'New watcher'));
  if(!isNew){hr.appendChild(wvEl('span','wvpill '+(d.run_mode==='shadow'?'warn':'ok'),d.run_mode==='shadow'?'Shadow':'Live'));if(!d.enabled)hr.appendChild(wvEl('span','wvpill','Paused'));}
  var dirty=wvEl('span','wvdirty');dirty.id='wv-dirty';hr.appendChild(dirty);
  hr.appendChild(wvEl('span','sp'));
  if(!isNew){
    var lab={slack:'Test against the last 200 posts',chats:'Test against current chats',prs:'Test against current pull request state',work:'Test against the endpoint now'}[d.source.kind];
    var tb=wvBtn(WV.testing?'Testing...':'Test','',function(){wvRunTest();});tb.id='wv-test';tb.title=lab+'. Runs the rule only, on what is saved plus your unsaved edits.';tb.disabled=WV.testing;hr.appendChild(tb);
    var every=w0&&w0.poll_every_ms;var tickOnly=d.source.kind==='chats'||d.source.kind==='prs';
    var rn=wvBtn('Run now','',function(){rn.disabled=true;wvPost('/api/watchers/run-now',{id:WV.sel}).then(function(j){rn.disabled=false;WV.msg=j.ok?'Polling on the next check, within '+Math.round((j.within_ms||15000)/1000)+' seconds.':(j.detail||'could not run it');WV.msgErr=!j.ok;wvSync();});});
    rn.id='wv-runnow';if(!d.enabled){rn.disabled=true;rn.title='Paused. Resume it first.';}else if(tickOnly){rn.disabled=true;rn.title='This source is already checked '+wvEvery(every||15000)+'.';}else rn.title='Poll now instead of waiting for the schedule ('+wvEvery(every)+').';hr.appendChild(rn);
    var en=wvBtn(d.enabled?'Pause':'Resume','',function(){var was=WV.dirty;d.enabled=!d.enabled;WV.dirty=true;wvSave(function(){d.enabled=!d.enabled;WV.dirty=was;wvDrawEditor();wvSync();});});en.id='wv-enable';en.title=d.enabled?'Stop polling. Nothing is lost.':'Start polling again. Whatever happened while paused is marked seen, not acted on.';hr.appendChild(en);
    var mw=wvEl('span','wvmorewrap');var mb=wvBtn('More','',function(){WV.moreOpen=!WV.moreOpen;WV.confirmDel=false;wvDrawEditor();});mb.id='wv-morebtn';mw.appendChild(mb);
    if(WV.moreOpen){var mn=wvEl('div','wvmenu');mn.id='wv-menu';
      mn.appendChild(wvBtn('Duplicate','',function(){WV.moreOpen=false;wvPost('/api/watchers/duplicate',{id:WV.sel}).then(function(j){if(!j.ok){WV.msg=j.detail||'could not duplicate';WV.msgErr=true;wvSync();return;}wvRefresh().then(function(){WV.dirty=false;wvSelect(j.watcher.id);});});}));
      var del=wvBtn(WV.confirmDel?'Confirm delete':'Delete','danger',function(){if(!WV.confirmDel){WV.confirmDel=true;wvDrawEditor();return;}WV.moreOpen=false;wvPost('/api/watchers/delete',{id:WV.sel}).then(function(j){if(!j.ok){WV.msg=j.detail||'could not delete';WV.msgErr=true;wvSync();return;}WV.dirty=false;WV.sel='';WV.draft=null;WV.orig=null;wvRefresh().then(function(){var f=(WATCH.watchers||[])[0];if(f)wvSelect(f.id);else{wvDrawList();wvDrawEditor();}});});});del.id='wv-delete';mn.appendChild(del);
      mw.appendChild(mn);}
    hr.appendChild(mw);
  }
  var dis=wvBtn('Discard','',function(){WV.dirty=false;WV.msg='';if(isNew){WV.sel='';WV.draft=null;wvDrawList();wvDrawEditor();return;}var w=wvById(WV.sel);WV.draft=w?wvDraftOf(w):null;WV.orig=w?wvDraftOf(w):null;WV.editorFor='__none__';wvDrawEditor();});dis.id='wv-discard';hr.appendChild(dis);
  var sv=wvBtn('Save','pri',wvSave);sv.id='wv-save';hr.appendChild(sv);
  hc.appendChild(hr);
  hc.appendChild(wvEl('div','wvsubline',isNew?'Set the source, trigger and action, then Save. It starts paused and in Shadow.':wvActionLine(d,WV.projects)));
  var msg=wvEl('div','wvmsg');msg.id='wv-msg';msg.style.marginTop='6px';hc.appendChild(msg);
  if(w0&&w0.last_error){var le=wvEl('div','wvmsg err','Last poll failed: '+w0.last_error);le.style.marginTop='4px';hc.appendChild(le);}
  right.appendChild(hc);
  if(!isNew){var tc=wvEl('div','wvcard');tc.id='wv-testcard';var th=wvEl('div','wvsech');th.appendChild(wvEl('h4','','Test'));th.appendChild(wvEl('span','wvsum','The rule only. Nothing is started, sent or recorded.'));th.appendChild(wvBtn('Close','sm',function(){WV.test=null;wvDrawTestResult();}));tc.appendChild(th);var res=wvEl('div');res.id='wv-testres';res.style.marginTop='10px';tc.appendChild(res);right.appendChild(tc);wvDrawTestResult();}
  if(isNew){wvDrawSettings(right,d,true);wvSync();wvTermSync();return;}
  // An existing watcher: its standing chat (live terminal), its settings and its history, one at a time.
  var stand=wvStandingOf(WV.sel);var hasChat=wvHasChat(w0,stand);var live=wvChatLive();var canTerm=live&&!!TERM_TOKEN;WV.pane=wvPaneFor(WV.pane,hasChat,canTerm);
  // The tab row: the Board's own Terminal / Transcript switch (dashboard.ts chatTabsHtml), then Settings and History.
  var tabs=wvEl('div','wvtabs');tabs.id='wv-tabs';tabs.setAttribute('role','tablist');
  var chatEff=WV.pane==='terminal'||WV.pane==='transcript'?WV.pane:'';
  if(hasChat&&typeof chatTabsHtml==='function'){var tmp=wvEl('div');tmp.innerHTML=chatTabsHtml(live,chatEff);while(tmp.firstChild)tabs.appendChild(tmp.firstChild);}
  function tabBtn(k,label,n){var b=wvEl('button','mtab'+(WV.pane===k?' on':''));b.type='button';b.setAttribute('role','tab');b.setAttribute('data-pane',k);b.appendChild(wvEl('span','',label));if(n)b.appendChild(wvEl('span','n',String(n)));tabs.appendChild(b);}
  tabBtn('settings','Settings');
  tabBtn('history','History',w0&&w0.shadow_unreviewed>0?w0.shadow_unreviewed:0);
  tabs.onclick=function(e){var b=e.target&&e.target.closest?e.target.closest('button'):null;if(!b||b.disabled)return;var k=b.getAttribute('data-t')||b.getAttribute('data-pane');if(!k||WV.pane===k)return;WV.pane=k;wvDrawEditor();};
  right.appendChild(tabs);
  function pane(k){var p=wvEl('div');p.id='wv-pane-'+k;if(WV.pane!==k)p.style.display='none';right.appendChild(p);return p;}
  if(hasChat){
    var sl=wvEl('div');sl.id='wv-stand';if(!chatEff)sl.style.display='none';right.appendChild(sl);
    var tp=pane('terminal');var tm=wvEl('div');tm.id='wv-termmsg';tm.style.display='none';tp.appendChild(tm);
    if(!WV.termHost){WV.termHost=wvEl('div');WV.termHost.id='wv-termhost';}WV.termHost.style.display='none';tp.appendChild(WV.termHost);
    var xp=pane('transcript');var xm=wvEl('div','wvdef');xm.id='wv-txmsg';xm.style.display='none';xp.appendChild(xm);var ms=wvEl('div');ms.id='wv-msgs';xp.appendChild(ms);WV.txSig='';
  }
  wvDrawSettings(pane('settings'),d,false);
  var hp=pane('history');var sh=wvEl('div','wvcard');sh.id='wv-shadow';hp.appendChild(sh);var fi=wvEl('div','wvcard');fi.id='wv-fires';hp.appendChild(fi);
  wvDrawEvents();wvStandingSync();wvSync();wvTermSync();wvTxSync(true);
}
/* Settings: the name, then Source / Trigger / Action / Limits as cards showing a one-line summary with Edit,
   each expanding in place (all open for a new watcher), then Shadow/Live at the bottom. */
function wvDrawSettings(p,d,all){
  var nm=wvText(function(){return d.label;},function(v){d.label=v;});nm.className='wvname';nm.id='wv-name';var nf=wvFld('Name',nm);nf.style.marginBottom='12px';p.appendChild(nf);
  wvSection(p,'source','Source',wvSourceSum(d),function(b){wvDrawSource(b,d);},all);
  wvSection(p,'trigger','Trigger',wvTriggerSum(d),function(b){wvDrawTrigger(b,d);},all);
  wvSection(p,'action','Action',wvActionLine(d,WV.projects),function(b){wvDrawAction(b,d);},all);
  wvSection(p,'limits','Limits',wvLimitsSum(d),function(b){wvDrawSafety(b,d);},all);
  var mc=wvEl('div','wvcard');mc.id='wv-modecard';mc.appendChild(wvEl('h4','','Run mode'));wvDrawMode(mc,d);p.appendChild(mc);
}
function wvSection(parent,key,title,summary,fill,all){
  var open=all||!!WV.open[key];var c=wvEl('div','wvcard wvsec'+(open?' open':''));c.setAttribute('data-sec',key);
  var h=wvEl('div','wvsech');h.appendChild(wvEl('h4','',title));h.appendChild(wvEl('span','wvsum',open?'':summary));
  if(!all){var b=wvBtn(open?'Done':'Edit','sm',function(){WV.open[key]=!open;wvDrawEditor();});b.setAttribute('data-edit',key);h.appendChild(b);}
  c.appendChild(h);if(open)fill(c);parent.appendChild(c);
}
/* The body of a Settings card (wvSection draws the card, title and summary). */
function wvCard(){return wvEl('div','wvsecb');}
function wvDrawSource(right,d){
  var c=wvCard();c.id='wv-source';
  c.appendChild(wvSeg(WV_SRC.map(function(x){return [x[0],x[1]];}),d.source.kind,function(k){if(k===d.source.kind)return;wvSetSource(d,k);WV.test=null;WV.dirty=true;wvDrawEditor();}));
  c.lastChild.style.marginBottom='10px';
  var p=d.source.params;
  if(d.source.kind==='slack'){
    var ids=Object.keys(WV.chan).sort(function(a,b){return String(WV.chan[a]).localeCompare(String(WV.chan[b]));});
    var g=wvEl('div','wvg2');
    var chSel;
    if(ids.length){var o=ids.map(function(id){return [id,'#'+String(WV.chan[id]).split('#').join('')];});if(p.channel&&!WV.chan[p.channel])o.unshift([p.channel,p.channel]);o.unshift(['','Choose a channel...']);chSel=wvSel(o,p.channel,function(v){p.channel=v;});}
    else chSel=wvText(function(){return p.channel;},function(v){p.channel=v.trim();},{ph:'Channel id, for example C0123456789'});
    chSel.id='wv-channel';
    g.appendChild(wvFld('Channel',chSel,ids.length?'':'Channel names appear here once Slack is connected (Direct).'));
    g.appendChild(wvFld('Workspace',wvText(function(){return p.workspace;},function(v){p.workspace=v.trim();},{ph:'workspace (the part before .slack.com)'}),'Used to build links to posts.'));
    c.appendChild(g);
    if(!WV.have.slack_direct)c.appendChild(wvEl('div','wvdef','Slack is not connected as Direct, so this watcher cannot poll or be tested until it is (Settings, Slack).'));
  }else if(d.source.kind==='chats'){
    var g2=wvEl('div','wvg2');
    g2.appendChild(wvFld('Projects',wvText(function(){return wvListText(p.projects);},function(v){p.projects=wvList(v);},{ph:'All projects'}),'Comma separated project folder names or paths. Empty means every project.'));
    g2.appendChild(wvFld('Tags',wvText(function(){return wvListText(p.tags);},function(v){p.tags=wvList(v);},{ph:'Any tag'}),'Comma separated. A chat with any one of them matches.'));
    c.appendChild(g2);c.appendChild(wvEl('div','wvdef','Reads the live chats Loom already tracks: state, last output time and context use.'));
  }else if(d.source.kind==='work'){
    var g4=wvEl('div','wvg2');
    g4.appendChild(wvFld('Endpoint URL',wvText(function(){return p.url;},function(v){p.url=v.trim();},{ph:'https://findings.example.com/api/audit'}),'Polled every 15 minutes. The bearer token is read from the Keychain.'));
    g4.appendChild(wvFld('Send everything already open on the first poll',wvSel([['no','No, baseline silently'],['yes','Yes, send it all once']],p.sweep_first?'yes':'no',function(v){p.sweep_first=v==='yes';})));
    c.appendChild(g4);
  }else{
    var g3=wvEl('div','wvg2');
    g3.appendChild(wvFld('Repos',wvText(function(){return wvListText(p.repos);},function(v){p.repos=wvList(v);},{ph:'Any repo (owner/name, comma separated)'})));
    g3.appendChild(wvFld('Whose pull requests',wvSel([['yes','Only my own'],['no','Any author in those repos']],p.mine_only===false?'no':'yes',function(v){p.mine_only=v==='yes';})));
    c.appendChild(g3);c.appendChild(wvEl('div','wvdef','Read from the pull request state Loom already caches with gh. Needs gh logged in.'));
  }
  right.appendChild(c);
}
function wvDrawTrigger(right,d){
  var c=wvCard();c.id='wv-trigger';
  var g=wvEl('div','wvg2');
  var ts=wvSel(wvTrigs(d.source.kind).map(function(t){return [t.kind,t.label];}),d.trigger.kind,function(v){wvSetTrigger(d,v);WV.test=null;},function(){wvDrawEditor();});ts.id='wv-trigger-kind';
  g.appendChild(wvFld('When',ts));c.appendChild(g);
  var def=wvTrigDef(d.source.kind,d.trigger.kind);var keys=Object.keys(def.defaults);
  if(keys.length){var g2=wvEl('div','wvg2');keys.forEach(function(k){
    var dv=def.defaults[k];var lab=WV_LABELS[k]||[k,''];var tp=d.trigger.params;var ctl;
    if(Array.isArray(dv))ctl=wvText(function(){return wvListText(tp[k]);},function(v){tp[k]=wvList(v);});
    else if(typeof dv==='boolean')ctl=wvSel([['yes','Yes'],['no','No']],tp[k]?'yes':'no',function(v){tp[k]=v==='yes';});
    else if(typeof dv==='number')ctl=wvText(function(){return String(tp[k]);},function(v){tp[k]=v===''?0:Number(v);},{num:true,step:k==='fraction'?'0.05':'1',min:0});
    else ctl=wvText(function(){return tp[k];},function(v){tp[k]=v;});
    ctl.setAttribute('data-tp',k);g2.appendChild(wvFld(lab[0],ctl,lab[1]));});c.appendChild(g2);}
  else c.appendChild(wvEl('div','wvdef','This trigger has no settings.'));
  right.appendChild(c);
}
function wvInvEntry(key){var e=WV.inv[key];if(e&&Date.now()-e.at<30000)return e;if(e&&e.busy)return e;WV.inv[key]={at:e?e.at:0,list:e?e.list:null,busy:true};wvGet('/api/watchers/invocables?project='+encodeURIComponent(key)).then(function(r){WV.inv[key]={at:Date.now(),list:r&&r.ok?(r.invocables||[]):[],busy:false};if(document.getElementById('wv-invpick'))wvDrawEditor();});return WV.inv[key];}
function wvDrawPicker(c,d,ap,mode){
  var key=wvInvKey(d);var ent=wvInvEntry(key);var box=wvEl('div','wvpick');box.id='wv-invpick';
  var noun=mode==='skill'?'skills':'commands';
  var q=wvEl('input');q.type='text';q.placeholder='Search '+noun+'...';q.value=WV.invQ||'';q.id='wv-invq';box.appendChild(q);
  var list=wvEl('div','wvpickl');box.appendChild(list);
  function fill(){
    list.textContent='';
    if(!ent.list){list.appendChild(wvEl('div','wvdef','Loading...'));list.firstChild.style.padding='8px 10px';return;}
    var m=wvInvMatch(ent.list,mode,WV.invQ);
    if(!m.length){list.appendChild(wvEl('div','wvdef','No '+noun+' match.'));list.firstChild.style.padding='8px 10px';return;}
    m.forEach(function(i){var b=wvEl('button','wvpi'+(ap.invoke.name===i.name?' sel':''));b.type='button';var t=wvEl('b','',i.name);b.appendChild(t);b.appendChild(wvEl('span','wvdef','  '+i.source));if(i.description)b.appendChild(wvEl('span','d',wvInvShort(i.description)));b.onclick=function(){ap.invoke.name=i.name;WV.dirty=true;wvDrawEditor();};list.appendChild(b);});
  }
  q.oninput=function(){WV.invQ=q.value;fill();};
  fill();c.appendChild(box);
  var nm=ap.invoke.name;
  if(nm&&ent.list&&!ent.list.some(function(i){return i.kind===mode&&i.name===nm;})){var w=wvEl('div','wvmsg err','Selected '+mode+' '+nm+' was not found'+(d.action.kind==='start_chat'&&ap.project_dir?' for this project':'')+'. Choose another or save will be refused.');w.style.marginTop='6px';c.appendChild(w);}
  else if(nm){var ok=wvEl('div','wvdef','Selected: '+nm);ok.style.marginTop='6px';c.appendChild(ok);}
}
function wvDrawPayload(c,d,ap,key,rows){
  var mode=wvInvMode(ap);var start=d.action.kind==='start_chat';
  var sg=wvSeg([['brief','Brief'],['skill','Skill'],['command','Command']],mode,function(m){wvSetInvMode(ap,m);WV.dirty=true;wvDrawEditor();});sg.id='wv-invmode';
  var help=start?'A skill or command runs in the new chat. Both run in Claude chats.':'A skill or command runs only in Claude chats. If the matching chat is Codex, the event fails and nothing is sent. Project skills and commands are not listed because the chat is not known until it fires.';
  c.appendChild(wvFld(start?'What the chat receives':'What the chat is sent',sg,help));
  if(mode==='brief'){var ta=wvArea(function(){return ap[key];},function(v){ap[key]=v;},rows,'wv-brief');ta.onfocus=function(){WV.chipTarget='wv-brief';};c.appendChild(wvFld(start?'Brief the worker receives':'Message sent into the chat',ta));return;}
  c.appendChild(wvFld(mode==='skill'?'Skill':'Command',(function(){var h=wvEl('div');wvDrawPicker(h,d,ap,mode);return h;})()));
  var ai=wvText(function(){return ap.invoke.args;},function(v){ap.invoke.args=v;},{ph:'Arguments, for example {{URL}}'});ai.id='wv-brief';ai.onfocus=function(){WV.chipTarget='wv-brief';};
  c.appendChild(wvFld('Arguments',ai,'Passed after the name. The variables below are filled in.'));
  var nt=wvArea(function(){return ap.notes||'';},function(v){ap.notes=v;},4,'wv-notes');nt.onfocus=function(){WV.chipTarget='wv-notes';};
  c.appendChild(wvFld('Extra instructions (optional)',nt,start?'Added after the '+mode+' on a new line.':'Added on the same line after the arguments, because the message is typed as one line.'));
}
function wvDrawAction(right,d){
  var c=wvCard();c.id='wv-action';
  var ak=wvSel(WV_ACT.map(function(a){return [a[0],a[1],a[0]==='tell_orch'&&WV.have.orchestrator===false&&d.action.kind!=='tell_orch'];}),d.action.kind,function(v){wvSetAction(d,v);},function(){wvDrawEditor();});ak.id='wv-action-kind';
  c.appendChild(wvFld('Then',ak,d.action.kind==='tell_orch'&&WV.have.orchestrator===false?'The orchestrator is off, so this action fails until it is turned on (Settings, Orchestrator).':''));
  var ap=d.action.params;
  if(d.action.kind==='start_chat'){
    var g=wvEl('div','wvg2');
    var po=WV.projects.filter(function(p){return !p.hidden;}).map(function(p){return [p.path,p.name];});
    var known=po.some(function(x){return x[0]===ap.project_dir;});
    if(ap.project_dir&&!known)po.unshift([ap.project_dir,ap.project_dir]);po.unshift(['','Choose a project...']);
    var ps=wvSel(po,ap.project_dir,function(v){ap.project_dir=v;});ps.id='wv-project';g.appendChild(wvFld('Project',ps));
    var lane=ap.target&&ap.target!=='managed';
    var tw=wvEl('div');var tsel=wvSel([['managed','New managed window'],['lane','Free pane in a lane']],lane?'lane':'managed',function(v){ap.target=v==='managed'?'managed':'lane:'+(WV.lanes[0]||'main');},function(){wvDrawEditor();});tsel.id='wv-target';tw.appendChild(tsel);
    if(lane){var ln=ap.target.slice(5);var lo=WV.lanes.map(function(x){return [x,x];});if(ln&&WV.lanes.indexOf(ln)<0)lo.unshift([ln,ln]);if(!lo.length)lo.push([ln||'main',ln||'main']);var ls=wvSel(lo,ln,function(v){ap.target='lane:'+v;});ls.style.marginTop='6px';tw.appendChild(ls);}
    g.appendChild(wvFld('Where it runs',tw));c.appendChild(g);
    var pr=wvSel([['inherit','Follow Settings, Agents and permissions'],['normal','Normal (asks before running commands)'],['skip','Skip permissions']],ap.perm,function(v){ap.perm=v;WV.skipOk=false;},function(){wvDrawEditor();});pr.id='wv-perm';
    c.appendChild(wvFld('Permissions for the chat',pr));
    if(wvNeedsSkipConfirm(d,WV.orig)){var cf=wvEl('label','wvtog');cf.style.margin='0 0 10px';var cc=wvEl('input');cc.type='checkbox';cc.id='wv-skipok';cc.checked=WV.skipOk;cc.onchange=function(){WV.skipOk=cc.checked;wvSync();};cf.appendChild(cc);var sp=wvEl('span','',"I understand: this chat will run commands without asking, on its own, whenever the watcher fires.");sp.style.color='#f0908f';cf.appendChild(sp);c.appendChild(cf);}
    var sl=wvEl('label','wvtog');sl.style.margin='0 0 10px';var sc=wvEl('input');sc.type='checkbox';sc.id='wv-standing';sc.checked=ap.standing===true;sc.onchange=function(){ap.standing=sc.checked;wvSync();};sl.appendChild(sc);sl.appendChild(wvEl('span','','Keep one chat for this watcher: later matches are sent to it, and everything from one poll goes out as one batch.'));c.appendChild(sl);
    wvDrawPayload(c,d,ap,'brief_template',9);
  }else{
    if(d.action.kind==='message_chat')wvDrawPayload(c,d,ap,'template',4);
    else{var lab={notify:'Notification text',tell_orch:'What to tell the orchestrator'}[d.action.kind];
    c.appendChild(wvFld(lab,wvArea(function(){return ap.template;},function(v){ap.template=v;},d.action.kind==='notify'?2:4,'wv-brief')));}
    if(d.action.kind==='notify')c.appendChild(wvEl('div','wvdef','Uses the notification sound from Settings, General.'));
  }
  var cr=wvEl('div','wvchips');(WV_CHIPS[d.source.kind]||[]).forEach(function(x){var ch=wvEl('span','wvchip','{{'+x+'}}');ch.onclick=function(){var t=document.getElementById(WV.chipTarget||'wv-brief')||document.getElementById('wv-brief');if(!t)return;var a=t.selectionStart==null?t.value.length:t.selectionStart,b=t.selectionEnd==null?a:t.selectionEnd;var tx='{{'+x+'}}';t.value=t.value.slice(0,a)+tx+t.value.slice(b);t.focus();var p=a+tx.length;t.setSelectionRange(p,p);t.dispatchEvent(new Event('input'));};cr.appendChild(ch);});
  cr.appendChild(wvEl('span','wvdef','click to insert at the cursor'));c.appendChild(cr);
  right.appendChild(c);
}
function wvDrawMode(right,d){
  var c=wvCard();c.id='wv-mode';
  c.appendChild(wvSeg([['shadow','Shadow'],['live','Live']],d.run_mode,function(m){d.run_mode=m;WV.dirty=true;wvDrawEditor();}));
  var h=wvEl('div','wvdef');h.style.marginTop='6px';h.textContent='Shadow records what would have fired and takes no action. Live performs the action. Start in Shadow, read History, then go Live.';c.appendChild(h);
  right.appendChild(c);
}
function wvDrawSafety(right,d){
  var c=wvCard();c.id='wv-safety';var g=wvEl('div','wvg2');
  g.appendChild(wvFld('Max fires per hour',wvText(function(){return String(d.max_per_hour);},function(v){d.max_per_hour=v===''?0:Number(v);},{num:true,min:0,cls:'wvnum'}),'0 means no cap.'));
  g.appendChild(wvFld('Cooldown per subject (minutes)',wvText(function(){return String(d.cooldown_min);},function(v){d.cooldown_min=v===''?0:Number(v);},{num:true,min:0,cls:'wvnum'}),'The same chat, post or pull request will not fire again within this time. 0 means none.'));
  var q=wvEl('div','wvrow');q.appendChild(wvText(function(){return d.quiet_start;},function(v){d.quiet_start=v.trim();},{ph:'22:00',cls:'wvtime'}));q.appendChild(wvEl('span','wvdef','to'));q.appendChild(wvText(function(){return d.quiet_end;},function(v){d.quiet_end=v.trim();},{ph:'07:00',cls:'wvtime'}));
  g.appendChild(wvFld('Quiet hours (local time, no actions)',q,'HH:MM to HH:MM, or leave both empty. Matches in quiet hours are held, not replayed later.'));
  c.appendChild(g);right.appendChild(c);
}
function wvRunTest(){
  var d=WV.draft;if(!d)return;WV.testing=true;WV.test=null;wvDrawTestResult();
  var body={watcher:wvPayload(d)};if(WV.sel!=='new')body.watcher.id=WV.sel;
  wvPost('/api/watchers/test',body).then(function(j){WV.testing=false;WV.test=j;var b=document.getElementById('wv-test');if(b){b.disabled=false;}wvDrawTestResult();});
}
function wvDrawTestResult(){
  var res=document.getElementById('wv-testres');if(!res)return;res.textContent='';
  var b=document.getElementById('wv-test');if(b){b.disabled=WV.testing;b.textContent=WV.testing?'Testing...':'Test';}
  var tc=document.getElementById('wv-testcard');if(tc)tc.style.display=WV.testing||WV.test?'':'none';
  if(WV.testing){res.appendChild(wvEl('div','wvmsg','Evaluating...'));return;}
  var j=WV.test;if(!j)return;
  if(!j.ok){res.appendChild(wvEl('div','wvmsg err',j.detail||'The test could not run.'));return;}
  res.appendChild(wvEl('div','wvmsg',j.rows.length+' of '+j.scanned+' scanned would fire.'+(j.rows.length>=200?' (First 200 shown.)':'')));
  if(!j.rows.length)return;
  var t=wvEl('table','wvt');var tr=wvEl('tr');['Would fire for','Subject'].forEach(function(h){tr.appendChild(wvEl('th','',h));});t.appendChild(tr);
  j.rows.slice(0,50).forEach(function(r){var row=wvEl('tr');var td=wvEl('td');if(r.permalink){var a=wvEl('a','',r.title||r.subject);a.href=r.permalink;a.target='_blank';a.rel='noopener';td.appendChild(a);}else td.textContent=r.title||r.subject;row.appendChild(td);row.appendChild(wvEl('td','',r.subject));t.appendChild(row);});
  res.appendChild(t);
}
function wvEventCell(e){var td=wvEl('td');if(e.permalink){var a=wvEl('a','',e.title||e.subject);a.href=e.permalink;a.target='_blank';a.rel='noopener';td.appendChild(a);}else td.textContent=e.title||e.subject;return td;}
function wvReview(body){return wvPost('/api/watchers/review',body).then(function(j){if(j&&j.ok){WATCH.unreviewed=j.unreviewed;renderTabs();}return wvRefresh().then(function(){wvDrawList();return wvLoadEvents();});});}
function wvDrawEvents(){
  var sh=document.getElementById('wv-shadow'),fi=document.getElementById('wv-fires');if(!sh||!fi)return;
  var now=Date.now();var d=WV.draft;var actName=d?wvActLabel(d.action.kind):'';
  sh.textContent='';sh.appendChild(wvEl('h4','','Would have fired (Shadow)'));
  if(!WV.shadow.length)sh.appendChild(wvEl('div','wvdef','Nothing waiting for review. In Shadow, every match is listed here instead of acting.'));
  else{
    var t=wvEl('table','wvt');var h=wvEl('tr');['When','Event','Action it would take','Reviewed'].forEach(function(x){h.appendChild(wvEl('th','',x));});t.appendChild(h);
    WV.shadow.forEach(function(e){var r=wvEl('tr');r.setAttribute('data-eid',e.id);r.appendChild(wvEl('td','',wvTimeText(e.detected_at,now)));r.appendChild(wvEventCell(e));r.appendChild(wvEl('td','',actName));var td=wvEl('td');td.appendChild(wvBtn('Mark reviewed','sm',function(){wvReview({event_ids:[e.id]});}));r.appendChild(td);t.appendChild(r);});
    sh.appendChild(t);
    var row=wvEl('div','wvrow');row.style.marginTop='8px';var all=wvBtn('Mark all '+WV.shadow.length+' reviewed','sm',function(){wvReview({id:WV.sel});});all.id='wv-reviewall';row.appendChild(all);
    var wvdef=wvEl('span','wvdef','The Watchers tab badge counts watchers that still have an unreviewed Shadow result, or a failed poll.');row.appendChild(wvdef);
    if(d&&d.run_mode==='shadow'){var go=wvBtn('Go Live','sm',function(){if(WV.dirty){d.run_mode='live';WV.msg='Switched to Live in the editor. Save to apply it.';WV.msgErr=false;wvDrawEditor();return;}wvPost('/api/watchers/run-mode',{id:WV.sel,mode:'live'}).then(function(j){if(!j.ok){WV.msg=j.detail||'could not switch';WV.msgErr=true;wvSync();return;}wvRefresh().then(function(){var w=wvById(WV.sel);WV.draft=w?wvDraftOf(w):WV.draft;WV.orig=w?wvDraftOf(w):null;WV.msg='Now Live.';WV.msgErr=false;wvDrawList();wvDrawEditor();wvLoadEvents();});});});go.id='wv-golive';row.appendChild(go);}
    sh.appendChild(row);
  }
  fi.textContent='';fi.appendChild(wvEl('h4','','Recent fires'));
  if(!WV.fires.length)fi.appendChild(wvEl('div','wvdef','Nothing has fired yet.'));
  else{
    var t2=wvEl('table','wvt');var h2=wvEl('tr');['When','Event','Action','Result'].forEach(function(x){h2.appendChild(wvEl('th','',x));});t2.appendChild(h2);
    WV.fires.slice(0,WV.firesShown).forEach(function(e){var r=wvEl('tr');r.appendChild(wvEl('td','',wvTimeText(e.detected_at,now)));r.appendChild(wvEventCell(e));r.appendChild(wvEl('td','',actName));var td=wvEl('td');var pp=wvResultPill(e);var pill=wvEl('span','wvpill '+pp[0],pp[1]);if(e.detail)pill.title=e.detail;td.appendChild(pill);if(e.result==='failed'&&e.detail){var dd=wvEl('div','wvdef',e.detail);td.appendChild(dd);}r.appendChild(td);t2.appendChild(r);});
    fi.appendChild(t2);
    var shown=Math.min(WV.firesShown,WV.fires.length);var fr=wvEl('div','wvrow');fr.style.marginTop='8px';fr.appendChild(wvEl('span','wvdef','Showing '+shown+' of '+WV.fires.length+(WV.fires.length>=200?' (the most recent 200 are kept in view)':'')+'.'));
    if(WV.fires.length>WV.firesShown){var mb=wvBtn('Show more','sm',function(){WV.firesShown+=20;wvDrawEvents();});mb.id='wv-more';fr.appendChild(mb);}
    fi.appendChild(fr);
  }
}

function wvDrawSpawns(){
  var c=document.getElementById('wvspawns');if(!c)return;c.textContent='';var sps=WATCH.spawns||[];
  var h=wvBtn('','',function(){WV.spawnsOpen=!WV.spawnsOpen;wvDrawSpawns();});h.className='wvfold grp'+(WV.spawnsOpen?' open':'');h.id='wv-spawnfold';h.appendChild(wvEl('span','car','>'));h.appendChild(wvEl('span','','Workers started'+(sps.length?' · '+sps.length:'')));c.appendChild(h);
  if(!WV.spawnsOpen)return;
  if(!sps.length){c.appendChild(wvEl('div','wvdef','Nothing started yet.'));return;}
  var now=Date.now();
  sps.forEach(function(e){var r=wvEl('div','wvsp');var w=wvById(e.watcher_id);
    var l1=wvEl('div','wvsp1');l1.appendChild(wvEl('span','wvpill '+(e.status==='spawned'?'ok':'warn'),e.status==='spawned'?'Started':e.status));l1.appendChild(wvEl('span','wvago',wvTimeText(e.detected_at,now)+' · '+(w?w.label:e.watcher_id)+(e.pane_name?' · '+e.pane_name:'')));
    if(e.status==='spawned'&&e.pane_id){var b=wvBtn('go','sm',function(){wvPost('/api/watchers/goto?id='+encodeURIComponent(e.id),{});});l1.appendChild(b);}
    r.appendChild(l1);var ev=wvEl('div','wvsp2');if(e.permalink){var a=wvEl('a','',e.title||e.subject);a.href=e.permalink;a.target='_blank';a.rel='noopener';ev.appendChild(a);}else ev.textContent=e.title||e.subject;r.appendChild(ev);c.appendChild(r);});
}
/* ---- entry point, called by dashboard.ts renderWatch() on every render and every 15 s ---- */
function wvRender(){
  if(!WV.built)wvBuild();
  wvFit();
  if(!WV.loaded){if(!WV.loading){WV.loading=true;wvLoadStatic().then(function(){wvRender();});}return;}
  if(WV.pendingSel&&wvById(WV.pendingSel)){var ps=WV.pendingSel;WV.pendingSel='';if(ps!==WV.sel)wvSelect(ps);}
  if(WV.sel!=='new'&&WV.sel&&!wvById(WV.sel)&&!WV.dirty){WV.sel='';WV.draft=null;}
  if(!WV.sel&&(WATCH.watchers||[]).length){wvSelect(WATCH.watchers[0].id);}
  wvDrawTop();wvDrawNote();wvDrawSpawns();
  wvDrawListKeepFocus();wvStandingSync();
  if(WV.dirty&&WV.draft)return;
  if(!WV.draft&&WV.sel===''){wvDrawEditor();}
  else if(WV.draft&&!document.getElementById('wv-save'))wvDrawEditor();
  if(WV.sel&&WV.sel!=='new')wvLoadEvents();
  wvTermSync();wvTxSync(false);
}
// ---- Standing chats ----------------------------------------------------------
// A standing watcher's own chat is kept off the Board (src/standingchats.ts) and shown here instead: a status
// dot on the watcher's list row, and the editor's Chat tab, which embeds the chat's live terminal (openTerm, the
// same mechanism as the orchestrator's Terminal view, keyed 'wv|<pane>'). Each running chat of the watcher is a row
// above the terminal (the Board's dot, DOT_LABEL and title); clicking one shows it, and Open on Board opens it the
// way a notification or a board row does (openInBoard + its terminal). Leaving the tab, choosing another watcher
// or another editor tab closes the terminal (wvTermSync, wvLeave).
function wvStandingOf(id){var l=(typeof DATA!=='undefined'&&DATA&&DATA.standing)||[];return l.filter(function(s){return s&&s.chat&&s.watcher_id===id;});}
function wvOpenStanding(c){openInBoard(c.session_id,c.agent);if(TERM_TOKEN)mtab='terminal';renderMain();}
function wvStandingEl(s,shown){
  var c=s.chat;var cls=dotCls(c);var label=DOT_LABEL[cls]||'';
  var row=wvEl('div','wvstand'+(cls==='d-turn'?' turn':'')+(shown?' cur':''));row.setAttribute('data-sid',c.session_id);row.setAttribute('data-agent',c.agent);
  row.title=(s.current?'This watcher':'An earlier chat of this watcher')+' · '+label+(shown?'':' · show its terminal');
  var dot=wvEl('span','sdot '+cls);dot.title=label;row.appendChild(dot);
  row.appendChild(wvEl('span','t',disp(c)));
  row.appendChild(wvEl('span','wvstl',s.current?label:label+' · earlier chat'));
  if(shown){var L=(typeof DATA!=='undefined'&&DATA&&DATA.live&&DATA.live[c.agent+':'+c.session_id])||null;var mt=wvChatMeta(L,WV.fires,Date.now());if(mt)row.appendChild(wvEl('span','wvmeta','· '+mt));}
  var ob=wvBtn('Open on Board','sm',function(e){if(e&&e.stopPropagation)e.stopPropagation();wvOpenStanding(c);});ob.setAttribute('data-open','1');row.appendChild(ob);
  row.onclick=function(){if(WV.termSid===c.session_id)return;WV.termSid=c.session_id;wvStandingSync();wvTermSync();if(typeof wvTxSync==='function')wvTxSync(true);};
  return row;
}
function wvStandingSync(){var slot=document.getElementById('wv-stand');if(!slot)return;slot.textContent='';
  var l=WV.sel&&WV.sel!=='new'?wvStandingOf(WV.sel):[];if(!l.length)return;
  var plan=wvTermPlan(l,WV.termSid,(typeof DATA!=='undefined'&&DATA&&DATA.live)||{},'x');var cur=plan.chat?plan.chat.chat.session_id:'';
  l.forEach(function(s){slot.appendChild(wvStandingEl(s,s.chat.session_id===cur));});}
/* Open, keep or close the Chat tab's terminal to match what is selected. Safe to call on every render. */
function wvTermSync(){
  if(typeof openTerm!=='function')return;
  var onTab=typeof tab==='undefined'||tab==='watch';
  var want=onTab&&WV.sel&&WV.sel!=='new'&&WV.pane==='terminal'&&WV.termHost&&document.body.contains(WV.termHost);
  var plan=want?wvTermPlan(wvStandingOf(WV.sel),WV.termSid,(DATA&&DATA.live)||{},TERM_TOKEN):null;
  var msg=document.getElementById('wv-termmsg');
  if(plan&&plan.key){WV.termHost.style.display='';if(msg)msg.style.display='none';if(termKey!==plan.key){openTerm(plan.pane,WV.termHost);termKey=plan.key;}else alignTerm();return;}
  if(termKey.indexOf('wv|')===0)closeTerm();
  if(WV.termHost)WV.termHost.style.display='none';
  if(msg){msg.textContent=plan?plan.msg:'';msg.style.display=plan?'':'none';}
}
/* Is the standing chat on show running in a pane? (The Board's "live": it decides whether Terminal is offered.) */
function wvChatLive(){var l=WV.sel&&WV.sel!=='new'?wvStandingOf(WV.sel):[];return !!wvTermPlan(l,WV.termSid,(typeof DATA!=='undefined'&&DATA&&DATA.live)||{},'x').pane;}
/* The Transcript tab: the Board's fetch and render (transcriptUrl, transcriptMsgsHtml) for the chosen standing chat. */
function wvTxSync(toBottom){
  var box=document.getElementById('wv-msgs');var note=document.getElementById('wv-txmsg');if(!box||WV.pane!=='transcript')return;
  var l=wvStandingOf(WV.sel);var live=(typeof DATA!=='undefined'&&DATA&&DATA.live)||{};
  var plan=wvTermPlan(l,WV.termSid,live,typeof TERM_TOKEN!=='undefined'?TERM_TOKEN:'');
  if(note){var why=!plan.chat?plan.msg:(!plan.key?plan.msg:'');note.textContent=why;note.style.display=why?'':'none';}
  if(!plan.chat){box.textContent='';WV.txSig='';return;}
  var c=plan.chat.chat;var sel0=WV.sel;if(typeof transcriptUrl!=='function')return;
  wvGet(transcriptUrl(c.session_id,c.agent)).then(function(d){
    if(!d||!d.ok||WV.sel!==sel0||WV.pane!=='transcript')return;var b=document.getElementById('wv-msgs');if(!b)return;
    var atBottom=b.scrollTop+b.clientHeight>=b.scrollHeight-50;var last=d.messages.length?d.messages[d.messages.length-1].text:'';var sig=c.session_id+':'+d.messages.length+':'+last.length;
    if(sig!==WV.txSig){WV.txSig=sig;b.innerHTML=transcriptMsgsHtml(d);}
    if(toBottom||atBottom)b.scrollTop=b.scrollHeight;});
}
/* A watcher notification's click (app/main.ts): the Watchers tab with that watcher selected. */
if(typeof window!=='undefined')window.loomOpenWatcher=function(id){WV.pendingSel=String(id||'');tab='watch';stateFilter='all';onlyGroup=null;syncControls();liveToggle();chips();render();refreshWatch();};
/* dashboard.ts render(): any tab but Watchers drops the watcher terminal. */
function wvLeave(){if(typeof termKey==='string'&&termKey.indexOf('wv|')===0)closeTerm();}
function wvDrawListKeepFocus(){var a=document.activeElement;if(a&&a.closest&&a.closest('#wvleft'))return;wvDrawList();}
`.split('__WV_TRIGGERS__').join(TRIGGER_JSON);
