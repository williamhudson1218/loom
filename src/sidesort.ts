// Sidebar sort order, kept as plain browser JS in a string (like grouping.ts) so the
// pure part is testable without a DOM.
//
// Why rows used to bounce: "Most recent" re-sorted on every refresh by
// last_turn_at, which the indexer rewrites while a chat streams, so the working
// chats traded places every few seconds. Now:
//   'new'    started_at descending (fully stable)
//   'old'    started_at ascending
//   'recent' (the default) stable recency: a chat's stamp only moves at a turn boundary (it is
//            first seen, or its status flips: working <-> your turn <-> done), not
//            when the file merely grows. pinOrder then holds the selected row and,
//            while the pointer is over the list, every row where it is.
export const SIDESORT_MODES = ['new', 'old', 'recent'];
export const SIDESORT_DEFAULT = 'recent';
export const SIDESORT_JS = `
var SORT_MODES=['new','old','recent'],SORT_DEFAULT='recent';
function sortModeOf(v){return SORT_MODES.indexOf(v)>=0?v:SORT_DEFAULT;}
// f.started(c) -> ms, f.stamp(c) -> ms, f.key(c) -> string. Ties break on key so
// equal rows never swap between renders.
function sortComparator(mode,f){
  var tie=function(a,b){var x=f.key(a),y=f.key(b);return x<y?-1:x>y?1:0;};
  if(mode==='old')return function(a,b){return (f.started(a)-f.started(b))||tie(a,b);};
  if(mode==='recent')return function(a,b){return (f.stamp(b)-f.stamp(a))||(f.started(b)-f.started(a))||tie(a,b);};
  return function(a,b){return (f.started(b)-f.started(a))||tie(a,b);};
}
// stamper(): stamp(key,sig,at) returns the chat's recency stamp, which only
// moves UP when sig (its status signature) differs from the last one seen, so a
// streaming chat does not bounce. It can always move DOWN: a stamp newer than the
// chat's real last activity was taken from a transient value (a file write with no
// turn, a turn time not indexed yet) and would hold an old chat at the top for good.
function makeStamper(){
  var seen={};
  return function(key,sig,at){var s=seen[key];if(!s||s.sig!==sig)s=seen[key]={sig:sig,at:at};else if(at<s.at)s.at=at;return s.at;};
}
// The age a row shows is the sort key: started for the Started sorts, last activity for Recent.
function sortAgeMs(mode,startedAt,freshMs){return mode==='recent'?freshMs:(startedAt||freshMs);}
function sortAgeTip(startedAt,freshMs,relf){return (startedAt?'Started '+relf(startedAt)+' \u00b7 ':'')+'active '+relf(freshMs);}
// Recent activity is one flat list (no status groups, so rows do not jump between groups as state changes); tag groups stay.
function isFlatList(mode,groupBy,tab){return mode==='recent'&&groupBy==='status'&&tab!=='saved';}
// Re-order want (keys, the order we would like) but keep every pinned key at the
// slot it held in prev. Unpinned keys fill the remaining slots in want order.
// A row that left the list (closed, hidden, filtered out) is dropped from prev first,
// so the rows below it close the gap by one: otherwise the last row's slot no longer
// exists and it was placed in the gap, lifting the oldest chat into the middle.
// A row not in prev has no slot to hold, so it is placed at its wanted index
// afterwards. Otherwise, with every row pinned (pointer over the list), it filled
// the one leftover slot at the bottom and only rose when the pointer left.
function pinOrder(prev,want,pinned){
  var inPrev={},j0;for(j0=0;j0<prev.length;j0++)inPrev[prev[j0]]=1;
  var fresh=want.filter(function(k){return !inPrev[k];});
  if(fresh.length&&fresh.length<want.length){
    var rest=pinOrder(prev,want.filter(function(k){return inPrev[k];}),pinned);
    for(var f=0;f<fresh.length;f++)rest.splice(Math.min(want.indexOf(fresh[f]),rest.length),0,fresh[f]);
    return rest;
  }
  var n=want.length,out=new Array(n),inWant={},i;
  for(i=0;i<n;i++)inWant[want[i]]=1;
  prev=prev.filter(function(k){return inWant[k];});
  var used={};
  for(i=0;i<prev.length;i++){var k=prev[i];if(!pinned[k]||!inWant[k])continue;
    var slot=Math.min(i,n-1);while(slot<n&&out[slot]!==undefined)slot++;
    if(slot>=n){slot=Math.min(i,n-1);while(slot>=0&&out[slot]!==undefined)slot--;}
    if(slot>=0){out[slot]=k;used[k]=1;}}
  var j=0;for(i=0;i<n;i++){if(used[want[i]])continue;while(out[j]!==undefined)j++;out[j]=want[i];}
  return out;
}
`;
