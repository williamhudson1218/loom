// The page side of the write guard (§13): one wrapper around window.fetch that
// puts this launch's token on every same-origin request as `x-loom-token`, and
// sends the few writes the page historically made with GET as POST instead
// (the server refuses a GET on a write-only path).
//
// The token is the page's TERM_TOKEN global, read at call time: the server only
// puts it in a page served to Loom's own Host, so a DNS-rebinding page has no
// token and every write it tries is refused. Cross-origin requests are passed
// through untouched, so the token never leaves Loom's origin.
//
// server.ts injects this as its own <script> ahead of the dashboard's script, so
// nothing in dashboard.ts or the *view.ts modules has to change. It is
// idempotent (window.__loomFetch), so splicing it into the page script as well
// does no harm.
//
// No backslashes or regex literals on purpose: page JS gets spliced into
// non-raw template strings elsewhere, which eat them.

export function clientFetchJs(legacyGetPaths: string[]): string {
  const posts = JSON.stringify(legacyGetPaths).split('<').join('');
  return `(function(){
if(window.__loomFetch)return;window.__loomFetch=1;
var F=window.fetch.bind(window);var POSTS=${posts};
function tok(){try{return typeof TERM_TOKEN==='string'?TERM_TOKEN:'';}catch(e){return '';}}
window.fetch=function(input,init){
  try{
    var isReq=typeof Request!=='undefined'&&input instanceof Request;
    var u=new URL(isReq?input.url:String(input),location.href);
    if(u.origin!==location.origin)return F(input,init);
    var o=Object.assign({},init||{});
    var h=new Headers(o.headers||(isReq?input.headers:undefined));
    var t=tok();if(t&&!h.has('x-loom-token'))h.set('x-loom-token',t);
    o.headers=h;
    var m=String(o.method||(isReq?input.method:'GET')).toUpperCase();
    if(m==='GET'&&POSTS.indexOf(u.pathname)>=0)o.method='POST';
    return F(input,o);
  }catch(e){return F(input,init);}
};
})();`;
}
