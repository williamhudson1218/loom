// The orchestrator's view in the dashboard (design §8, mockup "orch"): a pinned
// entry at the top of the sidebar with a "N need you" badge, and, when it is
// selected, the conversation on the left (its transcript, interleaved with what
// Loom did for it) and the status rail on the right, rendered from
// orchestrator_items. Plain browser JS in strings, embedded verbatim by
// dashboard.ts, the same way chatmenu.ts is. String.raw so nothing here needs
// double escaping; it must never contain a dollar-brace.

export const ORCH_VIEW_CSS = String.raw`
  #orchpin:empty { display:none; }
  .ovh { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; }
  .opin { display:flex; gap:8px; align-items:center; width:calc(100% - 16px); height:34px; margin:6px 8px 4px; padding:0 10px; border-radius:8px; border:1px solid #232634; background:#121622; color:inherit; text-align:left; cursor:pointer; font:inherit; font-size:13px; }
  .opin:hover { background:#161b2a; }
  .opin.sel { background:#1a2033; border-color:#34406a; }
  .opin .oic { flex:0 0 16px; height:16px; display:flex; align-items:center; justify-content:center; }
  .opin .ot { font-weight:600; flex:0 0 auto; }
  .opin .os { font-size:12px; color:#8a90a2; display:flex; align-items:center; gap:6px; white-space:nowrap; min-width:0; }
  .opin .os.on { color:#7fd18b; }
  .odot { width:6px; height:6px; border-radius:3px; background:#4a5060; flex:none; }
  .odot.on { background:#7fd18b; }
  .obadge { flex:0 0 auto; margin-left:auto; font-size:11px; font-weight:600; padding:2px 8px; border-radius:10px; background:#3b6fe0; color:#fff; white-space:nowrap; }
  #chatmain.orch > :not(#orchview) { display:none !important; }
  #orchview { display:none; flex:1 1 auto; min-height:0; flex-direction:column; }
  #chatmain.orch #orchview { display:flex; }
  #ohead { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:12px 20px; border-bottom:1px solid #232634; }
  .mpill.rc { background:#15301d; color:#9fe0aa; display:inline-flex; align-items:center; gap:5px; }
  .mpill.rc.off { background:#23262f; color:#9aa3b2; }
  #obanner:empty { display:none; }
  #obanner { margin:14px 20px 0; }
  .obody { flex:1 1 auto; min-height:0; display:flex; overflow:hidden; }
  #oconvo { flex:999 1 460px; min-width:0; min-height:0; display:flex; flex-direction:column; border-right:1px solid #232634; }
  #omsgs { flex:1 1 auto; min-height:0; overflow-y:auto; padding:16px 20px; display:flex; flex-direction:column; gap:9px; }
  #omsgs .msg { max-width:88%; flex:none; }
  #ofilt { flex:none; display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:10px 20px 0; }
  #ofilt .ochip { height:26px; padding:0 10px; border-radius:13px; border:1px solid #2b2f40; background:transparent; color:#8a90a2; font:inherit; font-size:12px; cursor:pointer; }
  #ofilt .ochip.on { background:#1b2440; border-color:#3a4f8f; color:#c9d6ff; }
  #ofilt .ochip i { font-style:normal; opacity:.7; margin-left:4px; }
  #osearch { flex:1 1 120px; min-width:90px; max-width:220px; height:26px; padding:0 10px; border-radius:13px; border:1px solid #2b2f40; background:#0c0e15; color:#c4ccdc; font:inherit; font-size:12px; }
  #omsgs .oearlier { align-self:center; flex:none; }
  /* display:flex above beats the hidden attribute: without this the messages stay up and squeeze the terminal. */
  #omsgs[hidden], #oterm[hidden], #ofilt[hidden] { display:none; }
  #oterm { flex:1 1 auto; min-height:0; margin:14px 20px; padding:6px 0 0 8px; border-radius:10px; border:1px solid #232634; background:#07080c; overflow:hidden; }
  .olog { align-self:center; max-width:92%; font-size:11.5px; line-height:1.45; color:#8a90a2; text-align:center; overflow-wrap:anywhere; }
  .olog b { color:#c4ccdc; font-weight:600; }
  .olog.ev { color:#a7b0c4; }
  .olog.bad { color:#f09a9f; }
  .oinput { padding:12px 20px; border-top:1px solid #232634; display:flex; gap:8px; align-items:center; }
  .oinput input { flex:1 1 auto; min-width:0; height:40px; box-sizing:border-box; border-radius:10px; border:1px solid #2a2f40; background:#151925; color:#e4e7ee; padding:0 12px; font:inherit; }
  .oinput .mbtn { height:40px; }
  #orail { flex:1 1 320px; min-width:0; padding:16px; display:flex; flex-direction:column; gap:18px; overflow-y:auto; background:#0d1016; }
  .orsec { display:flex; flex-direction:column; gap:8px; }
  .orh { font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:#8a90a2; }
  .orh.nd { color:#a9c6ff; }
  .ocard { padding:10px 12px; border-radius:10px; border:1px solid #2c3a63; background:#121a2e; display:flex; flex-direction:column; gap:6px; }
  .oct { display:flex; justify-content:space-between; gap:8px; }
  .oct b { font-weight:600; }
  .oct span, .omv .oag { font-size:11px; color:#8a90a2; white-space:nowrap; }
  .ocw { font-size:12px; line-height:1.5; color:#c4c9d6; }
  .ocbtns { display:flex; gap:6px; flex-wrap:wrap; }
  .ocbtn { height:28px; padding:0 10px; border-radius:7px; border:1px solid #3a4a7a; background:transparent; color:#cfe0ff; cursor:pointer; font-size:12px; }
  .ocbtn:hover { background:#18223c; }
  .ocbtn.q { border-color:#2a2f40; color:#a3a9b8; }
  .obl { font-size:12px; line-height:1.5; color:#c4c9d6; }
  .obl b { color:#e4e7ee; }
  .omv { display:flex; gap:8px; align-items:flex-start; padding:6px 0; border-bottom:1px solid #1a1d27; }
  .omv .sdot { margin-top:5px; }
  .omv .omb { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px; font-size:12px; }
  .omv .omb span:last-child { color:#8a90a2; }
  .omv.link { cursor:pointer; }
  .odn { font-size:12px; line-height:1.5; color:#a3a9b8; display:flex; gap:6px; }
  .odn i { color:#7fd18b; font-style:normal; }
  .ocl summary { cursor:pointer; list-style:none; }
  .ocl .odn { color:#7d8394; }
  .ocl .odn i { color:#7d8394; }
  .oempty { font-size:12px; color:#6f778a; }
  @media (max-width:900px) { #ohead, #omsgs, .oinput { padding-left:14px; padding-right:14px; } .obody { flex-direction:column; overflow:auto; } #oconvo { flex:none; height:70vh; border-right:0; border-bottom:1px solid #232634; } #orail { flex:none; overflow:visible; } }
`;

export const ORCH_VIEW_HTML = String.raw`<div id="orchview" aria-label="Orchestrator">
  <div id="ohead"></div>
  <div id="obanner"></div>
  <div class="obody">
    <section id="oconvo" aria-label="Conversation">
      <div id="ofilt"><span id="ochips"></span><input id="osearch" type="search" autocomplete="off" placeholder="Search the feed" aria-label="Search the feed"/></div>
      <div id="omsgs"></div>
      <div id="oterm" hidden></div>
      <div class="oinput"><label for="oinput" class="ovh">Message the orchestrator</label><input id="oinput" type="text" autocomplete="off" placeholder="Ask where anything stands, or tell an agent what to do"/><button type="button" class="mbtn pri" id="osend">Send</button></div>
    </section>
    <aside id="orail" aria-label="Status"></aside>
  </div>
</div>`;

export const ORCH_VIEW_JS = String.raw`
// ---- Orchestrator ----------------------------------------------------------------
var orchSel=false,ORCH=null,orchTimer=null,OMSG_SIG='',orchTermOn=false,ORCH_STORE=[],ORCH_KEYS={},ORCH_MORE=null,ORCH_LOADING=false;
var ORCH_F={conv:true,relay:false,ev:false,sys:false,q:''};try{const sv=JSON.parse(localStorage.getItem('loom.orchFilt')||'{}');['conv','relay','ev','sys'].forEach(k=>{if(typeof sv[k]==='boolean')ORCH_F[k]=sv[k];});}catch(e){}
var ORCH_PAGE=120;
var ORCH_SVG='<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8fb4ff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><circle cx="4" cy="5" r="1.6"></circle><circle cx="20" cy="5" r="1.6"></circle><circle cx="4" cy="19" r="1.6"></circle><circle cx="20" cy="19" r="1.6"></circle><path d="M5.3 6.2l4.6 4M18.7 6.2l-4.6 4M5.3 17.8l4.6-4M18.7 17.8l-4.6-4"></path></svg>';
var PHONE_SVG='<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2"></rect><path d="M11 18h2"></path></svg>';
function orchInfo(){return DATA.orch||{};}
function orchStatusText(o){if(o.enabled===false)return 'Off';return o.live?'Remote control on':'Not running';}
function orchPinText(o){if(o.enabled===false)return 'Off';return o.live?'Running':'Not running';}
function orchPinHtml(o,selected){const n=o.needsYou||0;
  return '<button type="button" class="opin'+(selected?' sel':'')+'" data-orch="1" aria-label="Orchestrator, '+esc(orchPinText(o))+(n?', '+n+' need you':'')+'"><span class="oic">'+ORCH_SVG+'</span><span class="ot">Orchestrator</span><span class="os'+(o.live?' on':'')+'"><span class="odot'+(o.live?' on':'')+'"></span>'+esc(orchPinText(o))+'</span>'+(n?'<span class="obadge">'+n+' need you</span>':'')+'</button>';}
function renderOrchPin(){const el=$('#orchpin');if(!el)return;const h=orchPinHtml(orchInfo(),orchSel);if(el.dataset.h!==h){el.dataset.h=h;el.innerHTML=h;}}
function selectOrch(){leaveHome();leaveColumns();leaveTerminal();if(tab!=='board'&&tab!=='saved'){tab='board';stateFilter='all';syncControls();liveToggle();chips();render();}
  if(sel)deselect();orchSel=true;OMSG_SIG='';$('#ohead').dataset.sig='';$('#orail').dataset.sig='';renderOrchPin();renderMain();loadOrch(true);
  clearInterval(orchTimer);orchTimer=setInterval(()=>{if(!document.hidden)loadOrch(false);},4000);setTimeout(()=>{const i=$('#oinput');if(i&&!orchTermOn)i.focus();},0);}
function leaveOrch(){if(!orchSel)return;orchSel=false;clearInterval(orchTimer);orchTimer=null;if(termKey.indexOf('orch|')===0)closeTerm();orchTermOn=false;renderOrchPin();}
function loadOrch(toBottom){fetch('/api/orch').then(r=>r.json()).then(j=>{if(!orchSel||!j.ok)return;ORCH=j;orchMerge(ORCH_STORE,ORCH_KEYS,j.messages);if(ORCH_MORE===null)ORCH_MORE=(j.messages||[]).length>=ORCH_PAGE;DATA.orch=Object.assign({},DATA.orch||{},{needsYou:j.needsYou,live:j.live,enabled:j.enabled,sessionId:j.sessionId});renderOrchPin();renderOrch(toBottom);}).catch(()=>{});}
function hhmm(ms){if(!ms)return '';const d=new Date(ms);return String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');}
// Conversation + Loom's own log, by time. An event batch is already in the
// transcript as a user turn, so its log row is skipped; it renders as a line.
var OLOG_TXT={relay:'Sent to',queued:'Queued for',delivered:'Delivered to',failed:'Not sent to',started:'',ask:'',cleared:'Cleared'};
// The client keeps every turn it has seen (the 4 s tail plus any pages loaded on demand), so a
// tail that slides forward never leaves a gap behind an earlier page.
function orchMerge(store,keys,msgs){let n=0;(msgs||[]).forEach(m=>{const k=(m.at||0)+'|'+m.role+'|'+(m.text||'').length+'|'+(m.text||'').slice(0,40);if(keys[k])return;keys[k]=1;store.push(m);n++;});if(n)store.sort((a,b)=>(a.at||0)-(b.at||0));return n;}
function orchTimeline(o,store){const out=[];(store||o.messages||[]).forEach((m,i)=>out.push({t:m.at||0,i:i,m:m}));
  (o.log||[]).forEach(l=>{if(l.kind==='events'||l.kind==='ask')return;out.push({t:l.at,i:1e6+l.id,l:l});});
  out.sort((a,b)=>(a.t-b.t)||(a.i-b.i));return out;}
function orchMsgHtml(x){if(x.l){const l=x.l;
    if(l.kind==='started')return '<div class="olog">'+hhmm(l.at)+' · '+esc(l.text)+'</div>';
    return '<div class="olog'+(l.kind==='failed'?' bad':'')+'">'+hhmm(l.at)+' · '+OLOG_TXT[l.kind]+' <b>'+esc(l.target)+'</b>'+(l.kind==='queued'?' (you were looking at it)':'')+': '+esc(l.text)+'</div>';}
  const m=x.m;const t=m.text||'';
  if(m.role==='user'&&t.indexOf('[Loom events]')===0)return '<div class="olog ev">'+esc(t.replace('[Loom events]','Loom events ·').split(' -- ')[0])+'</div>';
  if(m.role==='user'&&(t.indexOf('Loom started you')===0||t.indexOf('Loom restarted you')===0))return '<div class="olog">'+hhmm(m.at)+' · '+esc(t.split('.')[0])+'</div>';
  return '<div class="msg '+m.role+'"><div class="who">'+(m.role==='user'?'You':'Orchestrator')+(m.at?' · '+hhmm(m.at):'')+'</div>'+esc(t)+'</div>';}
// Which filter chip a feed row belongs to. Failed relays are problems, so they ignore the chips.
function orchRowKind(x){if(x.l){const k=x.l.kind;return k==='failed'?'failed':k==='started'?'sys':'relay';}
  const m=x.m,t=m.text||'';if(m.role==='user'&&t.indexOf('[Loom events]')===0)return 'ev';
  if(m.role==='user'&&(t.indexOf('Loom started you')===0||t.indexOf('Loom restarted you')===0))return 'sys';return 'conv';}
function orchRowText(x){return x.l?((x.l.target||'')+' '+(x.l.text||'')):(x.m.text||'');}
function orchRowShown(x,f){const k=orchRowKind(x);if(k!=='failed'&&!f[k])return false;
  const q=(f.q||'').trim().toLowerCase();return !q||orchRowText(x).toLowerCase().indexOf(q)>=0;}
function orchCounts(tl){const c={conv:0,relay:0,ev:0,sys:0,failed:0};tl.forEach(x=>{c[orchRowKind(x)]++;});return c;}
function orchChipsHtml(c,f){const chip=(k,label,n)=>'<button type="button" class="ochip'+(f[k]?' on':'')+'" data-ofilt="'+k+'" aria-pressed="'+(f[k]?'true':'false')+'">'+label+'<i>'+n+'</i></button>';
  return chip('conv','Conversation',c.conv)+chip('relay','Relays',c.relay)+chip('ev','Loom events',c.ev)+chip('sys','System',c.sys)+(c.failed?'<span class="olog bad" style="align-self:center">'+c.failed+' failed relay'+(c.failed>1?'s':'')+' always shown</span>':'');}
function orchSaveFilt(){try{localStorage.setItem('loom.orchFilt',JSON.stringify({conv:ORCH_F.conv,relay:ORCH_F.relay,ev:ORCH_F.ev,sys:ORCH_F.sys}));}catch(e){}}
function orchLoadEarlier(){if(ORCH_LOADING||!ORCH_STORE.length)return;const first=ORCH_STORE.find(m=>m.at);if(!first)return;ORCH_LOADING=true;
  fetch('/api/orch?before='+first.at+'&limit='+ORCH_PAGE).then(r=>r.json()).then(j=>{ORCH_LOADING=false;if(!j.ok)return;orchMerge(ORCH_STORE,ORCH_KEYS,j.messages);ORCH_MORE=!!j.more;const w=$('#omsgs'),h=w.scrollHeight,t=w.scrollTop;OMSG_SIG='';renderOrch(false);w.scrollTop=t+(w.scrollHeight-h);}).catch(()=>{ORCH_LOADING=false;});}
function orchJumpLabel(i){return i.ref_type==='chat'?'Open chat':i.ref_type==='pr'?'Open PR':i.ref_type==='slack'?'Open Slack thread':'';}
function orchItemChat(i){if(i.ref_type!=='chat')return null;const k=i.ref_id;const c=DATA.chats.find(x=>chatKey(x)===k||x.session_id===k);return c||null;}
function orchRailHtml(o){const items=o.items||[];const open=items.filter(i=>!i.resolved_at);
  const nd=open.filter(i=>i.kind==='needs_you'),bl=open.filter(i=>i.kind==='blocked'),mv=open.filter(i=>i.kind==='moving'),dn=items.filter(i=>i.kind==='done'&&i.resolved_at),cl=items.filter(i=>i.kind!=='done'&&i.resolved_at&&i.resolved_why);
  const sec=(cls,label,n,body,empty)=>'<div class="orsec"><div class="orh'+cls+'">'+label+(n===null?'':' · '+n)+'</div>'+(body||'<div class="oempty">'+empty+'</div>')+'</div>';
  const needs=nd.map(i=>{const j=orchJumpLabel(i);return '<div class="ocard"><div class="oct"><b>'+esc(i.title)+'</b><span>'+esc(rel(i.opened_at))+'</span></div>'+(i.why?'<div class="ocw">'+esc(i.why)+'</div>':'')+
    '<div class="ocbtns">'+(j?'<button type="button" class="ocbtn" data-jump="'+i.id+'">'+(i.ref_type==='pr'?brandIcon('github'):i.ref_type==='slack'?brandIcon('slack'):'')+j+'</button>':'')+'<button type="button" class="ocbtn q" data-resolve="'+i.id+'" title="close this item">Resolve</button></div></div>';}).join('');
  const blocked=bl.map(i=>'<div class="obl"><b>'+esc(i.who||i.title)+'</b>: '+esc(i.why||i.title)+'</div>').join('');
  const extra=(o.moving||[]).map(m=>({id:0,title:m.title,who:m.pane,why:m.stage||'Working',ref_type:'chat',ref_id:m.chat,updated_at:0}));
  const all=mv.concat(extra);
  const moving=all.map(i=>'<div class="omv'+(i.ref_type?' link':'')+'"'+(i.ref_type==='chat'?' data-chat="'+esc(i.ref_id)+'"':'')+'><span class="sdot d-working"></span><span class="omb"><span><b>'+esc(i.who||'agent')+'</b> · '+esc(i.title)+'</span><span>'+esc(i.why||'')+'</span></span><span class="oag">'+(i.updated_at?esc(rel(i.updated_at)):'')+'</span></div>').join('');
  const done=dn.map(i=>'<div class="odn"><i>✓</i><span>'+esc(i.title)+(i.why?' · '+esc(i.why):'')+'</span></div>').join('');
  const cleared=cl.length?'<details class="orsec ocl"><summary class="orh">Cleared today · '+cl.length+'</summary>'+cl.map(i=>'<div class="odn"><i>–</i><span>'+esc(i.title)+' · '+esc(i.resolved_why)+'</span></div>').join('')+'</details>':'';
  return sec(' nd','Needs you',nd.length,needs,'Nothing needs you.')+sec('','Blocked on others',bl.length,blocked,'Nothing is waiting on anyone else.')+sec('','Moving',all.length,moving,'No agent is working.')+sec('','Done today',null,done,'Nothing finished yet today.')+cleared;}
function orchHeadHtml(o){const on=!!o.live;
  return '<div class="mh-l"><div class="mh-t"><h1>Orchestrator</h1><span class="mpill rc'+(on?'':' off')+'">'+PHONE_SVG+esc(orchStatusText(o))+'</span></div><div class="mh-sub">Watches every chat, PR and Slack thread Loom knows about. Messages your phone only when something needs you.</div></div>'+
    '<div class="mh-r"><button type="button" class="mbtn" data-oa="notify" title="notify on a new Needs you item">Notify: '+(o.notify==='off'?'Off':'Needs you only')+'</button>'+
    '<button type="button" class="mbtn" data-oa="phone"'+(o.remoteUrl?'':' disabled title="'+(on?'the Remote Control link is not on its screen':'not running')+'"')+'>Copy phone link</button>'+
    '<button type="button" class="mbtn'+(orchTermOn?' on':'')+'" data-oa="term"'+(o.paneExists&&TERM_TOKEN?'':' disabled')+' title="the session itself, for anything it asks on screen">Terminal</button>'+'</div>';}
function orchBannerHtml(o){if(o.live)return '';if(o.enabled===false)return '<div class="banner"><div class="bt"><b>The orchestrator is off</b><span>It was turned off in settings (orchestrator_enabled = 0, or LOOM_ORCHESTRATOR=0).</span></div></div>';
  if(!o.supervised)return '<div class="banner"><div class="bt"><b>The orchestrator is not running</b><span>The Loom app starts it; this server only serves its data.</span></div></div>';
  const st=o.startState;
  if(st==='prompt')return '<div class="banner"><div class="bt"><b>Waiting on a first-run question</b><span>'+esc(o.prompt||'')+'</span></div>'+(o.paneExists&&TERM_TOKEN?'<button type="button" class="mbtn pri" data-oa="show">Show it</button>':'')+'</div>';
  if(st==='starting')return '<div class="banner"><div class="bt"><b>Starting</b><span>Loom launched the orchestrator in a window of its own; it is not up yet.</span></div></div>';
  return '<div class="banner"><div class="bt"><b>'+(o.gaveUp?'The orchestrator keeps exiting':'The orchestrator exited, restarting')+'</b><span>'+(o.gaveUp?'It exited too many times in a short window; Loom will not restart it until Loom restarts.':'Loom restarts it in a window of its own on the next check.')+(o.status&&o.status.detail&&o.gaveUp?' '+esc(o.status.detail)+'.':'')+'</span></div></div>';}
function renderOrch(toBottom){const o=ORCH;if(!o){$('#omsgs').innerHTML='<p class="muted">loading…</p>';return;}
  const h=orchHeadHtml(o);if($('#ohead').dataset.sig!==h){$('#ohead').dataset.sig=h;$('#ohead').innerHTML=h;}
  const b=orchBannerHtml(o);if($('#obanner').dataset.sig!==b){$('#obanner').dataset.sig=b;$('#obanner').innerHTML=b;}
  const r=orchRailHtml(o);if($('#orail').dataset.sig!==r){$('#orail').dataset.sig=r;$('#orail').innerHTML=r;}
  const showTerm=orchTermOn&&o.paneExists&&TERM_TOKEN&&o.paneId;
  $('#oterm').hidden=!showTerm;$('#omsgs').hidden=!!showTerm;$('#ofilt').hidden=!!showTerm;
  if(showTerm){const k='orch|'+o.paneId;if(termKey!==k){openTerm(o.paneId,$('#oterm'));termKey=k;}return;}
  if(termKey.indexOf('orch|')===0)closeTerm();
  const tl=orchTimeline(o,ORCH_STORE);const last=tl.length?tl[tl.length-1]:null;const f=ORCH_F;
  const ch=orchChipsHtml(orchCounts(tl),f);if($('#ochips').dataset.sig!==ch){$('#ochips').dataset.sig=ch;$('#ochips').innerHTML=ch;}
  const sig=tl.length+':'+(last?(last.l?last.l.id:(last.m.text||'').length):0)+'|'+(f.conv?1:0)+(f.relay?1:0)+(f.ev?1:0)+(f.sys?1:0)+f.q+'|'+(ORCH_MORE?1:0);
  const wrap=$('#omsgs');const atBottom=wrap.scrollTop+wrap.clientHeight>=wrap.scrollHeight-50;
  if(sig!==OMSG_SIG||toBottom){OMSG_SIG=sig;const shown=tl.filter(x=>orchRowShown(x,f));
    wrap.innerHTML=(ORCH_MORE?'<button type="button" class="mbtn oearlier" data-oearlier="1">Load earlier</button>':'')+(shown.map(orchMsgHtml).join('')||'<p class="muted">'+(tl.length?'Nothing matches these filters.':(o.live?'No messages yet. Ask it where things stand.':'No conversation yet.'))+'</p>');}
  if(toBottom||atBottom)wrap.scrollTop=wrap.scrollHeight;}
function orchSend(){const i=$('#oinput');const t=i.value.trim();if(!t)return;i.value='';
  postJ('/api/orch/send',{text:t}).then(j=>{if(!j.ok){i.value=t;toast(j.detail||'could not send','#8a2b2e');return;}setTimeout(()=>loadOrch(true),600);setTimeout(()=>loadOrch(true),2500);}).catch(()=>{i.value=t;toast('server off','#8a2b2e');});}
function orchJump(i){if(!i)return;
  if(i.ref_type==='chat'){const c=orchItemChat(i);if(c){openInBoard(c.session_id,c.agent);}else toast('that chat is no longer on the board','#8a2b2e');return;}
  if(i.ref_type==='pr'&&/^https:\/\/github\.com\//.test(i.ref_id)){window.open(i.ref_id,'_blank','noopener');return;}
  if(i.ref_type==='slack'&&/^https:\/\/[\w-]+\.slack\.com\//.test(i.ref_id)){window.open(i.ref_id,'_blank','noopener');return;}
  toast('nothing to open','#8a2b2e');}
function askOrchestrator(c){postJ('/api/orch/ask',{session:c.session_id,agent:c.agent}).then(j=>{if(!j.ok){toast(j.detail||'could not ask','#8a2b2e');return;}toast('asked the orchestrator');selectOrch();}).catch(()=>toast('server off','#8a2b2e'));}
function wireOrch(){
  $('#orchpin').addEventListener('click',e=>{if(e.target.closest('[data-orch]'))selectOrch();});
  $('#ofilt').addEventListener('click',e=>{const b=e.target.closest('[data-ofilt]');if(!b)return;const k=b.dataset.ofilt;ORCH_F[k]=!ORCH_F[k];orchSaveFilt();if(ORCH)renderOrch(false);});
  $('#osearch').addEventListener('input',e=>{ORCH_F.q=e.target.value;if(ORCH)renderOrch(false);});
  $('#omsgs').addEventListener('click',e=>{if(e.target.closest('[data-oearlier]'))orchLoadEarlier();});
  $('#osend').onclick=orchSend;$('#oinput').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();orchSend();}});
  [$('#ohead'),$('#obanner')].forEach(el=>el.addEventListener('click',e=>{const b=e.target.closest('button[data-oa]');if(!b||b.disabled||!ORCH)return;const a=b.dataset.oa;
    if(a==='notify'){const mode=ORCH.notify==='off'?'needs_you':'off';postJ('/api/orch/notify',{mode}).then(j=>{if(j.ok){ORCH.notify=j.notify;renderOrch(false);toast(j.notify==='off'?'notifications off':'notifying on Needs you only');}}).catch(()=>toast('server off','#8a2b2e'));}
    if(a==='phone'&&ORCH.remoteUrl)copyText(ORCH.remoteUrl,'phone link copied');
    if(a==='show'){orchTermOn=true;$('#ohead').dataset.sig='';OMSG_SIG='';renderOrch(true);return;}
    if(a==='term'){orchTermOn=!orchTermOn;$('#ohead').dataset.sig='';OMSG_SIG='';renderOrch(true);}}));
  $('#orail').addEventListener('click',e=>{if(!ORCH)return;const items=ORCH.items||[];
    const j=e.target.closest('[data-jump]');if(j){orchJump(items.find(i=>String(i.id)===j.dataset.jump));return;}
    const r=e.target.closest('[data-resolve]');if(r){postJ('/api/orch/resolve',{id:Number(r.dataset.resolve)}).then(x=>{if(!x.ok)toast(x.detail||'failed','#8a2b2e');loadOrch(false);}).catch(()=>toast('server off','#8a2b2e'));return;}
    const m=e.target.closest('[data-chat]');if(m)orchJump({ref_type:'chat',ref_id:m.dataset.chat});});}
`;
