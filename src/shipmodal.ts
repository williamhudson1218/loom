// The "View staged work" modal and its Ship confirm step. Markup, styles and
// client script are plain strings spliced into the dashboard page (the same
// pattern as orchview.ts). The client script uses no backticks and no dollar
// braces, so it survives the dashboard's template literal untouched.

export const SHIPMODAL_CSS = `
  .shipln { position:relative; }
  .shipln .shipbar { padding-right:96px; }
  .shipacts { position:absolute; right:6px; top:3px; height:24px; display:flex; align-items:center; gap:4px; }
  .shipgo { height:24px; padding:0 14px; border:1px solid transparent; border-radius:6px; background:#1f6f3f; color:#fff; font:inherit; font-size:12px; font-weight:650; cursor:pointer; box-shadow:0 1px 0 rgba(0,0,0,.25); }
  .shipgo:hover:not(:disabled) { background:#26844a; }
  .shipgo:focus-visible, .shipbtn:focus-visible { outline:2px solid var(--waiting_on_user); outline-offset:1px; }
  .shipgo:disabled { background:#1b1f2a; border-color:#2b3040; color:#6b7388; box-shadow:none; cursor:not-allowed; }
  .shipln.shipping .shipgo:disabled { color:#e8b04a; border-color:rgba(232,176,74,.45); background:rgba(232,176,74,.1); }
  .shipacts2 { display:flex; gap:6px; flex-wrap:wrap; }
  .shipbtn { height:26px; padding:0 11px; border:1px solid #2b3040; border-radius:6px; background:#1b1f2a; color:#c4ccdc; font:inherit; font-size:12px; font-weight:600; cursor:pointer; }
  .shipbtn:hover { background:#232836; border-color:#3a4155; color:#e6e9ef; }
  .shipbtn.on { border-color:#e8b84b; color:#e8b84b; background:rgba(212,167,44,.12); }
  .shiphint { font-size:11.5px; color:#8b93a7; }
  .shiphint code { background:#1b1f2a; padding:0 5px; border-radius:4px; font:11px ui-monospace,SFMono-Regular,Menlo,monospace; color:#c4ccdc; }
  .shipicon { width:24px; height:24px; border:0; border-radius:6px; background:transparent; color:#8b93a7; cursor:pointer; font-size:14px; line-height:24px; padding:0; }
  .shipicon:hover { background:rgba(255,255,255,.08); color:#e6e9ef; }
  .shipchip:disabled { opacity:.45; cursor:not-allowed; }
  #shipmodal { --sm-panel:#11141d; --sm-card:#161a24; --sm-inset:#0d1017; --sm-line:#232634; --sm-line2:#2b3040; --sm-ctl:#1b1f2a; --sm-text:#e6e9ef; --sm-text2:#c4ccdc; --sm-muted:#8b93a7; --sm-faint:#6b7388; --sm-accent:var(--waiting_on_user); --sm-amber:var(--warning); --sm-go:#1f6f3f; --sm-go-h:#26844a;
    z-index:30; background:rgba(0,0,0,.6); }
  #shipmodal * { box-sizing:border-box; }
  .smbox { position:relative; width:min(640px,100%); max-height:92vh; background:var(--sm-panel); border:1px solid var(--sm-line2); border-radius:14px; display:flex; flex-direction:column; overflow:hidden; box-shadow:0 24px 60px rgba(0,0,0,.5); color:var(--sm-text2); font-size:13px; }
  .smhead { padding:16px 20px 14px; display:flex; align-items:flex-start; gap:12px; }
  .smhead .grow { flex:1; min-width:0; }
  .smhead h2 { margin:0; font-size:16px; font-weight:650; color:var(--sm-text); }
  .smhead .sub { color:var(--sm-muted); font-size:12.5px; margin-top:2px; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .smhead .sep { color:var(--sm-faint); }
  .smhead code, .smnote code { background:var(--sm-ctl); padding:1px 6px; border-radius:4px; color:var(--sm-text2); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .smx { border:0; background:transparent; color:var(--sm-muted); width:28px; height:28px; border-radius:7px; font-size:15px; cursor:pointer; flex:none; }
  .smx:hover { background:var(--sm-ctl); color:var(--sm-text); }
  .a { color:#56d364; } .d { color:#ff7b72; }
  .smbody { padding:2px 20px 16px; display:flex; flex-direction:column; gap:12px; overflow:auto; flex:1; min-height:120px; }
  .smempty { color:var(--sm-faint); padding:20px 0; }
  .smcard { background:var(--sm-card); border:1px solid var(--sm-line); border-radius:10px; padding:12px 14px; }
  .smcard.miss { border-color:var(--sm-amber); }
  .smct { display:flex; align-items:center; gap:8px; font-size:12.5px; color:var(--sm-muted); }
  .smct .sdot { margin-top:0; }
  .smct .nm { color:var(--sm-text2); font-weight:600; cursor:pointer; } .smct .nm:hover { text-decoration:underline; }
  .smct .pn { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; }
  .smct .spacer { flex:1; }
  .smlab { margin:9px 0 8px; display:flex; flex-direction:column; gap:4px; }
  .smlab label { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:var(--sm-faint); display:flex; justify-content:space-between; }
  .smlab .smreq { display:none; color:var(--sm-amber); font-weight:600; text-transform:none; letter-spacing:0; font-size:12px; }
  .smcard.miss .smreq { display:inline; }
  .smlab input { width:100%; height:34px; background:var(--sm-inset); border:1px solid var(--sm-line2); border-radius:8px; padding:0 10px; color:var(--sm-text); font:inherit; font-size:13.5px; }
  .smlab input::placeholder { color:var(--sm-faint); }
  .smlab input:focus { outline:2px solid var(--sm-accent); outline-offset:-1px; }
  .smcard.miss .smlab input { border-color:var(--sm-amber); background:rgba(212,167,44,.12); }
  .smhint { display:none; font-size:11.5px; color:var(--sm-faint); }
  .smcard.miss .smhint { display:block; }
  .smlink, .smbody a { background:transparent; border:0; color:var(--sm-accent); font:inherit; font-size:12px; padding:0 4px; cursor:pointer; text-decoration:none; } .smlink:hover, .smbody a:hover { text-decoration:underline; }
  .smfoot a { color:var(--sm-accent); cursor:pointer; }
  .smf { margin:0; }
  .smfh { display:flex; align-items:center; gap:9px; width:100%; border:0; background:transparent; color:var(--sm-text2); font:12px ui-monospace,SFMono-Regular,Menlo,monospace; text-align:left; padding:4px 6px; border-radius:6px; cursor:pointer; }
  .smfh:hover { background:var(--sm-ctl); }
  .smfh .smv { flex:none; width:8px; color:var(--sm-faint); transition:transform .12s; } .smfh.on .smv { transform:rotate(90deg); }
  .smfh .smp { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .smfh .smp span { color:var(--sm-muted); } .smfh .smp b { font-weight:600; color:var(--sm-text); }
  .smfh .smn { flex:none; }
  .smfh .smtag { flex:none; font:11px -apple-system,Segoe UI,sans-serif; color:var(--sm-amber); background:rgba(212,167,44,.14); border-radius:999px; padding:0 6px; }
  .smtouched { margin-top:8px; padding-top:8px; border-top:1px dashed var(--sm-line); font-size:11.5px; color:var(--sm-faint); }
  .smtouched span.mono { font:11.5px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--sm-muted); }
  .smdiff { margin:2px 0 6px 18px; border:1px solid var(--sm-line); border-radius:6px; background:var(--sm-inset); overflow:auto; max-height:420px; font:11.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace; }
  .smdiff div { white-space:pre; padding:0 8px; min-width:max-content; }
  .smdiff .la { background:rgba(46,160,67,.16); color:#7ee787; } .smdiff .lr { background:rgba(248,81,73,.16); color:#ff9b94; }
  .smdiff .lh { color:#79b1ff; background:rgba(121,177,255,.08); } .smdiff .lm { color:var(--sm-faint); }
  .smdiff .lx { color:var(--sm-muted); }
  .smdiff button.more { margin:6px 8px; }
  .smown { border:1px dashed var(--sm-line2); border-radius:10px; padding:12px 14px; }
  .smown h3 { margin:0 0 6px; font-size:12.5px; font-weight:600; color:var(--sm-text2); } .smown h3 span { color:var(--sm-muted); font-weight:400; }
  .smown .smrow { display:flex; align-items:center; gap:8px; } .smown .smrow .smf { flex:1; min-width:0; }
  .smown select { flex:none; max-width:170px; height:28px; background:var(--sm-ctl); color:var(--sm-text2); border:1px solid var(--sm-line2); border-radius:7px; font-size:12px; padding:0 8px; }
  .smfoot { padding:12px 20px; border-top:1px solid var(--sm-line); display:flex; align-items:center; gap:10px; background:var(--sm-panel); flex-wrap:wrap; }
  .smfoot .spacer { flex:1; }
  .smgate { font-size:12.5px; color:var(--sm-amber); } .smgate.ok { color:var(--sm-muted); }
  .smnote { font-size:12px; color:var(--sm-muted); }
  .smbtn { height:34px; padding:0 14px; border-radius:8px; border:1px solid var(--sm-line2); background:transparent; color:var(--sm-text2); font:inherit; font-weight:500; font-size:13px; cursor:pointer; }
  .smbtn:hover { background:var(--sm-ctl); }
  .smbtn.ghost { border-color:transparent; color:var(--sm-muted); }
  .smbtn.pri { background:var(--sm-go); border-color:transparent; color:#fff; font-weight:650; padding:0 18px; } .smbtn.pri:hover { background:var(--sm-go-h); }
  .smbtn.pri:disabled { background:var(--sm-ctl); color:var(--sm-faint); cursor:not-allowed; }
  .smsum { border:1px solid var(--sm-line); border-radius:10px; overflow:hidden; }
  .smsum .r { display:flex; gap:10px; align-items:baseline; padding:9px 14px; background:var(--sm-card); }
  .smsum .r + .r { border-top:1px solid var(--sm-line); }
  .smsum .l { flex:1; min-width:0; color:var(--sm-text); } .smsum .m { color:var(--sm-muted); font-size:12px; flex:none; }
  .smsteps { margin:0; padding:0; list-style:none; display:flex; flex-direction:column; gap:10px; }
  .smsteps li { display:flex; gap:12px; align-items:flex-start; color:var(--sm-text2); }
  .smsteps .i { flex:none; width:22px; height:22px; border-radius:50%; background:var(--sm-ctl); border:1px solid var(--sm-line2); display:grid; place-items:center; font-size:11px; font-weight:700; color:var(--sm-muted); }
  .smsteps small { display:block; color:var(--sm-muted); font-size:12px; }
  .smsteps li.sdone .i { background:rgba(46,160,67,.14); border-color:transparent; color:#56d364; }
  .smsteps li.snow .i { border-color:var(--sm-accent); color:var(--sm-accent); } .smsteps li.snow { color:var(--sm-text); }
  .smsteps li.slater { opacity:.6; }
  .smspin { display:inline-block; width:10px; height:10px; border:2px solid var(--sm-accent); border-right-color:transparent; border-radius:50%; animation:smspin 1s linear infinite; }
  @keyframes smspin { to { transform:rotate(360deg); } }
  @media (prefers-reduced-motion:reduce) { .smspin { animation:none; } }
  .smok { width:34px; height:34px; border-radius:50%; background:rgba(46,160,67,.14); color:#56d364; display:grid; place-items:center; font-size:17px; flex:none; }
  .smerr { color:#ff7b72; font-size:12.5px; }
`;

export const SHIPMODAL_HTML = `<div id="shipmodal" class="loverlay" hidden>
  <div class="smbox" role="dialog" aria-modal="true" aria-labelledby="smtitle">
    <div class="smhead" id="smhead"></div>
    <div class="smbody" id="smbody"></div>
    <div class="smfoot" id="smfoot"></div>
  </div>
</div>`;

// One dialog, three views in the same box: review (a card per chat), confirm
// (what is about to go out) and started (the session is running).
export const SHIPMODAL_JS = String.raw`
var SM={open:false,repo:'',d:null,view:'review',lab:{},exp:{},diffs:{},more:{},busy:false,err:'',loading:false,failed:'',started:null};
var SM_CAP=300;
function smNL(){return String.fromCharCode(10);}
function smN(f){return f.binary?'<span class="dsub">binary</span>':'<span class="a">+'+f.added+'</span> <span class="d">−'+f.deleted+'</span>';}
function smDot(key){const c=chatByKey(key);return c?dotCls(c):'d-stale';}
function smPane(key){const L=DATA.live[key];return L&&L.name?'@'+L.name:'';}
function smChatName(key){const c=chatByKey(key);return c?disp(c):key.slice(key.indexOf(':')+1,key.indexOf(':')+9);}
function smSid(key){return key.slice(key.indexOf(':')+1);}
function smPlural(n,one,many){return n+' '+(n===1?one:many);}
function smSaved(c){return (c.labelSource==='db'||c.labelSource==='file')?c.label:'';}
function smLabelOf(c){return (SM.lab[c.key]!==undefined?SM.lab[c.key]:smSaved(c)).trim();}
function smMissing(d){return d.labelRequired?d.chats.filter(c=>!smLabelOf(c)).length:0;}
function smLoad(){SM.loading=true;fetch('/api/ship/detail?repo='+encodeURIComponent(SM.repo)).then(r=>r.json()).then(j=>{SM.loading=false;if(!j.ok){SM.failed=j.detail||'failed';}else{SM.failed='';SM.d=j.detail;}smRender();}).catch(()=>{SM.loading=false;SM.failed='server off?';smRender();});}
function openShipModal(repo,confirm){SM.open=true;SM.repo=repo;SM.d=null;SM.lab={};SM.exp={};SM.diffs={};SM.more={};SM.view=confirm?'confirm':'review';SM.err='';SM.failed='';SM.busy=false;SM.started=null;$('#shipmodal').hidden=false;smRender();smLoad();}
function closeShipModal(){SM.open=false;$('#shipmodal').hidden=true;}
function smOpenChat(key){const i=key.indexOf(':');closeShipModal();selectChat(key.slice(i+1),key.slice(0,i));}
function smPathHtml(p){const i=p.lastIndexOf('/');return '<span class="smp" dir="ltr">'+(i<0?'':'<span>'+esc(p.slice(0,i+1))+'</span>')+'<b>'+esc(p.slice(i+1))+'</b></span>';}
function smFile(f,side){const id=side+':'+f.path;const on=!!SM.exp[id];
  let h='<div class="smf"><button class="smfh'+(on?' on':'')+'" data-smdiff="'+esc(id)+'" title="'+esc(f.path)+'"><span class="smv">›</span>'+smPathHtml(f.path)+(side==='unstaged'?'<span class="smtag">'+(f.state==='partial'?'also unstaged':esc(f.state))+'</span>':'')+'<span class="smn">'+(f.state==='untracked'?'<span class="dsub">new</span>':smN(f))+'</span></button>';
  if(on)h+=smDiffHtml(id,f);
  return h+'</div>';}
function smDiffHtml(id,f){const x=SM.diffs[id];if(!x)return '<div class="smdiff"><div class="lx">loading…</div></div>';
  if(x.err)return '<div class="smdiff"><div class="lx">'+esc(x.err)+'</div></div>';
  if(!x.diff.trim())return '<div class="smdiff"><div class="lx">'+(f.state==='untracked'?'untracked: no diff until it is staged':'no diff')+'</div></div>';
  const lines=x.diff.split(smNL());const cap=SM.more[id]||SM_CAP;let h='<div class="smdiff">';
  lines.slice(0,cap).forEach(l=>{const c=l.charAt(0);const k=l.indexOf('+++')===0||l.indexOf('---')===0||l.indexOf('diff ')===0||l.indexOf('index ')===0?'lm':c==='+'?'la':c==='-'?'lr':c==='@'?'lh':'lx';h+='<div class="'+k+'">'+esc(l)+' </div>';});
  if(lines.length>cap)h+='<button class="more" data-smmore="'+esc(id)+'">show more ('+(lines.length-cap)+' lines)</button>';
  else if(x.truncated)h+='<div class="lx">diff truncated at 400 KB</div>';
  return h+'</div>';}
function smToggleDiff(id){if(SM.exp[id]){delete SM.exp[id];smRender();return;}SM.exp[id]=1;smRender();if(SM.diffs[id])return;
  const i=id.indexOf(':');const which=id.slice(0,i),p=id.slice(i+1);
  fetch('/api/ship/diff?repo='+encodeURIComponent(SM.repo)+'&path='+encodeURIComponent(p)+'&which='+which).then(r=>r.json()).then(j=>{SM.diffs[id]=j.ok?{diff:j.diff,truncated:j.truncated}:{err:j.detail||'failed'};smRender();}).catch(()=>{SM.diffs[id]={err:'server off?'};smRender();});}
function smCloseBtn(){return '<button class="smx" data-smclose="1" title="Close (Esc)" aria-label="Close">✕</button>';}
function smHeadHtml(d){
  if(SM.view==='started'){const st=SM.started||{};const L=Object.keys(DATA.live).map(k=>DATA.live[k]).find(x=>x.pane_id===st.pane);
    return '<span class="smok">✓</span><div class="grow"><h2 id="smtitle">Ship session started</h2><div class="sub">Running in '+(L&&L.name?'<span class="mono">@'+esc(L.name)+'</span>':'a new chat')+(st.where?'<span class="sep">·</span><span>'+esc(st.where)+'</span>':'')+'</div></div>'+smCloseBtn();}
  if(!d)return '<div class="grow"><h2 id="smtitle">Ship staged work</h2></div>'+smCloseBtn();
  if(SM.view==='confirm')return '<div class="grow"><h2 id="smtitle">Ship '+smPlural(d.totals.staged,'file','files')+' as one batch?</h2><div class="sub">Starts a new Claude session in this checkout and runs <code>'+esc(d.commands.plain)+'</code>.</div></div>'+smCloseBtn();
  return '<div class="grow"><h2 id="smtitle">Ship staged work</h2><div class="sub"><span>'+esc(d.repo.split('/').pop())+'</span><span class="sep">·</span><span>'+(d.onMain?esc(d.base||'main'):'not on '+esc(d.base||'main'))+'</span><span class="sep">·</span><span>'+smPlural(d.totals.staged,'file','files')+'</span><span class="a">+'+d.totals.added+'</span><span class="d">−'+d.totals.deleted+'</span><span class="sep">·</span><span>'+smPlural(d.chats.length,'chat','chats')+'</span></div></div>'+smCloseBtn();}
function smChatHtml(c,d){const pane=smPane(c.key);const cur=SM.lab[c.key]!==undefined?SM.lab[c.key]:smSaved(c);const miss=d.labelRequired&&!cur.trim();
  const id='smlab-'+esc(smSid(c.key));
  let h='<div class="smcard'+(miss?' miss':'')+'" data-smcard="'+esc(c.key)+'"><div class="smct"><span class="sdot '+smDot(c.key)+'"></span><span class="nm" data-smchat="'+esc(c.key)+'">'+esc(smChatName(c.key))+'</span>'+(pane?'<span class="pn">'+esc(pane)+'</span>':'')+'<span class="spacer"></span><span>'+smPlural(c.staged.length,'file','files')+'</span></div>';
  h+='<div class="smlab"><label for="'+id+'">Ship label'+(d.labelRequired?'<span class="smreq">Required</span>':'')+'</label><input id="'+id+'" data-smlabel="'+esc(c.key)+'" value="'+esc(cur)+'" maxlength="200" placeholder="Describe this change in one line" autocomplete="off"'+(TERM_TOKEN?'':' disabled')+'>'+
    (c.title?'<span class="smhint">Chat title is “'+esc(c.title)+'”. <button class="smlink" data-smusetitle="'+esc(c.key)+'">Use it</button></span>':'')+'</div>';
  h+=c.staged.map(f=>smFile(f,'staged')).join('');
  if(c.unstaged.length){const shown=c.unstaged.slice(0,3).map(f=>'<span class="mono">'+esc(f.path)+'</span>').join(', ');
    h+='<div class="smtouched">Also touched, not staged (won’t ship): '+shown+(c.unstaged.length>3?' and '+(c.unstaged.length-3)+' more':'')+'</div>';}
  return h+'</div>';}
function smAssignOptions(){const rows=[];Object.keys(DATA.live).forEach(k=>{const c=chatByKey(k);if(c)rows.push([k,(smPane(k)||'')+' '+disp(c)]);});
  return '<option value="">Assign to…</option>'+rows.sort((a,b)=>a[1].localeCompare(b[1])).map(r=>'<option value="'+esc(r[0])+'">'+esc(r[1].trim())+'</option>').join('');}
function smUnHtml(d){if(!d.unattributed.length)return '';
  let h='<div class="smown"><h3>Needs an owner <span>· '+smPlural(d.unattributed.length,'file','files')+' no chat claims</span></h3>';
  d.unattributed.forEach(f=>{const side=(f.state==='staged'||f.state==='partial')?'staged':'unstaged';const g=f.guess;
    h+='<div class="smrow">'+smFile(f,side)+(g?'<button class="smlink" data-smassign="'+esc(f.path)+'" data-smkey="'+esc(g.key)+'">Use '+esc(smPane(g.key)||smChatName(g.key))+'</button>':'')+
      '<select data-smpick="'+esc(f.path)+'" aria-label="Assign '+esc(f.path)+' to a chat" '+(TERM_TOKEN?'':'disabled')+'>'+smAssignOptions()+'</select></div>';});
  return h+'</div>';}
function smSumHtml(d){const rows=d.chats.map(c=>{const a=c.staged.reduce((n,f)=>n+f.added,0),x=c.staged.reduce((n,f)=>n+f.deleted,0);
    return '<div class="r"><span class="l">'+esc(smLabelOf(c)||c.title||smChatName(c.key))+'</span><span class="m">'+smPlural(c.staged.length,'file','files')+' · <span class="a">+'+a+'</span> <span class="d">−'+x+'</span></span></div>';});
  const un=d.unattributed.filter(f=>f.state==='staged'||f.state==='partial');
  if(un.length)rows.push('<div class="r"><span class="l">Files no chat claims</span><span class="m">'+smPlural(un.length,'file','files')+' · <span class="a">+'+un.reduce((n,f)=>n+f.added,0)+'</span> <span class="d">−'+un.reduce((n,f)=>n+f.deleted,0)+'</span></span></div>');
  return '<div class="smsum">'+rows.join('')+'</div>';}
function smStepsHtml(items){return '<ol class="smsteps">'+items.map((s,i)=>'<li class="'+(s[0]||'')+'"><span class="i">'+(s[0]==='sdone'?'✓':s[0]==='snow'?'<span class="smspin"></span>':(i+1))+'</span><span>'+s[1]+(s[2]?'<small>'+s[2]+'</small>':'')+'</span></li>').join('')+'</ol>';}
function smBodyHtml(d){
  if(!d)return '<div class="smempty">'+(SM.failed?esc(SM.failed):'Loading…')+'</div>';
  if(SM.view==='started')return smStepsHtml([['sdone','Session launched',smPlural(d.totals.staged,'staged file','staged files')+' locked for this ship.'],['snow','Committing and opening the pull request','Watch it in the ship session.'],['slater','Merge when CI and review are green']])+'<div class="smnote">Other chats can keep working. New staged files wait for the next ship.</div>';
  if(SM.view==='confirm')return smSumHtml(d)+smStepsHtml([['','Commit the staged files as one batch','Unstaged changes are left alone.'],['','Open a <span class="mono">ship/</span> pull request','Labels become the PR’s change list.'],['','Merge when CI and review are green','Production deploy follows.']])+(SM.err?'<div class="smerr">'+esc(SM.err)+'</div>':'');
  let b=d.chats.map(c=>smChatHtml(c,d)).join('')+smUnHtml(d);
  if(!d.chats.length&&!d.unattributed.length)b='<div class="smempty">Nothing staged.</div>';
  if(d.onlyUnstagedChats)b+='<div class="smnote">'+d.onlyUnstagedChats+' more '+(d.onlyUnstagedChats===1?'chat is':'chats are')+' working in this checkout with nothing staged yet.</div>';
  return b;}
// The footer's message: why Ship is or is not available.
function smGateInfo(d){
  if(!d.gate.ok){const l=d.lock;
    if(l&&!l.stale){const who=l.holderKey?(smPane(l.holderKey)||smChatName(l.holderKey)):(l.sessionId.slice(0,8)||'unknown');
      return {ok:false,cls:'',html:'Shipping now: '+(l.holderKey?'<a data-smchat="'+esc(l.holderKey)+'">'+esc(who)+'</a>':esc(who))+', '+smPlural(l.batch,'file','files')};}
    return {ok:false,cls:'',html:esc(d.gate.reason)};}
  if(d.labelRequired){const m=smMissing(d);
    if(m)return {ok:false,cls:'',html:'⚠ '+m+(m===1?' label':' labels')+' missing'};
    if(d.chats.length)return {ok:true,cls:' ok',html:'✓ All '+d.chats.length+(d.chats.length===1?' chat':' chats')+' labelled'};}
  return {ok:true,cls:' ok',html:''};}
function smFootHtml(d){
  if(SM.view==='started')return '<span class="spacer"></span><button class="smbtn" data-smclose="1">Close</button><button class="smbtn pri" data-smopen="1">Open ship session</button>';
  if(!d)return '<span class="spacer"></span><button class="smbtn" data-smclose="1">Close</button>';
  if(SM.view==='confirm')return '<span class="smnote">Nothing is committed until you start.</span><span class="spacer"></span><button class="smbtn" data-smback="1">Back</button><button class="smbtn pri" data-smgo="1" '+(SM.busy?'disabled':'')+'>'+(SM.busy?'Starting…':'Start ship session')+'</button>';
  const g=smGateInfo(d);
  return '<button class="smbtn ghost" data-smrefresh="1">Refresh</button><span class="spacer"></span><span class="smgate'+g.cls+'" id="smgate">'+g.html+'</span><button class="smbtn" data-smclose="1">Cancel</button><button class="smbtn pri" id="smshipbtn" data-smship="1" '+(g.ok&&TERM_TOKEN?'':'disabled')+' title="'+esc(g.ok?'Review and start '+(d.command||'the ship command'):'')+'">Review and ship</button>';}
function smRender(){if(!SM.open)return;const d=SM.d;
  $('#smhead').innerHTML=smHeadHtml(d);
  const body=$('#smbody');const top=body.scrollTop;body.innerHTML=smBodyHtml(d);body.scrollTop=top;
  $('#smfoot').innerHTML=smFootHtml(d);}
// Typing in a label re-evaluates the gate without re-rendering, so the field keeps focus.
function smUpdateGate(){const d=SM.d;if(!d||SM.view!=='review')return;
  document.querySelectorAll('#shipmodal [data-smcard]').forEach(el=>{const c=d.chats.find(x=>x.key===el.dataset.smcard);if(c)el.classList.toggle('miss',d.labelRequired&&!smLabelOf(c));});
  const g=smGateInfo(d);const el=$('#smgate');if(el){el.className='smgate'+g.cls;el.innerHTML=g.html;}
  const b=$('#smshipbtn');if(b)b.disabled=!(g.ok&&TERM_TOKEN);}
function smSaveLabel(key){const d=SM.d;const c=d&&d.chats.find(x=>x.key===key);if(!c||SM.lab[key]===undefined)return;const v=SM.lab[key].trim();if(v===smSaved(c))return;
  fetch('/api/ship/label',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo:SM.repo,session_id:smSid(key),label:v})}).then(r=>r.json()).then(j=>{
    if(!j.ok){toast(j.detail||'label not saved','#8a2f2f');return;}c.label=v;c.labelSource=v?'db':'none';}).catch(()=>toast('server off?','#8a2f2f'));}
function smFlushLabels(){if(SM.d)SM.d.chats.forEach(c=>smSaveLabel(c.key));}
function smUseTitle(key){const c=SM.d&&SM.d.chats.find(x=>x.key===key);if(!c)return;SM.lab[key]=c.title;
  document.querySelectorAll('#shipmodal [data-smlabel]').forEach(x=>{if(x.dataset.smlabel===key)x.value=c.title;});
  smSaveLabel(key);smUpdateGate();}
function smAssign(path,key){fetch('/api/ship/assign',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo:SM.repo,path,key})}).then(r=>r.json()).then(j=>{if(!j.ok){toast(j.detail||'assign failed','#8a2f2f');return;}toast('assigned');smLoad();}).catch(()=>toast('server off?','#8a2f2f'));}
// "Add <repo> to Ship": the board's ship line calls this for a candidate from GET /api/ship/candidates.
function shipAddRepo(repo,after){fetch('/api/ship/projects',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({path:repo})}).then(r=>r.json()).then(j=>{if(!j.ok){toast(j.detail||'could not add','#8a2f2f');return;}toast('added to Ship');if(after)after(j.project);}).catch(()=>toast('server off?','#8a2f2f'));}
function smGo(){if(SM.busy)return;SM.busy=true;SM.err='';smRender();
  fetch('/api/ship/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({repo:SM.repo})}).then(r=>r.json()).then(j=>{SM.busy=false;
    if(!j.ok){SM.err=j.detail||'failed';smRender();return;}
    SM.started={pane:j.pane_id,where:j.where};SM.view='started';smRender();refresh();setTimeout(smRender,1500);}).catch(()=>{SM.busy=false;SM.err='server off?';smRender();});}
function smOpenSession(){const pane=SM.started&&SM.started.pane;closeShipModal();if(pane)smSelectLaunched(pane,0);}
function smSelectLaunched(pane,n){refresh();setTimeout(()=>{const k=Object.keys(DATA.live).find(x=>DATA.live[x].pane_id===pane);if(k){const i=k.indexOf(':');selectChat(k.slice(i+1),k.slice(0,i));return;}if(n<20)smSelectLaunched(pane,n+1);},1500);}
function wireShipModal(){const m=$('#shipmodal');
  m.addEventListener('mousedown',e=>{if(e.target.id==='shipmodal'&&SM.view!=='confirm')closeShipModal();});
  m.addEventListener('click',e=>{const t=e.target.closest('[data-smclose],[data-smdiff],[data-smmore],[data-smchat],[data-smassign],[data-smrefresh],[data-smship],[data-smback],[data-smgo],[data-smopen],[data-smusetitle]');if(!t)return;
    if(t.dataset.smclose)closeShipModal();else if(t.dataset.smdiff)smToggleDiff(t.dataset.smdiff);
    else if(t.dataset.smmore){SM.more[t.dataset.smmore]=(SM.more[t.dataset.smmore]||SM_CAP)+600;smRender();}
    else if(t.dataset.smchat)smOpenChat(t.dataset.smchat);else if(t.dataset.smassign)smAssign(t.dataset.smassign,t.dataset.smkey);
    else if(t.dataset.smusetitle)smUseTitle(t.dataset.smusetitle);
    else if(t.dataset.smrefresh){SM.diffs={};smLoad();}else if(t.dataset.smship){smFlushLabels();SM.view='confirm';SM.err='';smRender();}
    else if(t.dataset.smback){SM.view='review';SM.err='';smRender();}else if(t.dataset.smgo)smGo();else if(t.dataset.smopen)smOpenSession();});
  m.addEventListener('input',e=>{const t=e.target;if(t.dataset&&t.dataset.smlabel){SM.lab[t.dataset.smlabel]=t.value;smUpdateGate();}});
  m.addEventListener('change',e=>{const t=e.target;if(t.dataset&&t.dataset.smlabel)smSaveLabel(t.dataset.smlabel);else if(t.dataset&&t.dataset.smpick&&t.value)smAssign(t.dataset.smpick,t.value);});
  m.addEventListener('keydown',e=>{const t=e.target;if(e.key==='Enter'&&t.dataset&&t.dataset.smlabel){e.preventDefault();t.blur();}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&SM.open){e.stopPropagation();e.preventDefault();if(SM.view==='confirm'&&!SM.busy){SM.view='review';smRender();}else closeShipModal();}},true);}
function shipGate(b){const l=b.lock;if(l&&!l.stale)return 'A ship is already in progress.';if(!b.onMain)return 'The checkout is not on '+(b.base||'main')+'.';if(b.next.staged<=0)return 'Nothing is staged.';return '';}
`;
