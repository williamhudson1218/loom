// The PR and CI split button in the chat header: main click opens the PR, the caret opens
// a menu per related PR (its own, plus any ship PR the chat rode) with Checks, Files changed,
// each failing or running CI job, and Copy PR link. Mirrors the Slack split button (.mbsplit)
// and reuses its look. Plain browser JS in String.raw strings embedded verbatim in the page
// script, written WITHOUT regex escapes (string methods only).

export const PRCI_PURE_JS = String.raw`
function prciStateOf(raw){var s=String(raw||'').toUpperCase();return s==='MERGED'?'merged':s==='CLOSED'?'closed':s==='DRAFT'?'draft':s==='OPEN'?'open':'';}
// The state a pipeline implies when GitHub's own state is not at hand.
function prciPipeState(p){if(!p)return '';var m=null;for(var i=0;i<p.dots.length;i++)if(p.dots[i].key==='merged')m=p.dots[i];
  if(!m)return '';if(m.state==='pass')return 'merged';if(m.state==='fail')return 'closed';return m.detail==='draft'?'draft':'open';}
function prciNumOf(url){var i=String(url||'').indexOf('/pull/');return i<0?'':String(url).slice(i+6).split('/')[0].split('?')[0].split('#')[0];}
// Every PR related to the chat: own first, then ship PRs it rode (deduped by url).
function prciGroups(own,boards,pipes,ck){var out=[],seen={};
  if(own&&own.url){seen[own.url]=1;var op=pipes[own.key]||null;out.push({num:prciNumOf(own.url),url:own.url,state:own.state||prciPipeState(op)||'open',kind:'own',pipe:op});}
  (boards||[]).forEach(function(b){(b.shipped||[]).forEach(function(s){
    if(!s.url||seen[s.url]||(s.members||[]).indexOf(ck)<0)return;seen[s.url]=1;
    var p=pipes[b.slug+'#'+s.number]||null;out.push({num:String(s.number),url:s.url,state:prciStateOf(s.state)||prciPipeState(p)||'open',kind:'ship',pipe:p});});});
  return out;}
function prciChecksText(p){if(!p)return '';var d=null;for(var i=0;i<p.dots.length;i++)if(p.dots[i].key==='checks')d=p.dots[i];
  if(!d)return '';if(d.state==='fail')return 'CI '+(d.detail?d.detail.split(':')[0]:'failing');if(d.state==='running')return 'CI running';
  if(d.state==='pass')return 'CI passing';return d.detail?'CI '+d.detail:'';}
function prciJobIcon(s){return s==='fail'?'✕':s==='running'?'◐':'✓';}
function prciNav(i,key,n){if(n<=0)return i;if(key==='ArrowDown')return (i+1)%n;if(key==='ArrowUp')return (i-1+n)%n;if(key==='Home')return 0;if(key==='End')return n-1;return i;}
`;

export const PRCI_CSS = `
  #prdd { position:fixed; z-index:40; width:min(460px, calc(100vw - 16px)); max-height:60vh; overflow-y:auto; padding:6px; border-radius:10px; border:1px solid #2f3548; background:#171b28; box-shadow:0 14px 36px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:1px; }
  #prdd[hidden] { display:none; }
  .prhd { display:flex; align-items:center; gap:8px; padding:6px 10px 4px; color:#8a90a2; font-size:11px; }
  .prhd + .prrow { margin-top:0; }
  .prhd .prn { color:#e4e7ee; font-size:12px; font-weight:500; }
  .prsep { height:1px; background:#2a2f42; margin:4px 0; }
  .prrow { display:flex; align-items:center; gap:8px; width:100%; padding:7px 10px; border:0; border-radius:6px; background:transparent; color:#e4e7ee; text-align:left; font:inherit; font-size:13px; cursor:pointer; }
  .prrow:hover, .prrow.hi, .prrow:focus-visible { background:#222a3d; outline:none; }
  .prrow.static { cursor:default; color:#aab0c0; }
  .prrow.static:hover { background:transparent; }
  .prrow .prl { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .prrow .prj { width:14px; text-align:center; font-size:12px; }
  .prrow .prj.fail { color:#ff8086; } .prrow .prj.running { color:#e8b04a; }
  .prrow .prst { color:#8a90a2; font-size:11px; }
  .prci { color:#a3a9b8; font-size:11px; }
  .prci.bad { color:#ff8086; } .prci.run { color:#e8b04a; }
`;

export const PRCI_VIEW_JS = String.raw`
// ---- PR and CI split button -------------------------------------------------------
var prDD=null;
function prciPipes(){return DATA.pipes||{};}
function prciOwn(c){var u=chatPrUrl(c);return u?{url:u,key:(DATA.chatPr||{})[chatKey(c)]||'',state:prStateOf(c)==='review'?'open':prStateOf(c)}:null;}
function prciOf(c){return prciGroups(prciOwn(c),DATA.ships||[],prciPipes(),chatKey(c));}
function prciSig(c){return prciOf(c).map(function(g){return g.url+g.state+(g.pipe?g.pipe.dots.map(function(d){return d.state.charAt(0);}).join('')+(g.pipe.jobs||[]).length:'');}).join(',');}
function prciHeadHtml(c){var gs=prciOf(c);if(!gs.length)return '';var g=gs[0];var ci=prciChecksText(g.pipe);var cls=ci.indexOf('failing')>=0||ci.indexOf('failed')>=0?' bad':ci.indexOf('running')>=0?' run':'';
  return '<span class="mbsplit">'+mbtn('prci',brandIcon('github')+'PR #'+esc(g.num)+' <span class="pst s-'+esc(g.state==='open'?'review':g.state)+'">'+esc(g.state)+'</span>'+(g.pipe?dotsHtml(g.pipe):'')+(ci?' <span class="prci'+cls+'">'+esc(ci)+'</span>':''),'',' title="open the pull request"')
    +mbtn('prcimenu','▾','dd',' aria-haspopup="menu" aria-expanded="'+(!!prDD)+'" aria-label="Pull request and CI details"')+'</span>';}
function prciOpen(u){if(u)window.open(u,'_blank','noopener');}
function prciRows(gs){var rows=[];gs.forEach(function(g){
  rows.push({h:g});rows.push({l:'Open PR',u:g.url});rows.push({l:'Checks',u:g.url+'/checks'});rows.push({l:'Files changed',u:g.url+'/files'});
  ((g.pipe&&g.pipe.jobs)||[]).forEach(function(j){rows.push({l:j.label,u:j.url||'',s:j.state});});
  rows.push({l:'Copy PR link',copy:g.url});});return rows;}
function prciMenuHtml(gs){var rows=prciRows(gs),i=0,h='';
  rows.forEach(function(r,k){
    if(r.h){if(k>0)h+='<div class="prsep"></div>';h+='<div class="prhd"><span class="prn">PR #'+esc(r.h.num)+'</span><span>'+(r.h.kind==='ship'?'ship PR':'this chat')+'</span><span class="pst s-'+esc(r.h.state==='open'?'review':r.h.state)+'">'+esc(r.h.state)+'</span></div>';return;}
    if(r.s&&!r.u){h+='<div class="prrow static"><span class="prj '+esc(r.s)+'">'+prciJobIcon(r.s)+'</span><span class="prl">'+esc(r.l)+'</span><span class="prst">'+esc(r.s)+'</span></div>';return;}
    h+='<button type="button" role="menuitem" class="prrow" data-i="'+(i++)+'" data-ri="'+k+'" tabindex="-1"'+(r.u?' title="'+esc(r.u)+'"':'')+'>'+(r.s?'<span class="prj '+esc(r.s)+'">'+prciJobIcon(r.s)+'</span>':'')+'<span class="prl">'+esc(r.l)+'</span>'+(r.s?'<span class="prst">'+esc(r.s)+'</span>':'')+'</button>';});
  return h;}
function prciRun(c,ri){var r=prciRows(prciOf(c))[ri];if(!r)return;if(r.copy)copyText(r.copy,'PR link copied');else if(r.u)prciOpen(r.u);}
function closePrDD(){if(!prDD)return;prDD=null;var m=$('#prdd');if(m){m.hidden=true;m.innerHTML='';}var b=document.querySelector('[data-act="prcimenu"]');if(b)b.setAttribute('aria-expanded','false');}
function prHi(m,i){var rows=m.querySelectorAll('button.prrow');rows.forEach(function(r,k){r.classList.toggle('hi',k===i);});if(rows[i]){rows[i].focus();rows[i].scrollIntoView({block:'nearest'});}prDD.i=i;}
function openPrDD(c,anchor){var m=$('#prdd');var gs=prciOf(c);if(!gs.length)return;prDD={sid:c.session_id,i:0};
  m.innerHTML=prciMenuHtml(gs);m.hidden=false;
  var r=anchor.getBoundingClientRect();var w=m.offsetWidth,h=m.offsetHeight;var x=Math.max(8,Math.min(r.right-w,window.innerWidth-w-8));var y=Math.min(r.bottom+6,window.innerHeight-h-8);
  m.style.left=x+'px';m.style.top=Math.max(8,y)+'px';anchor.setAttribute('aria-expanded','true');prHi(m,0);}
function togglePrDD(c,anchor){if(prDD){closePrDD();return;}openPrDD(c,anchor);}
function wirePrDD(){var m=$('#prdd');
  m.addEventListener('click',function(e){var b=e.target.closest('button.prrow');if(!b||!prDD)return;var c=selChat();if(!c)return;var ri=Number(b.dataset.ri);closePrDD();prciRun(c,ri);});
  m.addEventListener('mousemove',function(e){var b=e.target.closest('button.prrow');if(b&&prDD&&Number(b.dataset.i)!==prDD.i)prHi(m,Number(b.dataset.i));});
  document.addEventListener('keydown',function(e){if(!prDD)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();var bt=document.querySelector('[data-act="prcimenu"]');closePrDD();if(bt)bt.focus();return;}
    if(e.key==='Tab'){closePrDD();return;}
    var rows=m.querySelectorAll('button.prrow');
    if(e.key==='ArrowDown'||e.key==='ArrowUp'||e.key==='Home'||e.key==='End'){e.preventDefault();prHi(m,prciNav(prDD.i,e.key,rows.length));return;}
    if(e.key==='Enter'||e.key===' '){e.preventDefault();var c=selChat();var b=rows[prDD.i];closePrDD();if(c&&b)prciRun(c,Number(b.dataset.ri));}},true);
  document.addEventListener('mousedown',function(e){if(prDD&&!e.target.closest('#prdd,[data-act="prcimenu"]'))closePrDD();});
  window.addEventListener('blur',closePrDD);window.addEventListener('resize',closePrDD);}
`;
