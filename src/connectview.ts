// Connect GitHub and Connect Gmail: the page side, shared by Settings (GitHub and
// Outbox sections) and the setup wizard's Connections step. Each host passes a class
// map (its own button and note classes) and a redraw function; the markup and the
// polling live here once.
//
// Plain browser JS in a String.raw, spliced verbatim by dashboard.ts like the other
// views: it must never contain a dollar-brace or a backtick, and it avoids
// backslashes and regex literals.

export const CONNECT_VIEW_CSS = String.raw`
  .cn-code { display:inline-flex; align-items:center; gap:10px; font:600 22px/1 ui-monospace,SFMono-Regular,Menlo,monospace; letter-spacing:.12em; padding:10px 14px; border-radius:10px; border:1px solid #34406a; background:#1a2033; color:#fff; }
  .cn-log { margin:8px 0 0; background:#0a0c11; border:1px solid #232634; border-radius:8px; padding:8px 10px; font:11.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; color:#c4ccdc; max-height:150px; overflow:auto; white-space:pre-wrap; }
  .cn-stack > * + * { margin-top:10px; }
  .cn-stack a, .cn-help a { color:#6ea2ff; }
  .cn-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .cn-acct { display:flex; gap:8px; align-items:center; flex-wrap:wrap; padding:8px 10px; border:1px solid #232634; border-radius:9px; background:#0d0f15; }
  .cn-acct .e { flex:1; min-width:160px; font-size:13px; color:#e6e6e6; }
  .cn-acct input { width:130px; }
  .cn-help { font-size:12.5px; color:#c4ccdc; }
  .cn-help summary { cursor:pointer; color:#6ea2ff; }
  .cn-help ol { margin:6px 0 0; padding-left:18px; }
  .cn-help li { margin:3px 0; }
  .cn-tabs { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); gap:10px; }
  .cn-tabs .opt { min-height:86px; }
  .cn-tabs .opt .pill { margin-top:6px; }
`;

export const CONNECT_VIEW_JS = String.raw`
// ---- Connect GitHub / Connect Gmail ------------------------------------------------
var CN={gh:null,ghT:0,ghWin:null,ghOpened:0,ghConfirm:false,ghMsg:null,gm:null,gmO:null,gmMsg:null,gmBusy:false};
var CN_K_SX={btn:'sxbtn sm',pri:'sxbtn sm pri',ghost:'sxbtn sm ghost',danger:'sxbtn sm danger',note:'sxnote',input:''};
var CN_K_WZ={btn:'btn sm',pri:'btn pri',ghost:'btn sm ghost',danger:'btn sm danger',note:'note',input:''};
var CN_DEVICE='https://github.com/login/device';
function cnEsc(s){return String(s==null?'':s).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;').split('"').join('&quot;');}
function cnB(K,act,label,o){o=o||{};var c=o.pri?K.pri:o.danger?K.danger:o.ghost?K.ghost:K.btn;return '<button type="button" class="'+c+'" data-cn="'+act+'"'+(o.arg!=null?' data-arg="'+cnEsc(o.arg)+'"':'')+(o.dis?' disabled':'')+'>'+cnEsc(label)+'</button>';}
function cnNote(K,t,kind){return '<div class="'+K.note+(kind?' '+kind:'')+'">'+t+'</div>';}
function cnPill(cls,t){return '<span class="pill '+cls+'">'+cnEsc(t)+'</span>';}
function cnJ(u,o){return fetch(u,o||{}).then(function(r){return r.json().catch(function(){return {ok:false,error:'bad response'};});});}
function cnPost(u,b){return cnJ(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b||{})});}
function cnErr(j){return (j&&(j.hint||j.detail||j.error))||'That did not work.';}
// Opens a page in the default browser. Inside the Loom app every window.open goes to the
// system browser; in a plain browser tab a window opened during the click survives the popup blocker.
function cnPreopen(){return window.loomNative?null:window.open('about:blank','_blank');}
function cnGo(url,w){if(w){try{w.location.href=url;return;}catch(e){}}window.open(url,'_blank','noopener');}

/* ---- GitHub ---- */
// What the GitHub panel shows, from GET /api/github/status. Pure, so tests can call it.
function cnGhView(st){
  if(!st)return {kind:'checking',pill:['off','Checking']};
  if(st.ok===false)return {kind:'error',pill:['off','Could not check']};
  var j=st.job;
  if(j&&j.state==='running')return j.kind==='install'?{kind:'installing',pill:['warn','Installing gh']}:{kind:'waiting',pill:['warn',j.code?'Waiting for approval':'Starting']};
  if(st.state==='ok')return {kind:'ok',pill:['ok',st.login?'Connected as '+st.login:'Connected']};
  if(st.state==='missing'||!st.gh)return {kind:'missing',pill:['off','gh not installed']};
  if(st.state==='unauth')return {kind:'unauth',pill:['warn','Not signed in']};
  return {kind:'checking',pill:['off','Checking']};}
function cnGhLoad(redraw){cnJ('/api/github/status').then(function(j){CN.gh=j;cnGhTick(redraw);if(redraw)redraw();}).catch(function(){CN.gh={ok:false};if(redraw)redraw();});}
function cnGhTick(redraw){var j=CN.gh&&CN.gh.job;var running=j&&j.state==='running';
  if(running&&j.kind==='login'&&j.code&&CN.ghOpened!==j.id){CN.ghOpened=j.id;cnGo(j.url||CN_DEVICE,CN.ghWin);CN.ghWin=null;}
  if(running&&!CN.ghT){CN.ghT=setInterval(function(){cnJ('/api/github/status').then(function(s){CN.gh=s;var jj=s&&s.job;if(!jj||jj.state!=='running'){clearInterval(CN.ghT);CN.ghT=0;if(CN.ghWin){try{CN.ghWin.close();}catch(e){}CN.ghWin=null;}cnGhEnded(jj);cnJ('/api/github/status').then(function(s2){CN.gh=s2;if(redraw)redraw();});}else cnGhTick(redraw);if(redraw)redraw();});},1200);}}
function cnGhEnded(j){if(!j)return;if(j.state==='ok')CN.ghMsg=j.kind==='install'?{kind:'ok',text:'gh is installed. Connect GitHub to sign in.'}:{kind:'ok',text:'GitHub connected.'};
  else if(j.state==='cancelled')CN.ghMsg={kind:'',text:j.kind==='install'?'The install was cancelled.':'The GitHub sign-in was cancelled. Nothing changed.'};
  else CN.ghMsg={kind:'err',text:(j.kind==='install'?'The install failed: ':'The GitHub sign-in did not finish: ')+(j.error||'unknown error')};}
function cnGhHtml(K){var st=CN.gh,v=cnGhView(st),h='';
  var msg=CN.ghMsg?cnNote(K,cnEsc(CN.ghMsg.text),CN.ghMsg.kind):'';
  if(v.kind==='checking')return '<div class="cn-stack">'+cnPill('off','Checking')+'</div>';
  if(v.kind==='error')return '<div class="cn-stack">'+cnNote(K,'Loom could not check gh.','err')+cnB(K,'ghrefresh','Check again')+'</div>';
  var j=st.job;
  if(v.kind==='installing'){h+='<div class="cn-row">'+cnPill('warn','Installing gh with Homebrew')+cnB(K,'ghcancel','Cancel',{ghost:true})+'</div><pre class="cn-log">'+cnEsc((j.log||[]).join(String.fromCharCode(10))||'Starting brew install gh')+'</pre>';return '<div class="cn-stack">'+h+'</div>';}
  if(v.kind==='waiting'){
   if(!j.code)h+='<div class="cn-row">'+cnPill('warn','Starting gh')+cnB(K,'ghcancel','Cancel',{ghost:true})+'</div>';
   else h+='<div>Copy this code, then paste it on the GitHub page that opened in your browser.</div><div class="cn-row"><span class="cn-code">'+cnEsc(j.code)+'</span>'+cnB(K,'ghcopy','Copy code',{arg:j.code})+'</div><div class="cn-row"><a href="'+cnEsc(j.url||CN_DEVICE)+'" target="_blank" rel="noopener">Open github.com/login/device</a><span class="def">Waiting for you to approve in the browser.</span>'+cnB(K,'ghcancel','Cancel',{ghost:true})+'</div>';
   return '<div class="cn-stack">'+h+'</div>';}
  if(v.kind==='missing'){
   h+='<div class="cn-row">'+cnPill('off','gh is not installed')+'</div><div class="def">Loom uses the GitHub CLI (gh) for pull request status, checks, reviews and Ship.</div>';
   h+=st.brew?'<div class="cn-row">'+cnB(K,'ghinstall','Install with Homebrew',{pri:true})+'<span class="def">Runs brew install gh.</span></div>':'<div class="cn-row"><a href="https://cli.github.com" target="_blank" rel="noopener">Download gh from cli.github.com</a>'+cnB(K,'ghrefresh','Check again')+'</div>';
   return '<div class="cn-stack">'+msg+h+'</div>';}
  if(v.kind==='unauth'){h+='<div class="cn-row">'+cnPill('warn','Not signed in')+cnB(K,'ghlogin','Connect GitHub',{pri:true})+'</div><div class="def">Loom runs gh auth login. GitHub shows a one-time code here and opens its sign-in page in your browser. gh keeps the token; Loom never sees it.</div>';return '<div class="cn-stack">'+msg+h+'</div>';}
  h+='<div class="cn-row">'+cnPill('ok',v.pill[1])+(CN.ghConfirm?'':cnB(K,'ghagain','Sign in again',{ghost:true}))+cnB(K,'ghrefresh','Check again',{ghost:true})+'</div>';
  if(CN.ghConfirm)h+=cnNote(K,'Signing in again runs gh auth login for github.com. gh adds the account you approve and makes it the active one; your current login stays in gh.','warn')+'<div class="cn-row">'+cnB(K,'ghagainyes','Sign in again',{pri:true})+cnB(K,'ghagainno','Keep the current login',{ghost:true})+'</div>';
  return '<div class="cn-stack">'+msg+h+'</div>';}

/* ---- Gmail ---- */
function cnGmView(st){
  if(!st)return {kind:'checking',pill:['off','Checking']};
  if(st.ok===false)return {kind:'error',pill:['off','Could not check']};
  var acc=st.accounts||[],rc=acc.filter(function(a){return a.reconnect;}).length;
  if(CN.gmO)return {kind:'waiting',pill:['warn','Waiting for Google']};
  if(acc.length&&rc)return {kind:'reconnect',pill:['warn',rc===1?'An account needs reconnecting':rc+' accounts need reconnecting']};
  if(acc.length)return {kind:'ok',pill:['ok',acc.length===1?'Connected as '+acc[0].email:acc.length+' accounts connected']};
  if(st.route==='cli')return {kind:'cli',pill:['ok','Using the email CLI']};
  if(!st.clientId)return {kind:'noclient',pill:['off','Not set up']};
  return {kind:'ready',pill:['off','Not connected']};}
function cnGmLoad(redraw){cnJ('/api/google/status').then(function(j){CN.gm=j;if(redraw)redraw();}).catch(function(){CN.gm={ok:false};if(redraw)redraw();});}
function cnGmStop(){if(CN.gmO&&CN.gmO.t)clearInterval(CN.gmO.t);CN.gmO=null;}
function cnGmStart(redraw,email){cnGmStop();CN.gmMsg=null;var w=cnPreopen();
  cnPost('/api/google/oauth/start',email?{email:email}:{}).then(function(j){if(!j.ok){if(w)w.close();CN.gmMsg={kind:'err',text:cnErr(j)};if(redraw)redraw();return;}
   cnGo(j.url,w);var o={state:j.state,url:j.url,at:Date.now()};CN.gmO=o;if(redraw)redraw();
   o.t=setInterval(function(){if(CN.gmO!==o)return;if(Date.now()-o.at>600000){cnGmStop();CN.gmMsg={kind:'err',text:'Connect Gmail timed out. Start it again.'};if(redraw)redraw();return;}
    cnJ('/api/google/status?oauth='+encodeURIComponent(o.state)).then(function(st){if(CN.gmO!==o)return;var r=st&&st.oauth;if(!r||r.state==='pending')return;
     cnGmStop();CN.gm=st;CN.gmMsg=r.state==='ok'?{kind:'ok',text:'Gmail connected as '+r.email+'.'}:{kind:'err',text:r.hint||r.error||'Google sign-in did not finish.'};if(redraw)redraw();});},2000);
  }).catch(function(){if(w)w.close();CN.gmMsg={kind:'err',text:'Loom did not answer.'};if(redraw)redraw();});}
var CN_GHELP='<details class="cn-help"><summary>How to create the Google client (about five minutes, once)</summary><ol>'+
 '<li>Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener">console.cloud.google.com</a> and create a project (any name, such as Loom).</li>'+
 '<li>APIs and Services, Library: search for <b>Gmail API</b> and click Enable.</li>'+
 '<li>APIs and Services, OAuth consent screen (Google Auth Platform): choose <b>External</b>, fill in the app name and your email, and leave it in <b>Testing</b>. Under Audience, add every address you will connect as a <b>test user</b>.</li>'+
 '<li>Data access: add the scopes <code>gmail.send</code> and <code>gmail.metadata</code>. Loom also asks for your email address.</li>'+
 '<li>Clients (Credentials), Create credentials, OAuth client ID: application type <b>Desktop app</b>. Copy the client id and the client secret into the fields here.</li>'+
 '<li>Click Connect Gmail. Google shows "Google hasn’t verified this app": that is your own Testing app, so click Continue. A Testing app’s sign-in lasts seven days; Loom then asks you to reconnect.</li></ol></details>';
// o.fields: show the client id and secret inputs here (the wizard). Settings shows them as its own rows.
function cnGmHtml(K,o){o=o||{};var st=CN.gm,v=cnGmView(st),h='';
  if(v.kind==='checking')return '<div class="cn-stack">'+cnPill('off','Checking')+'</div>';
  if(v.kind==='error')return '<div class="cn-stack">'+cnNote(K,'Loom could not read the Gmail connection.','err')+cnB(K,'gmrefresh','Check again')+'</div>';
  var acc=st.accounts||[];
  if(CN.gmMsg)h+=cnNote(K,cnEsc(CN.gmMsg.text),CN.gmMsg.kind);
  if(o.fields){
   h+='<div class="cn-row"><input type="text" id="cn-gcid" class="mono" placeholder="Client id, ends in .apps.googleusercontent.com" value="'+cnEsc(st.clientId||'')+'" style="flex:2;min-width:220px"'+(st.clientIdFromEnv?' disabled':'')+'><input type="password" id="cn-gsec" placeholder="'+(st.hasSecret?'Client secret saved':'Client secret')+'" autocomplete="off" style="flex:1;min-width:140px">'+cnB(K,'gmsave','Save')+'</div>';}
  if(!st.clientId)h+='<div class="def">Connect Gmail needs your own Google client id and secret first.</div>';
  h+=CN_GHELP;
  if(acc.length)h+=acc.map(function(a){return '<div class="cn-acct"><span class="e">'+cnEsc(a.email)+'</span>'+
    '<label class="def">Draft label <input type="text" data-cn-label="'+cnEsc(a.email)+'" value="'+cnEsc(a.label===a.email?'':a.label)+'" placeholder="'+cnEsc(a.email)+'"></label>'+
    (a.isDefault?cnPill('ok','Default'):cnB(K,'gmdefault','Make default',{arg:a.email,ghost:true}))+
    (a.reconnect?cnPill('warn','Needs reconnecting')+cnB(K,'gmreconnect','Reconnect',{arg:a.email,pri:true}):'')+
    cnB(K,'gmdisc','Disconnect',{arg:a.email,danger:true})+'</div>';}).join('');
  if(CN.gmO)h+='<div class="cn-row"><span class="def">Waiting for you to approve in Google.</span><a href="'+cnEsc(CN.gmO.url)+'" target="_blank" rel="noopener">Open the Google page</a>'+cnB(K,'gmcancel','Cancel',{ghost:true})+'</div>';
  else h+='<div class="cn-row">'+cnB(K,'gmconnect',acc.length?'Add another account':'Connect Gmail',{pri:!acc.length,dis:!st.clientId})+'<span class="def">'+(acc.length?'The default account sends drafts that name no account. A draft names an account by its label or address.':'Sends email drafts as you and reads their threads (headers and snippets only) for the before-send check.')+'</span></div>';
  var rt=st.route==='gmail'?'Email drafts send through Gmail, built in.':st.route==='cli'?'Email drafts send through the Email CLI'+(st.cli?' ('+cnEsc(st.cli)+')':'')+'.':'Email drafts cannot send yet.';
  h+='<div class="def">'+rt+'</div>';
  return '<div class="cn-stack">'+h+'</div>';}

/* ---- actions; returns true when it handled the click ---- */
function cnAct(a,arg,redraw,btn){
  if(a==='ghrefresh'){CN.ghMsg=null;CN.gh=null;if(redraw)redraw();cnGhLoad(redraw);return true;}
  if(a==='ghlogin'||a==='ghagainyes'){CN.ghMsg=null;CN.ghConfirm=false;CN.ghWin=cnPreopen();
   cnPost('/api/github/login',{again:a==='ghagainyes'}).then(function(j){if(!j.ok){if(CN.ghWin){try{CN.ghWin.close();}catch(e){}CN.ghWin=null;}CN.ghMsg={kind:'err',text:cnErr(j)};cnGhLoad(redraw);return;}
    CN.gh=Object.assign({},CN.gh||{},{job:j.job});cnGhTick(redraw);if(redraw)redraw();});return true;}
  if(a==='ghagain'){CN.ghConfirm=true;if(redraw)redraw();return true;}
  if(a==='ghagainno'){CN.ghConfirm=false;if(redraw)redraw();return true;}
  if(a==='ghcancel'){cnPost('/api/github/cancel',{}).then(function(){cnGhLoad(redraw);});return true;}
  if(a==='ghinstall'){CN.ghMsg=null;cnPost('/api/github/install',{}).then(function(j){if(!j.ok){CN.ghMsg={kind:'err',text:cnErr(j)};cnGhLoad(redraw);return;}CN.gh=Object.assign({},CN.gh||{},{job:j.job});cnGhTick(redraw);if(redraw)redraw();});return true;}
  if(a==='ghcopy'){if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(arg).then(function(){if(btn)btn.textContent='Copied';},function(){if(btn)btn.textContent='Select and copy';});return true;}
  if(a==='gmrefresh'){CN.gm=null;CN.gmMsg=null;if(redraw)redraw();cnGmLoad(redraw);return true;}
  if(a==='gmconnect'){cnGmStart(redraw);return true;}
  if(a==='gmreconnect'){cnGmStart(redraw,arg);return true;}
  if(a==='gmcancel'){cnGmStop();if(redraw)redraw();return true;}
  if(a==='gmdefault'){cnPost('/api/google/account',{email:arg,'default':true}).then(function(j){if(!j.ok)CN.gmMsg={kind:'err',text:cnErr(j)};else CN.gm=j;if(redraw)redraw();});return true;}
  if(a==='gmdisc'){if(!window.confirm('Disconnect '+arg+'? Loom deletes its Gmail sign-in from the Keychain and revokes it at Google. Drafts for this account stop sending until you connect it again.'))return true;
   cnPost('/api/google/disconnect',{email:arg}).then(function(j){if(!j.ok)CN.gmMsg={kind:'err',text:cnErr(j)};else{CN.gm=j;CN.gmMsg={kind:'',text:arg+' was disconnected.'};}if(redraw)redraw();});return true;}
  if(a==='gmsave'){var ci=document.getElementById('cn-gcid'),cs=document.getElementById('cn-gsec');var o={};if(ci&&!ci.disabled)o.google_client_id=ci.value.trim();if(cs&&cs.value.trim())o.google_client_secret=cs.value.trim();
   cnPost('/api/settings',o).then(function(j){if(j&&j.ok===false){CN.gmMsg={kind:'err',text:cnErr(j)};if(redraw)redraw();return;}CN.gmMsg={kind:'ok',text:'Saved.'};cnGmLoad(redraw);});return true;}
  return false;}
// A draft-label input changed (Enter or blur).
function cnChange(t,redraw){if(!t||!t.dataset||t.dataset.cnLabel==null)return false;
  cnPost('/api/google/account',{email:t.dataset.cnLabel,label:t.value.trim()}).then(function(j){if(!j.ok)CN.gmMsg={kind:'err',text:cnErr(j)};else{CN.gm=j;CN.gmMsg=null;}if(redraw)redraw();});return true;}
`;
