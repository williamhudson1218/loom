// Sidebar grouping, kept as plain browser JS in a string (like chatmenu.ts) so the
// pure part is testable without a DOM. groupChats(rows, mode, f) returns
// [{name, tag, rows}] sections; `f` supplies the page's own predicates:
//   f.saved(c) f.working(c) f.turn(c) f.live(c) f.tags(c)->names f.fresh(c)->ms
//   f.done(c) (Send & close: lands in Closed, shown only in All history)
//   f.parked(c)-> '' | 'waiting' | 'replied' (Send & park: waiting joins Waiting on others, a reply joins Your turn)
// 'status' is the original grouping and keeps the incoming row order. 'tag' makes
// one section per tag (name order), Untagged last; a chat with two tags is in both;
// inside a section: Working, then Your turn, then most recent.
export const GROUPING_JS = `
// User-defined groups (chatgroups.ts): carve the chats a person moved into a group out of the
// list. groups is the ordered definition list [{id,name}], groupOf(c) -> a group id or 0/null.
// Returns {groups:[{id,name,rows}], rest}: each group's rows keep the incoming order (the page
// sorts them with the same comparator as the main list), groups keep definition order, and a
// chat whose group no longer exists falls into rest. Empty groups are kept only with keepEmpty
// (so a filter or search that matches nothing in a group hides it).
function splitUserGroups(rows,groups,groupOf,keepEmpty){
  var by={},rest=[];
  rows.forEach(function(c){var g=groupOf(c);if(g&&groups.some(function(x){return x.id===g;}))(by[g]=by[g]||[]).push(c);else rest.push(c);});
  var out=[];groups.forEach(function(g){if(by[g.id]||keepEmpty)out.push({id:g.id,name:g.name,rows:by[g.id]||[]});});
  return {groups:out,rest:rest};
}
var STATUS_GROUPS=['Working','Your turn','Waiting on others','Saved for later','Recent','Closed'];
function statusGroupOf(c,f){var pk=f.parked?f.parked(c):'';if(pk==='waiting')return 'Waiting on others';if(pk==='replied')return 'Your turn';if(f.saved(c))return 'Saved for later';if(f.done&&f.done(c))return 'Closed';if(f.working(c))return 'Working';if(f.live(c)&&f.turn(c))return 'Your turn';return 'Recent';}
function groupChats(rows,mode,f){
  var by={},out=[];
  if(mode==='tag'){
    var untagged=[];
    rows.forEach(function(c){var ts=f.tags(c)||[];if(!ts.length){untagged.push(c);return;}ts.forEach(function(t){(by[t]=by[t]||[]).push(c);});});
    var tier=function(c){var pk=f.parked?f.parked(c):'';return f.working(c)?0:((f.live(c)&&f.turn(c))||pk==='replied'?1:(pk==='waiting'?3:2));};
    var order=function(a,b){return tier(a)-tier(b)||(f.cmp?f.cmp(a,b):f.fresh(b)-f.fresh(a));};
    Object.keys(by).sort(function(a,b){return a.toLowerCase()<b.toLowerCase()?-1:a.toLowerCase()>b.toLowerCase()?1:0;}).forEach(function(t){out.push({name:t,tag:t,rows:by[t].slice().sort(order)});});
    if(untagged.length)out.push({name:'Untagged',tag:'',rows:untagged.slice().sort(order)});
    return out;
  }
  rows.forEach(function(c){var g=statusGroupOf(c,f);(by[g]=by[g]||[]).push(c);});
  STATUS_GROUPS.forEach(function(g){if(by[g])out.push({name:g,tag:'',rows:by[g]});});
  return out;
}
`;
