// The Overview (Home): the landing view of the main pane. A mission-status headline,
// stat tiles, recent chats, what needs you, the ship card and jump-off actions over
// the night sky (src/skyview.ts), with an Orbit layout as a toggle. Everything comes
// from data the page already holds (DATA, TERMS) plus the orchestrator's /api/orch
// items, which the orchestrator page reads the same way.
//
// Two plain-browser-JS strings, like sidesort.ts: HOME_PURE_JS has the stat and layout
// maths with no DOM (unit tested), HOME_VIEW_JS is the rendering and wiring on top of
// the dashboard's globals. Neither contains a backtick or a dollar-brace.
//
// Cost. Nothing runs unless the Overview is the open view: the sky is stopped on
// leaving (and pauses on a hidden window, see skyview.ts), the orchestrator poll and
// clock tick return early, and every section is only written to the DOM when its HTML
// changed, so a refresh with nothing new is string building and nothing else.

import { KEYMAP } from './keymap.ts';

export const HOME_PURE_JS = String.raw`
// ---- Overview maths (src/homeview.ts) ----------------------------------------------
// rows: [{key, working, turn, at}] for the live chats. A chat older than the stale rule
// (isStaleAge, src/sidesort.ts: the one definition) is stale whatever else it is, so it
// leaves the Working and Your turn counts, as it leaves the sidebar's main list.
function homeClassify(rows,now){var o={working:[],turn:[],stale:[],rest:[]};
  rows.forEach(function(r){if(isStaleAge(r.at,now))o.stale.push(r);else if(r.working)o.working.push(r);else if(r.turn)o.turn.push(r);else o.rest.push(r);});
  return o;}
function homeOldest(rows){var b=null;rows.forEach(function(r){if(!b||(r.at||0)<(b.at||0))b=r;});return b;}
// Short age with no ago: now, 38m, 3h, 2d.
function homeAge(t,now){if(!t)return '';var s=Math.max(0,(now-t)/1000);if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';return Math.floor(s/86400)+'d';}
function homePlural(n,one,many){return n+' '+(n===1?one:many);}
// The headline as parts; accent parts render in the accent colour.
function homeHeadline(waiting,flight){var a=waiting===0?'Nothing is waiting on you.':(waiting===1?'1 chat is waiting on you.':waiting+' chats are waiting on you.');
  var b=flight===0?'Nothing is in flight.':(flight===1?'1 is in flight.':flight+' are in flight.');
  return [{t:a,accent:false},{t:b,accent:true}];}
// boards: DATA.ships. Files that ride the next ship across every repo, the chats behind
// them, one entry per repo that has any, and one line per chat (most files first).
function homeShipTotals(boards,nameOf){var files=0,seen={},repos=[],lines=[];
  (boards||[]).forEach(function(b){var n=b&&b.next;if(!n||!(n.staged>0))return;files+=n.staged;
    var cs=(n.chats||[]).filter(function(c){return c.staged>0;});
    cs.forEach(function(c){seen[c.key]=1;lines.push({key:c.key,staged:c.staged});});
    repos.push({repo:b.repo,name:nameOf?nameOf(b.repo):b.repo,staged:n.staged,chats:cs.length});});
  repos.sort(function(a,b){return b.staged-a.staged;});lines.sort(function(a,b){return b.staged-a.staged;});
  return {files:files,chats:Object.keys(seen).length,repos:repos,lines:lines};}
// items: orchestrator_items rows. Open means not resolved. The page's own count of what needs you.
function homeOrchTotals(items){var needs=[],blocked=0;(items||[]).forEach(function(i){if(i.resolved_at)return;if(i.kind==='needs_you')needs.push(i);else if(i.kind==='blocked')blocked++;});
  return {needs:needs,needsN:needs.length,blocked:blocked};}
// Orbit geometry. groups: {turn,working,stale} arrays of keys. Rings are ellipses, wider
// than tall, clamped inside the box; planets sit evenly round their ring, each ring
// turned a little so the three do not line up.
function homeOrbitLayout(W,H,groups){var m=Math.min(W,H),cx=W/2,cy=H/2,out={rings:[],planets:[]};
  var ring={turn:{r:.22,size:22},working:{r:.34,size:18},stale:{r:.45,size:12}};
  ['turn','working','stale'].forEach(function(k,ri){var ry=m*ring[k].r,rx=Math.min(ry*1.55,Math.max(40,W/2-48));
    out.rings.push({k:k,cx:cx,cy:cy,rx:rx,ry:ry});
    var list=groups[k]||[],n=list.length;list.forEach(function(key,i){var a=(i/n)*Math.PI*2+ri*.9-.6;
      // Crowded ring: every other planet sits a little inside it and its label flips above, so neighbours do not share a row.
      var alt=n>6&&i%2===1,f=alt&&n>8?.9:1;
      out.planets.push({key:key,k:k,x:cx+Math.cos(a)*rx*f,y:cy+Math.sin(a)*ry*f,size:ring[k].size,alt:alt,dense:n>8,bare:n>14});});});
  return out;}
`;

const keyOf = (action: string): string => KEYMAP.find((k) => k.action === action)?.keys ?? '';

export const HOME_VIEW_CSS = String.raw`
  #homepin:empty { display:none; }
  #chatmain.home > :not(#homeview) { display:none !important; }
  #homeview { display:none; flex:1 1 auto; min-height:0; position:relative; overflow:hidden; background:#05060b; container-type:inline-size; }
  #chatmain.home #homeview { display:block; }
  #home-sky { position:absolute; inset:0; width:100%; height:100%; display:block; pointer-events:none; }
  #homeview .hm-scroll { position:absolute; inset:0; overflow-y:auto; }
  #homeview .hm-in { position:relative; padding:22px 24px 26px; display:flex; flex-direction:column; gap:18px; max-width:1180px; margin:0 auto; }
  #homeview .hm-top { display:flex; justify-content:space-between; align-items:flex-end; gap:12px; flex-wrap:wrap; }
  #homeview .hm-eyebrow { font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.14em; text-transform:uppercase; color:#8b93a7; display:flex; align-items:center; gap:8px; }
  #homeview h2.hm-h { margin:4px 0 0; font-size:26px; line-height:1.15; font-weight:600; color:#eef1fb; text-wrap:balance; }
  #homeview h2.hm-h .ok { color:#e8a94a; }
  #homeview .hm-side { display:flex; flex-direction:column; align-items:flex-end; gap:8px; }
  #homeview .hm-clock { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:#8b93a7; text-align:right; white-space:nowrap; }
  #homeview .hm-live { display:inline-flex; align-items:center; gap:6px; }
  #homeview .hm-live:before { content:""; width:7px; height:7px; border-radius:50%; background:#2ea043; box-shadow:0 0 8px #2ea043; animation:hmpulse 2.4s ease-in-out infinite; }
  #homeview .hm-live.bad:before { background:#e5484d; box-shadow:0 0 8px #e5484d; animation:none; }
  @keyframes hmpulse { 50% { opacity:.35; } }
  #homeview .hm-seg { display:inline-flex; gap:2px; padding:2px; border-radius:9px; border:1px solid #2b3040; background:rgba(20,24,38,.72); }
  #homeview .hm-seg button { height:26px; padding:0 12px; border-radius:7px; border:0; background:transparent; color:#8b93a7; font:600 12px inherit; font-family:inherit; cursor:pointer; }
  #homeview .hm-seg button[aria-pressed=true] { background:#222a3d; color:#dbe6ff; }
  #homeview .hm-tiles { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; }
  #homeview .hm-tile { background:rgba(20,24,38,.72); border:1px solid #232634; border-radius:10px; padding:10px 12px; min-width:0; }
  #homeview .hm-tile.you { border-color:#2b4a85; box-shadow:inset 0 0 0 1px rgba(59,130,246,.15); }
  #homeview .hm-tile .n { font-size:28px; line-height:1; font-weight:600; font-variant-numeric:tabular-nums; display:flex; align-items:center; gap:8px; color:#eef1fb; }
  #homeview .hm-tile .l { font:600 10.5px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.08em; text-transform:uppercase; color:#8b93a7; margin-top:6px; }
  #homeview .hm-tile .s { font-size:11.5px; color:#8b93a7; margin-top:2px; overflow-wrap:anywhere; }
  #homeview .hdot { width:8px; height:8px; border-radius:50%; display:inline-block; flex:none; background:#4a5060; }
  #homeview .hdot.d-working { background:#2ea043; } #homeview .hdot.d-turn { background:#3b82f6; } #homeview .hdot.d-stale { background:#6b7280; }
  #homeview .hdot.d-error { background:#e5484d; } #homeview .hdot.d-warn { background:#d4a72c; } #homeview .hdot.d-done { background:#4a5060; } #homeview .hdot.d-wait { background:#8b93a7; }
  #homeview .hm-grid { display:grid; grid-template-columns:minmax(0,1.3fr) minmax(0,1fr); gap:14px; }
  #homeview .hm-col { display:flex; flex-direction:column; gap:14px; min-width:0; }
  #homeview .hm-card { background:rgba(20,24,38,.72); border:1px solid #232634; border-radius:12px; min-width:0; }
  #homeview .hm-card > h3 { margin:0; padding:12px 14px 8px; font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; text-transform:uppercase; color:#8b93a7; display:flex; justify-content:space-between; align-items:center; gap:8px; }
  #homeview .hm-link { border:0; background:none; padding:0; color:#7db0ff; font:12px inherit; font-family:inherit; letter-spacing:0; text-transform:none; cursor:pointer; }
  #homeview .hm-link:hover { text-decoration:underline; }
  #homeview .hm-row { display:grid; grid-template-columns:10px minmax(0,1fr) auto; gap:10px; align-items:center; width:100%; box-sizing:border-box; padding:8px 14px; border:0; border-top:1px solid #232634; background:none; color:inherit; text-align:left; font:inherit; cursor:pointer; }
  #homeview .hm-row:hover { background:#171d2f; }
  #homeview .hm-row .t { min-width:0; }
  #homeview .hm-row .nm { font:600 12.5px ui-monospace,SFMono-Regular,Menlo,monospace; color:#fff; }
  #homeview .hm-row .tp { font-size:12.5px; color:#c4ccdc; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #homeview .hm-row .tp.wrap { white-space:normal; }
  #homeview .hm-row .meta { font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace; color:#8b93a7; text-align:right; white-space:nowrap; font-variant-numeric:tabular-nums; }
  #homeview .hm-pill { font:600 10.5px ui-monospace,SFMono-Regular,Menlo,monospace; border-radius:9px; padding:1px 7px; border:1px solid #2b4a85; color:#cfe0ff; background:#14264a; margin-left:6px; }
  #homeview .hm-empty { padding:6px 14px 14px; font-size:12.5px; color:#8b93a7; }
  #homeview .hm-ship { padding:2px 14px 12px; }
  #homeview .hm-ship .cap { font-size:12px; color:#8b93a7; }
  #homeview .hm-ship .cap b { color:#c4ccdc; font-weight:600; }
  #homeview .hm-ship ul { list-style:none; margin:6px 0 0; padding:0; font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:#8b93a7; display:flex; flex-direction:column; gap:2px; }
  #homeview .hm-ship li { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  #homeview .hm-ship .hm-repo { border:0; background:none; padding:0; font:inherit; color:#7db0ff; cursor:pointer; }
  #homeview .hm-acts { display:flex; gap:8px; flex-wrap:wrap; }
  #homeview .hm-act { height:34px; padding:0 14px; border-radius:8px; background:#1b1f2a; border:1px solid #2b3040; color:#c4ccdc; font:600 12.5px inherit; font-family:inherit; cursor:pointer; display:inline-flex; align-items:center; gap:8px; }
  #homeview .hm-act:hover:not(:disabled) { background:#222839; color:#fff; }
  #homeview .hm-act:disabled { opacity:.45; cursor:default; }
  #homeview .hm-act.pri { background:linear-gradient(135deg,#3b2a12,#16284d); border-color:#7a6030; color:#fff; }
  #homeview .hm-act kbd { font:600 10.5px ui-monospace,SFMono-Regular,Menlo,monospace; color:#8b93a7; border:1px solid #2b3040; border-radius:4px; padding:0 4px; }
  #homeview button:focus-visible { outline:2px solid #7db0ff; outline-offset:2px; }
  #homeview .hm-orbit { position:relative; height:500px; margin:-4px 0; }
  #homeview .hm-orbit svg { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }
  #homeview .hm-core { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); width:140px; height:140px; border-radius:50%; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; background:radial-gradient(circle at 35% 30%,#2a3560,#0f1424 70%); border:1px solid #3a4a7a; box-shadow:0 0 50px rgba(232,169,74,.18),0 0 90px rgba(59,130,246,.12); }
  #homeview .hm-core b { font-size:32px; line-height:1; font-weight:600; color:#eef1fb; }
  #homeview .hm-core span { font:600 10px ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.1em; color:#8b93a7; text-transform:uppercase; margin-top:4px; }
  #homeview .hm-body { position:absolute; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; gap:3px; cursor:pointer; background:none; border:0; color:inherit; padding:0; font:inherit; }
  #homeview .hm-body .pl { width:var(--s); height:var(--s); border-radius:50%; background:radial-gradient(circle at 32% 28%,var(--c2),var(--c1)); box-shadow:0 0 14px var(--c1); }
  #homeview .hm-body.turn .pl { animation:hmring 2.2s ease-out infinite; }
  @keyframes hmring { 0% { box-shadow:0 0 0 0 rgba(59,130,246,.7),0 0 14px var(--c1); } 100% { box-shadow:0 0 0 14px rgba(59,130,246,0),0 0 14px var(--c1); } }
  #homeview .hm-body .lb { font:600 11px ui-monospace,SFMono-Regular,Menlo,monospace; color:#fff; white-space:nowrap; background:rgba(7,8,13,.7); padding:0 5px; border-radius:4px; }
  #homeview .hm-body.alt { flex-direction:column-reverse; }
  #homeview .hm-body.dense .lb { font-size:9.5px; padding:0 3px; }
  #homeview .hm-body.bare .lb { display:none; }
  #homeview .hm-body.bare:hover .lb, #homeview .hm-body.bare:focus-visible .lb { display:block; }
  #homeview.paused *, #homeview.paused *:before { animation-play-state:paused !important; }
  #homeview .hm-body .tp { font-size:10.5px; color:#8b93a7; max-width:150px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; display:none; background:rgba(7,8,13,.85); padding:0 4px; border-radius:4px; }
  #homeview .hm-body:hover, #homeview .hm-body:focus-visible { z-index:3; }
  #homeview .hm-body:hover .tp, #homeview .hm-body:focus-visible .tp { display:block; }
  #homeview .hm-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:11.5px; color:#8b93a7; }
  #homeview .hm-legend span { display:inline-flex; align-items:center; gap:6px; }
  #homeview .hm-strip { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
  @container (max-width:760px) { #homeview .hm-grid, #homeview .hm-strip { grid-template-columns:1fr; } #homeview .hm-in { padding:16px; } #homeview .hm-orbit { height:420px; } #homeview h2.hm-h { font-size:22px; } }
  @media (prefers-reduced-motion:reduce) { #homeview *, #homeview *:before { animation:none !important; } }
`;

export const HOME_VIEW_HTML = String.raw`<div id="homeview" aria-label="Overview">
  <canvas id="home-sky" aria-hidden="true"></canvas>
  <div class="hm-scroll"><div class="hm-in">
    <div class="hm-top">
      <div><div class="hm-eyebrow"><span>Mission status</span><span class="hm-live" id="hm-live"></span></div><h2 class="hm-h" id="hm-h" aria-live="polite"></h2></div>
      <div class="hm-side"><div class="hm-seg" id="hm-seg" role="group" aria-label="Overview layout"><button type="button" data-hv="B" aria-pressed="true">Orbit</button><button type="button" data-hv="A" aria-pressed="false">Dashboard</button></div><div class="hm-clock" id="hm-clock"></div></div>
    </div>
    <section class="hm-tiles" id="hm-tiles" aria-label="Stats"></section>
    <div id="hm-A" hidden><div class="hm-grid"><section class="hm-card" id="hm-recent" aria-label="Recent chats"></section><div class="hm-col"><section class="hm-card" id="hm-needs" aria-label="Needs you"></section><section class="hm-card" id="hm-ship" aria-label="Ship card"></section></div></div></div>
    <div id="hm-B"><div class="hm-orbit" id="hm-orbit"></div><div class="hm-legend" id="hm-legend"></div><div class="hm-strip"><section class="hm-card" id="hm-needs2" aria-label="Needs you"></section><section class="hm-card" id="hm-ship2" aria-label="Ship card"></section></div></div>
    <div class="hm-acts" id="hm-acts" role="group" aria-label="Jump off"></div>
  </div></div>
</div>`;

export const HOME_VIEW_JS =
  'var HOME_KEYS=' +
  JSON.stringify({ newThread: keyOf('newThread'), jump: keyOf('jump') }) +
  ';\n' +
  HOME_PURE_JS +
  String.raw`
// ---- Overview rendering (src/homeview.ts) -------------------------------------------
// homeSel: the Overview is the open view. True at launch; any other selection leaves it.
var homeSel=true;
var HOME={sky:null,orch:null,orchAt:0,orchBusy:false,orchSig:'',view:lsGet('loom.homeView')==='A'?'A':'B',sig:{},ro:null,clockT:null};
var HOME_COL={turn:['#3b82f6','#a9c8ff'],working:['#2ea043','#8ee6a1'],stale:['#6b7280','#b5bcc9']};
var HOME_LBL={turn:'Your turn',working:'Working',stale:'Stale'};
function homeOn(){const v=$('#homeview');return homeSel&&!!v&&v.offsetParent!==null;}
function homeStopSky(){if(HOME.sky){HOME.sky.stop();HOME.sky=null;}}
function homePinHtml(){return '<button type="button" class="opin'+(homeSel?' sel':'')+'" data-home="1" aria-label="Home, overview"><span class="oic"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#8fb4ff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 11l9-8 9 8"></path><path d="M5 10v10h5v-6h4v6h5V10"></path></svg></span><span class="ot">Home</span></button>';}
function renderHomePin(){const el=$('#homepin');if(!el)return;const h=homePinHtml();if(el.dataset.h!==h){el.dataset.h=h;el.innerHTML=h;}}
function selectHome(){if(homeSel&&!sel&&!tsel&&!orchSel){renderHome();return;}
  homeSel=true;leaveOrch();leaveTerminal();
  if(tab!=='board'&&tab!=='saved'){tab='board';stateFilter='all';syncControls();liveToggle();chips();render();}
  if(sel){sel=null;DETAIL=null;clearInterval(detailTimer);clearTimeout(detailRetry);closeCtx();document.querySelectorAll('#sidelist .srow.sel, #kanban .tk.sel').forEach(el=>el.classList.remove('sel'));}
  renderHomePin();renderMain();homeLoadOrch(true);}
function leaveHome(){if(!homeSel)return;homeSel=false;homeStopSky();renderHomePin();}
// The orchestrator page's own feed: open items, read from /api/orch. Polled slowly, and sooner when the sidebar's count disagrees.
function homeLoadOrch(force){if(HOME.orchBusy||document.hidden)return;
  const n=(DATA.orch&&DATA.orch.needsYou)||0;
  if(!force&&HOME.orch&&Date.now()-HOME.orchAt<20000&&homeOrchTotals(HOME.orch).needsN===n)return;
  HOME.orchBusy=true;
  fetch('/api/orch').then(r=>r.json()).then(j=>{HOME.orchBusy=false;if(!j||!j.ok)return;HOME.orch=j.items||[];HOME.orchAt=Date.now();if(homeSel)renderHome();}).catch(()=>{HOME.orchBusy=false;});}
// Write html into a section only when it changed; keep keyboard focus on the same control across the rewrite.
function homeSet(id,html){const el=$('#'+id);if(!el||HOME.sig[id]===html)return;HOME.sig[id]=html;
  const a=document.activeElement,hk=(a&&el.contains(a)&&a.dataset)?a.dataset.hk:'';
  el.innerHTML=html;
  if(hk){const b=el.querySelector('[data-hk="'+hk.replace(/"/g,'')+'"]');if(b)b.focus();}}
function homeRows(){return DATA.chats.filter(c=>!c.arch&&isLive(c)).map(c=>({key:chatKey(c),c:c,working:isWorking(c),turn:isTurn(c),at:fresh(c)||0}));}
function homeChatName(c){const L=DATA.live[chatKey(c)];return (L&&L.name)||paneLabel(c);}
function homeChatRow(r,now){const c=r.c,L=DATA.live[r.key]||{};const stage=L.stage||'';
  return '<button type="button" class="hm-row" data-hchat="'+esc(r.key)+'" data-hk="c'+esc(r.key)+'"><i class="hdot '+dotCls(c)+'"></i><div class="t"><div class="nm">'+esc(homeChatName(c))+(r.turn?'<span class="hm-pill">your turn</span>':'')+'</div><div class="tp">'+esc(disp(c))+'</div></div><div class="meta">'+(stage?esc(stage)+' · ':'')+esc(homeAge(r.at,now)||'now')+'</div></button>';}
function homeNeedsHtml(oc){const items=oc?oc.needs.slice(0,4):[];
  const body=!HOME.orch?'<div class="hm-empty">Loading.</div>':(items.length?items.map(i=>'<button type="button" class="hm-row" data-hitem="'+i.id+'" data-hk="i'+i.id+'"><i class="hdot d-turn"></i><div class="t"><div class="tp wrap">'+esc(i.title)+'</div></div><div class="meta">'+esc(homeAge(i.opened_at,Date.now()))+'</div></button>').join(''):'<div class="hm-empty">Nothing needs you.</div>');
  const more=oc&&oc.needsN>4?'<div class="hm-empty">and '+(oc.needsN-4)+' more</div>':'';
  return '<h3>Needs you<button type="button" class="hm-link" data-hact="orch">Open orchestrator</button></h3>'+body+more;}
function homeShipHtml(t){
  if(!t.files)return '<h3>Ship card</h3><div class="hm-ship"><div class="cap">Nothing is staged.</div></div>';
  const lines=t.lines.slice(0,3).map(l=>'<li>'+esc(chatName(l.key))+' · '+l.staged+'</li>').join('');
  const repos=t.repos.length>1?'<ul>'+t.repos.map(r=>'<li><button type="button" class="hm-repo" data-hrepo="'+esc(r.repo)+'" data-hk="r'+esc(r.repo)+'">'+esc(r.name)+'</button> · '+r.staged+' staged</li>').join('')+'</ul>':'';
  return '<h3>Ship card</h3><div class="hm-ship"><div class="cap"><b>'+homePlural(t.files,'file','files')+' staged</b> by '+homePlural(t.chats,'chat','chats')+'</div>'+(lines?'<ul>'+lines+'</ul>':'')+repos+'</div>';}
function homeShortName(repo){return String(repo).replace(/[/]+$/,'').split('/').pop();}
function homeTilesHtml(cl,oc,ship,now){
  const tile=(cls,dot,n,l,s)=>'<div class="hm-tile'+cls+'"><div class="n">'+(dot?'<i class="hdot '+dot+'"></i>':'')+n+'</div><div class="l">'+l+'</div><div class="s">'+esc(s)+'</div></div>';
  const old=homeOldest(cl.turn);
  const orchOff=DATA.orch&&DATA.orch.enabled===false;
  const on=orchOff?'Off':(oc?oc.needsN+oc.blocked:((DATA.orch&&DATA.orch.needsYou)||0));
  const os=orchOff?'orchestrator is off':(oc?oc.needsN+' need you, '+oc.blocked+' blocked':'loading');
  const wins=TERMS.reduce((a,t)=>a+t.windows.length,0);
  return tile('','d-working',cl.working.length,'Working','chats in flight')+
    tile(' you','d-turn',cl.turn.length,'Your turn',old?'oldest waiting '+homeAge(old.at,now):'none waiting')+
    tile('','d-stale',cl.stale.length,'Stale','idle since yesterday')+
    tile('','',ship.files,'Staged to ship',ship.files?'across '+homePlural(ship.chats,'chat','chats'):'nothing staged')+
    tile('','',on,'Orchestrator',os)+
    tile('','',TERMS.length,'Terminals',homePlural(wins,'window','windows'));}
function homeActsHtml(canWait,shipRepo){
  const a=(k,l,cls,kbd,dis)=>'<button type="button" class="hm-act'+cls+'" data-hact="'+k+'"'+(dis?' disabled':'')+'>'+l+(kbd?' <kbd>'+esc(kbd)+'</kbd>':'')+'</button>';
  return a('thread','New thread',' pri',HOME_KEYS.newThread,false)+a('oldest','Open oldest waiting chat','','',!canWait)+a('orch','Orchestrator','','',false)+
    a('ship','Review ship card','','',!shipRepo)+a('term','New terminal','','',false)+a('jump','Jump to anything','',HOME_KEYS.jump,false);}
function homeOrbitHtml(cl,total,now){const box=$('#hm-orbit');const W=box.clientWidth,H=box.clientHeight;if(W<50||H<50)return;
  const byKey={};cl.turn.concat(cl.working,cl.stale).forEach(r=>{byKey[r.key]=r;});
  const keys=g=>g.map(r=>r.key).sort();
  const lay=homeOrbitLayout(W,H,{turn:keys(cl.turn),working:keys(cl.working),stale:keys(cl.stale)});
  const svg='<svg viewBox="0 0 '+W+' '+H+'" aria-hidden="true">'+lay.rings.map((r,i)=>'<ellipse cx="'+r.cx+'" cy="'+r.cy+'" rx="'+r.rx.toFixed(1)+'" ry="'+r.ry.toFixed(1)+'" fill="none" stroke="#2b3550" stroke-width="1" stroke-dasharray="'+(i?'2 5':'0')+'" opacity=".8"/>').join('')+'</svg>';
  const pl=lay.planets.map(p=>{const r=byKey[p.key],c=r.c,col=HOME_COL[p.k];
    return '<button type="button" class="hm-body '+p.k+(p.alt?' alt':'')+(p.dense?' dense':'')+(p.bare?' bare':'')+'" style="left:'+p.x.toFixed(1)+'px;top:'+p.y.toFixed(1)+'px;--s:'+p.size+'px;--c1:'+col[0]+';--c2:'+col[1]+'" data-hchat="'+esc(p.key)+'" data-hk="p'+esc(p.key)+'" aria-label="'+esc(homeChatName(c)+', '+HOME_LBL[p.k]+', '+disp(c))+'"><span class="pl"></span><span class="lb">'+esc(homeChatName(c))+'</span><span class="tp">'+esc(disp(c)+' · '+homeAge(r.at,now))+'</span></button>';}).join('');
  homeSet('hm-orbit',svg+'<div class="hm-core"><b>'+total+'</b><span>'+(total===1?'chat':'chats')+' in orbit</span></div>'+pl);
  homeSet('hm-legend','<span><i class="hdot d-turn"></i>Your turn, inner ring</span><span><i class="hdot d-working"></i>Working, middle ring</span><span><i class="hdot d-stale"></i>Stale, outer ring</span><span>Hover for the topic, click to open.</span>');}
function homeClock(){const el=$('#hm-clock');if(!el)return;const d=new Date();
  const day=d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short'}),tm=String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
  const ago=DATA.generatedAt?Math.max(0,Math.round((Date.now()-DATA.generatedAt)/1000)):0;
  const t=day+' · '+tm+'\nsynced '+(ago<5?'just now':ago<60?ago+'s ago':homeAge(DATA.generatedAt,Date.now())+' ago');
  if(HOME.sig.clock!==t){HOME.sig.clock=t;el.textContent=t;el.style.whiteSpace='pre';}
  const live=$('#hm-live'),bad=!!pollFailed,lt=bad?'server not reachable':'all chats tracking';
  if(live&&HOME.sig.live!==lt){HOME.sig.live=lt;live.textContent=lt;live.classList.toggle('bad',bad);}}
function renderHome(){if(!homeSel)return;
  const now=Date.now(),rows=homeRows(),cl=homeClassify(rows,now);
  const oc=HOME.orch?homeOrchTotals(HOME.orch):null;
  const ship=homeShipTotals(DATA.ships,homeShortName);
  const hl=homeHeadline(cl.turn.length,cl.working.length);
  homeSet('hm-h',hl.map(p=>p.accent?'<span class="ok">'+esc(p.t)+'</span>':esc(p.t)).join(' '));
  homeSet('hm-tiles',homeTilesHtml(cl,oc,ship,now));
  const seg=$('#hm-seg');seg.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.hv===HOME.view)));
  $('#hm-A').hidden=HOME.view!=='A';$('#hm-B').hidden=HOME.view!=='B';
  const needs=homeNeedsHtml(oc),shipH=homeShipHtml(ship);
  if(HOME.view==='A'){
    const recent=rows.slice().sort((a,b)=>b.at-a.at).slice(0,8);
    homeSet('hm-recent','<h3>Recent chats</h3>'+(recent.length?recent.map(r=>homeChatRow(r,now)).join(''):'<div class="hm-empty">No chat is running.</div>'));
    homeSet('hm-needs',needs);homeSet('hm-ship',shipH);
  }else{
    homeOrbitHtml(cl,rows.length,now);
    homeSet('hm-needs2',needs);homeSet('hm-ship2',shipH);}
  homeSet('hm-acts',homeActsHtml(cl.turn.length>0,ship.repos[0]&&ship.repos[0].repo));
  homeClock();homeLoadOrch(false);
  if(!(HOME.sky&&HOME.sky.running())&&homeOn())HOME.sky=loomSky($('#home-sky'),{nebula:LSKY_NEBULA,dim:.55,density:.6,maxStars:420,fps:30,dpr:1,shoot:16000,alive:homeOn});}
function homeAct(a,el){
  if(a==='thread'){openComposer();return;}
  if(a==='orch'){selectOrch();return;}
  if(a==='term'){openTermBox();return;}
  if(a==='jump'){jumpToggle();return;}
  if(a==='oldest'){const w=homeOldest(homeClassify(homeRows(),Date.now()).turn);const c=w&&w.c;if(c)openInBoard(c.session_id,c.agent);return;}
  if(a==='ship'){const t=homeShipTotals(DATA.ships,homeShortName);if(t.repos[0])openShipModal(t.repos[0].repo,false);}}
function wireHome(){const v=$('#homeview');
  $('#homepin').addEventListener('click',e=>{if(e.target.closest('[data-home]'))selectHome();});
  const wm=document.querySelector('.brand h1.wordmark');
  if(wm){wm.setAttribute('role','button');wm.setAttribute('tabindex','0');wm.setAttribute('title','Home');wm.setAttribute('aria-label','Loom, go to Home');wm.style.cursor='pointer';
    wm.addEventListener('click',selectHome);wm.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();selectHome();}});}
  v.addEventListener('click',e=>{
    const hv=e.target.closest('[data-hv]');if(hv){HOME.view=hv.dataset.hv==='B'?'B':'A';lsSet('loom.homeView',HOME.view);renderHome();return;}
    const ch=e.target.closest('[data-hchat]');if(ch){const c=DATA.chats.find(x=>chatKey(x)===ch.dataset.hchat);if(c)openInBoard(c.session_id,c.agent);else toast('that chat is no longer on the board','#8a2b2e');return;}
    const it=e.target.closest('[data-hitem]');if(it){const i=(HOME.orch||[]).find(x=>String(x.id)===it.dataset.hitem);if(i&&i.ref_type)orchJump(i);else selectOrch();return;}
    const rp=e.target.closest('[data-hrepo]');if(rp){openShipModal(rp.dataset.hrepo,false);return;}
    const ac=e.target.closest('[data-hact]');if(ac&&!ac.disabled)homeAct(ac.dataset.hact,ac);});
  if(window.ResizeObserver){HOME.ro=new ResizeObserver(()=>{if(homeSel&&HOME.view==='B'&&v.offsetParent!==null)renderHome();});HOME.ro.observe($('#hm-orbit'));}
  HOME.clockT=setInterval(()=>{if(homeSel&&!document.hidden&&v.offsetParent!==null)homeClock();},5000);
  document.addEventListener('visibilitychange',()=>{v.classList.toggle('paused',document.hidden);});
  renderHomePin();}
`;
