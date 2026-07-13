import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { DASHBOARD_PATH } from './paths.ts';
import type { ChatRow } from './types.ts';

export interface ChatView {
  session_id: string;
  project: string;
  project_dir: string;
  jsonl_path: string;
  title: string;
  claude_auto_title: string;
  pr_url: string;
  overview: string;
  state: string; // ChatState or '' when pending
  breakdown: string[];
  first_message: string;
  message_count: number;
  last_active_at: number;
  activity: Record<string, number>;
  summary_pending: boolean;
}

export function toChatViews(db: Database.Database): ChatView[] {
  const rows = db
    .prepare(`SELECT * FROM chats ORDER BY last_active_at DESC`)
    .all() as ChatRow[];
  return rows.map((r) => ({
    session_id: r.session_id,
    project: path.basename(r.project_dir || 'unknown'),
    project_dir: r.project_dir,
    jsonl_path: r.jsonl_path,
    title: r.title || r.claude_auto_title || '',
    claude_auto_title: r.claude_auto_title,
    pr_url: r.pr_url,
    overview: r.overview,
    state: r.state,
    breakdown: safeArray(r.breakdown_json),
    first_message: r.first_message,
    message_count: r.message_count,
    last_active_at: r.last_active_at,
    activity: safeObj(r.activity_json),
    summary_pending: r.summary_dirty === 1 && !r.title,
  }));
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function safeObj(s: string): Record<string, number> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Woven, colorful "loom" mark — threads in the four state colors.
export const LOGO_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="1" y="1" width="22" height="22" rx="6" fill="#12151c" stroke="#2a3142"/>' +
  '<path d="M7 3.5v17" stroke="#2ea043" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M12 3.5v17" stroke="#d4a72c" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M17 3.5v17" stroke="#e5484d" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M3.5 9h17" stroke="#3b82f6" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M3.5 15h17" stroke="#79b1ff" stroke-width="2.1" stroke-linecap="round"/>' +
  '</svg>';

export const APP_NAME = 'Loom';

export interface LiveLoc {
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  running: boolean;
  working?: boolean;
}

export function renderDashboard(
  views: ChatView[],
  generatedAt: number,
  live: Record<string, LiveLoc> = {},
): string {
  const data = JSON.stringify({ generatedAt, chats: views, live });
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(LOGO_SVG);
  // All rendering is client-side from DATA; HTML below is a static shell.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${APP_NAME}</title>
<link rel="icon" href="${favicon}"/>
<style>
  :root { color-scheme: dark;
    --done:#2ea043; --waiting_on_user:#3b82f6; --warning:#d4a72c; --error:#e5484d; --pending:#6b7280; }
  body { margin:0; background:#0d0f15; color:#e6e6e6; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:14px 20px; border-bottom:1px solid #232634; position:sticky; top:0; z-index:5;
    background:linear-gradient(180deg,#141826,#0d0f15); }
  .brand { display:flex; align-items:center; gap:10px; }
  .brand h1 { font-size:18px; margin:0; font-weight:700; letter-spacing:.3px;
    background:linear-gradient(90deg,#79b1ff,#7ee0a0); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .brand .sub { color:#8b93a7; font-size:12px; }
  #heatmap { display:flex; gap:2px; flex-wrap:wrap; margin-top:10px; }
  .hcell { width:11px; height:11px; border-radius:2px; background:#1b1f2a; }
  .controls { margin-top:10px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input,select { background:#1b1f2a; color:#e6e6e6; border:1px solid #2b3040; border-radius:6px; padding:6px 8px; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { background:#1b1f2a; border:1px solid #2b3040; color:#c4ccdc; border-radius:999px; padding:4px 11px; cursor:pointer; font-size:12.5px; }
  .chip:hover { border-color:#3a4258; }
  .chip.on { background:#222a3d; border-color:#4d5b80; color:#fff; }
  .chip .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  main { padding:16px 20px; display:grid; gap:11px; max-width:1100px; }
  .card { background:#161a24; border:1px solid #232634; border-left:4px solid var(--pending); border-radius:10px; padding:11px 14px; transition:border-color .15s, background .15s; }
  .card:hover { background:#1a1f2c; }
  .card.s-done { border-left-color:var(--done); }
  .card.s-waiting_on_user { border-left-color:var(--waiting_on_user); }
  .card.s-warning { border-left-color:var(--warning); }
  .card.s-error { border-left-color:var(--error); }
  .card.jumpable { cursor:pointer; }
  .card.jumpable:hover { background:#1d2433; border-color:#3a4a63; box-shadow:0 0 0 1px rgba(122,224,160,.25) inset; }
  .live { color:#56d364; font-size:11.5px; font-weight:600; }
  .live .pin { opacity:.85; }
  .stale { color:#6b7280; font-size:11.5px; }
  .working { color:#e8b84b; font-size:11.5px; font-weight:600; }
  @keyframes pulse { 0%,100%{opacity:.35} 50%{opacity:1} }
  .working .pin { animation:pulse 1s ease-in-out infinite; }
  .card.work { border-color:#4a3d1f; background:#1b1a17; }
  .sweep { position:absolute; top:0; left:0; right:0; height:3px; border-radius:10px 10px 0 0; overflow:hidden; pointer-events:none; }
  .sweep::after { content:''; position:absolute; top:0; bottom:0; width:38%; background:linear-gradient(90deg,transparent,#e8b84b,#fff3cf,#e8b84b,transparent); animation:streak 1.25s linear infinite; }
  @keyframes streak { 0%{transform:translateX(-120%)} 100%{transform:translateX(330%)} }
  .flash { position:absolute; right:14px; top:11px; font-size:11px; padding:2px 8px; border-radius:6px; background:#1f6f3f; color:#fff; }
  .card { position:relative; }
  .chead { display:flex; align-items:flex-start; gap:10px; }
  .card h2 { font-size:15px; margin:0; flex:1; cursor:pointer; }
  .pill { font-size:11px; padding:2px 9px; border-radius:999px; font-weight:600; white-space:nowrap; flex-shrink:0; }
  .pill.done { background:rgba(46,160,67,.16); color:#56d364; }
  .pill.waiting_on_user { background:rgba(59,130,246,.18); color:#79b1ff; }
  .pill.warning { background:rgba(212,167,44,.18); color:#e3c050; }
  .pill.error { background:rgba(229,72,77,.18); color:#ff8086; }
  .pill.pending { background:#23262f; color:#9aa3b2; }
  .meta { color:#8b93a7; font-size:12px; margin-top:3px; }
  .ptag { display:inline-block; padding:1px 7px; border-radius:5px; font-weight:600; font-size:11px; margin-right:6px; }
  .spark { font-family:monospace; letter-spacing:1px; color:#7db0ff; }
  .ov { margin:7px 0 0; color:#dfe4ee; }
  .km { margin:8px 0 0; display:none; }
  .km h3 { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:#8b93a7; margin:0 0 4px; }
  .km ul { margin:0; padding-left:18px; color:#c4ccdc; }
  .card.open .km { display:block; }
  .pending-note { color:#c8a44d; font-size:12px; margin-top:6px; }
  .resume { margin-top:9px; display:flex; gap:8px; align-items:center; }
  code { background:#0d0f15; border:1px solid #232634; border-radius:6px; padding:3px 6px; font-size:12px; }
  code.sid { color:#8b93a7; }
  button { background:#2b3040; color:#e6e6e6; border:0; border-radius:6px; padding:5px 9px; cursor:pointer; transition:background .15s; }
  button:hover { background:#3a4150; }
  button.ok { background:#1f6f3f; color:#fff; }
  .resume { flex-wrap:wrap; }
  .spacer { flex:1; }
  button.open { background:#1c4a2e; color:#9be8b4; font-weight:600; }
  button.open:hover { background:#246138; }
  button.resumebtn { background:#1c2f4d; color:#9bc1ff; font-weight:600; }
  button.resumebtn:hover { background:#244070; }
  button.branchbtn { background:#2d2340; color:#c9a9ff; font-weight:600; }
  button.branchbtn:hover { background:#3f3060; }
  button.closebtn { background:#2b2230; color:#caa3b8; }
  button.closebtn:hover { background:#3d2a36; }
  button.closebtn.arm { background:#7a1f2b; color:#fff; }
  a.prbtn { background:#2d2348; color:#c9b6ff; border:0; border-radius:6px; padding:5px 9px; font-size:12px; font-weight:600; text-decoration:none; display:inline-block; }
  a.prbtn:hover { background:#3b2e63; }
  .card { cursor:pointer; }
  #overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s; z-index:8; }
  #overlay.on { opacity:1; pointer-events:auto; }
  #panel { position:fixed; top:0; right:0; height:100vh; width:min(560px,94vw); background:#11141d; border-left:1px solid #232634; transform:translateX(100%); transition:transform .22s ease; z-index:9; display:flex; flex-direction:column; }
  #panel.on { transform:translateX(0); box-shadow:-24px 0 60px rgba(0,0,0,.45); }
  .phead { padding:13px 16px; border-bottom:1px solid #232634; display:grid; grid-template-columns:1fr auto; gap:3px 10px; align-items:start; }
  .ptitle { font-weight:700; font-size:15px; }
  .pmeta { color:#8b93a7; font-size:12px; grid-column:1/2; }
  #pclose { grid-row:1/3; }
  .pbody { flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:9px; }
  .msg { max-width:90%; padding:8px 11px; border-radius:10px; font-size:13px; line-height:1.45; white-space:pre-wrap; word-break:break-word; }
  .msg.user { align-self:flex-end; background:#1c2f4d; color:#dbe7ff; }
  .msg.assistant { align-self:flex-start; background:#191d28; border:1px solid #232634; color:#dfe4ee; }
  .msg .who { font-size:10px; text-transform:uppercase; letter-spacing:.5px; opacity:.55; margin-bottom:2px; }
  .pfoot { padding:12px 16px; border-top:1px solid #232634; }
  .pfoot textarea { width:100%; box-sizing:border-box; resize:vertical; min-height:48px; background:#1b1f2a; color:#e6e6e6; border:1px solid #2b3040; border-radius:8px; padding:8px; font:inherit; }
  .sendrow { display:flex; gap:8px; margin-top:8px; align-items:center; }
  .sendrow .grow { flex:1; color:#8b93a7; font-size:11.5px; }
  button.send { background:#1c4a2e; color:#9be8b4; font-weight:600; }
  button.send:hover { background:#246138; }
  .stalefoot { color:#c8a44d; font-size:13px; }
  .picker { margin-top:8px; display:flex; flex-direction:column; gap:5px; }
  .picker:empty { display:none; }
  .pickhdr { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#8b93a7; }
  .muted { color:#8b93a7; font-size:12px; }
  button.paneopt { text-align:left; background:#1b1f2a; border:1px solid #2b3040; display:flex; justify-content:space-between; gap:12px; }
  button.paneopt:hover { background:#222a3d; border-color:#3a4a63; }
  .pcwd { color:#6b7280; font-size:11px; }
</style></head>
<body>
<header>
  <div class="brand">${LOGO_SVG}<h1>${APP_NAME}</h1><span class="sub" id="gen"></span></div>
  <div id="heatmap"></div>
  <div class="controls">
    <input id="q" placeholder="filter title/overview/first message…" style="min-width:240px"/>
    <select id="proj"></select>
    <select id="sort">
      <option value="recent">Most recent</option>
      <option value="active">Most active</option>
      <option value="long">Longest</option>
    </select>
    <button id="livetoggle" class="chip on"></button>
    <button id="restorebtn" class="open" title="rebuild every loom-* tmux session from the last snapshot and open a Ghostty tab for each">⟲ Restore workspace</button>
    <div class="chips" id="chips"></div>
  </div>
</header>
<main id="list"></main>
<div id="overlay"></div>
<aside id="panel">
  <div class="phead">
    <div class="ptitle" id="ptitle"></div>
    <button id="pclose" title="close (Esc)">✕</button>
    <div class="pmeta" id="pmeta"></div>
  </div>
  <div class="pbody" id="ptranscript"></div>
  <div class="pfoot" id="pfoot"></div>
</aside>
<script>
const DATA = ${data};
const $ = (s,r=document)=>r.querySelector(s);
function rel(ms){const s=(Date.now()-ms)/1000;if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function spark(act){const days=[];const now=new Date();for(let i=13;i>=0;i--){const d=new Date(now);d.setDate(now.getDate()-i);const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');days.push(act[k]||0);}const max=Math.max(1,...days);const bars='▁▂▃▄▅▆▇█';return days.map(v=>bars[Math.min(7,Math.round(v/max*7))]).join('');}
function heat(){const map={};DATA.chats.forEach(c=>{for(const k in c.activity)map[k]=(map[k]||0)+c.activity[k];});const el=$('#heatmap');const now=new Date();const max=Math.max(1,...Object.values(map));for(let i=83;i>=0;i--){const d=new Date(now);d.setDate(now.getDate()-i);const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');const v=map[k]||0;const cell=document.createElement('div');cell.className='hcell';cell.title=k+': '+v;if(v){const a=0.25+0.75*Math.min(1,v/max);cell.style.background='rgba(88,166,255,'+a+')';}el.appendChild(cell);}}
function projects(){const set=[...new Set(DATA.chats.map(c=>c.project))].sort();const sel=$('#proj');sel.innerHTML='<option value="">all projects</option>'+set.map(p=>'<option>'+p+'</option>').join('');}
function esc(s){return (s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
var stateFilter='all';
var liveOnly=true;
const SLABEL={done:'Done',waiting_on_user:'Your turn',warning:'Caveats',error:'Error',pending:'Summarizing…'};
function st(c){return c.summary_pending?'pending':(c.state||'done');}
function isLive(c){return !!DATA.live[c.session_id];}
function scoped(){return liveOnly?DATA.chats.filter(isLive):DATA.chats;}
function pcolor(p){let h=0;for(let i=0;i<p.length;i++)h=(h*31+p.charCodeAt(i))%360;return 'background:hsl('+h+',42%,20%);color:hsl('+h+',72%,76%)';}
function liveToggle(){const n=Object.keys(DATA.live).length;const b=$('#livetoggle');b.textContent=(liveOnly?'● Live only ':'○ All chats ')+(liveOnly?n:DATA.chats.length);b.classList.toggle('on',liveOnly);b.onclick=()=>{liveOnly=!liveOnly;liveToggle();chips();render();};}
function isWorking(c){const L=DATA.live[c.session_id];return !!(L&&L.working);}
function chips(){const base=scoped();const ct={all:base.length,working:0,waiting_on_user:0,issues:0,done:0};base.forEach(c=>{if(isWorking(c))ct.working++;const s=st(c);if(s==='waiting_on_user')ct.waiting_on_user++;else if(s==='warning'||s==='error')ct.issues++;else if(s==='done')ct.done++;});const defs=[['all','All',''],['working','⚡ Working','var(--warning)'],['waiting_on_user','Your turn','var(--waiting_on_user)'],['issues','Issues','var(--error)'],['done','Done','var(--done)']];$('#chips').innerHTML=defs.map(d=>'<span class="chip'+(stateFilter===d[0]?' on':'')+'" data-f="'+d[0]+'">'+(d[2]&&d[0]!=='working'?'<span class="dot" style="background:'+d[2]+'"></span>':'')+d[1]+' '+ct[d[0]]+'</span>').join('');$('#chips').querySelectorAll('.chip').forEach(el=>el.onclick=()=>{stateFilter=el.dataset.f;chips();render();});}
function matchFilter(c){if(stateFilter==='all')return true;if(stateFilter==='working')return isWorking(c);const s=st(c);if(stateFilter==='issues')return s==='warning'||s==='error';return s===stateFilter;}
function render(){const q=$('#q').value.toLowerCase();const proj=$('#proj').value;const sort=$('#sort').value;let rows=scoped().filter(c=>matchFilter(c)&&(!proj||c.project===proj)&&(!q||(c.title+' '+c.overview+' '+c.first_message).toLowerCase().includes(q)));rows.sort((a,b)=>{const wa=isWorking(a)?1:0,wb=isWorking(b)?1:0;if(wa!==wb)return wb-wa;const la=DATA.live[a.session_id]?1:0,lb=DATA.live[b.session_id]?1:0;if(la!==lb)return lb-la;return sort==='active'?(sum(b.activity)-sum(a.activity)): sort==='long'?(b.message_count-a.message_count):(b.last_active_at-a.last_active_at);});const list=$('#list');const empty=liveOnly&&scoped().length===0?'<p class="meta">No live sessions detected yet — send a prompt in a chat to register it, or switch to <b>All chats</b>.</p>':'<p class="meta">no matches</p>';list.innerHTML=rows.map(card).join('')||empty;list.querySelectorAll('.card').forEach(el=>{el.onclick=(e)=>{if(e.target.closest('button,code,.picker,a'))return;openChat(el.dataset.sid);};const exp=el.querySelector('.expand');if(exp)exp.onclick=()=>el.classList.toggle('open');const cp=el.querySelector('.copy');if(cp)cp.onclick=()=>copyId(cp);const op=el.querySelector('.open');if(op)op.onclick=()=>jump(op.dataset.jump,el);const rb=el.querySelector('.resumebtn');if(rb)rb.onclick=()=>openPicker(rb.dataset.sid,el,'resume');const bb=el.querySelector('.branchbtn');if(bb)bb.onclick=()=>openPicker(bb.dataset.sid,el,'branch');const cb=el.querySelector('.closebtn');if(cb)cb.onclick=()=>confirmClose(cb,el);});}
function confirmClose(b,el){if(b.dataset.armed){doClose(b.dataset.sid,el);}else{b.dataset.armed='1';b.textContent='✕ confirm?';b.classList.add('arm');setTimeout(()=>{if(b){b.dataset.armed='';b.textContent='✕ close';b.classList.remove('arm');}},2500);}}
function doClose(sid,el){flash(el,'closing…','#7a4a1a');fetch('/close?session='+encodeURIComponent(sid)).then(r=>r.json()).then(j=>{flash(el,j.ok?'closed — pane freed ✓':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');setTimeout(poll,1500);setTimeout(poll,3500);}).catch(()=>flash(el,'server off','#8a2b2e'));}
function jump(sid,el){flash(el,'opening…','#3b5bdb');fetch('/goto?session='+encodeURIComponent(sid)).then(r=>r.json()).then(j=>flash(el,j.ok?'opened ✓':'no live pane',j.ok?'#1f6f3f':'#8a2b2e')).catch(()=>flash(el,'server off','#8a2b2e'));}
function openPicker(sid,el,action){const p=el.querySelector('.picker');if(p.dataset.open===action){p.dataset.open='';p.innerHTML='';return;}p.dataset.open=action;const verb=action==='branch'?'Branch':'Resume';p.innerHTML='<span class="muted">finding empty panes…</span>';fetch('/api/idle-panes').then(r=>r.json()).then(panes=>{if(!panes.length){p.innerHTML='<span class="muted">No empty panes found. Open a new pane/window in tmux, then click '+verb+' again.</span>';return;}p.innerHTML='<div class="pickhdr">'+verb+' into which pane?</div>'+panes.map(pn=>'<button class="paneopt" data-pane="'+pn.pane_id+'">'+esc(pn.label)+(pn.cwd?'<span class="pcwd">…/'+esc(pn.cwd.split('/').filter(Boolean).pop()||'')+'</span>':'')+'</button>').join('');p.querySelectorAll('.paneopt').forEach(b=>b.onclick=()=>doLaunch(sid,b.dataset.pane,el,p,action));}).catch(()=>p.innerHTML='<span class="muted">server off?</span>');}
function doLaunch(sid,pane,el,p,action){const busy=action==='branch'?'branching…':'resuming…';const okmsg=action==='branch'?'branched ✓':'resumed ✓';p.innerHTML='<span class="muted">'+busy+'</span>';fetch('/'+action+'?session='+encodeURIComponent(sid)+'&pane='+encodeURIComponent(pane)).then(r=>r.json()).then(j=>{flash(el,j.ok?okmsg:(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');p.dataset.open='';p.innerHTML='';setTimeout(poll,1500);setTimeout(poll,3500);}).catch(()=>{p.innerHTML='<span class="muted">server off?</span>';});}
function flash(el,msg,bg){let f=el.querySelector('.flash');if(!f){f=document.createElement('span');f.className='flash';el.appendChild(f);}f.textContent=msg;f.style.background=bg;clearTimeout(f._t);f._t=setTimeout(()=>f.remove(),1400);}
function copyId(b){navigator.clipboard.writeText(b.dataset.id).then(()=>{const o=b.textContent;b.textContent='copied ✓';b.classList.add('ok');setTimeout(()=>{b.textContent=o;b.classList.remove('ok');},1200);}).catch(()=>{b.textContent='copy failed';setTimeout(()=>{b.textContent='copy id';},1200);});}
function sum(o){return Object.values(o).reduce((a,b)=>a+b,0);}
function disp(c){const t=c.title||c.first_message||'Untitled';return t.length>90?t.slice(0,90)+'…':t;}
function liveTag(c){const L=DATA.live[c.session_id];if(!L)return '<span class="stale">○ no active pane</span>';const loc=esc(L.tmux_session)+' · pane '+L.pane_index;if(L.working)return '<span class="working"><span class="pin">⚡</span> working · '+loc+'</span>';return '<span class="live"><span class="pin">●</span> live · '+loc+(L.running?'':' (idle)')+'</span>';}
function card(c){const s=st(c);const L=DATA.live[c.session_id];const W=!!(L&&L.working);const id=esc(c.session_id);const km=c.breakdown.map(b=>'<li>'+esc(b)+'</li>').join('');const prn=c.pr_url?(c.pr_url.split('/pull/')[1]||''):'';const pr=c.pr_url?'<a class="prbtn" href="'+esc(c.pr_url)+'" target="_blank" rel="noopener" title="'+esc(c.pr_url)+'">⎇ PR #'+esc(prn)+'</a>':'';return '<div class="card s-'+s+(W?' work':'')+'" data-sid="'+id+'">'+(W?'<div class="sweep"></div>':'')+
'<div class="chead"><h2>'+esc(disp(c))+'</h2><span class="pill '+s+'">'+SLABEL[s]+'</span></div>'+
'<div class="meta"><span class="ptag" style="'+pcolor(c.project)+'">'+esc(c.project)+'</span>'+c.message_count+' msgs · <span class="spark">'+spark(c.activity)+'</span> '+rel(c.last_active_at)+' · '+liveTag(c)+'</div>'+
(c.summary_pending?'<div class="pending-note">indexed, summarizing…</div>':'<div class="ov">'+esc(c.overview)+'</div>')+
(km?'<div class="km"><h3>Key moments</h3><ul>'+km+'</ul></div>':'')+
'<div class="resume"><code class="sid" title="session id">'+id+'</code><button class="copy" data-id="'+id+'">copy id</button>'+(km?'<button class="expand">▸ moments</button>':'')+pr+
'<span class="spacer"></span>'+
(L?'<button class="open" data-jump="'+id+'">↗ open in Ghostty</button><button class="closebtn" data-sid="'+id+'" title="exit Claude in this pane (chat stays resumable)">✕ close</button>':'<button class="resumebtn" data-sid="'+id+'">⏵ resume…</button>')+
'<button class="branchbtn" data-sid="'+id+'" title="fork this conversation into a new pane (original left untouched)">⑃ branch…</button>'+
'</div>'+
'<div class="picker"></div></div>';}
$('#gen').textContent='· '+DATA.chats.length+' chats · '+new Date(DATA.generatedAt).toLocaleString();
var panelSid=null, ptimer=null;
function openChat(sid){panelSid=sid;$('#panel').classList.add('on');$('#overlay').classList.add('on');$('#ptranscript').innerHTML='<p class="muted">loading…</p>';$('#pfoot').innerHTML='';loadTranscript(true);clearInterval(ptimer);ptimer=setInterval(()=>loadTranscript(false),1500);}
function closeChat(){panelSid=null;$('#panel').classList.remove('on');$('#overlay').classList.remove('on');clearInterval(ptimer);}
function loadTranscript(toBottom){if(!panelSid)return;const req=panelSid;fetch('/api/transcript?session='+encodeURIComponent(req)).then(r=>r.json()).then(d=>{if(panelSid!==req||!d.ok)return;$('#ptitle').textContent=d.title||'(untitled)';$('#pmeta').innerHTML=esc(d.project)+' · '+(d.live?'<span class="live">● live</span>':'<span class="stale">○ stale</span>');const body=$('#ptranscript');const atBottom=body.scrollTop+body.clientHeight>=body.scrollHeight-50;body.innerHTML=d.messages.map(m=>'<div class="msg '+m.role+'"><div class="who">'+(m.role==='user'?'You':'Claude')+'</div>'+esc(m.text)+'</div>').join('')||'<p class="muted">no messages yet</p>';if(toBottom||atBottom)body.scrollTop=body.scrollHeight;renderFoot(d);}).catch(()=>{});}
function renderFoot(d){const f=$('#pfoot');if(d.live){if(!f.querySelector('textarea')){f.innerHTML='<textarea id="pinput" placeholder="message this chat… (Enter to send, Shift+Enter for newline)"></textarea><div class="sendrow"><span class="grow">types straight into the live Claude pane</span><button class="send" id="psend">Send ↵</button></div>';$('#psend').onclick=sendMsg;$('#pinput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});}}else{f.innerHTML='<div class="stalefoot">This chat isn\\'t running — <b>Resume</b> it from its card to send messages.</div>';}}
function sendMsg(){const ta=$('#pinput');if(!ta||!panelSid)return;const t=ta.value.trim();if(!t)return;ta.value='';fetch('/send?session='+encodeURIComponent(panelSid)+'&text='+encodeURIComponent(t)).then(r=>r.json()).then(()=>{setTimeout(()=>loadTranscript(true),500);setTimeout(()=>loadTranscript(true),2500);}).catch(()=>{});}
$('#pclose').onclick=closeChat;$('#overlay').onclick=closeChat;
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeChat();});
var lastRenderAt=0;
function dataSig(){return DATA.chats.map(c=>c.session_id+':'+(c.state||'')+':'+(c.summary_pending?'p':'')).sort().join('|')+'##'+Object.keys(DATA.live).sort().map(k=>k+(DATA.live[k].working?'⚡':'')).join(',');}
function refresh(){fetch('/api/data').then(r=>r.json()).then(d=>{const before=dataSig();DATA.chats=d.chats;DATA.live=d.live;if(panelSid)loadTranscript(false);if(document.querySelector('.picker:not(:empty)')||document.querySelector('.card.open'))return;if(dataSig()!==before||Date.now()-lastRenderAt>30000){liveToggle();chips();render();lastRenderAt=Date.now();}}).catch(()=>{});}
function restoreWorkspace(){const b=$('#restorebtn');const orig=b.textContent;b.disabled=true;b.textContent='⟲ restoring…';fetch('/restore').then(r=>r.json()).then(j=>{const n=(j.restored||[]).length;b.textContent=j.ok?(n?'✓ restored '+n+' tab(s)':'✓ nothing to restore'):'✕ '+(j.detail||'failed');setTimeout(refresh,1500);}).catch(()=>{b.textContent='✕ server off';}).finally(()=>{setTimeout(()=>{b.disabled=false;b.textContent=orig;},2600);});}
$('#restorebtn').onclick=restoreWorkspace;
heat();projects();liveToggle();chips();render();
['#q','#proj','#sort'].forEach(s=>$(s).addEventListener('input',render));
setInterval(refresh,5000);
</script>
</body></html>`;
}

export function writeDashboard(
  db: Database.Database,
  outPath: string = DASHBOARD_PATH,
  now: number = Date.now(),
): { count: number; path: string } {
  const views = toChatViews(db);
  const html = renderDashboard(views, now);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf-8');
  return { count: views.length, path: outPath };
}
