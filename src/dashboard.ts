import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDefaultAgent } from './db.ts';
import { DASHBOARD_PATH } from './paths.ts';
import type { Agent, ChatRow, LaunchPreference } from './types.ts';

export interface ChatView {
  agent: Agent;
  session_id: string;
  project: string;
  project_dir: string;
  jsonl_path: string;
  title: string;
  claude_auto_title: string;
  pr_url: string;
  overview: string;
  state: string; // ChatState or '' when pending
  breakdown: string[];
  first_message: string;
  message_count: number;
  last_active_at: number;
  activity: Record<string, number>;
  summary_pending: boolean;
  saved: boolean;
  saved_at: number;
}

export function toChatViews(db: Database.Database): ChatView[] {
  const rows = db
    .prepare(`SELECT * FROM chats ORDER BY last_active_at DESC`)
    .all() as ChatRow[];
  return rows.map((r) => ({
    agent: r.agent,
    session_id: r.session_id,
    project: path.basename(r.project_dir || 'unknown'),
    project_dir: r.project_dir,
    jsonl_path: r.jsonl_path,
    title: r.title || r.claude_auto_title || '',
    claude_auto_title: r.claude_auto_title,
    pr_url: r.pr_url,
    overview: r.overview,
    state: r.state,
    breakdown: safeArray(r.breakdown_json),
    first_message: r.first_message,
    message_count: r.message_count,
    last_active_at: r.last_active_at,
    activity: safeObj(r.activity_json),
    summary_pending: r.summary_dirty === 1 && !r.title,
    saved: r.saved === 1,
    saved_at: r.saved_at,
  }));
}

function safeArray(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}
function safeObj(s: string): Record<string, number> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// Woven, colorful "loom" mark — threads in the four state colors.
export const LOGO_SVG =
  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<rect x="1" y="1" width="22" height="22" rx="6" fill="#12151c" stroke="#2a3142"/>' +
  '<path d="M7 3.5v17" stroke="#2ea043" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M12 3.5v17" stroke="#d4a72c" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M17 3.5v17" stroke="#e5484d" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M3.5 9h17" stroke="#3b82f6" stroke-width="2.1" stroke-linecap="round"/>' +
  '<path d="M3.5 15h17" stroke="#79b1ff" stroke-width="2.1" stroke-linecap="round"/>' +
  '</svg>';

export const APP_NAME = 'Loom';

export interface LiveLoc {
  agent: Agent;
  session_id: string;
  pane_id: string;
  tmux_session: string;
  window_index: string;
  pane_index: string;
  running: boolean;
  working?: boolean;
  name?: string; // the pane's memorable @name, when it has one
  // The pane's current directory. Always set by liveSessionsFrom(); optional here
  // because consumers of the serialized shape must not assume it, and the Trees
  // tab filters on its presence rather than defaulting it to something wrong.
  cwd?: string;
}

export function renderDashboard(
  views: ChatView[],
  generatedAt: number,
  live: Record<string, LiveLoc> = {},
  defaultAgent: LaunchPreference = 'claude',
  slackOwners: string[] = [],
  drafts: unknown[] = [],
): string {
  const data = JSON.stringify({ generatedAt, defaultAgent, chats: views, live, slackOwners, drafts });
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(LOGO_SVG);
  // All rendering is client-side from DATA; HTML below is a static shell.
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${APP_NAME}</title>
<link rel="icon" href="${favicon}"/>
<style>
  :root { color-scheme: dark;
    --done:#2ea043; --waiting_on_user:#3b82f6; --warning:#d4a72c; --error:#e5484d; --pending:#6b7280; }
  body { margin:0; background:#0d0f15; color:#e6e6e6; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:14px 20px; border-bottom:1px solid #232634; position:sticky; top:0; z-index:5;
    background:linear-gradient(180deg,#141826,#0d0f15); }
  /* Three rows: brand + heatmap + actions / tabs + filters / chips + live toggle.
     Every control in them is 32px tall with an 8px radius and the same border,
     except the chips, which are deliberately smaller so the tabs read as primary. */
  .topbar { display:flex; justify-content:space-between; align-items:center; gap:16px; }
  .actions { display:flex; gap:8px; align-items:center; flex:none; }
  .actions button { height:32px; box-sizing:border-box; border-radius:8px; padding:0 12px; }
  .brand { display:flex; align-items:center; gap:10px; flex:none; }
  .brand h1 { font-size:18px; margin:0; font-weight:700; letter-spacing:.3px;
    background:linear-gradient(90deg,#79b1ff,#7ee0a0); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .brand .sub { color:#8b93a7; font-size:12px; }
  .heatwrap { flex:1; min-width:0; display:flex; align-items:center; justify-content:center; gap:8px; }
  .heatlbl { color:#6b7280; font-size:11px; }
  #heatmap { display:flex; gap:2px; }
  @media (max-width:900px) { .heatwrap { display:none; } }
  /* Primary view switch — a segmented control, kept distinct from the filters below */
  .tabs { display:inline-flex; flex:none; height:32px; box-sizing:border-box; background:#141826; border:1px solid #2b3040; border-radius:8px; padding:2px; gap:2px; }
  .tab { height:26px; background:transparent; border:0; color:#8b93a7; border-radius:6px; padding:0 14px; cursor:pointer; font-size:13px; font-weight:600; transition:background .15s, color .15s; }
  .tab:hover { color:#c4ccdc; background:#1b2233; }
  .tab.on { background:#26304a; color:#fff; }
  .tab.on:hover { background:#2b3654; }
  .tab .cnt { opacity:.6; margin-left:6px; }
  .tab.savedtab.on { background:#3a3826; color:#f0dfa0; }
  .tab.savedtab.on:hover { background:#46432e; }
  .hcell { width:10px; height:10px; border-radius:2px; background:#1b1f2a; }
  .row2 { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top:12px; }
  .controls { flex:1; min-width:0; display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  input,select { background:#1b1f2a; color:#e6e6e6; border:1px solid #2b3040; border-radius:6px; padding:6px 8px; }
  header input, header select { height:32px; box-sizing:border-box; border-radius:8px; padding:0 10px; }
  #q { flex:1; min-width:220px; }
  /* Narrow: the search takes a line of its own, the selects share the next. */
  @media (max-width:700px) { #q { flex-basis:100%; } }
  .row3 { display:flex; justify-content:space-between; align-items:center; gap:10px; flex-wrap:wrap; margin-top:10px; }
  .chips { display:flex; gap:6px; flex-wrap:wrap; }
  .chip { display:inline-flex; align-items:center; height:26px; box-sizing:border-box; background:#1b1f2a; border:1px solid #2b3040; color:#c4ccdc; border-radius:999px; padding:0 10px; cursor:pointer; font-size:12px; }
  /* Live/All — a small sibling of .tabs, since it switches the set, not a filter on it. */
  .seg { display:inline-flex; margin-left:auto; height:32px; box-sizing:border-box; background:#141826; border:1px solid #2b3040; border-radius:8px; padding:2px; gap:2px; }
  .seg button { height:26px; background:transparent; color:#8b93a7; border-radius:6px; padding:0 12px; font-size:12px; font-weight:600; }
  .seg button:hover { color:#c4ccdc; background:#1b2233; }
  .seg button.on { background:#26304a; color:#fff; }
  .chip:hover { border-color:#3a4258; }
  .chip.on { background:#222a3d; border-color:#4d5b80; color:#fff; }
  .chip .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px; vertical-align:middle; }
  main { padding:16px 20px; display:grid; gap:11px; max-width:1100px; }
  .card { background:#161a24; border:1px solid #232634; border-left:4px solid var(--pending); border-radius:10px; padding:11px 14px; transition:border-color .15s, background .15s; }
  .card:hover { background:#1a1f2c; }
  /* EM activity feed — shadow entries read muted so a week of "would" is
     scannable and any stray "did" stands out while calibrating. */
  .tab.emtab.on { background:#2b3446; color:#bcd2f5; }
  .tab.emtab.on:hover { background:#354056; }
  /* Hidden until its tab is selected; syncControls() owns the toggle. */
  #em-section { display:none; padding:0 20px 24px; }
  .emtop { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:18px 0 4px; }
  .emtitle { font-size:14px; color:#8b93a7; font-weight:600; margin:0; text-transform:uppercase; letter-spacing:.6px; }
  .emmodes { display:flex; gap:2px; background:#161a26; border:1px solid #232634; border-radius:8px; padding:2px; }
  .emmodes button { font:inherit; font-size:12px; padding:3px 12px; border:0; border-radius:6px; background:transparent; color:#8b93a7; cursor:pointer; }
  .emmodes button:hover { color:#e6e6e6; }
  .emmodes button.on { background:#2b3446; color:#e6e6e6; }
  .emmodes button.on[data-m="shadow"] { background:#4a4322; color:#f0dfa0; }
  .emmodes button.on[data-m="live"] { background:#1f5f38; color:#a8e6c0; }
  .emmodes button.arm { background:var(--error); color:#fff; }
  .emhint { font-size:11px; color:#6f778a; margin:0 0 10px; }
  .emfeed { display:flex; flex-direction:column; gap:6px; }
  .emrow { border:1px solid #232634; border-left:3px solid var(--pending); border-radius:6px; padding:8px 10px; background:#11141d; }
  .emrow.em-escalated { border-left-color:var(--waiting_on_user); }
  .emrow.em-acted { border-left-color:var(--done); }
  .emrow.em-expired { opacity:.55; }
  .emhead { font-size:12px; color:#8b93a7; }
  .emwho { font-size:13px; color:#e6e6e6; margin-top:2px; }
  .emproj { font-size:11px; color:#8b93a7; }
  .emwhy { font-size:11px; color:#6f778a; margin-top:1px; }
  .emact { font-size:12px; margin-top:5px; color:#e6e6e6; word-break:break-word; }
  .emact.shadow { color:#8b93a7; font-style:italic; }
  .emtag { font-size:10px; padding:1px 5px; border-radius:4px; background:#232634; color:#8b93a7; margin-right:5px; }
  .emact:not(.shadow) .emtag { background:var(--done); color:#0d0f15; }
  /* Trees — worktree inventory, diffs and cleanup. Hidden until its tab is
     selected; syncControls() owns the toggle, same as #em-section. */
  .tab.treetab.on { background:#233a34; color:#a8e6c0; }
  .tab.treetab.on:hover { background:#2b453e; }
  #trees-section { display:none; padding:0 20px 24px; }
  .twrap { display:grid; grid-template-columns:340px 1fr; border:1px solid #232634; border-radius:10px; overflow:hidden; margin-top:16px; min-height:540px; }
  .trail { border-right:1px solid #232634; background:#11141d; overflow-y:auto; max-height:74vh; }
  /* Cleanup is a triage table, not a browser — it takes the full width and the
     rail goes away rather than sitting there showing the same rows twice. */
  .twrap.cleanup { grid-template-columns:1fr; }
  .twrap.cleanup .trail { display:none; }
  /* The triage list scrolls inside the panel rather than scrolling the page:
     .twrap is overflow:hidden (for the rounded corners), which would otherwise
     be the sticky footer's scrollport and never scroll, stranding the action
     44 rows below the group it applies to. Sized off the viewport minus Loom's
     header and tabs so the panel's own bottom edge — and the footer pinned to
     it — land above the fold. */
  .twrap.cleanup { min-height:0; }
  .twrap.cleanup .tdetail { max-height:calc(100vh - 250px); overflow-y:auto; }
  .tmodes { display:flex; gap:2px; background:#161a26; border:1px solid #232634; border-radius:7px; padding:2px; }
  .tmodes button { font:inherit; font-size:11px; padding:3px 9px; border:0; border-radius:5px; background:transparent; color:#8b93a7; cursor:pointer; }
  .tmodes button.on { background:#2b3446; color:#e6e6e6; }
  .trepo { padding:7px 13px; background:#151a26; border-bottom:1px solid #232634; font-size:11px; color:#8b93a7; letter-spacing:.4px; text-transform:uppercase; font-weight:600; }
  /* Collapsible rail groups. Grouped by whether a pane is living there, which is
     a different question from the cleanup verdict: a worktree can be full of
     unmerged work and long abandoned, or clean and actively occupied. */
  .tgrp { display:flex; align-items:center; gap:7px; padding:6px 13px; background:#12161f; border-bottom:1px solid #232634; cursor:pointer; font-size:10.5px; font-weight:600; letter-spacing:.5px; text-transform:uppercase; color:#8b93a7; user-select:none; }
  .tgrp:hover { color:#c4ccdc; background:#161b26; }
  .tgcar { font-size:8px; transition:transform .12s; display:inline-block; }
  .tgrp.open .tgcar { transform:rotate(90deg); }
  .tgcount { margin-left:auto; opacity:.55; font-variant-numeric:tabular-nums; }
  .twt { padding:8px 13px; border-bottom:1px solid #191d28; border-left:3px solid transparent; cursor:pointer; }
  .twt:hover { background:#161c28; }
  .twt.on { background:#1d2433; border-left-color:#79b1ff; }
  .twtl1 { display:flex; align-items:center; gap:7px; }
  .twtname { font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .twtl2 { display:flex; align-items:center; gap:8px; font-size:11px; color:#6f778a; margin-top:2px; }
  .twtbr { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:#8b93a7; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:180px; }
  .tsp { flex:1; }
  .tdot { width:7px; height:7px; border-radius:50%; flex-shrink:0; }
  .tdot.v-safe { background:var(--done); } .tdot.v-active { background:var(--pending); }
  .tdot.v-uncommitted { background:var(--error); } .tdot.v-untracked-only { background:var(--warning); }
  .tdot.v-primary { background:#79b1ff; }
  .tct { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; font-variant-numeric:tabular-nums; }
  .tct.a { color:#56d364; } .tct.d { color:#ff8086; } .tct.b { color:#6f778a; }
  .ttag { font-size:9.5px; font-weight:600; letter-spacing:.05em; text-transform:uppercase; padding:2px 6px; border-radius:4px; white-space:nowrap; }
  .ttag.safe { background:rgba(46,160,67,.16); color:#56d364; }
  .ttag.risk { background:rgba(229,72,77,.18); color:#ff8086; }
  .ttag.warn { background:rgba(212,167,44,.18); color:#e8b84b; }
  .ttag.live { background:rgba(46,160,67,.14); color:#56d364; cursor:pointer; }
  .tdetail { display:flex; flex-direction:column; min-width:0; background:#0d0f15; }
  .tdhead { display:flex; align-items:center; gap:10px; padding:9px 15px; border-bottom:1px solid #232634; background:#12151e; }
  .tcrumb { font-size:12px; color:#8b93a7; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tcrumb b { color:#e6e6e6; }
  .tbtns { margin-left:auto; display:flex; gap:6px; flex-shrink:0; }
  .tbtn { font-size:11.5px; font-weight:600; padding:5px 10px; border-radius:6px; border:1px solid #2b3040; background:#1b1f2a; color:#c4ccdc; cursor:pointer; }
  .tbtn:hover { border-color:#3a4258; }
  .tbtn.on { background:#2b3446; color:#fff; border-color:#3a4a63; }
  .tbtn.danger { background:var(--error); border-color:var(--error); color:#fff; }
  .tbtn.danger[disabled] { opacity:.4; cursor:default; }
  .tfiles { border-bottom:1px solid #232634; background:#10131b; max-height:190px; overflow-y:auto; }
  .tfile { display:flex; align-items:center; gap:9px; padding:6px 15px; font-size:12.5px; border-left:3px solid transparent; cursor:pointer; }
  .tfile:hover { background:#161c28; }
  .tfile.on { background:#1d2433; border-left-color:#79b1ff; }
  .tfname { font-weight:600; white-space:nowrap; }
  .tfpath { color:#6f778a; font-size:11.5px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tdiff { font:12px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace; overflow:auto; flex:1; max-height:52vh; }
  .thunk { padding:3px 15px; background:#141a26; color:#7f92b8; border-top:1px solid #232634; border-bottom:1px solid #232634; font-size:11.5px; }
  .dl { display:flex; white-space:pre; }
  .dl .ln { width:46px; flex-shrink:0; text-align:right; padding-right:10px; color:#545c70; user-select:none; font-variant-numeric:tabular-nums; }
  .dl .mk { width:13px; flex-shrink:0; user-select:none; }
  .dl .tx { padding-right:15px; }
  .dl.add { background:rgba(46,160,67,.14); } .dl.add .mk,.dl.add .tx { color:#a8e6c0; }
  .dl.del { background:rgba(229,72,77,.13); } .dl.del .mk,.dl.del .tx { color:#ffb3b6; }
  .dl.ctx .tx { color:#a9b2c6; }
  .tbtnsep { width:1px; align-self:stretch; background:#2b3040; margin:0 2px; }
  /* Side-by-side. Each column scrolls horizontally on its own (monorepo paths
     are long), while vertical alignment is held by the filler rows pairRows()
     emits rather than by syncing scroll positions. */
  .tsplit { display:grid; grid-template-columns:1fr 1fr; }
  .tsplitcol { min-width:0; overflow-x:auto; }
  .tsplitcol + .tsplitcol { border-left:1px solid #2b3040; }
  .dl.pad { background:#0f1219; }
  .dl.pad .tx { color:transparent; }
  .tempty { padding:26px 16px; color:#6f778a; font-size:13px; text-align:center; }
  .tgroup { border-bottom:1px solid #232634; }
  .tghead { display:flex; align-items:center; gap:10px; padding:9px 15px; background:#12151e; }
  .tgtitle { font-size:12px; font-weight:600; letter-spacing:.4px; text-transform:uppercase; }
  .tgwhy { font-size:11.5px; color:#6f778a; }
  .tgn { margin-left:auto; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:#8b93a7; }
  .g-safe .tgtitle { color:#56d364; } .g-untracked-only .tgtitle { color:#e8b84b; }
  .g-uncommitted .tgtitle { color:#ff8086; } .g-active .tgtitle,.g-primary .tgtitle { color:#8b93a7; }
  .tcrow { display:flex; align-items:center; gap:11px; padding:8px 15px; border-top:1px solid #191d28; font-size:13px; }
  .tcbr { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; min-width:210px; }
  .tcnote { color:#6f778a; font-size:11.5px; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; }
  .tck { width:13px; height:13px; border-radius:3px; border:1px solid #3a4258; flex-shrink:0; cursor:pointer; position:relative; }
  .tck.on { background:var(--done); border-color:var(--done); }
  .tck.on::after { content:'✓'; position:absolute; inset:0; font-size:9px; color:#0d0f15; display:grid; place-items:center; font-weight:700; }
  /* A protected row gets no checkbox at all, only a placeholder holding the
     column. A dimmed checkbox still reads as "tick me", which is the one thing
     these rows must not invite. */
  .tck.off { border:0; background:transparent; cursor:default; }
  .tck.off::after { content:'·'; position:absolute; inset:0; display:grid; place-items:center; color:#3a4258; font-size:14px; }
  /* 44 rows of triage put the action a long scroll below the Safe group. */
  .tfoot { display:flex; align-items:center; gap:12px; padding:11px 15px; background:#12151e; border-top:1px solid #232634; position:sticky; bottom:0; z-index:2; }
  .tsum { font-size:12.5px; color:#8b93a7; }
  .tsum b { color:#e6e6e6; }
  .card.s-done { border-left-color:var(--done); }
  .card.s-waiting_on_user { border-left-color:var(--waiting_on_user); }
  .card.s-warning { border-left-color:var(--warning); }
  .card.s-error { border-left-color:var(--error); }
  .card.jumpable { cursor:pointer; }
  .card.jumpable:hover { background:#1d2433; border-color:#3a4a63; box-shadow:0 0 0 1px rgba(122,224,160,.25) inset; }
  .live { color:#56d364; font-size:11.5px; font-weight:600; }
  .live .pin { opacity:.85; }
  .stale { color:#6b7280; font-size:11.5px; }
  .working { color:#e8b84b; font-size:11.5px; font-weight:600; }
  @keyframes pulse { 0%,100%{opacity:.35} 50%{opacity:1} }
  .working .pin { animation:pulse 1s ease-in-out infinite; }
  .card.work { border-color:#4a3d1f; background:#1b1a17; }
  .sweep { position:absolute; top:0; left:0; right:0; height:3px; border-radius:10px 10px 0 0; overflow:hidden; pointer-events:none; }
  .sweep::after { content:''; position:absolute; top:0; bottom:0; width:38%; background:linear-gradient(90deg,transparent,#e8b84b,#fff3cf,#e8b84b,transparent); animation:streak 1.25s linear infinite; }
  @keyframes streak { 0%{transform:translateX(-120%)} 100%{transform:translateX(330%)} }
  .flash { position:absolute; right:14px; top:11px; font-size:11px; padding:2px 8px; border-radius:6px; background:#1f6f3f; color:#fff; }
  .card { position:relative; }
  .chead { display:flex; align-items:flex-start; gap:10px; }
  .card h2 { font-size:15px; margin:0; flex:1; cursor:pointer; }
  .pill { font-size:11px; padding:2px 9px; border-radius:999px; font-weight:600; white-space:nowrap; flex-shrink:0; }
  .pill.done { background:rgba(46,160,67,.16); color:#56d364; }
  .pill.waiting_on_user { background:rgba(59,130,246,.18); color:#79b1ff; }
  .pill.warning { background:rgba(212,167,44,.18); color:#e3c050; }
  .pill.error { background:rgba(229,72,77,.18); color:#ff8086; }
  .pill.pending { background:#23262f; color:#9aa3b2; }
  .pill.source { background:#243044; color:#a7c7ff; }
  .meta { color:#8b93a7; font-size:12px; margin-top:3px; }
  .ptag { display:inline-block; padding:1px 7px; border-radius:5px; font-weight:600; font-size:11px; margin-right:6px; }
  .spark { font-family:monospace; letter-spacing:1px; color:#7db0ff; }
  .ov { margin:7px 0 0; color:#dfe4ee; }
  .km { margin:8px 0 0; display:none; }
  .km h3 { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:#8b93a7; margin:0 0 4px; }
  .km ul { margin:0; padding-left:18px; color:#c4ccdc; }
  .card.open .km { display:block; }
  .pending-note { color:#c8a44d; font-size:12px; margin-top:6px; }
  .resume { margin-top:9px; display:flex; gap:8px; align-items:center; }
  code { background:#0d0f15; border:1px solid #232634; border-radius:6px; padding:3px 6px; font-size:12px; }
  code.sid { color:#8b93a7; }
  button { background:#2b3040; color:#e6e6e6; border:0; border-radius:6px; padding:5px 9px; cursor:pointer; transition:background .15s; }
  button:hover { background:#3a4150; }
  button.ok { background:#1f6f3f; color:#fff; }
  .resume { flex-wrap:wrap; }
  .spacer { flex:1; }
  button.open { background:#1c4a2e; color:#9be8b4; font-weight:600; }
  button.open:hover { background:#246138; }
  button.resumebtn { background:#1c2f4d; color:#9bc1ff; font-weight:600; }
  button.resumebtn:hover { background:#244070; }
  /* Cross-agent handoff — deliberately quieter than resume: it starts a NEW session */
  button.startbtn { background:#232a37; color:#9aa9c4; }
  button.startbtn:hover { background:#2d3646; color:#c4d2ea; }
  /* Marks whichever action matches the header's "Launch with" preference. With
     "Ask every time" nothing carries this, so neither agent reads as the default. */
  button.pref { box-shadow:0 0 0 1.5px #5c6b93; }
  button.branchbtn { background:#2d2340; color:#c9a9ff; font-weight:600; }
  button.branchbtn:hover { background:#3f3060; }
  button.closebtn { background:#2b2230; color:#caa3b8; }
  button.closebtn:hover { background:#3d2a36; }
  button.closebtn.arm { background:#7a1f2b; color:#fff; }
  a.prbtn { background:#2d2348; color:#c9b6ff; border:0; border-radius:6px; padding:5px 9px; font-size:12px; font-weight:600; text-decoration:none; display:inline-block; }
  a.prbtn:hover { background:#3b2e63; }
  button.savebtn { background:#2a2a1c; color:#e3d08a; font-weight:600; }
  button.savebtn:hover { background:#3a3826; }
  button.unsavebtn { background:#3a3826; color:#f0dfa0; font-weight:600; }
  button.unsavebtn:hover { background:#4a462f; }
  .card { cursor:pointer; }
  #overlay { position:fixed; inset:0; background:rgba(0,0,0,.5); opacity:0; pointer-events:none; transition:opacity .2s; z-index:8; }
  #overlay.on { opacity:1; pointer-events:auto; }
  #panel { position:fixed; top:0; right:0; height:100vh; width:min(560px,94vw); background:#11141d; border-left:1px solid #232634; transform:translateX(100%); transition:transform .22s ease; z-index:9; display:flex; flex-direction:column; }
  #panel.on { transform:translateX(0); box-shadow:-24px 0 60px rgba(0,0,0,.45); }
  .phead { padding:13px 16px; border-bottom:1px solid #232634; display:grid; grid-template-columns:1fr auto; gap:3px 10px; align-items:start; }
  .ptitle { font-weight:700; font-size:15px; }
  .pmeta { color:#8b93a7; font-size:12px; grid-column:1/2; }
  #pclose { grid-row:1/3; }
  .pbody { flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:9px; }
  .msg { max-width:90%; padding:8px 11px; border-radius:10px; font-size:13px; line-height:1.45; white-space:pre-wrap; word-break:break-word; }
  .msg.user { align-self:flex-end; background:#1c2f4d; color:#dbe7ff; }
  .msg.assistant { align-self:flex-start; background:#191d28; border:1px solid #232634; color:#dfe4ee; }
  .msg .who { font-size:10px; text-transform:uppercase; letter-spacing:.5px; opacity:.55; margin-bottom:2px; }
  .pfoot { padding:12px 16px; border-top:1px solid #232634; }
  .pfoot textarea { width:100%; box-sizing:border-box; resize:vertical; min-height:48px; background:#1b1f2a; color:#e6e6e6; border:1px solid #2b3040; border-radius:8px; padding:8px; font:inherit; }
  .sendrow { display:flex; gap:8px; margin-top:8px; align-items:center; }
  .sendrow .grow { flex:1; color:#8b93a7; font-size:11.5px; }
  button.send { background:#1c4a2e; color:#9be8b4; font-weight:600; }
  button.send:hover { background:#246138; }
  .stalefoot { color:#c8a44d; font-size:13px; }
  .picker { margin-top:8px; display:flex; flex-direction:column; gap:5px; }
  .picker:empty { display:none; }
  .pickhdr { font-size:11px; text-transform:uppercase; letter-spacing:.5px; color:#8b93a7; }
  .muted { color:#8b93a7; font-size:12px; }
  button.paneopt { text-align:left; background:#1b1f2a; border:1px solid #2b3040; display:flex; justify-content:space-between; gap:12px; }
  button.paneopt:hover { background:#222a3d; border-color:#3a4a63; }
  .pcwd { color:#6b7280; font-size:11px; }
  /* Saved-for-later cards carry a warm tint wherever they render (the Saved tab) */
  .card.saved { border-left-color:#e3d08a; background:#191712; }
  .card.saved:hover { background:#1e1b14; }
  /* Archive search — chats older than the board window, surfaced via find-chat */
  .deeplink { display:none; margin-top:9px; color:#79b1ff; font-size:12.5px; cursor:pointer;
    border-bottom:1px dashed #3a4a63; width:fit-content; }
  .deeplink:hover { color:#a8ccff; border-bottom-color:#79b1ff; }
  #archive { padding:0 20px 26px; max-width:1100px; display:grid; gap:11px; }
  #archive:empty { display:none; }
  .ahead { display:flex; align-items:center; gap:10px; margin-top:4px;
    color:#8b93a7; font-size:11px; text-transform:uppercase; letter-spacing:.6px; }
  .ahead::after { content:''; flex:1; height:1px; background:#232634; }
  /* Dashed + dimmer than a board card: no live pane, no AI summary — a different class of thing */
  .card.arch { border-left-style:dashed; border-left-color:#3a4258; background:#141720; }
  .card.arch:hover { background:#181c27; }
  .pill.arch { background:#23262f; color:#9aa3b2; }
  .snip { color:#c4ccdc; font-size:12.5px; }
  .chead .ico { flex-shrink:0; width:26px; height:24px; padding:0; display:inline-grid; place-items:center; font-size:13px; line-height:1; background:#1b1f2a; color:#8b93a7; border:1px solid #2b3040; }
  .chead .ico:hover { background:#222a3d; color:#e6e6e6; }
  .chead .ico.open { color:#9be8b4; border-color:#1f5f38; }
  .chead .ico.open:hover { background:#1c4a2e; }
  .chead .ico.savebtn { color:#c8b46a; }
  .chead .ico.unsavebtn { color:#f0dfa0; background:#3a3826; border-color:#4a462f; }
  .prn { color:#c9b6ff; font-weight:600; }
  .slk { display:inline-block; font-weight:800; color:#e8a6e0; background:#3a2238; border-radius:4px; padding:0 5px; font-size:11px; }
  .sthread { border:1px solid #232634; border-radius:8px; padding:7px 10px; display:flex; flex-direction:column; gap:4px; background:#11141d; }
  .sprev { font-size:12.5px; color:#c4ccdc; }
  .dft { color:#e8a6e0; font-weight:700; }
  #composer { position:fixed; inset:0; z-index:20; background:rgba(0,0,0,.55); display:grid; place-items:start center; padding-top:12vh; }
  #composer[hidden] { display:none; }
  .cbox { width:min(760px,92vw); background:#11141d; border:1px solid #2b3040; border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:10px; box-shadow:0 24px 60px rgba(0,0,0,.5); }
  .cbox.drop { border-color:#79b1ff; box-shadow:0 0 0 2px rgba(121,177,255,.35); }
  .cbox textarea { width:100%; box-sizing:border-box; min-height:140px; resize:vertical; background:#1b1f2a; color:#e6e6e6; border:1px solid #2b3040; border-radius:8px; padding:10px; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  .crow { display:flex; gap:10px; align-items:center; flex-wrap:wrap; font-size:12.5px; color:#8b93a7; }
  .crow label { display:flex; gap:6px; align-items:center; }
  .crow select { max-width:260px; }
  .cchk input { margin:0; }
  #cthumbs { display:flex; gap:8px; flex-wrap:wrap; }
  #cthumbs:empty { display:none; }
  .cthumb { position:relative; width:84px; height:64px; border-radius:6px; overflow:hidden; border:1px solid #2b3040; }
  .cthumb img { width:100%; height:100%; object-fit:cover; display:block; }
  .cthumb button { position:absolute; top:2px; right:2px; padding:0 5px; font-size:11px; background:rgba(0,0,0,.65); }
  .card.ghost { border-style:dashed; border-left-style:solid; opacity:.8; }
  .draft { border:1px solid #4a2d48; border-left:3px solid #e8a6e0; border-radius:8px; padding:8px 10px; display:flex; flex-direction:column; gap:6px; background:#161220; }
  .draft textarea { width:100%; box-sizing:border-box; resize:vertical; background:#1b1f2a; color:#e6e6e6; border:1px solid #2b3040; border-radius:6px; padding:6px 8px; font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; }
  .draft .arow { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  .dconfirm { display:flex; flex-direction:column; gap:6px; }
  .dfinal { margin:0; white-space:pre-wrap; word-break:break-word; background:#0d0f15; border:1px solid #e8a6e0; border-radius:6px; padding:6px 8px; font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif; color:#e6e6e6; }
  /* Board + detail panel. The panel is a sticky column of its own, so selecting a
     card never reflows the list; --hh is the live header height, set from JS. */
  #boardwrap { display:grid; grid-template-columns:minmax(0,1100px) minmax(0,1fr); align-items:start; }
  #col { min-width:0; }
  #detail { position:sticky; top:var(--hh,150px); height:calc(100vh - var(--hh,150px)); overflow-y:auto; box-sizing:border-box;
    border-left:1px solid #232634; padding:16px 20px 28px; display:flex; flex-direction:column; gap:14px; }
  @media (max-width:1300px) { #boardwrap { grid-template-columns:minmax(0,1fr) 420px; } }
  @media (max-width:900px) { #boardwrap { grid-template-columns:1fr; } #detail { display:none; } }
  .card.sel { border-color:#5c6b93; background:#1d2433; box-shadow:0 0 0 1px #5c6b93 inset; }
  .dsec { display:flex; flex-direction:column; gap:6px; min-width:0; }
  .dsec > h3 { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:#8b93a7; margin:0; font-weight:600; display:flex; align-items:center; gap:8px; }
  .dsec > h3 .n { opacity:.6; font-weight:400; text-transform:none; letter-spacing:0; }
  .dtitle { font-size:16px; font-weight:700; line-height:1.3; }
  .dsub { color:#8b93a7; font-size:12px; }
  .drow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12.5px; color:#c4ccdc; }
  .stage { font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; background:#1b1f2a; border:1px solid currentColor; }
  .stage.s-discovery { color:#5fafff; } .stage.s-implementation { color:#87d787; }
  .stage.s-shipping { color:#d787d7; } .stage.s-thread { color:#ffaf5f; }
  .dname { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; color:#c4ccdc; }
  .dloc { color:#8b93a7; font-size:12px; }
  code.copyable { cursor:pointer; } code.copyable:hover { border-color:#3a4a63; color:#c4ccdc; }
  .iconbtn { background:#1c4a2e; color:#9be8b4; padding:3px 8px; font-size:12px; font-weight:600; }
  .iconbtn:hover { background:#246138; }
  .iconbtn.ghost { background:#1b1f2a; color:#c4ccdc; }
  .iconbtn.ghost:hover { background:#222a3d; }
  .dmono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; }
  .dpath { color:#6f778a; font-size:11.5px; word-break:break-all; }
  .dfiles { display:flex; flex-direction:column; border:1px solid #232634; border-radius:8px; overflow:hidden; }
  .dfile { display:flex; align-items:center; gap:8px; padding:4px 10px; font-size:12px; border-top:1px solid #191d28; min-width:0; }
  .dfile:first-child { border-top:0; }
  .dfile .fp { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; color:#c4ccdc; }
  .fst { font-size:10px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; padding:1px 6px; border-radius:4px; flex-shrink:0; }
  .fst.uncommitted { background:rgba(229,72,77,.18); color:#ff8086; }
  .fst.untracked { background:rgba(212,167,44,.18); color:#e8b84b; }
  .fst.staged { background:rgba(59,130,246,.18); color:#79b1ff; }
  .fst.committed { background:rgba(46,160,67,.16); color:#56d364; }
  .fst.unchanged, .fst.outside, .fst.ignored { background:#23262f; color:#8b93a7; }
  .dlast { position:relative; border:1px solid #232634; border-radius:8px; padding:8px 12px; background:#11141d; font-size:13px; line-height:1.5; color:#dfe4ee; overflow:hidden; max-height:200px; }
  .dlast.open { max-height:none; }
  .dlast:not(.open)::after { content:''; position:absolute; left:0; right:0; bottom:0; height:40px; background:linear-gradient(transparent,#11141d); pointer-events:none; }
  .dlast.turn { border-color:var(--waiting_on_user); background:#121a2b; }
  .dlast.turn:not(.open)::after { background:linear-gradient(transparent,#121a2b); }
  .dlast p { margin:0 0 6px; } .dlast h4 { margin:6px 0 4px; font-size:13px; }
  .dlast ul, .dlast ol { margin:0 0 6px; padding-left:20px; }
  .dlast pre { background:#0d0f15; border:1px solid #232634; border-radius:6px; padding:6px 8px; overflow-x:auto; font-size:11.5px; margin:0 0 6px; }
  .dlast code { padding:1px 4px; font-size:11.5px; }
  .dlast a { color:#79b1ff; }
  .dlast blockquote { margin:0 0 6px; padding-left:10px; border-left:3px solid #3a4258; color:#c4ccdc; }
  .turnlbl { color:#79b1ff; font-weight:700; text-transform:none; letter-spacing:0; font-size:11px; }
  .linkbtn { background:none; color:#79b1ff; padding:0; font-size:12px; align-self:flex-start; }
  .linkbtn:hover { background:none; color:#a8ccff; }
  .prline { display:flex; align-items:center; gap:7px; flex-wrap:wrap; font-size:12.5px; }
  .prline a { color:#c9b6ff; font-weight:600; text-decoration:none; }
  .prline a:hover { text-decoration:underline; }
  .shipstrip { border:1px solid #2f3442; background:#151922; border-radius:10px; padding:9px 12px; margin-bottom:10px; display:flex; flex-direction:column; gap:6px; }
  .shipstrip .sh { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12.5px; color:#b8bfcc; }
  .shipstrip .sh b { color:#e6e9ef; }
  .shipstrip .shc { display:flex; gap:6px; flex-wrap:wrap; }
  .shipmate { font-size:11.5px; border:1px solid #2f3442; border-radius:999px; padding:1px 8px; cursor:pointer; color:#c9d1dd; background:#1b2029; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .shipmate:hover { border-color:#4a5468; }
  .shipmate .ok { color:#56d364; } .shipmate .wip { color:#e8b84b; }
  .shiplock { color:#f2cc60; font-weight:700; } .shiplock.stale { color:#8b93a7; font-weight:400; }
  .shipchip { font-size:10.5px; font-weight:700; padding:0 7px; border-radius:999px; background:rgba(121,177,255,.14); color:#9cc4ff; cursor:pointer; border:0; margin-left:4px; }
  .shipchip.next { background:rgba(212,167,44,.16); color:#e8b84b; } .shipchip.next.ready { background:rgba(46,160,67,.16); color:#56d364; }
  .shipchip.on { outline:1px solid currentColor; }
  .shipfiles { display:flex; flex-direction:column; gap:1px; font-size:11.5px; }
  .shipfiles .sf { display:flex; gap:6px; min-width:0; } .shipfiles .sf .fp { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; direction:rtl; text-align:left; }
  .pdots { display:inline-flex; gap:2px; vertical-align:middle; margin-left:3px; }
  .pd { width:7px; height:7px; border-radius:50%; background:#3a3f4b; display:inline-block; }
  .pd.pass { background:#2ea043; } .pd.fail { background:#e5484d; } .pd.skipped { background:#2a2e38; box-shadow:inset 0 0 0 1px #4a5060; }
  .pd.running { background:#d4a72c; animation:pdpulse 1.2s ease-in-out infinite; } .pd.waiting { background:#3a3f4b; box-shadow:inset 0 0 0 1px #6b7385; }
  @keyframes pdpulse { 50% { opacity:.35; } }
  .pev { font-size:10.5px; font-weight:700; padding:0 6px; border-radius:999px; margin-left:4px; }
  .pev.good { background:rgba(46,160,67,.18); color:#56d364; } .pev.bad { background:rgba(229,72,77,.2); color:#ff8086; } .pev.info { background:rgba(59,130,246,.18); color:#79b1ff; }
  .stepper { display:flex; flex-direction:column; gap:0; margin-top:4px; }
  .step { display:grid; grid-template-columns:18px 1fr auto; gap:2px 8px; align-items:start; position:relative; padding:3px 0; }
  .step .si { width:16px; height:16px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:10px; font-weight:800; background:#2a2e38; color:#9aa3b2; z-index:1; }
  .step.pass > .si { background:#1f5130; color:#7ee08f; } .step.fail > .si { background:#5a2226; color:#ff9aa0; }
  .step.running > .si { background:#5a4716; color:#f2cc60; animation:pdpulse 1.2s ease-in-out infinite; } .step.skipped > .si { background:#20232b; color:#5f6676; }
  .step.top:not(:last-child)::before { content:''; position:absolute; left:7.5px; top:19px; bottom:-3px; width:1px; background:#2f3442; }
  .step .sl { font-size:12.5px; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .step .sl.tog { cursor:pointer; } .step .sl.tog:hover { color:#e6e9ef; }
  .step .sd { grid-column:2/4; font-size:11.5px; color:#8b93a7; margin-top:-1px; }
  .step .sr { font-size:11px; color:#8b93a7; white-space:nowrap; display:flex; gap:6px; align-items:center; }
  .step .sr a { color:#79b1ff; text-decoration:none; } .step .sr a:hover { text-decoration:underline; }
  .step .kids { grid-column:2/4; display:flex; flex-direction:column; border-left:1px solid #2f3442; padding-left:8px; margin:2px 0 2px; }
  .step .kids .step { grid-template-columns:14px 1fr auto; padding:1px 0; }
  .step .kids .si { width:12px; height:12px; font-size:8px; }
  .step .kids .sl { font-size:11.5px; color:#b8bfcc; }
  .badge { font-size:10.5px; font-weight:700; padding:1px 7px; border-radius:999px; background:#23262f; color:#9aa3b2; }
  .badge.good { background:rgba(46,160,67,.16); color:#56d364; }
  .badge.bad { background:rgba(229,72,77,.18); color:#ff8086; }
  .badge.warn { background:rgba(212,167,44,.18); color:#e8b84b; }
  .badge.info { background:rgba(59,130,246,.18); color:#79b1ff; }
  .timeline { list-style:none; margin:0; padding:0 0 0 14px; border-left:2px solid #2b3040; display:flex; flex-direction:column; gap:6px; }
  .timeline li { position:relative; font-size:12.5px; color:#c4ccdc; }
  .timeline li::before { content:''; position:absolute; left:-20px; top:6px; width:8px; height:8px; border-radius:50%; background:#3a4258; border:2px solid #0d0f15; }
  .timeline li:last-child::before { background:#79b1ff; }
  .todo { font-size:12.5px; color:#c4ccdc; display:flex; gap:7px; }
  .todo .tk { flex-shrink:0; width:14px; text-align:center; }
  .todo.completed { color:#6f778a; text-decoration:line-through; }
  .todo.in_progress { color:#e8b84b; }
  .dactions { position:relative; display:flex; flex-direction:column; gap:8px; margin-top:auto; padding-top:12px; border-top:1px solid #232634; }
  .dactions .arow { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
  .dactions .danger-zone { margin-left:auto; }
  .dempty { color:#6f778a; font-size:12.5px; }
  .wait { border:1px solid #232634; border-left:3px solid var(--waiting_on_user); border-radius:8px; padding:8px 11px; cursor:pointer; background:#141824; }
  .wait:hover { background:#1a2030; border-color:#3a4a63; }
  .wait .wt { font-weight:600; font-size:13px; }
  .wait .wm { color:#8b93a7; font-size:11.5px; margin-top:1px; }
  .wait .wx { color:#c4ccdc; font-size:12px; margin-top:4px; }
</style></head>
<body>
<header>
  <div class="topbar">
    <div class="brand">${LOGO_SVG}<h1>${APP_NAME}</h1><span class="sub" id="gen"></span></div>
    <div class="heatwrap"><span class="heatlbl" id="heatlbl">14d</span><div id="heatmap"></div></div>
    <div class="actions">
      <label for="default-agent" class="muted">Launch with</label>
      <select id="default-agent" aria-label="Default launch agent" title="which agent's action is highlighted as the default on every card">
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
        <option value="ask">Ask every time</option>
      </select>
      <button id="newbtn" class="open" title="start a new thread in an open pane (n)">＋ New thread</button>
      <button id="restorebtn" class="open" title="rebuild every loom-* tmux session from the last snapshot and open a Ghostty tab for each">⟲ Restore</button>
    </div>
  </div>
  <div class="row2">
  <div class="tabs" id="tabs"></div>
  <div class="controls">
    <input id="q" placeholder="filter title/overview/first message…"/>
    <select id="proj"></select>
    <select id="sort">
      <option value="recent">Most recent</option>
      <option value="active">Most active</option>
      <option value="long">Longest</option>
    </select>
  </div>
  </div>
  <div class="row3" id="row3">
    <div class="chips" id="chips"></div>
    <div class="seg" id="livetoggle" role="group" aria-label="Show live chats or all chats"></div>
  </div>
  <div class="deeplink" id="deep" title="search every chat on disk, including those older than the board"></div>
</header>
<div id="boardwrap">
<div id="col">
<main id="list"></main>
<section id="archive"></section>
</div>
<aside id="detail" aria-label="Selected chat"></aside>
</div>
<section id="em-section">
  <div class="emtop">
    <h2 class="emtitle">Recent activity</h2>
    <div class="emmodes" id="em-modes"></div>
  </div>
  <p class="emhint" id="em-hint"></p>
  <div id="em-feed" class="emfeed"></div>
</section>
<section id="trees-section">
  <div class="emtop">
    <h2 class="emtitle">Worktrees</h2>
    <div class="tmodes" id="tree-modes"></div>
  </div>
  <p class="emhint" id="tree-hint"></p>
  <div class="twrap" id="twrap">
    <div class="trail" id="tree-rail"></div>
    <div class="tdetail" id="tree-detail"></div>
  </div>
</section>
<div id="composer" hidden>
  <div class="cbox" role="dialog" aria-label="New thread">
    <div class="crow"><b>New thread</b><span class="spacer"></span><span class="dsub">⌘↵ launch · Esc close</span></div>
    <textarea id="cprompt" placeholder="What should it work on? Paste or drop screenshots here."></textarea>
    <div id="cthumbs"></div>
    <div class="crow">
      <label>Project <select id="cproj"></select></label>
      <label>Target <select id="ctarget"></select></label>
      <label>Agent <select id="cagent"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
      <label class="cchk"><input type="checkbox" id="cfocus"/> focus it</label>
    </div>
    <div class="crow"><span id="cmsg" class="dsub"></span><span class="spacer"></span><button id="ccancel">Cancel</button><button id="claunch" class="send">Launch ↵</button></div>
  </div>
</div>
<div id="overlay"></div>
<aside id="panel">
  <div class="phead">
    <div class="ptitle" id="ptitle"></div>
    <button id="pclose" title="close (Esc)">✕</button>
    <div class="pmeta" id="pmeta"></div>
  </div>
  <div class="pbody" id="ptranscript"></div>
  <div class="pfoot" id="pfoot"></div>
</aside>
<script>
const DATA = ${data};
const $ = (s,r=document)=>r.querySelector(s);
function rel(ms){const s=(Date.now()-ms)/1000;if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function spark(act){const days=[];const now=new Date();for(let i=13;i>=0;i--){const d=new Date(now);d.setDate(now.getDate()-i);const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');days.push(act[k]||0);}const max=Math.max(1,...days);const bars='▁▂▃▄▅▆▇█';return days.map(v=>bars[Math.min(7,Math.round(v/max*7))]).join('');}
// 14-day activity strip — matches the board's ~1-week data window (plus a few
// days of in-chat history) so the cells are actually populated, and mirrors the
// per-card spark-line's span. Shading scales to the busiest visible day.
const HEAT_DAYS=14;
function heat(){const map={};DATA.chats.forEach(c=>{for(const k in c.activity)map[k]=(map[k]||0)+c.activity[k];});const el=$('#heatmap');const now=new Date();const cells=[];for(let i=HEAT_DAYS-1;i>=0;i--){const d=new Date(now);d.setDate(now.getDate()-i);const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');cells.push({k,v:map[k]||0});}const max=Math.max(1,...cells.map(c=>c.v));$('#heatlbl').textContent=HEAT_DAYS+'d';el.innerHTML='';for(const {k,v} of cells){const cell=document.createElement('div');cell.className='hcell';cell.title=k+': '+v;if(v){const a=0.25+0.75*Math.min(1,v/max);cell.style.background='rgba(88,166,255,'+a+')';}el.appendChild(cell);}}
function projects(){const set=[...new Set(DATA.chats.map(c=>c.project))].sort();const sel=$('#proj');sel.innerHTML='<option value="">all projects</option>'+set.map(p=>'<option>'+p+'</option>').join('');}
function esc(s){return (s||'').replace(/[&<>"]/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));}
var stateFilter='all';
var liveOnly=true;
var tab='board'; // 'board' | 'saved'
const SLABEL={done:'Done',waiting_on_user:'Your turn',warning:'Caveats',error:'Error',pending:'Summarizing…'};
function st(c){return c.summary_pending?'pending':(c.state||'done');}
function agentLabel(agent){return agent==='codex'?'Codex':'Claude Code';}
function otherAgent(agent){return agent==='codex'?'claude':'codex';}
// Every card action names the agent it will launch, so nothing depends on the
// header preference to be unambiguous. The preference only decides which of the
// two gets the highlighted-default treatment ('ask' highlights neither).
function prefClass(agent){return DATA.defaultAgent===agent?' pref':'';}
function resumeLabel(sourceAgent){return '⏵ Resume '+agentLabel(sourceAgent);}
function startLabel(sourceAgent){return '⊕ Start with '+agentLabel(otherAgent(sourceAgent));}
// The pair of launch buttons shown on every stale card (board and archive alike).
// data-agent is the agent that will actually run; the server derives resume-vs-fresh
// from whether it matches the card's source agent.
function launchButtons(id,sourceAgent,proj){const p=proj?' data-proj="'+proj+'"':'';
return '<button class="resumebtn launchbtn'+prefClass(sourceAgent)+'" data-sid="'+id+'" data-agent="'+sourceAgent+'" data-action="resume"'+p+' title="continue this session in '+agentLabel(sourceAgent)+'">'+resumeLabel(sourceAgent)+'</button>'+
'<button class="startbtn launchbtn'+prefClass(otherAgent(sourceAgent))+'" data-sid="'+id+'" data-agent="'+otherAgent(sourceAgent)+'" data-action="resume"'+p+' title="start a fresh '+agentLabel(otherAgent(sourceAgent))+' session in this project (no context carried over)">'+startLabel(sourceAgent)+'</button>';}
function chatKey(c){return c.agent+':'+c.session_id;}
function isLive(c){return !!DATA.live[chatKey(c)];}
function isSaved(c){return !!c.saved;}
// Two views: the Board (unsaved chats, optionally live-only) and the Saved tab
// (the bookmark list). scoped() returns whichever the active tab is showing, so
// the filters/chips below operate on the right set.
function boardBase(){return (liveOnly?DATA.chats.filter(isLive):DATA.chats).filter(c=>!isSaved(c));}
function savedBase(){return DATA.chats.filter(isSaved);}
function scoped(){return tab==='saved'?savedBase():boardBase();}
function pcolor(p){let h=0;for(let i=0;i<p.length;i++)h=(h*31+p.charCodeAt(i))%360;return 'background:hsl('+h+',42%,20%);color:hsl('+h+',72%,76%)';}
// Segmented Board / Saved switch. Counts are totals (independent of the live
// filter) so they don't jump around as you toggle Live-only.
function renderTabs(){const nb=DATA.chats.filter(c=>!isSaved(c)).length;const ns=DATA.chats.filter(isSaved).length;const defs=[['board','▦ Board',nb,''],['saved','★ Saved',ns,' savedtab'],['em','⚙ EM',EM.findings.length,' emtab'],['trees','⑂ Trees',treeCount(),' treetab']];$('#tabs').innerHTML=defs.map(d=>'<button class="tab'+d[3]+(tab===d[0]?' on':'')+'" data-t="'+d[0]+'">'+d[1]+'<span class="cnt">'+d[2]+'</span></button>').join('');$('#tabs').querySelectorAll('.tab').forEach(el=>el.onclick=()=>{if(tab===el.dataset.t)return;tab=el.dataset.t;stateFilter='all';syncControls();liveToggle();chips();render();});}
// Live-only toggle is a Board concept; hide it on the Saved tab (saved chats are
// usually closed, so filtering them by "live" is meaningless).
// The EM tab shows the ledger, not chats, so every chat-scoped control goes away
// with it — leaving the project/sort pickers visible would imply they filter it.
// The EM and Trees tabs both show something other than chats, so every
// chat-scoped control goes away with either — leaving the project/sort pickers
// visible would imply they filter it.
function syncControls(){const em=tab==='em';const tr=tab==='trees';const other=em||tr;
  $('#livetoggle').style.display=(tab==='saved'||other)?'none':'';
  $('.controls').style.display=other?'none':'';
  $('#row3').style.display=other?'none':'';
  $('#deep').style.display=other?'none':'';
  $('#list').style.display=other?'none':'';
  $('#archive').style.display=other?'none':'';
  $('#boardwrap').style.display=other?'none':'';
  // 'block', NOT '': the stylesheet defaults #em-section to display:none, and
  // clearing the inline style just lets that rule win again — the tab renders
  // its rows into a section that is still hidden.
  $('#em-section').style.display=em?'block':'none';
  $('#trees-section').style.display=tr?'block':'none';}
function liveToggle(){const board=DATA.chats.filter(c=>!isSaved(c));const nLive=board.filter(isLive).length;const nAll=board.length;const t=$('#livetoggle');t.innerHTML='<button data-live="1" class="'+(liveOnly?'on':'')+'" title="only chats running in a pane">● Live '+nLive+'</button><button data-live="0" class="'+(liveOnly?'':'on')+'" title="every chat on the board">All '+nAll+'</button>';t.querySelectorAll('button').forEach(b=>b.onclick=()=>{liveOnly=b.dataset.live==='1';liveToggle();chips();render();});}
function isWorking(c){const L=DATA.live[chatKey(c)];return !!(L&&L.working);}
function chips(){const base=scoped();const ct={all:base.length,working:0,waiting_on_user:0,drafts:0,issues:0,done:0};base.forEach(c=>{if(isWorking(c))ct.working++;ct.drafts+=draftsFor(c).length;const s=st(c);if(s==='waiting_on_user')ct.waiting_on_user++;else if(s==='warning'||s==='error')ct.issues++;else if(s==='done')ct.done++;});const defs=[['all','All',''],['working','⚡ Working','var(--warning)'],['waiting_on_user','Your turn','var(--waiting_on_user)'],['drafts','✉ Drafts','#e8a6e0'],['issues','Issues','var(--error)'],['done','Done','var(--done)']];$('#chips').innerHTML=defs.map(d=>'<span class="chip'+(stateFilter===d[0]?' on':'')+'" data-f="'+d[0]+'">'+(d[2]&&d[0]!=='working'?'<span class="dot" style="background:'+d[2]+'"></span>':'')+d[1]+' '+ct[d[0]]+'</span>').join('');$('#chips').querySelectorAll('.chip').forEach(el=>el.onclick=()=>{stateFilter=el.dataset.f;chips();render();});}
function matchFilter(c){if(stateFilter==='all')return true;if(stateFilter==='working')return isWorking(c);if(stateFilter==='drafts')return hasDrafts(c);const s=st(c);if(stateFilter==='issues')return s==='warning'||s==='error';return s===stateFilter;}
function render(){renderTabs();syncControls();if(tab==='em'){renderEm(EM);return;}if(tab==='trees'){renderTrees();return;}const q=$('#q').value.toLowerCase();const proj=$('#proj').value;const sort=$('#sort').value;
// On the Saved tab "Most recent" means most-recently-saved; elsewhere, last active.
const rec=(a,b)=>tab==='saved'?(b.saved_at-a.saved_at):(b.last_active_at-a.last_active_at);
let rows=(shipFilter!==null&&tab==='board'?DATA.chats.filter(inShipFilter):scoped()).filter(c=>matchFilter(c)&&(!proj||c.project===proj)&&(!q||(c.title+' '+c.overview+' '+c.first_message).toLowerCase().includes(q)));rows.sort((a,b)=>{const wa=isWorking(a)?1:0,wb=isWorking(b)?1:0;if(wa!==wb)return wb-wa;const la=DATA.live[chatKey(a)]?1:0,lb=DATA.live[chatKey(b)]?1:0;if(la!==lb)return lb-la;return sort==='active'?(sum(b.activity)-sum(a.activity)): sort==='long'?(b.message_count-a.message_count):rec(a,b);});const list=$('#list');const empty=tab==='saved'?'<p class="meta">Nothing saved yet — hit <b>☆ save</b> on any chat to bookmark it here. Saved chats stay put no matter how long they sit, and saving a live one frees its pane.</p>':(liveOnly&&boardBase().length===0?'<p class="meta">No live sessions detected yet — send a prompt in a chat to register it, or switch to <b>All</b>.</p>':'<p class="meta">no matches</p>');list.innerHTML=shipStrip()+((ghostCards()+rows.map(card).join(''))||empty);list.querySelectorAll('.card').forEach(wireCard);wireShips(list);renderDetail();}
// Shared by board and archive cards. Archive cards carry data-jsonl/data-proj
// (they have no DB row, so the server needs those passed back to it).
function wireCard(el){const sourceAgent=el.dataset.agent||'claude';el.onclick=(e)=>{if(e.target.closest('button,code,.picker,a'))return;
// Board cards select into the detail panel; archive cards (no DB row) and a
// window too narrow for the panel keep the transcript drawer.
if(!el.dataset.jsonl&&detailShown()){selectChat(el.dataset.sid,sourceAgent);return;}openChat(el.dataset.sid,sourceAgent,el.dataset.jsonl?{jsonl:el.dataset.jsonl,proj:el.dataset.proj||'',title:el.dataset.title||''}:null);};const exp=el.querySelector('.expand');if(exp)exp.onclick=()=>el.classList.toggle('open');const cp=el.querySelector('.copy');if(cp)cp.onclick=()=>copyId(cp);const op=el.querySelector('.open');if(op)op.onclick=()=>jump(op.dataset.jump,sourceAgent,el);el.querySelectorAll('.launchbtn').forEach(b=>b.onclick=()=>openPicker(b.dataset.sid,sourceAgent,el,b.dataset.action,b.dataset.proj||'',b.dataset.agent));const cb=el.querySelector('.closebtn');if(cb)cb.onclick=()=>confirmClose(cb,sourceAgent,el);const sv=el.querySelector('.savebtn');if(sv)sv.onclick=()=>doSave(sv.dataset.sid,sourceAgent,el);const us=el.querySelector('.unsavebtn');if(us)us.onclick=()=>doUnsave(us.dataset.sid,sourceAgent,el);}
function doSave(sid,agent,el){flash(el,'saving…','#7a6a1a');fetch('/save?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent)).then(r=>r.json()).then(j=>{flash(el,j.ok?(j.closed?'saved — pane freed ✓':'saved ✓'):(j.detail||'failed'),j.ok?'#7a6a1a':'#8a2b2e');setTimeout(refresh,1200);setTimeout(refresh,3200);}).catch(()=>flash(el,'server off','#8a2b2e'));}
function doUnsave(sid,agent,el){flash(el,'removing…','#7a6a1a');fetch('/unsave?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent)).then(r=>r.json()).then(j=>{flash(el,j.ok?'unsaved ✓':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');setTimeout(refresh,1200);setTimeout(refresh,3200);}).catch(()=>flash(el,'server off','#8a2b2e'));}
function confirmClose(b,agent,el){if(b.dataset.armed){doClose(b.dataset.sid,agent,el);}else{b.dataset.armed='1';b.textContent='✕ confirm?';b.classList.add('arm');setTimeout(()=>{if(b){b.dataset.armed='';b.textContent='✕ close';b.classList.remove('arm');}},2500);}}
function doClose(sid,agent,el){flash(el,'closing…','#7a4a1a');fetch('/close?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent),{method:'POST'}).then(r=>r.json()).then(j=>{flash(el,j.ok?'closed — pane freed ✓':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');setTimeout(refresh,1500);setTimeout(refresh,3500);}).catch(()=>flash(el,'server off','#8a2b2e'));}
function jump(sid,agent,el){flash(el,'opening…','#3b5bdb');fetch('/goto?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent)).then(r=>r.json()).then(j=>flash(el,j.ok?'opened ✓':'no live pane',j.ok?'#1f6f3f':'#8a2b2e')).catch(()=>flash(el,'server off','#8a2b2e'));}
// One picker per card, so it keys on action+agent: clicking the same button again
// closes it, clicking the sibling swaps to that button's launch.
function launchVerb(action,sourceAgent,selectedAgent){return action==='branch'?('Branch '+agentLabel(selectedAgent)):(selectedAgent===sourceAgent?resumeLabel(sourceAgent).slice(2):startLabel(sourceAgent).slice(2));}
function openPicker(sid,sourceAgent,el,action,proj,selectedAgent){const p=el.querySelector('.picker');const key=action+':'+selectedAgent;if(p.dataset.open===key){p.dataset.open='';p.innerHTML='';return;}p.dataset.open=key;const verb=launchVerb(action,sourceAgent,selectedAgent);p.innerHTML='<span class="muted">finding an open pane…</span>';fetch('/api/lanes').then(r=>r.json()).then(lanes=>{if(!lanes.length){p.innerHTML='<span class="muted">No empty panes found. Open a new pane/window in tmux, then click '+esc(verb)+' again.</span>';return;}
// One lane is the whole choice, so skip the picker. The server re-resolves the
// lane's next open pane at launch time, so these rows are a menu, not a claim.
if(lanes.length===1){doLaunch(sid,sourceAgent,lanes[0].lane,el,p,action,proj,selectedAgent);return;}p.innerHTML='<div class="pickhdr">'+esc(verb)+' into which lane?</div>'+lanes.map(ln=>'<button class="paneopt" data-lane="'+esc(ln.lane)+'">'+esc(ln.lane)+' → '+esc(ln.where)+(ln.name?'<span class="pcwd">'+esc(ln.name)+'</span>':'')+'</button>').join('');p.querySelectorAll('.paneopt').forEach(b=>b.onclick=()=>doLaunch(sid,sourceAgent,b.dataset.lane,el,p,action,proj,selectedAgent));}).catch(()=>p.innerHTML='<span class="muted">server off?</span>');}
// proj is sent only for archive chats — the server resolves board chats from its DB.
function doLaunch(sid,sourceAgent,lane,el,p,action,proj,selectedAgent){const busy=action==='branch'?'branching…':(sourceAgent===selectedAgent?'resuming…':'starting new…');const okmsg=action==='branch'?'branched ✓':(sourceAgent===selectedAgent?'resumed ✓':'started fresh ✓');p.innerHTML='<span class="muted">'+busy+'</span>';fetch('/'+action+'?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(selectedAgent)+'&lane='+encodeURIComponent(lane)+(proj?'&proj='+encodeURIComponent(proj):''),{method:'POST'}).then(r=>r.json()).then(j=>{flash(el,j.ok?okmsg:(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');p.dataset.open='';p.innerHTML='';setTimeout(refresh,1500);setTimeout(refresh,3500);}).catch(()=>{p.innerHTML='<span class="muted">server off?</span>';});}
function flash(el,msg,bg){let f=el.querySelector('.flash');if(!f){f=document.createElement('span');f.className='flash';el.appendChild(f);}f.textContent=msg;f.style.background=bg;clearTimeout(f._t);f._t=setTimeout(()=>f.remove(),1400);}
function copyId(b){navigator.clipboard.writeText(b.dataset.id).then(()=>{const o=b.textContent;b.textContent='copied ✓';b.classList.add('ok');setTimeout(()=>{b.textContent=o;b.classList.remove('ok');},1200);}).catch(()=>{b.textContent='copy failed';setTimeout(()=>{b.textContent='copy id';},1200);});}
function sum(o){return Object.values(o).reduce((a,b)=>a+b,0);}
function disp(c){const t=c.title||c.first_message||'Untitled';return t.length>90?t.slice(0,90)+'…':t;}
function liveTag(c){const L=DATA.live[chatKey(c)];if(!L)return '<span class="stale">○ no active pane</span>';const loc=esc(L.tmux_session)+' · pane '+L.pane_index;if(L.working)return '<span class="working"><span class="pin">⚡</span> working · '+loc+'</span>';return '<span class="live"><span class="pin">●</span> live · '+loc+(L.running?'':' (idle)')+'</span>';}
function ownsSlack(c){return (DATA.slackOwners||[]).indexOf(c.session_id)>=0;}
// ---- Ship groups ---------------------------------------------------------------
// Which chats ride the next /ship on a shared main checkout (staged = done and
// riding, unstaged = still in progress), who holds the ship lock, and which
// recent ship/ PRs each chat rode. Attribution is by each chat's own edits.
var shipFilter=null;const NL=String.fromCharCode(10); // null | 'next' | a ship PR number
function shipSig(){return (DATA.ships||[]).map(b=>b.next.chats.map(c=>c.key+c.staged+'/'+c.unstaged).join(',')+'|'+b.next.unattributed.length+'|'+(b.lock?b.lock.sessionId+b.lock.stale:'')+'|'+b.shipped.map(s=>s.number+s.state+s.members.length).join(',')).join(';')+'|'+shipFilter;}
function shipRole(c){for(const b of DATA.ships||[]){const r=b.byChat[chatKey(c)];if(r)return {b,r};}return null;}
function shipPipe(b,n){return (DATA.pipes||{})[b.slug+'#'+n]||null;}
function inShipFilter(c){const x=shipRole(c);if(shipFilter==='next')return !!(x&&x.r.next)||(DATA.ships||[]).some(b=>b.lock&&b.lock.holderKey===chatKey(c));return !!(x&&x.r.ships.indexOf(shipFilter)>=0);}
function chatByKey(k){const i=k.indexOf(':');const a=k.slice(0,i),sid=k.slice(i+1);return DATA.chats.find(c=>c.agent===a&&c.session_id===sid)||null;}
function chatName(k){const c=chatByKey(k);if(!c)return k.slice(k.indexOf(':')+1,k.indexOf(':')+9);const L=DATA.live[k];return (L&&L.name?'@'+L.name+' · ':'')+disp(c);}
function shipCardChips(c){const x=shipRole(c);if(!x)return '';const {b,r}=x;let h='';
  if(r.next){const ready=r.next==='staged';h+='<button class="shipchip next'+(ready?' ready':'')+(shipFilter==='next'?' on':'')+'" data-shipf="next" title="'+(ready?'staged: rides the next ship':r.next==='both'?'some staged, some still in progress':'changed on main, not staged yet: won’t ride')+'">next ship'+(ready?' ✓':' …')+'</button>';}
  if(r.ships.length){const n=r.ships[0];const own=(DATA.chatPr||{})[chatKey(c)]===b.slug+'#'+n;h+='<button class="shipchip'+(shipFilter===n?' on':'')+'" data-shipf="'+n+'" title="rode ship #'+n+(r.ships.length>1?' (and '+(r.ships.length-1)+' earlier)':'')+' — click to show its chats">ship #'+n+'</button>'+(own?'':dotsHtml(shipPipe(b,n)));}
  return h;}
function lockHtml(b){const l=b.lock;if(!l)return '';const who=l.holderKey?chatName(l.holderKey):(l.sessionId.slice(0,8)||'unknown');
  return '<span class="shiplock'+(l.stale?' stale':'')+'" title="ship lock'+(l.stale?' (stale, >5 min old — the next acquire takes it)':'')+'">⚓ '+(l.stale?'stale lock: ':'shipping now: ')+esc(who)+(l.pane?' · '+esc(l.pane):'')+(l.batch.length?' · '+l.batch.length+' files':'')+'</span>';}
function shipStrip(){if(tab!=='board')return '';const bs=(DATA.ships||[]).filter(b=>b.next.chats.length||b.next.unattributed.length||b.lock);
  let h=bs.map(b=>{const n=b.next;const ready=n.chats.filter(c=>c.staged);const wip=n.chats.filter(c=>c.unstaged);
    return '<div class="shipstrip"><div class="sh"><b>⛵ Next ship</b><span class="dsub">'+esc(b.repo.split('/').pop())+(b.onMain?'':' (not on main)')+'</span>'+
      '<span>'+n.staged+' staged</span><span>· '+n.unstaged+' unstaged</span>'+(n.unattributed.length?'<span title="'+esc(n.unattributed.map(f=>f.state+' '+f.path).join(NL))+'">· '+n.unattributed.length+' unattributed</span>':'')+
      (n.shared.length?'<span class="wip" title="'+esc(n.shared.join(NL))+'">· ⚠ '+n.shared.length+' edited by two chats</span>':'')+
      lockHtml(b)+'<span class="spacer"></span><button class="shipchip next'+(shipFilter==='next'?' on':'')+'" data-shipf="next">'+(shipFilter==='next'?'showing these ✕':'show these chats')+'</button></div>'+
      '<div class="shc">'+n.chats.map(c=>'<span class="shipmate" data-key="'+esc(c.key)+'" title="'+esc(c.files.map(f=>f.state+' '+f.path+(f.shared?' (shared)':'')).join(NL))+'">'+esc(chatName(c.key))+' '+(c.staged?'<span class="ok">'+c.staged+'✓</span> ':'')+(c.unstaged?'<span class="wip">'+c.unstaged+'…</span>':'')+'</span>').join('')+'</div></div>';}).join('');
  if(typeof shipFilter==='number')h='<div class="shipstrip"><div class="sh"><b>Showing ship #'+shipFilter+'</b><span class="dsub">its chats, live or not</span><span class="spacer"></span><button class="shipchip on" data-shipf="'+shipFilter+'">clear ✕</button></div></div>'+h;
  return h;}
function setShipFilter(v){shipFilter=(shipFilter===v)?null:v;render();}
function wireShips(root){root.querySelectorAll('[data-shipf]').forEach(el=>el.onclick=(e)=>{e.stopPropagation();const v=el.dataset.shipf;setShipFilter(v==='next'?'next':Number(v));});
  root.querySelectorAll('.shipmate[data-key]').forEach(el=>el.onclick=()=>{const k=el.dataset.key;const i=k.indexOf(':');selectChat(k.slice(i+1),k.slice(0,i));});}
function shipFilesHtml(files){return '<div class="shipfiles">'+files.slice(0,40).map(f=>'<div class="sf"><span class="fst '+(f.state==='staged'?'staged':f.state==='untracked'?'untracked':'uncommitted')+'">'+esc(f.state)+'</span><span class="fp">&lrm;'+esc(f.path)+'</span>'+(f.shared?'<span class="badge warn">shared</span>':'')+'</div>').join('')+(files.length>40?'<div class="dsub">+'+(files.length-40)+' more</div>':'')+'</div>';}
function shipSectionHtml(d,c){const s=d.ship;if(!s)return '';let h='';
  if(s.lock&&s.lock.holderKey===chatKey(c))h+='<div class="drow">'+lockHtml({lock:s.lock})+'</div>';
  if(s.next){const n=s.next;h+='<div class="drow"><b>Next ship</b><span class="badge '+(n.staged&&!n.unstaged?'good':'warn')+'">'+(n.unstaged?(n.staged?n.staged+' staged · '+n.unstaged+' in progress':'in progress — not staged'):'staged — will ride')+'</span></div>'+shipFilesHtml(n.files)+
    (n.fellows.length?'<div class="dsub">riding with: '+n.fellows.map(f=>esc(chatName(f.key))+' ('+f.staged+'✓'+(f.unstaged?' '+f.unstaged+'…':'')+')').join(', ')+'</div>':'')+(s.lock&&s.lock.holderKey!==chatKey(c)?'<div class="drow">'+lockHtml({lock:s.lock})+'</div>':'');}
  if(s.shipped){const x=s.shipped;h+='<div class="prline" style="margin-top:6px"><a href="'+esc(x.url)+'" target="_blank" rel="noopener">ship #'+x.number+'</a><span>'+esc(x.title)+'</span></div>'+
    '<div class="dsub">'+esc(x.branch)+' · '+x.files+' files'+(x.runner?' · shipped by '+esc(x.runner===chatKey(c)?'this chat':chatName(x.runner)):'')+'</div>'+
    (x.members.length>1?'<div class="dsub">rode with: '+x.members.filter(k=>k!==chatKey(c)).map(k=>esc(chatName(k))).join(', ')+'</div>':'')+
    (x.pipeline?'<div class="stepper">'+x.pipeline.steps.map(st=>stepHtml(st,true,x.pipeline.repo+'#'+x.pipeline.number)).join('')+'</div>':'<div class="dempty">fetching the ship’s pipeline…</div>')+
    (s.others.length?'<div class="dsub">also rode: '+s.others.map(n=>'#'+n).join(', ')+'</div>':'');}
  return '<div class="dsec"><h3>Ship</h3>'+h+'</div>';}
// ---- PR pipelines -------------------------------------------------------------
// checks → review → merged → deploy → done. The board gets a dot per step from
// /api/data (served from the server's cache); the panel gets the full stepper
// from /api/detail. Transitions (checks red, review back, deployed) become a
// badge on the card until the chat is selected.
function pipeSig(){const p=DATA.pipes||{};return Object.keys(p).sort().map(k=>k+':'+p[k].dots.map(d=>d.state.charAt(0)).join('')+':'+p[k].events.length).join(',')+'|'+Object.keys(DATA.chatPr||{}).length+'|'+JSON.stringify(PIPE_ACK);}
var PIPE_ACK={};try{PIPE_ACK=JSON.parse(localStorage.getItem('loom.pipeAck')||'{}')||{};}catch(e){PIPE_ACK={};}
function pipeOf(c){const k=(DATA.chatPr||{})[chatKey(c)];return k?(DATA.pipes||{})[k]||null:null;}
function ackPipe(c){const k=(DATA.chatPr||{})[chatKey(c)];if(!k)return;PIPE_ACK[k]=Date.now();try{localStorage.setItem('loom.pipeAck',JSON.stringify(PIPE_ACK));}catch(e){}}
const PIPE_EVENT_MS=6*3600000;
function pipeEvent(c){const p=pipeOf(c);if(!p||!p.events.length)return null;const k=DATA.chatPr[chatKey(c)];const e=p.events[p.events.length-1];if(Date.now()-e.at>PIPE_EVENT_MS||(PIPE_ACK[k]||0)>=e.at)return null;return e;}
function dotsHtml(p){if(!p)return '';return '<span class="pdots" title="'+esc(p.dots.map(d=>d.label+': '+d.state+(d.detail?' ('+d.detail+')':'')).join(' · '))+'">'+p.dots.map(d=>'<span class="pd '+esc(d.state)+'"></span>').join('')+'</span>';}
function pipeCard(c){const p=pipeOf(c);const e=pipeEvent(c);return dotsHtml(p)+(e?'<span class="pev '+esc(e.tone)+'">'+esc(e.text)+'</span>':'');}
const STEP_ICON={pass:'✓',fail:'✕',running:'◐',waiting:'',skipped:'–'};
var STEP_OPEN={};
function fmtDur(ms){if(!(ms>0))return '';const s=Math.round(ms/1000);if(s<60)return s+'s';const m=Math.floor(s/60);if(m<60)return m+'m '+(s%60)+'s';return Math.floor(m/60)+'h '+(m%60)+'m';}
function stepDur(s){if(!s.startedAt)return s.completedAt&&s.key==='merged'?rel(s.completedAt):'';if(s.state==='running'||s.state==='waiting')return s.state==='running'?fmtDur(Date.now()-s.startedAt)+'…':'';return s.completedAt?fmtDur(s.completedAt-s.startedAt):'';}
function stepHtml(s,top,pkey){const kids=s.children||[];const id=pkey+'|'+s.key;
  // Open by default: whatever is red or moving, so the panel lands on the interesting part.
  const open=id in STEP_OPEN?STEP_OPEN[id]:(top&&kids.length>0&&(s.state==='fail'||s.state==='running'));
  const fails=kids.filter(k=>k.state==='fail').length;
  return '<div class="step '+esc(s.state)+(top?' top':'')+'"><span class="si">'+(STEP_ICON[s.state]||'')+'</span>'+
    '<span class="sl'+(kids.length?' tog':'')+'"'+(kids.length?' data-step="'+esc(id)+'"':'')+' title="'+esc(s.label)+'">'+(kids.length?(open?'▾ ':'▸ '):'')+esc(s.label)+(kids.length&&!open?' <span class="dsub">'+kids.length+(fails?' · '+fails+' failed':'')+'</span>':'')+'</span>'+
    '<span class="sr">'+esc(stepDur(s))+(s.url?'<a href="'+esc(s.url)+'" target="_blank" rel="noopener">↗</a>':'')+'</span>'+
    (s.detail?'<span class="sd">'+esc(s.detail)+'</span>':'')+
    (open&&kids.length?'<div class="kids">'+kids.map(k=>stepHtml(k,false,pkey)).join('')+'</div>':'')+'</div>';}
function pipelineHtml(d){const p=d.pipeline;if(!p)return d.pipelineRef?'<div class="dempty">fetching the pipeline…</div>':'';
  return '<div class="stepper">'+p.steps.map(s=>stepHtml(s,true,p.repo+'#'+p.number)).join('')+'</div>'+
    '<div class="dsub">updated '+rel(p.fetchedAt)+(p.inFlight?' · refreshing every 20s while live':'')+'</div>';}
function wireSteps(box){box.querySelectorAll('[data-step]').forEach(el=>el.onclick=()=>{const id=el.dataset.step;const isOpen=el.textContent.charAt(0)==='▾';STEP_OPEN[id]=!isOpen;renderDetail();});}
// Cards are deliberately light: title line (with open-in-Ghostty and save as
// icons), meta line, summary. Everything else — session id, moments, PR detail,
// resume/branch/close — lives in the detail panel for the selected card.
function card(c){const s=st(c);const L=DATA.live[chatKey(c)];const W=!!(L&&L.working);const id=esc(c.session_id);const agent=esc(c.agent);const pru=c.pr_url||(((DATA.chatPr||{})[chatKey(c)]||'').split('#')[1]?'https://github.com/'+DATA.chatPr[chatKey(c)].replace('#','/pull/'):'');const prn=pru?(pru.split('/pull/')[1]||'').replace(/[^0-9]/g,''):'';const pr=prn?' · <span class="prn" title="'+esc(pru)+'">PR #'+esc(prn)+'</span>':'';const sav=c.saved?'<button class="ico unsavebtn" data-sid="'+id+'" title="remove from Saved for later">★</button>':'<button class="ico savebtn" data-sid="'+id+'" title="'+(L?'save for later &amp; close this pane':'save for later')+'">☆</button>';const open=L?'<button class="ico open" data-jump="'+id+'" title="open in Ghostty">↗</button>':'';return '<div class="card s-'+s+(W?' work':'')+(c.saved?' saved':'')+(sel&&sel.sid===c.session_id&&sel.agent===c.agent?' sel':'')+'" data-sid="'+id+'" data-agent="'+agent+'">'+(W?'<div class="sweep"></div>':'')+
'<div class="chead"><h2>'+esc(disp(c))+'</h2><span class="pill source">'+agentLabel(c.agent)+'</span><span class="pill '+s+'">'+SLABEL[s]+'</span>'+open+sav+'</div>'+
'<div class="meta"><span class="ptag" style="'+pcolor(c.project)+'">'+esc(c.project)+'</span>'+c.message_count+' msgs · <span class="spark">'+spark(c.activity)+'</span> '+rel(c.last_active_at)+' · '+liveTag(c)+pr+pipeCard(c)+shipCardChips(c)+(ownsSlack(c)?' · <span class="slk" title="owns a Slack thread">#</span>':'')+(hasDrafts(c)?' · <span class="dft" title="Slack draft awaiting your okay">✉ '+draftsFor(c).length+'</span>':'')+'</div>'+
(c.summary_pending?'<div class="pending-note">indexed, summarizing…</div>':'<div class="ov">'+esc(c.overview)+'</div>')+
'</div>';}
$('#gen').textContent='· '+DATA.chats.length+' chats · '+new Date(DATA.generatedAt).toLocaleString();
var panelSid=null, panelAgent='claude', ptimer=null, panelArch=null;
// arch = {jsonl,proj,title} for archive chats (no DB row, so the server needs them).
function openChat(sid,agent,arch){panelSid=sid;panelAgent=agent;panelArch=arch||null;$('#panel').classList.add('on');$('#overlay').classList.add('on');$('#ptranscript').innerHTML='<p class="muted">loading…</p>';$('#pfoot').innerHTML='';loadTranscript(true);clearInterval(ptimer);
// An archive chat isn't running, so its transcript can't change — don't poll it.
if(!panelArch)ptimer=setInterval(()=>loadTranscript(false),1500);}
function closeChat(){panelSid=null;panelAgent='claude';panelArch=null;$('#panel').classList.remove('on');$('#overlay').classList.remove('on');clearInterval(ptimer);}
function loadTranscript(toBottom){if(!panelSid)return;const req=panelSid;var u='/api/transcript?session='+encodeURIComponent(req)+'&agent='+encodeURIComponent(panelAgent);if(panelArch)u+='&jsonl='+encodeURIComponent(panelArch.jsonl)+'&proj='+encodeURIComponent(panelArch.proj)+'&title='+encodeURIComponent(panelArch.title);fetch(u).then(r=>r.json()).then(d=>{if(panelSid!==req||!d.ok)return;$('#ptitle').textContent=d.title||'(untitled)';$('#pmeta').innerHTML=esc(d.project)+' · <span class="pill source">'+agentLabel(d.agent)+'</span> · '+(d.live?'<span class="live">● live</span>':'<span class="stale">○ stale</span>');const body=$('#ptranscript');const atBottom=body.scrollTop+body.clientHeight>=body.scrollHeight-50;body.innerHTML=d.messages.map(m=>'<div class="msg '+m.role+'"><div class="who">'+(m.role==='user'?'You':agentLabel(d.agent))+'</div>'+esc(m.text)+'</div>').join('')||'<p class="muted">no messages yet</p>';if(toBottom||atBottom)body.scrollTop=body.scrollHeight;renderFoot(d);}).catch(()=>{});}
function renderFoot(d){const f=$('#pfoot');if(d.live){if(!f.querySelector('textarea')){f.innerHTML='<textarea id="pinput" placeholder="message this chat… (Enter to send, Shift+Enter for newline)"></textarea><div class="sendrow"><span class="grow">types straight into the live '+agentLabel(d.agent)+' pane</span><button class="send" id="psend">Send ↵</button></div>';$('#psend').onclick=sendMsg;$('#pinput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});}}else{f.innerHTML='<div class="stalefoot">This chat isn\\'t running — <b>'+esc(resumeLabel(d.agent).slice(2))+'</b> from its card to send messages.</div>';}}
function sendMsg(){const ta=$('#pinput');if(!ta||!panelSid)return;const t=ta.value.trim();if(!t)return;ta.value='';fetch('/send?session='+encodeURIComponent(panelSid)+'&agent='+encodeURIComponent(panelAgent)+'&text='+encodeURIComponent(t),{method:'POST'}).then(r=>r.json()).then(()=>{setTimeout(()=>loadTranscript(true),500);setTimeout(()=>loadTranscript(true),2500);}).catch(()=>{});}
$('#pclose').onclick=closeChat;$('#overlay').onclick=closeChat;
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(panelSid)closeChat();else if(sel)deselect();});
var lastRenderAt=0;
function dataSig(){return DATA.defaultAgent+'##'+DATA.chats.map(c=>chatKey(c)+':'+(c.state||'')+':'+(c.summary_pending?'p':'')+':'+(c.saved?'s':'')).sort().join('|')+'##'+Object.keys(DATA.live).sort().map(k=>k+(DATA.live[k].working?'⚡':'')).join(',')+'##'+(DATA.slackOwners||[]).slice().sort().join(',')+'##'+(DATA.drafts||[]).map(x=>x.id).join(',')+'##'+(DATA.launches||[]).map(x=>x.id).join(',')+'##'+pipeSig()+'##'+shipSig();}
function syncDefaultAgent(){$('#default-agent').value=DATA.defaultAgent;}
function refresh(){fetch('/api/data').then(r=>r.json()).then(d=>{const before=dataSig();DATA.chats=d.chats;DATA.live=d.live;DATA.defaultAgent=d.defaultAgent;DATA.slackOwners=d.slackOwners||[];DATA.drafts=d.drafts||[];DATA.launches=d.launches||[];DATA.pipes=d.pipes||{};DATA.chatPr=d.chatPr||{};DATA.ships=d.ships||[];if(panelSid)loadTranscript(false);if(document.querySelector('.picker:not(:empty)')||document.querySelector('.card.open'))return;if(dataSig()!==before||Date.now()-lastRenderAt>30000){liveToggle();chips();render();lastRenderAt=Date.now();}}).catch(()=>{});}
function updateDefaultAgent(){const select=$('#default-agent');const agent=select.value;select.disabled=true;fetch('/api/settings/default-agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agent})}).then(r=>r.json()).then(j=>{if(j.ok){DATA.defaultAgent=j.defaultAgent;render();}else{syncDefaultAgent();}}).catch(syncDefaultAgent).finally(()=>{select.disabled=false;});}
function restoreWorkspace(){const b=$('#restorebtn');const orig=b.textContent;b.disabled=true;b.textContent='⟲ restoring…';fetch('/restore').then(r=>r.json()).then(j=>{const n=(j.restored||[]).length;b.textContent=j.ok?(n?'✓ restored '+n+' tab(s)':'✓ nothing to restore'):'✕ '+(j.detail||'failed');setTimeout(refresh,1500);}).catch(()=>{b.textContent='✕ server off';}).finally(()=>{setTimeout(()=>{b.disabled=false;b.textContent=orig;},2600);});}
$('#restorebtn').onclick=restoreWorkspace;
// ── Archive search ────────────────────────────────────────────────────────────
// #q filters the board client-side. This searches every chat on disk via find-chat
// (/api/search) and renders what the 7-day board can't show. Click/Enter only —
// never per-keystroke, since each search spawns a subprocess.
var archHits=[], archQuery='', archState='idle', archErr='';
function updateDeep(){const q=$('#q').value.trim();const d=$('#deep');if(!q){d.style.display='none';return;}d.style.display='block';d.textContent='⤷ Search all history for "'+q+'"';}
function runArchive(){const q=$('#q').value.trim();if(!q)return;archQuery=q;archState='searching';archErr='';renderArchive();fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json()).then(j=>{if(archQuery!==q)return;if(j.ok){archHits=j.results||[];archState='results';}else{archErr=j.detail||'search failed';archState='error';}renderArchive();}).catch(()=>{if(archQuery!==q)return;archErr='server off?';archState='error';renderArchive();});}
function adisp(h){const t=(h.title||h.snippet||'Untitled').trim();return t.length>90?t.slice(0,90)+'…':t;}
function acard(h){const id=esc(h.session_id);const proj=esc(h.project_dir);const pname=h.project_dir.split('/').filter(Boolean).pop()||'unknown';
// Most chats have no custom title, so the heading already IS the snippet — don't print it twice.
const hasTitle=!!(h.title&&h.title.trim());
// Resuming needs the original cwd; a few old rows were indexed without one.
const canLaunch=!!(h.project_dir&&h.project_dir.trim());
return '<div class="card arch" data-sid="'+id+'" data-agent="claude" data-jsonl="'+esc(h.jsonl_path)+'" data-proj="'+proj+'" data-title="'+esc(h.title||'')+'">'+
'<div class="chead"><h2>'+esc(adisp(h))+'</h2><span class="pill source">Claude Code</span><span class="pill arch">archive</span></div>'+
'<div class="meta"><span class="ptag" style="'+pcolor(pname)+'">'+esc(pname)+'</span>'+h.message_count+' msgs · '+rel(h.ended_at)+'</div>'+
(hasTitle?'<div class="ov snip">'+esc(h.snippet)+'</div>':'')+
'<div class="resume"><code class="sid" title="session id">'+id+'</code><button class="copy" data-id="'+id+'">copy id</button><span class="spacer"></span>'+
(canLaunch?launchButtons(id,'claude',proj)+
'<button class="branchbtn launchbtn" data-sid="'+id+'" data-agent="claude" data-action="branch" data-proj="'+proj+'" title="fork this conversation into a new pane (original left untouched)">⑃ branch…</button>'
:'<span class="muted">no project dir recorded — can\\'t resume</span>')+
'</div><div class="picker"></div></div>';}
function renderArchive(){const box=$('#archive');if(archState==='idle'){box.innerHTML='';return;}const hd='<div class="ahead">From your archive</div>';if(archState==='searching'){box.innerHTML=hd+'<p class="muted">searching all history…</p>';return;}if(archState==='error'){box.innerHTML=hd+'<p class="muted">'+esc(archErr)+'</p>';return;}if(!archHits.length){box.innerHTML=hd+'<p class="muted">no archive matches for "'+esc(archQuery)+'" — chats already on the board above are excluded</p>';return;}box.innerHTML=hd+archHits.map(acard).join('');box.querySelectorAll('.card').forEach(wireCard);}
// EM activity feed. Every action the EM took OR would have taken, grouped under
// the finding that triggered it. In shadow mode every row reads "would".
// Plain-English gloss per detector, so the feed does not require knowing the
// codebase to read.
const EM_WHY={BLOCKED:'waiting on an answer',WRAPPABLE:'finished, pane still held',BLOATED:'near its context limit',
  STALLED:'idle mid-task',SPINNING:'lots of talk, no artifacts',DRIFTING:'off the original ask',CONVERGING:'colliding with another session'};
// What the EM is waiting for, when it has not acted yet.
const EM_STATUS={new:'awaiting triage (runs every 5m)',triaged:'triaged',acted:'acted',escalated:'needs you',expired:'no longer applicable'};
// Render the numbers that actually fired the detector — a finding you cannot
// second-guess is not calibration data.
function emWhy(f){let s={};try{s=JSON.parse(f.signals_json)||{};}catch(e){}
  const bits=[];
  if(s.idleMs!=null)bits.push('idle '+Math.round(s.idleMs/60000)+'m');
  if(s.contextFraction!=null)bits.push('ctx '+Math.round(s.contextFraction*100)+'% of '+Math.round((s.contextLimit||0)/1000)+'k');
  if(s.messageCount!=null)bits.push(s.messageCount+' msgs');
  return bits.join(' · ');}
function emRow(f,acts){const who=f.title||f.session_id.slice(0,8);
  const proj=f.project?f.project.split('/').filter(Boolean).pop():'';
  return '<div class="emrow em-'+esc(f.status)+'">'+
  '<div class="emhead"><b>'+esc(f.kind)+'</b> · '+esc(EM_WHY[f.kind]||'')+' · '+rel(f.detected_at)+'</div>'+
  '<div class="emwho">'+esc(who)+(proj?' <span class="emproj">'+esc(proj)+'</span>':'')+'</div>'+
  '<div class="emwhy">'+esc(emWhy(f))+(acts.length?'':' — <i>'+esc(EM_STATUS[f.status]||f.status)+'</i>')+'</div>'+
  acts.map(a=>'<div class="emact'+(a.shadow?' shadow':'')+'"><span class="emtag">'+(a.shadow?'would':'did')+'</span> '+esc(a.kind)+': '+esc(a.payload)+'</div>').join('')+'</div>';}
// Findings read newest-first, but the actions WITHIN one read oldest-first: a
// wrap-up files its issue before it closes anything, and the feed has to show
// that order or it misrepresents what the EM did.
let EM={mode:'',findings:[],actions:[]};
const EM_MODE_HINT={
  off:'Off — no scanning, no findings, no cost.',
  shadow:'Shadow — scans and triages, and records what it WOULD do. Never touches a pane or files an issue.',
  live:'Live — the EM acts on its own: answers blocked sessions, files fast-follows, and closes finished panes.'};
function renderEmModes(){const cur=EM.mode||'shadow';
  // The 15s poll must not rebuild these buttons while one is armed — it would
  // wipe the confirm mid-click, and the second click would land on a fresh
  // button and merely re-arm it, so 'live' could never actually be reached.
  if($('#em-modes').querySelector('.arm'))return;
  $('#em-modes').innerHTML=['off','shadow','live'].map(m=>'<button data-m="'+m+'"'+(cur===m?' class="on"':'')+'>'+m+'</button>').join('');
  $('#em-hint').textContent=EM_MODE_HINT[cur]||'';
  $('#em-modes').querySelectorAll('button').forEach(b=>b.onclick=()=>armMode(b));}
// Going live is the moment the EM starts writing to panes and filing issues, so
// it takes a second click — same arm-then-confirm as the card close button.
// off and shadow are harmless and switch immediately.
function armMode(b){const m=b.dataset.m;
  if(m!=='live'||b.dataset.armed)return setMode(m);
  b.dataset.armed='1';b.textContent='act for real?';b.classList.add('arm');
  setTimeout(()=>{if(b){b.dataset.armed='';b.textContent='live';b.classList.remove('arm');}},5000);}
function setMode(m){fetch('/api/em/mode',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({mode:m})})
  .then(r=>r.json()).then(j=>{if(j.ok){EM.mode=j.mode;renderEmModes();}}).catch(()=>{});}
function renderEm(d){const byF={};(d.actions||[]).forEach(a=>{(byF[a.finding_id]=byF[a.finding_id]||[]).push(a);});
  Object.keys(byF).forEach(k=>byF[k].sort((x,y)=>(x.taken_at-y.taken_at)||(x.id-y.id)));
  renderEmModes();
  const rows=(d.findings||[]).map(f=>emRow(f,byF[f.id]||[]));
  $('#em-feed').innerHTML=rows.length?rows.join(''):'<p class="meta">Nothing yet. The EM scans every 30s and triages every 5m; in <b>shadow</b> mode it records what it would have done without touching a pane or filing anything.</p>';}
function refreshEm(){fetch('/api/em').then(r=>r.json()).then(d=>{EM=d;renderTabs();if(tab==='em')renderEm(EM);}).catch(()=>{});}
// ---- Trees -----------------------------------------------------------------
// Worktree inventory, diffs and cleanup. A full scan is five git calls per
// worktree (~2.4s across 44), so this deliberately does NOT join the board's 5s
// poll: it fetches a 30s server cache on first open, and otherwise only when
// asked. Everything renders from TREES, exactly as the board renders from DATA.
var TREES={repos:[],generatedAt:0,scanMs:0};
var treeLoaded=false,treeBusy=false,treeMode='browse',treeDiffMode='branch',treeArmed=false;
var treeSel=null,treeFile=null,treeFiles=[],treeDiff='',treePick={},treeMsg='';
// Stale is collapsed by default — it is the long tail the tab exists to keep out of the way.
var treeOpen={main:true,active:true,stale:false};
var treeView='unified';
function treeCount(){var n=0;TREES.repos.forEach(function(r){n+=r.worktrees.length;});return n;}
function allWts(){var a=[];TREES.repos.forEach(function(r){r.worktrees.forEach(function(w){a.push(w);});});return a;}
function wtByPath(p){var m=allWts().filter(function(w){return w.path===p;});return m.length?m[0]:null;}
function pickCount(){return Object.keys(treePick).length;}
function refreshTrees(force){if(treeBusy)return;treeBusy=true;if(tab==='trees')renderTrees();
  fetch('/api/trees'+(force?'?refresh=1':'')).then(function(r){return r.json();}).then(function(d){
    TREES=d;treeLoaded=true;treeBusy=false;
    // A worktree can vanish between polls (another session removed it); drop any
    // selection or tick that no longer refers to something real.
    if(treeSel&&!wtByPath(treeSel))treeSel=null;
    Object.keys(treePick).forEach(function(p){var w=wtByPath(p);if(!w||!w.removable)delete treePick[p];});
    if(!treeSel){var occupied=allWts().filter(function(w){return !w.primary&&w.livePanes.length;});
      var busy=allWts().filter(function(w){return !w.primary&&(w.trackedModified||w.ahead);});
      var first=occupied.length?occupied[0]:(busy.length?busy[0]:allWts()[0]);if(first)treeSel=first.path;}
    renderTabs();if(tab==='trees'){renderTrees();if(treeSel)loadFiles();}
  }).catch(function(){treeBusy=false;if(tab==='trees')renderTrees();});}
function loadFiles(){if(!treeSel)return;var p=treeSel;
  fetch('/api/trees/files?mode='+treeDiffMode+'&wt='+encodeURIComponent(p)).then(function(r){return r.json();}).then(function(d){
    if(treeSel!==p)return;treeFiles=d.files||[];treeFile=treeFiles.length?treeFiles[0].path:null;treeDiff='';renderTrees();if(treeFile)loadDiff();}).catch(function(){});}
function loadDiff(){if(!treeSel||!treeFile)return;var p=treeSel,f=treeFile;
  fetch('/api/trees/diff?mode='+treeDiffMode+'&wt='+encodeURIComponent(p)+'&file='+encodeURIComponent(f)).then(function(r){return r.json();}).then(function(d){
    if(treeSel!==p||treeFile!==f)return;treeDiff=d.diff||'';renderTrees();}).catch(function(){});}
// git already emits unified diff, so there is nothing to diff here — only the
// two line counters to carry forward from each @@ header while colouring rows.
function dline(k,n,mk,tx){return '<div class="dl '+k+'"><span class="ln">'+(n||'')+'</span><span class="mk">'+mk+'</span><span class="tx">'+esc(tx)+'</span></div>';}
// Parse git's unified output ONCE into hunks of typed rows; unified and split are
// then two renderings of the same model rather than two parsers.
function parseDiff(t){var hunks=[],cur=null,a=0,b=0,lines=t.split('\\n');
  for(var i=0;i<lines.length;i++){var L=lines[i];
    if(L.indexOf('@@')===0){var m=/@@ -(\\d+)(?:,\\d+)? \\+(\\d+)(?:,\\d+)? @@/.exec(L);if(m){a=+m[1];b=+m[2];}
      cur={header:L,rows:[]};hunks.push(cur);continue;}
    // Nothing before the first @@ is content, and the '--- a/x' / '+++ b/x'
    // header pair would otherwise read as a deletion and an addition.
    if(!cur)continue;
    var c=L.charAt(0);
    if(c==='+'){cur.rows.push({k:'add',b:b++,tx:L.slice(1)});}
    else if(c==='-'){cur.rows.push({k:'del',a:a++,tx:L.slice(1)});}
    else if(c===' '){cur.rows.push({k:'ctx',a:a++,b:b++,tx:L.slice(1)});}
    // Anything else inside a hunk is the no-newline marker, which carries nothing.
  }
  return hunks;}
function renderUnified(hunks){var out=[];
  hunks.forEach(function(h){out.push('<div class="thunk">'+esc(h.header)+'</div>');
    h.rows.forEach(function(r){
      out.push(r.k==='add'?dline('add',r.b,'+',r.tx):r.k==='del'?dline('del',r.a,'−',r.tx):dline('ctx',r.b,' ',r.tx));});});
  return out.join('');}
// Pair a hunk's rows into left/right. git emits a change as a run of deletions
// followed by a run of additions, so the runs pair by index and whichever side
// is shorter gets filler rows — that filler is what keeps the two columns
// vertically aligned without a scroll listener.
function pairRows(rows){var out=[],i=0;
  while(i<rows.length){
    if(rows[i].k==='ctx'){out.push({l:rows[i],r:rows[i]});i++;continue;}
    var dels=[],adds=[];
    while(i<rows.length&&rows[i].k==='del'){dels.push(rows[i]);i++;}
    while(i<rows.length&&rows[i].k==='add'){adds.push(rows[i]);i++;}
    var n=Math.max(dels.length,adds.length);
    for(var j=0;j<n;j++)out.push({l:dels[j]||null,r:adds[j]||null});}
  return out;}
function splitCell(row,side){
  if(!row)return '<div class="dl pad"><span class="ln"></span><span class="tx"> </span></div>';
  var k=row.k==='ctx'?'ctx':(side==='l'?'del':'add');
  var mk=row.k==='ctx'?' ':(side==='l'?'−':'+');
  return '<div class="dl '+k+'"><span class="ln">'+((side==='l'?row.a:row.b)||'')+'</span><span class="mk">'+mk+'</span><span class="tx">'+esc(row.tx)+'</span></div>';}
function renderSplit(hunks){var out=[];
  hunks.forEach(function(h){var pairs=pairRows(h.rows);
    out.push('<div class="thunk">'+esc(h.header)+'</div>');
    out.push('<div class="tsplit"><div class="tsplitcol">'
      +pairs.map(function(p){return splitCell(p.l,'l');}).join('')
      +'</div><div class="tsplitcol">'
      +pairs.map(function(p){return splitCell(p.r,'r');}).join('')
      +'</div></div>');});
  return out.join('');}
function renderDiffText(t){if(!t)return '<div class="tempty">No changes in this file.</div>';
  var hunks=parseDiff(t);
  if(!hunks.length)return '<div class="tempty">No textual changes (binary or mode-only).</div>';
  return treeView==='split'?renderSplit(hunks):renderUnified(hunks);}
function renderTreeModes(){var defs=[['browse','Browse'],['cleanup','Cleanup']];
  $('#tree-modes').innerHTML=defs.map(function(d){return '<button'+(treeMode===d[0]?' class="on"':'')+' data-m="'+d[0]+'">'+d[1]+'</button>';}).join('')
    +'<button data-m="refresh">'+(treeBusy?'Scanning…':'Refresh')+'</button>';
  $('#tree-modes').querySelectorAll('button').forEach(function(el){el.onclick=function(){
    if(el.dataset.m==='refresh')return refreshTrees(true);
    treeMode=el.dataset.m;treeArmed=false;renderTrees();};});}
function wtHtml(w){var tag='';
  if(w.removable)tag='<span class="ttag safe">Safe</span>';
  else if(w.verdict==='uncommitted')tag='<span class="ttag risk">'+w.trackedModified+' uncommitted</span>';
  else if(w.verdict==='untracked-only')tag='<span class="ttag warn">'+w.untracked+' untracked</span>';
  // Count SESSIONS, not panes: one session holds several panes, so a pane count
  // reads as far more work happening here than there is.
  var sess=[];w.livePanes.forEach(function(x){if(sess.indexOf(x.tmux_session)<0)sess.push(x.tmux_session);});
  var p=w.livePanes[0];
  var extra=sess.length>1?' +'+(sess.length-1):'';
  var live=p?'<span class="ttag live" data-wt="'+esc(w.path)+'" data-pane="'+esc(p.pane_id)+'" title="'+esc(sess.join(', '))+' — click to focus in Ghostty">● '+esc(sess[0].replace(/^loom-/,''))+extra+'</span>':'';
  var counts=(w.ahead?'<span class="tct a">↑'+w.ahead+'</span>':'')+(w.behind?'<span class="tct b">↓'+w.behind+'</span>':'');
  return '<div class="twt'+(treeSel===w.path?' on':'')+'" data-p="'+esc(w.path)+'">'
    +'<div class="twtl1"><span class="tdot v-'+w.verdict+'"></span><span class="twtname">'+esc(w.name)+'</span><span class="tsp"></span>'+live+tag+'</div>'
    +'<div class="twtl2"><span class="twtbr">⑂ '+esc(w.branch||'detached')+'</span><span class="tsp"></span>'+counts+'</div></div>';}
// Rail grouping is by occupancy, not by cleanup verdict: what you want at the
// top is the worktree an agent is in right now.
function railGroups(r){var main=[],active=[],stale=[];
  r.worktrees.forEach(function(w){(w.primary?main:(w.livePanes.length?active:stale)).push(w);});
  return [['main','Main',main],['active','Active work',active],['stale','Stale',stale]];}
function repoHtml(r){
  var out='<div class="trepo">'+esc(r.name)+' <span style="opacity:.55">'+r.worktrees.length+'</span></div>';
  railGroups(r).forEach(function(g){if(!g[2].length)return;var open=treeOpen[g[0]];
    out+='<div class="tgrp'+(open?' open':'')+'" data-g="'+g[0]+'"><span class="tgcar">▶</span>'+g[1]+'<span class="tgcount">'+g[2].length+'</span></div>';
    if(open)out+=g[2].map(wtHtml).join('');});
  return out;}
function detailHtml(){var w=wtByPath(treeSel);
  if(!w)return '<div class="tempty">Select a worktree to see what changed in it.</div>';
  var files=treeFiles.map(function(f){var parts=f.path.split('/');var name=parts.pop();
    return '<div class="tfile'+(treeFile===f.path?' on':'')+'" data-f="'+esc(f.path)+'"><span class="tfname">'+esc(name)+'</span><span class="tfpath">'+esc(parts.join('/'))+'</span>'
      +'<span class="tct a">+'+f.added+'</span><span class="tct d">−'+f.deleted+'</span></div>';}).join('');
  return '<div class="tdhead"><span class="tcrumb"><b>'+esc(w.name)+'</b> · '+esc(w.reason)+'</span>'
    +'<span class="tbtns"><button class="tbtn'+(treeDiffMode==='branch'?' on':'')+'" data-dm="branch" title="this branch’s own commits, vs the base">vs base</button>'
    +'<button class="tbtn'+(treeDiffMode==='worktree'?' on':'')+'" data-dm="worktree" title="uncommitted edits only">Uncommitted</button>'
    +'<span class="tbtnsep"></span>'
    +'<button class="tbtn'+(treeView==='unified'?' on':'')+'" data-vw="unified">Unified</button>'
    +'<button class="tbtn'+(treeView==='split'?' on':'')+'" data-vw="split">Split</button></span></div>'
    +'<div class="tfiles">'+(files||'<div class="tempty">Nothing changed here.</div>')+'</div>'
    +'<div class="tdiff">'+renderDiffText(treeDiff)+'</div>';}
// Group order is the order of consequence, not alphabetical: what you can act on
// sits above what you must not touch.
var VGROUPS=[['safe','Safe to remove','no unmerged patches · clean · no live session'],
  ['untracked-only','Merged, but files would be lost','no unmerged patches · untracked files present'],
  ['uncommitted','Do not remove','tracked modifications not committed anywhere'],
  ['active','Active work','unmerged patches present'],
  ['primary','Repositories','the main worktree, never removable']];
function cleanupHtml(){var all=allWts(),out='';
  VGROUPS.forEach(function(g){var rows=all.filter(function(w){return w.verdict===g[0];});if(!rows.length)return;
    out+='<div class="tgroup g-'+g[0]+'"><div class="tghead"><span class="tgtitle">'+g[1]+'</span><span class="tgwhy">'+g[2]+'</span><span class="tgn">'+rows.length+'</span></div>'
      +rows.map(function(w){var cls=w.removable?(treePick[w.path]?'tck on':'tck'):'tck off';
        return '<div class="tcrow"><span class="'+cls+'"'+(w.removable?' data-p="'+esc(w.path)+'"':'')+'></span>'
          +'<span class="tcbr">'+esc(w.name)+'</span><span class="tcnote">'+esc(w.reason)+'</span></div>';}).join('')+'</div>';});
  var n=pickCount();
  out+='<div class="tfoot"><span class="tsum"><b>'+n+' selected</b>'+(n?' · removes the worktree and deletes its local branch':'')+'</span>'
    +(treeMsg?'<span class="tsum">'+esc(treeMsg)+'</span>':'')
    +'<span class="tbtns"><button class="tbtn" data-act="copy">Copy commands</button>'
    +'<button class="tbtn danger" data-act="remove"'+(n?'':' disabled')+'>'+(treeArmed?'Click again to confirm':'Remove '+n+' worktree'+(n===1?'':'s'))+'</button></span></div>';
  return out;}
function renderTrees(){renderTreeModes();
  // Lazy first load: the scan is expensive enough that it should happen when the
  // tab is opened, not on every dashboard boot. treeBusy guards the re-entry.
  if(!treeLoaded&&!treeBusy)refreshTrees(false);
  var rail=$('#tree-rail'),det=$('#tree-detail');
  $('#twrap').classList.toggle('cleanup',treeMode==='cleanup');
  $('#tree-hint').textContent=treeLoaded
    ?(treeCount()+' worktrees across '+TREES.repos.length+' repo'+(TREES.repos.length===1?'':'s')+' · scanned in '+TREES.scanMs+'ms '+rel(TREES.generatedAt))
    :'';
  if(!treeLoaded){rail.innerHTML='';det.innerHTML='<div class="tempty">'+(treeBusy?'Scanning every repo Loom has seen a session in…':'Nothing scanned yet.')+'</div>';return;}
  if(treeMode==='cleanup'){det.innerHTML=cleanupHtml();wireCleanup(det);return;}
  rail.innerHTML=TREES.repos.map(repoHtml).join('')||'<div class="tempty">No git repositories found.</div>';
  rail.querySelectorAll('.tgrp').forEach(function(el){el.onclick=function(){
    treeOpen[el.dataset.g]=!treeOpen[el.dataset.g];renderTrees();};});
  rail.querySelectorAll('.twt').forEach(function(el){el.onclick=function(){
    if(treeSel===el.dataset.p)return;treeSel=el.dataset.p;treeFiles=[];treeFile=null;treeDiff='';renderTrees();loadFiles();};});
  // Focus the pane's Ghostty tab. stopPropagation so the badge doesn't also
  // change the rail selection out from under the jump.
  rail.querySelectorAll('.ttag.live').forEach(function(el){el.onclick=function(e){e.stopPropagation();
    fetch('/api/trees/goto?wt='+encodeURIComponent(el.dataset.wt)+'&pane='+encodeURIComponent(el.dataset.pane))
      .then(function(r){return r.json();}).then(function(j){if(!j.ok){el.title=j.detail||'jump failed';}}).catch(function(){});};});
  det.innerHTML=detailHtml();
  det.querySelectorAll('.tbtn[data-dm]').forEach(function(el){el.onclick=function(){
    if(treeDiffMode===el.dataset.dm)return;treeDiffMode=el.dataset.dm;treeFiles=[];treeFile=null;treeDiff='';renderTrees();loadFiles();};});
  // Purely a re-render: the diff text is already in hand, so switching view
  // must not refetch.
  det.querySelectorAll('.tbtn[data-vw]').forEach(function(el){el.onclick=function(){
    if(treeView===el.dataset.vw)return;treeView=el.dataset.vw;renderTrees();};});
  det.querySelectorAll('.tfile').forEach(function(el){el.onclick=function(){
    if(treeFile===el.dataset.f)return;treeFile=el.dataset.f;treeDiff='';renderTrees();loadDiff();};});}
function wireCleanup(det){
  det.querySelectorAll('.tck[data-p]').forEach(function(el){el.onclick=function(){
    var p=el.dataset.p;if(treePick[p])delete treePick[p];else treePick[p]=1;treeArmed=false;treeMsg='';renderTrees();};});
  det.querySelectorAll('.tbtn[data-act="copy"]').forEach(function(el){el.onclick=function(){
    var cmds=Object.keys(treePick).map(function(p){var w=wtByPath(p);return 'git worktree remove '+p+(w&&w.branch?' && git branch -d '+w.branch:'');}).join('\\n');
    navigator.clipboard.writeText(cmds).then(function(){treeMsg='Copied '+pickCount()+' command'+(pickCount()===1?'':'s');renderTrees();}).catch(function(){});};});
  // Arm/confirm, matching the EM tab's live-mode switch. This is the only thing
  // in Loom that deletes from disk, so it never fires on a single click.
  det.querySelectorAll('.tbtn[data-act="remove"]').forEach(function(el){el.onclick=function(){
    if(!pickCount())return;
    if(!treeArmed){treeArmed=true;treeMsg='';renderTrees();setTimeout(function(){if(treeArmed){treeArmed=false;renderTrees();}},5000);return;}
    treeArmed=false;treeMsg='Removing…';renderTrees();
    fetch('/api/trees/remove',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({paths:Object.keys(treePick)})})
      .then(function(r){return r.json();}).then(function(o){
        treePick={};
        var bits=[];
        if(o.removed&&o.removed.length)bits.push('Removed '+o.removed.length);
        if(o.refused&&o.refused.length)bits.push('refused '+o.refused.length+' ('+o.refused[0].reason+')');
        if(o.failed&&o.failed.length)bits.push('failed '+o.failed.length);
        treeMsg=bits.join(' · ')||'Nothing removed';
        treeLoaded=false;renderTrees();refreshTrees(true);}).catch(function(){treeMsg='Removal failed';renderTrees();});};});}
// ---- Detail panel ------------------------------------------------------------
// Clicking a card selects it and fills the sticky right column. Everything cheap
// renders from DATA straight away; the expensive half (git, gh, transcript scan)
// comes from /api/detail, fetched on selection and every 20s while selected —
// never on the board poll. With nothing selected the column lists every chat
// waiting on you.
var sel=null, DETAIL=null, detailTimer=null, detailRetry=null, lastOpen=false, TAILS={}, tailsAt=0;
const STAGE_GLYPH={discovery:'?',implementation:'+',shipping:'^',thread:'~'};
function detailShown(){const d=$('#detail');return !!d&&getComputedStyle(d).display!=='none'&&tab!=='em'&&tab!=='trees';}
function selKey(){return sel?sel.agent+':'+sel.sid:'';}
function selChat(){return sel?DATA.chats.find(c=>c.agent===sel.agent&&c.session_id===sel.sid)||null:null;}
function isTurn(c){return st(c)==='waiting_on_user'&&!isWorking(c);}
function selectChat(sid,agent){if(sel&&sel.sid===sid&&sel.agent===agent)return;sel={sid,agent};const sc=selChat();if(sc&&pipeEvent(sc)){ackPipe(sc);setTimeout(render,0);}DETAIL=null;lastOpen=false;
  document.querySelectorAll('#list .card').forEach(el=>el.classList.toggle('sel',el.dataset.sid===sid&&el.dataset.agent===agent));
  renderDetail();loadDetail();clearInterval(detailTimer);detailTimer=setInterval(loadDetail,20000);}
function deselect(){sel=null;DETAIL=null;clearInterval(detailTimer);clearTimeout(detailRetry);document.querySelectorAll('#list .card.sel').forEach(el=>el.classList.remove('sel'));renderDetail();}
function loadDetail(){if(!sel)return;const k=selKey();fetch('/api/detail?session='+encodeURIComponent(sel.sid)+'&agent='+encodeURIComponent(sel.agent)).then(r=>r.json()).then(d=>{if(selKey()!==k)return;DETAIL=d;renderDetail();
  // gh runs in the background on the server; ask again shortly rather than wait on it.
  clearTimeout(detailRetry);if(d.pending)detailRetry=setTimeout(loadDetail,3000);}).catch(()=>{});}
function detailBusy(){const d=$('#detail');return !!(d.querySelector('.picker:not(:empty)')||d.querySelector('.dactions .closebtn.arm')||d.querySelector('textarea:focus'));}
function shortPath(p){return (p||'').replace(new RegExp('^/Users/[^/]+'),'~');}
function stageBadge(s){return s?'<span class="stage s-'+esc(s)+'">'+esc(STAGE_GLYPH[s]||'')+' '+esc(s)+'</span>':'';}
function whereHtml(w,pr){if(!w)return '<div class="dempty">…</div>';
  if(w.kind==='none')return '<div class="drow">not a git checkout</div><div class="dpath">'+esc(shortPath(w.cwd))+'</div>';
  if(w.kind==='main')return '<div class="drow"><span class="dmono">⎇ '+esc(w.branch)+'</span><span class="dsub">(shared checkout)</span></div><div class="dpath">'+esc(shortPath(w.top))+'</div>';
  const ab=(w.ahead?'<span class="tct a">↑'+w.ahead+'</span>':'')+(w.behind?'<span class="tct b">↓'+w.behind+'</span>':'')+'<span class="dsub">vs '+esc(w.base)+'</span>';
  return '<div class="drow"><span class="dmono">⑂ '+esc(w.branch)+'</span>'+ab+'</div>'+
    '<div class="dpath">'+(w.kind==='worktree'?'worktree ':'primary checkout ')+esc(shortPath(w.top))+'</div>'+
    (pr&&pr.number?'<div class="drow"><a class="prbtn" href="'+esc(pr.url)+'" target="_blank" rel="noopener">⎇ PR #'+pr.number+'</a></div>':'');}
const FILE_CAP=60;
function filesHtml(d){const fs=d.files||[];if(!fs.length)return '<div class="dempty">'+(d.filesMode==='session'?'This session hasn’t edited any files.':'Nothing changed on this branch.')+'</div>';
  return '<div class="dfiles">'+fs.slice(0,FILE_CAP).map(f=>'<div class="dfile" title="'+esc(f.path)+'"><span class="fst '+f.state+'">'+esc(f.state)+'</span><span class="fp">&lrm;'+esc(f.path)+'</span></div>').join('')+
    (fs.length>FILE_CAP?'<div class="dfile dsub">+'+(fs.length-FILE_CAP)+' more</div>':'')+'</div>';}
function prHtml(pr){if(!pr)return '';if(pr.loading)return '<div class="dempty">checking '+esc(pr.ref)+' on GitHub…</div>';
  const st=pr.state==='MERGED'?'<span class="badge info">merged</span>':pr.state==='CLOSED'?'<span class="badge">closed</span>':(pr.isDraft?'<span class="badge">draft</span>':'<span class="badge good">ready</span>');
  const rv={APPROVED:['good','approved'],CHANGES_REQUESTED:['bad','changes requested'],REVIEW_REQUIRED:['warn','review required']}[pr.reviewDecision];
  const ci={pass:['good','CI ✓'],fail:['bad','CI ✕'],pending:['warn','CI …']}[pr.ci];
  return '<div class="prline"><a href="'+esc(pr.url)+'" target="_blank" rel="noopener">#'+pr.number+'</a><span>'+esc(pr.title)+'</span></div>'+
    '<div class="prline">'+st+(rv?'<span class="badge '+rv[0]+'">'+rv[1]+'</span>':'')+(ci?'<span class="badge '+ci[0]+'">'+ci[1]+'</span>':'')+'</div>';}
function todoHtml(d){const t=d.todos||[],b=d.background||[];if(!t.length&&!b.length)return '';
  const tk={completed:'☑',in_progress:'◐',pending:'☐'};
  return '<div class="dsec"><h3>Todo'+(b.length?' · background':'')+'</h3>'+
    t.map(x=>'<div class="todo '+esc(x.status)+'"><span class="tk">'+(tk[x.status]||'☐')+'</span><span>'+esc(x.status==='in_progress'&&x.activeForm?x.activeForm:x.content)+'</span></div>').join('')+
    b.map(x=>'<div class="todo in_progress"><span class="tk">⟳</span><span>'+esc(x.kind==='agent'?'agent: ':'bash: ')+esc(x.desc)+(x.startedAt?' <span class="dsub">· '+rel(x.startedAt)+'</span>':'')+'</span></div>').join('')+'</div>';}
function renderDetail(){const box=$('#detail');if(!box)return;if(!sel){renderWaiting();return;}
  const c=selChat();if(!c){box.innerHTML='<div class="dempty">That chat is no longer on the board.</div>';return;}
  if(detailBusy())return;
  const L=DATA.live[chatKey(c)];const d=DETAIL&&DETAIL.session_id===c.session_id?DETAIL:null;const lb=d?d.labels:{topic:'',stage:'',name:L&&L.name||''};
  const id=esc(c.session_id);const agent=esc(c.agent);const turn=isTurn(c)&&!!L;
  const head='<div class="dsec"><div class="dtitle">'+esc(lb.topic||disp(c))+'</div>'+(lb.topic?'<div class="dsub">'+esc(disp(c))+'</div>':'')+
    '<div class="drow">'+stageBadge(lb.stage)+(lb.name?'<span class="dname">@'+esc(lb.name)+'</span>':'')+
      (L?'<span class="dloc">'+esc(L.tmux_session)+' · pane '+esc(L.pane_index)+'</span><button class="iconbtn" data-act="goto" title="open in Ghostty">↗ open</button>':'<span class="stale">○ no active pane</span>')+'</div>'+
    '<div class="drow"><code class="sid copyable" data-id="'+id+'" title="click to copy the session id">'+id+'</code><button class="iconbtn ghost" data-act="transcript" title="read the transcript and message this chat">💬 transcript</button></div></div>';
  if(!d){box.innerHTML=head+draftsHtml(c,null)+'<div class="dempty">loading…</div>'+actionsHtml(c,L);wireDetail(box,c);return;}
  const pr=d.pr&&!d.pr.loading?d.pr:null;
  const last=d.last?'<div class="dsec"><h3>Last message'+(turn?' <span class="turnlbl">● waiting on you</span>':'')+'<span class="n">'+rel(d.last.at)+'</span></h3>'+
    '<div class="dlast'+(turn?' turn':'')+(lastOpen?' open':'')+'">'+d.last.html+'</div><button class="linkbtn" data-act="expand">'+(lastOpen?'collapse':'expand')+'</button></div>':'';
  const km=(c.breakdown||[]).length?'<div class="dsec"><h3>Moments</h3><ul class="timeline">'+c.breakdown.map(b=>'<li>'+esc(b)+'</li>').join('')+'</ul></div>':'';
  box.innerHTML=head+
    '<div class="dsec"><h3>Where it’s working</h3>'+whereHtml(d.where,d.where.kind==='main'?null:pr)+'</div>'+
    '<div class="dsec"><h3>Files changed <span class="n">'+(d.files||[]).length+' · '+(d.filesMode==='session'?'edited by this session':'branch vs '+esc(d.where.base))+'</span></h3>'+filesHtml(d)+'</div>'+
    last+
    (d.pr||d.pipeline?'<div class="dsec"><h3>Pull request</h3>'+prHtml(d.pr)+pipelineHtml(d)+'</div>':'')+shipSectionHtml(d,c)+
    draftsHtml(c,d)+slackHtml(d)+km+todoHtml(d)+actionsHtml(c,L);
  wireDetail(box,c);wireSteps(box);wireShips(box);}
const SLACK_STAGE={looking:['info','👀 looking'],blocked:['bad','⛔ blocked'],done:['good','✅ done']};
function slackHtml(d){const t=d.slack||[];if(!t.length)return '';
  return '<div class="dsec"><h3>Slack <span class="n">'+t.length+'</span></h3>'+t.map(x=>{const sg=SLACK_STAGE[x.stage];
    return '<div class="sthread"><div class="drow"><span class="dmono">'+esc(x.label)+'</span>'+(sg?'<span class="badge '+sg[0]+'">'+sg[1]+'</span>':'')+
      '<span class="spacer"></span><button class="iconbtn ghost" data-slack="'+esc(x.key)+'" title="'+esc(x.deeplink)+'">Open in Slack</button></div>'+
      '<div class="sprev">'+(x.preview===null?'<span class="dsub">loading the thread…</span>':(x.author?'<b>'+esc(x.author)+':</b> ':'')+esc(x.preview))+'</div>'+
      '<a class="dpath" href="'+esc(x.url)+'" target="_blank" rel="noopener">'+esc(x.url)+'</a></div>';}).join('')+'</div>';}
function actionsHtml(c,L){const id=esc(c.session_id);const agent=esc(c.agent);
  return '<div class="dactions"><div class="arow">'+
    (L?'':launchButtons(id,c.agent,''))+
    '<button class="branchbtn launchbtn" data-sid="'+id+'" data-agent="'+agent+'" data-action="branch" title="fork this conversation into a new '+agentLabel(c.agent)+' pane (original left untouched)">⑃ Branch from here…</button>'+
    (L?'<span class="danger-zone"><button class="closebtn" data-sid="'+id+'" title="exit '+agentLabel(c.agent)+' in this pane (chat stays resumable)">✕ close</button></span>':'')+
    '</div><div class="picker"></div></div>';}
function wireDetail(box,c){const agent=c.agent;const act=box.querySelector('.dactions');
  box.querySelectorAll('[data-slack]').forEach(b=>b.onclick=()=>{fetch('/api/slack/open?key='+encodeURIComponent(b.dataset.slack),{method:'POST'}).then(r=>r.json()).then(j=>flash(act,j.ok?j.detail+' ✓':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e')).catch(()=>flash(act,'server off','#8a2b2e'));});
  box.querySelectorAll('[data-act="goto"]').forEach(b=>b.onclick=()=>jump(c.session_id,agent,act));
  box.querySelectorAll('[data-act="transcript"]').forEach(b=>b.onclick=()=>openChat(c.session_id,agent,null));
  box.querySelectorAll('code.copyable').forEach(el=>el.onclick=()=>{navigator.clipboard.writeText(el.dataset.id).then(()=>flash(act,'session id copied ✓','#1f6f3f')).catch(()=>{});});
  box.querySelectorAll('[data-act="expand"]').forEach(b=>b.onclick=()=>{lastOpen=!lastOpen;const l=box.querySelector('.dlast');if(l)l.classList.toggle('open',lastOpen);b.textContent=lastOpen?'collapse':'expand';});
  box.querySelectorAll('.launchbtn').forEach(b=>b.onclick=()=>openPicker(b.dataset.sid,agent,act,b.dataset.action,b.dataset.proj||'',b.dataset.agent));
  const cb=box.querySelector('.dactions .closebtn');if(cb)cb.onclick=()=>confirmClose(cb,agent,act);wireDrafts(box,c);}
// Empty state: every live chat whose turn it is, longest-waiting first.
function waitingChats(){return DATA.chats.filter(c=>isLive(c)&&isTurn(c)).sort((a,b)=>a.last_active_at-b.last_active_at);}
function renderWaiting(){const box=$('#detail');const w=waitingChats();
  const keys=w.map(chatKey);
  if(keys.length&&(Date.now()-tailsAt>15000||keys.some(k=>!(k in TAILS)))){tailsAt=Date.now();fetch('/api/tails?keys='+encodeURIComponent(keys.join(','))).then(r=>r.json()).then(j=>{if(j.ok){Object.assign(TAILS,j.tails);if(!sel)renderWaiting();}}).catch(()=>{});}
  box.innerHTML='<div class="dsec"><h3>Waiting on you <span class="n">'+w.length+'</span></h3>'+
    (w.length?w.map(c=>{const L=DATA.live[chatKey(c)];return '<div class="wait" data-sid="'+esc(c.session_id)+'" data-agent="'+esc(c.agent)+'"><div class="wt">'+esc(disp(c))+'</div>'+
      '<div class="wm">waiting '+rel(c.last_active_at).replace(' ago','')+' · '+esc(L.tmux_session)+' · pane '+esc(L.pane_index)+(L.name?' · @'+esc(L.name):'')+'</div>'+
      (TAILS[chatKey(c)]?'<div class="wx">'+esc(TAILS[chatKey(c)])+'</div>':'')+'</div>';}).join(''):'<div class="dempty">Nothing is waiting on you. Click a card to see its details.</div>')+'</div>';
  box.querySelectorAll('.wait').forEach(el=>el.onclick=()=>{selectChat(el.dataset.sid,el.dataset.agent);const card=document.querySelector('#list .card.sel');if(card)card.scrollIntoView({block:'nearest'});});}
function setHeaderHeight(){document.documentElement.style.setProperty('--hh',$('header').offsetHeight+'px');}
// ---- Slack drafts (outbox) ---------------------------------------------------
// Drafts a chat showed Will for approval. Editable here; Send opens a confirm
// that shows the exact destination and text, and only that second click posts
// (as Will). Edits and the open confirm live in client state, so the board
// poll re-rendering the panel cannot lose them.
var DRAFT_EDITS={}, draftConfirm=null, draftArmDiscard=null, draftMsg={};
function draftsFor(c){return (DATA.drafts||[]).filter(d=>d.session_id===c.session_id);}
function hasDrafts(c){return (DATA.drafts||[]).some(d=>d.session_id===c.session_id);}
function draftTexts(d){return DRAFT_EDITS[d.id]||d.messages.slice();}
function draftDest(d,threads){const t=(threads||[]).find(x=>x.key===d.channel+'/'+d.thread_ts);
  const lbl=t?t.label:(d.label||d.channel||'');
  return d.thread_ts?('reply in '+lbl+' thread'+(t&&t.preview?' · “'+t.preview.slice(0,80)+(t.preview.length>80?'…':'')+'”':'')):('new message to '+lbl);}
function draftsHtml(c,d){const ds=draftsFor(c);if(!ds.length)return '';const threads=d?d.slack:[];
  return '<div class="dsec"><h3>Drafts <span class="n">'+ds.length+' awaiting your okay</span></h3>'+ds.map(x=>{const texts=draftTexts(x);const dest=draftDest(x,threads);const conf=draftConfirm===x.id;
    return '<div class="draft" data-id="'+esc(x.id)+'"><div class="drow"><span class="dmono">✉ '+esc(dest)+'</span></div>'+
      (conf?'<div class="dconfirm"><div class="dsub">Post as Will — '+esc(dest)+'</div>'+texts.map(t=>'<pre class="dfinal">'+esc(t)+'</pre>').join('')+
        '<div class="arow"><button class="send" data-dact="post">Post now</button><button data-dact="cancel">Cancel</button></div></div>'
      :texts.map((t,i)=>'<textarea class="dtext" data-i="'+i+'" rows="'+Math.min(10,Math.max(3,t.split('\\n').length+1))+'">'+esc(t)+'</textarea>').join('')+
        '<div class="arow"><button class="send" data-dact="send">Send…</button><button class="closebtn'+(draftArmDiscard===x.id?' arm':'')+'" data-dact="discard">'+(draftArmDiscard===x.id?'✕ discard?':'Discard')+'</button>'+
        (draftMsg[x.id]?'<span class="dsub">'+esc(draftMsg[x.id])+'</span>':'')+'</div>')+'</div>';}).join('')+'</div>';}
function wireDrafts(box,c){box.querySelectorAll('.draft').forEach(el=>{const id=el.dataset.id;const d=(DATA.drafts||[]).find(x=>x.id===id);if(!d)return;
  el.querySelectorAll('textarea.dtext').forEach(ta=>ta.oninput=()=>{const t=draftTexts(d);t[+ta.dataset.i]=ta.value;DRAFT_EDITS[id]=t;});
  const b=(a)=>el.querySelector('[data-dact="'+a+'"]');
  if(b('send'))b('send').onclick=()=>{if(draftTexts(d).some(t=>!t.trim())){draftMsg[id]='every message needs text';renderDetail();return;}draftConfirm=id;draftArmDiscard=null;draftMsg[id]='';renderDetail();};
  if(b('cancel'))b('cancel').onclick=()=>{draftConfirm=null;renderDetail();};
  if(b('post'))b('post').onclick=()=>{const texts=draftTexts(d);const btn=b('post');btn.disabled=true;btn.textContent='posting…';
    fetch('/api/outbox/send',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id,messages:texts})}).then(r=>r.json()).then(j=>{
      draftConfirm=null;draftMsg[id]=j.ok?(j.dry?'dry run — nothing posted':(j.detail==='posted'?'posted ✓':j.detail)):(j.detail||'failed');
      if(j.ok&&!j.dry){delete DRAFT_EDITS[id];flash(box.querySelector('.dactions'),'posted ✓','#1f6f3f');}
      renderDetail();setTimeout(refresh,800);}).catch(()=>{draftConfirm=null;draftMsg[id]='server off';renderDetail();});};
  if(b('discard'))b('discard').onclick=()=>{if(draftArmDiscard!==id){draftArmDiscard=id;renderDetail();setTimeout(()=>{if(draftArmDiscard===id){draftArmDiscard=null;renderDetail();}},2500);return;}
    draftArmDiscard=null;fetch('/api/outbox/discard',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json()).then(j=>{draftMsg[id]=j.ok?'':(j.detail||'failed');delete DRAFT_EDITS[id];setTimeout(refresh,300);renderDetail();}).catch(()=>{});};});}
// ---- New thread composer ------------------------------------------------------
// "+ New thread" (or n): a prompt, pasted/dropped images, a project and a target
// pane. The server saves the images under ~/.loom/inbox/<id>/, appends their
// paths to the prompt, and launches the agent with the prompt as its CLI
// argument. Until the new chat is indexed its card shows as a placeholder.
var CIMAGES=[], composerOpen=false, composerBusy=false;
function lsGet(k){try{return localStorage.getItem(k)||'';}catch(e){return '';}}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function composerProjects(){const seen={},out=[];DATA.chats.slice().sort((a,b)=>b.last_active_at-a.last_active_at).forEach(c=>{if(c.project_dir&&!seen[c.project_dir]){seen[c.project_dir]=1;out.push(c.project_dir);}});return out;}
function openComposer(){if(composerOpen)return;composerOpen=true;const m=$('#composer');m.hidden=false;
  const projs=composerProjects();const last=lsGet('loom.lastProject');const def=projs.indexOf(last)>=0?last:(projs[0]||'');
  $('#cproj').innerHTML=projs.map(p=>'<option value="'+esc(p)+'"'+(p===def?' selected':'')+'>'+esc(shortPath(p))+'</option>').join('');
  $('#cagent').value=DATA.defaultAgent==='codex'?'codex':'claude';
  $('#ctarget').innerHTML='<option value="">Next open pane</option>';
  fetch('/api/lanes?all=1').then(r=>r.json()).then(ls=>{$('#ctarget').innerHTML='<option value="">Next open pane</option>'+ls.map(l=>'<option value="'+esc(l.lane)+'">loom-'+esc(l.lane)+(l.open?' → '+esc(l.open.where):' (full: splits a new pane)')+'</option>').join('');}).catch(()=>{});
  $('#cmsg').textContent='';renderThumbs();setTimeout(()=>$('#cprompt').focus(),0);}
function closeComposer(){composerOpen=false;$('#composer').hidden=true;}
function resetComposer(){$('#cprompt').value='';CIMAGES=[];renderThumbs();}
function renderThumbs(){const t=$('#cthumbs');t.innerHTML=CIMAGES.map((im,i)=>'<div class="cthumb"><img src="'+im.url+'" alt="'+esc(im.name)+'"/><button data-i="'+i+'" title="remove">✕</button></div>').join('');
  t.querySelectorAll('button').forEach(b=>b.onclick=()=>{CIMAGES.splice(+b.dataset.i,1);renderThumbs();});}
function addImageFile(f){if(!f||f.type.indexOf('image/')!==0)return;const r=new FileReader();r.onload=()=>{const url=String(r.result);CIMAGES.push({name:f.name||'pasted',type:f.type,url,data:url.slice(url.indexOf(',')+1)});renderThumbs();};r.readAsDataURL(f);}
function launchThread(){if(composerBusy)return;const prompt=$('#cprompt').value;if(!prompt.trim()&&!CIMAGES.length){$('#cmsg').textContent='Write a prompt first.';return;}
  const body={prompt,project:$('#cproj').value,lane:$('#ctarget').value,prefer:lsGet('loom.lastLane'),agent:$('#cagent').value,focus:$('#cfocus').checked,images:CIMAGES.map(i=>({name:i.name,type:i.type,data:i.data}))};
  composerBusy=true;$('#claunch').disabled=true;$('#cmsg').textContent='launching…';
  fetch('/api/new-thread',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).then(j=>{
    if(!j.ok){$('#cmsg').textContent='✕ '+(j.detail||'failed');return;}
    lsSet('loom.lastProject',body.project);const m=/^loom-(.+)-\\d+ /.exec(j.where||'');if(m)lsSet('loom.lastLane',m[1]);
    $('#cmsg').textContent='✓ started in '+(j.where||j.pane_id);resetComposer();refresh();setTimeout(refresh,2000);setTimeout(refresh,5000);setTimeout(closeComposer,1100);
  }).catch(()=>{$('#cmsg').textContent='✕ server off?';}).finally(()=>{composerBusy=false;$('#claunch').disabled=false;});}
// Placeholder cards for launches whose chat is not on the board yet.
function ghostCards(){if(tab!=='board')return '';const L=DATA.launches||[];return L.filter(g=>!DATA.chats.some(c=>{const x=DATA.live[chatKey(c)];return x&&x.pane_id===g.pane_id&&c.last_active_at>=g.at-5000;})).map(g=>
  '<div class="card ghost"><div class="chead"><h2>'+esc((g.prompt||'').split('\\n')[0].slice(0,90)||'New thread')+'</h2><span class="pill pending">Starting…</span></div>'+
  '<div class="meta"><span class="ptag" style="'+pcolor(g.project)+'">'+esc(g.project)+'</span>'+esc(g.where)+' · '+rel(g.at)+'</div></div>').join('');}
$('#newbtn').onclick=openComposer;
$('#ccancel').onclick=closeComposer;
$('#claunch').onclick=launchThread;
$('#composer').addEventListener('mousedown',e=>{if(e.target.id==='composer')closeComposer();});
$('#cprompt').addEventListener('paste',e=>{const items=(e.clipboardData&&e.clipboardData.items)||[];let took=false;for(const it of items){if(it.kind==='file'&&it.type.indexOf('image/')===0){addImageFile(it.getAsFile());took=true;}}if(took)e.preventDefault();});
$('.cbox').addEventListener('dragover',e=>{e.preventDefault();$('.cbox').classList.add('drop');});
$('.cbox').addEventListener('dragleave',()=>$('.cbox').classList.remove('drop'));
$('.cbox').addEventListener('drop',e=>{e.preventDefault();$('.cbox').classList.remove('drop');for(const f of (e.dataTransfer&&e.dataTransfer.files)||[])addImageFile(f);});
$('#composer').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeComposer();}else if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();launchThread();}});
document.addEventListener('keydown',e=>{if(e.key!=='n'||e.metaKey||e.ctrlKey||e.altKey||composerOpen)return;const t=e.target;if(t&&(t.tagName==='INPUT'||t.tagName==='TEXTAREA'||t.tagName==='SELECT'||t.isContentEditable))return;e.preventDefault();openComposer();});
$('#deep').onclick=runArchive;
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter')runArchive();});
$('#q').addEventListener('input',updateDeep);
setHeaderHeight();window.addEventListener('resize',setHeaderHeight);if(window.ResizeObserver)new ResizeObserver(setHeaderHeight).observe($('header'));
heat();projects();syncDefaultAgent();liveToggle();chips();render();updateDeep();refreshEm();
$('#default-agent').onchange=updateDefaultAgent;
['#q','#proj','#sort'].forEach(s=>$(s).addEventListener('input',render));
setInterval(refresh,5000);
setInterval(refreshEm,15000);
</script>
</body></html>`;
}

export function writeDashboard(
  db: Database.Database,
  outPath: string = DASHBOARD_PATH,
  now: number = Date.now(),
): { count: number; path: string } {
  const views = toChatViews(db);
  const html = renderDashboard(views, now, {}, getDefaultAgent(db));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, html, 'utf-8');
  return { count: views.length, path: outPath };
}
