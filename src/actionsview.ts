// The Actions tab in the chat's right rail (src/outboxview.ts owns the rail itself).
// A chat's steps are a short checklist, each a trigger and an action. The panel reads
// them with GET /api/actions and edits them through the /api/actions/* writes
// (src/routes/actions.ts); the evaluator that fires steps runs on the server.
// Plain browser JS in strings, embedded verbatim by dashboard.ts. String.raw, no dollar-brace.

export const ACTIONS_VIEW_CSS = String.raw`
  .orh2 .ortabs { display:flex; gap:2px; min-width:0; flex-wrap:wrap; }
  .orh2 .ortab { display:flex; align-items:center; gap:6px; padding:3px 9px; border-radius:6px; font-size:12px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:#8a90a2; background:transparent; }
  .orh2 .ortab:hover { color:#e4e7ee; background:#1b2233; }
  .orh2 .ortab.on { color:#a9c6ff; background:#1b2744; }
  .orh2 .ortab .obadge { margin-left:0; font-size:10px; padding:1px 6px; }
  .orh2 .ortab .obadge.att { background:#b9770e; }
  #outcards.acts { gap:8px; }
  .act-empty { color:#8a90a2; font-size:12px; padding:4px 2px; }
  .act-row { background:#161a24; border:1px solid #232634; border-radius:8px; padding:9px 10px; display:flex; flex-direction:column; gap:5px; min-width:0; }
  .act-row.final .act-title { color:#8a90a2; text-decoration:line-through; }
  .act-head { display:flex; align-items:flex-start; gap:8px; min-width:0; }
  .act-title { flex:1 1 auto; min-width:0; color:#e6e6e6; font-size:13px; line-height:1.35; overflow-wrap:anywhere; }
  .act-pill { flex:0 0 auto; font-size:10px; font-weight:600; letter-spacing:.04em; text-transform:uppercase; padding:1px 7px; border-radius:10px; background:#23262f; color:#8a90a2; }
  .act-pill.st-due { background:rgba(110,162,255,.16); color:#8fb4ff; }
  .act-pill.st-running { background:rgba(224,192,74,.16); color:#e0c04a; }
  .act-pill.st-held { background:rgba(232,184,75,.16); color:#e8b84b; }
  .act-pill.st-failed { background:rgba(240,113,120,.16); color:#f07178; }
  .act-pill.st-done { background:rgba(86,211,100,.14); color:#56d364; }
  .act-pill.st-removed { background:#23262f; color:#6d7384; }
  .act-sum { color:#8a90a2; font-size:11px; overflow-wrap:anywhere; }
  .act-why { color:#d9b36a; font-size:11px; overflow-wrap:anywhere; }
  .act-err { color:#f07178; font-size:11px; }
  .act-btns { display:flex; flex-wrap:wrap; align-items:center; gap:6px; }
  .act-btns button, .act-link, .act-add button { font-size:11px; padding:3px 9px; border-radius:6px; background:#1f2740; color:#bcd0ff; }
  .act-btns button:hover, .act-link:hover, .act-add button:hover { background:#2a3a63; color:#fff; }
  .act-btns button[data-act="remove"] { background:transparent; color:#8a90a2; margin-left:auto; }
  .act-btns button[data-act="remove"]:hover { color:#f07178; background:#2a1d22; }
  .act-btns .act-sw { display:flex; align-items:center; gap:6px; background:transparent; color:#8a90a2; padding:3px 2px; }
  .act-sw .trk { width:24px; height:14px; border-radius:7px; background:#2b3040; position:relative; flex:0 0 auto; }
  .act-sw .trk::after { content:''; position:absolute; top:2px; left:2px; width:10px; height:10px; border-radius:50%; background:#8a90a2; transition:left .12s ease; }
  .act-sw[aria-checked="true"] { color:#bcd0ff; }
  .act-sw[aria-checked="true"] .trk { background:#3b6fe0; }
  .act-sw[aria-checked="true"] .trk::after { left:12px; background:#fff; }
  .act-link { align-self:flex-start; }
  .act-row.act-removed { flex-direction:row; align-items:center; gap:8px; color:#8a90a2; font-size:12px; }
  .act-add { display:flex; gap:6px; margin-top:2px; }
  .act-add input { flex:1 1 auto; min-width:0; background:#0f1219; border:1px solid #232634; border-radius:6px; color:#e6e6e6; font-size:12px; padding:5px 8px; }
  .act-add input:focus { outline:none; border-color:#3b6fe0; }
  .chp.ac { background:#1b2a4d; color:#bcd0ff; }
  .chp.ac.d-turn { background:rgba(110,162,255,.16); color:#8fb4ff; }
  @media (max-width:900px) {
    .orh2 { flex-wrap:wrap; }
    .act-btns button[data-act="remove"] { margin-left:0; }
  }
`;

export const ACTIONS_PURE_JS = String.raw`
var STEP_PILL={waiting:'Waiting',due:'Due',running:'Running',held:'Held',done:'Done',failed:'Failed',removed:'Removed'};
function stepPill(status){return {label:STEP_PILL[status]||String(status||''),cls:'st-'+status};}
function stepFinal(s){return s.status==='done'||s.status==='removed';}
// Which of the row's buttons show: check (manual triggers), run (due), retry (failed or held),
// the ask-first switch (any open step), remove (any open step). A done or removed row has none.
function stepButtons(s){if(stepFinal(s))return [];var b=[];
  if(s.trigger_type==='manual')b.push('check');
  if(s.status==='due')b.push('run');
  if(s.status==='failed'||s.status==='held')b.push('retry');
  b.push('askfirst','remove');return b;}
function stepNeedsYou(s){return s.status==='due'||s.status==='held'||s.status==='failed';}
function countOf(x){return Array.isArray(x)?x.length:(Number(x)||0);}
// Default tab: Actions when any step needs a look, else the tab last picked for the chat
// (if it has anything in it), else Outbox when there are drafts, else Actions.
function railTab(drafts,steps,remembered){var ss=Array.isArray(steps)?steps:[];
  if(ss.some(stepNeedsYou))return 'actions';
  if(remembered==='actions'&&countOf(steps)>0)return 'actions';
  if(remembered==='outbox'&&countOf(drafts)>0)return 'outbox';
  return countOf(drafts)>0?'outbox':'actions';}
`;

export const ACTIONS_VIEW_JS = String.raw`
var STEPS={},STEPS_AT={},ACT_PICK={},ACT_UNDO={},ACT_ERR={},ACT_TIMER=null;
function actSid(){if(homeSel||orchSel||tsel||!sel||sel.arch)return '';return sel.sid||'';}
// The selected chat's steps that count toward the rail: not removed, or removed within the 10 s undo window.
function railSteps(){const sid=actSid();if(!sid)return [];const now=Date.now();return (STEPS[sid]||[]).filter(function(s){return s.status!=='removed'||(ACT_UNDO[s.id]||0)>now;});}
function actOpen(list){return (list||[]).filter(function(s){return !stepFinal(s);}).length;}
function actLoad(sid){if(!sid)return;const t=Date.now();if(STEPS_AT[sid]&&t-STEPS_AT[sid]<1000)return;STEPS_AT[sid]=t;
  fetch('/api/actions?session='+encodeURIComponent(sid)).then(function(r){return r.json();}).then(function(j){if(!j||!j.ok)return;
    const changed=JSON.stringify(j.steps)!==JSON.stringify(STEPS[sid]||null);STEPS[sid]=j.steps;if(changed)renderOutbox();}).catch(function(){});}
// Load the chat's steps when first selected, and again when the board's count disagrees with what the panel holds.
function actSync(){const sid=actSid();if(!sid)return;const have=STEPS[sid];const a=(DATA.actions||{})[sid];
  if(!have||actOpen(have)!==(a?a.open:0))actLoad(sid);}
function actTabKey(k){return 'loom.actions.tab.'+k;}
function actTabLoad(k){try{return localStorage.getItem(actTabKey(k))||'';}catch(e){return '';}}
function actTabSave(k,t){try{localStorage.setItem(actTabKey(k),t);}catch(e){}}
function actTab(ds,as){const k=selKey();return ACT_PICK[k]||railTab(ds,as,actTabLoad(k));}
function actBusy(rail){const i=rail&&rail.querySelector('.act-add input');return !!(i&&i===document.activeElement&&i.value);}
function actPollSync(){const want=!document.hidden&&railSteps().length>0;
  if(want&&!actPoll)actPoll=setInterval(function(){const sid=actSid();if(sid&&!document.hidden){STEPS_AT[sid]=0;actLoad(sid);}},1500);
  else if(!want&&actPoll){clearInterval(actPoll);actPoll=null;}}
var actPoll=null;
function actChip(c){const a=(DATA.actions||{})[c.session_id];if(!a||!a.open)return '';
  return '<span class="chp ac'+(a.attention?' d-turn':'')+'" title="'+esc(a.open+' open step'+(a.open===1?'':'s')+(a.attention?', one needs you':''))+'">'+a.open+' step'+(a.open===1?'':'s')+'</span>';}
function railHeadHtml(tab,ds,as){const open=actOpen(as);const att=as.some(stepNeedsYou);
  return '<div class="orh2"><div class="ortabs" role="tablist" aria-label="Chat side panel">'+
    '<button type="button" role="tab" class="ortab'+(tab==='actions'?' on':'')+'" data-otab="actions" aria-selected="'+(tab==='actions')+'">Actions<span class="obadge'+(att?' att':'')+'">'+open+'</span></button>'+
    '<button type="button" role="tab" class="ortab'+(tab==='outbox'?' on':'')+'" data-otab="outbox" aria-selected="'+(tab==='outbox')+'">Outbox<span class="obadge">'+ds.length+'</span></button></div>'+
    '<span class="sp"></span><button type="button" data-rail="close" title="collapse" aria-label="Collapse the side panel">›</button></div>';}
function stepBtnHtml(a,s){
  if(a==='askfirst')return '<button type="button" class="act-sw" role="switch" aria-checked="'+(s.ask_first?'true':'false')+'" data-act="askfirst" title="Ask me before this runs"><span class="trk" aria-hidden="true"></span>Ask first</button>';
  if(a==='check')return '<button type="button" data-act="check" title="Mark done">Check off</button>';
  if(a==='run')return '<button type="button" data-act="run" title="Run this step now">Run now</button>';
  if(a==='retry')return '<button type="button" data-act="retry" title="Try this step again">Retry</button>';
  return '<button type="button" data-act="remove" title="Remove this step" aria-label="Remove this step">Remove</button>';}
function stepRowHtml(s){
  if(s.status==='removed')return '<div class="act-row act-removed" data-step="'+esc(s.id)+'"><span>Removed · </span><button type="button" class="act-link" data-act="undo">Undo</button></div>';
  const p=stepPill(s.status);const draft=s.action_type==='send_draft'&&s.action_params?s.action_params.draft_id:'';
  return '<div class="act-row'+(stepFinal(s)?' final':'')+'" data-step="'+esc(s.id)+'"><div class="act-head"><span class="act-title">'+esc(s.title)+'</span><span class="act-pill '+p.cls+'">'+esc(p.label)+'</span></div>'+
    '<div class="act-sum">'+esc(stepLine(s))+'</div>'+(s.status_why?'<div class="act-why">'+esc(s.status_why)+'</div>':'')+(ACT_ERR[s.id]?'<div class="act-err" role="alert">'+esc(ACT_ERR[s.id])+'</div>':'')+
    (s.status==='held'&&draft?'<button type="button" class="act-link" data-act="draft" data-draft="'+esc(draft)+'">Open the draft in the outbox</button>':'')+
    '<div class="act-btns">'+stepButtons(s).map(function(a){return stepBtnHtml(a,s);}).join('')+'</div></div>';}
function actionsBodyHtml(as){const rows=as.length?as.map(stepRowHtml).join(''):'<div class="act-empty">No steps yet.</div>';
  return '<div id="outcards" class="acts">'+rows+'<form class="act-add" data-actadd><input type="text" maxlength="300" placeholder="Add a step" aria-label="Add a step"><button type="submit">Add</button></form></div>';}
// The browser's stepSummary: the same trigger -> action line the CLI prints (src/actions.ts), from the fields the panel has.
function stepLine(s){const p=s.trigger_params||{};let w;
  switch(s.trigger_type){case 'now':w='Now';break;case 'manual':w='To do';break;
    case 'pr_merged':w='When PR #'+p.number+' merges';break;case 'pr_shipped':w='When '+p.repo+'#'+p.number+' ships';break;
    case 'slack_reply':w='When '+(p.from?String(p.from):'someone')+' replies';break;case 'draft_sent':w='When draft '+p.draft_id+' is sent';break;default:w='';}
  const bare=(s.trigger_type==='now'||s.trigger_type==='manual')&&s.action_type==='none';
  const ph={none:'none',send_draft:'send draft',wake_chat:'wake the chat'};
  return bare?w:w+' → '+(ph[s.action_type]||s.action_type);}
function actPost(path,body,sid){return postJ('/api/actions/'+path,body).then(function(j){
    if(!j.ok&&body.id)ACT_ERR[body.id]=j.detail||'failed';else if(body.id)delete ACT_ERR[body.id];
    STEPS_AT[sid]=0;actLoad(sid);renderOutbox();setTimeout(refresh,300);return j;}).catch(function(){});}
function actGoDraft(id){const k=selKey();ACT_PICK[k]='outbox';actTabSave(k,'outbox');railRender();
  setTimeout(function(){const el=document.querySelector('#outcards .draft[data-id="'+id+'"]');if(el&&el.scrollIntoView)el.scrollIntoView({block:'nearest'});},30);}
function actClick(e){
  const tb=e.target.closest('button[data-otab]');if(tb){const k=selKey();ACT_PICK[k]=tb.dataset.otab;actTabSave(k,tb.dataset.otab);railRender();return;}
  const b=e.target.closest('[data-act]');if(!b)return;const row=b.closest('[data-step]');const sid=actSid();
  if(b.dataset.act==='draft'){actGoDraft(b.dataset.draft);return;}
  if(!row||!sid)return;const id=row.dataset.step;const a=b.dataset.act;
  if(a==='remove'){ACT_UNDO[id]=Date.now()+10000;if(ACT_TIMER)clearTimeout(ACT_TIMER);ACT_TIMER=setTimeout(renderOutbox,10100);}
  if(a==='askfirst'){actPost('ask-first',{id:id,on:b.getAttribute('aria-checked')!=='true'},sid);return;}
  if(a==='undo')delete ACT_UNDO[id];
  actPost(a,{id:id},sid);}
function actSubmit(e){const f=e.target.closest&&e.target.closest('form[data-actadd]');if(!f)return;e.preventDefault();
  const inp=f.querySelector('input');const title=inp.value.trim();const sid=actSid();if(!title||!sid)return;inp.value='';
  actPost('add',{session:sid,title:title},sid).then(function(){const i=document.querySelector('#outrail .act-add input');if(i)i.focus();});}
function wireActions(){const box=$('#outrail');if(!box)return;box.addEventListener('click',actClick);box.addEventListener('submit',actSubmit);}
`;
