// Sidebar search sections, kept as plain browser JS in a string (like sidesort.ts) so
// the pure part is testable without a DOM.
//
// While a query is typed the board splits its matches in two, whatever the Live/All
// toggle says: Open (running in a pane, or parked) first, then Archived (every other
// board match, then archive-search hits the board has no row for).
export const SIDESEARCH_JS = `
// matches: board chats that already passed the text/project/tag/state filters.
// isOpen(c) -> bool. hits: /api/search results. boardIds: session ids of every chat the
// board knows, so an archive hit never repeats one. Both archived groups are newest first.
function splitMatches(matches,isOpen,hits,boardIds){
  var open=[],closed=[];
  matches.forEach(function(c){(isOpen(c)?open:closed).push(c);});
  closed.sort(function(a,b){return (b.last_active_at||0)-(a.last_active_at||0);});
  var known={};(boardIds||[]).forEach(function(id){known[id]=1;});matches.forEach(function(c){known[c.session_id]=1;});
  var seen={},fresh=[];
  (hits||[]).forEach(function(h){if(known[h.session_id]||seen[h.session_id])return;seen[h.session_id]=1;fresh.push(h);});
  fresh.sort(function(a,b){return (b.ended_at||0)-(a.ended_at||0);});
  return {open:open,archivedBoard:closed,archiveHits:fresh,archivedCount:closed.length+fresh.length};
}
// What a typed query is matched against: text, session id (full or prefix) and pane name.
// liveName is the running pane's @name; otherwise the last one remembered for the chat.
function searchHay(c,liveName){return [c.title,c.overview,c.first_message,c.session_id,liveName||c.pane_name||''].join(' ').toLowerCase();}
// Archive search runs on its own once the query is long enough; shorter ones only wait.
function archiveWanted(q){return String(q||'').trim().length>=2;}
`;
