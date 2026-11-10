// Slack-faithful rendering of a draft, as plain browser JS in a string (embedded
// verbatim by dashboard.ts; tests evaluate it). String.raw so nothing needs double
// escaping; it must contain neither a backtick nor a dollar-brace, so the code
// fence characters are built from String.fromCharCode(96).
//
// slkRender(text, ctx) -> HTML for ONE message; slkBubbles(messages, ctx) -> one
// bubble per message (a burst is several). The input is untrusted: every piece of
// text is escaped, and the only markup ever emitted is the fixed set below.
//   ctx = { users:{id:name}, channels:{id:name}, emoji:{shortcode:char}, custom:{name:url|'alias:x'} }
// It first applies the same markdown -> mrkdwn conversion slack.mjs applies on send
// (**bold**, [t](u), # heading ...), so what shows is what Slack will show.
export const SLACKMD_JS = String.raw`
var SLK_BT=String.fromCharCode(96), SLK_FENCE=SLK_BT+SLK_BT+SLK_BT;
var SLK_S0=String.fromCharCode(0xE000), SLK_S1=String.fromCharCode(0xE001);
function slkEsc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function slkToMrkdwn(text){
  var segs=String(text).split(new RegExp('('+SLK_FENCE+'[\\s\\S]*?'+SLK_FENCE+'|'+SLK_BT+'[^'+SLK_BT+'\\n]*'+SLK_BT+')','g'));
  return segs.map(function(seg,i){
    if(i%2===1)return seg;
    return seg
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,'<$2|$1>')
      .replace(/\*\*([^*\n]+)\*\*/g,'*$1*')
      .replace(/__([^_\n]+)__/g,'_$1_')
      .replace(/~~([^~\n]+)~~/g,'~$1~')
      .replace(/^#{1,6}[ \t]+(.+)$/gm,'*$1*')
      .replace(/^([ \t]*)\*[ \t]+/gm,'$1• ');
  }).join('');
}
function slkLink(url,text){return '<a class="slk-link" href="'+slkEsc(url)+'" target="_blank" rel="noopener noreferrer">'+slkEsc(text)+'</a>';}
function slkMention(prefix,name){return '<span class="slk-mention">'+prefix+slkEsc(name)+'</span>';}
function slkAngle(inner,ctx){
  var m;
  if((m=/^@([UW][A-Z0-9]+)(?:\|(.*))?$/.exec(inner))){var u=(ctx.users||{})[m[1]]||m[2]||m[1];return slkMention('@',u);}
  if((m=/^#([CG][A-Z0-9]+)(?:\|(.*))?$/.exec(inner))){var c=(ctx.channels||{})[m[1]]||m[2]||m[1];return slkMention('#',String(c).replace(/^#/,''));}
  if((m=/^!(here|channel|everyone)(?:\|.*)?$/.exec(inner)))return slkMention('@',m[1]);
  if((m=/^!subteam\^[A-Z0-9]+(?:\|(.*))?$/.exec(inner)))return slkMention('',m[1]||'@group');
  if((m=/^!date\^[^|]*(?:\|(.*))?$/.exec(inner)))return slkEsc(m[1]||'');
  if((m=/^((?:https?:\/\/|mailto:)[^|\s]*)(?:\|(.*))?$/.exec(inner)))return slkLink(m[1],m[2]||m[1].replace(/^mailto:/,''));
  return null;
}
function slkEmoji(name,tone,ctx){
  var map=ctx.emoji||{};
  if(map[name])return '<span class="slk-emoji-u" title=":'+slkEsc(name)+':">'+map[name]+'</span>';
  var cu=(ctx.custom||{})[name];
  if(typeof cu==='string'&&cu.indexOf('alias:')===0)cu=(ctx.custom||{})[cu.slice(6)];
  if(typeof cu==='string'&&cu.indexOf('https://')===0)return '<img class="slk-emoji" src="'+slkEsc(cu)+'" alt=":'+slkEsc(name)+':" title=":'+slkEsc(name)+':">';
  if(/[a-z]/i.test(name)&&name.length>1)return '<span class="slk-epill">:'+slkEsc(name)+':</span>';
  return null;
}
function slkMark(s,ch,tag){
  var e=ch==='*'?'\\*':ch;
  var re=new RegExp('(^|[\\s(\\[{>.,;:!?\\u2014\\u2026-]|'+SLK_S1+')'+e+'(?![\\s'+e+'])([^'+e+'\\n]*?[^\\s'+e+'])'+e+'(?=$|[\\s)\\]}<.,;:!?\\u2014\\u2026-]|'+SLK_S0+')','g');
  return s.replace(re,function(m,pre,c){return pre+'<'+tag+'>'+c+'</'+tag+'>';});
}
// One line of Slack text -> HTML. Code, links, mentions and emoji are lifted out
// into placeholders first so formatting marks cannot reach into them, then the rest
// is escaped, then formatted, then the placeholders go back.
function slkInline(src,ctx){
  var store=[];
  var put=function(h){store.push(h);return SLK_S0+(store.length-1)+SLK_S1;};
  var s=String(src).split(SLK_S0).join('').split(SLK_S1).join('');
  s=s.replace(new RegExp(SLK_BT+'([^'+SLK_BT+'\\n]+)'+SLK_BT,'g'),function(m,c){return put('<code class="slk-code">'+slkEsc(c)+'</code>');});
  s=s.replace(/<([^<>\n]+)>/g,function(m,inner){var h=slkAngle(inner,ctx);return h===null?m:put(h);});
  s=s.replace(/(^|[\s(])(https?:\/\/[^\s<>]+)/g,function(m,pre,url){var t=/[.,;:!?)\]]+$/.exec(url);var tail=t?t[0]:'';if(tail)url=url.slice(0,url.length-tail.length);return pre+put(slkLink(url,url))+tail;});
  s=s.replace(/:([A-Za-z0-9_+'-]+):(?::skin-tone-([2-6]):)?/g,function(m,name,tone){var h=slkEmoji(name,tone,ctx);return h===null?m:put(h);});
  s=slkEsc(s);
  s=slkMark(s,'*','b');s=slkMark(s,'_','i');s=slkMark(s,'~','s');
  return s.replace(new RegExp(SLK_S0+'(\\d+)'+SLK_S1,'g'),function(m,i){return store[+i];});
}
var SLK_GAP='<div class="slk-gap"></div>';
function slkLines(text,ctx){
  var lines=String(text).split('\n'),out=[],buf=[],i=0;
  var flush=function(){if(buf.length){out.push('<div class="slk-p">'+buf.map(function(l){return slkInline(l,ctx);}).join('<br>')+'</div>');buf=[];}};
  while(i<lines.length){
    var l=lines[i],m;
    if((m=/^(?:&gt;|>){3}[ ]?(.*)$/.exec(l))){flush();var rest=[m[1]].concat(lines.slice(i+1));out.push('<blockquote class="slk-quote">'+rest.map(function(x){return slkInline(x,ctx);}).join('<br>')+'</blockquote>');break;}
    if(/^(?:&gt;|>)/.test(l)){flush();var q=[];while(i<lines.length&&(m=/^(?:&gt;|>)[ ]?(.*)$/.exec(lines[i]))){q.push(m[1]);i++;}out.push('<blockquote class="slk-quote">'+q.map(function(x){return slkInline(x,ctx);}).join('<br>')+'</blockquote>');continue;}
    if(/^([ \t]*)(?:[•-]|\d+[.)])[ \t]+\S/.test(l)){
      flush();var items=[];
      while(i<lines.length&&(m=/^([ \t]*)(?:([•-])|(\d+)[.)])[ \t]+(.*)$/.exec(lines[i]))){
        var depth=Math.min(4,Math.floor(m[1].replace(/\t/g,'  ').length/2));
        items.push('<div class="slk-li" style="margin-left:'+(depth*18)+'px"><span class="slk-bul">'+(m[3]?m[3]+'.':'•')+'</span><span class="slk-lt">'+slkInline(m[4],ctx)+'</span></div>');i++;
      }
      out.push('<div class="slk-list">'+items.join('')+'</div>');continue;
    }
    if(!l.trim()){flush();if(out.length&&out[out.length-1]!==SLK_GAP)out.push(SLK_GAP);i++;continue;}
    buf.push(l);i++;
  }
  flush();
  if(out.length&&out[out.length-1]===SLK_GAP)out.pop();
  return out.join('');
}
function slkRender(text,ctx){
  ctx=ctx||{};
  var src=slkToMrkdwn(String(text==null?'':text).replace(/\r\n?/g,'\n'));
  var parts=[],re=new RegExp(SLK_FENCE+'([\\s\\S]*?)'+SLK_FENCE,'g'),last=0,m;
  while((m=re.exec(src))){if(m.index>last)parts.push({t:'txt',s:src.slice(last,m.index)});parts.push({t:'pre',s:m[1].replace(/^\n/,'').replace(/\n$/,'')});last=m.index+m[0].length;}
  if(last<src.length)parts.push({t:'txt',s:src.slice(last)});
  return parts.map(function(p){return p.t==='pre'?'<pre class="slk-pre">'+slkEsc(p.s)+'</pre>':slkLines(p.s.replace(/^\n/,'').replace(/\n$/,''),ctx);}).join('');
}
// A burst is several messages. A lone draft is one plain bubble; a burst is a distinct card per
// message with a "1/3" marker and its own hover time (time = the draft's, as nothing is sent yet).
function slkBubbles(messages,ctx,time,extras){var ms=messages||[],ex=extras||[];if(ms.length<2)return ms.map(function(m,i){return '<div class="slk-msg">'+slkRender(m,ctx)+(ex[i]||'')+'</div>';}).join('');
  return ms.map(function(m,i){return '<div class="slk-msg slk-burst"><div class="slk-bh"><span class="slk-mark">'+(i+1)+'/'+ms.length+'</span><span class="slk-hts">'+slkEsc(time||'')+'</span></div>'+slkRender(m,ctx)+(ex[i]||'')+'</div>';}).join('');}
`;
