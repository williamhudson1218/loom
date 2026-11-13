// The update affordance in the header and the Settings › Updates section.
//
// Server side: src/routes/update.ts (GET /api/update, POST /api/update/check,
// POST /api/update/apply), backed by src/updater.ts through app/main.ts. The
// header shows nothing until a verified update is ready; then a quiet "Update
// ready" button whose menu has "Restart to update".

export const UPDATE_VIEW_CSS = String.raw`
  .updsel[hidden] { display:none !important; }
  button.updbtn { display:inline-flex; align-items:center; gap:6px; height:32px; box-sizing:border-box; padding:0 11px; background:rgba(110,162,255,.10); border:1px solid #34406a; border-radius:8px; color:#9cc0ff; font-size:12.5px; font-weight:600; white-space:nowrap; }
  button.updbtn:hover, button.updbtn[aria-expanded="true"] { background:rgba(110,162,255,.18); color:#fff; }
  button.updbtn svg { flex:none; }
  #updmenu { min-width:300px; padding:6px; }
  #updmenu .updv { color:#d4d9e6; font-size:13px; font-weight:600; padding:6px 9px 2px; }
  #updmenu .updn { color:#7f879b; font-size:11.5px; line-height:1.45; padding:0 9px 6px; }
  #updmenu .updnl { list-style:none; margin:8px 0 0; padding:0 0 0 9px; border-left:2px solid #34406a; max-height:150px; overflow:auto; }
  #updmenu .updnl li { margin:0 0 4px; padding:0; color:#9aa2b6; font-size:11.5px; }
  #updmenu .updnl li:last-child { margin-bottom:0; }
  #updmenu .upderr { color:#ff8a8e; font-size:11.5px; padding:2px 9px 6px; }
  #updmenu .updsep { height:1px; margin:4px 3px 6px; background:#2b3040; }
  #updmenu button[data-upd] { align-items:flex-start; gap:10px; padding:8px 9px; margin-top:2px; cursor:pointer; }
  #updmenu button[data-upd][disabled] { opacity:.5; cursor:default; }
  #updmenu button[data-upd] .ck { width:16px; margin-top:1px; text-align:center; color:#9cc0ff; font-size:14px; line-height:1.2; }
  #updmenu button[data-upd] .mi { font-weight:500; }
  #settings-section .updnotes { margin:6px 0 0 18px; padding:0; color:var(--sx-text2); font-size:12.5px; }
  #settings-section .updnotes li { margin:2px 0; }
`;

const ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"></path><path d="M7 10l5 5 5-5"></path><path d="M5 20h14"></path></svg>';

/** Goes in the header's .actions, before the gear. */
export const UPDATE_HEADER_HTML = `<div class="moresel updsel" id="updwrap" hidden>
        <button type="button" id="updbtn" class="updbtn" aria-haspopup="menu" aria-expanded="false" aria-controls="updmenu" title="A new version of Loom is downloaded and verified">${ICON}<span>Update ready</span></button>
        <div class="hmenu" id="updmenu" role="menu" aria-label="Update"></div>
      </div>`;

export const UPDATE_VIEW_JS = String.raw`
// ---- Updates (src/updateview.ts) --------------------------------------------------
var UPD=null,UPD_T=0,UPD_POLL=0,UPD_ASKED=false;
var UPD_BUSY=['checking','downloading','verifying'];
if(typeof HMENUS!=='undefined')HMENUS.push('updmenu');
function updEsc(s){return esc(String(s==null?'':s));}
function updBusy(s){return !!(s&&UPD_BUSY.indexOf(s.status)>=0);}
/* Every state the page learns (GET, the check's answer, a push from the main
   process) goes through here: header, Settings, the toast a click asked for,
   and a 1s poll while a check runs (the fallback when nothing is pushed). */
function updSet(j){if(!j||!j.state)return;UPD=j;var s=j.state;updHeader();
  if(typeof tab!=='undefined'&&tab==='settings'&&typeof SX!=='undefined'&&SX.sec==='updates'&&typeof sxRerender==='function')sxRerender();
  if(UPD_ASKED&&!updBusy(s)){UPD_ASKED=false;
    if(s.status==='current')toast("You're on the latest version ("+s.current+')');
    else if(s.status==='ready'&&s.ready)toast('Loom '+s.ready.version+' is ready to install');
    else if(s.status==='error')toast(s.detail||'Could not check for updates','#8a2b2e');
    else if(s.detail)toast(s.detail);}
  var busy=updBusy(s);if(busy&&!UPD_POLL)UPD_POLL=setInterval(updLoad,1000);else if(!busy&&UPD_POLL){clearInterval(UPD_POLL);UPD_POLL=0;}}
function updLoad(){return fetch('/api/update').then(function(r){return r.json();}).then(function(j){updSet(j);return j;}).catch(function(){return null;});}
function updNotes(n,cls){n=(n||[]).slice(0,8);return n.length?'<ul class="'+cls+'">'+n.map(function(x){return '<li>'+updEsc(x)+'</li>';}).join('')+'</ul>':'';}
function updHeader(){var w=$('#updwrap');if(!w)return;var s=UPD&&UPD.state;var show=!!(s&&(s.status==='ready'||s.status==='applying'));w.hidden=!show;if(!show)return;
  var b=$('#updbtn');if(b){var lab=b.querySelector('span');if(lab)lab.textContent=s.status==='applying'?'Restarting':'Update ready';b.title=s.ready?'Loom '+s.ready.version+' is downloaded and verified':'';}
  var m=$('#updmenu');if(!m)return;var r=s.ready||{};
  m.innerHTML='<div class="updv">Loom '+updEsc(r.version||'')+'</div><div class="updn">You have '+updEsc(s.current)+'. Chats keep running in tmux while Loom restarts.'+updNotes(r.notes,'updnl')+'</div><div class="updsep"></div>'+
   (s.writable?'':'<div class="upderr">Loom cannot replace itself where it is installed. See Settings, Updates.</div>')+
   '<button type="button" role="menuitem" data-upd="apply"'+(s.writable&&s.status==='ready'?'':' disabled')+'><span class="ck">↻</span><span class="mi">Restart to update<span class="hint">Installed now, then Loom opens again</span></span></button>'+
   '<button type="button" role="menuitem" data-upd="later"><span class="ck">◷</span><span class="mi">Later<span class="hint">Installed the next time Loom quits</span></span></button>';}
function updApply(btn){if(btn)btn.disabled=true;return fetch('/api/update/apply',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json();}).then(function(j){if(!j.ok){toast(j.detail||'Could not install the update','#8a2b2e');if(btn)btn.disabled=false;updLoad();return;}toast('Installing Loom '+(j.version||'')+'. Loom will open again.');if(UPD&&UPD.state)UPD.state.status='applying';updHeader();}).catch(function(){/* the server going away is the restart */});}
function updCheck(btn){UPD_ASKED=true;
  /* Show Checking now, in the state every re-render reads, so the board's 5s
     re-render cannot put the idle button back while the check runs. */
  var cur=(UPD&&UPD.state)||{};var st={};for(var k in cur)st[k]=cur[k];st.status='checking';st.detail=null;st.progress=null;
  updSet({ok:true,state:st});if(typeof sxRerender==='function')sxRerender(true);
  return fetch('/api/update/check',{method:'POST',headers:{'content-type':'application/json'},body:'{}'}).then(function(r){return r.json();}).then(function(j){updSet(j);}).catch(function(){UPD_ASKED=false;toast('Could not reach Loom','#8a2b2e');updLoad();});}
function wireUpdates(){var b=$('#updbtn');if(b)b.onclick=function(e){e.stopPropagation();hmenuToggle('updmenu');};
  var m=$('#updmenu');if(m)m.addEventListener('click',function(e){var t=e.target.closest('[data-upd]');if(!t||t.disabled)return;hmenuClose();if(t.dataset.upd==='apply')updApply(t);});
  /* Subscribe before the first read, so a change in between is not missed. */
  if(window.loomNative&&typeof window.loomNative.onUpdateState==='function')window.loomNative.onUpdateState(function(st){updSet({ok:true,state:st});});
  updLoad();UPD_T=setInterval(updLoad,60000);}

/* Settings › Updates (called from settingsview.ts's sxBody) */
function updBusyLabel(s){if(s.status==='checking')return 'Checking…';if(s.status==='verifying')return 'Verifying '+((s.latest&&s.latest.version)||'');
  return 'Downloading '+((s.latest&&s.latest.version)||'')+(s.progress!=null?' '+s.progress+'%':'');}
function sxUpdatesStatus(){var s=UPD&&UPD.state;if(!s)return ['off','Checking'];
  if(s.status==='disabled')return ['off','Off'];if(updBusy(s))return ['off',updBusyLabel(s)];if(s.status==='ready')return ['warn','Update ready'];if(s.status==='applying')return ['warn','Installing'];
  if(s.status==='error')return ['warn','Problem'];if(s.status==='current')return ['ok','Up to date'];return ['ok',s.current];}
function sxUpdates(){if(!UPD){updLoad();return '<p class="sxempty">loading…</p>';}var s=UPD.state||{};
  var ver=sxPill('off','Loom '+(s.current||'?'))+'<span class="def">'+sxEsc(s.channel==='release'?'Release build':'Built locally')+(s.commit?' · <code>'+sxEsc(String(s.commit).slice(0,12))+'</code>':'')+'</span>';
  var st;if(s.status==='disabled')st=sxPill('off','Not available');else if(updBusy(s))st=sxPill('off',updBusyLabel(s));
  else if(s.status==='ready')st=sxPill('warn','Loom '+s.ready.version+' is ready');else if(s.status==='applying')st=sxPill('warn','Installing');else if(s.status==='current')st=sxPill('ok','Up to date ('+s.current+')');else if(s.status==='error')st=sxPill('err','Problem');else st=sxPill('off','Not checked yet');
  var off=s.status==='disabled';
  var h=sxRow('Version','The version running now, and the commit it was built from.',ver)+
   sxRow('Status',s.detail?sxEsc(s.detail):'New releases are published on GitHub when the Loom repo changes.',st+(off?'':sxBtn('updcheck',updBusy(s)?'Checking…':'Check for updates',{dis:updBusy(s)||s.status==='applying'}))+(s.status==='ready'?sxBtn('updapply','Restart to update',{pri:true,dis:!s.writable}):'')+(s.status==='error'&&typeof lerrCopyBtn==='function'?lerrCopyBtn({what:'Check for Loom updates',message:s.detail||'The update check failed.'}):''))+
   sxRow('Last checked','Loom checks soon after it opens and every 4 hours.',s.lastChecked?sxPill('off',sxAgo(s.lastChecked))+'<span class="def">'+sxEsc(sxWhen(s.lastChecked))+'</span>':sxPill('off','Never'));
  if(!off)h+=sxKey('auto_update',{title:'Update automatically',help:'Downloads and verifies new releases in the background, and installs a ready one when you click Restart to update or the next time Loom quits.'});
  if(!off&&s.app&&!s.writable)h+=sxNote('Loom cannot replace itself in <code>'+sxEsc(s.app.replace(/\/[^\/]+$/,''))+'</code> because that folder is not writable. Move Loom to Applications or ~/Applications, or install new versions by hand from the Releases page.','warn');
  var la=s.lastApply;if(la)h+=sxRow('Last install',la.ok?'':'The previous version was put back, so Loom kept working.',sxPill(la.ok?'ok':'err',la.ok?'Updated to '+la.to:'Update to '+la.to+' failed')+'<span class="def">'+sxEsc((la.ok?'':la.detail+' · ')+sxWhen(la.at))+'</span>'+(!la.ok&&typeof lerrCopyBtn==='function'?lerrCopyBtn({what:'Install the Loom update to '+la.to,message:la.detail||'',output:la.log||''}):''));
  var notes=(s.ready&&s.ready.notes)||(s.latest&&s.latest.notes)||[];var nv=(s.ready&&s.ready.version)||(s.latest&&s.latest.version);
  if(notes.length&&nv)h+=sxGrp('What is in '+nv)+updNotes(notes,'updnotes');
  h+='<div class="def" style="margin-top:12px">Releases: <code>github.com/williamhudson1218/loom/releases</code></div>';
  return h;}
function sxUpdatesAct(a,btn){if(a==='updcheck')updCheck(btn);else if(a==='updapply')updApply(btn);}
`;
