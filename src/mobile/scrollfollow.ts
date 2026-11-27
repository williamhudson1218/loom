// The phone chat's scroll rules, as plain browser JS (like src/grouping.ts) so they are testable
// without a DOM. Spliced into the PWA script ahead of the app (src/mobile/webapp.ts).
//
// Why scrolling used to hang: every poll that changed anything rebuilt the whole message list
// and set scrollTop, often while iOS was still running the momentum of a flick, which stops the
// gesture dead; a reader scrolling up kept getting caught. Now:
//   - follow (stick to the bottom) ends the moment the reader scrolls away from the bottom, and
//     comes back only when they scroll back down or tap the "new messages" pill;
//   - nothing sets scrollTop while a finger is down or the list moved in the last IDLE_MS
//     (momentum); such a repaint waits until the list is idle;
//   - a poll only touches the messages that changed (firstChange), so a new line appends.
export const SCROLLFOLLOW_JS = `
var FOLLOW_IDLE_MS=300,FOLLOW_NEAR_PX=24;
function nearBottom(scrollHeight,scrollTop,clientHeight){return scrollHeight-scrollTop-clientHeight<FOLLOW_NEAR_PX;}
// A finger on the list, or the list still moving from one: no programmatic scroll now.
function scrollBusy(touching,lastScrollAt,now){return !!touching||now-lastScrollAt<FOLLOW_IDLE_MS;}
// A scroll event the page caused (it set scrollTop to want) is not the reader moving.
function ownScroll(want,scrollTop){return want!==null&&Math.abs(want-scrollTop)<2;}
// The follow flag after a scroll event the reader made.
function followAfterScroll(scrollHeight,scrollTop,clientHeight){return nearBottom(scrollHeight,scrollTop,clientHeight);}
// Where scrollTop goes after a repaint: 'anchor' (older messages were put above: keep what is on
// screen where it is), 'bottom' (first paint, or following), else 'keep'.
function afterPaint(first,follow,prepended){if(prepended)return 'anchor';if(first||follow)return 'bottom';return 'keep';}
// The first index where the new message keys differ from the rendered ones; -1 when the same.
function firstChange(oldKeys,newKeys){var n=Math.min(oldKeys.length,newKeys.length);for(var i=0;i<n;i++)if(oldKeys[i]!==newKeys[i])return i;return oldKeys.length===newKeys.length?-1:n;}
// The chat's outbox dock memory {open, seen:[draft ids]}. Collapsed by default; a draft not seen
// before never opens it, it only flags 'fresh' (the bar pulses). Returns {mem, fresh, changed}.
function dockTake(mem,ids){var seen=Array.isArray(mem&&mem.seen)?mem.seen:[];var open=!!(mem&&mem.open);var fresh=ids.some(function(id){return seen.indexOf(id)<0;});var changed=fresh||ids.length!==seen.length;return {mem:{open:open,seen:changed?ids.slice():seen},fresh:fresh,changed:changed};}
`;
