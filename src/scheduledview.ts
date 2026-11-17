// The Scheduled tab: everything Loom will do without a person starting it, across every chat.
// Action steps (one-shot, owned by the chat that added them) come from GET /api/actions/scheduled,
// grouped by what they wait on; the watchers (standing, recurring) are listed below them with their
// next check. Run and Remove reuse the Actions panel's routes, so the rules are the panel's.

export const SCHED_VIEW_CSS = `
  .tab.schedtab.on { background:#23344a; color:#bcd8f5; }
  .tab.schedtab.on:hover { background:#2b405a; }
  #sched-section { display:none; padding:0 20px 24px; }
  .sc-row { display:flex; align-items:flex-start; gap:12px; }
  .sc-row .sc-main { flex:1; min-width:0; }
  .sc-row .sc-title { font-size:13px; color:#e6e9f2; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sc-row .sc-sub { font-size:12px; color:#8b93a7; margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sc-row .sc-why { font-size:11px; color:#6f778a; margin-top:2px; }
  .sc-row .sc-when { font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace; color:#bcd8f5; white-space:nowrap; padding-top:1px; }
  .sc-row .sc-btns { display:flex; gap:6px; flex-shrink:0; }
  .sc-row .sc-btns button { font-size:11px; padding:3px 8px; border-radius:5px; border:1px solid #2e3446; background:#171b27; color:#c9cfdd; cursor:pointer; }
  .sc-row .sc-btns button:hover { background:#1f2433; }
  .sc-row .sc-btns button.danger { color:#f0a5a5; }
  .emrow.sc-att { border-left-color:var(--waiting_on_user); }
  .emrow.sc-clock { border-left-color:#5c8fd6; }
  .emrow.sc-queued { opacity:.7; }
  .emrow.sc-off { opacity:.55; }
  .sc-empty { font-size:12px; color:#6f778a; padding:6px 2px; }
`;

export const SCHED_VIEW_HTML = `
<section id="sched-section" aria-label="Scheduled">
  <p class="emhint" style="margin-top:14px">Everything Loom will do without you starting it. Each step belongs to the chat that added it, and wakes that chat when it fires. Watchers run on their own.</p>
  <div id="sched-body"><div class="sc-empty">Loading.</div></div>
</section>
`;

/** Pure helpers, exported for tests and embedded in the page. */
export const SCHED_PURE_JS = `
var SCHED_ATT={held:1,failed:1,due:1};
// Needs you (held, failed, due) | At a time (clock steps, soonest first) | Waiting on an event (current steps) | Queued (behind an earlier step).
function schedGroups(steps){var g={needs:[],timed:[],waiting:[],queued:[]};
  (steps||[]).forEach(function(s){if(SCHED_ATT[s.status])g.needs.push(s);else if(s.trigger_type==='clock')g.timed.push(s);else if(s.current)g.waiting.push(s);else g.queued.push(s);});
  g.timed.sort(function(a,b){return a.at-b.at;});
  var bySess=function(a,b){return a.session_id<b.session_id?-1:a.session_id>b.session_id?1:a.position-b.position;};
  g.needs.sort(bySess);g.waiting.sort(bySess);g.queued.sort(bySess);return g;}
// "in 14h 5m", "in 3m", "now" for a time that has passed (it fires on the next tick).
function schedIn(at,now){var d=at-now;if(d<=0)return 'now';var m=Math.round(d/60000);if(m<1)return 'in <1m';if(m<60)return 'in '+m+'m';var h=Math.floor(m/60);m=m%60;if(h<48)return 'in '+h+'h'+(m?' '+m+'m':'');return 'in '+Math.round(h/24)+'d';}
function schedBadge(steps){return (steps||[]).filter(function(s){return SCHED_ATT[s.status];}).length;}
`;

export const SCHED_VIEW_JS = `
${SCHED_PURE_JS}
var SCHED={steps:[],watchers:[],loaded:false,at:0,busy:false,err:''};
function schedLoad(force){if(SCHED.busy)return;if(!force&&Date.now()-SCHED.at<5000)return;SCHED.busy=true;
  fetch('/api/actions/scheduled').then(function(r){return r.json();}).then(function(j){SCHED.busy=false;SCHED.at=Date.now();if(!j||!j.ok){SCHED.err='could not load';}else{SCHED.err='';SCHED.steps=j.steps||[];SCHED.watchers=j.watchers||[];SCHED.loaded=true;}renderTabs();if(tab==='sched')renderSched();})
  .catch(function(){SCHED.busy=false;SCHED.err='Loom server not reachable';if(tab==='sched')renderSched();});}
function schedChat(sid){return (DATA.chats||[]).find(function(c){return c.session_id===sid;})||null;}
function schedChatLabel(sid){var c=schedChat(sid);if(!c)return 'ended chat';var L=DATA.live[chatKey(c)];return disp(c)+(L&&L.name?' · '+L.name:'')+(L?'':' · not running');}
function schedStepRow(s,now){var cls=SCHED_ATT[s.status]?' sc-att':s.trigger_type==='clock'?' sc-clock':'';if(!s.current&&!SCHED_ATT[s.status])cls+=' sc-queued';
  var when=s.trigger_type==='clock'?'<div class="sc-when" title="'+esc(new Date(s.at).toLocaleString())+'">'+esc(schedIn(s.at,now))+'</div>':'';
  var why=s.status_why||(!s.current?'after the step before it in this chat':'');
  var run=s.status==='due'?'<button type="button" data-sc="run">Run</button>':'';
  return '<div class="emrow sc-row'+cls+'" data-step="'+esc(s.id)+'" data-sid="'+esc(s.session_id)+'">'+when+'<div class="sc-main"><div class="sc-title">'+esc(s.title)+'</div><div class="sc-sub">'+esc(s.summary)+' · '+esc(schedChatLabel(s.session_id))+'</div>'+(why?'<div class="sc-why">'+esc(why)+'</div>':'')+'</div>'+
    '<div class="sc-btns">'+run+'<button type="button" data-sc="open">Open chat</button><button type="button" class="danger" data-sc="remove">Remove</button></div></div>';}
function schedWatchRow(w,now){var next=w.enabled?(w.next_poll_at?'next check '+schedIn(w.next_poll_at,now):'watching continuously'):'off';
  return '<div class="emrow sc-row'+(w.enabled?'':' sc-off')+(w.last_error?' w-err':' w-on')+'"><div class="sc-main"><div class="sc-title">'+esc(w.label)+'</div><div class="sc-sub">'+esc(w.source)+' · '+(w.run_mode==='live'?'live':'shadow')+' · '+esc(next)+'</div>'+(w.last_error?'<div class="sc-why">'+esc(w.last_error)+'</div>':'')+'</div><div class="sc-btns"><button type="button" data-sc="watch">Open</button></div></div>';}
function schedSec(title,rows,empty){return '<div class="emtop"><h2 class="emtitle">'+esc(title)+' <span class="bcnt">'+rows.length+'</span></h2></div><div class="emfeed">'+(rows.length?rows.join(''):'<div class="sc-empty">'+esc(empty)+'</div>')+'</div>';}
function renderSched(){schedLoad(false);var b=$('#sched-body');if(!b)return;
  if(!SCHED.loaded){b.innerHTML='<div class="sc-empty">'+esc(SCHED.err||'Loading.')+'</div>';return;}
  var now=Date.now();var g=schedGroups(SCHED.steps);var r=function(s){return schedStepRow(s,now);};
  var html=(g.needs.length?schedSec('Needs you',g.needs.map(r),''):'')+
    schedSec('At a time',g.timed.map(r),'No timed steps. A chat adds one with loom action add --when at:07:00.')+
    schedSec('Waiting on an event',g.waiting.map(r),'Nothing is waiting on a PR, a reply or a draft.')+
    (g.queued.length?schedSec('Queued behind another step',g.queued.map(r),''):'')+
    schedSec('Watchers',SCHED.watchers.map(function(w){return schedWatchRow(w,now);}),'No watchers.');
  if(b.dataset.html!==html){b.dataset.html=html;b.innerHTML=html;}}
document.addEventListener('click',function(e){var bt=e.target.closest&&e.target.closest('#sched-body button[data-sc]');if(!bt)return;var a=bt.dataset.sc;
  if(a==='watch'){tab='watch';syncControls();render();return;}
  var row=bt.closest('[data-step]');if(!row)return;var sid=row.dataset.sid,id=row.dataset.step;
  if(a==='open'){var c=schedChat(sid);if(c)openInBoard(c.session_id,c.agent);else selectOrch();return;}
  if(a==='run'||a==='remove'){bt.disabled=true;postJ('/api/actions/'+a,{id:id}).then(function(j){if(!j.ok)toast(j.detail||'failed','#8a2b2e');else if(a==='remove')toast('step removed');schedLoad(true);setTimeout(refresh,300);}).catch(function(){toast('Loom server not reachable','#8a2b2e');bt.disabled=false;});}});
`;
