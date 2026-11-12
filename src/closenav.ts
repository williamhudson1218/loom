// Where the view goes after the chat being viewed is closed. Plain browser JS in a
// string (like grouping.ts) so the pure part is testable without a DOM.
//
// closeNavPick(keys, key): `keys` is the displayed list order (duplicates are a chat
// shown under two tag groups), `key` the chat being closed. Returns the key that takes
// its place: the next one down, else the one above, else null (nothing left, which
// the caller turns into the orchestrator page). null as well when `key` is not listed.
// closeNavPlan(c) must run BEFORE the close removes the row; closeNavGo(plan) runs
// once the close succeeded and only moves when that chat is still the one open.
export const CLOSENAV_JS = `
function closeNavPick(keys,key){var seen={},list=[];(keys||[]).forEach(function(k){if(!seen[k]){seen[k]=1;list.push(k);}});
  var i=list.indexOf(key);if(i<0||list.length<2)return null;return i+1<list.length?list[i+1]:list[i-1];}
function closeNavPlan(c){if(!c||!sel||sel.arch||sel.sid!==c.session_id||sel.agent!==c.agent)return null;
  var keys=Array.prototype.slice.call(document.querySelectorAll('#list .srow[data-sid]')).filter(function(r){return !r.dataset.jsonl&&!r.classList.contains('ghost');}).map(function(r){return r.dataset.agent+':'+r.dataset.sid;});
  return {key:chatKey(c),next:closeNavPick(keys,chatKey(c))};}
function closeNavGo(plan){if(!plan||!sel||sel.arch||sel.agent+':'+sel.sid!==plan.key)return;
  var n=plan.next&&DATA.chats.find(function(x){return chatKey(x)===plan.next;});
  if(n)selectChat(n.session_id,n.agent,null);else selectOrch();}
`;
