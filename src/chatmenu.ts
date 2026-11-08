// The per-chat action menu: one list, shown in the chat header's More menu and
// as the right-click menu on every sidebar row. It is plain browser JS kept in a
// string (the dashboard embeds it verbatim) so the order, labels and disabled
// states are testable without a DOM: tests evaluate it and call chatMenuItems().
//
// Input fields: live (has a pane), saved, archive (no board row), prNum ('' when
// none), prState, hasSlack, slackCount (2+ makes Open Slack thread a submenu), armedClose (the Close item was clicked once),
// orchLive (the orchestrator session is running), extLabel (the configured
// external terminal's name, '' when the terminal is Loom's own window),
// done (Send & close ended it: enables Restore to board),
// parked (Send & park is waiting on a reply: enables Unpark),
// tagCount (how many tags the chat carries; the item opens a checkbox submenu).
// Items that do not apply are disabled, never hidden, so the menu keeps one shape.
export const CHAT_MENU_JS = `
function chatMenuItems(x){
  var live=!!x.live, arch=!!x.archive;
  var items=[
    {key:'open',label:live?'Open terminal':'Resume',hint:''},
    {key:'external',label:x.extLabel?'Open in '+x.extLabel:'Open in external terminal',hint:!live?'not running':(x.extLabel?'':'set one in Settings'),disabled:!live||!x.extLabel},
    {key:'branch',label:'Branch into a new window',hint:''},
    {key:'pr',label:x.prNum?'Open PR #'+x.prNum:'Open PR',hint:x.prNum?(x.prState||''):'none',disabled:!x.prNum,divider:true},
    {key:'slack',label:'Open Slack thread',hint:(x.slackCount||0)>1?x.slackCount+' ▸':(x.hasSlack?'':'none'),disabled:!x.hasSlack,submenu:(x.slackCount||0)>1},
    {key:'save',label:x.saved?'Unsave':'Save for later',hint:x.saved?'':(live?'closes pane':''),disabled:arch,divider:true},
    {key:'tags',label:'Tags',hint:x.tagCount?String(x.tagCount):'▸',disabled:arch},
    {key:'unpark',label:'Unpark',hint:x.parked?'':'not parked',disabled:!x.parked,tip:x.parked?'Stop waiting on the reply and put this chat back in Recent':''},
    {key:'restore',label:'Restore to board',hint:x.done?'':'not closed',disabled:!x.done,tip:x.done?'Undo Send & close: put this chat back on the board':''},
    {key:'copyResume',label:'Copy resume command',hint:''},
    {key:'copyId',label:'Copy session ID',hint:''},
    {key:'rename',label:'Rename',hint:'',disabled:arch},
    {key:'orchestrator',label:'Ask the orchestrator about this',hint:x.orchLive?'':'not running',disabled:arch||!x.orchLive,tip:x.orchLive?'':'The orchestrator is not running'},
    {key:'close',label:live?(x.armedClose?'Click again to close':'Close chat'):'Remove from board',hint:live?'frees the pane':(x.saved?'unsave first':''),danger:true,divider:true,disabled:!live&&(arch||!!x.saved)}
  ];
  return items.map(function(i){i.disabled=!!i.disabled;i.divider=!!i.divider;i.danger=!!i.danger;i.submenu=!!i.submenu;return i;});
}
`;
