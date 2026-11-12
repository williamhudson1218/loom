// The guided tour: a spotlight and a tooltip over the real page, one stop per feature.
// Plain browser CSS/HTML/JS in strings, spliced verbatim by dashboard.ts like orchview.ts.
// String.raw so nothing here needs double escaping; it must never contain a dollar-brace,
// a backtick or a backslash (the page script is spliced into template strings elsewhere).
//
// Entry points: window.startTour(i), the 'loom:start-tour' event (on window or document),
// and the wizard's "Take the tour" button, which calls the same function.
//
// How it works
//  - The stops point at the data-tour anchors that dashboard.ts puts on real elements.
//  - Stops 3 to 7 open the real UI (a chat, the Outbox confirm, the staged-work dialog,
//    the right-click menu) by calling the same functions a click would.
//  - A user with no chats gets sample data: tourFixture() in tourfixture.ts. It reaches the
//    page through a fetch interceptor and a temporary swap of DATA, and is removed on exit.
//    Nothing sample is ever sent to the server or stored.
//  - While the tour runs every write is refused, a full-page shield takes the clicks, and
//    keys other than Tab, Escape and the arrows are swallowed, so a stray Enter cannot press
//    a real Send button that a stop has put on screen.
//  - The tour records tour_completed_at or tour_skipped_at through POST /api/wizard/tour.

import { TOUR_FIXTURE_JS } from './tourfixture.ts';

export const TOUR_VIEW_CSS = String.raw`
  #tour { position:fixed; inset:0; z-index:95; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  #tour[hidden] { display:none; }
  #tourshield { position:absolute; inset:0; background:transparent; }
  #tour.dim #tourshield { background:rgba(5,6,10,.72); }
  #tourspot { position:fixed; border-radius:10px; box-shadow:0 0 0 9999px rgba(5,6,10,.72); border:2px solid #6ea2ff; pointer-events:none; transition:left .22s ease, top .22s ease, width .22s ease, height .22s ease; }
  #tour.dim #tourspot { display:none; }
  #tourtip { position:fixed; box-sizing:border-box; width:300px; background:#161a24; border:1px solid #34406a; border-radius:12px; padding:14px; box-shadow:0 14px 44px rgba(0,0,0,.65); color:#e6e9ef; transition:left .22s ease, top .22s ease; }
  #tourtip h4 { margin:0 0 4px; font-size:14.5px; font-weight:650; color:#e6e9ef; }
  #tourtip p { margin:0; color:#c4ccdc; font-size:12.5px; }
  #tourtip p.tournote { margin-top:8px; color:#8b93a7; }
  #tourtip .tourf { display:flex; align-items:center; gap:6px; margin-top:12px; }
  #tourtip .tourf .sp { flex:1; }
  #tourtip .tourcnt { color:#8b93a7; font-size:11.5px; margin-left:auto; padding-right:4px; }
  #tourtip .tourbtn { height:28px; border-radius:8px; border:1px solid #2b3040; background:#1b1f2a; color:#c4ccdc; padding:0 11px; font:inherit; font-size:12.5px; cursor:pointer; }
  #tourtip .tourbtn:hover:not(:disabled) { background:#232a3b; color:#fff; }
  #tourtip .tourbtn:disabled { opacity:.45; cursor:default; }
  #tourtip .tourbtn.ghost { background:transparent; border-color:transparent; color:#8b93a7; padding:0 6px; }
  #tourtip .tourbtn.pri { background:#6ea2ff; border-color:#6ea2ff; color:#08101f; font-weight:600; }
  #tourtip .tourbtn.pri:hover { filter:brightness(1.1); background:#6ea2ff; color:#08101f; }
  #tourtip .tourbtn:focus-visible { outline:2px solid #6ea2ff; outline-offset:2px; }
  #tourribbon { position:fixed; left:50%; top:10px; transform:translateX(-50%); max-width:calc(100vw - 24px); box-sizing:border-box; display:flex; align-items:center; gap:10px; padding:5px 6px 5px 14px; border-radius:999px; background:#2a2412; border:1px solid #6b5a1e; color:#e8c872; font-size:12.5px; z-index:2; }
  #tourribbon[hidden] { display:none; }
  #tourribbon b { font-weight:600; }
  #tourribbon button { height:24px; border-radius:999px; border:1px solid #6b5a1e; background:#3a3216; color:#f3dc92; padding:0 11px; font:inherit; font-size:12px; cursor:pointer; }
  #tourribbon button:hover { background:#4a401c; color:#fff; }
  #tourribbon button:focus-visible { outline:2px solid #6ea2ff; outline-offset:2px; }
  @media (prefers-reduced-motion: reduce) { #tourspot, #tourtip { transition:none; } }
`;

export const TOUR_VIEW_HTML = String.raw`
<div id="tour" hidden>
  <div id="tourshield"></div>
  <div id="tourspot"></div>
  <div id="tourribbon" role="status" hidden><span><b>Showing sample data for the tour.</b> Nothing here is real, and nothing you do changes anything.</span><button type="button" id="tourexit">Exit tour</button></div>
  <div id="tourtip" role="dialog" aria-modal="true" aria-labelledby="tourtt" aria-describedby="tourtb">
    <h4 id="tourtt"></h4>
    <p id="tourtb"></p>
    <p id="tournote" class="tournote" hidden></p>
    <div class="tourf">
      <button type="button" class="tourbtn ghost" id="tourskip">Skip tour</button>
      <span class="tourcnt" id="tourcnt"></span>
      <button type="button" class="tourbtn" id="tourback">Back</button>
      <button type="button" class="tourbtn pri" id="tournext">Next</button>
    </div>
  </div>
</div>
`;

export const TOUR_VIEW_JS =
  TOUR_FIXTURE_JS +
  String.raw`
// ---- Guided tour ---------------------------------------------------------------
var TOUR={on:false,pos:0,order:[],stops:[],timer:null,sample:false,fx:null,saved:null,prevFetch:null,origFetch:null,stepAt:0,
  shipOk:false,shipRepo:'',hotkey:'Command+Shift+L',slackOn:false,keyH:null,resizeH:null,focusEl:null,ending:false};
function tourQ(s){return document.querySelector(s);}
function tourUsable(el){if(!el||el.hidden)return false;var r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
function tourJson(o){return Promise.resolve(new Response(JSON.stringify(o),{status:200,headers:{'content-type':'application/json'}}));}
function tourFmtAcc(a){if(!a||a==='off')return '';var m={command:'⌘',cmd:'⌘',commandorcontrol:'⌘',control:'⌃',ctrl:'⌃',alt:'⌥',option:'⌥',shift:'⇧'};
  return String(a).split('+').map(function(p){return m[p.toLowerCase()]||p;}).join('');}
var TOUR_PANES=['mhead','mtabs','mbanner','mdetail','mmsgs','mfoot','mslack'];
function tourPaneHtml(){var o={};TOUR_PANES.forEach(function(id){var el=document.getElementById(id);if(el)o[id]=el.innerHTML;});return o;}
function tourPaneReset(h){TOUR_PANES.forEach(function(id){var el=document.getElementById(id);if(el&&h[id]!==undefined){el.innerHTML=h[id];if(el.dataset)el.dataset.sig='';}});}
function tourSlackIsOn(){var m=DATA.slackMode;return m==='direct'||m==='mcp';}

// ---- fetch guard + sample data -------------------------------------------------
function tourFetch(input,init){
  var url,method='GET';
  try{
    var isReq=typeof Request!=='undefined'&&input instanceof Request;
    url=new URL(isReq?input.url:String(input),location.href);
    method=String((init&&init.method)||(isReq?input.method:'GET')).toUpperCase();
  }catch(e){return TOUR.prevFetch(input,init);}
  if(url.origin!==location.origin)return TOUR.prevFetch(input,init);
  if(method!=='GET')return tourJson({ok:false,detail:'The tour is running. Nothing was changed.'});
  if(!TOUR.sample)return TOUR.prevFetch(input,init);
  var p=url.pathname,sid=url.searchParams.get('session')||'',fx=TOUR.fx;
  if(p==='/api/data'){
    return TOUR.prevFetch(input,init).then(function(r){return r.json();}).then(function(d){
      d=Object.assign({},d);d.chats=fx.chats;d.live=fx.live;d.drafts=fx.drafts;d.slackOwners=fx.slackOwners;d.slackCounts=fx.slackCounts;
      d.ships=fx.ships;d.parked=fx.parked;d.pipes=fx.pipes;d.chatPr=fx.chatPr;d.slackStarts=[];d.launches=[];d.slackMode=TOUR.sampleSlackMode;return tourJson(d);});
  }
  if(p==='/api/detail'&&sid.indexOf('sample-')===0)return tourJson(fx.detail(sid));
  if(p==='/api/transcript'&&sid.indexOf('sample-')===0)return tourJson(fx.transcript(sid));
  if(p.indexOf('outbox')>0&&p.slice(-6)==='/state')return tourJson({ok:true,drafts:fx.drafts});
  if(p==='/api/ship/detail'&&url.searchParams.get('repo')===fx.repo)return tourJson({ok:true,detail:fx.shipDetail});
  if(p==='/api/ship/diff'&&url.searchParams.get('repo')===fx.repo)return tourJson({ok:true,diff:fx.diff,truncated:false});
  if((p+url.search).indexOf('sample-')>=0||url.searchParams.get('repo')===fx.repo)return tourJson({ok:false,detail:'This is sample data.'});
  return TOUR.prevFetch(input,init);
}
function tourApplySample(){
  var fx=TOUR.fx;
  DATA.chats=fx.chats;DATA.live=fx.live;DATA.drafts=fx.drafts;DATA.slackOwners=fx.slackOwners;DATA.slackCounts=fx.slackCounts;
  DATA.ships=fx.ships;DATA.parked=fx.parked;DATA.pipes=fx.pipes;DATA.chatPr=fx.chatPr;DATA.slackStarts=[];
  // The sample shows every stop, Slack's included, whatever this Mac has set up.
  DATA.slackMode=TOUR.sampleSlackMode;
}

// ---- selecting a chat for the stops ---------------------------------------------
function tourSelectChat(pred){
  var list=DATA.chats.filter(function(c){return !c.arch;}),c=null,i;
  for(i=0;i<list.length;i++){if(pred(list[i])){c=list[i];break;}}
  if(!c)c=list[0];
  if(!c)return null;
  if(!(sel&&!sel.arch&&sel.sid===c.session_id&&sel.agent===c.agent))selectChat(c.session_id,c.agent);
  return c;
}
function tourForceTranscript(){mtab='transcript';var t=tourQ('#mtabs');if(t)t.dataset.sig='';renderMain();}
function tourWithAsk(c){return hasDrafts(c)||ownsSlack(c);}
// The menu stop opens on the chat the earlier stops selected, so it is the one in focus.
function tourMenuRow(){return tourQ('.srow.sel[data-tour="row"]')||tourQ('[data-tour="row"]');}

// ---- the stops ------------------------------------------------------------------
// Real data: a stop runs only when its subject exists in this person's data
// (has), so no stop talks about something that is not on screen. Sample data has
// every subject by construction (tests/tour.test.ts checks each anchor).
function tourLiveChats(){return DATA.chats.filter(function(c){return !c.arch;});}
function tourHasDraftChat(){return tourLiveChats().some(function(c){return hasDrafts(c);});}
function tourHasSlackChat(){return tourLiveChats().some(function(c){return ownsSlack(c);});}
function tourStops(){
  var slackKey=TOUR.hotkey&&TOUR.hotkey!=='off'?tourFmtAcc(TOUR.hotkey):'';
  var slackBody='A chat that works in a Slack thread owns it, and Open in Slack jumps straight to that thread. '+
    (slackKey?'In Slack itself, hover any message and press '+slackKey+' to open the chat that message belongs to, or to start a new one from it.'
             :'The shortcut that jumps from a Slack message to its chat is off. Turn it on in Settings › Shortcut.');
  var stops=[
    {id:'filters',anchor:'[data-tour="filters"]',place:'right',title:'Find a chat fast',
     body:'The sidebar lists every chat Loom knows about, so one list answers which chat needs you. Search it, filter by project, group by status or tag, and sort it. Filters stay set between launches, and archive search finds chats older than seven days.'},
    {id:'groups',has:function(){return tourLiveChats().length>0;},anchor:'#list',place:'right',title:'Each row says what the chat needs',
     body:'The dot and label on each row give the chat state: Your turn, Working, Waiting on others or Done. Sorted by Recent activity, the chat that changed last is on top. Pick another sort in the filter menu above and the list groups by state, so the chats waiting on you sit together.'},
    {id:'tabs',has:function(){return tourLiveChats().length>0;},anchor:'#mtabs',place:'below',title:'Open a chat',
     body:'Clicking a row opens the chat here. Terminal is the live session, where you type to the chat. Transcript is a readable record you can search and copy from, with the git, pull request and Slack details beside it. Both show the same chat.',
     open:function(){tourSelectChat(tourWithAsk);}},
    {id:'outbox',requires:TOUR.slackOn,has:tourHasDraftChat,anchor:'[data-tour="outbox"]',place:'left',title:'The Outbox',
     body:'When a chat drafts a Slack reply, it waits here instead of posting. Nothing reaches Slack until you press Send, so you read every message first. Send posts now. Send and park posts, then reopens the chat when someone replies. Send and close posts and ends the chat.',
     open:function(){var c=tourSelectChat(hasDrafts);var ds=c?draftsFor(c):[];
       if(ds.length){outCollapsed=false;draftConfirm=ds[0].id;draftArmDiscard=null;}renderOutbox();},
     close:function(){draftConfirm=null;outCollapsed=outRailKey?railCollapsed(outRailKey,railDrafts()):true;renderOutbox();}}
  ];
  // Ship runs only where it has something to show: the sample, or a Ship repository
  // set up on this Mac. Without one the gear stop below already says where to add it.
  stops.push({id:'ship',has:function(){return TOUR.shipOk;},anchor:'#shipmodal:not([hidden]) .smbox',place:'left',title:'Ship staged work',
    body:'Ship turns the changes that several chats have staged into one pull request. The ship line in the sidebar counts the staged files. This dialog shows which chat changed what, flags files no chat has claimed, and starts your ship command. Loom never force-pushes.',
    open:function(){if(TOUR.shipRepo)openShipModal(TOUR.shipRepo,false);},
    close:function(){closeShipModal();}});
  stops.push(
    {id:'menu',has:function(){return tourLiveChats().length>0;},anchor:function(){return [tourMenuRow(),tourQ('#ctx:not([hidden])')];},place:'right',title:'Right-click for more',
     body:'Every chat has the same actions on right-click: open its terminal, branch it into a new window, tag it, save it for later, rename it, copy its session ID, or close it. They keep the board tidy, so only work in progress stays on it.',
     open:function(){var r=tourMenuRow();if(!r)return;var c=null,i;
       for(i=0;i<DATA.chats.length;i++){if(DATA.chats[i].session_id===r.dataset.sid&&DATA.chats[i].agent===r.dataset.agent){c=DATA.chats[i];break;}}
       if(!c)return;var b=r.getBoundingClientRect();openCtx(c,b.left+60,b.bottom-4);},
     close:function(){closeCtx();}},
    {id:'slack',requires:TOUR.slackOn,has:tourHasSlackChat,anchor:'[data-tour="slack"]',place:'left',title:'Slack threads and the shortcut',body:slackBody,
     open:function(){tourSelectChat(ownsSlack);tourForceTranscript();}},
    {id:'gear',anchor:'[data-tour="gear"]',place:'below',title:'Settings live here',
     body:'The gear opens every choice from setup: terminal, permissions, Slack, Ship repositories, watchers and the helper plugin. Settings › Help, or Take the tour in the ⌘K jump box, runs this tour again.'}
  );
  return stops;
}

// ---- layout ---------------------------------------------------------------------
function tourAnchors(s){
  var a=typeof s.anchor==='function'?s.anchor():s.anchor,out=[],i;
  a=[].concat(a);
  for(i=0;i<a.length;i++){var el=typeof a[i]==='string'?tourQ(a[i]):a[i];if(tourUsable(el))out.push(el);}
  return out;
}
function tourUnion(els){
  var u=null;
  els.forEach(function(el){var r=el.getBoundingClientRect();
    u=u?{l:Math.min(u.l,r.left),t:Math.min(u.t,r.top),r:Math.max(u.r,r.right),b:Math.max(u.b,r.bottom)}:{l:r.left,t:r.top,r:r.right,b:r.bottom};});
  return u;
}
function tourLayout(){
  if(!TOUR.on)return;
  var s=TOUR.stops[TOUR.order[TOUR.pos]];if(!s)return;
  var root=tourQ('#tour'),spot=tourQ('#tourspot'),tip=tourQ('#tourtip');
  var els=tourAnchors(s),u=tourUnion(els),W=window.innerWidth,H=window.innerHeight;
  var tw=Math.min(300,W-20);tip.style.width=tw+'px';
  var th=tip.offsetHeight||170,pad=5,x,y,note=tourQ('#tournote');
  if(!u){
    root.classList.add('dim');
    x=(W-tw)/2;y=(H-th)/2;
    var late=Date.now()-TOUR.stepAt>1500;
    note.hidden=!late;note.textContent=late?'There is nothing to point at here right now, so this stop has no highlight.':'';
  }else{
    root.classList.remove('dim');note.hidden=true;
    spot.style.left=(u.l-pad)+'px';spot.style.top=(u.t-pad)+'px';spot.style.width=(u.r-u.l+pad*2)+'px';spot.style.height=(u.b-u.t+pad*2)+'px';
    var cand={
      right:{x:u.r+pad+14,y:u.t,ok:u.r+pad+14+tw<=W-10},
      left:{x:u.l-pad-14-tw,y:u.t,ok:u.l-pad-14-tw>=10},
      below:{x:(u.l+u.r)/2-tw/2,y:u.b+pad+14,ok:u.b+pad+14+th<=H-10},
      above:{x:(u.l+u.r)/2-tw/2,y:u.t-pad-14-th,ok:u.t-pad-14-th>=10}
    };
    var opp={right:'left',left:'right',below:'above',above:'below'};
    var order=[s.place,opp[s.place],'below','above','right','left'],pick=null,i;
    for(i=0;i<order.length;i++){if(cand[order[i]].ok){pick=cand[order[i]];break;}}
    if(!pick)pick={x:W-tw-10,y:H-th-10};
    x=pick.x;y=pick.y;
  }
  x=Math.max(10,Math.min(W-tw-10,x));y=Math.max(10,Math.min(H-th-10,y));
  tip.style.left=x+'px';tip.style.top=y+'px';
}
function tourReveal(){
  var s=TOUR.stops[TOUR.order[TOUR.pos]];if(!s||!TOUR.on)return;
  var els=tourAnchors(s);
  try{if(els[0])els[0].scrollIntoView({block:'nearest',inline:'nearest'});}catch(e){}
  tourLayout();
}
function tourTick(){
  if(!TOUR.on)return;
  if(TOUR.sample&&DATA.chats!==TOUR.fx.chats&&DATA.chats.length===0){tourApplySample();render();}
  tourLayout();
  var ae=document.activeElement;
  if(!ae||!ae.closest||!ae.closest('#tourtip,#tourribbon')){var nx=tourQ('#tournext');if(nx)nx.focus();}
}

// ---- stepping -------------------------------------------------------------------
function tourClose(pos){
  var s=TOUR.stops[TOUR.order[pos]];
  if(s&&s.close){try{s.close();}catch(e){}}
}
function tourShow(pos){
  if(TOUR.pos>=0)tourClose(TOUR.pos);
  TOUR.pos=pos;TOUR.stepAt=Date.now();
  var s=TOUR.stops[TOUR.order[pos]];
  if(s.open){try{s.open();}catch(e){}}
  tourQ('#tourtt').textContent=s.title;tourQ('#tourtb').textContent=s.body;
  tourQ('#tourcnt').textContent=(pos+1)+' of '+TOUR.order.length;
  tourQ('#tourback').disabled=pos===0;
  tourQ('#tournext').textContent=pos===TOUR.order.length-1?'Finish':'Next';
  tourLayout();
  setTimeout(tourReveal,60);setTimeout(tourReveal,450);
  var nx=tourQ('#tournext');if(nx)nx.focus();
}
function tourNext(){if(!TOUR.on)return;if(TOUR.pos>=TOUR.order.length-1){tourEnd('completed');return;}tourShow(TOUR.pos+1);}
function tourBack(){if(!TOUR.on||TOUR.pos<=0)return;tourShow(TOUR.pos-1);}
function tourKey(e){
  if(!TOUR.on)return;
  var inTour=!!(e.target&&e.target.closest&&e.target.closest('#tourtip,#tourribbon'));
  if(e.key==='Escape'){e.preventDefault();e.stopPropagation();tourEnd('skipped');return;}
  if(e.key==='ArrowRight'){e.preventDefault();e.stopPropagation();tourNext();return;}
  if(e.key==='ArrowLeft'){e.preventDefault();e.stopPropagation();tourBack();return;}
  if(e.key==='Tab'){
    var f=[tourQ('#tourskip'),tourQ('#tourback'),tourQ('#tournext'),TOUR.sample?tourQ('#tourexit'):null].filter(function(b){return b&&!b.disabled;});
    var at=f.indexOf(document.activeElement);
    e.preventDefault();e.stopPropagation();
    if(!f.length)return;
    f[(at+(e.shiftKey?-1:1)+f.length)%f.length].focus();return;
  }
  e.stopPropagation();
  if(!inTour&&(e.key==='Enter'||e.key===' '))e.preventDefault(); // a stray Enter or Space must not press whatever has focus underneath
}
function tourKeyUp(e){
  if(!TOUR.on)return;
  var inTour=!!(e.target&&e.target.closest&&e.target.closest('#tourtip,#tourribbon'));
  if(!inTour&&(e.key===' '||e.key==='Enter')){e.preventDefault();e.stopPropagation();}
}

// ---- start and end ----------------------------------------------------------------
function startTour(i){
  if(TOUR.on||TOUR.ending)return;
  TOUR.on=true;
  var projects=fetch('/api/ship/projects').then(function(r){return r.json();}).catch(function(){return null;});
  var settings=fetch('/api/settings').then(function(r){return r.json();}).catch(function(){return null;});
  var slack=fetch('/api/slack/status').then(function(r){return r.json();}).catch(function(){return null;});
  Promise.all([projects,settings,slack]).then(function(a){
    if(a[2]&&a[2].ok&&typeof a[2].mode==='string')DATA.slackMode=a[2].mode;
    var pj=a[0]&&a[0].ok&&a[0].projects||[],st=a[1]&&a[1].ok&&a[1].settings||{},on=pj.filter(function(p){return p.enabled;});
    TOUR.shipOk=on.length>0;
    TOUR.shipRepo=(DATA.ships&&DATA.ships[0]&&DATA.ships[0].repo)||(on[0]&&on[0].project_dir)||'';
    TOUR.hotkey=st.slack_goto_hotkey&&typeof st.slack_goto_hotkey.value==='string'?st.slack_goto_hotkey.value:'Command+Shift+L';
    tourBegin(i||0);
  });
}
// Which stops run: those whose setting allows them and, on real data, whose subject exists.
function tourOrder(stops,sample){
  var out=[];
  stops.forEach(function(s,i){
    if(s.requires!==undefined&&!s.requires)return;
    if(!sample&&s.has&&!s.has())return;
    out.push(i);
  });
  return out;
}
function tourBegin(first){
  TOUR.slackOn=tourSlackIsOn();
  TOUR.saved={panes:tourPaneHtml(),tab:tab,sel:sel?{sid:sel.sid,agent:sel.agent,arch:sel.arch||null}:null,mtab:mtab,chats:DATA.chats,live:DATA.live,drafts:DATA.drafts,
    slackOwners:DATA.slackOwners,slackCounts:DATA.slackCounts,ships:DATA.ships,parked:DATA.parked,pipes:DATA.pipes,chatPr:DATA.chatPr,
    slackStarts:DATA.slackStarts,shipOpen:shipOpen,outCollapsed:outCollapsed,focus:document.activeElement};
  TOUR.sample=DATA.chats.filter(function(c){return !c.arch;}).length===0;
  TOUR.saved.slackMode=DATA.slackMode;
  if(TOUR.sample){TOUR.slackOn=true;TOUR.sampleSlackMode='direct';}
  // Bound: the native fetch throws Illegal invocation when called as TOUR.prevFetch(...).
  TOUR.origFetch=window.fetch;TOUR.prevFetch=window.fetch.bind(window);window.fetch=tourFetch;
  if(typeof closeCtx==='function')closeCtx();
  if(typeof closeShipModal==='function')closeShipModal();
  if(TOUR.sample){
    TOUR.fx=tourFixture(Date.now(),{slack:true,ship:true});
    TOUR.shipOk=true;TOUR.shipRepo=TOUR.fx.repo;
    tourApplySample();
  }
  tab='board';stateFilter='all';onlyGroup=null;shipFilter=null;
  if(TOUR.sample)shipOpen=false;
  syncControls();liveToggle();chips();render();
  TOUR.stops=tourStops();
  TOUR.order=tourOrder(TOUR.stops,TOUR.sample);
  TOUR.pos=-1;TOUR.stepAt=0;
  var root=tourQ('#tour');root.hidden=false;tourQ('#tourribbon').hidden=!TOUR.sample;
  tourQ('#tourskip').onclick=function(){tourEnd('skipped');};
  tourQ('#tourexit').onclick=function(){tourEnd('skipped');};
  tourQ('#tourback').onclick=tourBack;tourQ('#tournext').onclick=tourNext;
  TOUR.keyH=tourKey;window.addEventListener('keydown',TOUR.keyH,true);window.addEventListener('keyup',tourKeyUp,true);
  TOUR.resizeH=function(){tourLayout();};window.addEventListener('resize',TOUR.resizeH);
  TOUR.timer=setInterval(tourTick,250);
  tourShow(Math.max(0,Math.min(first,TOUR.order.length-1)));
}
function tourEnd(result){
  if(!TOUR.on||TOUR.ending)return;
  TOUR.ending=true;
  clearInterval(TOUR.timer);TOUR.timer=null;
  window.removeEventListener('keydown',TOUR.keyH,true);window.removeEventListener('keyup',tourKeyUp,true);window.removeEventListener('resize',TOUR.resizeH);
  tourClose(TOUR.pos);
  if(typeof closeCtx==='function')closeCtx();
  if(typeof closeShipModal==='function')closeShipModal();
  draftConfirm=null;
  var S=TOUR.saved;
  tourQ('#tour').hidden=true;tourQ('#tour').classList.remove('dim');tourQ('#tourribbon').hidden=true;
  window.fetch=TOUR.origFetch;
  if(TOUR.sample){
    DATA.chats=S.chats;DATA.live=S.live;DATA.drafts=S.drafts;DATA.slackOwners=S.slackOwners;DATA.slackCounts=S.slackCounts;
    DATA.ships=S.ships;DATA.parked=S.parked;DATA.pipes=S.pipes;DATA.chatPr=S.chatPr;DATA.slackStarts=S.slackStarts;
    DATA.slackMode=S.slackMode;
  }
  shipOpen=S.shipOpen;
  if(S.sel){
    if(!(sel&&sel.sid===S.sel.sid&&sel.agent===S.sel.agent&&!!sel.arch===!!S.sel.arch))selectChat(S.sel.sid,S.sel.agent,S.sel.arch);
  }else if(sel){deselect();tourPaneReset(S.panes);}
  mtab=S.mtab;var mt=tourQ('#mtabs');if(mt)mt.dataset.sig='';
  tab=S.tab;stateFilter='all';
  syncControls();liveToggle();chips();render();
  outCollapsed=outRailKey?railCollapsed(outRailKey,railDrafts()):true;renderOutbox();
  try{if(S.focus&&S.focus.focus&&document.contains(S.focus))S.focus.focus();}catch(e){}
  fetch('/api/wizard/tour',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({result:result})}).catch(function(){});
  var wasSample=TOUR.sample;
  TOUR.on=false;TOUR.sample=false;TOUR.fx=null;TOUR.saved=null;TOUR.prevFetch=null;TOUR.origFetch=null;TOUR.ending=false;
  refresh();if(wasSample)setTimeout(refresh,1500);
}
window.startTour=startTour;
window.addEventListener('loom:start-tour',function(){startTour(0);});
document.addEventListener('loom:start-tour',function(){startTour(0);});
`;
