// The chat list's git mark (see gitmarks.ts for how it is computed). Kept apart
// from gitmarks.ts so the dashboard does not pull the ship scan into its imports.

// gitMarkHtml(m) -> the mark at the front of a chat row's title. Spliced into the
// dashboard script: no backticks, no dollar-brace, no backslashes.
export const GITMARK_CSS = `
  .smk.gclean { color:#5b6275; } .smk.gok { color:#3fb950; } .smk.gwip { color:#e8b04a; } .smk.gnew { color:#f47067; font-weight:700; }
`;

export const GITMARK_JS = String.raw`
var GIT_MARKS={clean:['gclean','○','clean: no changed files'],staged:['gok','✓','all staged'],unstaged:['gwip','●','unstaged changes'],untracked:['gnew','◌','untracked files']};
function gitMarkTip(m){if(m.state==='clean')return GIT_MARKS.clean[2]+(m.worktree?' (worktree)':'');
  var p=[];if(m.staged)p.push(m.staged+' staged');if(m.unstaged)p.push(m.unstaged+' unstaged');if(m.untracked)p.push(m.untracked+' untracked');
  return p.join(' · ')+(m.worktree?' (worktree)':' (this chat’s files)');}
function gitMarkHtml(m){if(!m||!GIT_MARKS[m.state])return '';var g=GIT_MARKS[m.state];
  return '<span class="smk '+g[0]+'" title="'+esc(gitMarkTip(m))+'">'+g[1]+'</span>';}
`;
