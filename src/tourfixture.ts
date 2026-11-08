// The guided tour's sample data. Plain browser JS in a string, spliced into the page by
// tourview.ts. It builds three sample chats, one Slack draft, one Slack thread and one
// ship line, all client side: the tour serves them through a fetch interceptor and puts
// them into the page's DATA for the length of the tour, and nothing here is ever sent to
// the server or stored.
//
// No backticks, no dollar-brace and no backslashes: the script is spliced into the
// dashboard's page script.
//
// tourFixture(now, o) -> { chats, live, drafts, slackOwners, slackCounts, ships,
//   detail(sid), transcript(sid), shipDetail, diff, repo, sids, draftId }
//   o.slack: include the draft and the Slack thread (Slack is on)
//   o.ship:  include the ship line and the staged-work dialog (a Ship repo is set up)

export const TOUR_FIXTURE_JS = String.raw`
var TOUR_SAMPLE_REPO='/sample/example-app';
function tourFixture(now,o){
  o=o||{};
  var MIN=60000,HR=3600000;
  var sids=['sample-1','sample-2','sample-3'];
  function key(i){return 'claude:'+sids[i];}
  function chat(i,f){
    var base={agent:'claude',session_id:sids[i],project:'example-app',project_dir:'/sample/example-app',jsonl_path:'',
      title:'',claude_auto_title:'',pr_url:'',overview:'',state:'done',breakdown:[],first_message:'',message_count:12,
      started_at:now-3*HR,last_active_at:now-5*MIN,last_turn_at:now-5*MIN,activity:{},summary_pending:false,
      saved:false,saved_at:0,tags:[]};
    for(var k in f)base[k]=f[k];
    return base;
  }
  var chats=[
    chat(0,{title:'Retry failed payment webhooks',state:'waiting_on_user',
      overview:'Adds a capped retry for failed payment webhooks and asks whether the cap should be 3 or 5.',
      first_message:'Retry the payment webhook when the provider returns a timeout',
      breakdown:['Read the webhook handler','Added a retry queue','Twelve tests pass'],
      pr_url:'https://github.com/sample/example-app/pull/412',started_at:now-4*HR,last_active_at:now-2*MIN,last_turn_at:now-2*MIN}),
    chat(1,{title:'Sidebar filter rewrite',state:'done',project:'example-web',
      overview:'Rewriting the sidebar filter row.',first_message:'Rewrite the sidebar filter row',
      started_at:now-2*HR,last_active_at:now-1*MIN,last_turn_at:now-1*MIN}),
    chat(2,{title:'Release notes draft',state:'done',
      overview:'Drafted the release notes and staged them.',first_message:'Draft the release notes for this week',
      breakdown:['Collected merged pull requests','Wrote the notes','Staged two files'],
      started_at:now-6*HR,last_active_at:now-40*MIN,last_turn_at:now-40*MIN})
  ];
  var names=['blue-vanilla','cozy-donut','quiet-maple'];
  var live={};
  for(var i=0;i<3;i++){
    live[key(i)]={agent:'claude',session_id:sids[i],pane_id:'',tmux_session:'sample',window_index:'1',
      pane_index:String(i),running:true,working:i===1,name:names[i],cwd:'/sample/example-app'};
  }
  var iso=function(t){var d=new Date(t),p=function(n){return (n<10?'0':'')+n;};
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes())+':'+p(d.getSeconds());};
  var draftId='sample-draft-1';
  var drafts=o.slack?[{id:draftId,session_id:sids[0],channel:'CSAMPLE01',label:'#payments',thread_ts:'1700000000.000100',
    thread_url:'https://sample.slack.com/archives/CSAMPLE01/p1700000000000100',
    messages:['The webhook retry is on the way, capped at 3 attempts. I will confirm once the pull request is merged.'],
    status:'pending',created_at:iso(now-3*MIN)}]:[];
  var slackOwners=o.slack?[sids[0]]:[];
  var slackCounts={};if(o.slack)slackCounts[sids[0]]=1;
  var slackThread={key:'CSAMPLE01/1700000000.000100',url:'https://sample.slack.com/archives/CSAMPLE01/p1700000000000100',
    channel:'CSAMPLE01',ts:'1700000000.000100',label:'#payments',stage:'looking',source:'send',claimedAt:now-3*HR,lastAt:now-10*MIN,
    preview:'Webhook deliveries are failing during the provider outage. Can someone look?',author:'Sample User',
    deeplink:'https://sample.slack.com/archives/CSAMPLE01/p1700000000000100'};
  var slackAll={key:slackThread.key,url:slackThread.url,channel:slackThread.channel,ts:slackThread.ts,role:'owner',
    channelLabel:'#payments',label:'Webhook deliveries are failing during the provider outage',lastAt:now-10*MIN,
    draft:false,parked:false,pending:false};
  var repo=TOUR_SAMPLE_REPO;
  var f1={path:'docs/release-notes.md',state:'staged'},f2={path:'docs/changelog.md',state:'staged'},f3={path:'config/feature-flags.json',state:'staged'};
  var ships=o.ship?[{repo:repo,slug:'sample/example-app',base:'main',command:'/ship',labelRequired:false,generatedAt:now,onMain:true,
    next:{chats:[{key:key(2),files:[f1,f2],staged:2,unstaged:0}],unattributed:[f3],shared:[],staged:3,unstaged:0},
    lock:null,shipped:[],byChat:(function(){var m={};m[key(2)]={next:'staged',ships:[]};return m;})()}]:[];
  var shipDetail={repo:repo,slug:'sample/example-app',base:'main',command:'/ship',labelRequired:false,onMain:true,generatedAt:now,
    totals:{staged:3,added:58,deleted:6,unstaged:0},lock:null,
    chats:[{key:key(2),title:'Release notes draft',label:'',labelSource:'none',
      staged:[{path:f1.path,state:'staged',added:41,deleted:2,binary:false},{path:f2.path,state:'staged',added:12,deleted:4,binary:false}],unstaged:[]}],
    onlyUnstagedChats:0,
    unattributed:[{path:f3.path,state:'staged',added:5,deleted:0,binary:false,guess:null}],
    gate:{ok:true,reason:''},confirm:'Commit the 3 staged files as one batch and open a pull request.',commands:{plain:'/ship'}};
  var diffText=['diff --git a/docs/release-notes.md b/docs/release-notes.md','--- a/docs/release-notes.md','+++ b/docs/release-notes.md',
    '@@ -1,3 +1,5 @@','# Release notes','+','+This sample diff stands in for a real one.',' ','Thanks for reading.'].join(String.fromCharCode(10));
  function detail(sid){
    var i=sids.indexOf(sid);if(i<0)return {ok:false,detail:'unknown session'};
    var c=chats[i];
    return {ok:true,agent:'claude',session_id:sid,labels:{topic:c.title,stage:i===0?'thread':(i===1?'implementation':'shipping'),name:names[i]},
      where:{kind:'main',cwd:'/sample/example-app',top:'/sample/example-app',repo:'/sample/example-app',branch:'main',base:'main',ahead:0,behind:0},
      filesMode:'session',
      files:i===0?[{path:'src/webhooks/retry.ts',status:'M',state:'uncommitted'},{path:'src/webhooks/retry.test.ts',status:'A',state:'uncommitted'}]:[],
      last:{html:'<p>Should the retry cap be 3 attempts or 5?</p>',at:c.last_turn_at},
      pr:null,todos:[],background:[],
      slack:(o.slack&&i===0)?[slackThread]:[],slackAll:(o.slack&&i===0)?[slackAll]:[],
      pipeline:null,pipelineRef:null,pending:false,ship:null};
  }
  function transcript(sid){
    var i=sids.indexOf(sid);
    return {ok:true,agent:'claude',live:true,messages:[
      {role:'user',text:c0(i)},
      {role:'assistant',text:'I read the handler and added a capped retry. Twelve tests pass.'},
      {role:'assistant',text:'Should the retry cap be 3 attempts or 5?'}]};
  }
  function c0(i){return i<0?'':chats[i].first_message;}
  return {chats:chats,live:live,drafts:drafts,slackOwners:slackOwners,slackCounts:slackCounts,ships:ships,
    detail:detail,transcript:transcript,shipDetail:shipDetail,diff:diffText,repo:repo,sids:sids,draftId:draftId};
}
`;
