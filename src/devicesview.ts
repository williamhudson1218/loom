// Settings › Devices: pair a phone with Loom's mobile app (the /m/ surface).
// Spliced into the Settings page by settingsview.ts, so it uses that page's helpers
// (sxRow, sxBtn, sxPill, sxNote, sxConfirm, sxJ, sxPost, sxRerender, toast). Plain browser
// CSS/JS in strings: no backslash, backtick or dollar-brace (the page script is spliced
// into a template string).
//
// Data is GET /api/devices, polled every 2 s while the section is open:
//   { phoneAccess: { on, state: off|on|no-tailscale|logged-out|error, url?, detail?, approveUrl? },
//     setup: { tailscaleInstalled, signedIn, magicDns, httpsCerts, iphone: none|offline|online,
//              phoneAccess, paired, notifications },
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
  #settings-section .devsteps { border:1px solid var(--sx-line); background:var(--sx-card); border-radius:10px; margin:8px 0 14px; padding:4px 14px; }
  #settings-section .devstep { padding:9px 0; border-top:1px solid var(--sx-line); display:flex; gap:10px; align-items:flex-start; }
  #settings-section .devstep:first-child { border-top:0; }
  #settings-section .devnum { flex:none; width:22px; height:22px; border-radius:50%; border:1px solid var(--sx-ctl-line); color:var(--sx-muted); font-size:12px; display:flex; align-items:center; justify-content:center; margin-top:1px; }
  #settings-section .devstep.done .devnum { background:var(--sx-green-bg); border-color:var(--sx-green); color:var(--sx-green); }
  #settings-section .devstep.cur .devnum { background:var(--sx-accent); border-color:var(--sx-accent); color:#08101f; font-weight:700; }
  #settings-section .devstep.pend { opacity:.6; }
  #settings-section .devstep .devbody { flex:1; min-width:0; }
  #settings-section .devstep .devttl { color:var(--sx-text); font-size:13.5px; }
  #settings-section .devstep .devtxt { color:var(--sx-text2); font-size:12.5px; line-height:1.55; margin-top:3px; }
  #settings-section .devstep .sxrow { margin-top:8px; }
  #settings-section .devdone { display:flex; align-items:center; gap:10px; justify-content:space-between; padding:8px 0; color:var(--sx-green); font-size:13.5px; }
  #settings-section .devreq { border:1px solid var(--sx-sel-line); background:var(--sx-accent-bg); border-radius:10px; padding:12px 14px; margin:8px 0; }
  #settings-section .devreq b { color:var(--sx-text); font-size:14px; }
  #settings-section .devreq ul { margin:8px 0 10px; padding-left:18px; color:var(--sx-text2); font-size:12.5px; line-height:1.6; }
`;

export const DEVICES_VIEW_JS = String.raw`
// ---- Settings › Devices ------------------------------------------------------------
` + QR_JS + String.raw`
var DEV={d:null,sig:'',err:'',t:0,n:0,hide:'',busy:false,exp:{},all:false};
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
  h+=devChecklist(d);
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
function devLink(url,label){return '<a href="'+sxEsc(url)+'" target="_blank" rel="noopener">'+sxEsc(label)+'</a>';}
function devApproveUrl(pa){var m=/https:[/][/]login[.]tailscale[.]com[/][^ "'<>)]+/.exec((pa&&(pa.approveUrl||pa.detail))||'');return m?m[0].replace(/[.,;]+$/,''):'';}
function devSteps(d){var s=d.setup;if(!s)return null;var pa=d.phoneAccess||{},np=(d.pending||[]).length,ap=devApproveUrl(pa);
  var steps=[
   {t:'Install Tailscale on this Mac',done:!!s.tailscaleInstalled,
    x:'Download the standalone app and open it. Homebrew cask installs fail from a non-interactive shell (the installer needs sudo).',
    a:devLink('https://tailscale.com/download/mac','Download Tailscale for Mac')+' <span class="def">or get it from the Mac App Store</span>'},
   {t:'Sign in to Tailscale on this Mac',done:!!s.signedIn,
    x:'Open Tailscale and allow the VPN configuration macOS asks for. Then click the menu bar icon, Log in, and sign in.',a:''},
   {t:'Turn on HTTPS for your tailnet',done:!!(s.magicDns&&s.httpsCerts),
    x:'In the Tailscale admin console, DNS page: make sure MagicDNS is on, then click Enable HTTPS under HTTPS Certificates.'+(s.signedIn?(s.magicDns?'':' MagicDNS is off.')+(s.httpsCerts?'':' HTTPS is not enabled yet.'):''),
    a:devLink('https://login.tailscale.com/admin/dns','Open the DNS page')},
   {t:'Put Tailscale on your iPhone',done:s.iphone!=='none',
    x:'Install the Tailscale app from the App Store, sign in with the same account, and turn on VPN On Demand in its settings so it stays connected.'+(s.iphone==='offline'?' Your iPhone is on the tailnet but offline right now.':''),a:''},
   {t:'Turn on Phone access',done:!!s.phoneAccess,
    x:'This shares Loom over Tailscale, and only the phone page.'+(ap?' Tailscale needs you to approve Serve for your tailnet first. Approve it, then turn Phone access on again.':''),
    a:(ap?devLink(ap,'Approve Serve for your tailnet')+' ':'')+sxBtn('dev_access','Turn on Phone access',{arg:'on',pri:!ap,dis:DEV.busy||!s.signedIn||!s.magicDns||!s.httpsCerts})},
   {t:'Pair your phone',done:!!(s.paired&&s.notifications),
    x:!s.paired?'Click Pair a phone and scan the QR code with the iPhone Camera (it opens Safari). Tap Share, Add to Home Screen, then open Loom from the Home Screen icon, not the Safari tab: the Home Screen app keeps its own storage, so pairing in Safari does not carry over. Enter the 8-character code, then click Allow here.'+(np?' A phone is waiting: click Allow below.':'')
     :'On the phone, open Loom from the Home Screen icon and tap Turn on notifications.',
    a:s.paired?'':sxBtn('dev_pair','Pair a phone',{pri:true,dis:!s.phoneAccess||DEV.busy})}
  ];
  return steps;}
function devChecklist(d){var steps=devSteps(d);if(!steps)return '';
  var cur=-1,i;for(i=0;i<steps.length;i++){if(!steps[i].done){cur=i;break;}}
  var h=sxGrp('Set up your phone');
  if(cur<0&&!DEV.all)return h+'<div class="devsteps"><div class="devdone"><span>Phone set up ✓</span>'+sxBtn('dev_all','Show steps',{ghost:true})+'</div></div>';
  h+='<div class="devsteps">';
  steps.forEach(function(st,n){var isCur=n===cur,open=isCur||(st.done&&DEV.exp[n]),cls=st.done?'done':isCur?'cur':'pend';
    h+='<div class="devstep '+cls+'"><div class="devnum">'+(st.done?'✓':(n+1))+'</div><div class="devbody"><div class="devttl">'+sxEsc(st.t)
     +(st.done?' <button type="button" class="sxbtn sm ghost" data-act="dev_step" data-arg="'+n+'">'+(open?'Hide':'Show')+'</button>':'')+'</div>'
     +(open||isCur?'<div class="devtxt">'+sxEsc(st.x)+'</div>'+(st.a?'<div class="sxrow">'+st.a+'</div>':''):'')+'</div></div>';});
  if(cur<0)h+='<div class="sxrow"><span class="def">Everything is done.</span>'+sxBtn('dev_all','Hide steps',{ghost:true})+'</div>';
  return h+'</div>';}
function devApply(j){if(j&&j.phoneAccess){DEV.d=j;DEV.sig=JSON.stringify(j);}}
function devAct(a,arg,btn){
  var fail=function(j){sxBad(sxErr(j));return devLoad();};
  if(a==='dev_access'){DEV.busy=true;sxRerender(true);sxPost('/api/devices/phone-access',{on:arg==='on'}).then(function(j){DEV.busy=false;if(j&&j.phoneAccess){devApply(j);sxRerender(true);}else fail(j).then(function(){sxRerender(true);});});return;}
  if(a==='dev_pair'){DEV.busy=true;sxRerender(true);sxPost('/api/devices/pair-start',{}).then(function(j){DEV.busy=false;DEV.hide='';if(j&&j.code){if(DEV.d)DEV.d.pairing={code:j.code,url:j.url,expires_at:j.expires_at};}else sxBad(sxErr(j));devLoad().then(function(){sxRerender(true);});});return;}
  if(a==='dev_step'){DEV.exp[arg]=!DEV.exp[arg];sxRerender(true);return;}
  if(a==='dev_all'){DEV.all=!DEV.all;sxRerender(true);return;}
  if(a==='dev_hide'){var pp=DEV.d&&DEV.d.pairing;DEV.hide=pp?pp.code:'';sxRerender(true);return;}
  if(a==='dev_allow'||a==='dev_deny'){var allow=a==='dev_allow';sxPost('/api/devices/'+(allow?'approve':'deny'),{id:arg}).then(function(j){if(j&&j.ok===false)sxBad(sxErr(j));else toast(allow?'Phone allowed':'Request denied');devLoad().then(function(){sxRerender(true);});});return;}
  if(a==='dev_revoke'){var dv=((DEV.d&&DEV.d.devices)||[]).filter(function(x){return String(x.id)===String(arg);})[0];
    sxConfirm({title:'Revoke this phone',body:sxEsc((dv&&dv.name)||'This phone')+' can no longer reach Loom, and its notifications stop. It has to be paired again to come back.',ok:'Revoke',danger:true}).then(function(y){if(!y)return;
      sxPost('/api/devices/revoke',{id:arg}).then(function(j){if(j&&j.ok===false)sxBad(sxErr(j));else toast('Phone revoked');devLoad().then(function(){sxRerender(true);});});});return;}
}
`;
