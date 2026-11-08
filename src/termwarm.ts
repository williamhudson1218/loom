// Instant terminal open, browser side. Three small pieces, kept as a string the
// dashboard embeds verbatim (like termdrop.ts) so they test without a DOM:
//
//   Handoff    — snapshot -> live. A chat's current screen is fetched from
//                /api/term/snap and painted while the pty is still attaching.
//                The first live byte resets the terminal and carries on, in the
//                same write queue as the reset, so no blank frame shows between.
//   WarmPool   — the last few opened chat views, kept attached and hidden so
//                switching back is instant. LRU; parking returns the evicted.
//   SnapCache  — hover prefetch and click share one fetch per pane.
//
// Only views that never touched the window's zoom are parked (an 'attach' view of
// a pane alone in its window). A zoom-mode view owns its window's zoom, so it is
// closed on leaving and the next view applies its own — the server's zoom marks
// and 15s repair logic stay the single owner of that.
export const TERMWARM_JS = `
function createHandoff(){return {snap:false,live:false};}
// Text to write for a snapshot, or null if live bytes already arrived (a late snapshot must never overwrite them).
// A second snapshot (fresher than a cached first) is preceded by a reset.
function snapPaint(h,text){if(h.live||!text)return null;const again=h.snap;h.snap=true;return (again?'\\x1bc':'')+text;}
// What to do with a live chunk: reset first if a snapshot is on screen and this is the first live byte.
function livePaint(h){const first=!h.live;h.live=true;return {reset:first&&h.snap};}
// A snapshot reply as escape sequences sized to a panel of 'rows' rows: keeps the bottom rows, moves the cursor with them.
function fitSnap(r,rows){
  if(!r||typeof r.screen!=='string')return '';
  let lines=r.screen.replace(/\\n$/,'').split('\\n');let cy=r.cy||0;
  if(rows>0&&lines.length>rows){const drop=lines.length-rows;lines=lines.slice(drop);cy=Math.max(0,cy-drop);}
  if(rows>0&&cy>=rows)cy=rows-1;
  return '\\x1b[0m\\x1b[H\\x1b[2J\\x1b[3J'+lines.join('\\r\\n')+'\\x1b[0m\\x1b['+(cy+1)+';'+((r.cx||0)+1)+'H'+(r.flag===0?'\\x1b[?25l':'\\x1b[?25h');
}
function WarmPool(max){this.max=max;this.items=[];}
WarmPool.prototype.has=function(k){return this.items.some(x=>x.k===k);};
WarmPool.prototype.take=function(k){const i=this.items.findIndex(x=>x.k===k);return i<0?null:this.items.splice(i,1)[0].v;};
WarmPool.prototype.drop=function(k){return this.take(k);};
// Park v under k as most recent. Returns what fell out: [{k,v}], oldest first (v replaced under the same key is returned too).
WarmPool.prototype.park=function(k,v){const out=[];const i=this.items.findIndex(x=>x.k===k);if(i>=0){const old=this.items.splice(i,1)[0];if(old.v!==v)out.push(old);}
  this.items.push({k:k,v:v});while(this.items.length>this.max)out.push(this.items.shift());return out;};
WarmPool.prototype.keys=function(){return this.items.map(x=>x.k);};
// fetcher(k) -> Promise. get() reuses one in flight or done within ttl ms; a failure is not cached.
function SnapCache(fetcher,ttl){this.f=fetcher;this.ttl=ttl;this.m=new Map();}
SnapCache.prototype.get=function(k,now){now=now===undefined?Date.now():now;const hit=this.m.get(k);if(hit&&now-hit.at<this.ttl)return hit.p;
  const p=this.f(k);const self=this;this.m.set(k,{at:now,p:p});p.then(r=>{if(!r&&self.m.get(k)&&self.m.get(k).p===p)self.m.delete(k);},()=>{if(self.m.get(k)&&self.m.get(k).p===p)self.m.delete(k);});
  if(this.m.size>32){for(const kk of this.m.keys()){this.m.delete(kk);break;}}return p;};
`;
