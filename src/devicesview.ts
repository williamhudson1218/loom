// Settings › Devices: pair a phone with Loom's mobile app (the /m/ surface).
// Spliced into the Settings page by settingsview.ts, so it uses that page's helpers
// (sxRow, sxBtn, sxPill, sxNote, sxConfirm, sxJ, sxPost, sxRerender, toast). Plain browser
// CSS/JS in strings: no backslash, backtick or dollar-brace (the page script is spliced
// into a template string).
//
// Data is GET /api/devices, polled every 2 s while the section is open:
//   { phoneAccess: { on, state: off|on|no-tailscale|logged-out|error, url?, detail? },
//     devices: [{ id, name, created_at, last_seen_at, push }],
//     pending: [{ id, name, requested_at }],
//     pairing: { code, url, expires_at } | null }
// Writes go through the same fetch wrapper as the rest of the page (it adds the launch token).

import { QR_JS } from './vendor/qrcode.ts';

export const DEVICES_VIEW_CSS = String.raw`
  #settings-section .devpair { display:flex; gap:20px; align-items:flex-start; flex-wrap:wrap; padding:14px; border:1px solid var(--sx-line); background:var(--sx-card); border-radius:10px; margin:8px 0 14px; }
  #settings-section .devqr { flex:none; width:196px; height:196px; border-radius:8px; overflow:hidden; background:#fff; }
  #settings-section .devqr svg { display:block; width:196px; height:196px; }
  #settings-section .devcode { font:700 30px/1.1 var(--sx-mono); letter-spacing:.08em; color:var(--sx-text); margin:4px 0 8px; }
  #settings-section .devmeta { display:flex; flex-direction:column; gap:6px; min-width:200px; flex:1; }
  #settings-section .devreq { border:1px solid var(--sx-sel-line); background:var(--sx-accent-bg); border-radius:10px; padding:12px 14px; margin:8px 0; }
  #settings-section .devreq b { color:var(--sx-text); font-size:14px; }
  #settings-section .devreq ul { margin:8px 0 10px; padding-left:18px; color:var(--sx-text2); font-size:12.5px; line-height:1.6; }
`;

export const DEVICES_VIEW_JS = String.raw`
// ---- Settings › Devices ------------------------------------------------------------
` + QR_JS + String.raw`
var DEV={d:null,sig:'',err:'',t:0,n:0,hide:'',busy:false};
function devMs(v){if(v==null||v==='')return 0;if(typeof v==='number')return v<1e12?v*1000:v;var t=Date.parse(v);return isNaN(t)?0:t;}
function devLoad(){return sxJ('/api/devices').then(function(j){
  if(j&&j.phoneAccess){var s=JSON.stringify(j);var ch=s!==DEV.sig;DEV.sig=s;DEV.d=j;DEV.err='';if(ch)sxRerender();}
  else{var m=(j&&(j.error||j.detail||j.hint))||'Could not load devices';if(DEV.err!==m||DEV.d){DEV.err=m;DEV.d=null;sxRerender();}}
}).catch(function(){DEV.err='Could not load devices';});}
function devCount(){var els=document.querySelectorAll('[data-dev-exp]');for(var i=0;i<els.length;i++){var ms=+els[i].getAttribute('data-dev-exp')-Date.now();
  els[i].textContent=ms<=0?'now':Math.floor(ms/60000)+':'+('0'+Math.floor(ms/1000)%60).slice(-2);}}
function devTick(){
  if(typeof tab==='undefined'||tab!=='settings'||SX.sec!=='devices'){clearInterval(DEV.t);DEV.t=0;return;}
  if(document.hidden)return;
  DEV.n++;devCount();if(DEV.n%2===0)devLoad();}
function devEnter(){if(!DEV.t){DEV.n=0;DEV.t=setInterval(devTick,1000);}devLoad();}
function devStatus(){var d=DEV.d;if(!d)return DEV.err?['off','Unavailable']:['off','Checking'];
  var pa=d.phoneAccess||{},np=(d.pending||[]).length;
  if(np)return ['warn',np+(np===1?' request waiting':' requests waiting')];
  if(pa.state==='on'){var n=(d.devices||[]).length;return ['ok',n?n+(n===1?' phone':' phones'):'On'];}
  if(pa.state==='no-tailscale')return ['warn','Tailscale not found'];
  if(pa.state==='logged-out')return ['warn','Tailscale signed out'];
  if(pa.state==='error')return ['err','Error'];
  return ['off','Off'];}
function devQr(url){try{return loomQrSvg(url,196);}catch(e){return '<p class="sxempty">Could not draw the code. Open this address on the phone: '+sxEsc(url)+'</p>';}}
function devAgo(v){var ms=devMs(v);return ms?sxAgo(ms):'never';}
function sxDevices(){var d=DEV.d;
  if(!d)return DEV.err?sxNote(sxEsc(DEV.err)+'. Loom may still be starting.','err'):'<p class="sxempty">loading…</p>';
  var pa=d.phoneAccess||{},st=pa.state||'off',on=st==='on',h='';
  var pill=on?sxPill('ok','On'):st==='off'?sxPill('off','Off'):st==='no-tailscale'?sxPill('warn','Tailscale not found'):st==='logged-out'?sxPill('warn','Tailscale signed out'):sxPill('err','Error');
  h+=sxGrp('Phone access');
  h+=sxRow('Reach Loom from your phone','Loom shares a private HTTPS address over Tailscale. Only devices signed in to your tailnet can open it, and only the phone page (/m/). Every other page, and the terminals, stay on this Mac. Nothing is exposed to the internet.',
    pill+sxBtn('dev_access',pa.on?'Turn off':'Turn on',{arg:pa.on?'off':'on',pri:!pa.on,dis:DEV.busy}));
  if(on&&pa.url)h+=sxNote('Address: <code>'+sxEsc(pa.url)+'</code>','ok');
  if(st==='no-tailscale')h+=sxNote('Install Tailscale on this Mac and on your iPhone, and sign in to both. Then turn Phone access on.'+(pa.detail?' <span class="def">'+sxEsc(pa.detail)+'</span>':''),'warn');
  else if(st==='logged-out')h+=sxNote('Tailscale is installed but signed out. Open it, sign in, then turn Phone access on.'+(pa.detail?' <span class="def">'+sxEsc(pa.detail)+'</span>':''),'warn');
  else if(st==='error')h+=sxNote(sxEsc(pa.detail||'Phone access failed to start.'),'err');
  else if(pa.detail&&st!=='off')h+=sxNote(sxEsc(pa.detail));
  h+=sxGrp('Pair a phone');
  var p=d.pairing,live=p&&p.code&&devMs(p.expires_at)>Date.now()-1000&&DEV.hide!==p.code;
  if(live){var exp=devMs(p.expires_at);
    h+='<div class="devpair"><div class="devqr">'+devQr(p.url||'')+'</div><div class="devmeta"><div class="def">Pairing code</div><div class="devcode">'+sxEsc(p.code)+'</div>'
      +'<div class="def">Expires in <b data-dev-exp="'+exp+'">…</b>. Five wrong tries burn the code.</div>'
      +'<div class="def">Scan with the iPhone camera, open it in Safari, add Loom to your Home Screen, then enter the code. Or open <code>'+sxEsc(p.url||'')+'</code> on the phone.</div>'
      +'<div class="sxrow">'+sxBtn('dev_pair','New code',{sm:false})+sxBtn('dev_hide','Hide',{sm:false,ghost:true})+'</div></div></div>';}
  else h+=sxRow('Pair a new phone','Shows a QR code and a code that expires in 5 minutes. You approve the phone here before it can do anything.',sxBtn('dev_pair','Pair a phone',{pri:true,dis:!on||DEV.busy}))+(on?'':sxNote('Turn Phone access on first.'));
  var pend=d.pending||[];
  if(pend.length){h+=sxGrp('Waiting for your approval');
    pend.forEach(function(r){h+='<div class="devreq"><b>Allow “'+sxEsc(r.name||'this phone')+'”?</b> <span class="def">asked '+devAgo(r.requested_at)+'</span><ul><li>Read sessions, transcripts and the outbox</li><li>Reply to and interrupt Claude sessions</li><li>Send outbox drafts as you</li><li>No terminals, shells or settings</li></ul>'
      +'<div class="sxrow" style="margin-top:0">'+sxBtn('dev_allow','Allow',{arg:r.id,pri:true,sm:false})+sxBtn('dev_deny','Deny',{arg:r.id,sm:false})+'</div></div>';});}
  h+=sxGrp('Paired devices');
  var devs=d.devices||[];
  if(!devs.length)h+='<p class="sxempty">No phones paired yet.</p>';
  devs.forEach(function(v){h+=sxRow(sxEsc(v.name||'Phone'),'Paired '+sxWhen(devMs(v.created_at))+' · last seen '+devAgo(v.last_seen_at)+' · notifications '+(v.push?'on':'off'),sxBtn('dev_revoke','Revoke',{arg:v.id,danger:true}));});
  return h;}
function devApply(j){if(j&&j.phoneAccess){DEV.d=j;DEV.sig=JSON.stringify(j);}}
function devAct(a,arg,btn){
  var fail=function(j){sxBad(sxErr(j));return devLoad();};
  if(a==='dev_access'){DEV.busy=true;sxRerender(true);sxPost('/api/devices/phone-access',{on:arg==='on'}).then(function(j){DEV.busy=false;if(j&&j.phoneAccess){devApply(j);sxRerender(true);}else fail(j).then(function(){sxRerender(true);});});return;}
  if(a==='dev_pair'){DEV.busy=true;sxRerender(true);sxPost('/api/devices/pair-start',{}).then(function(j){DEV.busy=false;DEV.hide='';if(j&&j.code){if(DEV.d)DEV.d.pairing={code:j.code,url:j.url,expires_at:j.expires_at};}else sxBad(sxErr(j));devLoad().then(function(){sxRerender(true);});});return;}
  if(a==='dev_hide'){var pp=DEV.d&&DEV.d.pairing;DEV.hide=pp?pp.code:'';sxRerender(true);return;}
  if(a==='dev_allow'||a==='dev_deny'){var allow=a==='dev_allow';sxPost('/api/devices/'+(allow?'approve':'deny'),{id:arg}).then(function(j){if(j&&j.ok===false)sxBad(sxErr(j));else toast(allow?'Phone allowed':'Request denied');devLoad().then(function(){sxRerender(true);});});return;}
  if(a==='dev_revoke'){var dv=((DEV.d&&DEV.d.devices)||[]).filter(function(x){return String(x.id)===String(arg);})[0];
    sxConfirm({title:'Revoke this phone',body:sxEsc((dv&&dv.name)||'This phone')+' can no longer reach Loom, and its notifications stop. It has to be paired again to come back.',ok:'Revoke',danger:true}).then(function(y){if(!y)return;
      sxPost('/api/devices/revoke',{id:arg}).then(function(j){if(j&&j.ok===false)sxBad(sxErr(j));else toast('Phone revoked');devLoad().then(function(){sxRerender(true);});});});return;}
}
`;
