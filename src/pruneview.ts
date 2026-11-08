// The Trees tab's prune controls: the "Prune N merged" button, its confirm
// dialog (built from a dry run, so it lists exactly what a real run would
// remove), the toast after every run of any trigger, and a short history.
//
// Plain browser JS spliced into the dashboard script. Written without regex
// escapes or backslashes so it survives the non-raw template it lands in.

export const PRUNE_VIEW_CSS = `
  .tpbar { display:flex; align-items:center; gap:8px; margin-left:auto; }
  .tpbtn { font:inherit; font-size:11px; padding:4px 10px; border-radius:6px; border:1px solid #2b3040; background:#1b1f2a; color:#c4ccdc; cursor:pointer; white-space:nowrap; }
  .tpbtn:hover { background:#26304a; color:#fff; }
  .tpbtn[disabled] { opacity:.45; cursor:not-allowed; }
  .tphist { margin:8px 0 0; font-size:12px; color:#8b93a7; }
  .tphist details { border-top:1px solid #1d2130; padding:4px 0; }
  .tphist summary { cursor:pointer; list-style:none; display:flex; gap:8px; align-items:baseline; }
  .tphist summary::-webkit-details-marker { display:none; }
  .tphist .tpwhen { color:#6f778a; font-variant-numeric:tabular-nums; min-width:64px; }
  .tphist .tptrig { font-size:10px; padding:1px 6px; border-radius:4px; background:#232634; color:#8b93a7; }
  .tphist ul { margin:4px 0 4px 72px; padding:0; list-style:none; }
  .tphist li { padding:1px 0; }
  .tphist .rm { color:#56d364; } .tphist .sk { color:#8b93a7; } .tphist .er { color:#ff8086; }
  .tpmodal { position:fixed; inset:0; z-index:200; background:rgba(5,6,10,.72); display:flex; align-items:center; justify-content:center; padding:16px; }
  .tpdlg { width:100%; max-width:560px; max-height:80vh; display:flex; flex-direction:column; background:#161a24; border:1px solid #2b3040; border-radius:12px; padding:18px; box-shadow:0 20px 60px rgba(0,0,0,.6); color:#c4ccdc; font-size:13px; }
  .tpdlg h3 { margin:0 0 8px; font-size:16px; color:#e6e6e6; }
  .tpdlg .tplist { overflow-y:auto; margin:6px 0; border:1px solid #232634; border-radius:8px; }
  .tpdlg .tpitem { padding:6px 10px; border-bottom:1px solid #1d2130; }
  .tpdlg .tpitem:last-child { border-bottom:0; }
  .tpdlg .tpname { font-weight:600; color:#e6e6e6; }
  .tpdlg .tpsub { font-size:11.5px; color:#8b93a7; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .tpdlg .tpwarn { font-size:11.5px; color:#e8b84b; }
  .tpdlg details { margin-top:6px; font-size:12px; color:#8b93a7; }
  .tpdlg details summary { cursor:pointer; }
  .tpdlg details ul { margin:4px 0 0; padding-left:16px; max-height:180px; overflow-y:auto; }
  .tpdlg .tprow { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
  .tpdlg .tpb { height:32px; border-radius:8px; border:1px solid #2b3040; background:#1b1f2a; color:#c4ccdc; padding:0 12px; font-size:13px; cursor:pointer; }
  .tpdlg .tpb:hover { background:#26304a; color:#fff; }
  .tpdlg .tpb.danger { color:#ff8a8e; border-color:#5a2a2e; }
  .tpdlg .tpb[disabled] { opacity:.4; cursor:not-allowed; }
`;

export const PRUNE_VIEW_HTML = `<div class="tpbar" id="tree-prune"></div>`;
export const PRUNE_HIST_HTML = `<div class="tphist" id="tree-prune-hist"></div>`;

export const PRUNE_VIEW_JS = `
var PRUNE={plan:null,planning:false,busy:false,runs:[],lastId:0,histInit:false,own:{}};
function pruneEsc(s){return String(s==null?'':s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');}
function pruneBase(p){var i=p.lastIndexOf('/');return i<0?p:p.slice(i+1);}
function prunePost(dry,paths){var b={dry_run:!!dry,source:'trees-tab'};if(paths)b.paths=paths;
  return fetch('/api/trees/prune',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)}).then(function(r){return r.json();});}
function pruneCount(){if(!PRUNE.plan)return 0;var n=0;PRUNE.plan.forEach(function(r){n+=r.removed.length;});return n;}
function prunePlan(){if(PRUNE.busy||PRUNE.planning)return;PRUNE.planning=true;
  prunePost(true).then(function(j){PRUNE.planning=false;if(j&&j.ok){PRUNE.plan=j.results;renderPrune();}}).catch(function(){PRUNE.planning=false;});}
function renderPrune(){var el=document.getElementById('tree-prune');if(!el)return;var n=pruneCount();
  var label=PRUNE.busy?'Checking…':(PRUNE.plan?('Prune '+n+' merged'):'Prune merged');
  el.innerHTML='<button class="tpbtn" id="tp-open" title="Remove worktrees that are merged, clean and not in use"'+(PRUNE.busy||(PRUNE.plan&&!n)?' disabled':'')+'>'+label+'</button>';
  var b=document.getElementById('tp-open');if(b)b.onclick=pruneOpen;renderPruneHist();}
function pruneOpen(){if(PRUNE.busy)return;PRUNE.busy=true;renderPrune();
  prunePost(true).then(function(j){PRUNE.busy=false;if(!j||!j.ok){toast('Prune check failed','#7a2e33');renderPrune();return;}PRUNE.plan=j.results;renderPrune();pruneDialog(j.results);})
  .catch(function(){PRUNE.busy=false;renderPrune();toast('Prune check failed','#7a2e33');});}
function pruneDialog(results){var go=[],skipped=[],errs=[];
  results.forEach(function(r){if(r.error)errs.push(pruneBase(r.repo)+': '+r.error);
    r.removed.forEach(function(w){go.push({r:r,w:w});});
    r.skipped.forEach(function(s){if(s.reason!=='the primary checkout')skipped.push({r:r,s:s});});});
  var items=go.map(function(x){var w=x.w;return '<div class="tpitem"><div class="tpname">'+pruneEsc(w.name)+' <span class="tpsub">'+pruneEsc(pruneBase(x.r.repo))+'</span></div>'
    +'<div class="tpsub">'+pruneEsc(w.branch)+' · '+pruneEsc(w.merge)+' ('+pruneEsc(x.r.base)+') · '+(w.branchDeleted?'branch deleted with -d':'branch kept')+'</div>'
    +(w.branchNote?'<div class="tpwarn">'+pruneEsc(w.branchNote)+'</div>':'')
    +'<div class="tpsub">'+pruneEsc(w.path)+'</div></div>';}).join('');
  var host=document.createElement('div');host.className='tpmodal';
  host.innerHTML='<div class="tpdlg" role="dialog" aria-modal="true"><h3>'+(go.length?'Remove '+go.length+' merged worktree'+(go.length===1?'':'s'):'Nothing to prune')+'</h3>'
    +'<div>'+(go.length?'Each one is checked again just before it goes: still clean, merged, no stash, nothing running in it. Removal is <code>git worktree remove</code> then <code>git branch -d</code>, never forced.':'No worktree is merged, clean and unused right now.')+'</div>'
    +(go.length?'<div class="tplist">'+items+'</div>':'')
    +(errs.length?'<div class="tpwarn">'+errs.map(pruneEsc).join('<br>')+'</div>':'')
    +(skipped.length?'<details><summary>'+skipped.length+' kept, with reasons</summary><ul>'+skipped.map(function(x){return '<li><b>'+pruneEsc(x.s.name)+'</b> · '+pruneEsc(x.s.reason)+'</li>';}).join('')+'</ul></details>':'')
    +'<div class="tprow"><button type="button" class="tpb" id="tp-no">Cancel</button>'+(go.length?'<button type="button" class="tpb danger" id="tp-yes">Remove '+go.length+'</button>':'')+'</div></div>';
  document.body.appendChild(host);
  var kd=function(ev){if(ev.key==='Escape'){ev.stopPropagation();done();}};
  var done=function(){document.removeEventListener('keydown',kd,true);host.remove();};
  document.addEventListener('keydown',kd,true);
  host.onclick=function(ev){if(ev.target===host)done();};
  document.getElementById('tp-no').onclick=done;
  var yes=document.getElementById('tp-yes');
  if(yes)yes.onclick=function(){done();pruneRun(go.map(function(x){return x.w.path;}));};}
function pruneRun(paths){PRUNE.busy=true;renderPrune();
  prunePost(false,paths).then(function(j){PRUNE.busy=false;if(!j||!j.ok){toast('Prune failed: '+((j&&j.detail)||'error'),'#7a2e33');renderPrune();return;}
    j.results.forEach(function(r){if(r.id)PRUNE.own[r.id]=1;});
    toast(j.results.map(function(r){return r.summary;}).join(' · '),j.results.some(function(r){return r.error;})?'#7a2e33':undefined);
    PRUNE.plan=null;pruneHist();if(typeof refreshTrees==='function')refreshTrees(true);})
  .catch(function(){PRUNE.busy=false;renderPrune();toast('Prune failed','#7a2e33');});}
function pruneHist(){fetch('/api/trees/prune/history').then(function(r){return r.json();}).then(function(j){if(!j||!j.ok)return;
  var fresh=j.runs.filter(function(r){return r.id>PRUNE.lastId&&!PRUNE.own[r.id];});
  if(PRUNE.histInit&&fresh.length)toast(fresh.map(function(r){return r.summary+' ('+r.trigger+')';}).join(' · '));
  if(PRUNE.histInit&&fresh.some(function(r){return r.removed.length;})&&typeof refreshTrees==='function')refreshTrees(true);
  j.runs.forEach(function(r){if(r.id>PRUNE.lastId)PRUNE.lastId=r.id;});
  PRUNE.histInit=true;PRUNE.runs=j.runs;renderPruneHist();}).catch(function(){});}
function renderPruneHist(){var el=document.getElementById('tree-prune-hist');if(!el)return;
  if(!PRUNE.runs.length){el.innerHTML='';return;}
  el.innerHTML=PRUNE.runs.slice(0,5).map(function(r){
    var lines=r.removed.map(function(w){return '<li class="rm">removed '+pruneEsc(w.name)+(w.branchNote?' · '+pruneEsc(w.branchNote):(w.branchDeleted?' · branch deleted':''))+'</li>';})
      .concat(r.skipped.filter(function(s){return s.reason!=='the primary checkout'&&s.reason!=='not in the confirmed list';}).map(function(s){return '<li class="sk">kept '+pruneEsc(s.name)+' · '+pruneEsc(s.reason)+'</li>';}));
    if(r.error)lines.unshift('<li class="er">'+pruneEsc(r.error)+'</li>');
    return '<details><summary><span class="tpwhen">'+pruneEsc(rel(r.finished_at))+'</span><span class="tptrig">'+pruneEsc(r.trigger)+'</span><span>'+pruneEsc(r.summary)+'</span></summary>'
      +(lines.length?'<ul>'+lines.join('')+'</ul>':'')+'</details>';}).join('');}
setTimeout(pruneHist,1500);setInterval(pruneHist,20000);
`;
