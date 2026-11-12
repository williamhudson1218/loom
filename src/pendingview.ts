// The board's Resume, and the "something is on its way" state in the main area
// (src/dashboard.ts inlines this into the page script). Kept apart so tests can
// run it against stub page globals: the view must switch on the click, before
// the request resolves, and a failure must show where the user is looking.
//
// Page globals it uses: $, esc, fetch, DATA, chatKey, mtab, TERM_TOKEN, refresh,
// renderMain, flash, launchVerb, openInBoard, onlyGroup; snapFetch and loomErrorHtml when present.

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
var PENDING=null;   // {label, detail, state: 'error' for a failure, pane: a pane to offer, output: text for Copy details}
var PENDING_LIVE={}; // chatKey -> {pane_id, at}: a resumed chat's pane, before the board sees it running
var PENDING_GEN=0;  // bumped by every setPending, so a poll for a chat stops once the card changed or was dismissed
function setPending(p){PENDING=p||null;PENDING_GEN++;renderPending();}
function dismissPending(){if(PENDING)setPending(null);}
function renderPending(){let el=$('#mpending');if(!PENDING){if(el)el.remove();return;}
  if(!el){el=document.createElement('div');el.id='mpending';$('#chatmain').appendChild(el);}
  const err=PENDING.state==='error';el.className=err?'err':'';
  const acts=err?'<div class="mpacts">'+(PENDING.pane?'<button type="button" class="mbtn" id="mppane" data-pane="'+esc(PENDING.pane)+'">Show the pane</button>':'')+'<button type="button" class="mbtn" id="mpclose">Dismiss</button></div>':'';
  if(err&&typeof loomErrorHtml==='function'){
    el.innerHTML='<div class="mpcard mperr" role="alert"><div style="flex:1;min-width:0">'+loomErrorHtml({title:PENDING.label||'',message:PENDING.detail||'',output:PENDING.output||'',what:PENDING.label||'Open a chat'})+acts+'</div></div>';
  }else{
    el.innerHTML='<div class="mpcard" role="status" aria-live="polite">'+(err?'':'<span class="mpspin"></span>')+'<div style="flex:1;min-width:0"><b>'+esc(PENDING.label||'')+'</b>'+(PENDING.detail?'<span class="mpd">'+esc(PENDING.detail)+'</span>':'')+acts+'</div>'+(err?'':'<button type="button" class="mbtn" id="mpclose" title="Stop waiting (Esc)">Cancel</button>')+'</div>';
  }
  const b=$('#mpclose');if(b)b.onclick=()=>setPending(null);
  const g=$('#mppane');if(g)g.onclick=()=>pendingShowPane(PENDING&&PENDING.pane);}
// Bring a pane up (the resumed chat's own pane, to see why it did not start), then clear the card.
function pendingShowPane(pane){if(!pane)return;fetch('/api/panes/goto?pane='+encodeURIComponent(pane),{method:'POST',headers:{'x-loom-term-token':TERM_TOKEN}}).then(r=>r.json()).then(j=>{if(j&&j.ok)setPending(null);else if(PENDING)setPending(Object.assign({},PENDING,{detail:(PENDING.detail||'')+' The pane could not be shown: '+((j&&j.detail)||'no such pane')+'.'}));}).catch(()=>{});}
// Dismiss is also caught at the document, in the capture phase: it clears the card however the
// card was rebuilt or whatever sits over it. Escape and a click outside the card clear any card,
// waiting or failed, so it can never hold the view.
if(typeof document!=='undefined'&&document.addEventListener&&!window.__loomPendingWired){window.__loomPendingWired=1;
  document.addEventListener('click',function(e){const t=e.target;if(!PENDING||!t||!t.closest)return;
    if(t.closest('#mpclose')){setPending(null);return;}
    if(t.closest('#mppane'))return;
    if(!t.closest('.mpcard'))setPending(null);},true);
  document.addEventListener('keydown',function(e){if(e.key==='Escape')dismissPending();},true);}
function pendingLiveFor(c){const k=chatKey(c);const p=PENDING_LIVE[k];if(!p)return null;
  if(DATA.live[k]||Date.now()-p.at>60000){delete PENDING_LIVE[k];return null;}
  return {pane_id:p.pane_id,tmux_session:'',window_index:'',pane_index:'',name:'',pending:true};}
function pickBeacon(id,event,fields){try{fetch('/api/pick-log',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,event,fields})}).catch(()=>{});}catch(e){}}
// app/main.ts: the Slack hotkey is opening something that will land here.
window.loomPending=function(p){setPending(p&&p.label?p:null);return true;};
// app/main.ts: a jump was requested; pick it up now rather than on the next 5 s poll.
window.loomFocusNow=function(){return refresh().then(function(){setPending(null);return true;});};
// app/main.ts: the hotkey resumed a chat into a pane; open that pane now.
// How long a resumed chat may take to reach the board before the card says it did not.
var PENDING_WAIT_MS=25000;
// What a pane says when the chat it was resumed into exited at once.
var PENDING_DEAD=/No conversation found|command not found|no such file or directory/i;
function pendingScreenTail(snap){if(!snap||typeof snap.screen!=='string')return '';
  const lines=snap.screen.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g,'').replace(/\x1b\][^\x07]*\x07/g,'').split(/\r?\n/).map(l=>l.replace(/\s+$/,'')).filter(Boolean);
  return lines.slice(-12).join('\n');}
// how: 'started' for a chat the Slack hotkey just started (its session id is known up front), which
// waits the same way, and polls faster than the board's 5 s refresh so it opens as soon as it is live.
window.loomOpenResumed=function(agent,sid,pane,retried,how){const verb=how==='started'?'started':'resumed';
  const find=function(){return DATA.chats.find(x=>x.session_id===sid&&x.agent===agent);};
  const open=function(){
    if(pane)PENDING_LIVE[agent+':'+sid]={pane_id:pane,at:Date.now()};
    const q=$('#q');if(q&&q.value)q.value='';onlyGroup=null;
    openInBoard(sid,agent);if(TERM_TOKEN)mtab='terminal';renderMain();setPending(null);
    setTimeout(refresh,1500);return true;};
  if(find())return open();
  // The chat is not on the board yet: a resumed chat is only seen once its process shows up, a few
  // seconds on. Say "Opening…" and keep looking, up to PENDING_WAIT_MS; the call returns now so the
  // hotkey's pick is not held open for the wait. The pane is read each round too, so a chat that
  // exited at once (claude --resume on a session it cannot find) fails at once, with its output.
  setPending({label:'Opening this chat…',detail:'Waiting for it to appear on the board.'});
  const gen=PENDING_GEN;const t0=Date.now();const short=String(sid||'').slice(0,8);
  const fail=function(why,tail){setPending({label:'This chat did not open',state:'error',pane:pane||'',output:tail||'',
    detail:why+(pane?' Loom '+verb+' session '+short+' in pane '+pane+'; the pane shows what happened.':' Loom '+verb+' session '+short+'.')});};
  const peek=function(){return pane&&typeof snapFetch==='function'?Promise.resolve(snapFetch(pane)).catch(function(){return null;}).then(pendingScreenTail):Promise.resolve('');};
  const look=function(){if(gen!==PENDING_GEN)return;
    Promise.resolve(refresh()).catch(function(){}).then(function(){if(gen!==PENDING_GEN)return;
      if(find()){open();return;}
      return peek().then(function(tail){if(gen!==PENDING_GEN)return;
        if(find()){open();return;}
        if(tail&&PENDING_DEAD.test(tail)){fail('The chat exited as soon as it started.',tail);return;}
        if(Date.now()-t0>PENDING_WAIT_MS){fail('It did not appear on the board within '+Math.round(PENDING_WAIT_MS/1000)+' seconds.',tail);return;}
        setTimeout(look,1500);});});};
  look();return true;};
`;
