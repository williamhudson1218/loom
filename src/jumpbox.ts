// The header's jump box and its command palette (⌘K), plus the small header menus that
// share its styling. Kept as plain browser JS in strings (like sidesearch.ts) so the
// pure part (matching and ranking) is testable without a DOM.

export const JUMP_PURE_JS = `
// Score one needle against one item. Every whitespace-separated token must match; lower is better.
// A token scores 0 at the start of the label, 1 at a word start in it, 2 inside it, 3 only in the
// hay (the wider searchable text). -1 means no match. An empty query matches everything at 0.
function jumpScore(label,hay,q){
  var toks=String(q||'').toLowerCase().split(/\\s+/).filter(Boolean);if(!toks.length)return 0;
  var l=String(label||'').toLowerCase(),h=l+' '+String(hay||'').toLowerCase(),total=0;
  for(var i=0;i<toks.length;i++){var t=toks[i],s;
    if(l.indexOf(t)===0)s=0;
    else if(new RegExp('(^|[^a-z0-9])'+t.replace(/[.*+?^\${}()|[\\]\\\\]/g,'\\\\$&')).test(l))s=1;
    else if(l.indexOf(t)>=0)s=2;
    else if(h.indexOf(t)>=0)s=3;
    else return -1;
    total+=s;}
  return total;
}
// Filter and sort one group: best score first, ties keep the input order (callers pass newest first).
// An item with keep set (an archive hit the archive search already matched in its body) never drops out.
// Recency: items carrying a last-update time (ms or epoch seconds) are docked up to 1.5 points as they
// age (30 days to the cap), so a recent chat beats an old one with a similar text score while a clearly
// better text match still wins. Items with no time (commands) are not docked.
function jumpPenalty(ts,now){
  var t=+ts;if(!t||t<0)return 0;if(t<1e11)t*=1000;
  var d=Math.max(0,((now||Date.now())-t)/86400000);return Math.min(1.5,d/20);
}
function jumpFilter(items,q,limit,now){
  var out=[];items.forEach(function(it,i){var s=jumpScore(it.label,it.hay,q);if(s<0&&it.keep)s=3;if(s>=0)out.push({it:it,s:s+jumpPenalty(it.ts,now),i:i});});
  out.sort(function(a,b){return a.s-b.s||a.i-b.i;});
  var r=out.map(function(x){return x.it;});return limit?r.slice(0,limit):r;
}
// The palette's sections in their fixed order: open chats, commands, archived chats. A group with no
// match is dropped; archived hits are already filtered by the archive search itself.
function jumpSections(chats,cmds,arch,q,opts){
  opts=opts||{};var out=[];
  var c=jumpFilter(chats,q,q?8:6,opts.now);if(c.length)out.push({id:'chats',title:q?'Chats':'Open chats',items:c});
  var m=jumpFilter(cmds,q,q?8:20);if(m.length)out.push({id:'cmds',title:'Commands',items:m});
  if(opts.archWanted){var a=jumpFilter(arch||[],q,8,opts.now);
    if(a.length||opts.archLoading)out.push({id:'arch',title:'Archived',items:a,loading:!!opts.archLoading});}
  return out;
}
// Compact age since a last-update time: 5m, 3h, 2d, 3w. Epoch seconds are accepted too (find-chat's
// ended_at). Empty when the time is unknown.
function jumpAge(ts,now){
  var t=+ts;if(!t||t<0)return '';if(t<1e11)t*=1000;
  var s=Math.max(0,((now||Date.now())-t)/1000);
  if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';
  if(s<604800)return Math.floor(s/86400)+'d';return Math.floor(s/604800)+'w';
}
// What a row does. Archived (ended) chats resume on Enter and preview on Cmd/Ctrl+Enter; everything
// else keeps its one action. hint is the label shown on the selected row.
function jumpActions(it,meta){
  if(!it)return null;
  if(it.kind==='arch')return meta?{act:'preview',hint:'Preview'}:{act:'resume',hint:'Resume'};
  if(it.kind==='cmd')return {act:'run',hint:'Run'};
  return {act:'open',hint:'Open'};
}
// Flat list of the selectable items, for arrow keys.
function jumpFlat(sections){var f=[];sections.forEach(function(s){s.items.forEach(function(it){f.push(it);});});return f;}
`;

export const JUMP_CSS = `
  .topbar { flex-wrap:nowrap; }
  .jumpwrap { flex:0 0 auto; display:flex; }
  .jumpbtn { width:300px; height:32px; box-sizing:border-box; display:flex; align-items:center; gap:9px; padding:0 8px 0 11px; border-radius:8px; background:#10131c; border:1px solid #2b3040; color:#8b93a7; font-size:13px; font-weight:400; text-align:left; transition:border-color .15s, background .15s, color .15s; }
  .jumpbtn:hover { background:#141826; border-color:#3a4258; color:#c4ccdc; }
  .jumpbtn svg { flex:none; }
  .jumpbtn .jl { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .kbd { flex:none; font:11px/1 -apple-system,Segoe UI,Roboto,sans-serif; color:#8b93a7; border:1px solid #2b3040; border-radius:5px; padding:3px 6px; background:#141826; }
  @media (max-width:1100px) { .jumpbtn { width:32px; padding:0; justify-content:center; } .jumpbtn .jl, .jumpbtn .kbd { display:none; } }
  .conns { display:flex; align-items:center; gap:2px; height:32px; box-sizing:border-box; padding:0 3px; border:1px solid #2b3040; border-radius:8px; flex:none; }
  .conns[hidden] { display:none; }
  .conn { display:inline-flex; align-items:center; gap:6px; height:24px; padding:0 8px; background:transparent; border:0; border-radius:6px; color:#8b93a7; font-size:12px; font-weight:400; }
  .conn:hover { background:#1b2233; color:#c4ccdc; }
  .conn .cd { width:7px; height:7px; border-radius:50%; background:#6b7280; flex:none; }
  .conn.c-ok .cd { background:#2ea043; }
  .conn.c-warn .cd { background:#d4a72c; }
  .conn.c-warn { color:#d9bd72; }
  @media (max-width:1400px) { .conn .cl { display:none; } .conn { padding:0 6px; } }
  .split { position:relative; display:flex; flex:none; }
  .split > button { height:32px; box-sizing:border-box; border-radius:0; }
  .split > #newbtn { border-radius:8px 0 0 8px; padding:0 12px; }
  .split > .splitcaret { border-radius:0 8px 8px 0; padding:0 7px; border-left:1px solid #0d0f15; display:inline-flex; align-items:center; }
  .splitcaret svg { transition:transform .15s; }
  .splitcaret[aria-expanded="true"] svg { transform:rotate(180deg); }
  .moresel { position:relative; flex:none; }
  button.morebtn { display:inline-flex; align-items:center; justify-content:center; width:32px; height:32px; padding:0; background:transparent; border:1px solid #2b3040; border-radius:8px; color:#8b93a7; font-size:16px; line-height:1; }
  button.morebtn:hover, button.morebtn[aria-expanded="true"] { background:#1b2233; color:#fff; }
  .hmenu { position:absolute; top:calc(100% + 6px); right:0; min-width:200px; z-index:30; padding:4px; background:#161a26; border:1px solid #2b3040; border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.45); opacity:0; transform:translateY(-4px) scale(.98); transform-origin:top right; pointer-events:none; visibility:hidden; transition:opacity .14s ease, transform .16s ease, visibility 0s .16s; }
  .hmenu.on { opacity:1; transform:none; pointer-events:auto; visibility:visible; transition:opacity .14s ease, transform .16s ease; }
  .hmenu button { display:flex; width:100%; align-items:center; gap:8px; background:transparent; border-radius:7px; padding:7px 9px; text-align:left; font-size:13px; color:#d4d9e6; }
  .hmenu button { height:auto; min-height:32px; }
  .hmenu button:hover, .hmenu button:focus-visible { background:#252b3c; outline:0; }
  .hmenu .ck { width:14px; flex:none; color:#7ee0a0; }
  .hmenu { min-width:250px; }
  .hmenu .mi { flex:1; min-width:0; }
  .hmenu .hint { display:block; color:#7f879b; font-size:11px; font-weight:400; margin-top:1px; }
  .hmenu .hlbl { color:#6b7280; font-size:11px; padding:5px 9px 3px; }
  #jump { position:fixed; inset:0; z-index:60; display:flex; justify-content:center; align-items:flex-start; padding-top:12vh; background:rgba(5,7,12,0); visibility:hidden; pointer-events:none; transition:background .16s ease, visibility 0s .16s; }
  #jump.on { background:rgba(5,7,12,.55); visibility:visible; pointer-events:auto; transition:background .16s ease; }
  #jump .jbox { width:min(620px, calc(100vw - 32px)); max-height:70vh; display:flex; flex-direction:column; background:#141826; border:1px solid #2f364a; border-radius:12px; box-shadow:0 24px 70px rgba(0,0,0,.6); overflow:hidden; opacity:0; transform:translateY(-8px) scale(.98); transition:opacity .14s ease, transform .18s cubic-bezier(.2,.9,.3,1); }
  #jump.on .jbox { opacity:1; transform:none; }
  #jump .jin { display:flex; align-items:center; gap:10px; padding:0 14px; height:48px; border-bottom:1px solid #232634; color:#8b93a7; flex:none; }
  #jump .jin input { flex:1; min-width:0; height:100%; background:transparent; border:0; border-radius:0; padding:0; font-size:15px; color:#e6e6e6; outline:0; }
  #jump .jlist { overflow-y:auto; padding:6px; }
  #jump .jh { color:#6b7280; font-size:11px; padding:8px 10px 4px; letter-spacing:.2px; }
  #jump .jrow { display:flex; align-items:center; gap:10px; padding:7px 10px; border-radius:8px; cursor:pointer; color:#d4d9e6; }
  #jump .jrow.sel { background:#222a40; }
  #jump .jrow .ji { flex:none; width:16px; text-align:center; color:#8b93a7; }
  #jump .jrow .jt { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13.5px; }
  #jump .jrow .js { flex:none; max-width:40%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#7f879b; font-size:12px; }
  #jump .jrow .jhint { display:none; flex:none; color:#8b93a7; font-size:11.5px; white-space:nowrap; }
  #jump .jrow.sel .jhint { display:inline; }
  #jump .jrow .jhint kbd { font:inherit; border:1px solid #2b3040; border-radius:4px; padding:1px 4px; background:#141826; margin-left:3px; }
  #jump .jrow .jage { flex:none; min-width:26px; text-align:right; color:#6b7280; font-size:12px; font-variant-numeric:tabular-nums; }
  #jump .jempty, #jump .jload { color:#7f879b; font-size:13px; padding:10px; }
  #jump .jfoot { display:flex; gap:14px; padding:7px 14px; border-top:1px solid #232634; color:#6b7280; font-size:11.5px; flex:none; }
  @media (prefers-reduced-motion:reduce) { #jump, #jump .jbox, .hmenu, .splitcaret svg { transition:none !important; } }
`;

export const JUMP_VIEW_JS = `
// ---- Jump box (⌘K) and header menus ---------------------------------------------
var JUMP={open:false,q:'',sel:0,sections:[],flat:[],hits:[],archQ:'',archState:'idle',archT:null,prevFocus:null};
function jumpReduce(){return window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches;}
function jumpTab(t){if(t==='columns'||t==='list'){if(tab==='board'&&boardView===t)return;setBoardView(t);return;}if(tab===t)return;tab=t;stateFilter='all';onlyGroup=null;syncControls();liveToggle();chips();render();}
function jumpToBoard(){if(boardColumns()){leaveColumns();return;}if(tab==='board'||tab==='saved')return;jumpTab('board');}
function openSettingsAt(sec){try{SX.sec=sec;SX.ghLoaded=0;SX.gmLoaded=0;lsSet('loom.settingsSec',sec);}catch(e){}if(tab==='settings'){if(typeof renderSettings==='function')renderSettings();}else openSettings();}
function jumpCommands(){
  var tabs=[['home','Home'],['board','Board'],['columns','Board columns'],['saved','Saved'],['watch','Watchers'],['trees','Trees']];
  var c=[
    {kind:'cmd',id:'new',label:'New thread',hay:'start launch chat',icon:'＋',run:function(){if(!composerOpen)openComposer();}},
    {kind:'cmd',id:'restore',label:'Restore sessions',hay:'rebuild tmux workspace snapshot',icon:'⟲',run:function(){restoreWorkspace();}},
    {kind:'cmd',id:'settings',label:'Settings',hay:'preferences config',icon:'⚙',run:function(){openSettings();}},
    {kind:'cmd',id:'tour',label:'Take the tour',hay:'guided tour walkthrough help tutorial',icon:'?',run:function(){if(typeof startTour==='function')startTour(0);}},
    {kind:'cmd',id:'outbox',label:'Outbox',hay:'drafts slack email send',icon:'✉',run:function(){var b=document.querySelector('#outrail [data-rail="open"]');if(b)b.click();else if(typeof toast==='function')toast(document.querySelector('#outrail:not([hidden])')?'The Outbox is open':'The Outbox is empty');}}
  ];
  tabs.forEach(function(t){c.push({kind:'cmd',id:'tab-'+t[0],label:'Go to '+t[1],hay:t[1]+' tab view',icon:'▸',run:function(){jumpTab(t[0]);}});});
  return c;
}
function jumpChatItems(){
  // Typing searches every chat the board knows (the sidebar's set, matched with its searchHay);
  // the empty palette lists only the open ones.
  var typed=!!JUMP.q.trim();
  var rows=DATA.chats.filter(function(c){return typed?!isSaved(c)||isOpenChat(c):isOpenChat(c);}).slice().sort(function(a,b){return (b.last_active_at||0)-(a.last_active_at||0);});
  return rows.map(function(c){var nm=chatNameOf(c);
    return {kind:'chat',chat:c,label:(nm?'@'+nm+' · ':'')+disp(c),sub:c.project||'',hay:searchHay(c,nm)+' '+(c.project||''),dot:dotCls(c),ts:isOpenChat(c)?Date.now():c.last_active_at||0};});
}
function jumpArchItems(){
  var known={};DATA.chats.forEach(function(c){known[c.session_id]=1;});
  return JUMP.hits.filter(function(h){return !known[h.session_id];}).map(function(h){var ac=archChat(h);return {kind:'arch',hit:h,label:disp(ac),sub:ac.project||'',hay:h.snippet||'',ts:h.ended_at||0,keep:true};});
}
function jumpBuild(){
  var q=JUMP.q.trim();var want=archiveWanted(q)&&DATA.archiveSearch!==false;
  var loading=want&&(JUMP.archState==='searching'||JUMP.archQ!==q);
  JUMP.sections=jumpSections(jumpChatItems(),jumpCommands(),want&&JUMP.archQ===q?jumpArchItems():[],q,{archWanted:want,archLoading:loading});
  JUMP.flat=jumpFlat(JUMP.sections);
  if(JUMP.sel>=JUMP.flat.length)JUMP.sel=Math.max(0,JUMP.flat.length-1);
}
function jumpRender(){
  jumpBuild();var box=$('#jlist');if(!box)return;var h='',idx=0;
  JUMP.sections.forEach(function(s){h+='<div class="jh">'+esc(s.title)+'</div>';
    s.items.forEach(function(it){var lead=it.kind==='chat'?'<span class="sdot '+esc(it.dot||'')+'" style="margin-top:0"></span>':'<span class="ji">'+(it.kind==='arch'?'❖':esc(it.icon||''))+'</span>';
      h+='<div class="jrow'+(idx===JUMP.sel?' sel':'')+'" role="option" data-i="'+idx+'">'+lead+'<span class="jt">'+esc(it.label)+'</span>'+(it.sub?'<span class="js">'+esc(it.sub)+'</span>':'')+(it.kind==='arch'&&jumpAge(it.ts)?'<span class="jage" title="last updated '+esc(new Date(it.ts<1e11?it.ts*1000:it.ts).toLocaleString())+'">'+esc(jumpAge(it.ts))+'</span>':'')+(it.kind==='arch'?'<span class="jhint">Resume<kbd>⏎</kbd> · Preview<kbd>⌘⏎</kbd></span>':'')+'</div>';idx++;});
    if(s.loading)h+='<div class="jload">Searching archived chats…</div>';});
  if(!JUMP.flat.length&&!JUMP.sections.some(function(s){return s.loading;}))h+='<div class="jempty">Nothing matches “'+esc(JUMP.q.trim())+'”.</div>';
  box.innerHTML=h;var sel=box.querySelector('.jrow.sel');if(sel&&sel.scrollIntoView)sel.scrollIntoView({block:'nearest'});
}
function jumpArchSearch(){
  clearTimeout(JUMP.archT);var q=JUMP.q.trim();
  if(!archiveWanted(q)||DATA.archiveSearch===false){JUMP.archState='idle';JUMP.archQ='';JUMP.hits=[];return;}
  if(q===JUMP.archQ&&JUMP.archState!=='error')return;
  JUMP.archState='searching';
  JUMP.archT=setTimeout(function(){fetch('/api/search?q='+encodeURIComponent(q)).then(function(r){return r.json();}).then(function(j){if(JUMP.q.trim()!==q)return;JUMP.archQ=q;JUMP.archState=j.ok?'results':'error';JUMP.hits=j.ok?(j.results||[]):[];if(JUMP.open)jumpRender();}).catch(function(){if(JUMP.q.trim()!==q)return;JUMP.archQ=q;JUMP.archState='error';JUMP.hits=[];if(JUMP.open)jumpRender();});},300);
}
function jumpOpen(){
  var el=$('#jump');if(!el||JUMP.open)return;hmenuClose();JUMP.open=true;JUMP.q='';JUMP.sel=0;JUMP.archQ='';JUMP.archState='idle';JUMP.hits=[];JUMP.prevFocus=document.activeElement;
  var inp=$('#jin');inp.value='';el.classList.add('on');el.setAttribute('aria-hidden','false');jumpRender();setTimeout(function(){inp.focus();},0);
}
function jumpClose(restore){
  var el=$('#jump');if(!el||!JUMP.open)return;JUMP.open=false;clearTimeout(JUMP.archT);el.classList.remove('on');el.setAttribute('aria-hidden','true');
  var p=JUMP.prevFocus;JUMP.prevFocus=null;if(restore&&p&&p.focus&&document.contains(p)){try{p.focus();}catch(e){}}
}
function jumpGo(it,meta){
  if(!it)return;var a=jumpActions(it,meta);jumpClose(false);
  setTimeout(function(){
    if(it.kind==='cmd'){it.run();return;}
    if(it.kind==='chat'){openInBoard(it.chat.session_id,it.chat.agent);var r=document.querySelector('#sidelist .srow.sel');if(r&&r.scrollIntoView)r.scrollIntoView({block:'nearest'});return;}
    if(it.kind==='arch'){jumpToBoard();var ac=archChat(it.hit);
      // Resume reuses the archive view's own path: select the chat, then the same lane/managed-pane launch
      // the Resume button runs; the main area shows the loading card until the pane is up.
      if(a.act==='resume'&&typeof startLaunch==='function')startLaunch(ac,'resume');
      else selectChat(ac.session_id,ac.agent,ac.arch);}
  },0);
}
function jumpToggle(){if(JUMP.open)jumpClose(true);else jumpOpen();}
function wireJump(){
  var b=$('#jumpbtn'),el=$('#jump'),inp=$('#jin');if(!b||!el||!inp)return;
  b.onclick=jumpOpen;
  el.addEventListener('mousedown',function(e){if(e.target===el){e.preventDefault();jumpClose(true);}});
  inp.addEventListener('input',function(){JUMP.q=inp.value;JUMP.sel=0;jumpArchSearch();jumpRender();});
  inp.addEventListener('keydown',function(e){
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();jumpClose(true);return;}
    if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();var n=JUMP.flat.length;if(!n)return;JUMP.sel=(JUMP.sel+(e.key==='ArrowDown'?1:n-1))%n;jumpRender();return;}
    if(e.key==='Enter'){e.preventDefault();jumpGo(JUMP.flat[JUMP.sel],e.metaKey||e.ctrlKey);return;}
    if(e.key==='Tab'){e.preventDefault();}
  });
  var list=$('#jlist');
  list.addEventListener('mousemove',function(e){var r=e.target.closest&&e.target.closest('.jrow');if(!r)return;var i=+r.dataset.i;if(i!==JUMP.sel){JUMP.sel=i;list.querySelectorAll('.jrow').forEach(function(x){x.classList.toggle('sel',+x.dataset.i===i);});}});
  list.addEventListener('click',function(e){var r=e.target.closest&&e.target.closest('.jrow');if(r)jumpGo(JUMP.flat[+r.dataset.i]);});
  // Ctrl+K where there is no Cmd key; the keymap entry covers ⌘K.
  if(!/Mac|iPhone|iPad/.test(navigator.platform||'')){document.addEventListener('keydown',function(e){if(e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey&&String(e.key).toLowerCase()==='k'){e.preventDefault();jumpToggle();}});}
}
// Header menus: the New thread agent menu and the more menu. One open at a time.
var HMENUS=['agentmenu','moremenu'];
function hmenuClose(){var any=false;HMENUS.forEach(function(id){var m=$('#'+id);if(m&&m.classList.contains('on')){any=true;m.classList.remove('on');var t=document.querySelector('[aria-controls="'+id+'"]');if(t)t.setAttribute('aria-expanded','false');}});return any;}
function hmenuToggle(id){var m=$('#'+id);if(!m)return;var was=m.classList.contains('on');hmenuClose();if(was)return;m.classList.add('on');var t=document.querySelector('[aria-controls="'+id+'"]');if(t)t.setAttribute('aria-expanded','true');}
var AGENT_LABEL={claude:'Claude Code',codex:'Codex',ask:'Ask every time'};
function agentMenuSync(){var cur=DATA.defaultAgent||'claude';var m=$('#agentmenu');if(m)m.querySelectorAll('[data-agent]').forEach(function(b){b.querySelector('.ck').textContent=b.dataset.agent===cur?'✓':'';b.setAttribute('aria-checked',b.dataset.agent===cur?'true':'false');});
  var nb=$('#newbtn');if(nb)nb.title=cur==='ask'?'start a new thread, choosing the agent each time (n)':'start a new thread with '+(AGENT_LABEL[cur]||cur)+' (n)';}
function wireHeaderMenus(){
  var ab=$('#agentbtn'),mb=$('#morebtn');
  if(ab)ab.onclick=function(e){e.stopPropagation();hmenuToggle('agentmenu');};
  if(mb)mb.onclick=function(e){e.stopPropagation();hmenuToggle('moremenu');};
  var am=$('#agentmenu');if(am)am.addEventListener('click',function(e){var b=e.target.closest('[data-agent]');if(!b)return;hmenuClose();var sel=$('#default-agent');if(sel){sel.value=b.dataset.agent;updateDefaultAgent();}agentMenuSync();});
  var mm=$('#moremenu');if(mm)mm.addEventListener('click',function(e){if(e.target.closest('#restorebtn'))setTimeout(hmenuClose,2800);else hmenuClose();});
  document.addEventListener('click',function(e){if(!e.target.closest||!e.target.closest('.split,.moresel'))hmenuClose();});
  HMENUS.forEach(function(id){var m=$('#'+id);if(m)m.addEventListener('keydown',function(e){if(e.key==='Escape'){e.stopPropagation();hmenuClose();}});});
}
// The connections group: a dot and a label per service, the state in the hover title, a click opens its Settings section.
function renderConns(){
  var el=$('#conns');if(!el)return;var cs=DATA.connections||[];
  if(!cs.length){el.hidden=true;return;}el.hidden=false;
  var sig=JSON.stringify(cs);if(el.dataset.sig===sig)return;el.dataset.sig=sig;
  el.innerHTML=cs.map(function(c){return '<button type="button" class="conn c-'+esc(c.state)+'" data-sec="'+esc(c.section)+'" title="'+esc(c.detail)+'" aria-label="'+esc(c.detail)+'"><span class="cd"></span>'+brandIcon(c.id)+'<span class="cl">'+esc(c.label)+'</span></button>';}).join('');
  el.querySelectorAll('.conn').forEach(function(b){b.onclick=function(){openSettingsAt(b.dataset.sec);};});
}
`;
