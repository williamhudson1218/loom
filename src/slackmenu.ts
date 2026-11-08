// The Slack thread picker: header split button, dropdown, the context-menu
// submenu and the sidebar count. Plain browser JS in strings that dashboard.ts
// embeds verbatim; the pure half is evaluated by tests. Both are String.raw and
// written WITHOUT regex escapes (string methods only), so they survive being
// interpolated into the page script.

export const SLACK_MENU_PURE_JS = String.raw`
// Thread key and permalink from a Slack archive url ("" when it is not one).
function slackRefOf(url){var u=String(url||'');var i=u.indexOf('/archives/');if(i<0)return null;
  var rest=u.slice(i+10).split('?')[0].split('#')[0].split('/');var ch=rest[0]||'',p=rest[1]||'';
  if(!ch||p.charAt(0)!=='p'||p.length<17)return null;var d=p.slice(1);
  for(var k=0;k<d.length;k++){if(d.charAt(k)<'0'||d.charAt(k)>'9')return null;}
  var ts=d.slice(0,10)+'.'+d.slice(10,16);
  var q=u.indexOf('?')>=0?u.slice(u.indexOf('?')+1).split('#')[0].split('&'):[];
  for(var j=0;j<q.length;j++){if(q[j].indexOf('thread_ts=')===0){var t=q[j].slice(10);if(t.length===17&&t.charAt(10)==='.')ts=t;}}
  return {key:ch+'/'+ts,url:u.slice(0,i)+'/archives/'+ch+'/p'+ts.replace('.',''),channel:ch,ts:ts};}
function slackRoleRank(t){return (t.role==='owner'||t.role==='started')?0:1;}
// The server's list for the chat, plus what the board already knows (pending draft thread,
// parked thread) so a fresh draft shows before the next detail refresh. Deduped by key.
function slackThreadList(base,draftThread,parkedUrl,nowMs){
  var by={},out=[];
  (base||[]).forEach(function(t){var c=Object.assign({},t);by[c.key]=c;out.push(c);});
  function add(ref,role,flag){if(!ref)return;var t=by[ref.key];
    if(!t){t={key:ref.key,url:ref.url,channel:ref.channel,ts:ref.ts,role:role,channelLabel:ref.channel,label:'thread '+ref.ts.split('.')[0],lastAt:Number(ref.ts.split('.')[0])*1000,draft:false,parked:false,pending:true};by[ref.key]=t;out.push(t);}
    t[flag]=true;if(nowMs&&flag==='draft'&&t.lastAt<nowMs&&role==='draft')t.lastAt=Math.max(t.lastAt,0);}
  if(draftThread)add(slackRefOf(draftThread.url),'draft','draft');
  if(parkedUrl)add(slackRefOf(parkedUrl),'parked','parked');
  return out.sort(function(a,b){return slackRoleRank(a)-slackRoleRank(b)||(b.lastAt||0)-(a.lastAt||0)||(a.key<b.key?-1:a.key>b.key?1:0);});}
// The thread the main button opens: pending draft, then parked, then the newest owned/started.
function slackPrimary(list){var i;
  for(i=0;i<list.length;i++)if(list[i].draft)return list[i];
  for(i=0;i<list.length;i++)if(list[i].parked)return list[i];
  for(i=0;i<list.length;i++)if(slackRoleRank(list[i])===0)return list[i];
  return list[0]||null;}
// none: no Slack button; single: today's direct button; split: main part + dropdown.
function slackBtnMode(n){return n<=0?'none':(n===1?'single':'split');}
function slackRoleChip(t){return {owner:'owner',started:'started',replying:'replying',draft:'draft',parked:'parked'}[t.role]||t.role;}
function slackAgeOf(ms,now){if(!ms)return '';var s=Math.max(0,Math.floor((now-ms)/1000));
  if(s<60)return 'now';if(s<3600)return Math.floor(s/60)+'m';if(s<86400)return Math.floor(s/3600)+'h';if(s<86400*30)return Math.floor(s/86400)+'d';return Math.floor(s/86400/30)+'mo';}
// Keyboard on the open dropdown: next highlighted index, or 'close' / 'open'.
function slackNav(i,key,n){if(n<=0)return i;
  if(key==='ArrowDown')return (i+1)%n;if(key==='ArrowUp')return (i-1+n)%n;
  if(key==='Home')return 0;if(key==='End')return n-1;return i;}
`;

export const SLACK_MENU_CSS = `
  .mbsplit { display:inline-flex; }
  .mbsplit .mbtn:first-child { border-top-right-radius:0; border-bottom-right-radius:0; }
  .mbsplit .mbtn.dd { width:26px; padding:0; justify-content:center; border-left:0; border-top-left-radius:0; border-bottom-left-radius:0; font-size:11px; }
  .mbsplit .mbtn.dd[aria-expanded="true"] { background:#222a3d; }
  #slackdd { position:fixed; z-index:40; width:min(520px, calc(100vw - 16px)); max-height:60vh; overflow-y:auto; padding:6px; border-radius:10px; border:1px solid #2f3548; background:#171b28; box-shadow:0 14px 36px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:1px; }
  #slackdd[hidden] { display:none; }
  .skrow { display:grid; grid-template-columns:minmax(64px,110px) 1fr auto auto; align-items:center; gap:8px; width:100%; padding:7px 10px; border:0; border-radius:6px; background:transparent; color:#e4e7ee; text-align:left; font:inherit; font-size:13px; cursor:pointer; }
  .skrow:hover, .skrow.hi, .skrow:focus-visible { background:#222a3d; outline:none; }
  .skrow .skch { color:#8a90a2; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .skrow .sklb { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }
  .skrow .skmeta { display:inline-flex; gap:4px; align-items:center; }
  .skrow .skage { color:#8a90a2; font-size:11px; min-width:26px; text-align:right; }
  .chp.role { background:#23262f; color:#aab0c0; }
  .chp.role.owner, .chp.role.started { background:#2a2140; color:#c9b4ff; }
  .chp.mk { background:#3a2238; color:#e8a6e0; }
  .chp.mk.pk { background:#33301d; color:#f0dfa0; }
  .cmslack { display:flex; flex-direction:column; margin:2px 0 2px 8px; padding-left:6px; border-left:1px solid #2f3548; }
  .cmslack .skrow { grid-template-columns:1fr auto auto; }
  .cmslack .skrow .skch { display:none; }
`;

export const SLACK_MENU_VIEW_JS = String.raw`
// ---- Slack thread picker ------------------------------------------------------
var slackDD=null;
function slackThreadsOf(c){var d=detailFor(c);var base=d&&d.slackAll?d.slackAll:[];
  var dt=draftThreadOf(DATA.drafts,c.session_id),pk=parkedOf(c);
  return slackThreadList(base,dt,pk&&pk.thread_url?pk.thread_url:'',Date.now());}
// Count for a row that has no loaded detail: what the board data knows.
function slackCountOf(c){var d=detailFor(c);if(d&&d.slackAll)return slackThreadsOf(c).length;
  return (DATA.slackCounts||{})[c.session_id]||0;}
function slackPost(t){fetch('/api/slack/open?key='+encodeURIComponent(t.key)+'&url='+encodeURIComponent(t.url||''),{method:'POST'}).then(function(r){return r.json();}).then(function(j){toast(j.ok?(j.detail||'opened'):(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');}).catch(function(){toast('server off','#8a2b2e');});}
function slackSig(c){return slackThreadsOf(c).map(function(t){return t.key+(t.draft?'d':'')+(t.parked?'p':'');}).join(',');}
function slackHeadHtml(c){if(!ownsSlack(c))return '';var list=slackThreadsOf(c),m=slackBtnMode(list.length);
  if(m==='split')return '<span class="mbsplit">'+mbtn('slack','Slack thread <span class="chp sl">'+list.length+'</span>','',' title="open the most relevant thread"')+mbtn('slackmenu','▾','dd',' aria-haspopup="menu" aria-expanded="'+(!!slackDD)+'" aria-label="All Slack threads"')+'</span>';
  return mbtn('slack','Slack thread','',list.length?'':' disabled title="loading the thread…"');}
function slackRowHtml(t,i,compact){var now=Date.now();
  return '<button type="button" role="menuitem" class="skrow" data-i="'+i+'" tabindex="-1" title="'+esc(t.url)+'"><span class="skch">'+esc(t.channelLabel)+'</span><span class="sklb">'+esc(compact?t.channelLabel+' · '+t.label:t.label)+'</span><span class="skmeta"><span class="chp role '+esc(t.role)+'">'+esc(slackRoleChip(t))+'</span>'+(t.draft?'<span class="chp mk">Draft</span>':'')+(t.parked?'<span class="chp mk pk">Parked</span>':'')+'</span><span class="skage">'+esc(slackAgeOf(t.lastAt,now))+'</span></button>';}
function slackPanelHtml(c){return slackThreadsOf(c).map(function(t,i){return slackRowHtml(t,i,true);}).join('');}
function closeSlackDD(){if(!slackDD)return;slackDD=null;var m=$('#slackdd');if(m){m.hidden=true;m.innerHTML='';}var b=document.querySelector('[data-act="slackmenu"]');if(b){b.setAttribute('aria-expanded','false');}}
function slackHi(m,i){var rows=m.querySelectorAll('.skrow');rows.forEach(function(r,k){r.classList.toggle('hi',k===i);});if(rows[i]){rows[i].focus();rows[i].scrollIntoView({block:'nearest'});}slackDD.i=i;}
function openSlackDD(c,anchor){var m=$('#slackdd');var list=slackThreadsOf(c);if(list.length<2)return;
  var p=slackPrimary(list);var start=Math.max(0,list.indexOf(p));
  slackDD={sid:c.session_id,agent:c.agent,i:start};
  m.innerHTML=list.map(function(t,i){return slackRowHtml(t,i,false);}).join('');m.hidden=false;
  var r=anchor.getBoundingClientRect();var w=m.offsetWidth,h=m.offsetHeight;var x=Math.max(8,Math.min(r.right-w,window.innerWidth-w-8));var y=Math.min(r.bottom+6,window.innerHeight-h-8);
  m.style.left=x+'px';m.style.top=Math.max(8,y)+'px';anchor.setAttribute('aria-expanded','true');slackHi(m,start);}
function toggleSlackDD(c,anchor){if(slackDD){closeSlackDD();return;}openSlackDD(c,anchor);}
function wireSlackDD(){var m=$('#slackdd');
  m.addEventListener('click',function(e){var b=e.target.closest('.skrow');if(!b||!slackDD)return;var c=selChat();if(!c)return;var t=slackThreadsOf(c)[Number(b.dataset.i)];closeSlackDD();if(t)slackPost(t);});
  m.addEventListener('mousemove',function(e){var b=e.target.closest('.skrow');if(b&&slackDD&&Number(b.dataset.i)!==slackDD.i)slackHi(m,Number(b.dataset.i));});
  document.addEventListener('keydown',function(e){if(!slackDD)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();var bt=document.querySelector('[data-act="slackmenu"]');closeSlackDD();if(bt)bt.focus();return;}
    if(e.key==='Tab'){closeSlackDD();return;}
    var rows=m.querySelectorAll('.skrow');
    if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Home'||e.key==='End'){e.preventDefault();slackHi(m,slackNav(slackDD.i,e.key,rows.length));return;}
    if(e.key==='Enter'||e.key===' '){e.preventDefault();var c=selChat();var t=c&&slackThreadsOf(c)[slackDD.i];closeSlackDD();if(t)slackPost(t);}},true);
  document.addEventListener('mousedown',function(e){if(slackDD&&!e.target.closest('#slackdd,[data-act="slackmenu"]'))closeSlackDD();});
  window.addEventListener('blur',closeSlackDD);window.addEventListener('resize',closeSlackDD);}
`;
