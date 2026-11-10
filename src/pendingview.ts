// The board's Resume, and the "something is on its way" state in the main area
// (src/dashboard.ts inlines this into the page script). Kept apart so tests can
// run it against stub page globals: the view must switch on the click, before
// the request resolves, and a failure must show where the user is looking.
//
// Page globals it uses: $, esc, fetch, DATA, chatKey, mtab, TERM_TOKEN, refresh,
// renderMain, flash, launchVerb, openInBoard, onlyGroup.

export const PENDING_VIEW_JS = String.raw`
function doLaunch(sid,sourceAgent,lane,el,p,action,proj,selectedAgent){const busy=action==='branch'?'branching…':(sourceAgent===selectedAgent?'resuming…':'starting new…');const okmsg=action==='branch'?'branched ✓':(sourceAgent===selectedAgent?'resumed ✓':'started fresh ✓');
  // A resume switches the view now and says so; the reply names the pane, which opens at once
  // (the board only sees the chat live a few seconds later).
  const resuming=action==='resume'&&sourceAgent===selectedAgent;const t0=Date.now();const trace='r'+t0.toString(36);
  p.innerHTML='<span class="muted">'+busy+'</span>';if(resuming){setPending({label:'Resuming…',detail:'Opening a window for this chat.'});pickBeacon(trace,'resume-click',{});}
  fetch('/'+action+'?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(selectedAgent)+'&lane='+encodeURIComponent(lane)+(proj?'&proj='+encodeURIComponent(proj):'')+'&trace='+trace,{method:'POST'}).then(r=>r.json()).then(j=>{
    if(resuming)pickBeacon(trace,'resume-reply',{ms:Date.now()-t0,ok:!!j.ok,pane:j.pane_id||''});
    if(!j.ok&&j.reason==='no_pane'){setPending(null);p.innerHTML='<span class="muted">No empty panes found. Open a new pane/window in tmux, then click '+esc(launchVerb(action,sourceAgent,selectedAgent))+' again.</span>';return;}
    p.dataset.open='';p.innerHTML='';
    if(!j.ok){flash(el,j.detail||'failed','#8a2b2e');if(resuming){setPending({label:'Could not resume this chat',detail:j.detail||'failed',state:'error'});pickBeacon(trace,'resume-failed',{ms:Date.now()-t0});}refresh();return;}
    flash(el,okmsg,'#1f6f3f');
    if(resuming&&j.pane_id){PENDING_LIVE[selectedAgent+':'+sid]={pane_id:j.pane_id,at:Date.now()};if(TERM_TOKEN)mtab='terminal';}
    setPending(null);renderMain();if(resuming)pickBeacon(trace,'resume-view',{ms:Date.now()-t0,terminal:mtab==='terminal'});
    refresh();setTimeout(refresh,1500);setTimeout(refresh,3500);}).catch(()=>{p.innerHTML='<span class="muted">server off?</span>';if(resuming)setPending({label:'Could not resume this chat',detail:'The Loom server did not answer.',state:'error'});});}
// ---- Opening / resuming states -------------------------------------------------
// The main area says what is happening the moment a chat is asked for (Resume here, or
// the Slack hotkey from app/main.ts), so a click is never followed by nothing.
var PENDING=null;   // {label, detail, state: 'error' for a failure}
var PENDING_LIVE={}; // chatKey -> {pane_id, at}: a resumed chat's pane, before the board sees it running
function setPending(p){PENDING=p||null;renderPending();}
function renderPending(){let el=$('#mpending');if(!PENDING){if(el)el.remove();return;}
  if(!el){el=document.createElement('div');el.id='mpending';$('#chatmain').appendChild(el);}
  const err=PENDING.state==='error';el.className=err?'err':'';
  el.innerHTML='<div class="mpcard" role="status" aria-live="polite">'+(err?'':'<span class="mpspin"></span>')+'<div style="flex:1;min-width:0"><b>'+esc(PENDING.label||'')+'</b>'+(PENDING.detail?'<span class="mpd">'+esc(PENDING.detail)+'</span>':'')+'</div>'+(err?'<button type="button" class="mbtn" id="mpclose">Dismiss</button>':'')+'</div>';
  const b=$('#mpclose');if(b)b.onclick=()=>setPending(null);}
function pendingLiveFor(c){const k=chatKey(c);const p=PENDING_LIVE[k];if(!p)return null;
  if(DATA.live[k]||Date.now()-p.at>60000){delete PENDING_LIVE[k];return null;}
  return {pane_id:p.pane_id,tmux_session:'',window_index:'',pane_index:'',name:'',pending:true};}
function pickBeacon(id,event,fields){try{fetch('/api/pick-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,event,fields})}).catch(()=>{});}catch(e){}}
// app/main.ts: the Slack hotkey is opening something that will land here.
window.loomPending=function(p){setPending(p&&p.label?p:null);return true;};
// app/main.ts: a jump was requested; pick it up now rather than on the next 5 s poll.
window.loomFocusNow=function(){return refresh().then(function(){setPending(null);return true;});};
// app/main.ts: the hotkey resumed a chat into a pane; open that pane now.
window.loomOpenResumed=function(agent,sid,pane,retried){
  const c=DATA.chats.find(x=>x.session_id===sid&&x.agent===agent);
  if(!c){if(retried){setPending({label:'Resumed, but that chat is not on the board yet',detail:'It opens here once it is indexed.',state:'error'});return false;}
    return refresh().then(function(){return window.loomOpenResumed(agent,sid,pane,true);});}
  if(pane)PENDING_LIVE[agent+':'+sid]={pane_id:pane,at:Date.now()};
  const q=$('#q');if(q&&q.value)q.value='';onlyGroup=null;
  openInBoard(sid,agent);if(TERM_TOKEN)mtab='terminal';renderMain();setPending(null);
  setTimeout(refresh,1500);return true;};
`;
