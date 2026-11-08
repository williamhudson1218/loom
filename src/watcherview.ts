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
`;

export const WATCHER_VIEW_HTML = String.raw`

`;

export const WATCHER_VIEW_JS = String.raw`
var WV_TRIGGERS=__WV_TRIGGERS__;
var WV_SRC=[['slack','Slack channel'],['chats','Chats'],['prs','Pull requests']];
var WV_ACT=[['start_chat','Start a chat with a brief'],['message_chat','Send a message into the matching chat'],['notify','Notify me (Mac notification)'],['tell_orch','Tell the orchestrator']];
var WV_CHIPS={slack:['WATCHER','TITLE','URL','TEXT','AUTHOR','CHANNEL'],chats:['WATCHER','CHAT_TITLE','PROJECT','PANE','IDLE_MIN','PERCENT'],prs:['WATCHER','TITLE','PR','PR_TITLE','URL','CHECK']};
var WV_LABELS={bot_ids:['Bot ids','Comma separated Slack bot ids (B...).'],user_ids:['User ids','Comma separated Slack user ids (U...).'],needle:['Phrase','Slack bot posts match the exact text; people posts ignore case.'],repos:['Repos','Comma separated owner/name. Empty means any repo.'],exclude_user_ids:['Ignore these user ids','Comma separated. Your own id is always ignored when "Ignore my own posts" is on.'],any_author:['Include posts by bots','Off means people only.'],min:['Minutes',''],min_sec:['Seconds waiting',''],max_h:['Ignore after (hours)','Chats waiting longer than this are old news.'],fraction:['Fraction of context used','0.85 means 85 percent.']};
var WV={built:false,sel:'',draft:null,orig:null,dirty:false,tpls:[],have:{},chan:{},projects:[],lanes:[],cfg:{},test:null,testing:false,shadow:[],fires:[],msg:'',msgErr:false,skipOk:false,confirmDel:false,editorFor:'__none__',loaded:false,link:'',linkMsg:'',firesShown:20,inv:{},invQ:'',chipTarget:'wv-brief'};

/* ---- pure helpers (no DOM; the unit tests run these) ---- */
function wvClone(o){return JSON.parse(JSON.stringify(o));}
function wvNl(){return String.fromCharCode(10);}
function wvEol(orig,val){var crlf=String.fromCharCode(13)+wvNl();if(String(orig).indexOf(crlf)>=0&&String(orig).split(crlf).join('').indexOf(wvNl())<0)return String(val).split(wvNl()).join(crlf);return val;}
function wvList(s){return String(s).split(wvNl()).join(',').split(',').map(function(x){return x.trim();}).filter(function(x){return x;});}
function wvListText(a){return (a||[]).join(', ');}
function wvDraftOf(w){return {label:w.label,enabled:!!w.enabled,run_mode:w.run_mode==='live'?'live':'shadow',source:wvClone(w.source),trigger:{kind:w.trigger.kind,params:wvClone(w.trigger.params||{})},action:wvClone(w.action),max_per_hour:w.max_per_hour,cooldown_min:w.cooldown_min,quiet_start:w.quiet_start||'',quiet_end:w.quiet_end||'',template_id:w.template_id||''};}
function wvPayload(d){return wvClone(d);}
function wvBlank(){return {label:'New watcher',enabled:false,run_mode:'shadow',source:{kind:'slack',params:{channel:'',workspace:''}},trigger:{kind:'phrase',params:{needle:'',any_author:false}},action:{kind:'notify',params:{template:'{{TITLE}}'}},max_per_hour:6,cooldown_min:60,quiet_start:'',quiet_end:'',template_id:''};}
function wvWatches(w){var p=w.source.params||{};var k=w.source.kind;if(k==='slack'){var n=p.channel&&WV.chan[p.channel];return (n?'#'+String(n).split('#').join(''):(p.channel||'no channel chosen'))+' - '+(w.trigger.label||w.trigger.kind);}if(k==='chats'){var pr=(p.projects||[]);return (pr.length?'chats in '+pr.join(', '):'your chats')+' - '+(w.trigger.label||w.trigger.kind);}var r=(p.repos||[]);return (r.length?r.join(', '):'your pull requests')+' - '+(w.trigger.label||w.trigger.kind);}
function wvTrigs(src){return WV_TRIGGERS[src]||[];}
function wvTrigDef(src,kind){var l=wvTrigs(src);for(var i=0;i<l.length;i++)if(l[i].kind===kind)return l[i];return l[0];}
function wvSetSource(d,src){var srcDefaults={slack:{channel:'',workspace:''},chats:{projects:[],tags:[]},prs:{repos:[],mine_only:true}};d.source={kind:src,params:srcDefaults[src]};var t=wvTrigs(src)[0];d.trigger={kind:t.kind,params:wvClone(t.defaults)};}
function wvSetTrigger(d,kind){var t=wvTrigDef(d.source.kind,kind);d.trigger={kind:t.kind,params:wvClone(t.defaults)};}
function wvSetAction(d,kind){var old=d.action.params||{};var tmpl=old.template!=null?old.template:(old.brief_template||'');if(kind==='start_chat')d.action={kind:kind,params:{project_dir:old.project_dir||'',target:old.target||'managed',brief_template:old.brief_template!=null?old.brief_template:tmpl,perm:old.perm||'inherit'}};else d.action={kind:kind,params:{template:old.template!=null?old.template:tmpl}};wvCarryInvoke(d,old);}
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
    WV.shadow=(r[0]&&r[0].events)||[];WV.fires=(r[1]&&r[1].events)||[];wvDrawEvents();
  });
}

/* ---- the page ---- */
function wvBuild(){
  var s=document.getElementById('watch-section');s.textContent='';
  var top=wvEl('div','wvtop');top.id='wvtop';
  var note=wvEl('div');note.id='wvnote';
  var wrap=wvEl('div','wvwrap');
  var left=wvEl('div');left.id='wvleft';
  var right=wvEl('div');right.id='wvright';
  var sp=wvEl('div');sp.id='wvspawns';wvAdd(wrap,left,right);wvAdd(s,top,note,wrap,sp);WV.built=true;
}
function wvDrawTop(){
  var top=document.getElementById('wvtop');if(!top)return;top.textContent='';
  function setting(key,val){return wvPost('/api/settings',(function(){var o={};o[key]=val;return o;})()).then(function(j){if(j&&j.ok===false){WV.msg=j.detail||'could not save the setting';WV.msgErr=true;}return wvGet('/api/settings').then(function(r){if(r&&r.settings)WV.cfg=r.settings;wvDrawTop();wvDrawNote();});});}
  var on=wvCfg('watchers_enabled',false);
  function row(title,help,ctl){var r=wvEl('div','wvset');var a=wvEl('div');a.appendChild(wvEl('b','',title));a.appendChild(wvEl('span','h',help));var c=wvEl('div','ctl');c.appendChild(ctl);r.appendChild(a);r.appendChild(c);return r;}
  var tg=wvEl('label','wvtog');var cb=wvEl('input');cb.type='checkbox';cb.id='wv-master';cb.checked=!!on;cb.onchange=function(){setting('watchers_enabled',cb.checked);};tg.appendChild(cb);tg.appendChild(wvEl('span','',on?'On':'Off'));
  var days=wvEl('input');days.type='number';days.min=0;days.className='wvnum';days.id='wv-prune';days.value=wvCfg('watcher_brief_prune_days',0);days.onchange=function(){setting('watcher_brief_prune_days',Number(days.value)||0);};
  var dw=wvEl('div','wvrow');dw.appendChild(days);dw.appendChild(wvEl('span','wvdef','days (0 keeps them)'));
  var ig=wvEl('label','wvtog');var ic=wvEl('input');ic.type='checkbox';ic.id='wv-ignore';ic.checked=wvCfg('watchers_ignore_self',true)!==false;ic.onchange=function(){setting('watchers_ignore_self',ic.checked);};ig.appendChild(ic);ig.appendChild(wvEl('span','',ic.checked?'On':'Off'));
  wvAdd(top,row('Watchers','Master switch. Nothing below runs while it is off.',tg),row('Prune per-match briefs after','Each match that starts a chat writes a brief to the watchers folder in your Loom data folder.',dw),row('Ignore my own posts','Excludes your Slack user id on every Slack watcher.',ig));
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
  WV.sel=id;WV.firesShown=20;WV.test=null;WV.msg='';WV.confirmDel=false;WV.skipOk=false;WV.dirty=false;WV.editorFor='__none__';
  if(id==='new'){WV.draft=wvBlank();WV.orig=null;}
  else{var w=wvById(id);WV.draft=w?wvDraftOf(w):null;WV.orig=w?wvDraftOf(w):null;}
  wvDrawList();wvDrawEditor();wvLoadEvents();
}
function wvDrawList(){
  var left=document.getElementById('wvleft');if(!left)return;left.textContent='';
  left.appendChild(wvEl('div','wvgrp','Watchers'));
  var ws=WATCH.watchers||[];
  if(!ws.length&&WV.sel!=='new')left.appendChild(wvEl('div','wvempty','No watchers yet. Add one, or start from a template.'));
  var order=[['slack','Slack channels'],['chats','Chats'],['prs','Pull requests']];
  order.forEach(function(g){var gl=ws.filter(function(w){return w.source.kind===g[0];});if(!gl.length)return;var gh=wvEl('div','wvgrp',g[1]);gh.style.margin='12px 0 6px';left.appendChild(gh);gl.forEach(wvRow);});
  function wvRow(w){
    var b=wvEl('button','wvli'+(w.id===WV.sel?' sel':''));b.type='button';b.setAttribute('data-wid',w.id);
    b.appendChild(wvEl('b','',w.label));
    var sm=wvEl('span','wvdef',wvWatches(w));sm.style.display='block';sm.style.margin='0 0 5px';b.appendChild(sm);
    var pl=wvEl('span','pl');
    pl.appendChild(wvEl('span','wvpill '+(w.enabled?'ok':''),w.enabled?'On':'Off'));
    var sn={slack:'Slack',chats:'Chats',prs:'Pull requests'}[w.source.kind]||w.source.kind;
    pl.appendChild(wvEl('span','wvpill',sn));
    pl.appendChild(wvEl('span','wvpill '+(w.run_mode==='shadow'?'warn':'ok'),w.run_mode==='shadow'?'Shadow':'Live'));
    if(w.shadow_unreviewed>0)pl.appendChild(wvEl('span','wvpill rev',w.shadow_unreviewed+' to review'));
    if(w.last_error)pl.appendChild(wvEl('span','wvpill err','Poll error'));
    if(w.skip_permissions)pl.appendChild(wvEl('span','wvpill err','Skip permissions'));
    b.appendChild(pl);b.onclick=function(){wvSelect(w.id);};left.appendChild(b);
  }
  var nb=wvBtn('+ New watcher','',function(){wvSelect('new');});nb.id='wv-new';nb.style.width='100%';nb.style.marginTop='4px';left.appendChild(nb);
  // from template
  var tf=wvEl('div','wvfld');tf.style.marginTop='12px';tf.appendChild(wvEl('label','','Start from a template'));
  var opts=[['','Choose a template...']];
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
  if(dc)dc.disabled=!WV.dirty;
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
    var e=wvEl('div','wvcard');e.appendChild(wvEl('div','wvempty',(WATCH.watchers||[]).length?'Choose a watcher on the left to edit it.':'Add a watcher, or start from a template. A watcher is Source, then Trigger, then Action.'));right.appendChild(e);return;
  }
  var isNew=WV.sel==='new';
  // header card
  var hc=wvEl('div','wvcard');var hr=wvEl('div','wvrow');
  var nm=wvText(function(){return d.label;},function(v){d.label=v;});nm.className='wvname';nm.id='wv-name';hr.appendChild(nm);
  hr.appendChild(wvEl('span','wvpill '+(d.enabled?'ok':''),d.enabled?'On':'Off'));
  var dirty=wvEl('span','wvdirty');dirty.id='wv-dirty';hr.appendChild(dirty);
  if(!isNew){
    hr.appendChild(wvBtn('Duplicate','',function(){wvPost('/api/watchers/duplicate',{id:WV.sel}).then(function(j){if(!j.ok){WV.msg=j.detail||'could not duplicate';WV.msgErr=true;wvSync();return;}wvRefresh().then(function(){WV.dirty=false;wvSelect(j.watcher.id);});});}));
    var en=wvBtn(d.enabled?'Disable':'Enable','',function(){var was=WV.dirty;d.enabled=!d.enabled;WV.dirty=true;wvSave(function(){d.enabled=!d.enabled;WV.dirty=was;wvDrawEditor();wvSync();});});en.id='wv-enable';hr.appendChild(en);
    var del=wvBtn(WV.confirmDel?'Confirm delete':'Delete','danger',function(){if(!WV.confirmDel){WV.confirmDel=true;wvDrawEditor();return;}wvPost('/api/watchers/delete',{id:WV.sel}).then(function(j){if(!j.ok){WV.msg=j.detail||'could not delete';WV.msgErr=true;wvSync();return;}WV.dirty=false;WV.sel='';WV.draft=null;WV.orig=null;wvRefresh().then(function(){var f=(WATCH.watchers||[])[0];if(f)wvSelect(f.id);else{wvDrawList();wvDrawEditor();}});});});del.id='wv-delete';hr.appendChild(del);
  }
  var dis=wvBtn('Discard','',function(){WV.dirty=false;WV.msg='';if(isNew){WV.sel='';WV.draft=null;wvDrawList();wvDrawEditor();return;}var w=wvById(WV.sel);WV.draft=w?wvDraftOf(w):null;WV.orig=w?wvDraftOf(w):null;WV.editorFor='__none__';wvDrawEditor();});dis.id='wv-discard';hr.appendChild(dis);
  var sv=wvBtn('Save','pri',wvSave);sv.id='wv-save';hr.appendChild(sv);
  hc.appendChild(hr);var msg=wvEl('div','wvmsg');msg.id='wv-msg';msg.style.marginTop='6px';hc.appendChild(msg);
  var w0=isNew?null:wvById(WV.sel);
  if(w0&&w0.last_error){var le=wvEl('div','wvmsg err','Last poll failed: '+w0.last_error);le.style.marginTop='4px';hc.appendChild(le);}
  right.appendChild(hc);
  wvDrawSource(right,d);wvDrawTrigger(right,d);wvDrawAction(right,d);wvDrawMode(right,d);wvDrawSafety(right,d);
  if(!isNew){wvDrawTest(right,d);var sh=wvEl('div','wvcard');sh.id='wv-shadow';right.appendChild(sh);var fi=wvEl('div','wvcard');fi.id='wv-fires';right.appendChild(fi);wvDrawEvents();}
  else{var tc=wvEl('div','wvcard');tc.appendChild(wvEl('h4','','Test'));tc.appendChild(wvEl('div','wvdef','Save the watcher first, then Test it against recent items.'));right.appendChild(tc);}
  wvSync();
}
function wvCard(title){var c=wvEl('div','wvcard');c.appendChild(wvEl('h4','',title));return c;}
function wvDrawSource(right,d){
  var c=wvCard('1 - Source');c.id='wv-source';
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
  }else{
    var g3=wvEl('div','wvg2');
    g3.appendChild(wvFld('Repos',wvText(function(){return wvListText(p.repos);},function(v){p.repos=wvList(v);},{ph:'Any repo (owner/name, comma separated)'})));
    g3.appendChild(wvFld('Whose pull requests',wvSel([['yes','Only my own'],['no','Any author in those repos']],p.mine_only===false?'no':'yes',function(v){p.mine_only=v==='yes';})));
    c.appendChild(g3);c.appendChild(wvEl('div','wvdef','Read from the pull request state Loom already caches with gh. Needs gh logged in.'));
  }
  right.appendChild(c);
}
function wvDrawTrigger(right,d){
  var c=wvCard('2 - Trigger');c.id='wv-trigger';
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
  var c=wvCard('3 - Action');c.id='wv-action';
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
  var c=wvCard('4 - Run mode');c.id='wv-mode';
  c.appendChild(wvSeg([['shadow','Shadow'],['live','Live']],d.run_mode,function(m){d.run_mode=m;WV.dirty=true;wvDrawEditor();}));
  var h=wvEl('div','wvdef');h.style.marginTop='6px';h.textContent='Shadow records what would have fired and takes no action. Live performs the action. Start in Shadow, read the list below, then go Live.';c.appendChild(h);
  right.appendChild(c);
}
function wvDrawSafety(right,d){
  var c=wvCard('5 - Safety');c.id='wv-safety';var g=wvEl('div','wvg2');
  g.appendChild(wvFld('Max fires per hour',wvText(function(){return String(d.max_per_hour);},function(v){d.max_per_hour=v===''?0:Number(v);},{num:true,min:0,cls:'wvnum'}),'0 means no cap.'));
  g.appendChild(wvFld('Cooldown per subject (minutes)',wvText(function(){return String(d.cooldown_min);},function(v){d.cooldown_min=v===''?0:Number(v);},{num:true,min:0,cls:'wvnum'}),'The same chat, post or pull request will not fire again within this time. 0 means none.'));
  var q=wvEl('div','wvrow');q.appendChild(wvText(function(){return d.quiet_start;},function(v){d.quiet_start=v.trim();},{ph:'22:00',cls:'wvtime'}));q.appendChild(wvEl('span','wvdef','to'));q.appendChild(wvText(function(){return d.quiet_end;},function(v){d.quiet_end=v.trim();},{ph:'07:00',cls:'wvtime'}));
  g.appendChild(wvFld('Quiet hours (local time, no actions)',q,'HH:MM to HH:MM, or leave both empty. Matches in quiet hours are held, not replayed later.'));
  c.appendChild(g);right.appendChild(c);
}
function wvDrawTest(right,d){
  var c=wvCard('Test');c.id='wv-testcard';var r=wvEl('div','wvrow');
  var lab={slack:'Test against the last 200 posts',chats:'Test against current chats',prs:'Test against current pull request state'}[d.source.kind];
  var b=wvBtn(WV.testing?'Testing...':lab,'pri',function(){wvRunTest();});b.id='wv-test';b.disabled=WV.testing;r.appendChild(b);
  r.appendChild(wvEl('span','wvdef','Runs the rule only, on what is saved plus your unsaved edits. Nothing is started, sent or recorded.'));c.appendChild(r);
  var res=wvEl('div');res.id='wv-testres';res.style.marginTop='10px';c.appendChild(res);right.appendChild(c);wvDrawTestResult();
}
function wvRunTest(){
  var d=WV.draft;if(!d)return;WV.testing=true;WV.test=null;wvDrawTestResult();
  var body={watcher:wvPayload(d)};if(WV.sel!=='new')body.watcher.id=WV.sel;
  wvPost('/api/watchers/test',body).then(function(j){WV.testing=false;WV.test=j;var b=document.getElementById('wv-test');if(b){b.disabled=false;}wvDrawTestResult();});
}
function wvDrawTestResult(){
  var res=document.getElementById('wv-testres');if(!res)return;res.textContent='';
  var b=document.getElementById('wv-test');if(b)b.disabled=WV.testing;
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
  var c=document.getElementById('wvspawns');if(!c)return;c.textContent='';var h=wvEl('div','wvgrp','Workers started');h.style.margin='20px 0 6px';c.appendChild(h);
  var sps=WATCH.spawns||[];if(!sps.length){c.appendChild(wvEl('div','wvdef','Nothing started yet.'));return;}
  var t=wvEl('table','wvt');var hr=wvEl('tr');['When','Event','Watcher','Status',''].forEach(function(x){hr.appendChild(wvEl('th','',x));});t.appendChild(hr);var now=Date.now();
  sps.forEach(function(e){var r=wvEl('tr');r.appendChild(wvEl('td','',wvTimeText(e.detected_at,now)));r.appendChild(wvEventCell(e));var w=wvById(e.watcher_id);r.appendChild(wvEl('td','',w?w.label:e.watcher_id));var td=wvEl('td');td.appendChild(wvEl('span','wvpill '+(e.status==='spawned'?'ok':'warn'),e.status==='spawned'?'Started':e.status));if(e.pane_name)td.appendChild(wvEl('span','wvdef',' '+e.pane_name));r.appendChild(td);var g=wvEl('td');if(e.status==='spawned'&&e.pane_id){var b=wvBtn('go','sm',function(){wvPost('/api/watchers/goto?id='+encodeURIComponent(e.id),{});});g.appendChild(b);}r.appendChild(g);t.appendChild(r);});
  c.appendChild(t);
}
/* ---- entry point, called by dashboard.ts renderWatch() on every render and every 15 s ---- */
function wvRender(){
  if(!WV.built)wvBuild();
  if(!WV.loaded){if(!WV.loading){WV.loading=true;wvLoadStatic().then(function(){wvRender();});}return;}
  if(WV.sel!=='new'&&WV.sel&&!wvById(WV.sel)&&!WV.dirty){WV.sel='';WV.draft=null;}
  if(!WV.sel&&(WATCH.watchers||[]).length){wvSelect(WATCH.watchers[0].id);}
  wvDrawTop();wvDrawNote();wvDrawSpawns();
  wvDrawListKeepFocus();
  if(WV.dirty&&WV.draft)return;
  if(!WV.draft&&WV.sel===''){wvDrawEditor();}
  else if(WV.draft&&!document.getElementById('wv-save'))wvDrawEditor();
  if(WV.sel&&WV.sel!=='new')wvLoadEvents();
}
function wvDrawListKeepFocus(){var a=document.activeElement;if(a&&a.closest&&a.closest('#wvleft'))return;wvDrawList();}
`.split('__WV_TRIGGERS__').join(TRIGGER_JSON);
