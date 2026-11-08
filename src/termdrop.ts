// Dropping files onto the embedded terminal types their paths, the way Ghostty
// does: each absolute path shell-escaped, separated by spaces, one trailing
// space. Claude Code treats a pasted image path as an attachment.
//
// Plain browser JS kept in a string (the dashboard embeds it verbatim) so the
// escaping is testable without a DOM: tests evaluate it and call the functions.
//
// shellEscapePath backslash-escapes everything outside a conservative safe set
// (Ghostty's style, which Claude Code's path detection understands). A path with
// a control character (a newline in a file name) cannot be backslash-escaped, so
// it is single-quoted instead, with embedded quotes closed and reopened.
export const TERMDROP_JS = `
function shellEscapePath(p){
  p=String(p);
  if(/[\\u0000-\\u001f\\u007f]/.test(p))return "'"+p.replace(/'/g,"'\\\\''")+"'";
  return p.replace(/[^A-Za-z0-9_\\-.,:+@%\\/=~]/g,'\\\\$&');
}
function dropText(paths){
  const ps=(paths||[]).filter(x=>typeof x==='string'&&x.length);
  return ps.length?ps.map(shellEscapePath).join(' ')+' ':'';
}
function fileUrlsToPaths(uriList){
  const out=[];
  for(const line of String(uriList||'').split(/\\r?\\n/)){
    const l=line.trim();if(!l||l[0]==='#'||l.indexOf('file://')!==0)continue;
    try{out.push(decodeURIComponent(l.replace(/^file:\\/\\/[^\\/]*/,'')));}catch(e){}
  }
  return out;
}
`;
