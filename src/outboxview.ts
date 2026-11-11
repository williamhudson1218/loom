// The Outbox: Slack drafts that chats propose, shown the way Slack would show
// them, and emails, shown the way a mail client would (src/outboxemail.ts). Before
// any Send goes out the server re-reads the draft's thread(s); anything new from
// someone else stops it, and the confirm lists it with one Send anyway. A draft may also carry a GitHub PR review (verdict, body, inline
// comments) and Slack reactions; the card shows the review above the Slack
// preview, and Send posts the whole bundle (review, then messages, then reactions). Each chat has its own outbox: a thin strip on the right edge of the chat
// view (both tabs) when that chat has pending drafts, which expands into a drawer
// with the full Slack-style cards. There is no global all-drafts view.
// Every write still goes through /api/outbox/send|discard (the CLI lock and the
// pending re-check live there); nothing here talks to Slack. Plain browser JS in
// strings, embedded verbatim by dashboard.ts. String.raw, no dollar-brace.

export const OUTBOX_VIEW_CSS = String.raw`
  #chatwrap { display:flex; min-width:0; min-height:0; }
  #chatwrap > #chatmain { flex:1 1 auto; min-width:0; }
  #boardwrap.tk #chatwrap { display:none; }
  #outrail { flex:0 0 400px; width:400px; border-left:1px solid #232634; background:#0d1016; display:flex; flex-direction:column; min-height:0; overflow:hidden; }
  #outrail[hidden] { display:none; }
  #chatwrap[data-rail="collapsed"] #outrail { flex-basis:28px; width:28px; }
  .orh2 { display:flex; align-items:center; gap:8px; padding:10px 14px; border-bottom:1px solid #1d2130; font-size:12px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; color:#a9c6ff; }
  .orh2 .sp { flex:1; }
  .orh2 button { background:transparent; color:#8a90a2; padding:2px 8px; font-size:14px; }
  .orh2 button:hover { color:#e4e7ee; background:#1b2233; }
  #outcards { flex:1 1 auto; min-height:0; overflow-y:auto; padding:12px; display:flex; flex-direction:column; gap:12px; }
  #outcards > * { flex-shrink:0; } /* cards clip their corners (overflow:hidden), which would otherwise let flex squash them instead of scrolling */
  .orailtab { width:100%; height:100%; border-radius:0; background:transparent; display:flex; flex-direction:column; align-items:center; gap:8px; padding:10px 0; color:#a9c6ff; font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; }
  .orailtab .oglyph { font-size:14px; line-height:1; }
  .orailtab .odest { width:18px; height:18px; border-radius:4px; background:#2a3a63; color:#e4e7ee; display:flex; align-items:center; justify-content:center; font-size:10px; letter-spacing:0; }
  .orailtab:hover { background:#141826; }
  .orailtab .vt { writing-mode:vertical-rl; }
  .orailtab .obadge { writing-mode:horizontal-tb; }
  .outpin { margin-top:0; }
  .outpin .oic { background:#2a2140; }
  .draft.sdraft { border:1px solid #2c3a63; border-left:3px solid #6ea2ff; border-radius:10px; padding:0; background:#121a2e; gap:0; overflow:hidden; }
  .dhd { display:flex; flex-wrap:wrap; align-items:center; gap:6px 10px; padding:9px 12px; background:#151f38; font-size:12px; color:#a3a9b8; }
  .dh-ch { font-weight:700; color:#e4e7ee; }
  .dh-th { color:#8fb4ff; }
  .dh-th a { color:#8fb4ff; }
  .dh-ago { margin-left:auto; color:#8a90a2; }
  .dstale { font-size:10.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:1px 7px; border-radius:999px; background:rgba(212,167,44,.18); color:#e8b84b; }
  .dchat { display:flex; align-items:center; gap:8px; padding:8px 12px; border-bottom:1px solid #1d2a4a; font-size:12.5px; }
  .dchat button { background:transparent; color:#9cc0ff; padding:0; font-size:12.5px; text-align:left; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
  .dchat button:hover { text-decoration:underline; background:transparent; }
  .dchat button[disabled] { color:#8a90a2; cursor:default; text-decoration:none; }
  .dbody { padding:12px; background:#1a1d21; color:#d1d2d3; }
  .dbody textarea.dtext { width:100%; box-sizing:border-box; resize:vertical; min-height:70px; background:#222529; color:#d1d2d3; border:1px solid #3b3d41; border-radius:8px; padding:8px; font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; margin-bottom:8px; }
  .dacts { display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:9px 12px; border-top:1px solid #1d2a4a; }
  .dacts .dsub { margin-left:4px; }
  .dacts .spacer { flex:1; }
  .dconf { padding:10px 12px; display:flex; flex-direction:column; gap:8px; border-top:1px solid #1d2a4a; }
  .slk-row { display:flex; gap:10px; align-items:flex-start; font-family:-apple-system,"Lato","Segoe UI",Roboto,sans-serif; font-size:15px; line-height:1.46; }
  .slk-av { flex:0 0 36px; width:36px; height:36px; border-radius:6px; background:#5b3a8c; color:#fff; font-weight:700; display:flex; align-items:center; justify-content:center; object-fit:cover; }
  .slk-main { flex:1 1 auto; min-width:0; }
  .slk-meta { display:flex; align-items:baseline; gap:8px; }
  .slk-meta b { color:#fff; font-weight:900; }
  .slk-meta span { font-size:12px; color:#ababad; }
  .slk-msg { overflow-wrap:anywhere; }
  .slk-msg + .slk-msg { margin-top:2px; }
  .slk-gap { height:.7em; }
  .slk-burst { margin-top:8px !important; padding:6px 10px 8px; border:1px solid rgba(255,255,255,.1); border-left:3px solid #4a6aa8; border-radius:8px; background:rgba(255,255,255,.035); }
  .slk-bh { display:flex; align-items:center; gap:8px; margin-bottom:3px; font-size:11px; color:#8a90a2; }
  .slk-mark { font-weight:700; letter-spacing:.04em; color:#9cc0ff; }
  .slk-hts { margin-left:auto; visibility:hidden; }
  .slk-burst:hover .slk-hts { visibility:visible; }
  .slk-p { white-space:normal; }
  .slk-link { color:#1d9bd1; text-decoration:none; }
  .slk-link:hover { text-decoration:underline; }
  .slk-mention { color:#1d9bd1; background:rgba(29,155,209,.1); border-radius:3px; padding:0 2px; }
  .slk-code { font:12px/1.4 Monaco,Menlo,Consolas,monospace; color:#e8912d; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.1); border-radius:3px; padding:1px 4px; }
  .slk-pre { margin:4px 0; font:12px/1.5 Monaco,Menlo,Consolas,monospace; color:#d1d2d3; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.1); border-radius:4px; padding:8px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .slk-quote { margin:4px 0; padding-left:10px; border-left:4px solid #5e6064; }
  .slk-list { margin:2px 0; }
  .slk-li { display:flex; gap:6px; }
  .slk-bul { flex:0 0 auto; min-width:14px; text-align:right; }
  .slk-lt { min-width:0; }
  .slk-emoji { width:20px; height:20px; vertical-align:text-bottom; }
  .slk-emoji-u { font-size:1.15em; line-height:1; }
  .slk-epill { font-size:12px; padding:0 5px; border-radius:9px; background:rgba(255,255,255,.08); color:#c4ccdc; }
  .draft.sdraft.leaving { max-height:0 !important; opacity:0; margin-bottom:-12px; border-width:0; transition:max-height .28s ease, opacity .22s ease, margin-bottom .28s ease; pointer-events:none; }
  .draft.sdraft.sending { border-left-color:#d4a72c; }
  .draft.sdraft.dim { opacity:.55; border-left-color:#4a5060; }
  .draft.sdraft.dim:hover, .draft.sdraft.dim:focus-within { opacity:.9; }
  .dconf .dkeys { margin-top:6px; }
  .dconf button:disabled { opacity:.45; cursor:not-allowed; }
  .dconf button.send.close { background:#3b2a1d; color:#f0c9a0; border-color:#5a4029; }
  .dacts button.park, .dconf button.park { background:#1d3b2c; color:#a6e8c0; border-color:#2c5a43; }
  .dsend { display:flex; align-items:center; gap:8px; padding:9px 12px; border-top:1px solid #1d2a4a; font-size:12.5px; color:#e8b84b; }
  .dsend .spin { width:12px; height:12px; border-radius:50%; border:2px solid rgba(232,184,75,.3); border-top-color:#e8b84b; animation:dspin .8s linear infinite; }
  .dfail { color:#ff8d8d; }
  .slk-st { margin-left:auto; display:flex; align-items:center; gap:8px; font-size:11px; color:#8a90a2; }
  .slk-st.sent { color:#7fd6a0; }
  .slk-st.now { color:#e8b84b; }
  .slk-st button { padding:1px 8px; font-size:11px; }
  .slk-files { margin-top:6px; }
  .slk-fwhere { font-size:11px; color:#8a90a2; margin-bottom:4px; }
  .slk-fwhere.thr { color:#e8b84b; }
  .slk-fwhere.top { color:#7fd6a0; }
  .slk-fthumbs { display:flex; flex-wrap:wrap; gap:6px; }
  .slk-thumb { max-width:100%; max-height:180px; border-radius:6px; border:1px solid rgba(255,255,255,.12); object-fit:contain; background:#111; }
  .slk-fchip { font-size:12px; padding:3px 8px; border-radius:6px; background:rgba(255,255,255,.06); border:1px solid rgba(255,255,255,.1); }
  .slk-noimg { color:#8a90a2; font-style:italic; }
  .slk-burst.queued { opacity:.55; }
  .gh-sec { padding:10px 12px; background:#11151d; border-bottom:1px solid #1d2a4a; color:#d1d5de; font-size:13px; line-height:1.45; }
  .gh-hd { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:6px; }
  .gh-pr { color:#9cc0ff; font-weight:600; text-decoration:none; overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .gh-pr:hover { text-decoration:underline; }
  .gh-badge { font-size:10.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:1px 8px; border-radius:999px; flex:0 0 auto; }
  .gh-badge.approve { background:rgba(46,160,67,.2); color:#56d364; }
  .gh-badge.changes { background:rgba(248,81,73,.18); color:#ff7b72; }
  .gh-badge.comment { background:rgba(139,148,158,.2); color:#b1bac4; }
  .gh-done { font-size:11.5px; color:#7fd6a0; }
  .gh-done a { color:#7fd6a0; }
  .gh-body { margin:4px 0 8px; overflow-wrap:anywhere; }
  .gh-cmts { display:flex; flex-direction:column; gap:6px; }
  .gh-cmt { border:1px solid #262c3a; border-radius:6px; padding:6px 8px; background:#0d1117; }
  .gh-loc { font:11.5px/1.4 Monaco,Menlo,Consolas,monospace; color:#8b949e; margin-bottom:3px; overflow-wrap:anywhere; }
  .gh-txt { overflow-wrap:anywhere; }
  .gh-code { font:12px/1.4 Monaco,Menlo,Consolas,monospace; background:rgba(110,118,129,.25); border-radius:4px; padding:1px 4px; }
  .gh-pre { margin:4px 0; font:12px/1.5 Monaco,Menlo,Consolas,monospace; background:#161b22; border:1px solid #262c3a; border-radius:6px; padding:8px; white-space:pre-wrap; overflow-wrap:anywhere; }
  .gh-more { margin-top:6px; background:transparent; color:#9cc0ff; padding:0; font-size:12px; }
  .gh-more:hover { text-decoration:underline; background:transparent; }
  .gh-warn { margin-top:8px; padding:6px 8px; border-radius:6px; background:rgba(212,167,44,.14); border:1px solid rgba(212,167,44,.35); color:#e8b84b; font-size:12px; }
  .gh-rx { padding:7px 12px; border-top:1px solid #1d2a4a; font-size:12px; color:#a3a9b8; }
  .dconf .gh-warn { margin-top:0; }
  .em-sec { padding:12px; background:#f8f9fa; color:#202124; font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  .em-hdr { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:12.5px; color:#5f6368; padding-bottom:8px; margin-bottom:8px; border-bottom:1px solid #dadce0; }
  .em-hdr b { font-weight:600; color:#5f6368; }
  .em-hdr span { color:#202124; overflow-wrap:anywhere; }
  .em-subj { font-size:16px; font-weight:600; color:#202124; margin-bottom:8px; overflow-wrap:anywhere; }
  .em-body { white-space:pre-wrap; overflow-wrap:anywhere; }
  .em-quote { margin-top:8px; padding-left:10px; border-left:2px solid #dadce0; color:#5f6368; white-space:pre-wrap; overflow-wrap:anywhere; }
  .em-more { margin-top:6px; background:#e8eaed; color:#3c4043; padding:0 8px; font-size:13px; border-radius:6px; letter-spacing:.1em; }
  .em-atts { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
  .em-att { font-size:12px; padding:3px 8px; border-radius:6px; background:#fff; border:1px solid #dadce0; color:#3c4043; }
  .em-sec textarea.dtext { width:100%; box-sizing:border-box; resize:vertical; min-height:120px; background:#fff; color:#202124; border:1px solid #dadce0; border-radius:6px; padding:8px; font:14px/1.5 -apple-system,"Segoe UI",Roboto,Arial,sans-serif; }
  .dh-mail { font-weight:700; color:#e4e7ee; }
  .fr-warn { margin:0; padding:8px 10px; border-radius:6px; background:rgba(212,167,44,.14); border:1px solid rgba(212,167,44,.35); color:#e8b84b; font-size:12.5px; }
  .fr-warn.err { background:rgba(248,81,73,.12); border-color:rgba(248,81,73,.35); color:#ff9b94; }
  .fr-warn .fr-t { font-weight:600; }
  .fr-items { margin:6px 0 0; padding:0; list-style:none; display:flex; flex-direction:column; gap:5px; }
  .fr-items li { color:#d1d5de; font-size:12px; line-height:1.4; overflow-wrap:anywhere; }
  .fr-items .fr-who { color:#e8b84b; font-weight:600; }
  .fr-items .fr-at { color:#8a90a2; }
  .fr-items a { color:#9cc0ff; }
  .fr-pass { padding:8px 12px; border-top:1px solid #1d2a4a; }
  @keyframes dspin { to { transform:rotate(360deg); } }
  #outrail.closing { flex-basis:0 !important; width:0 !important; border-left-width:0; transition:flex-basis .25s ease, width .25s ease; }
  @media (prefers-reduced-motion: reduce) {
    .draft.sdraft.leaving, #outrail.closing { transition:none; }
    .dsend .spin { animation:none; }
  }
  @media (max-width:900px) {
    #chatwrap { flex-direction:column; }
    #outrail { flex:none; width:auto; border-left:0; border-top:1px solid #232634; max-height:60vh; }
    #chatwrap[data-rail="collapsed"] #outrail { width:auto; flex-basis:auto; }
    .orailtab { flex-direction:row; height:auto; justify-content:center; }
    .orailtab .vt { writing-mode:horizontal-tb; }
  }
`;

// Pure helpers (tested by evaluating this string).
export const OUTBOX_PURE_JS = String.raw`
function draftDate(d){var t=Date.parse((d&&d.created_at)||'');return isNaN(t)?0:t;}
function sortDrafts(ds){return ds.slice().sort(function(a,b){return draftDate(a)-draftDate(b)||(a.id<b.id?-1:a.id>b.id?1:0);});}
// A draft is stale when a newer one exists for the same chat, or it is over a day old.
function draftFilesOf(d,i){return (d&&d.files&&d.files[i])||[];}
// Where a message's files land: in the draft's thread; in the thread under message 1 (a top-level draft's images-only message); or at the top level.
function fileWhere(d,i,text){if(d&&d.thread_ts)return 'thread';if(i>0&&!String(text||'').trim()&&draftFilesOf(d,i).length)return 'thread';return 'channel';}
function fileIsImage(p){return /[.](png|jpe?g|gif|webp)$/i.test(p||'');}
function filesLabel(d,i,text){var w=fileWhere(d,i,text);return w==='thread'?(d.thread_ts?'Posts in the thread':'Posts as a thread reply under message 1'):'Posts top-level in the channel';}
function draftStaleReason(d,all,now){
  if(!d)return '';
  if(d.stale&&d.stale_reason)return d.stale_reason;
  var t=draftDate(d);
  if(all.some(function(x){return x.session_id===d.session_id&&x.id!==d.id&&draftDate(x)>t;}))return 'newer draft in this chat';
  if(t&&now-t>86400000)return 'over 24h old';
  return '';
}
// hidden with no drafts; a thin strip when collapsed (the default); the drawer when expanded.
function railMode(n,collapsed){return n<=0?'hidden':(collapsed?'collapsed':'open');}
function draftsOfChat(all,sid){return sortDrafts((all||[]).filter(function(d){return d.session_id===sid;}));}
function railStoreKey(k){return 'loom.outbox.closed.'+k;}
// The rail opens by itself whenever a chat has a draft waiting. Collapsing it records the newest
// draft it was showing (closedAt); it stays collapsed until a draft newer than that arrives.
function newestDraftAt(ds){return (ds||[]).reduce(function(m,d){return Math.max(m,draftDate(d));},0);}
function railShut(closedAt,ds){return closedAt>0&&newestDraftAt(ds)<=closedAt;}
// A chat that replies into a thread it does not own (another chat claimed it first) still
// has the thread on its draft: {key,url} of the newest pending draft's thread, or null.
function draftThreadOf(all,sid){var ds=draftsOfChat(all,sid).filter(function(d){return d.status==null||d.status==='pending';});
  for(var i=ds.length-1;i>=0;i--){var m=/^(https:[/][/][\w-]+[.]slack[.]com)[/]archives[/]([A-Z0-9]+)[/]p(\d{10})(\d{6})(?:[?#].*)?$/.exec(ds[i].thread_url||'');
    if(m)return {key:m[2]+'/'+m[3]+'.'+m[4],url:m[1]+'/archives/'+m[2]+'/p'+m[3]+m[4]};}
  return null;}
function destInitial(l){var m=String(l||'').replace(/^[#@]/,'').trim();return (m.charAt(0)||'?').toUpperCase();}
// ---- the GitHub review on a draft
function reviewBadge(ev){return ev==='APPROVE'?{cls:'approve',label:'Approve'}:ev==='REQUEST_CHANGES'?{cls:'changes',label:'Request changes'}:{cls:'comment',label:'Comment'};}
var REVIEW_SHOW=3;
// Inline comments on the card: the first few, or all of them once "show all" is pressed.
function reviewShown(n,all){return all?n:Math.min(n,REVIEW_SHOW);}
function ghEsc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// GitHub markdown, readable rather than faithful: fenced blocks, code spans, bold, links, line breaks.
function ghInline(t){var bt=String.fromCharCode(96);var parts=String(t).split(new RegExp('('+bt+'[^'+bt+'\n]+'+bt+')'));
  return parts.map(function(p,i){if(i%2===1)return '<code class="gh-code">'+ghEsc(p.slice(1,-1))+'</code>';
    return ghEsc(p).replace(/\*\*([^*\n]+)\*\*/g,'<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[/][/][^)\s"]+)\)/g,'<a class="slk-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>').replace(/\n/g,'<br>');}).join('');}
function ghRender(text){var f=String.fromCharCode(96,96,96);var parts=String(text||'').split(new RegExp(f+'[^\\n]*\\n?([\\s\\S]*?)'+f));
  return parts.map(function(p,i){if(i%2===1)return '<pre class="gh-pre">'+ghEsc(p.replace(/\n$/,''))+'</pre>';return ghInline(p.replace(/^\n+|\n+$/g,''));}).filter(function(x){return x;}).join('');}
function reviewLoc(c){var l=c.start_line?c.start_line+'-'+c.line:String(c.line);return c.path+':'+l+(c.side==='LEFT'?' (old)':'');}
function reviewPrLabel(r){return r.repo+'#'+r.pr;}
// "React :eyes: :white_check_mark:, remove :large_orange_circle:" per message the reactions go on.
function reactionParts(rx){return (rx||[]).map(function(r){return {add:r.add||[],remove:r.remove||[],channel:r.channel,ts:r.ts};});}
// ---- email drafts
// The body split at the start of the quoted history ("On ... wrote:", "--- Original Message", or a > line): the quote collapses.
function emailSplitQuote(body){var ls=String(body||'').split('\n');for(var i=0;i<ls.length;i++){var l=ls[i].trim();
    if(/^On .{4,200} wrote:$/.test(l)||/^-{2,}\s*Original Message/i.test(l)||(/^>/.test(l)&&ls.slice(i).every(function(x){return !x.trim()||/^\s*>/.test(x);}))){
      return {main:ls.slice(0,i).join('\n').replace(/\s+$/,''),quoted:ls.slice(i).join('\n')};}}
  return {main:String(body||'').replace(/\s+$/,''),quoted:''};}
function emailDest(e){var to=(e&&e.to)||[];return to.length?(to[0]+(to.length>1?' +'+(to.length-1):'')):'(no recipient)';}
// ---- the freshness check: new messages in the draft's thread(s) since it was drafted
// The items the card knows of: what the last refused send returned plus the passive check, one per id, oldest first.
function freshMerge(a,b){var seen={},out=[];(a||[]).concat(b||[]).forEach(function(i){if(i&&i.id&&!seen[i.id]){seen[i.id]=1;out.push(i);}});return out.sort(function(x,y){return (x.at||0)-(y.at||0);});}
function freshTitle(n){return n+' new message'+(n===1?'':'s')+' since this was drafted';}
`;

export const OUTBOX_VIEW_JS = String.raw`
// ---- Outbox rail + view -------------------------------------------------------
var LEAVING={},outPoll=null,SENDING={},SEND_LOCAL={},outTick=null;
var DRAFT_EDITS={},draftConfirm=null,draftArmDiscard=null,draftMsg={},DRAFT_EDIT_ON={};
var outCollapsed=true,outRailKey='',SLK_DIR=null,SLK_EMOJI=null,slkAt=0,slkLoading=false;
function draftsFor(c){return draftsOfChat(DATA.drafts,c.session_id);}
function hasDrafts(c){return (DATA.drafts||[]).some(function(d){return d.session_id===c.session_id;});}
function draftTexts(d){if(d.email)return DRAFT_EDITS[d.id]||[d.email.body];return DRAFT_EDITS[d.id]||d.messages.slice();}
function slkCtx(){return {users:(SLK_DIR&&SLK_DIR.users)||{},channels:(SLK_DIR&&SLK_DIR.channels)||{},emoji:SLK_EMOJI||{},custom:(SLK_DIR&&SLK_DIR.custom)||{}};}
// Names, custom emoji and the shortcode map load once the first draft is on screen,
// and the names again every ten minutes; each part falls back by itself when absent.
function loadSlkData(){if(slkLoading)return;const needDir=!SLK_DIR||Date.now()-slkAt>600000;if(!needDir&&SLK_EMOJI)return;slkLoading=true;
  Promise.all([needDir?fetch('/api/slack/directory').then(r=>r.json()).catch(()=>null):Promise.resolve(SLK_DIR),SLK_EMOJI?Promise.resolve(SLK_EMOJI):fetch('/api/emoji-map').then(r=>r.json()).catch(()=>null)]).then(a=>{
    if(needDir){SLK_DIR=a[0]&&a[0].ok?a[0]:(SLK_DIR||{users:{},channels:{},custom:{},me:{}});slkAt=Date.now();}
    SLK_EMOJI=a[1]||SLK_EMOJI||{};slkLoading=false;renderOutbox();}).catch(()=>{slkLoading=false;});}
function draftDestLabel(d){if(d.email)return emailDest(d.email);const u=slkCtx().users;let l=d.label||d.channel;if(l===d.channel&&u[d.channel])l='@'+u[d.channel];if(!l&&d.review)l=reviewPrLabel(d.review);return l;}
// The PR head, fetched once a minute per review card, for the "new commits since" warning.
var REVIEW_HEAD={},REVIEW_ALL={};
function loadReviewHead(d){if(!d.review||d.review_posted)return;const h=REVIEW_HEAD[d.id];if(h&&(h.loading||Date.now()-h.at<60000))return;REVIEW_HEAD[d.id]=Object.assign({},h||{},{loading:1,at:Date.now()});
  fetch('/api/outbox/review-head?id='+encodeURIComponent(d.id)).then(r=>r.json()).then(j=>{const was=JSON.stringify(REVIEW_HEAD[d.id]&&[REVIEW_HEAD[d.id].stale,REVIEW_HEAD[d.id].head]);REVIEW_HEAD[d.id]={at:Date.now(),stale:!!j.stale,head:j.head||'',title:j.title||'',url:j.url||''};if(JSON.stringify([!!j.stale,j.head||''])!==was)renderOutbox();}).catch(()=>{REVIEW_HEAD[d.id]={at:Date.now(),stale:false,head:''};});}
function reviewStale(d){return !!(d.review&&!d.review_posted&&REVIEW_HEAD[d.id]&&REVIEW_HEAD[d.id].stale);}
function staleWarnHtml(d){const h=REVIEW_HEAD[d.id]||{};return '<div class="gh-warn" role="alert">PR has new commits since this review was drafted'+(h.head?' (head '+esc(String(h.head).slice(0,7))+', drafted on '+esc(d.review.commit_id.slice(0,7))+')':'')+'. It still posts against the drafted commit.</div>';}
// The passive freshness check, once a minute per card; BLOCK holds what a refused send returned.
var FRESH={},BLOCK={},EMAIL_QUOTE={};
function loadFresh(d){const f=FRESH[d.id];if(f&&(f.loading||Date.now()-f.at<60000))return;FRESH[d.id]=Object.assign({},f||{},{loading:1,at:Date.now()});
  fetch('/api/outbox/fresh?id='+encodeURIComponent(d.id)).then(r=>r.json()).then(j=>{const was=JSON.stringify((FRESH[d.id]&&FRESH[d.id].items)||[]);FRESH[d.id]={at:Date.now(),items:j.items||[],error:j.ok?'':(j.error||j.detail||'')};if(JSON.stringify(FRESH[d.id].items)!==was)renderOutbox();}).catch(()=>{FRESH[d.id]={at:Date.now(),items:[],error:''};});}
// Everything the confirm must warn about before this goes out: the PR head, new messages, a check that failed.
function sendWarnings(d){const b=BLOCK[d.id]||{};const f=FRESH[d.id]||{};return {head:reviewStale(d),items:freshMerge(b.items,f.items),error:b.error||''};}
function hasWarnings(w){return !!(w.head||w.items.length||w.error);}
function freshItemsHtml(items){return '<ul class="fr-items">'+items.slice(0,8).map(function(i){const link=/^https:[/][/]/.test(i.url||'')?' <a href="'+esc(i.url)+'" target="_blank" rel="noopener noreferrer">open</a>':'';
    return '<li><span class="fr-who">'+esc(i.author||'someone')+'</span> <span class="fr-at">'+esc(i.at?rel(i.at):'')+'</span><br>'+esc(i.snippet||'')+link+'</li>';}).join('')+(items.length>8?'<li>and '+(items.length-8)+' more</li>':'')+'</ul>';}
function freshWarnHtml(w){let h='';if(w.items.length)h+='<div class="fr-warn" role="alert"><span class="fr-t">'+esc(freshTitle(w.items.length))+'</span>'+freshItemsHtml(w.items)+'</div>';
  if(w.error)h+='<div class="fr-warn err" role="alert"><span class="fr-t">Could not check the thread for new messages.</span><br>'+esc(w.error)+'</div>';return h;}
function emailHtml(d,texts,editing){const e=d.email;const rows=[['From',e.from||(e.account?e.account+' account':'default account')],['To',(e.to||[]).join(', ')]].concat(e.cc&&e.cc.length?[['Cc',e.cc.join(', ')]]:[]).concat(e.bcc&&e.bcc.length?[['Bcc',e.bcc.join(', ')]]:[]);
  const hdr='<div class="em-hdr">'+rows.map(function(r){return '<b>'+r[0]+'</b><span>'+esc(r[1])+'</span>';}).join('')+'</div><div class="em-subj">'+esc(e.subject)+'</div>';
  const atts=(e.attachments||[]).length?'<div class="em-atts">'+e.attachments.map(function(a){return '<span class="em-att">'+esc(a.split('/').pop())+'</span>';}).join('')+'</div>':'';
  const off=d.email_off?'<div class="fr-warn err" role="alert">'+esc(d.email_off)+'</div>':'';
  if(editing)return '<div class="em-sec">'+hdr+'<textarea class="dtext" data-i="0" rows="'+Math.min(18,Math.max(6,texts[0].split(NL).length+1))+'">'+esc(texts[0])+'</textarea>'+atts+'</div>'+off;
  const body=e.html?String(texts[0]).replace(/<br\s*[/]?>/gi,NL).replace(/<[^>]+>/g,''):texts[0];const q=emailSplitQuote(body);
  return '<div class="em-sec">'+hdr+'<div class="em-body">'+esc(q.main)+'</div>'+(q.quoted?(EMAIL_QUOTE[d.id]?'<div class="em-quote">'+esc(q.quoted)+'</div>':'')+'<button type="button" class="em-more" data-dact="email-quote" title="'+(EMAIL_QUOTE[d.id]?'Hide':'Show')+' quoted text" aria-label="'+(EMAIL_QUOTE[d.id]?'Hide':'Show')+' quoted text">\u2026</button>':'')+atts+'</div>'+off;}
function emojiHtml(n){const h=typeof slkEmoji==='function'?slkEmoji(n,null,slkCtx()):null;return h||(':'+esc(n)+':');}
function reactionsHtml(d){const rx=reactionParts(d.reactions);if(!rx.length)return '';return '<div class="gh-rx">'+rx.map(function(r){const bits=[];if(r.add.length)bits.push('React '+r.add.map(emojiHtml).join(' '));if(r.remove.length)bits.push((r.add.length?'remove ':'Remove ')+r.remove.map(emojiHtml).join(' '));
    return bits.join(', ')+' on the '+(d.thread_ts&&r.ts===d.thread_ts?'request message':'message '+esc(r.ts));}).join('<br>')+'</div>';}
function reviewHtml(d){const r=d.review;if(!r)return '';loadReviewHead(d);const b=reviewBadge(r.event);const h=REVIEW_HEAD[d.id]||{};const url=r.url||h.url||('https://github.com/'+r.repo+'/pull/'+r.pr);const title=r.title||h.title||'';
  const cs=r.comments||[];const n=reviewShown(cs.length,!!REVIEW_ALL[d.id]);
  const done=d.review_posted?'<span class="gh-done">✓ Review posted'+(/^https:[/][/]github[.]com[/]/.test(d.review_posted.url||'')?' <a href="'+esc(d.review_posted.url)+'" target="_blank" rel="noopener noreferrer">view</a>':'')+'</span>':'';
  return '<div class="gh-sec"><div class="gh-hd"><span class="gh-badge '+b.cls+'">'+b.label+'</span><a class="gh-pr" href="'+esc(url)+'" target="_blank" rel="noopener noreferrer" title="'+esc(reviewPrLabel(r)+(title?' '+title:''))+'">'+brandIcon('github')+esc(reviewPrLabel(r))+(title?' · '+esc(title):'')+'</a>'+done+'</div>'
    +(r.body?'<div class="gh-body">'+ghRender(r.body)+'</div>':'')
    +(cs.length?'<div class="gh-cmts">'+cs.slice(0,n).map(function(c){return '<div class="gh-cmt"><div class="gh-loc">'+esc(reviewLoc(c))+'</div><div class="gh-txt">'+ghRender(c.body)+'</div></div>';}).join('')+'</div>'
      +(cs.length>REVIEW_SHOW?'<button type="button" class="gh-more" data-dact="review-all">'+(REVIEW_ALL[d.id]?'Show fewer':'Show all '+cs.length+' comments')+'</button>':''):'')
    +(reviewStale(d)&&draftConfirm!==d.id?staleWarnHtml(d):'')+'</div>';}
// What the confirm says it will do, in send order.
function confirmWhat(d,texts){if(d.email){const e=d.email;const n=(e.cc||[]).length+(e.bcc||[]).length;return 'Send the email'+(e.threadId?' as a reply in the thread':'')+' to '+(e.to||[]).join(', ')+(n?' (+'+n+' cc/bcc)':'')+(e.account?' from the '+e.account+' account':'')+((e.attachments||[]).length?' with '+e.attachments.length+' attachment(s)':'');}
  const parts=[];if(d.review&&!d.review_posted){const b=reviewBadge(d.review.event);const n=(d.review.comments||[]).length;parts.push('post the review ('+b.label+(n?', '+n+' comment'+(n===1?'':'s'):'')+') on '+reviewPrLabel(d.review));}
  if(texts.length){const nf=(d.files||[]).reduce(function(n,f){return n+f.length;},0);parts.push('post as '+senderName()+' to '+draftDestLabel(d)+(d.thread_ts?' (reply in thread)':'')+(texts.length>1?' ('+texts.length+' messages)':'')+(nf?' with '+nf+' file(s)':''));}
  const nr=(d.reactions||[]).reduce(function(n,r){return n+(r.add||[]).length+(r.remove||[]).length;},0);if(nr)parts.push('apply '+nr+' reaction change'+(nr===1?'':'s'));
  const s=parts.join(', then ');return s.charAt(0).toUpperCase()+s.slice(1)+(d.review_posted?' (the review is already posted)':'');}
function senderName(){return (SLK_DIR&&SLK_DIR.me&&SLK_DIR.me.name)||'You';}
function avatarHtml(){const m=(SLK_DIR&&SLK_DIR.me)||{};const n=senderName();if(m.avatar&&m.avatar.indexOf('https://')===0)return '<img class="slk-av" alt="" src="'+esc(m.avatar)+'">';return '<span class="slk-av" aria-hidden="true">'+esc(n.charAt(0).toUpperCase()||'?')+'</span>';}
function draftHeadHtml(d,stale){if(d.email){const e=d.email;const tl=e.threadId&&/^[0-9a-f]+$/i.test(e.threadId)?' <a href="https://mail.google.com/mail/#all/'+esc(e.threadId)+'" target="_blank" rel="noopener noreferrer">view thread</a>':'';
    return '<div class="dhd"><span class="dh-mail">'+brandIcon('gmail')+'Email</span><span class="dh-ch">'+esc(emailDest(e))+'</span>'+(e.threadId?'<span class="dh-th">Reply in thread: '+esc(e.thread_subject||e.subject)+tl+'</span>':'')+(stale?'<span class="dstale" title="'+esc(stale)+'">stale</span>':'')+'<span class="dh-ago">'+esc(rel(draftDate(d)))+'</span></div>';}
  const lbl=draftDestLabel(d);const link=/^https?:[/][/]/.test(d.thread_url||'')?' <a href="'+esc(d.thread_url)+'" target="_blank" rel="noopener noreferrer">view thread</a>':'';
  return '<div class="dhd"><span class="dh-ch">'+(d.review&&!d.channel&&!d.thread_ts?'':brandIcon('slack'))+esc(lbl)+'</span>'+(d.thread_ts?'<span class="dh-th">Reply in thread'+link+'</span>':'')+(stale?'<span class="dstale" title="'+esc(stale)+'">stale</span>':'')+'<span class="dh-ago">'+esc(rel(draftDate(d)))+'</span></div>';}
// The message exactly as Slack lays it out: one sender header, then a bubble per message.
function filesHtml(d,i,text){const fl=draftFilesOf(d,i);if(!fl.length)return '';const w=fileWhere(d,i,text);
  return '<div class="slk-files"><div class="slk-fwhere '+(w==='thread'?'thr':'top')+'">'+esc(filesLabel(d,i,text))+' \u00b7 '+fl.length+(fl.length===1?' file':' files')+'</div><div class="slk-fthumbs">'+fl.map(function(f,j){
    return fileIsImage(f)?'<img class="slk-thumb" alt="'+esc(f.split('/').pop())+'" src="/api/outbox/file?id='+encodeURIComponent(d.id)+'&m='+i+'&f='+j+'">':'<span class="slk-fchip">'+esc(f.split('/').pop())+'</span>';}).join('')+'</div></div>';}
function msgExtras(d,texts){return texts.map(function(t,i){return filesHtml(d,i,t);});}
function slackPreviewHtml(d,texts){const t=draftDate(d);return '<div class="slk-row">'+avatarHtml()+'<div class="slk-main"><div class="slk-meta"><b>'+esc(senderName())+'</b><span>'+esc(t?hhmm(t):'')+'</span></div>'+slkBubbles(texts.map(function(x,i){return x.trim()?x:'_(images only)_';}),slkCtx(),t?hhmm(t):'',msgExtras(d,texts))+'</div></div>';}
// A draft Loom is posting: each message shows sent / sending / a countdown with Send now / queued.
function sendProgressOf(d,texts){return SENDING[d.id]||(SEND_LOCAL[d.id]?{total:texts.length,sent:0,next_at:null}:null);}
function sendEtaText(at){return 'in '+Math.max(0,Math.ceil((at-Date.now())/1000))+'s';}
function sendingBodyHtml(d,texts,p){const t=draftDate(d);const ctx=slkCtx();
  return '<div class="dbody"><div class="slk-row">'+avatarHtml()+'<div class="slk-main"><div class="slk-meta"><b>'+esc(senderName())+'</b><span>'+esc(t?hhmm(t):'')+'</span></div>'+texts.map(function(m,i){
    const done=i<p.sent,cur=i===p.sent;let st;
    if(done)st='<span class="slk-st sent">\u2713 Sent</span>';
    else if(cur&&p.next_at&&p.next_at>Date.now())st='<span class="slk-st now"><span data-eta="'+p.next_at+'">'+sendEtaText(p.next_at)+'</span><button type="button" data-dact="sendnow" title="Skip the wait and post this message now">Send now</button></span>';
    else if(cur)st='<span class="slk-st now">\u25cf Sending\u2026</span>';
    else st='<span class="slk-st">Queued</span>';
    return '<div class="slk-msg slk-burst'+(done||cur?'':' queued')+'"><div class="slk-bh"><span class="slk-mark">'+(i+1)+'/'+texts.length+'</span>'+st+'</div>'+slkRender(m.trim()?m:'_(images only)_',ctx)+filesHtml(d,i,m)+'</div>';}).join('')+'</div></div></div>';}
function draftCardHtml(d,o){o=o||{};const sending=d.send_state==='sending';const texts=draftTexts(d);const prog=sending?null:sendProgressOf(d,texts);const burstSend=!!(prog&&prog.total>1&&texts.length===prog.total&&prog.phase!=='review');const conf=draftConfirm===d.id&&!prog;const editing=!!DRAFT_EDIT_ON[d.id]&&!conf&&!prog;
  loadFresh(d);
  const slackBody=d.email?emailHtml(d,texts,editing):!texts.length?'':burstSend?sendingBodyHtml(d,texts,prog):editing?'<div class="dbody">'+texts.map((t,i)=>'<textarea class="dtext" data-i="'+i+'" rows="'+Math.min(10,Math.max(3,t.split(NL).length+1))+'">'+esc(t)+'</textarea>').join('')+'</div>':'<div class="dbody">'+slackPreviewHtml(d,texts)+'</div>';
  const body=reviewHtml(d)+slackBody+reactionsHtml(d);const warn=sendWarnings(d);const warned=hasWarnings(warn);const anyway=warned?'Send anyway':'Send';
  const msg=draftMsg[d.id]?'<span class="dsub">'+esc(draftMsg[d.id])+'</span>':'';
  const passive=!conf&&!prog&&!sending&&warn.items.length?'<div class="fr-pass">'+freshWarnHtml({items:warn.items,error:''})+'</div>':'';
  const acts=prog?'<div class="dsend" role="status"><span class="spin" aria-hidden="true"></span>'+(prog.phase==='review'?'Posting the review\u2026':prog.phase==='reactions'?'Applying reactions\u2026':prog.phase==='email'?'Sending the email\u2026':burstSend?'Sending '+Math.min(prog.sent+1,prog.total)+' of '+prog.total+'\u2026':'Sending\u2026')+'</div>'
    :sending?'<div class="dsend" role="status"><span class="spin" aria-hidden="true"></span>Sending\u2026 <span class="dsub">posted from the chat</span></div>'
    :conf?'<div class="dconf">'+(warn.head?staleWarnHtml(d):'')+freshWarnHtml(warn)+'<div class="dsub">'+esc(confirmWhat(d,texts))+'</div><div class="arow"><button class="send" data-dact="post-none" title="'+(warned?'Send it past the warning above. ':'')+'Post it. The chat stays as it is.">'+anyway+(!warned&&d.review&&!d.review_posted&&texts.length?' all':'')+'</button><button class="send park" data-dact="post-park"'+(canPark(d)?' title="Post, close the pane and list this chat under Waiting on others until someone replies"':' disabled title="'+esc(parkWhyNot(d))+'"')+'>'+anyway+' &amp; park</button><button class="send close" data-dact="post-close" title="Post, close the pane and take this chat off the board. It stays in All history; Resume still works.">'+anyway+' &amp; close</button><button data-dact="cancel">Cancel</button>'+msg+'</div><div class="dsub dkeys">Enter send · ⌥Enter send &amp; park · ⇧Enter send &amp; close · Esc cancel'+(canPark(d)?'':' · park: '+esc(parkWhyNot(d)))+'</div></div>'
    :'<div class="dacts"><button class="send" data-dact="send">Send</button><button data-dact="edit">'+(editing?'Done':'Edit')+'</button><button data-dact="copy">Copy</button><span class="spacer"></span><button class="closebtn'+(draftArmDiscard===d.id?' arm':'')+'" data-dact="discard">'+(draftArmDiscard===d.id?'✕ discard?':'Discard')+'</button>'+(d.send_state==='failed'?'<span class="dsub dfail">'+esc(d.send_note||'Send failed in chat')+'</span>':'')+msg+'</div>';
  return '<div class="draft sdraft'+((sending||prog)?' sending':'')+(o.stale?' dim':'')+(LEAVING[d.id]?' leaving':'')+'" data-id="'+esc(d.id)+'">'+draftHeadHtml(d,o.stale)+body+passive+acts+'</div>';}
function canPark(d){return !!(d.thread_ts||d.channel||d.email);}
function parkWhyNot(d){return canPark(d)?'':(d.review?'a review with no Slack message has no thread to watch for a reply':'no thread or channel to watch for a reply');}
function draftsBusy(box){return !!(box&&box.querySelector('textarea:focus'));}
// ---- the rail
function railDrafts(){if(orchSel||tsel||!sel||sel.arch)return [];const c=selChat();return c?draftsFor(c):[];}
function railLoad(k){try{return Number(localStorage.getItem(railStoreKey(k)))||0;}catch(e){return 0;}}
function railCollapsed(k,ds){return railShut(railLoad(k),ds);}
function railSave(k,collapsed){try{if(collapsed)localStorage.setItem(railStoreKey(k),String(newestDraftAt(railDrafts())||Date.now()));else localStorage.removeItem(railStoreKey(k));}catch(e){}}
function railRender(){const rail=$('#outrail'),wrap=$('#chatwrap');if(!rail||!wrap)return;const ds=railDrafts();
  const key=ds.length?selKey():'';if(key!==outRailKey){outRailKey=key;outCollapsed=key?railCollapsed(key,ds):true;}
  else if(outCollapsed&&key&&!railCollapsed(key,ds))outCollapsed=false; // a newer draft arrived: open
  if(wrap.dataset.closing){return;}
  const mode=railMode(ds.length,outCollapsed);const was=wrap.dataset.rail;
  // Last draft gone: slide the rail shut (width transition), refit the terminal once at the end.
  if(mode==='hidden'&&was&&was!=='hidden'&&!reduceMotion()){wrap.dataset.closing='1';rail.classList.add('closing');setTimeout(()=>{delete wrap.dataset.closing;rail.classList.remove('closing');wrap.dataset.rail='hidden';rail.hidden=true;rail.innerHTML='';refitTerm();},280);outPollSync();return;}
  wrap.dataset.rail=mode;rail.hidden=mode==='hidden';
  if(was!==mode)setTimeout(refitTerm,60);outPollSync();
  if(mode==='hidden'){rail.innerHTML='';return;}
  if(draftsBusy(rail))return;
  loadSlkData();
  if(mode==='collapsed'){const dest=draftDestLabel(ds[ds.length-1]);
    rail.innerHTML='<button type="button" class="orailtab" data-rail="open" title="Open the outbox ('+ds.length+' pending, '+esc(dest)+')" aria-label="Open the outbox, '+ds.length+' pending"><span class="oglyph" aria-hidden="true">\u2709</span><span class="obadge">'+ds.length+'</span><span class="odest">'+esc(destInitial(dest))+'</span></button>';return;}
  const now=Date.now();
  rail.innerHTML='<div class="orh2"><span>Outbox</span><span class="obadge">'+ds.length+'</span><span class="sp"></span><button type="button" data-rail="close" title="collapse" aria-label="Collapse the outbox">\u203a</button></div><div id="outcards">'+ds.map(d=>draftCardHtml(d,{stale:draftStaleReason(d,ds,now)})).join('')+'</div>';focusConfirm();}
// Keep keyboard focus inside the open confirm (Send is the default), also after a re-render replaced the buttons.
function focusConfirm(){if(!draftConfirm)return;const card=document.querySelector('#outcards .draft[data-id="'+draftConfirm+'"]');if(!card||card.contains(document.activeElement))return;const b=card.querySelector('[data-dact="post-none"]');if(b)b.focus();}
function reduceMotion(){return !!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);}
// New draft list from the server (or after a local send/discard). A card that is gone while it
// is on screen fades and collapses out first (~280 ms); the rail closes after the last one.
function setDrafts(nl){const old=DATA.drafts||[];const keep=new Set(nl.map(d=>d.id));
  const gone=reduceMotion()?[]:old.filter(d=>!keep.has(d.id)&&!LEAVING[d.id]&&document.querySelector('#outcards .draft[data-id="'+d.id+'"]'));
  if(!gone.length){DATA.drafts=nl.concat(old.filter(d=>LEAVING[d.id]&&!keep.has(d.id)));return;}
  DATA.drafts=nl.concat(old.filter(d=>(LEAVING[d.id]||gone.indexOf(d)>=0)&&!keep.has(d.id)));
  gone.forEach(d=>{LEAVING[d.id]=1;const el=document.querySelector('#outcards .draft[data-id="'+d.id+'"]');if(el){el.style.maxHeight=el.offsetHeight+'px';void el.offsetHeight;el.classList.add('leaving');}});
  setTimeout(()=>{gone.forEach(d=>{delete LEAVING[d.id];delete DRAFT_EDITS[d.id];});DATA.drafts=(DATA.drafts||[]).filter(d=>!LEAVING[d.id]&&keep.has(d.id));renderOutbox();},300);}
// While the open chat has pending drafts, ask for their state every 1.5 s so a chat posting one itself shows as Sending\u2026 within a second or two.
function outPollSync(){const want=!document.hidden&&railDrafts().length>0;if(want&&!outPoll)outPoll=setInterval(pollOutbox,1500);else if(!want&&outPoll){clearInterval(outPoll);outPoll=null;}
  if(want&&!outTick)outTick=setInterval(function(){document.querySelectorAll('#outrail [data-eta]').forEach(function(el){el.textContent=sendEtaText(+el.dataset.eta);});},1000);else if(!want&&outTick){clearInterval(outTick);outTick=null;}}
function pollOutbox(){if(document.hidden)return;fetch('/api/outbox/state').then(r=>r.json()).then(j=>{if(!j||!j.ok)return;const sig=x=>JSON.stringify((x||[]).map(d=>[d.id,d.send_state||'',d.send_note||'']));const psig=x=>JSON.stringify(x||{});const before=sig((DATA.drafts||[]).filter(d=>!LEAVING[d.id]))+psig(SENDING);SENDING=j.sending||{};setDrafts(j.drafts||[]);if(sig(j.drafts)+psig(SENDING)!==before)renderOutbox();}).catch(()=>{});}
function refitTerm(){try{if(termFit)termFit.fit();}catch(e){}}
function renderOutbox(){railRender();}
// ---- actions (rail and view share them)
function draftAction(act,id,btn){const d=(DATA.drafts||[]).find(x=>x.id===id);if(!d)return;
  if(act==='edit'){DRAFT_EDIT_ON[id]=!DRAFT_EDIT_ON[id];renderOutbox();return;}
  if(act==='copy'&&d.email){const e=d.email;copyText(['To: '+(e.to||[]).join(', ')].concat(e.cc&&e.cc.length?['Cc: '+e.cc.join(', ')]:[]).concat(['Subject: '+e.subject,'',draftTexts(d)[0]]).join(NL),'email copied');return;}
  if(act==='email-quote'){EMAIL_QUOTE[id]=!EMAIL_QUOTE[id];renderOutbox();return;}
  if(act==='copy'){const r=d.review;const gh=r?[r.body].concat((r.comments||[]).map(function(c){return reviewLoc(c)+NL+c.body;})).filter(Boolean):[];copyText(gh.concat(draftTexts(d)).join(NL+NL),'draft copied');return;}
  if(act==='review-all'){REVIEW_ALL[id]=!REVIEW_ALL[id];renderOutbox();return;}
  if(act==='send'){if(draftTexts(d).some((t,i)=>!t.trim()&&!draftFilesOf(d,i).length)){draftMsg[id]='every message needs text';renderOutbox();return;}draftConfirm=id;draftArmDiscard=null;draftMsg[id]='';renderOutbox();return;}
  if(act==='cancel'){draftConfirm=null;delete BLOCK[id];renderOutbox();return;}
  if(act==='sendnow'){fetch('/api/outbox/send-now',{method:'POST',headers:{'content-type':'application/json','x-loom-term-token':(typeof TERM_TOKEN==='string'?TERM_TOKEN:'')},body:JSON.stringify({id})}).then(r=>r.json()).then(()=>pollOutbox()).catch(()=>{});return;}
  if(act.indexOf('post-')===0){const after=act.slice(5);if(after==='park'&&!canPark(d))return;const texts=draftTexts(d);
    // The confirm showed these warnings and Send anyway was pressed: acknowledge exactly what was shown (new items still stop it).
    const w=sendWarnings(d);const ack_stale=w.head;const ack_fresh=w.error?true:w.items.map(function(i){return i.id;});draftConfirm=null;SEND_LOCAL[id]=1;renderOutbox();pollOutbox();
    fetch('/api/outbox/send',{method:'POST',headers:{'content-type':'application/json','x-loom-term-token':(typeof TERM_TOKEN==='string'?TERM_TOKEN:'')},body:JSON.stringify({id,messages:texts,after,ack_stale,ack_fresh})}).then(r=>r.json()).then(j=>{
      delete SEND_LOCAL[id];delete SENDING[id];draftConfirm=null;delete BLOCK[id];draftMsg[id]=j.ok?(j.dry?'dry run, nothing posted':(j.detail==='posted'?'posted':j.detail)):(j.detail||'failed');
      // The PR moved since the review was drafted: reopen the confirm with the warning; Send anyway is the second click.
      // Refused before anything went out (the PR moved, someone wrote in the thread, or the check failed): reopen the confirm with every warning; one Send anyway sends.
      if(!j.ok&&(j.stale_head||j.stale_thread||j.fresh_error)){if(j.stale_head)REVIEW_HEAD[id]={at:Date.now(),stale:true,head:j.stale_head};BLOCK[id]={items:j.stale_thread||[],error:j.fresh_error||''};draftConfirm=id;draftMsg[id]='';}
      if(j.ok&&!j.dry){setDrafts((DATA.drafts||[]).filter(x=>x.id!==id));toast(j.parked?'posted, chat parked'+(j.waiting_on&&j.waiting_on.length?' (waiting on '+j.waiting_on.join(', ')+')':''):(j.done?'posted, chat closed':(after==='park'?(j.detail||'posted'):'posted')));}
      renderOutbox();setTimeout(refresh,800);}).catch(()=>{delete SEND_LOCAL[id];draftConfirm=null;draftMsg[id]='server off';renderOutbox();});return;}
  if(act==='discard'){if(draftArmDiscard!==id){draftArmDiscard=id;renderOutbox();setTimeout(()=>{if(draftArmDiscard===id){draftArmDiscard=null;renderOutbox();}},2500);return;}
    draftArmDiscard=null;fetch('/api/outbox/discard',{method:'POST',headers:{'content-type':'application/json','x-loom-term-token':(typeof TERM_TOKEN==='string'?TERM_TOKEN:'')},body:JSON.stringify({id})}).then(r=>r.json()).then(j=>{draftMsg[id]=j.ok?'':(j.detail||'failed');if(j.ok){setDrafts((DATA.drafts||[]).filter(x=>x.id!==id));}renderOutbox();setTimeout(refresh,300);}).catch(()=>{});}}
function wireOutbox(){['#outrail'].forEach(q=>{const box=$(q);
  box.addEventListener('click',e=>{const r=e.target.closest('button[data-rail]');if(r){outCollapsed=r.dataset.rail==='close';if(outRailKey)railSave(outRailKey,outCollapsed);railRender();return;}
    const b=e.target.closest('[data-dact]');if(!b)return;const card=b.closest('.draft');if(card)draftAction(b.dataset.dact,card.dataset.id,b);});
  box.addEventListener('keydown',e=>{if(!draftConfirm)return;const card=e.target.closest&&e.target.closest('.draft');if(!card||card.dataset.id!==draftConfirm)return;
    if(e.key==='Escape'){e.preventDefault();e.stopPropagation();delete BLOCK[draftConfirm];draftConfirm=null;renderOutbox();return;}
    if(e.key!=='Enter'||e.isComposing)return;
    const onOther=e.target.tagName==='BUTTON'&&!e.altKey&&!e.shiftKey&&e.target.dataset.dact!=='post-none';if(onOther)return;
    const which=e.altKey?'post-park':(e.shiftKey?'post-close':'post-none');const btn=card.querySelector('[data-dact="'+which+'"]');
    e.preventDefault();if(btn&&!btn.disabled)draftAction(which,card.dataset.id,btn);});
  box.addEventListener('input',e=>{const ta=e.target.closest&&e.target.closest('textarea.dtext');if(!ta)return;const card=ta.closest('.draft');const d=(DATA.drafts||[]).find(x=>x.id===card.dataset.id);if(!d)return;const t=draftTexts(d);t[+ta.dataset.i]=ta.value;DRAFT_EDITS[d.id]=t;});});
}
`;
