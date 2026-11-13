import { PENDING_VIEW_JS } from './pendingview.ts';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { getDefaultAgent } from './db.ts';
import { DASHBOARD_PATH } from './paths.ts';
import { CHAT_MENU_JS } from './chatmenu.ts';
import { TERMDROP_JS } from './termdrop.ts';
import { TERMWARM_JS } from './termwarm.ts';
import { GROUPING_JS } from './grouping.ts';
import { SIDESORT_JS } from './sidesort.ts';
import { CLOSENAV_JS } from './closenav.ts';
import { SIDESEARCH_JS } from './sidesearch.ts';
import { JUMP_CSS, JUMP_PURE_JS, JUMP_VIEW_JS } from './jumpbox.ts';
import { chatTagMap, listTags, type TagInfo } from './tags.ts';
import { BRAND_ICONS_CSS, BRAND_ICONS_JS, BRAND_SVG } from './brandicons.ts';
import { ORCH_VIEW_CSS, ORCH_VIEW_HTML, ORCH_VIEW_JS } from './orchview.ts';
import { SETTINGS_VIEW_CSS, SETTINGS_VIEW_HTML, SETTINGS_VIEW_JS } from './settingsview.ts';
import { WIZARD_VIEW_CSS, WIZARD_VIEW_HTML, WIZARD_VIEW_JS } from './wizardview.ts';
import { ERROR_VIEW_CSS, ERROR_VIEW_JS } from './errorview.ts';
import { LOGO_SVG, threadMark } from './logo.ts';
import { SKY_JS } from './skyview.ts';
import { WELCOME_BOOT_CSS, WELCOME_VIEW_CSS, WELCOME_VIEW_JS, welcomeHtml } from './welcomeview.ts';
import { CONNECT_VIEW_CSS, CONNECT_VIEW_JS } from './connectview.ts';
import { TOUR_VIEW_CSS, TOUR_VIEW_HTML, TOUR_VIEW_JS } from './tourview.ts';
import { WATCHER_VIEW_CSS, WATCHER_VIEW_HTML, WATCHER_VIEW_JS } from './watcherview.ts';
import { pageKeymapJson } from './keymap.ts';
import { TEST_LINKS_CSS, TEST_LINKS_VIEW_JS } from './testlinks.ts';
import { PRUNE_HIST_HTML, PRUNE_VIEW_CSS, PRUNE_VIEW_HTML, PRUNE_VIEW_JS } from './pruneview.ts';
import { SLACK_MENU_CSS, SLACK_MENU_PURE_JS, SLACK_MENU_VIEW_JS } from './slackmenu.ts';
import { PRCI_CSS, PRCI_PURE_JS, PRCI_VIEW_JS } from './prci.ts';
import { OUTBOX_PURE_JS, OUTBOX_VIEW_CSS, OUTBOX_VIEW_JS } from './outboxview.ts';
import { UPDATE_HEADER_HTML, UPDATE_VIEW_CSS, UPDATE_VIEW_JS } from './updateview.ts';
import { SLACKMD_JS } from './slackmd.ts';
import { SHIPMODAL_CSS, SHIPMODAL_HTML, SHIPMODAL_JS } from './shipmodal.ts';
import { OVERLAY_CSS } from './overlayview.ts';
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
  started_at: number;
  last_active_at: number; // the file's last write of any kind
  last_turn_at: number; // the last prompt or reply; 0 until re-indexed
  activity: Record<string, number>;
  summary_pending: boolean;
  saved: boolean;
  saved_at: number;
  tags: string[]; // tag names, name order
  pane_name?: string; // the last pane @name seen for this chat (live name wins client-side)
  done?: boolean; // ended by Send & close: off the board, still in All history
}

export function toChatViews(db: Database.Database): ChatView[] {
  const rows = db
    .prepare(
      `SELECT c.*, t.title AS title_override,
         EXISTS (SELECT 1 FROM chat_hidden h2 WHERE h2.agent = c.agent AND h2.session_id = c.session_id AND h2.via = 'close' AND c.last_active_at <= h2.hidden_at) AS done_flag
       FROM chats c
       LEFT JOIN chat_titles t ON t.agent = c.agent AND t.session_id = c.session_id
       WHERE NOT EXISTS (
         SELECT 1 FROM chat_hidden h
         WHERE h.agent = c.agent AND h.session_id = c.session_id AND h.via <> 'close' AND c.last_active_at <= h.hidden_at
       )
       ORDER BY c.last_active_at DESC`,
    )
    .all() as (ChatRow & { title_override: string | null; done_flag: number })[];
  const tagsByChat = chatTagMap(db);
  return rows.map((r) => ({
    agent: r.agent,
    session_id: r.session_id,
    project: path.basename(r.project_dir || 'unknown'),
    project_dir: r.project_dir,
    jsonl_path: r.jsonl_path,
    title: r.title_override || r.title || r.claude_auto_title || '',
    claude_auto_title: r.claude_auto_title,
    pr_url: r.pr_url,
    overview: r.overview,
    state: r.state,
    breakdown: safeArray(r.breakdown_json),
    first_message: r.first_message,
    message_count: r.message_count,
    started_at: r.started_at,
    last_active_at: r.last_active_at,
    last_turn_at: r.last_turn_at ?? 0,
    activity: safeObj(r.activity_json),
    summary_pending: r.summary_dirty === 1 && !r.title,
    saved: r.saved === 1,
    saved_at: r.saved_at,
    done: r.done_flag === 1,
    tags: tagsByChat.get(`${r.agent}:${r.session_id}`) ?? [],
    pane_name: r.last_pane_name || '',
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

// The mark lives in src/logo.ts so the wizard and settings can use it too.
export { LOGO_SVG } from './logo.ts';

export const APP_NAME = 'Loom';

/** The header wordmark's L: the logo's ribbon l without its tile, knocked out against the header's colour. */
export const WORDMARK_L_SVG =
  '<svg class="wm-l" width="15" height="15" viewBox="190 180 650 640" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><clipPath id="loom-wm-x"><rect x="340" y="500" width="230" height="220"/></clipPath></defs><g fill="none" stroke-linecap="round"><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="30"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(0 0)" stroke="#ffb238" stroke-width="30"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="30"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="#11141d" stroke-width="66" clip-path="url(#loom-wm-x)"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(0 0)" stroke="#11141d" stroke-width="66" clip-path="url(#loom-wm-x)"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="#11141d" stroke-width="66" clip-path="url(#loom-wm-x)"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="30"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(0 0)" stroke="#ffb238" stroke-width="30"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="30"/></g></svg>';

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
  stage?: string; // the pane classifier's @stage (discovery | implementation | shipping | thread | blocked)
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
  // The embedded terminal's per-launch secret (ptybridge.ts). Only the live
  // server passes it; the dashboard.html written to disk never carries one.
  termToken = '',
  // The orchestrator's sidebar entry (orchserver.orchSummary); refreshed by every poll.
  orch: unknown = null,
  // Tag definitions (name, colour, count); chats carry only the names.
  tags: TagInfo[] = [],
  // First-paint gate (routes/wizard.ts firstPaint). With welcome set, the page
  // is served with the welcome screen already open and the board hidden, so a
  // first launch never paints a frame of the board before it.
  boot: { welcome?: boolean } = {},
): string {
  const welcomeFirst = !!boot.welcome;
  const data = JSON.stringify({ generatedAt, defaultAgent, chats: views, live, slackOwners, drafts, orch, tags })
    // Chat titles and draft text are untrusted: a literal </script> must not end the block.
    .replace(/</g, '\\u003c');
  const favicon = 'data:image/svg+xml,' + encodeURIComponent(LOGO_SVG);
  // All rendering is client-side from DATA; HTML below is a static shell.
  return `<!doctype html>
<html lang="en"${welcomeFirst ? ' class="lw-first"' : ''}><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${APP_NAME}</title>
<link rel="icon" href="${favicon}"/>
<style>
${OVERLAY_CSS}
${WELCOME_BOOT_CSS}
  :root { color-scheme: dark;
    --done:#2ea043; --waiting_on_user:#3b82f6; --warning:#d4a72c; --error:#e5484d; --pending:#6b7280; }
  body { margin:0; background:#0d0f15; color:#e6e6e6; font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif; }
  header { padding:14px 20px; border-bottom:1px solid #232634; position:sticky; top:0; z-index:5;
    background:linear-gradient(180deg,#141826,#0d0f15); }
  /* Header: brand + jump box + connections + actions / tabs. Nothing wraps to a third row.
     Every control in them is 32px tall with an 8px radius and the same border,
     except the chips, which are deliberately smaller so the tabs read as primary. */
  .topbar { display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .hleft { display:flex; align-items:center; gap:12px; flex:1 1 auto; min-width:0; }
  .hleft .tabs { min-width:0; overflow-x:auto; scrollbar-width:none; }
  .hleft .tabs::-webkit-scrollbar { display:none; }
  .tab { flex:none; white-space:nowrap; }
  .actions { display:flex; gap:8px; align-items:center; flex:none; }
  .actions button { height:32px; box-sizing:border-box; border-radius:8px; padding:0 12px; }
  .brand { display:flex; align-items:center; gap:10px; flex:none; }
  /* The wordmark: the logo's ribbon l (no tile) stands in for the L, then 'oom' in the ribbon's amber to blue. */
  .brand h1.wordmark { display:flex; align-items:baseline; gap:0; line-height:1;
    background:none; -webkit-background-clip:border-box; background-clip:border-box; color:inherit; }
  .brand h1.wordmark span { background:linear-gradient(90deg,#ffb238,#5ec8ff); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .brand h1 { font-size:18px; margin:0; font-weight:700; letter-spacing:.3px;
    background:linear-gradient(90deg,#79b1ff,#7ee0a0); -webkit-background-clip:text; background-clip:text; color:transparent; }
  .brand .sub { color:#8b93a7; font-size:12px; }
  .stalechip { color:#e0b050 !important; }
  .stalechip.bad { color:#ee7b7b !important; }
  /* Primary view switch — a segmented control, kept distinct from the filters below */
  .tabs { display:inline-flex; flex:none; height:32px; box-sizing:border-box; background:#141826; border:1px solid #2b3040; border-radius:8px; padding:2px; gap:2px; }
  .tab { height:26px; background:transparent; border:0; color:#8b93a7; border-radius:6px; padding:0 14px; cursor:pointer; font-size:13px; font-weight:600; transition:background .15s, color .15s; }
  .tab:hover { color:#c4ccdc; background:#1b2233; }
  .tab.on { background:#26304a; color:#fff; }
  .tab.on:hover { background:#2b3654; }
  .tab .cnt { opacity:.6; margin-left:6px; }
  .tab.savedtab.on { background:#3a3826; color:#f0dfa0; }
  .tab.savedtab.on:hover { background:#46432e; }
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
  /* Watchers — Slack channels Loom polls itself; reuses the EM row styles. */
  .tab.watchtab.on { background:#3a2b46; color:#e0c8f5; }
  .tab.watchtab.on:hover { background:#45345a; }
  #watch-section, #settings-section { display:none; padding:0 20px 24px; }
${SETTINGS_VIEW_CSS}
${CONNECT_VIEW_CSS}
${PRUNE_VIEW_CSS}
  .emrow.w-on { border-left-color:var(--done); }
  .emrow.w-err { border-left-color:var(--error); }
  .emrow.w-queued { border-left-color:var(--waiting_on_user); }
  .wrow { display:flex; align-items:center; gap:10px; }
  .wrow .grow { flex:1; min-width:0; }
  .emrow a { color:#9cc0ff; text-decoration:none; }
  .emrow a:hover { text-decoration:underline; }
  .wgo { font:inherit; font-size:11px; padding:2px 8px; border:1px solid #2b3040; border-radius:6px; background:#1b1f2a; color:#c4ccdc; cursor:pointer; }
  .wgo:hover { border-color:#4d5b80; color:#fff; }
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
     selected; syncControls() owns the toggle, same as #watch-section. */
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
  /* Tickets — the board's chats in columns (Needs you, Blocked, then stage),
     beside the shared detail panel. Hidden until its tab is selected;
     syncControls() owns the toggle. */
  .tab.tktab.on { background:#2a3a52; color:#cfe0ff; }
  .tab.tktab.on:hover { background:#334664; }
  .vh { position:absolute; left:-9999px; }
  .tkboard { display:none; gap:10px; align-items:start; overflow-x:auto; padding-bottom:6px; }
  .tkx .col { display:flex; flex-direction:column; gap:8px; min-width:0; }
  .tkx .colhd { display:flex; align-items:baseline; justify-content:space-between; padding:0 2px 2px; border-bottom:1px solid #232634; }
  .tkx .colnm { font-size:12px; font-weight:700; color:#8b93a7; text-transform:uppercase; letter-spacing:.6px; }
  .tkx .colct { font-size:12px; color:#8b93a7; display:flex; align-items:center; gap:6px; }
  .tkx .rail { display:flex; flex-direction:column; align-items:center; gap:10px; background:#11141d; border:1px solid #232634; border-radius:10px; padding:10px 0; min-height:420px; cursor:pointer; }
  .tkx .rail:hover { border-color:#3a4258; }
  .tkx .rail .nm { writing-mode:vertical-rl; transform:rotate(180deg); font-size:11px; font-weight:700; color:#8b93a7; text-transform:uppercase; letter-spacing:.6px; }
  .tkx .rail .ct { font-size:12px; font-weight:700; color:#c4ccdc; background:#1b1f2a; border:1px solid #2b3040; border-radius:999px; padding:1px 7px; }
  .tkx .rail button, .tkx .colct button { background:transparent; border:0; color:#8b93a7; font-size:14px; padding:0; line-height:1; }
  .tkx .rail button:hover, .tkx .colct button:hover { color:#e6e6e6; background:transparent; }
  .tkx .tk { background:#161a24; border:1px solid #232634; border-left:4px solid var(--pending); border-radius:10px; padding:9px 11px; display:flex; flex-direction:column; gap:5px; text-align:left; color:#e6e6e6; width:100%; box-sizing:border-box; font:inherit; }
  .tkx .tk:hover { background:#1a1f2c; }
  .tkx .tk.sel { background:#1b2233; border-color:#3b4a6b; border-left-color:var(--waiting_on_user); }
  .tkx .tk.you { border-left-color:var(--waiting_on_user); }
  .tkx .tk.work { border-left-color:var(--done); }
  .tkx .tk.bad { border-left-color:var(--error); }
  .tkx .tk.stale { border-left-color:var(--warning); }
  .tkx .tk { overflow:hidden; }
  .tkx .col.wait .colhd { border-bottom-color:#3a4258; }
  .tkx .col.c-needsYou .colnm { color:var(--waiting_on_user); } .tkx .col.c-blocked .colnm { color:#ffaf5f; }
  .tkx .lbl.stg { background:transparent; border:1px solid #2b3040; color:#8b93a7; }
  .tkx .blk { font-size:11px; color:#ffd7a8; background:#3a2a1a; border:1px solid #5a3f22; border-radius:4px; padding:0 6px; line-height:16px; display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box; }
  .tkx .g.b { color:#ffaf5f; } .tkx .tk.blkd { border-left-color:#ffaf5f; }
  .tkx .tkh { display:flex; align-items:center; gap:6px; font-size:11px; color:#8b93a7; flex-wrap:wrap; }
  .tkx .num { font-weight:700; color:#c4ccdc; }
  .tkx .lbl { font-size:10px; padding:0 5px; border-radius:4px; background:#232634; color:#aab3c5; line-height:16px; }
  .tkx .lbl.bug { background:#3a2227; color:#f0a0a8; } .tkx .lbl.feat { background:#1f3a2c; color:#a8e6c0; }
  .tkx .lbl.otto { background:#2b3446; color:#bcd2f5; } .tkx .lbl.auto { background:#3a3826; color:#f0dfa0; }
  .tkx .age { margin-left:auto; }
  .tkx .ttl { font-size:13px; line-height:1.3; color:#e6e6e6; }
  .tkx .who { font-size:12px; color:#c4ccdc; display:flex; align-items:center; gap:6px; min-width:0; }
  .tkx .who .g { font-weight:700; } .tkx .g.w { color:var(--done); } .tkx .g.y { color:var(--waiting_on_user); } .tkx .g.i { color:#8b93a7; } .tkx .g.r { color:var(--error); }
  .tkx .pn { color:#8b93a7; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tkx .pr { display:flex; align-items:center; gap:6px; font-size:11px; color:#8b93a7; }
  .tkx .pr .n { color:#c4ccdc; font-weight:600; }
  .tkx .s { display:inline-block; width:9px; height:9px; border-radius:50%; border:1.5px solid #6b7280; box-sizing:border-box; flex-shrink:0; }
  .tkx .s.ok { background:var(--done); border-color:var(--done); } .tkx .s.run { background:var(--waiting_on_user); border-color:var(--waiting_on_user); } .tkx .s.no { background:var(--error); border-color:var(--error); }
  .tkx .need { font-size:11px; color:#cfe0ff; background:#1f2d4a; border:1px solid #2f4470; border-radius:4px; padding:0 6px; line-height:16px; display:inline-block; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; box-sizing:border-box; }
  .tkx .panel { position:sticky; top:calc(var(--hh,150px) + 16px); max-height:calc(100vh - var(--hh,150px) - 32px); overflow-y:auto; background:#11141d; border:1px solid #232634; border-radius:12px; padding:14px 16px; display:flex; flex-direction:column; gap:14px; min-width:0; box-sizing:border-box; }
  .tkx .ph { display:flex; flex-direction:column; gap:6px; }
  .tkx .ph h2 { margin:0; font-size:16px; line-height:1.3; }
  .tkx .ph h2 a { color:inherit; text-decoration:none; } .tkx .ph h2 a:hover { text-decoration:underline; }
  .tkx .meta { font-size:12px; color:#8b93a7; margin:0; }
  .tkx .pill { display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:600; color:#cfe0ff; background:#1f2d4a; border:1px solid #2f4470; border-radius:999px; padding:2px 10px; }
  .tkx .pill .dot { display:inline-block; width:8px; height:8px; border-radius:50%; }
  .tkx .sec { display:flex; flex-direction:column; gap:8px; }
  .tkx .sech { font-size:11px; font-weight:700; color:#8b93a7; text-transform:uppercase; letter-spacing:.6px; }
  .tkx .tl { display:flex; flex-direction:column; gap:0; border-left:2px solid #232634; margin-left:5px; padding-left:12px; }
  .tkx .tls { display:flex; align-items:baseline; gap:8px; font-size:12px; padding:3px 0; position:relative; }
  .tkx .tls .m { position:absolute; left:-19px; top:9px; width:10px; height:10px; border-radius:50%; background:var(--done); }
  .tkx .tls.now .m { background:var(--waiting_on_user); box-shadow:0 0 0 3px #1f2d4a; }
  .tkx .tls.todo .m { background:#0d0f15; border:2px solid #3a4258; box-sizing:border-box; }
  .tkx .tls .w { color:#e6e6e6; font-weight:600; min-width:92px; }
  .tkx .tls.todo .w { color:#6f778a; }
  .tkx .tls .d { color:#8b93a7; }
  .tkx .row { display:flex; align-items:center; gap:10px; font-size:12px; background:#161a24; border:1px solid #232634; border-radius:8px; padding:8px 10px; }
  .tkx .row.pick { cursor:pointer; } .tkx .row.pick:hover { background:#1a2030; border-color:#3a4a63; }
  .tkx .row .grow { flex:1; min-width:0; }
  .tkx .row .t { color:#e6e6e6; }
  .tkx .row .m2 { color:#8b93a7; font-size:11px; }
  .tkx .sbtn { height:26px; box-sizing:border-box; border-radius:6px; padding:0 10px; background:#1b1f2a; border:1px solid #2b3040; color:#c4ccdc; font-size:12px; font-weight:600; white-space:nowrap; text-decoration:none; display:inline-flex; align-items:center; font-family:inherit; }
  .tkx .sbtn:hover { background:#222a3d; color:#fff; }
  .tkx .sbtn.pri { background:#26304a; border-color:#3b4a6b; color:#fff; }
  .tkx .ev { display:flex; gap:8px; font-size:12px; color:#c4ccdc; }
  .tkx .ev .at { color:#8b93a7; min-width:44px; flex-shrink:0; }
  .tkx .ev.good { color:#a8e6c0; } .tkx .ev.bad { color:#f0a0a8; }
  .tkx .acts { display:flex; gap:6px; flex-wrap:wrap; }
  .tkx .tkempty { color:#6f778a; font-size:12.5px; padding:6px 2px; }
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
  button.gearbtn { display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; padding:0; background:transparent; color:#8b93a7; }
  button.gearbtn:hover { background:#2b3040; color:#fff; }
  button.gearbtn.on { background:#26304a; color:#fff; }
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
  #archive { padding:0 0 26px; }
  #archive:empty { display:none; }
  .ahead { display:flex; align-items:center; gap:10px; margin-top:4px;
    color:#8b93a7; font-size:11px; text-transform:uppercase; letter-spacing:.6px; }
  .ahead::after { content:''; flex:1; height:1px; background:#232634; }
  #sidelist .ahead { margin:0; padding:12px 16px 6px; font-weight:600; letter-spacing:.06em; color:#8a90a2; }
  #sidelist .ahead .cnt { margin-left:0; }
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
  #composer { z-index:20; background:rgba(0,0,0,.55); }
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
    border-left:1px solid #232634; padding:16px 20px 28px; display:flex; flex-direction:column; gap:14px; }
  .card.sel { border-color:#5c6b93; background:#1d2433; box-shadow:0 0 0 1px #5c6b93 inset; }
  .dsec { display:flex; flex-direction:column; gap:6px; min-width:0; }
  .dsec > h3 { font-size:11px; text-transform:uppercase; letter-spacing:.6px; color:#8b93a7; margin:0; font-weight:600; display:flex; align-items:center; gap:8px; }
  .dsec > h3 .n { opacity:.6; font-weight:400; text-transform:none; letter-spacing:0; }
  .dtitle { font-size:16px; font-weight:700; line-height:1.3; }
  .dsub { color:#8b93a7; font-size:12px; }
  .drow { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:12.5px; color:#c4ccdc; }
  .stage { font-size:11px; font-weight:700; padding:2px 8px; border-radius:999px; background:#1b1f2a; border:1px solid currentColor; }
  .stage.s-discovery { color:#5fafff; } .stage.s-implementation { color:#87d787; }
  .stage.s-shipping { color:#d787d7; } .stage.s-thread { color:#ffaf5f; } .stage.s-blocked { color:#ff875f; }
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
  /* ---- Layout: session sidebar + the selected chat ---------------------------
     The header is brand + actions and the view tabs. Everything that filters
     the session list lives at the top of the sidebar; the chat fills the rest. */
  .sidetoggle { height:32px; width:34px; padding:0; border-radius:8px; background:#141826; border:1px solid #2b3040; color:#8b93a7; font-size:14px; }
  .sidetoggle:hover { color:#e6e6e6; }
  #boardwrap { display:grid; grid-template-columns:var(--sidew,360px) minmax(0,1fr); height:calc(100vh - var(--hh,100px)); }
  /* The session list's width: drag its right edge, arrow keys on the handle, double-click to reset. */
  #side { position:relative; }
  .sidegrip { position:absolute; top:0; right:0; bottom:0; width:6px; cursor:col-resize; z-index:3; background:transparent; transition:background .12s; }
  .sidegrip:hover, .sidegrip:focus-visible, body.sideresizing .sidegrip { background:#3a63b8; outline:none; }
  body.sideresizing, body.sideresizing * { cursor:col-resize !important; user-select:none !important; }
  body.sidehide #boardwrap { grid-template-columns:minmax(0,1fr); }
  body.sidehide #side { display:none; }
  #boardwrap.tk { grid-template-columns:minmax(0,1fr); height:auto; }
  #boardwrap.tk #side, #boardwrap.tk #chatmain { display:none; }
  #boardwrap.tk #kanban { padding:16px 20px; }
  #side { border-right:1px solid #232634; background:#0f1218; display:flex; flex-direction:column; min-height:0; min-width:0; overflow:hidden; }
  .sidetop { padding:10px 10px 8px; border-bottom:1px solid #1d2130; display:flex; flex-direction:column; gap:8px; }
  .sidetop .controls { flex-direction:column; align-items:stretch; gap:6px; flex:none; }
  .sidetop input, .sidetop select { height:30px; box-sizing:border-box; border-radius:8px; padding:0 9px; width:100%; min-width:0; }
  .sidetop .two { display:flex; gap:6px; }
  .sidetop #row3 { display:flex; flex-direction:column; gap:6px; margin:0; }
  .sidetop .seg { margin-left:0; align-self:flex-start; }
  #sidelist { flex:1; min-height:0; overflow-y:auto; padding:2px 0 12px; }
  #archive { padding:0; max-width:none; display:block; }
  .sidehint { padding:14px 16px 4px; font-size:11px; color:#6f778a; }
  .sgrp { padding:12px 16px 6px; font-size:11px; font-weight:600; letter-spacing:.06em; text-transform:uppercase; color:#8a90a2; display:flex; justify-content:space-between; }
  .sgrp .cnt { opacity:.6; }
  .sidetop { position:relative; padding:10px 10px 6px; gap:6px; }
  .searchrow { display:flex; gap:6px; }
  .sidetop .controls, .sidetop .searchrow { width:100%; box-sizing:border-box; }
  .shipbody .shipmate { max-width:100%; }
  .shipbody .shc { min-width:0; max-width:100%; }
  .fbtn { position:relative; flex:none; width:30px; height:30px; padding:0; border-radius:8px; border:1px solid #2b3040; background:#1b1f2a; color:#c4ccdc; display:grid; place-items:center; cursor:pointer; }
  .fbtn:hover, .fbtn.open { border-color:#4d5b80; background:#222a3d; color:#fff; }
  .fbtn .pip { position:absolute; top:3px; right:3px; width:7px; height:7px; border-radius:50%; background:#6ea2ff; box-shadow:0 0 0 2px #1b1f2a; }
  .fbtn .pip[hidden] { display:none; }
  .fchips { display:flex; gap:6px; flex-wrap:wrap; }
  .fchips:empty { display:none; }
  .fchip { display:inline-flex; align-items:center; gap:5px; height:22px; background:#222a3d; border:1px solid #4d5b80; color:#dbe6ff; border-radius:999px; padding:0 4px 0 9px; font-size:11.5px; cursor:pointer; font-family:inherit; }
  .fchip i { font-style:normal; color:#8b93a7; width:15px; height:15px; border-radius:50%; display:grid; place-items:center; font-size:10px; }
  .fchip:hover i { background:#34406a; color:#fff; }
  .fpop { position:absolute; z-index:20; top:48px; left:10px; right:10px; background:#171b27; border:1px solid #3a4258; border-radius:10px; padding:12px; box-shadow:0 12px 32px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:10px; }
  .fpop[hidden] { display:none; }
  .fpop label { font-size:11px; color:#8b93a7; text-transform:uppercase; letter-spacing:.06em; display:block; margin-bottom:3px; }
  .fpop .fck { display:flex; align-items:center; gap:8px; text-transform:none; letter-spacing:0; font-size:12.5px; color:#c4ccdc; margin:0 0 4px; cursor:pointer; }
  .fpop .fck input { width:auto; height:auto; }
  .fpop .tagbtn { width:100%; flex:none; }
  .fpop .seg { display:flex; width:100%; } .fpop .seg button { flex:1; }
  .sgrp { cursor:pointer; user-select:none; padding:8px 16px 4px; }
  .sgrp:hover { color:#c4ccdc; }
  .sgrp .car { display:inline-block; width:12px; font-size:9px; transition:transform .15s; }
  .sgrp.closed .car { transform:rotate(-90deg); }
  .smk { font-size:11px; margin-right:4px; color:#6ea2ff; } .smk.wipm { color:#e8b04a; } .smk.hot { color:#e8b04a; }
  .shipln { margin:0 8px 6px; border-radius:8px; border:1px solid #232634; background:#161a24; font-size:12.5px; overflow:hidden; }
  .shipln .shipbar { display:flex; align-items:center; gap:7px; width:100%; height:30px; padding:0 10px; border:0; background:transparent; color:#8b93a7; font:inherit; text-align:left; cursor:pointer; white-space:nowrap; }
  .shipln .shipbar .sl { overflow:hidden; text-overflow:ellipsis; min-width:0; }
  .shipln .chev { margin-left:auto; transition:transform .15s; }
  .shipln.open .chev { transform:rotate(90deg); }
  .shipln.idle .shipbar { opacity:.75; }
  .shipln.unstaged { border-left:3px solid #8b93a7; }
  .shipln.unstaged .shipbar { color:#c4ccdc; }
  .shipln.staged { border-left:3px solid #6ea2ff; background:rgba(110,162,255,.12); }
  .shipln.staged .shipbar { color:#9cc4ff; font-weight:600; }
  .shipln.shipping { background:rgba(232,176,74,.14); border-color:rgba(232,176,74,.5); border-left:3px solid #e8b04a; }
  .shipln.shipping .shipbar { color:#e8b04a; font-weight:700; }
  .pdot { width:8px; height:8px; border-radius:50%; background:#e8b04a; flex:none; animation:shippulse 1.2s ease-in-out infinite; }
  @keyframes shippulse { 0%,100%{opacity:.35;transform:scale(.85)} 50%{opacity:1;transform:scale(1.1)} }
  @media (prefers-reduced-motion:reduce) { .pdot { animation:none; } }
  .shipbody { border-top:1px solid #232634; padding:8px 10px; display:flex; flex-direction:column; gap:7px; font-size:12.5px; color:#b8bfcc; }
  .shipbody .sh { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .shipbody .sh b { color:#e6e9ef; }
  .srow { display:flex; gap:10px; align-items:flex-start; margin:0 8px 2px; padding:9px 10px; border-radius:8px; border:1px solid transparent; cursor:pointer; position:relative; }
  .srow:hover { background:#151925; }
  .srow.sel { background:#1a2033; border-color:#34406a; }
  .srow.arch { opacity:.85; }
  .srow.age-today { background:#16150f; }
  .srow.age-yday { background:#1f1a0e; box-shadow:inset 3px 0 0 #6b5420; }
  .srow.age-old { background:#221316; box-shadow:inset 3px 0 0 #7a3236; }
  .srow.age-today:hover, .srow.age-yday:hover, .srow.age-old:hover { background:#151925; }
  .srow.sel.age-today, .srow.sel.age-yday, .srow.sel.age-old { background:#1a2033; }
  .srow.ghost { opacity:.7; cursor:default; }
  .srow.ghost.failed { opacity:1; background:#2a1215; border-color:#7a3236; }
  .srow.ghost.failed .stitle { color:#ff8b8f; }
  .sdot.d-failed { background:#e5484d; }
  .lpane { margin:6px 0 0; padding:6px 8px; max-height:150px; overflow:auto; background:#120a0c; border-radius:6px; font:11px/1.35 ui-monospace,monospace; color:#c9a3a5; white-space:pre-wrap; word-break:break-all; }
  .lacts { display:flex; gap:6px; margin-top:6px; }
  .lacts button { background:#3a1a1e; color:#ffd0d2; border:1px solid #7a3236; border-radius:6px; padding:3px 9px; font-size:12px; cursor:pointer; }
  .lacts button:hover { background:#4a2227; }
  .srow:focus-visible { outline:1px solid #5c6b93; }
  .sdot { flex:0 0 8px; height:8px; border-radius:4px; margin-top:6px; background:var(--pending); display:inline-block; }
  .sdot.d-working { background:#e8b04a; animation:pulse 1s ease-in-out infinite; }
  .sdot.d-turn { background:#6ea2ff; }
  .sdot.d-done { background:var(--done); }
  .sdot.d-warn { background:var(--warning); }
  .sdot.d-error { background:var(--error); }
  .sdot.d-stale { background:#4a5060; }
  .sbody { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px; }
  .stitle { font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .cname { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; color:#8a90a2; margin-left:6px; }
  .ssub .cname { margin-left:0; }
  .cname .cpi { font:inherit; font-size:12px; line-height:1; color:#8a90a2; background:transparent; border:1px solid transparent; border-radius:4px; padding:1px 4px; margin-left:4px; cursor:pointer; visibility:hidden; vertical-align:baseline; }
  .srow:hover .cname .cpi, .mh-sub:hover .cname .cpi, .cname .cpi:focus-visible { visibility:visible; }
  .cname .cpi:hover { color:#e4e7ee; background:#222a3d; border-color:#34406a; }
  .sstate { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:#8a90a2; }
  .sstate.d-working { color:#e0c04a; } .sstate.d-turn { color:#6ea0ff; }
  .ssub { font-size:12px; color:#8a90a2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .sright { flex:0 0 auto; display:flex; flex-direction:column; align-items:flex-end; gap:4px; max-width:46%; }
  .sage { font-size:11px; color:#8a90a2; }
  .schips { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; align-items:center; }
  .chp { font-size:10px; padding:1px 6px; border-radius:4px; white-space:nowrap; }
  .chp.pr { background:#15301d; color:#9fe0aa; }
  .chp.sl { background:#2a2140; color:#c9b4ff; }
  .chp.dr { background:#3a2238; color:#e8a6e0; }
  .chp.dr.stl { opacity:.5; }
  .chp.rp { background:#1d3b2c; color:#a6e8c0; }
${SLACK_MENU_CSS}
${PRCI_CSS}
${TEST_LINKS_CSS}
  .sdot.d-wait { background:#6a7ba8; box-shadow:0 0 0 2px rgba(106,123,168,.25); }
  .parkbar { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
  #chatmain { display:flex; flex-direction:column; min-width:0; min-height:0; position:relative; }
  #chatmain.empty > :not(#mempty):not(#mpending):not(#mhero) { display:none !important; }
  /* The empty board: a quiet sky (src/skyview.ts), the mark, one line and the next step. */
  #mhero { display:none; position:absolute; inset:0; overflow:hidden; background:#05060b; }
  #chatmain.empty.hero #mhero { display:flex; align-items:center; justify-content:center; }
  #chatmain.empty.hero #mempty { display:none !important; }
  #mhero canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
  #mhero .hx-in { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:14px; text-align:center; max-width:520px; padding:24px; }
  #mhero .hx-mark { width:92px; height:auto; overflow:visible; filter:drop-shadow(0 0 5px rgba(255,178,56,.4)) drop-shadow(0 0 18px rgba(255,95,143,.3)) drop-shadow(0 0 32px rgba(94,200,255,.25)); }
  #mhero h2 { margin:6px 0 0; font-size:22px; font-weight:600; color:#eef1fb; letter-spacing:.01em; }
  #mhero p { margin:0; color:#a3a9be; font-size:14px; line-height:1.55; text-wrap:balance; }
  #mhero .hx-acts { display:flex; flex-wrap:wrap; justify-content:center; gap:10px; margin-top:10px; }
  #mhero .hx-acts button { height:36px; padding:0 16px; border-radius:9px; font:inherit; font-size:13.5px; cursor:pointer; border:1px solid #2b3040; background:rgba(20,24,38,.8); color:#dfe4f2; }
  #mhero .hx-acts button:hover { border-color:#4a5578; color:#fff; }
  #mhero .hx-acts button.pri { border:1px solid transparent; color:#fff; font-weight:600;
    background:linear-gradient(rgba(14,16,28,.9), rgba(14,16,28,.9)) padding-box, linear-gradient(90deg,#ff5f8f,#ffb238,#5ec8ff) border-box; }
  #mhero .hx-acts button:focus-visible { outline:2px solid #5ec8ff; outline-offset:3px; }
  /* Opening / resuming: shown the moment the view switches, until the pane is there. */
  #mpending.loverlay { z-index:30; background:rgba(11,13,19,.72); }
  .mpcard { display:flex; align-items:center; gap:12px; max-width:440px; padding:14px 18px; border-radius:10px; border:1px solid #2a2f40; background:#121620; color:#e4e7ee; font-size:13px; }
  .mpcard b { display:block; font-weight:600; }
  .mpcard span.mpd { display:block; color:#8a90a2; margin-top:2px; }
  #mpending.err { pointer-events:none; background:transparent; }
  #mpending.err .mpcard { pointer-events:auto; }
  #mpending.err .mpcard { border-color:#6b2a2e; background:#1d1215; }
  #mpending .mpcard.mperr { max-width:560px; flex-direction:column; align-items:stretch; padding:12px; }
  /* Opening a chat from Slack: the welcome screen's night sky over the main area, the mark
     weaving its three threads, until the chat is there (src/pendingview.ts, renderSlackOpening). */
  #mpending.mpslack { position:absolute; inset:0; z-index:30; overflow:hidden; background:#05060b; display:flex; align-items:center; justify-content:center; animation:mpsl-in .2s ease both; }
  .mpslack canvas.mpsl-sky { position:absolute; inset:0; width:100%; height:100%; display:block; }
  .mpslack .mpsl-in { position:relative; z-index:1; display:flex; flex-direction:column; align-items:center; gap:8px; text-align:center; max-width:460px; padding:24px 16px; }
  .mpslack .mpsl-halo { position:absolute; width:300px; height:300px; max-width:80vw; left:50%; top:0; transform:translate(-50%,-30%); border-radius:50%; pointer-events:none;
    background:radial-gradient(circle, rgba(255,178,56,.10), rgba(255,95,143,.06) 40%, transparent 70%); }
  .mpslack .mpsl-mark { position:relative; width:88px; height:auto; overflow:visible; margin-bottom:10px;
    filter:drop-shadow(0 0 5px rgba(255,178,56,.45)) drop-shadow(0 0 18px rgba(255,95,143,.32)) drop-shadow(0 0 34px rgba(94,200,255,.28)); }
  .mpslack .mpsl-mark path[pathLength] { stroke-dasharray:1; stroke-dashoffset:1; animation:mpsl-weave 2.8s cubic-bezier(.6,0,.2,1) infinite; }
  .mpslack .mpsl-mark path.lw-t2[pathLength] { animation-delay:.45s; }
  .mpslack .mpsl-h { margin:0; font-size:20px; font-weight:600; color:#eef1fb; letter-spacing:.01em; }
  .mpslack .mpsl-where { margin:0; font-size:13.5px; font-weight:600; color:#e8a6e0; }
  .mpslack .mpsl-where:empty, .mpslack .mpsl-step:empty { display:none; }
  .mpslack .mpsl-step { margin:0; font-size:13px; color:#a3a9be; line-height:1.5; text-wrap:balance; }
  .mpslack .mpsl-bar { position:relative; width:180px; height:2px; margin:12px 0 6px; border-radius:2px; overflow:hidden; background:rgba(238,241,251,.08); }
  .mpslack .mpsl-bar i { position:absolute; top:0; bottom:0; width:40%; border-radius:2px; background:linear-gradient(90deg, transparent, #ff5f8f, #ffb238, #5ec8ff, transparent); animation:mpsl-comet 1.6s ease-in-out infinite; }
  .mpslack .mpsl-x { margin-top:8px; height:30px; padding:0 14px; border-radius:999px; font:inherit; font-size:12px; letter-spacing:.06em; cursor:pointer; border:1px solid #2b3040; background:rgba(14,16,28,.7); color:#a3a9be; }
  .mpslack .mpsl-x:hover { border-color:#4a5578; color:#eef1fb; }
  .mpslack .mpsl-x:focus-visible { outline:2px solid #5ec8ff; outline-offset:3px; }
  @keyframes mpsl-in { from { opacity:0; } }
  @keyframes mpsl-weave { 0% { stroke-dashoffset:1; } 45%, 70% { stroke-dashoffset:0; } 100% { stroke-dashoffset:-1; } }
  @keyframes mpsl-comet { from { left:-40%; } to { left:100%; } }
  @media (prefers-reduced-motion:reduce) { #mpending.mpslack { animation:none; } .mpslack .mpsl-mark path[pathLength] { animation:none; stroke-dashoffset:0; } .mpslack .mpsl-bar i { animation:none; left:30%; } }
  /* ...and the row that was selected before stops looking selected while it is up. */
  body.slackopen #sidelist .srow.sel { background:transparent; border-color:transparent; }
  body.slackopen #sidelist .srow.sel.age-today { background:#16150f; }
  body.slackopen #sidelist .srow.sel.age-yday { background:#1f1a0e; }
  body.slackopen #sidelist .srow.sel.age-old { background:#221316; }
  body.slackopen #kanban .tkx .tk.sel, body.slackopen .tkx .tk.sel { background:#161a24; border-color:#232634; }
  .mpacts { display:flex; gap:8px; justify-content:flex-end; margin-top:10px; flex-wrap:wrap; }
  .mpspin { width:16px; height:16px; flex-shrink:0; border:2px solid #2f3a55; border-top-color:#8fb4ff; border-radius:50%; animation:mpspin .7s linear infinite; }
  @keyframes mpspin { to { transform:rotate(360deg); } }
  #mempty { display:none; padding:20px; overflow-y:auto; }
  #chatmain.empty #mempty { display:block; }
  #mhead { display:flex; flex-wrap:wrap; align-items:center; gap:12px; padding:12px 20px; border-bottom:1px solid #232634; position:relative; }
  .mh-l { flex:1 1 300px; min-width:0; display:flex; flex-direction:column; gap:3px; }
  .mh-t { display:flex; align-items:center; gap:8px; min-width:0; }
  .mh-t .sdot { margin-top:0; }
  .mh-t h1 { margin:0; font-size:16px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mh-sub { font-size:12px; color:#8a90a2; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .mpill { font-size:11px; padding:2px 7px; border-radius:4px; background:#23262f; color:#9aa3b2; flex-shrink:0; }
  .mpill.d-working { background:rgba(232,176,74,.16); color:#e8b04a; }
  .mpill.d-turn { background:rgba(110,162,255,.16); color:#8fb4ff; }
  .mpill.d-done { background:rgba(46,160,67,.16); color:#56d364; }
  .mpill.d-warn { background:rgba(212,167,44,.18); color:#e3c050; }
  .mpill.d-error { background:rgba(229,72,77,.18); color:#ff8086; }
  .mpill.src { background:#243044; color:#a7c7ff; }
  .mh-r { display:flex; flex-wrap:wrap; gap:6px; align-items:center; }
  .mbtn { height:32px; box-sizing:border-box; padding:0 12px; border-radius:8px; border:1px solid #2a2f40; background:#151925; color:#e4e7ee; cursor:pointer; display:inline-flex; align-items:center; gap:6px; font:inherit; font-size:13px; text-decoration:none; }
  .mbtn:hover { background:#1c2232; }
  .mbtn.pri { background:#3b6fe0; border-color:#3b6fe0; color:#fff; font-weight:500; }
  .mbtn.pri:hover { background:#4a7cec; }
  .mbtn.on { background:#3a3826; border-color:#4a462f; color:#f0dfa0; }
  .mbtn.sq { width:32px; padding:0; justify-content:center; }
  .mbtn[disabled] { opacity:.45; cursor:default; }
  .pst { font-size:11px; color:#a3a9b8; }
  .pst.s-draft { color:#a3a9b8; } .pst.s-review { color:#e8b04a; } .pst.s-merged { color:#a7c7ff; } .pst.s-closed { color:#ff8086; }
  #mhead .picker { flex-basis:100%; margin-top:0; }
  #mtabs { display:flex; gap:2px; padding:0 20px; border-bottom:1px solid #232634; }
  .mtab { padding:8px 14px; border:0; border-bottom:2px solid transparent; border-radius:0; background:transparent; color:#8a90a2; font-weight:500; cursor:pointer; }
  .mtab:hover { color:#c4ccdc; background:transparent; }
  .mtab.on { color:#e4e7ee; border-bottom-color:#6ea2ff; }
  .mtab[disabled] { opacity:.45; cursor:default; }
  #mterm { flex:1 1 auto; min-height:0; margin:14px 20px; padding:6px 0 0 8px; border-radius:10px; border:1px solid #232634; background:#07080c; overflow:hidden; }
  .tcol { display:flex; flex-direction:column; height:100%; min-height:0; }
  .tcol.dropping { outline:2px dashed #6aa2ff; outline-offset:-4px; }
  .termwrap { flex:1 1 auto; min-height:0; width:100%; transform-origin:0 0; }
  .termwrap.mirror { flex:none; width:max-content; height:max-content; }
  .ttools { flex:none; display:flex; gap:6px; align-items:center; padding:0 8px 6px 0; font-size:12px; }
  .ttools button { height:24px; padding:0 9px; border-radius:6px; font-size:12px; }
  .ttools.off button { opacity:.45; pointer-events:none; }
  .ttools .tmsg { color:#e5a04d; font-size:11.5px; }
  .ttools .spacer { flex:1; }
  .tmore { position:relative; }
  .tmenu { position:absolute; right:0; top:28px; z-index:6; background:#141826; border:1px solid #2b3040; border-radius:8px; padding:4px; min-width:130px; box-shadow:0 12px 30px rgba(0,0,0,.45); }
  .tmenu[hidden] { display:none; }
  .tmenu button { width:100%; text-align:left; }
  .tmenu .danger { color:#ff8a8a; }
  /* The messages and the side column scroll on their own, so the latest message
     can be kept in view without scrolling the side column away. */
  #mtxwrap { flex:1 1 auto; min-height:0; overflow:hidden; padding:14px 20px 0; display:flex; flex-direction:column; gap:14px; }
  .mtxrow { flex:1 1 auto; min-height:0; display:flex; gap:20px; align-items:stretch; }
  #mmsgs { flex:999 1 420px; min-width:0; overflow-y:auto; display:flex; flex-direction:column; gap:9px; padding-bottom:16px; }
  #mdetail { flex:1 1 300px; max-width:420px; min-width:0; overflow-y:auto; display:flex; flex-direction:column; gap:14px; padding-bottom:16px; }
  #mmsgs .msg { max-width:100%; align-self:stretch; box-sizing:border-box; flex:none; }
  #mbanner:empty { display:none; }
  .banner { padding:12px 14px; border-radius:10px; border:1px solid #2a2f40; background:#121620; display:flex; flex-wrap:wrap; align-items:center; gap:12px; }
  .banner .bt { flex:1 1 260px; min-width:0; }
  .banner .bt b { display:block; }
  .banner .bt span { font-size:12px; color:#a3a9b8; }
  #mslack:empty { display:none; }
  #mslack { margin:14px 20px 0; }
  .banner.slack { border-color:#3a2f5c; background:#1a1528; align-items:flex-start; }
  .banner.slack .bt b { color:#e4dcff; }
  .banner.slack .bt span { color:#b8b0d4; }
  .banner.slack .slackq { margin-top:8px; padding:8px 10px; border-left:3px solid #6b5aa8; background:#120f1c; border-radius:4px; font-size:12px; color:#d6d0ea; max-height:84px; overflow:hidden; white-space:pre-wrap; overflow-wrap:anywhere; }
  .banner.slack .slackq b { display:inline; color:#d6d0ea; }
  .banner.slack select { max-width:280px; height:30px; border-radius:7px; border:1px solid #4a3d75; background:#120f1c; color:#d6ccff; }
  #mfoot:empty { display:none; }
  #ctx { position:fixed; z-index:30; width:250px; padding:6px; border-radius:10px; border:1px solid #2f3548; background:#171b28; box-shadow:0 14px 36px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:1px; }
  #ctx[hidden] { display:none; }
  .chp.tg { max-width:84px; overflow:hidden; text-overflow:ellipsis; }
  .chp.tg.more { color:#8a90a2 !important; background:#23262f !important; }
  .tgdot { display:inline-block; width:8px; height:8px; border-radius:4px; margin-right:6px; flex:0 0 8px; }
  .sgrp > span:first-child { display:flex; align-items:center; }
  .tagrow { align-items:center; }
  .tagbtn { flex:1; min-width:0; height:30px; border-radius:8px; border:1px solid #2b3040; background:#1b1f2a; color:#c4ccdc; text-align:left; padding:0 9px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12.5px; }
  .tagbtn.on { border-color:#4d5b80; color:#fff; background:#222a3d; }
  .tagrow .seg { margin-left:0; height:30px; flex:none; }
  .tagrow .seg button { height:24px; padding:0 10px; }
  .tagrow .seg button.on { background:#26304a; color:#fff; }
  #tagpop { position:fixed; z-index:30; width:240px; max-height:60vh; overflow-y:auto; padding:6px; border-radius:10px; border:1px solid #2f3548; background:#171b28; box-shadow:0 14px 36px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:1px; }
  #tagpop[hidden] { display:none; }
  .cmi.tg { justify-content:flex-start; gap:0; }
  .cmi.tg .tgn { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tgck { width:20px; color:#8fb4ff; }
  .cmtags { margin:2px 0 4px 8px; padding-left:6px; border-left:1px solid #2a2f40; display:flex; flex-direction:column; gap:1px; }
  .newtag { height:28px; box-sizing:border-box; margin:3px 4px 2px; border-radius:6px; padding:0 8px; width:calc(100% - 8px); }
  .mh-tags { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin-top:2px; }
  .mh-tags .chp.tg { max-width:160px; }
  .tgadd { height:20px; padding:0 8px; border-radius:4px; border:1px dashed #3a4258; background:transparent; color:#8a90a2; font-size:11px; }
  .tgadd:hover { color:#e4e7ee; border-color:#5c6b93; }
  .cmi { display:flex; justify-content:space-between; align-items:center; gap:8px; width:100%; padding:7px 10px; border:0; border-radius:6px; background:transparent; color:#e4e7ee; text-align:left; font-size:13px; cursor:pointer; }
  .cmi:hover { background:#222a3d; }
  .cmi.dis { color:#5d6273; cursor:default; }
  .cmi.dis:hover { background:transparent; }
  .cmi.danger { color:#f09a9f; }
  .cmi.danger.dis { color:#6b4a4e; }
  .cmh { font-size:11px; color:#8a90a2; }
  .cmdiv { height:1px; background:#2a2f40; margin:4px 2px; }
  #termbox { z-index:20; background:rgba(0,0,0,.55); }
  .sgrp .tnew { padding:0 7px; height:20px; font-size:13px; line-height:1; border-radius:5px; }
  .tsel-win { height:28px; border-radius:7px; padding:0 8px; }
  #renamebox { z-index:20; background:rgba(0,0,0,.55); }
  .rbox input { width:100%; box-sizing:border-box; height:34px; border-radius:8px; padding:0 10px; font:14px -apple-system,Segoe UI,Roboto,sans-serif; }
  #toast { position:fixed; left:50%; bottom:22px; transform:translateX(-50%); z-index:40; padding:7px 14px; border-radius:8px; background:#1f6f3f; color:#fff; font-size:12.5px; opacity:0; pointer-events:none; transition:opacity .2s; }
  #toast.on { opacity:1; }
  @media (max-width:900px) {
    #boardwrap { grid-template-columns:1fr; height:auto; }
    #side { max-height:44vh; border-right:0; border-bottom:1px solid #232634; }
    .sidegrip { display:none; }
    #chatmain { min-height:78vh; }
    header { padding:10px 12px; }
    #mtxwrap { overflow-y:auto; }
    .mtxrow { flex-direction:column; flex:none; }
    #mmsgs, #mdetail { overflow:visible; max-width:none; flex:none; }
    #mhead, #mtxwrap { padding-left:14px; padding-right:14px; }
    #mtabs { padding:0 14px; }
    #mterm { margin:10px 14px; }
  }
  .sidetop #q { min-width:0; flex:1 1 0; width:auto; }
  .qwrap { position:relative; display:flex; flex:1 1 0; min-width:0; }
  .qwrap #q { flex:1 1 0; min-width:0; width:auto; padding-right:28px; }
  .qclear { position:absolute; right:6px; top:50%; width:18px; height:18px; padding:0; border:0; border-radius:50%; background:#2f3446; color:#c9cede; display:flex; align-items:center; justify-content:center; cursor:pointer; opacity:0; transform:translateY(-50%) scale(.4) rotate(-90deg); pointer-events:none; transition:opacity .16s ease, transform .2s cubic-bezier(.3,1.5,.6,1), background .12s; }
  .qwrap.has .qclear { opacity:1; transform:translateY(-50%) scale(1) rotate(0); pointer-events:auto; }
  .qclear:hover { background:#454c66; color:#fff; }
  @media (prefers-reduced-motion:reduce) { .qclear { transition:none; } }
${JUMP_CSS}
${BRAND_ICONS_CSS}
${ORCH_VIEW_CSS}
${WIZARD_VIEW_CSS}
${WELCOME_VIEW_CSS}
${TOUR_VIEW_CSS}
${WATCHER_VIEW_CSS}
${SHIPMODAL_CSS}
${OUTBOX_VIEW_CSS}
${UPDATE_VIEW_CSS}
${ERROR_VIEW_CSS}
</style></head>
<body>
${welcomeFirst ? welcomeHtml(true) : ''}
<header>
  <div class="topbar">
    <div class="hleft">
      <button id="sidetoggle" class="sidetoggle" aria-label="Show or hide the session list" title="show or hide the session list">\u2630</button>
    <div class="brand"><h1 class="wordmark" aria-label="${APP_NAME}">${WORDMARK_L_SVG}<span aria-hidden="true">${APP_NAME.slice(1)}</span></h1><span class="sub stalechip" id="stale" hidden></span></div>
      <div class="tabs" id="tabs"></div>
    </div>
    <div class="jumpwrap"><button type="button" id="jumpbtn" class="jumpbtn" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" title="Jump to a chat, ticket or command (${'\u2318'}K)" aria-label="Jump to a chat, ticket or command"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><span class="jl">Jump to a chat, ticket or command</span><span class="kbd">\u2318K</span></button></div>
    <div class="conns" id="conns" role="group" aria-label="Connections" hidden></div>
    <div class="actions">
      <select id="default-agent" hidden aria-hidden="true" tabindex="-1">
        <option value="claude">Claude Code</option>
        <option value="codex">Codex</option>
        <option value="ask">Ask every time</option>
      </select>
      <div class="split">
        <button id="newbtn" class="open" title="start a new thread (n)">\uFF0B New thread</button>
        <button type="button" id="agentbtn" class="open splitcaret" aria-haspopup="menu" aria-expanded="false" aria-controls="agentmenu" title="Launch with" aria-label="Launch with"><svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6l5 5 5-5"/></svg></button>
        <div class="hmenu" id="agentmenu" role="menu" aria-label="Launch with">
          <div class="hlbl">Launch with</div>
          <button type="button" role="menuitemradio" data-agent="claude"><span class="ck"></span>${BRAND_SVG.claude}Claude Code</button>
          <button type="button" role="menuitemradio" data-agent="codex"><span class="ck"></span>${BRAND_SVG.codex}Codex</button>
          <button type="button" role="menuitemradio" data-agent="ask"><span class="ck"></span>Ask every time</button>
        </div>
      </div>
      <div class="moresel">
        <button type="button" id="morebtn" class="morebtn" aria-haspopup="menu" aria-expanded="false" aria-controls="moremenu" title="More" aria-label="More actions">\u22EF</button>
        <div class="hmenu" id="moremenu" role="menu" aria-label="More actions">
          <button type="button" role="menuitem" id="restorebtn" title="rebuild every loom-* tmux session from the last snapshot and open a Ghostty tab for each"><span class="ck">\u27F2</span><span class="mi">Restore sessions<span class="hint">Rebuild every loom-* tmux session from the last snapshot</span></span></button>
        </div>
      </div>
      ${UPDATE_HEADER_HTML}
      <button id="setbtn" class="gearbtn" data-tour="gear" type="button" title="Settings (⌘,)" aria-label="Settings"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"></path></svg></button>
    </div>
  </div>
</header>
<div id="jump" role="dialog" aria-modal="true" aria-label="Jump" aria-hidden="true"><div class="jbox"><div class="jin"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg><input id="jin" type="text" placeholder="Jump to a chat, ticket or command" autocomplete="off" spellcheck="false" aria-label="Jump to a chat, ticket or command"/></div><div class="jlist" id="jlist" role="listbox"></div><div class="jfoot"><span>\u2191\u2193 move</span><span>\u21B5 open</span><span>esc close</span></div></div></div>
<div id="boardwrap">
<aside id="side" aria-label="Sessions">
  <div class="sidetop" data-tour="filters">
    <div class="controls">
      <div class="searchrow">
        <span class="qwrap"><input id="q" placeholder="Search open and archived chats"/><button type="button" id="qclear" class="qclear" tabindex="-1" title="Clear search" aria-label="Clear search"><svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></span>
        <button type="button" id="fbtn" class="fbtn" aria-haspopup="true" aria-expanded="false" aria-controls="fpop" title="Filters"><svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M2 4h12M4 8h8M6.5 12h3"/></svg><span class="pip" hidden></span></button>
      </div>
    </div>
    <div class="fchips" id="fchips"></div>
    <div class="fpop" id="fpop" role="dialog" aria-label="Filters" hidden>
      <div><label for="proj">Project</label><select id="proj"></select></div>
      <div><label for="sort">Sort</label>
        <select id="sort">
          <option value="new">Started, newest first</option>
          <option value="old">Started, oldest first</option>
          <option value="recent">Recent activity</option>
        </select>
      </div>
      <div><label>Tags</label><button type="button" id="tagbtn" class="tagbtn" aria-haspopup="menu" title="filter by tag">All tags</button></div>
      <div><label>Group by</label><div class="seg" id="groupby" role="group" aria-label="Group chats by"></div></div>
      <div id="row3"><label>Show</label><div class="seg" id="livetoggle" role="group" aria-label="Show live chats or all chats"></div></div>
      <div class="fchecks"><label class="fck"><input type="checkbox" id="fdraft"/> Has a draft</label><label class="fck"><input type="checkbox" id="fissue"/> Has issues</label></div>
    </div>
  </div>
  <div id="sidelist">
    <div id="orchpin"></div>
    <div id="list"></div>
    <div id="termlist"></div>
    <section id="archive"></section>
    <div class="sidehint">Right-click a chat for actions</div>
  </div>
  <div class="sidegrip" id="sidegrip" role="separator" aria-orientation="vertical" aria-label="Resize the session list" aria-valuemin="240" aria-valuemax="720" tabindex="0" title="Drag to resize. Double-click to reset."></div>
</aside>
<section class="tkx tkboard" id="kanban" aria-label="Chats by stage"></section>
<div id="chatwrap" data-rail="hidden">
<section id="chatmain" aria-label="Selected chat" class="empty">
  <div id="mhead"></div>
  <div id="mtabs" role="tablist" data-tour="chat-tabs"></div>
  <div id="mslack"></div>
  <div id="mterm"></div>
  <div id="mtxwrap">
    <div id="mbanner"></div>
    <div class="mtxrow">
      <div id="mmsgs"></div>
      <aside id="mdetail" aria-label="Chat details"></aside>
    </div>
  </div>
  <div class="pfoot" id="mfoot"></div>
  ${ORCH_VIEW_HTML}
  <div id="mempty"></div>
  <div id="mhero" aria-live="polite"><canvas id="mhero-sky" aria-hidden="true"></canvas><div class="hx-in">${threadMark('hx-mark', 'hx')}<h2 id="mhero-h"></h2><p id="mhero-p"></p><div class="hx-acts" id="mhero-acts"></div></div></div>
</section>
<aside id="outrail" aria-label="Outbox" data-tour="outbox" hidden></aside>
</div>
</div>
<section id="watch-section">
  <div class="emtop"><h2 class="emtitle">Slack watchers</h2></div>
  <p class="emhint" id="watch-hint"></p>
  <div id="watch-list" class="emfeed"></div>
  <div class="emtop"><h2 class="emtitle">Workers started</h2></div>
  <div id="watch-spawns" class="emfeed"></div>
</section>
  ${SETTINGS_VIEW_HTML}
<section id="trees-section">
  <div class="emtop">
    <h2 class="emtitle">Worktrees</h2>
    <div class="tmodes" id="tree-modes"></div>
    ${PRUNE_VIEW_HTML}
  </div>
  <p class="emhint" id="tree-hint"></p>
  ${PRUNE_HIST_HTML}
  <div class="twrap" id="twrap">
    <div class="trail" id="tree-rail"></div>
    <div class="tdetail" id="tree-detail"></div>
  </div>
</section>
${SHIPMODAL_HTML}
<div id="composer" class="loverlay" hidden>
  <div class="cbox" role="dialog" aria-label="New thread">
    <div class="crow"><b>New thread</b><span class="spacer"></span><span class="dsub">⌘↵ launch · Esc close</span></div>
    <textarea id="cprompt" placeholder="What should it work on? Paste or drop screenshots here."></textarea>
    <div id="cthumbs"></div>
    <div class="crow">
      <label>Project <select id="cproj"></select></label>
      <span id="cpathrow" hidden><input id="cpath" placeholder="/absolute/path/to/folder" style="width:260px"/> <button id="cpathgo" type="button">Add</button></span>
      <label>Target <select id="ctarget"></select></label>
      <label>Agent <select id="cagent"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label>
      <label class="cchk"><input type="checkbox" id="cfocus"/> focus it</label>
      <label class="cchk" id="ctrustrow" hidden title="Claude Code has not been trusted in this folder yet, so the chat would wait on its trust question in the background. Ticked, Loom accepts it in ~/.claude.json before launching."><input type="checkbox" id="ctrust" checked/> trust this folder</label>
    </div>
    <div class="crow"><span id="cmsg" class="dsub"></span><a id="crestore" href="#" hidden>Restore last message</a><span class="spacer"></span><button id="ccancel">Cancel</button><button id="claunch" class="send">Launch ↵</button></div>
  </div>
</div>
<div id="termbox" class="loverlay" hidden>
  <div class="cbox rbox" role="dialog" aria-label="New terminal session">
    <div class="crow"><b>New terminal session</b><span class="spacer"></span><span class="dsub">Enter create · Esc close</span></div>
    <div class="crow"><label>Name <input id="tbname" maxlength="40" placeholder="api"/></label><label>Project <select id="tbproj"></select></label></div>
    <div class="crow"><span id="tbmsg" class="dsub"></span><span class="spacer"></span><button id="tbcancel">Cancel</button><button id="tbgo" class="send">Create ↵</button></div>
  </div>
</div>
<div id="renamebox" class="loverlay" hidden>
  <div class="cbox rbox" role="dialog" aria-label="Rename chat">
    <div class="crow"><b>Rename chat</b><span class="spacer"></span><span class="dsub">Enter save · Esc close · empty restores the generated title</span></div>
    <input id="rninput" maxlength="200" placeholder="Title"/>
    <div class="crow"><span id="rnmsg" class="dsub"></span><span class="spacer"></span><button id="rncancel">Cancel</button><button id="rnsave" class="send">Save ↵</button></div>
  </div>
</div>
<div id="tagpop" role="menu" aria-label="Filter by tag" hidden></div>
<div id="ctx" role="menu" aria-label="Chat actions" hidden></div>
<div id="slackdd" role="menu" aria-label="Slack threads" hidden></div>
<div id="prdd" role="menu" aria-label="Pull request and CI" hidden></div>
<div id="testpop" role="menu" aria-label="Test links" hidden></div>
<div id="toast" role="status" aria-live="polite"></div>
<script>
const DATA = ${data};
const TERM_TOKEN = ${JSON.stringify(termToken).replace(/</g, '\\u003c')};
${SKY_JS}
${ERROR_VIEW_JS}
${CHAT_MENU_JS}
${TERMDROP_JS}
${TERMWARM_JS}
${GROUPING_JS}
${SIDESORT_JS}
${CLOSENAV_JS}
${SIDESEARCH_JS}
${JUMP_PURE_JS}
${JUMP_VIEW_JS}
${UPDATE_VIEW_JS}
${BRAND_ICONS_JS}
${ORCH_VIEW_JS}
${CONNECT_VIEW_JS}
${WIZARD_VIEW_JS}
${WELCOME_VIEW_JS}
${TOUR_VIEW_JS}
${WATCHER_VIEW_JS}
${SHIPMODAL_JS}
${SLACKMD_JS}
${OUTBOX_PURE_JS}
${SLACK_MENU_PURE_JS}
${OUTBOX_VIEW_JS}
${SLACK_MENU_VIEW_JS}
${PRCI_PURE_JS}
${PRCI_VIEW_JS}
${TEST_LINKS_VIEW_JS}
const $ = (s,r=document)=>r.querySelector(s);
function rel(ms){const s=(Date.now()-ms)/1000;if(s<60)return'just now';if(s<3600)return Math.floor(s/60)+'m ago';if(s<86400)return Math.floor(s/3600)+'h ago';return Math.floor(s/86400)+'d ago';}
function spark(act){const days=[];const now=new Date();for(let i=13;i>=0;i--){const d=new Date(now);d.setDate(now.getDate()-i);const k=d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0');days.push(act[k]||0);}const max=Math.max(1,...days);const bars='▁▂▃▄▅▆▇█';return days.map(v=>bars[Math.min(7,Math.round(v/max*7))]).join('');}
// 14-day activity strip — matches the board's ~1-week data window (plus a few
// days of in-chat history) so the cells are actually populated, and mirrors the
// per-card spark-line's span. Shading scales to the busiest visible day.
function projects(){const cur=$('#proj').value;const set=DATA.projects?[...new Set(DATA.projects.map(p=>p.path.split('/').pop()))].sort():[...new Set(DATA.chats.map(c=>c.project))].sort();const sel=$('#proj');sel.innerHTML='<option value="">all projects</option>'+set.map(p=>'<option>'+p+'</option>').join('');if(cur&&set.indexOf(cur)>=0)sel.value=cur;}
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
// Send & close takes a chat off the board; it shows again in All history, and while a search is typed.
function isOpenChat(c){return isLive(c)||!!parkedOf(c);}
var SPLIT=null;
function searchActive(){return tab==='board'&&shipFilter===null&&!!($('#q')&&$('#q').value.trim());}
function showDone(){return !liveOnly||!!($('#q')&&$('#q').value.trim());}
function boardBase(){return (liveOnly?DATA.chats.filter(c=>isLive(c)||!!parkedOf(c)):DATA.chats).filter(c=>!isSaved(c)&&(!c.done||showDone()));}
function savedBase(){return DATA.chats.filter(isSaved);}
function scoped(){return tab==='saved'?savedBase():boardBase();}
function pcolor(p){let h=0;for(let i=0;i<p.length;i++)h=(h*31+p.charCodeAt(i))%360;return 'background:hsl('+h+',42%,20%);color:hsl('+h+',72%,76%)';}
// Segmented Board / Saved switch. Counts are totals (independent of the live
// filter) so they don't jump around as you toggle Live-only.
function openSettings(){if(tab==='settings')return;tab='settings';stateFilter='all';onlyGroup=null;syncControls();liveToggle();chips();render();}
// Badges only where something is actionable, hidden at zero. Board and Saved never carry one.
function watchBadge(){var n=Number(WATCH.unreviewed)||0;(WATCH.watchers||[]).forEach(function(w){n+=Number(w.unreviewed)||0;});return n;}
// The Trees badge counts only worktrees that are safe to delete: not the primary, nothing
// running in it, and its branch merged and clean (git.ts verdict 'safe'). Merely idle ones
// (old lastCommitAt) are not counted: with dozens of worktrees that made the badge noise.
function treeIsStale(w){if(w.primary||(w.livePanes&&w.livePanes.length))return false;return w.verdict==='safe';}
function staleTreeCount(){var n=0;TREES.repos.forEach(function(r){r.worktrees.forEach(function(w){if(treeIsStale(w))n++;});});return n;}
function renderTabs(){const gb=$('#setbtn');if(gb){gb.classList.toggle('on',tab==='settings');gb.setAttribute('aria-pressed',tab==='settings'?'true':'false');}const defs=[['board','▦ Board',0,''],['saved','★ Saved',0,' savedtab'],['tickets','⊞ Tickets',kbCount(),' tktab'],['watch','◉ Watchers',watchBadge(),' watchtab'],['trees','⑂ Trees',staleTreeCount(),' treetab']];$('#tabs').innerHTML=defs.map(d=>'<button class="tab'+d[3]+(tab===d[0]?' on':'')+'" data-t="'+d[0]+'">'+d[1]+(d[2]>0?'<span class="cnt">'+d[2]+'</span>':'')+'</button>').join('');$('#tabs').querySelectorAll('.tab').forEach(el=>el.onclick=()=>{if(tab===el.dataset.t)return;tab=el.dataset.t;stateFilter='all';onlyGroup=null;syncControls();liveToggle();chips();render();});}
// Header status: "Updated Ns ago" only when the data is over 30 s old or the last poll failed.
var pollFailed=false;
function renderStale(){const el=$('#stale');if(!el)return;const age=Date.now()-(DATA.generatedAt||0);
  if(pollFailed){el.textContent='Loom server not reachable';el.className='sub stalechip bad';el.hidden=false;}
  else if(age>30000){el.textContent='Updated '+(age<90000?Math.round(age/1000)+'s':Math.round(age/60000)+'m')+' ago';el.className='sub stalechip';el.hidden=false;}
  else{el.hidden=true;}
  renderConns();}
// Live-only toggle is a Board concept; hide it on the Saved tab (saved chats are
// usually closed, so filtering them by "live" is meaningless).
// The Trees, Watchers and Settings tabs show something other than chats, so every
// chat-scoped control goes away with them — leaving the project/sort pickers
// visible would imply they filter it.
function syncControls(){const tr=tab==='trees';const tk=tab==='tickets';const wa=tab==='watch';const se=tab==='settings';const other=tr||wa||se;
  $('#livetoggle').style.display=(tab==='saved'||other)?'none':'';
  $('.controls').style.display=other?'none':'';
  $('#row3').style.display=other?'none':'';
  $('#fchips').style.display=other?'none':'';
  // Tickets is the Board's own chats and filters, drawn as columns in place of the list.
  $('#list').style.display=other||tk?'none':'';
  $('#archive').style.display=other||tk?'none':'';
  $('#termlist').style.display=other||tk?'none':'';
  $('#kanban').style.display=tk?'grid':'none';
  $('#boardwrap').classList.toggle('tk',tk);
  $('#boardwrap').style.display=other?'none':'';
  // 'block', NOT '': the stylesheet defaults these sections to display:none, and
  // clearing the inline style just lets that rule win again.
  $('#trees-section').style.display=tr?'block':'none';
  $('#watch-section').style.display=wa?'block':'none';
  $('#settings-section').style.display=se?'block':'none';
}
function liveToggle(){const board=DATA.chats.filter(c=>!isSaved(c));const nLive=board.filter(isLive).length;const nAll=board.length;const t=$('#livetoggle');t.innerHTML='<button data-live="1" class="'+(liveOnly?'on':'')+'" title="only chats running in a pane">● Live '+nLive+'</button><button data-live="0" class="'+(liveOnly?'':'on')+'" title="every chat on the board">All '+nAll+'</button>';t.querySelectorAll('button').forEach(b=>b.onclick=()=>{liveOnly=b.dataset.live==='1';liveToggle();chips();render();});}
function isWorking(c){const L=DATA.live[chatKey(c)];return !!(L&&L.working);}
// When someone last spoke in the chat — a prompt or a reply. last_active_at is
// the file's last write, which Claude Code keeps bumping (title rewrites, system
// records, late tool results) long after the conversation stopped, so sorting on
// it floated dead chats to the top. A row not yet re-indexed has no last_turn_at
// and falls back.
function fresh(c){return c.last_turn_at||c.last_active_at;}
var fDraft=false, fIssue=false, onlyGroup=null;
var sortMode=sortModeOf(lsGet('loom.sort')), stampOf=makeStamper(), lastOrder={}, CMP=null, pointerIn=false, pendingReorder=false;
var collapsed=lsList('loom.grpCollapsed');
const SORT_LABEL={new:'Started, newest first',old:'Started, oldest first',recent:'Recent activity'};
const SF={started:c=>c.started_at||0,stamp:c=>stampOf(chatKey(c),(isWorking(c)?'w':'-')+st(c),fresh(c)),key:chatKey};
// On the Saved tab the order is when a chat was saved; elsewhere the chosen sort.
function rowComparator(){if(tab==='saved')return sortMode==='old'?(a,b)=>a.saved_at-b.saved_at:(a,b)=>b.saved_at-a.saved_at;return sortComparator(sortMode,SF);}
function filterChipDefs(){const o=[];const proj=$('#proj').value;if(proj)o.push(['proj',proj]);if(sortMode!==SORT_DEFAULT)o.push(['sort',SORT_LABEL[sortMode]]);
  if(tagSel.length)o.push(['tags','Tags: '+(tagSel.length===1?(tagSel[0]===UNTAGGED?'Untagged':tagSel[0]):tagSel.length+' selected')]);
  if(groupBy==='tag')o.push(['group','Grouped by tag']);if(tab!=='saved'&&!liveOnly)o.push(['live','All history']);
  if(fDraft)o.push(['draft','Has a draft']);if(fIssue)o.push(['issue','Has issues']);if(onlyGroup)o.push(['only','Only: '+onlyGroup]);return o;}
function renderFilterChips(){const d=filterChipDefs();const box=$('#fchips');if(!box)return;
  box.innerHTML=d.map(x=>'<button type="button" class="fchip" data-fk="'+x[0]+'" title="Remove this filter">'+esc(x[1])+'<i>✕</i></button>').join('');
  const pip=$('#fbtn .pip');if(pip)pip.hidden=!d.length;const ref=d.length?box:$('.searchrow');$('#fpop').style.top=(ref.offsetTop+ref.offsetHeight+6)+'px';$('#fdraft').checked=fDraft;$('#fissue').checked=fIssue;}
// The old status chips are gone: group headers collapse / isolate, and the two
// that were not groups (drafts, issues) are checkboxes in the Filters popover.
function chips(){renderFilterChips();}
function removeFilter(k){
  if(k==='proj')$('#proj').value='';else if(k==='sort'){sortMode=SORT_DEFAULT;lsSet('loom.sort',sortMode);lastOrder={};$('#sort').value=sortMode;}
  else if(k==='tags'){tagSel=[];saveTagSel();renderTagBtn();}else if(k==='group'){groupBy='status';lsSet('loom.groupBy',groupBy);renderGroupBy();}
  else if(k==='live'){liveOnly=true;liveToggle();}else if(k==='draft')fDraft=false;else if(k==='issue')fIssue=false;else if(k==='only')onlyGroup=null;
  render();}
function setFilterPop(open){const p=$('#fpop');p.hidden=!open;if(open)renderFilterChips();$('#fbtn').classList.toggle('open',open);$('#fbtn').setAttribute('aria-expanded',String(open));}
function wireSideTop(){$('#sort').value=sortMode;
  $('#fbtn').onclick=e=>{e.stopPropagation();setFilterPop($('#fpop').hidden);};
  document.addEventListener('mousedown',e=>{if(!$('#fpop').hidden&&!e.target.closest('#fpop,#fbtn,#tagpop'))setFilterPop(false);});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#fpop').hidden&&$('#tagpop').hidden){setFilterPop(false);$('#fbtn').focus();}});
  $('#fchips').addEventListener('click',e=>{const b=e.target.closest('[data-fk]');if(b)removeFilter(b.dataset.fk);});
  $('#fdraft').onchange=e=>{fDraft=e.target.checked;render();};$('#fissue').onchange=e=>{fIssue=e.target.checked;render();};
  const sl=$('#sidelist');sl.addEventListener('mouseenter',()=>{pointerIn=true;});
  sl.addEventListener('mouseleave',()=>{pointerIn=false;if(pendingReorder){pendingReorder=false;render();}});
  sl.addEventListener('click',e=>{const h=e.target.closest('.sgrp[data-gk]');if(!h)return;
    if(e.altKey){onlyGroup=onlyGroup===h.dataset.gn?null:h.dataset.gn;}
    else{const i=collapsed.indexOf(h.dataset.gk);if(i>=0)collapsed.splice(i,1);else collapsed.push(h.dataset.gk);lsSet('loom.grpCollapsed',JSON.stringify(collapsed));}
    render();});
  sl.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const h=e.target.closest&&e.target.closest('.sgrp[data-gk]');if(!h||e.target!==h)return;e.preventDefault();h.click();});}
function matchFilter(c){if(fDraft&&!hasDrafts(c))return false;if(fIssue){const s=st(c);if(!(s==='warning'||s==='error'))return false;}return true;}
function render(){renderTabs();if(typeof syncQClear==='function')syncQClear();renderOrchPin();syncControls();if(tab==='trees'){renderTrees();return;}if(tab==='watch'){renderWatch();return;}if(tab==='settings'){renderSettings();return;}renderTagBtn();const q=$('#q').value.toLowerCase();const proj=$('#proj').value;const sv=sortModeOf($('#sort').value);if(sv!==sortMode){sortMode=sv;lsSet('loom.sort',sortMode);lastOrder={};}renderFilterChips();
// On the Saved tab "Most recent" means most-recently-saved; elsewhere, last active.
const searching=searchActive();const fl=c=>matchFilter(c)&&(!proj||c.project===proj)&&matchTagFilter(c)&&(!q||searchHay(c,(DATA.live[chatKey(c)]||{}).name).includes(q));
let rows=(shipFilter!==null&&tab==='board'?DATA.chats.filter(inShipFilter):searching?DATA.chats.filter(c=>!isSaved(c)):scoped()).filter(fl);
if(searching!==termSearchState){termSearchState=searching;renderTermList();}
const tmatch=searching?termMatches(q):[];
if(searching){SPLIT=splitMatches(rows,isOpenChat,archHits,DATA.chats.map(c=>c.session_id));rows=SPLIT.open;}else SPLIT=null;
// Order inside each group is the chosen sort; the groups (Working, Your turn, ...) only
// decide which heading a row sits under.
CMP=rowComparator();rows.sort(CMP);const list=$('#list');const empty=tab==='saved'?'<p class="meta sidehint">Nothing saved yet. Use Save for later on any chat to bookmark it here. Saved chats stay put no matter how long they sit, and saving a live one frees its pane.</p>':(liveOnly&&boardBase().length===0?'<p class="meta sidehint">No live sessions detected yet. Send a prompt in a chat to register it, or switch to All.</p>':'<p class="meta sidehint">no matches</p>');if(tab==='tickets'){renderKanban(rows);renderMain();return;}const flipBefore=flipTops();list.innerHTML=shipStrip()+(searching?'<div class="ahead">Open · '+(rows.length+tmatch.length)+'</div>'+((sidebarRows(rows)+tmatch.map(termRow).join(''))||'<p class="meta sidehint">no open matches</p>'):(sidebarRows(rows)||empty));wireShips(list);flipPlay(flipBefore);renderArchive();renderMain();}
// ---- Sidebar rows ------------------------------------------------------------
// One row per chat: state dot, title, project and pane name, age, PR / Slack /
// draft chips. Click selects it into the main area; right-click opens the action
// menu (chatmenu.ts). Archive hits render as the same rows, flagged .arch.
function parkedOf(c){return c.arch?null:((DATA.parked||[]).find(p=>p.session_id===c.session_id&&p.agent===c.agent)||null);}
function dotCls(c){const pk=parkedOf(c);if(pk)return pk.state==='replied'?'d-turn':'d-wait';const L=DATA.live[chatKey(c)];if(c.arch||!L)return 'd-stale';if(L.working)return 'd-working';const s=st(c);if(s==='waiting_on_user')return 'd-turn';if(s==='error')return 'd-error';if(s==='warning')return 'd-warn';return 'd-done';}
const DOT_LABEL={'d-wait':'Waiting on others','d-working':'Working','d-turn':'Your turn','d-done':'Done','d-warn':'Caveats','d-error':'Error','d-stale':'Not running'};
function paneLabel(c){const L=DATA.live[chatKey(c)];if(c.arch)return 'archive';return L?(L.name||(L.tmux_session+':'+L.pane_index)):'not running';}
function chatPrUrl(c){const k=(DATA.chatPr||{})[chatKey(c)]||'';return c.pr_url||(k.split('#')[1]?'https://github.com/'+k.replace('#','/pull/'):'');}
function chatPrNum(c){const u=chatPrUrl(c);return u?(u.split('/pull/')[1]||'').replace(/[^0-9]/g,''):'';}
function isSel(c){return !!sel&&sel.sid===c.session_id&&sel.agent===c.agent&&!!sel.arch===!!c.arch;}
function parkSub(c){const pk=parkedOf(c);if(pk)return pk.state==='replied'?(pk.reply_first_line||pk.label):pk.label;return c.project+' · '+paneLabel(c);}
function flatList(){return isFlatList(sortMode,groupBy,tab);}
// Age tint on the sidebar row (moved here from the tmux panes). Same ramp as src/panetint.ts:
// active within the hour is untinted; earlier today, yesterday, older warm up in that order.
// Wall-clock day boundaries, not rolling 24h windows.
function ageClass(c){if(c.arch)return '';const t=fresh(c);if(!t)return '';const now=Date.now();if(now-t<3600000)return '';const d=new Date(now);d.setHours(0,0,0,0);const today=d.getTime();if(t>=today)return ' age-today';d.setDate(d.getDate()-1);if(t>=d.getTime())return ' age-yday';return ' age-old';}
// The row age is always recency (last activity), whatever the sort; the tooltip also gives the start.
function rowAgeMs(c){if(c.arch)return c.last_active_at;return fresh(c);}
function ageTip(c){if(c.arch)return 'active '+rel(c.last_active_at);return sortAgeTip(c.started_at,fresh(c),rel);}
function chatNameOf(c){const L=c.arch?null:DATA.live[chatKey(c)];return (L&&L.name)||'';}
// The name is plain text (a click on it selects the row like anywhere else); only the small
// icon, shown on row hover, copies it.
function nameChip(c){const n=chatNameOf(c);return n?' <span class="cname">'+esc(n)+'<button type="button" class="cpi" data-copyname="'+esc(n)+'" title="Copy name" aria-label="Copy name '+esc(n)+'">⧉</button></span>':'';}
function rowSub(c){const n=chatNameOf(c);if(n&&!parkedOf(c))return esc(c.project)+' · '+nameChip(c).trim();return esc(parkSub(c));}
function copyName(n){copyText(n,'Copied');}
function srow(c){const prn=chatPrNum(c);const a=c.arch?' data-jsonl="'+esc(c.arch.jsonl)+'"':'';
return '<div class="srow'+(isSel(c)?' sel':'')+(c.arch?' arch':'')+ageClass(c)+'" data-tour="row" role="button" tabindex="0" aria-haspopup="menu" data-sid="'+esc(c.session_id)+'" data-agent="'+esc(c.agent)+'"'+a+'>'+
'<span class="sdot '+dotCls(c)+'" title="'+esc(DOT_LABEL[dotCls(c)])+'"></span>'+
'<span class="sbody"><span class="stitle" title="'+esc(disp(c))+'">'+(c.arch?'':shipMark(c))+(c.provisional?'<span class="badge info" title="not indexed yet">new</span> ':'')+esc(disp(c))+'</span><span class="ssub">'+(flatList()&&!c.arch?'<span class="sstate '+dotCls(c)+'">'+esc(DOT_LABEL[dotCls(c)]||'')+'</span> ':'')+rowSub(c)+'</span></span>'+
'<span class="sright"><span class="sage" title="'+esc(ageTip(c))+'">'+esc(agoShort(rowAgeMs(c)))+'</span><span class="schips">'+(prn?'<span class="chp pr" title="'+esc(chatPrUrl(c))+'">PR #'+esc(prn)+'</span>':'')+(parkedOf(c)&&parkedOf(c).state==='replied'?'<span class="chp rp" title="someone replied in the thread">replied</span>':'')+(ownsSlack(c)?'<span class="chp sl">Slack'+(slackCountOf(c)>1?' '+slackCountOf(c):'')+'</span>':'')+(c.arch?'':rowTagChips(c))+(c.arch?'':(draftsFor(c).length?'<span class="chp dr'+(draftsFor(c).every(d=>d.stale)?' stl" title="stale: '+esc(draftsFor(c)[0].stale_reason||''):'')+'">Draft</span>':'')+pipeCard(c)+shipCardChips(c))+'</span></span></div>';}
// Tags: names live on each chat, colours in DATA.tags. Filter and group-by persist.
function lsList(k){try{const v=JSON.parse(lsGet(k)||'[]');return Array.isArray(v)?v.map(String):[];}catch(e){return [];}}
var tagSel=lsList('loom.tagFilter'), groupBy=lsGet('loom.groupBy')==='tag'?'tag':'status';
const UNTAGGED='__untagged';
function chatTags(c){return c.tags||[];}
function tagColor(n){const t=(DATA.tags||[]).find(x=>x.name===n);return t?t.color:'#8a90a2';}
function tagChipHtml(n,cls){const c=tagColor(n);return '<span class="chp tg'+(cls?' '+cls:'')+'" style="color:'+c+';background:'+c+'22" title="'+esc(n)+'">'+esc(n)+'</span>';}
function rowTagChips(c){const ts=chatTags(c);if(!ts.length)return '';return ts.slice(0,2).map(n=>tagChipHtml(n)).join('')+(ts.length>2?'<span class="chp tg more" title="'+esc(ts.slice(2).join(', '))+'">+'+(ts.length-2)+'</span>':'');}
function matchTagFilter(c){if(!tagSel.length)return true;const ts=chatTags(c);if(!ts.length)return tagSel.indexOf(UNTAGGED)>=0;return ts.some(t=>tagSel.indexOf(t)>=0);}
const GF={done:c=>!!c.done,parked:c=>{const p=parkedOf(c);return p?p.state:'';},saved:c=>!!c.saved,working:c=>isWorking(c),turn:c=>isTurn(c),live:c=>isLive(c),tags:chatTags,fresh:c=>fresh(c),cmp:(a,b)=>CMP?CMP(a,b):fresh(b)-fresh(a)};
function rowKeyOf(r){return r.dataset.agent+':'+r.dataset.sid;}
// FLIP: remember where each row is, re-render, then slide moved rows from the old spot.
function flipTops(){const m={};if(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches)return m;document.querySelectorAll('#list .srow[data-sid]').forEach(r=>{m[rowKeyOf(r)]=r.getBoundingClientRect().top;});return m;}
function flipPlay(before){const rows=document.querySelectorAll('#list .srow[data-sid]');rows.forEach(r=>{const o=before[rowKeyOf(r)];if(o===undefined)return;const d=o-r.getBoundingClientRect().top;if(Math.abs(d)<1||Math.abs(d)>1500)return;
  r.style.transition='none';r.style.transform='translateY('+d+'px)';requestAnimationFrame(()=>{r.style.transition='transform .15s ease-out';r.style.transform='';});});}
// The chat that ran a ship owns it until it merges: ⚓ while it holds the lock (shipping now)
// and while its ship PR is open (in review), not only for the minutes the lock is held.
function shipMark(c){const k=chatKey(c);for(const b of DATA.ships||[]){if(b.lock&&!b.lock.stale&&b.lock.holderKey===k)return '<span class="smk hot" title="shipping now">⚓</span>';}
  for(const b of DATA.ships||[]){const g=(b.shipped||[]).find(g=>g.runner===k&&g.state==='OPEN');if(g)return '<span class="smk own" title="owns ship #'+g.number+', in review">⚓</span>';}
  const x=shipRole(c);if(!x)return '';
  if(!x.r.next)return '';return x.r.next==='unstaged'?'<span class="smk wipm" title="in the next ship, not staged yet">⛵…</span>':'<span class="smk" title="rides the next ship">⛵</span>';}
function sidebarRows(rows){let h=ghostRows();const selKey=sel?sel.agent+':'+sel.sid:'';
  (flatList()?[{name:'All chats',tag:'',rows:rows,flat:true}]:groupChats(rows,groupBy,GF)).forEach(g=>{const gk=groupBy+':'+g.name;if(onlyGroup&&onlyGroup!==g.name)return;
    let gr=g.rows;
    if(sortMode==='recent'&&tab!=='saved'){const want=gr.map(chatKey);const pinned={};if(selKey)pinned[selKey]=1;if(pointerIn)want.forEach(k=>{pinned[k]=1;});
      const out=pinOrder(lastOrder[gk]||[],want,pinned);if(out.join('|')!==want.join('|'))pendingReorder=pointerIn||pendingReorder;
      const by={};gr.forEach(c=>{by[chatKey(c)]=c;});gr=out.map(k=>by[k]);lastOrder[gk]=out;}
    const closed=collapsed.indexOf(gk)>=0;
    if(g.flat){h+=gr.map(srow).join('');return;}
    h+='<div class="sgrp'+(closed?' closed':'')+'" data-tour="group" role="button" tabindex="0" aria-expanded="'+!closed+'" data-gk="'+esc(gk)+'" data-gn="'+esc(g.name)+'" title="Click to collapse or expand. Alt-click to show only this group."><span><span class="car">▾</span>'+(g.tag?'<span class="tgdot" style="background:'+tagColor(g.tag)+'"></span>':'')+esc(g.name)+'</span><span class="cnt">'+g.rows.length+'</span></div>'+(closed?'':gr.map(srow).join(''));});
  return h;}
// Placeholder rows for launches whose chat is not on the board yet.
function ghostRows(){if(tab!=='board')return '';const L=DATA.launches||[];return L.filter(g=>g.status==='failed'||!DATA.chats.some(c=>{const x=DATA.live[chatKey(c)];return x&&x.pane_id===g.pane_id&&c.last_active_at>=g.at-5000;})).map(g=>{const t=esc((g.prompt||'').split(NL)[0].slice(0,90)||'New thread');
  if(g.status==='failed')return '<div class="srow ghost failed" data-lid="'+esc(g.id)+'"><span class="sdot d-failed"></span><span class="sbody"><span class="stitle">Chat didn\u2019t start in '+esc(g.where)+'</span><span class="ssub">'+esc(g.project)+' \u00b7 '+t+'</span><pre class="lpane">'+esc((g.lines||[]).join(NL)||'(the pane was empty)')+'</pre><span class="lacts"><button data-lact="retry">Retry</button><button data-lact="edit">Edit in composer</button><button data-lact="dismiss">Dismiss</button></span></span></div>';
  return '<div class="srow ghost"><span class="sdot d-working"></span><span class="sbody"><span class="stitle">'+t+'</span><span class="ssub">'+esc(g.project)+' \u00b7 '+esc(g.where)+'</span></span><span class="sright"><span class="sage">Starting\u2026</span></span></div>';}).join('');}
// Retry / Edit / Dismiss on a launch that never started.
function launchAct(act,id,btn){const g=(DATA.launches||[]).find(x=>x.id===id);if(!g)return;
  if(act==='edit'){openComposer({prompt:g.fullPrompt||g.prompt,project:g.projectDir});fetch('/api/new-thread/dismiss',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})}).then(()=>refresh());return;}
  btn.disabled=true;fetch('/api/new-thread/'+act,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})}).then(r=>r.json()).then(j=>{toast(j.ok?(act==='retry'?'relaunched in '+(j.where||'a new pane'):'dismissed'):(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');if(!j.ok)btn.disabled=false;refresh();setTimeout(refresh,2000);}).catch(()=>{btn.disabled=false;toast('server off','#8a2b2e');});}
function rowChat(r){if(r.classList.contains('ghost'))return null;if(r.dataset.jsonl){const h=archHits.find(x=>x.session_id===r.dataset.sid);return h?archChat(h):null;}return DATA.chats.find(c=>c.agent===r.dataset.agent&&c.session_id===r.dataset.sid)||null;}
function wireSidebar(){const sl=$('#sidelist');
  $('#list').addEventListener('click',e=>{const r=e.target.closest('.tsrow');if(r)selectTerminal(r.dataset.term,r.dataset.win);});
  $('#list').addEventListener('keydown',e=>{const r=e.target.closest&&e.target.closest('.tsrow');if(r&&e.key==='Enter'){e.preventDefault();selectTerminal(r.dataset.term,r.dataset.win);}});
  sl.addEventListener('click',e=>{const la=e.target.closest('[data-lact]');if(la){e.stopPropagation();const row=la.closest('[data-lid]');if(row)launchAct(la.dataset.lact,row.dataset.lid,la);return;}const cn=e.target.closest('[data-copyname]');if(cn){e.stopPropagation();copyName(cn.dataset.copyname);return;}const r=e.target.closest('.srow[data-sid]');if(!r||e.target.closest('button,a'))return;const c=rowChat(r);if(c)selectChat(c.session_id,c.agent,c.arch||null);});
  sl.addEventListener('keydown',e=>{if(e.key!=='Enter'&&e.key!==' ')return;const r=e.target.closest&&e.target.closest('.srow[data-sid]');if(!r||e.target!==r)return;e.preventDefault();const c=rowChat(r);if(c)selectChat(c.session_id,c.agent,c.arch||null);});
  sl.addEventListener('contextmenu',e=>{const r=e.target.closest('.srow[data-sid]');if(!r)return;const c=rowChat(r);if(!c)return;e.preventDefault();openCtx(c,e.clientX,e.clientY,null);});}
function doSave(sid,agent,el){const nav=tab==='saved'?null:closeNavPlan(DATA.chats.find(x=>x.agent===agent&&x.session_id===sid));flash(el,'saving…','#7a6a1a');fetch('/save?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent)).then(r=>r.json()).then(j=>{flash(el,j.ok?(j.closed?'saved, pane freed':'saved'):(j.detail||'failed'),j.ok?'#7a6a1a':'#8a2b2e');if(j.ok){markSaved(sid,agent,true);closeNavGo(nav);}setTimeout(refresh,1200);setTimeout(refresh,3200);}).catch(()=>flash(el,'server off','#8a2b2e'));}
function doUnsave(sid,agent,el){flash(el,'removing…','#7a6a1a');fetch('/unsave?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent)).then(r=>r.json()).then(j=>{flash(el,j.ok?'unsaved':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');if(j.ok)markSaved(sid,agent,false);setTimeout(refresh,1200);setTimeout(refresh,3200);}).catch(()=>flash(el,'server off','#8a2b2e'));}
function markSaved(sid,agent,v){const c=DATA.chats.find(x=>x.agent===agent&&x.session_id===sid);if(c){c.saved=v;c.saved_at=v?Date.now():0;render();}}
function parkPost(path,c){return fetch(path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:c.session_id,agent:c.agent})}).then(r=>r.json());}
function doRestore(c){parkPost('/api/restore',c).then(j=>{toast(j.ok?'restored to the board':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');if(j.ok){c.done=false;render();}setTimeout(refresh,300);}).catch(()=>toast('server off','#8a2b2e'));}
function doUnpark(c){parkPost('/api/parked/unpark',c).then(j=>{toast(j.ok?'unparked':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');setTimeout(refresh,200);}).catch(()=>toast('server off','#8a2b2e'));}
function doParkResume(c){toast('resuming with the reply…');parkPost('/api/parked/resume',c).then(j=>{toast(j.ok?'resumed with the reply':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');setTimeout(refresh,1200);setTimeout(refresh,3200);}).catch(()=>toast('server off','#8a2b2e'));}
function doClose(sid,agent,el){const nav=closeNavPlan(DATA.chats.find(x=>x.agent===agent&&x.session_id===sid));flash(el,'closing…','#7a4a1a');fetch('/close?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent),{method:'POST'}).then(r=>r.json()).then(j=>{flash(el,j.ok?'closed, pane freed':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');if(j.ok)closeNavGo(nav);setTimeout(refresh,1500);setTimeout(refresh,3500);}).catch(()=>flash(el,'server off','#8a2b2e'));}
function jump(sid,agent,el){flash(el,'opening…','#3b5bdb');fetch('/goto?session='+encodeURIComponent(sid)+'&agent='+encodeURIComponent(agent)).then(r=>r.json()).then(j=>flash(el,j.ok?'opened':'no live pane',j.ok?'#1f6f3f':'#8a2b2e')).catch(()=>flash(el,'server off','#8a2b2e'));}
// One picker per card, so it keys on action+agent: clicking the same button again
// closes it, clicking the sibling swaps to that button's launch.
function launchVerb(action,sourceAgent,selectedAgent){return action==='branch'?('Branch '+agentLabel(selectedAgent)):(selectedAgent===sourceAgent?resumeLabel(sourceAgent).slice(2):startLabel(sourceAgent).slice(2));}
function openPicker(sid,sourceAgent,el,action,proj,selectedAgent){const p=el.querySelector('.picker');const key=action+':'+selectedAgent;if(p.dataset.open===key){p.dataset.open='';p.innerHTML='';return;}p.dataset.open=key;const verb=launchVerb(action,sourceAgent,selectedAgent);p.innerHTML='<span class="muted">finding an open pane…</span>';fetch('/api/lanes').then(r=>r.json()).then(lanes=>{if(!lanes.length){doLaunch(sid,sourceAgent,'',el,p,action,proj,selectedAgent);return;}
// One lane is the whole choice, so skip the picker. The server re-resolves the
// lane's next open pane at launch time, so these rows are a menu, not a claim.
if(lanes.length===1){doLaunch(sid,sourceAgent,lanes[0].lane,el,p,action,proj,selectedAgent);return;}p.innerHTML='<div class="pickhdr">'+esc(verb)+' into which lane?</div>'+lanes.map(ln=>'<button class="paneopt" data-lane="'+esc(ln.lane)+'">'+esc(ln.lane)+' → '+esc(ln.where)+(ln.name?'<span class="pcwd">'+esc(ln.name)+'</span>':'')+'</button>').join('');p.querySelectorAll('.paneopt').forEach(b=>b.onclick=()=>doLaunch(sid,sourceAgent,b.dataset.lane,el,p,action,proj,selectedAgent));}).catch(()=>p.innerHTML='<span class="muted">server off?</span>');}
// proj is sent only for archive chats — the server resolves board chats from its DB.
${PENDING_VIEW_JS}
// One toast for every action result (the per-element flash it replaced would sit
// on whichever chat the header happens to show, not the row that was clicked).
// A red toast is an error: it carries Copy details (src/errorview.ts) and stays
// up long enough to press it, and while the pointer is on it.
function toastIsErr(bg){const m=/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(bg||'');if(!m)return false;const r=parseInt(m[1],16),g=parseInt(m[2],16),b=parseInt(m[3],16);return r>100&&r>g*1.6&&r>b*1.6;}
function toast(msg,bg,detail){const t=$('#toast');const err=toastIsErr(bg);t.classList.toggle('lerr-toast',err);
  if(err)t.innerHTML='<span>'+esc(msg)+'</span>'+lerrCopyBtn({what:msg,message:msg,output:lerrOutput(detail)});else t.textContent=msg;
  t.style.background=bg||'#1f6f3f';t.classList.add('on');clearTimeout(t._t);const hide=()=>t.classList.remove('on');t._t=setTimeout(hide,err?7000:1800);
  t.onmouseenter=err?()=>clearTimeout(t._t):null;t.onmouseleave=err?()=>{clearTimeout(t._t);t._t=setTimeout(hide,2500);}:null;}
function flash(el,msg,bg){toast(msg,bg);}
function sum(o){return Object.values(o).reduce((a,b)=>a+b,0);}
function disp(c){const t=c.title||c.first_message||'Untitled';return t.length>90?t.slice(0,90)+'…':t;}
function liveTag(c){const L=DATA.live[chatKey(c)];if(!L)return '<span class="stale">○ no active pane</span>';const loc=esc(L.tmux_session)+' · pane '+L.pane_index;if(L.working)return '<span class="working"><span class="pin">⚡</span> working · '+loc+'</span>';return '<span class="live"><span class="pin">●</span> live · '+loc+(L.running?'':' (idle)')+'</span>';}
function ownsSlack(c){return (DATA.slackOwners||[]).indexOf(c.session_id)>=0||!!draftThreadOf(DATA.drafts,c.session_id);}
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
var shipOpen=lsGet('loom.shipOpen')==='1';
function shipWho(b){const l=b.lock;if(l.holderKey){const L=DATA.live[l.holderKey];return (L&&L.name)||chatName(l.holderKey);}return l.sessionId.slice(0,8)||'unknown';}
function shipBody(b){const n=b.next;
  return '<div class="shipbody"><div class="sh"><b>'+esc(b.repo.split('/').pop())+'</b>'+(b.onMain?'':'<span class="dsub">(not on main)</span>')+
    '<span>'+n.staged+' staged</span><span>· '+n.unstaged+' unstaged</span>'+(n.unattributed.length?'<span title="'+esc(n.unattributed.map(f=>f.state+' '+f.path).join(NL))+'">· '+n.unattributed.length+' unattributed</span>':'')+
    (n.shared.length?'<span class="wip" title="'+esc(n.shared.join(NL))+'">· ⚠ '+n.shared.length+' edited by two chats</span>':'')+'</div>'+
    (b.lock?'<div class="sh">'+lockHtml(b)+'</div>':'')+
    '<div class="shc">'+n.chats.map(c=>'<span class="shipmate" data-key="'+esc(c.key)+'" title="'+esc(c.files.map(f=>f.state+' '+f.path+(f.shared?' (shared)':'')).join(NL))+'">'+esc(chatName(c.key))+' '+(c.staged?'<span class="ok">'+c.staged+'✓</span> ':'')+(c.unstaged?'<span class="wip">'+c.unstaged+'…</span>':'')+'</span>').join('')+'</div>'+
    '<div class="shipacts2"><button type="button" class="shipbtn'+(shipFilter==='next'?' on':'')+'" data-shipf="next" title="Filter the board to the chats riding this ship">'+(shipFilter==='next'?'Showing these chats ✕':'Show these chats')+'</button><button type="button" class="shipbtn" data-shipview="'+esc(b.repo)+'" title="Review the staged files and their labels">View staged work</button></div>'+
    '<div class="shiphint">'+(shipGate(b)?esc(shipGate(b)):'Ship reviews the staged work, then starts a new chat that runs <code>/ship</code>.')+'</div></div>';}
// The card's primary action: always on the bar, collapsed or open. Opens the review
// modal at its confirm step; nothing commits until "Start ship session" there.
function shipGoBtn(b){const g=shipGate(b);
  return '<button type="button" class="shipgo" data-shipgo="'+esc(b.repo)+'"'+(g?' disabled aria-disabled="true"':'')+' title="'+esc(g||'Review and start /ship ('+b.next.staged+' staged)')+'">Ship</button>';}
// One line per repo. Idle is muted; staged work gets an accent border; a live ship
// lock goes amber with a pulsing dot, so work in progress is visible even collapsed.
// Git projects with staged work that are not on Ship yet: the strip offers to add them.
var shipCands=[];
function loadShipCands(){fetch('/api/ship/candidates').then(r=>r.json()).then(j=>{const c=(j&&j.ok&&j.candidates)||[];if(JSON.stringify(c)===JSON.stringify(shipCands))return;shipCands=c;if(tab==='board')render();}).catch(()=>{});}
// A ship whose PR is still open (CI, review, merge) keeps the line up: shipping is work in progress until it lands.
function shipsInFlight(b){return (b.shipped||[]).filter(x=>x.state==='OPEN');}
function shipStrip(){if(tab!=='board')return '';const bs=DATA.ships||[];
  let h=bs.map(b=>{const n=b.next;const l=b.lock;const shipping=!!(l&&!l.stale);const cls=shipping||(!n.staged&&shipsInFlight(b).length)?'shipping':(n.staged>0?'staged':(n.unstaged>0?'unstaged':'idle'));let t;
    if(shipping)t='<span class="pdot"></span><span class="sl">⚓ Shipping · '+esc(shipWho(b))+(l.batch.length?' · '+l.batch.length+' files':'')+'</span>';
    else{
      // Always shown: one line per ship repo, saying what state it is in.
      const f=shipsInFlight(b);const parts=[];
      if(n.staged>0)parts.push(n.staged+' staged');
      if(n.unstaged>0)parts.push(n.unstaged+' unstaged');
      if(n.unattributed.length)parts.push(n.unattributed.length+' unattributed');
      if(f.length)parts.push('#'+f.map(x=>x.number).join(', #')+' in review');
      const head=n.staged>0?'Next ship':(f.length&&!n.unstaged?'⚓ Shipped':'Next ship');
      t=(f.length&&!n.staged?'<span class="pdot"></span>':'<span>⛵</span>')+'<span class="sl">'+head+' · '+(parts.length?parts.join(' · '):'no changes')+'</span>';
    }
    return '<div class="shipln '+cls+(shipOpen?' open':'')+'" data-tour="ship"><button type="button" class="shipbar" data-shiptog="1" aria-expanded="'+shipOpen+'">'+t+'<span class="chev">›</span></button><span class="shipacts">'+shipGoBtn(b)+'<button type="button" class="shipicon" data-shipview="'+esc(b.repo)+'" title="View staged work" aria-label="View staged work">\u2630</button></span>'+(shipOpen?shipBody(b):'')+'</div>';}).join('');
  h+=shipCands.map(c=>'<div class="shipln idle"><button type="button" class="shipbar" data-shipadd="'+esc(c.repo)+'" title="'+esc(c.slug+' · '+c.staged+' staged · ships to '+c.base)+'"><span>⛵</span><span class="sl">Add '+esc(c.name)+' to Ship · '+c.staged+' staged</span></button></div>').join('');
  if(typeof shipFilter==='number')h='<div class="shipstrip"><div class="sh"><b>Showing ship #'+shipFilter+'</b><span class="dsub">its chats, live or not</span><span class="spacer"></span><button class="shipchip on" data-shipf="'+shipFilter+'">clear ✕</button></div></div>'+h;
  return h;}
function setShipFilter(v){shipFilter=(shipFilter===v)?null:v;render();}
function wireShips(root){root.querySelectorAll('[data-shipadd]').forEach(el=>el.onclick=(e)=>{e.stopPropagation();shipAddRepo(el.dataset.shipadd,()=>{shipCands=shipCands.filter(c=>c.repo!==el.dataset.shipadd);refresh();setTimeout(loadShipCands,1500);});});
  root.querySelectorAll('[data-shipview]').forEach(el=>el.onclick=(e)=>{e.stopPropagation();openShipModal(el.dataset.shipview,false);});
  root.querySelectorAll('[data-shipgo]').forEach(el=>el.onclick=(e)=>{e.stopPropagation();openShipModal(el.dataset.shipgo,true);});
  root.querySelectorAll('[data-shiptog]').forEach(el=>el.onclick=()=>{shipOpen=!shipOpen;lsSet('loom.shipOpen',shipOpen?'1':'0');render();});
  root.querySelectorAll('[data-shipf]').forEach(el=>el.onclick=(e)=>{e.stopPropagation();const v=el.dataset.shipf;setShipFilter(v==='next'?'next':Number(v));});
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
// ---- Main area: the selected chat --------------------------------------------
// Header (state, location, actions), then Terminal | Transcript. Terminal is the
// default for a live chat; a chat that is not running opens on Transcript under a
// Not running banner. renderMain() is cheap to call: the header, tab bar and
// banner skip when nothing they show changed, and the terminal only reattaches
// when the chat or its pane changes.
var mtab='terminal', MSGS_SIG='', closeArm='', closeTimer=null;
function selKey(){return sel?sel.agent+':'+sel.sid:'';}
function selChat(){if(!sel)return null;if(sel.arch)return sel.chat||null;return DATA.chats.find(c=>c.agent===sel.agent&&c.session_id===sel.sid)||null;}
function isTurn(c){return st(c)==='waiting_on_user'&&!isWorking(c);}
function detailFor(c){return DETAIL&&c&&DETAIL.session_id===c.session_id?DETAIL:null;}
function prStateOf(c){const d=detailFor(c);const pr=d&&d.pr&&!d.pr.loading?d.pr:null;if(!pr)return '';return pr.state==='MERGED'?'merged':pr.state==='CLOSED'?'closed':pr.isDraft?'draft':'review';}
function slackKeyOf(c){const p=slackPrimary(slackThreadsOf(c));return p?p.key:'';}
function slackDraftUrl(c){const f=draftThreadOf(DATA.drafts,c.session_id);return f?f.url:'';}
function stateLabel(c){return DOT_LABEL[dotCls(c)];}
function resumeCmd(c){const dir=c.project_dir?('cd '+shortPath(c.project_dir)+' && '):'';return dir+(c.agent==='codex'?'codex resume ':'claude --resume ')+c.session_id;}
function selectChat(sid,agent,arch){leaveOrch();leaveTerminal();if(sel&&sel.sid===sid&&sel.agent===agent&&!!sel.arch===!!arch)return;sel={sid,agent,arch:arch||null,chat:arch?archChatOf(sid):null};closeCtx();
  const sc=selChat();if(sc&&!sel.arch&&pipeEvent(sc)){ackPipe(sc);setTimeout(render,0);}
  DETAIL=null;lastOpen=false;MSGS_SIG='';closeArm='';$('#mhead').dataset.sig='';$('#mtabs').dataset.sig='';$('#mbanner').dataset.sig='';
  mtab=(!sel.arch&&livePaneFor(sid,agent)&&TERM_TOKEN)?'terminal':'transcript';
  document.querySelectorAll('#sidelist .srow, #kanban .tk').forEach(el=>el.classList.toggle('sel',el.dataset.sid===sid&&el.dataset.agent===agent&&!!el.dataset.jsonl===!!arch));
  $('#mmsgs').innerHTML='<p class="muted">loading…</p>';$('#mdetail').innerHTML='';$('#mfoot').innerHTML='';
  renderMain();loadTranscript(true);clearInterval(detailTimer);clearTimeout(detailRetry);
  if(!sel.arch){loadDetail();detailTimer=setInterval(loadDetail,20000);}}
function archChatOf(sid){const h=archHits.find(x=>x.session_id===sid)||JUMP.hits.find(x=>x.session_id===sid);return h?archChat(h):null;}
function deselect(){sel=null;DETAIL=null;clearInterval(detailTimer);clearTimeout(detailRetry);closeCtx();document.querySelectorAll('#sidelist .srow.sel, #kanban .tk.sel').forEach(el=>el.classList.remove('sel'));renderMain();}
// A Tickets card opens its chat in the Sessions view, where the terminal lives.
function openInBoard(sid,agent){const c=DATA.chats.find(x=>x.agent===agent&&x.session_id===sid);tab=c&&c.saved?'saved':'board';stateFilter='all';selectChat(sid,agent,null);syncControls();liveToggle();chips();render();}
// ---- Jump with the terminal set to inside Loom ---------------------------------
// The server publishes the newest jump request; when its seq moves, open the chat
// in that pane. The first poll only records the seq, so a stale request never fires.
var FOCUS_SEQ=null;
function checkInsideFocus(f){if(!f)return;if(FOCUS_SEQ===null){FOCUS_SEQ=f.seq;return;}if(f.seq===FOCUS_SEQ)return;FOCUS_SEQ=f.seq;
  const k=Object.keys(DATA.live).find(x=>DATA.live[x].pane_id===f.pane_id);if(!k)return;const L=DATA.live[k];
  const c=DATA.chats.find(x=>chatKey(x)===k);if(!c)return;openInBoard(c.session_id,c.agent);if(TERM_TOKEN)mtab='terminal';renderMain();if(typeof setPending==='function')setPending(null);}
// A notification click lands here (app/main.ts): switch to the tab that lists the chat, drop any filter hiding it,
// select it and open its terminal. A chat not indexed yet gets one retry after a refresh, then a toast.
window.loomOpenChat=function(agent,sid,retried){
  const c=DATA.chats.find(x=>x.session_id===sid&&(!agent||x.agent===agent));
  if(!c){if(retried){toast('that chat is not on the board','#8a2b2e');return;}
    refresh();setTimeout(function(){window.loomOpenChat(agent,sid,true);},1500);return;}
  const q=$('#q');if(q&&q.value)q.value='';onlyGroup=null;
  openInBoard(c.session_id,c.agent);if(TERM_TOKEN)mtab='terminal';renderMain();if(typeof setPending==='function')setPending(null);
  setTimeout(function(){const r=document.querySelector('#sidelist .srow.sel, #kanban .tk.sel');if(r&&r.scrollIntoView)r.scrollIntoView({block:'nearest'});},0);
};
// A notification about a PR: open the chat working on it (the most recently active one), else the orchestrator.
window.loomOpenPr=function(url){
  const want=String(url||'').replace(/[#?].*$/,'').replace(/[/]+$/,'');
  const c=DATA.chats.filter(x=>x.pr_url&&String(x.pr_url).replace(/[#?].*$/,'').replace(/[/]+$/,'')===want).sort((a,b)=>fresh(b)-fresh(a))[0];
  if(c){window.loomOpenChat(c.agent,c.session_id);return;}
  if(typeof selectOrch==='function')selectOrch();
};
${SETTINGS_VIEW_JS}
${PRUNE_VIEW_JS}
// ---- Slack auto-start banner ----------------------------------------------------
// A hotkey press on a thread no chat owned started one (server: slackowner.ts).
// The newest start opens in the main area with this banner over it; the chat is
// not on the board until it is indexed, so the selection waits for it.
var SLK_SEEN=null,SLK_PENDING=null,SLK_OPEN='';
var SLK_SRC={channel:'mapped from this channel',last:'the project you last started a chat in',recent:'the project of your most recent chat'};
function postJ(u,o){return fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(o)}).then(r=>r.json());}
function slackStartFor(c){return (DATA.slackStarts||[]).find(s=>s.agent===c.agent&&((s.session_id&&s.session_id===c.session_id)||(!s.session_id&&(DATA.live[chatKey(c)]||{}).pane_id===s.pane_id)))||null;}
function checkSlackStarts(){const S=DATA.slackStarts||[];
  S.forEach(s=>{const k=s.key+'@'+s.at;if(SLK_SEEN&&SLK_SEEN[k])return;
    // The first poll only skips starts that predate this page; one made a moment ago is new.
    if(SLK_SEEN===null&&Date.now()-s.at>60000){return;}
    (SLK_SEEN=SLK_SEEN||{})[k]=1;SLK_PENDING=s;});
  if(SLK_SEEN===null)SLK_SEEN={};
  if(!SLK_PENDING)return;const s=SLK_PENDING;
  const c=DATA.chats.find(x=>x.agent===s.agent&&((s.session_id&&x.session_id===s.session_id)||(DATA.live[chatKey(x)]||{}).pane_id===s.pane_id));
  if(c){SLK_PENDING=null;openInBoard(c.session_id,c.agent);}}
function renderSlackStart(c){const el=$('#mslack');const s=(sel&&!sel.arch)?slackStartFor(c):null;
  const sig=s?(s.key+'@'+s.at+'|'+SLK_OPEN):'';if(el.dataset.sig===sig)return;el.dataset.sig=sig;
  if(!s){el.innerHTML='';return;}
  const seen={},dirs=[];DATA.chats.slice().sort((a,b)=>b.last_active_at-a.last_active_at).forEach(x=>{if(x.project_dir&&!seen[x.project_dir]){seen[x.project_dir]=1;dirs.push(x.project_dir);}});
  if(!seen[s.project_dir])dirs.unshift(s.project_dir);
  const pick=SLK_OPEN?'<div class="bt" style="flex-basis:100%"><select id="slkproj">'+dirs.map(d=>'<option value="'+esc(d)+'"'+(d===s.project_dir?' selected':'')+'>'+esc(shortPath(d))+'</option>').join('')+'</select> '+'<button type="button" class="mbtn pri" data-sl="apply">Restart here</button>'+'<span style="display:block;margin-top:4px">This closes the chat just started, starts a new one in that project, and maps this channel to it from now on.</span></div>':'';
  el.innerHTML='<div class="banner slack"><div class="bt"><b>Started a chat for this Slack thread. No chat owned it.</b><span>'+(s.where?esc(s.where)+', ':'')+'project '+esc(s.project)+' ('+esc(SLK_SRC[s.project_source]||'')+'). Loom now owns this thread, so the hotkey returns here next time.</span>'+
    (s.quote?'<div class="slackq">'+(s.author?'<b>'+esc(s.author)+'</b> · ':'')+esc(s.quote)+'</div>':'')+'</div>'+
    '<button type="button" class="mbtn" data-sl="change">Change project</button><button type="button" class="mbtn" data-sl="dismiss">Dismiss</button>'+pick+'</div>';}
function wireSlackStart(){$('#mslack').addEventListener('click',e=>{const b=e.target.closest('button[data-sl]');if(!b)return;const c=selChat();const s=c&&slackStartFor(c);if(!s)return;
  const a=b.dataset.sl;
  if(a==='change'){SLK_OPEN=SLK_OPEN?'':'1';$('#mslack').dataset.sig='';renderSlackStart(c);return;}
  if(a==='dismiss'){postJ('/api/slack/start/dismiss',{key:s.key,at:s.at}).then(()=>refresh());return;}
  if(a==='apply'){const dir=$('#slkproj').value;b.disabled=true;
    postJ('/api/slack/start/project',{key:s.key,at:s.at,project:dir}).then(j=>{b.disabled=false;
      if(j.ok){SLK_OPEN='';SLK_PENDING=j.started;toast('restarted in '+shortPath(dir));setTimeout(refresh,800);setTimeout(refresh,3000);}
      else toast(j.detail||'could not restart','#8a2b2e');}).catch(()=>{b.disabled=false;toast('server off','#8a2b2e');});}});}
function renderMain(){const box=$('#chatmain');renderOutbox();
  if(orchSel){box.classList.remove('empty');box.classList.add('orch');if(termKey&&termKey.indexOf('orch|')!==0)closeTerm();renderOrch(false);return;}
  box.classList.remove('orch');
  if(tsel){renderTermMain();return;}
  if(!sel){box.classList.add('empty');closeTerm();renderWaiting();return;}
  const c=selChat();
  if(!c){box.classList.add('empty');closeTerm();$('#mempty').innerHTML='<div class="dempty">That chat is no longer on the board.</div>';return;}
  box.classList.remove('empty');
  const L=(sel.arch?null:DATA.live[chatKey(c)])||pendingLiveFor(c);const live=!!L;
  const eff=(live&&TERM_TOKEN&&mtab==='terminal')?'terminal':'transcript';
  renderHead(c,L,live);renderTabsBar(live,eff);renderSlackStart(c);
  $('#mterm').style.display=eff==='terminal'?'':'none';
  $('#mtxwrap').style.display=eff==='transcript'?'':'none';
  $('#mfoot').style.display=eff==='transcript'?'':'none';
  if(eff==='terminal'){syncTerm(L);}else{closeTerm();renderBanner(c,live);renderAside(c,L);}}
// Same chat still selected: the terminal is already open, but tell the server to put its view back on this
// chat's pane, in case something moved it (ptybridge.realignView). Cheap, and runs on every render.
function syncTerm(L){const key=L.pane_id+'|'+selKey();if(termKey===key){alignTerm();return;}openTerm(L.pane_id,$('#mterm'));termKey=key;}
function alignTerm(){try{if(termWs&&termWs.readyState===1)termWs.send(JSON.stringify({t:'a'}));}catch(e){}}
function renderTabsBar(live,eff){const el=$('#mtabs');const sig=live+'|'+eff+'|'+!!TERM_TOKEN;if(el.dataset.sig===sig)return;el.dataset.sig=sig;
  const can=live&&!!TERM_TOKEN;
  el.innerHTML='<button type="button" role="tab" class="mtab'+(eff==='terminal'?' on':'')+'" data-t="terminal"'+(can?'':' disabled title="'+(live?'the terminal needs the running Loom server':'not running')+'"')+'>Terminal</button>'+
    '<button type="button" role="tab" class="mtab'+(eff==='transcript'?' on':'')+'" data-t="transcript">Transcript</button>';}
function mbtn(act,label,cls,extra){return '<button type="button" class="mbtn'+(cls?' '+cls:'')+'" data-act="'+act+'"'+(extra||'')+'>'+label+'</button>';}
function renderHead(c,L,live){const h=$('#mhead');const prn=chatPrNum(c),prs=prStateOf(c),sk=slackKeyOf(c);
  const sig=[c.session_id,chatTags(c).join(','),JSON.stringify(DATA.tags||[]),disp(c),dotCls(c),live,L&&L.name,L&&L.tmux_session,L&&L.window_index,L&&L.pane_index,c.saved,prn,prs,ownsSlack(c),sk,slackSig(c),testLinksOf(c).length,prciSig(c),!!c.arch,c.project_dir].join('|');
  if(h.dataset.sig===sig)return;if(h.querySelector('.picker:not(:empty)'))return;h.dataset.sig=sig;
  const where=L?(L.pending?'starting…':L.tmux_session+':'+L.window_index+'.'+L.pane_index):(c.arch?'archive':'not running');
  const pn=L?(L.name||L.pane_index):'none';
  const canLaunch=!!(c.project_dir&&c.project_dir.trim());
  let b='';
  if(!live)b+=mbtn('resume','▶ Resume','pri',canLaunch?'':' disabled title="no project directory recorded"')+mbtn('branch','⑃ Branch','',canLaunch?'':' disabled');
  b+=prciHeadHtml(c);
  b+=slackHeadHtml(c);
  b+=testHeadHtml(c);
  if(!c.arch)b+=mbtn('save','★ '+(c.saved?'Saved':'Save for later'),c.saved?'on':'',' aria-pressed="'+(!!c.saved)+'" title="'+(c.saved?'remove from Saved for later':(live?'save for later and close this pane':'save for later'))+'"');
  b+=mbtn('more','⋯','sq',' aria-haspopup="menu" aria-label="More actions"');
  h.innerHTML='<div class="mh-l"><div class="mh-t"><span class="sdot '+dotCls(c)+'"></span><h1 title="'+esc(disp(c))+'">'+esc(disp(c))+'</h1><span class="mpill '+dotCls(c)+'">'+esc(stateLabel(c))+'</span><span class="mpill src">'+brandIcon(c.agent==='codex'?'codex':'claude')+agentLabel(c.agent)+'</span></div>'+
    '<div class="mh-sub">'+esc(shortPath(c.project_dir)||c.project)+' · pane '+(L&&L.name?'<span class="cname">'+esc(L.name)+'<button type="button" class="cpi" data-copyname="'+esc(L.name)+'" title="Copy name" aria-label="Copy name '+esc(L.name)+'">⧉</button></span>':esc(pn))+' · '+esc(where)+'</div>'+(c.arch?'':'<div class="mh-tags">'+chatTags(c).map(n=>tagChipHtml(n)).join('')+'<button type="button" class="tgadd" data-act="tagpop" title="tag this chat">+ Tag</button></div>')+'</div><div class="mh-r">'+b+'</div><div class="picker"></div>';}
function renderBanner(c,live){const el=$('#mbanner');const pk=parkedOf(c);const sig=live+'|'+c.session_id+'|'+!!c.arch+'|'+(pk?pk.state+pk.reply_ts+pk.label:'');if(el.dataset.sig===sig)return;el.dataset.sig=sig;
  if(pk&&!live){const rp=pk.state==='replied';
    el.innerHTML='<div class="banner parkbar"><div class="bt"><b>'+(rp?esc(pk.reply_user||'Someone')+' replied':'Parked: '+esc(pk.label))+'</b><span>'+(rp?esc(pk.reply_first_line||''):'This chat was closed after Send &amp; park. It comes back to Your turn when someone other than you replies in the thread.')+'</span></div>'+
      (rp?mbtn('resumeparked','▶ Resume with the reply','pri'):'')+(pk.thread_url?mbtn('parkthread','Open thread',''):'')+mbtn('unpark','Unpark','')+'</div>';return;}
  if(live){el.innerHTML='';return;}
  const canLaunch=!!(c.project_dir&&c.project_dir.trim());
  el.innerHTML='<div class="banner"><div class="bt"><b>'+(c.arch?'Archived chat':'Not running')+'</b><span>Last active '+esc(rel(c.arch?c.last_active_at:fresh(c)))+'. '+(canLaunch?'Resume continues it in an open pane; Branch forks it and leaves the original untouched.':'No project directory was recorded, so it cannot be resumed.')+'</span></div>'+
    mbtn('resume','▶ Resume','pri',canLaunch?'':' disabled')+mbtn('branch','⑃ Branch','',canLaunch?'':' disabled')+
    mbtn('startother','⊕ Start with '+agentLabel(otherAgent(c.agent)),'',(canLaunch?'':' disabled')+' title="start a fresh '+agentLabel(otherAgent(c.agent))+' session in this project (no context carried over)"')+'</div>';}
// ---- Header and banner actions, shared with the menu --------------------------
function startLaunch(c,action,agent){selectChat(c.session_id,c.agent,c.arch||null);openPicker(c.session_id,c.agent,$('#mhead'),action,c.arch?c.arch.proj:'',agent||c.agent);}
function openSlack(c){const p=slackPrimary(slackThreadsOf(c));if(p){slackPost(p);return;}
  fetch('/api/detail?session='+encodeURIComponent(c.session_id)+'&agent='+encodeURIComponent(c.agent)).then(r=>r.json()).then(d=>{const t=(d.slackAll&&d.slackAll[0])||(d.slack&&d.slack[0]);if(t)slackPost(t);else toast('no Slack thread found','#8a2b2e');}).catch(()=>toast('server off','#8a2b2e'));}
function copyText(text,msg){const ok=()=>toast(msg);const fb=()=>{try{const ta=document.createElement('textarea');ta.value=text;ta.style.position='fixed';ta.style.opacity='0';document.body.appendChild(ta);ta.select();const done=document.execCommand('copy');ta.remove();if(done)ok();else toast('copy failed','#8a2b2e');}catch(e){toast('copy failed','#8a2b2e');}};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(text).then(ok).catch(fb);else fb();}
function runAction(key,c){const L=c.arch?null:DATA.live[chatKey(c)];const k=chatKey(c);
  switch(key){
    case 'unpark':doUnpark(c);break;
    case 'restore':doRestore(c);break;
    case 'parkthread':{const pk=parkedOf(c);const r=pk&&slackRefOf(pk.thread_url);if(r)slackPost(r);else openSlack(c);break;}
    case 'resumeparked':doParkResume(c);break;
    case 'open':if(parkedOf(c)&&parkedOf(c).state==='replied'){doParkResume(c);break;}if(L){selectChat(c.session_id,c.agent,null);if(TERM_TOKEN)mtab='terminal';renderMain();}else startLaunch(c,'resume');break;
    case 'resume':if(parkedOf(c)&&parkedOf(c).state==='replied'){doParkResume(c);break;}startLaunch(c,'resume');break;
    case 'startother':startLaunch(c,'resume',otherAgent(c.agent));break;
    case 'branch':startLaunch(c,'branch');break;
    case 'external':if(L)jump(c.session_id,c.agent);break;
    case 'pr':{const u=chatPrUrl(c);if(u)window.open(u,'_blank','noopener');break;}
    case 'save':if(c.saved)doUnsave(c.session_id,c.agent);else doSave(c.session_id,c.agent);break;
    case 'copyResume':copyText(resumeCmd(c),'resume command copied');break;
    case 'copyId':copyText(c.session_id,'session id copied');break;
    case 'rename':openRename(c);break;
    case 'tags':if(ctxState){ctxState.tagsOpen=!ctxState.tagsOpen;renderCtx();}return;
    case 'slack':if(ctxState&&slackThreadsOf(c).length>1){ctxState.slackOpen=!ctxState.slackOpen;renderCtx();return;}openSlack(c);break;
    case 'tagpop':return;
    case 'orchestrator':closeCtx();askOrchestrator(c);return;
    case 'close':
      if(L){if(closeArm!==k){closeArm=k;renderCtx();clearTimeout(closeTimer);closeTimer=setTimeout(()=>{if(closeArm===k){closeArm='';renderCtx();}},2500);return;}closeArm='';closeCtx();doClose(c.session_id,c.agent);}
      else{closeCtx();removeFromBoard(c);}
      return;
  }
  if(key!=='more')closeCtx();}
function removeFromBoard(c){const nav=closeNavPlan(c);fetch('/api/hide',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:c.session_id,agent:c.agent})}).then(r=>r.json()).then(j=>{toast(j.ok?'removed from the board':(j.detail||'failed'),j.ok?'#1f6f3f':'#8a2b2e');if(j.ok){DATA.chats=DATA.chats.filter(x=>!(x.agent===c.agent&&x.session_id===c.session_id));if(sel&&sel.sid===c.session_id&&sel.agent===c.agent)deselect();closeNavGo(nav);render();}setTimeout(refresh,800);}).catch(()=>toast('server off','#8a2b2e'));}
// ---- Context menu ---------------------------------------------------------------
var ctxState=null;
function ctxInput(c){const L=c.arch?null:DATA.live[chatKey(c)];return {live:!!L,done:!!c.done,parked:!!parkedOf(c),saved:!!c.saved,archive:!!c.arch,prNum:chatPrNum(c),prState:prStateOf(c),hasSlack:ownsSlack(c),slackCount:slackCountOf(c),armedClose:closeArm===chatKey(c),tagCount:chatTags(c).length,orchLive:!!(DATA.orch&&DATA.orch.live),extLabel:(DATA.terminal&&DATA.terminal.label)||''};}
function openCtx(c,x,y,anchor,only){closeArm='';ctxState={c,x,y,anchor,only:only||'',tagsOpen:false,slackOpen:false};renderCtx();}
function currentChat(c){return c.arch?c:(DATA.chats.find(x=>x.agent===c.agent&&x.session_id===c.session_id)||c);}
// Tags submenu: a checkbox per tag, then an inline field that creates a tag (colour
// picked automatically) and applies it to this chat.
function tagsPanel(c){const has=chatTags(c);return '<div class="cmtags">'+((DATA.tags||[]).map(t=>{const on=has.indexOf(t.name)>=0;return '<button type="button" class="cmi tg" role="menuitemcheckbox" aria-checked="'+on+'" data-tag="'+esc(t.name)+'"><span class="tgck">'+(on?'☑':'☐')+'</span><span class="tgdot" style="background:'+t.color+'"></span><span class="tgn">'+esc(t.name)+'</span></button>';}).join(''))+'<input id="newtag" class="newtag" maxlength="40" placeholder="New tag…" aria-label="New tag name"/></div>';}
function tagPost(url,body){return fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json());}
function applyTags(c,j){if(j.tags_all)DATA.tags=j.tags_all;const x=DATA.chats.find(v=>v.agent===c.agent&&v.session_id===c.session_id);if(x&&j.tags)x.tags=j.tags;$('#mhead').dataset.sig='';render();if(ctxState)renderCtx();}
function setTagsFor(c,names){return tagPost('/api/chat-tags',{session:c.session_id,agent:c.agent,tags:names}).then(j=>{if(!j.ok){toast(j.detail||'failed','#8a2b2e');return j;}applyTags(c,j);return j;}).catch(()=>toast('server off','#8a2b2e'));}
function toggleTag(c0,name){const c=currentChat(c0);const has=chatTags(c);setTagsFor(c,has.indexOf(name)>=0?has.filter(n=>n!==name):has.concat([name]));}
function createTagFor(c0,name){const c=currentChat(c0);name=name.trim();if(!name)return;tagPost('/api/tags',{name}).then(j=>{if(!j.ok&&!/exists/.test(j.detail||'')){toast(j.detail||'failed','#8a2b2e');return;}if(j.tags_all)DATA.tags=j.tags_all;const t=(DATA.tags||[]).find(x=>x.name.toLowerCase()===name.toLowerCase());const n=t?t.name:name;const has=chatTags(c);return setTagsFor(c,has.indexOf(n)>=0?has:has.concat([n]));}).then(()=>{const i=$('#newtag');if(i){i.value='';i.focus();}}).catch(()=>toast('server off','#8a2b2e'));}
function closeCtx(){ctxState=null;closeArm='';const m=$('#ctx');if(m){m.hidden=true;m.innerHTML='';}}
function renderCtx(){const m=$('#ctx');if(!ctxState){m.hidden=true;m.innerHTML='';return;}
  const c=currentChat(ctxState.c);
  if(ctxState.only==='tags'){m.innerHTML=tagsPanel(c);}
  else{const items=chatMenuItems(ctxInput(c));
  m.innerHTML=items.map(i=>(i.divider?'<div class="cmdiv"></div>':'')+'<button type="button" role="menuitem" class="cmi'+(i.danger?' danger':'')+(i.disabled?' dis':'')+'" data-k="'+i.key+'"'+(i.disabled?' aria-disabled="true"':'')+(i.tip?' title="'+esc(i.tip)+'"':'')+'><span>'+esc(i.label)+'</span><span class="cmh">'+esc(i.hint)+'</span></button>'+(i.key==='tags'&&ctxState.tagsOpen?tagsPanel(c):'')+(i.key==='slack'&&ctxState.slackOpen?'<div class="cmslack">'+slackPanelHtml(c)+'</div>':'')).join('');}
  m.hidden=false;const w=m.offsetWidth,h=m.offsetHeight;let x=ctxState.x,y=ctxState.y;
  if(ctxState.anchor){x=ctxState.anchor.right-w;y=ctxState.anchor.bottom+6;}
  x=Math.max(8,Math.min(x,window.innerWidth-w-8));y=Math.max(8,Math.min(y,window.innerHeight-h-8));m.style.left=x+'px';m.style.top=y+'px';}
// Tag filter (multi-select, any-of) and the Status | Tag group-by switch.
function saveTagSel(){lsSet('loom.tagFilter',JSON.stringify(tagSel));}
function renderTagBtn(){const b=$('#tagbtn');if(!b)return;const names=(DATA.tags||[]).map(t=>t.name);tagSel=tagSel.filter(n=>n===UNTAGGED||names.indexOf(n)>=0);const n=tagSel.length;b.textContent=n?'Tags: '+(n===1?(tagSel[0]===UNTAGGED?'Untagged':tagSel[0]):n+' selected'):'All tags';b.classList.toggle('on',n>0);}
function renderTagPop(){const p=$('#tagpop');if(p.hidden)return;const r=$('#tagbtn').getBoundingClientRect();const rows=(DATA.tags||[]).map(t=>({n:t.name,c:t.color,k:t.count})).concat([{n:UNTAGGED,c:'#8a90a2',k:null}]);
  p.innerHTML=rows.map(t=>{const on=tagSel.indexOf(t.n)>=0;return '<button type="button" class="cmi tg" role="menuitemcheckbox" aria-checked="'+on+'" data-tf="'+esc(t.n)+'"><span class="tgck">'+(on?'☑':'☐')+'</span><span class="tgdot" style="background:'+t.c+'"></span><span class="tgn">'+(t.n===UNTAGGED?'Untagged':esc(t.n))+'</span>'+(t.k!==null?'<span class="cmh">'+t.k+'</span>':'')+'</button>';}).join('')+(tagSel.length?'<div class="cmdiv"></div><button type="button" class="cmi" data-tfclear="1">Clear tag filter</button>':'');
  p.style.left=Math.max(8,r.left)+'px';p.style.top=(r.bottom+4)+'px';}
function renderGroupBy(){const g=$('#groupby');if(!g)return;g.innerHTML='<button data-g="status" class="'+(groupBy==='status'?'on':'')+'" title="group by status">Status</button><button data-g="tag" class="'+(groupBy==='tag'?'on':'')+'" title="group by tag">Tag</button>';}
function wireTagFilter(){const p=$('#tagpop');
  $('#tagbtn').onclick=e=>{e.stopPropagation();p.hidden=!p.hidden;renderTagPop();};
  p.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.tfclear){tagSel=[];}else if(b.dataset.tf!==undefined){const i=tagSel.indexOf(b.dataset.tf);if(i>=0)tagSel.splice(i,1);else tagSel.push(b.dataset.tf);}saveTagSel();renderTagBtn();renderTagPop();render();});
  document.addEventListener('mousedown',e=>{if(!p.hidden&&!e.target.closest('#tagpop,#tagbtn'))p.hidden=true;});
  $('#groupby').addEventListener('click',e=>{const b=e.target.closest('button[data-g]');if(!b||b.dataset.g===groupBy)return;groupBy=b.dataset.g;lsSet('loom.groupBy',groupBy);renderGroupBy();render();});
  renderTagBtn();renderGroupBy();}
function wireMain(){
  $('#ctx').addEventListener('click',e=>{const b=e.target.closest('.cmi,.skrow');if(!b||b.classList.contains('dis')||!ctxState)return;if(b.dataset.tag!==undefined){toggleTag(ctxState.c,b.dataset.tag);return;}if(b.classList.contains('skrow')){const t=slackThreadsOf(currentChat(ctxState.c))[Number(b.dataset.i)];closeCtx();if(t)slackPost(t);return;}runAction(b.dataset.k,ctxState.c);});
  $('#ctx').addEventListener('keydown',e=>{if(e.target.id==='newtag'&&e.key==='Enter'&&ctxState){e.preventDefault();createTagFor(ctxState.c,e.target.value);}});
  wireTagFilter();
  document.addEventListener('mousedown',e=>{if(ctxState&&!e.target.closest('#ctx'))closeCtx();});
  window.addEventListener('blur',closeCtx);window.addEventListener('resize',closeCtx);
  $('#sidelist').addEventListener('scroll',closeCtx);
  const onAct=e=>{const b=e.target.closest('button[data-act]');if(!b||b.disabled)return;const c=selChat();if(!c)return;
    if(b.dataset.act==='prci'){prciOpen(prciOf(c)[0]&&prciOf(c)[0].url);return;}
    if(b.dataset.act==='prcimenu'){closeTestPop();closeCtx();closeSlackDD();togglePrDD(c,b);return;}
    if(b.dataset.act==='more'){closePrDD();closeSlackDD();openCtx(c,0,0,b.getBoundingClientRect());return;}
    if(b.dataset.act==='testlinks'){closeCtx();closeSlackDD();toggleTestPop(c,b);return;}
    if(b.dataset.act==='slackmenu'){closeTestPop();closeCtx();toggleSlackDD(c,b);return;}
    if(b.dataset.act==='tagpop'){openCtx(c,0,0,b.getBoundingClientRect(),'tags');setTimeout(()=>{const i=$('#newtag');if(i)i.focus();},0);return;}
    runAction(b.dataset.act,c);};
  $('#mhead').addEventListener('click',onAct);$('#mbanner').addEventListener('click',onAct);wireSlackStart();wireSlackDD();wirePrDD();wireTestPop();$('#mhead').addEventListener('click',e=>{const cn=e.target.closest('[data-copyname]');if(cn){e.stopPropagation();copyName(cn.dataset.copyname);}});
  $('#mtabs').addEventListener('click',e=>{const b=e.target.closest('button[data-t]');if(!b||b.disabled)return;mtab=b.dataset.t;if(mtab==='transcript')loadTranscript(true);renderMain();});
  $('#sidetoggle').onclick=()=>{const hide=!document.body.classList.contains('sidehide');document.body.classList.toggle('sidehide',hide);lsSet('loom.sidehide',hide?'1':'');};
  if(lsGet('loom.sidehide')==='1')document.body.classList.add('sidehide');
  wireSidebar();wireSideGrip();wireHoverPrefetch();wireSideTop();wireRename();wireOrch();wireOutbox();
  setInterval(()=>{if(!document.hidden&&sel&&mtab==='transcript'&&!sel.arch&&selChat()&&DATA.live[selKey()])loadTranscript(false);},1500);}
// ---- Rename ---------------------------------------------------------------------
var renameFor=null;
function openRename(c){renameFor=c;$('#renamebox').hidden=false;$('#rninput').value=disp(c);$('#rnmsg').textContent='';setTimeout(()=>{$('#rninput').focus();$('#rninput').select();},0);}
function closeRename(){renameFor=null;$('#renamebox').hidden=true;}
function saveRename(){const c=renameFor;if(!c)return;const title=$('#rninput').value.trim();
  fetch('/api/rename',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({session:c.session_id,agent:c.agent,title})}).then(r=>r.json()).then(j=>{if(!j.ok){$('#rnmsg').textContent=j.detail||'failed';return;}closeRename();toast(title?'renamed':'title restored');const x=DATA.chats.find(v=>v.agent===c.agent&&v.session_id===c.session_id);if(x){x.title=title||x.claude_auto_title||'';}$('#mhead').dataset.sig='';render();setTimeout(refresh,600);}).catch(()=>{$('#rnmsg').textContent='server off';});}
function wireRename(){$('#rncancel').onclick=closeRename;$('#rnsave').onclick=saveRename;
  $('#renamebox').addEventListener('mousedown',e=>{if(e.target.id==='renamebox')closeRename();});
  $('#renamebox').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeRename();}else if(e.key==='Enter'){e.preventDefault();saveRename();}});}
// ---- Transcript tab -----------------------------------------------------------
function loadTranscript(toBottom){if(!sel)return;const req=selKey();var u='/api/transcript?session='+encodeURIComponent(sel.sid)+'&agent='+encodeURIComponent(sel.agent);if(sel.arch)u+='&jsonl='+encodeURIComponent(sel.arch.jsonl)+'&proj='+encodeURIComponent(sel.arch.proj)+'&title='+encodeURIComponent(sel.arch.title);
  fetch(u).then(r=>r.json()).then(d=>{if(selKey()!==req||!d.ok)return;const wrap=$('#mmsgs');const atBottom=wrap.scrollTop+wrap.clientHeight>=wrap.scrollHeight-50;
    const last=d.messages.length?d.messages[d.messages.length-1].text:'';const sig=d.messages.length+':'+last.length;
    if(sig!==MSGS_SIG||toBottom){MSGS_SIG=sig;$('#mmsgs').innerHTML=d.messages.map(m=>'<div class="msg '+m.role+'"><div class="who">'+(m.role==='user'?'You':agentLabel(d.agent))+'</div>'+esc(m.text)+'</div>').join('')||'<p class="muted">no messages yet</p>';}
    if(toBottom||atBottom)wrap.scrollTop=wrap.scrollHeight;renderFoot(d);}).catch(()=>{});}
function renderFoot(d){const f=$('#mfoot');if(d.live&&sel&&!sel.arch&&DATA.live[selKey()]){if(!f.querySelector('textarea')){f.innerHTML='<textarea id="pinput" placeholder="message this chat… (Enter to send, Shift+Enter for newline)"></textarea><div class="sendrow"><span class="grow">types straight into the live '+agentLabel(d.agent)+' pane</span><button class="send" id="psend">Send ↵</button></div>';$('#psend').onclick=sendMsg;$('#pinput').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}});}}else{f.innerHTML='';}}
function sendMsg(){const ta=$('#pinput');if(!ta||!sel)return;const t=ta.value.trim();if(!t)return;ta.value='';fetch('/send?session='+encodeURIComponent(sel.sid)+'&agent='+encodeURIComponent(sel.agent)+'&text='+encodeURIComponent(t),{method:'POST'}).then(r=>r.json()).then(()=>{setTimeout(()=>loadTranscript(true),500);setTimeout(()=>loadTranscript(true),2500);}).catch(()=>{});}
// ---- Keymap ---------------------------------------------------------------------
// KEYMAP is src/keymap.ts (the page-bound entries); KEY_ACTIONS is the handler for each.
// An action returns true when it handled the key and the browser default should be
// suppressed. tests/keymap.test.ts pins the two lists to each other.
const KEYMAP=${pageKeymapJson()};
const KEY_ACTIONS={
  settings:function(e){openSettings();return true;},
  newThread:function(e){if(!composerOpen)openComposer();return true;},
  jump:function(e){jumpToggle();return true;},
  dismiss:function(e){if(hmenuClose())return false;if(e.target&&e.target.closest&&e.target.closest('#mterm,#oterm,.xterm'))return false;if(ctxState){closeCtx();return false;}if(sel)deselect();return false;}
};
function keyMatches(e,m){if(String(e.key).toLowerCase()!==m.key.toLowerCase())return false;
  if(m.plain)return !e.metaKey&&!e.ctrlKey&&!e.altKey&&!e.shiftKey;
  return !!m.meta===e.metaKey&&!e.ctrlKey&&!!m.alt===e.altKey&&!!m.shift===e.shiftKey;}
document.addEventListener('keydown',e=>{for(const k of KEYMAP){if(!keyMatches(e,k.match))continue;const fn=KEY_ACTIONS[k.action];if(fn&&fn(e)){e.preventDefault();}return;}});
// Embedded terminal. openTerm(paneId, el) attaches a live pane's terminal into el;
// closeTerm() detaches. The chat keeps running either way: only Loom's view of it
// closes. termSeq cancels an open that was superseded while xterm was still loading.
// Polls skip while the window is hidden or minimised (an Electron window kept in the tray still ticks otherwise).
function visOnly(f){return function(){if(!document.hidden)f();};}
var term=null,termWs=null,termFit=null,termRO=null,xtermLoading=null,termKey='',termSeq=0,termView='',termEl=null,cur=null,termPool=new WarmPool(4),snapCache=new SnapCache(snapFetch,1500);
function snapFetch(pane){return fetch('/api/term/snap?pane='+encodeURIComponent(pane),{headers:{'x-loom-term-token':TERM_TOKEN}}).then(r=>r.ok?r.json():null).then(j=>j&&j.ok?j:null).catch(()=>null);}
function loadXterm(){if(window.Terminal&&window.FitAddon)return Promise.resolve();if(xtermLoading)return xtermLoading;const css=document.createElement('link');css.rel='stylesheet';css.href='/vendor/xterm.css';document.head.appendChild(css);const js=src=>new Promise((ok,bad)=>{const s=document.createElement('script');s.src=src;s.onload=ok;s.onerror=bad;document.head.appendChild(s);});xtermLoading=js('/vendor/xterm.js').then(()=>js('/vendor/addon-fit.js')).then(()=>js('/vendor/addon-webgl.js').catch(()=>{})).then(()=>js('/vendor/addon-web-links.js').catch(()=>{})).catch(e=>{xtermLoading=null;throw e;});return xtermLoading;}
function livePaneFor(sid,agent){const l=DATA.live[agent+':'+sid];return l&&l.pane_id?l.pane_id:null;}
function openTerm(paneId,el){closeTerm();if(!TERM_TOKEN||!paneId)return Promise.resolve();const my=termSeq;const pk=typeof paneId==='string'?paneId:'';const warm=pk?termPool.take(pk):null;if(warm&&!warm.dead&&warm.ws&&warm.ws.readyState===1){showWarm(warm,el);return Promise.resolve();}if(warm)destroyEnt(warm);const snapP=pk?snapCache.get(pk):null;return loadXterm().then(()=>{if(my!==termSeq)return;termEl=el;
// paneId is a chat pane id, or {session,window} for a whole terminal window.
const col=document.createElement('div');col.className='tcol';const bar=document.createElement('div');bar.className='ttools';bar.innerHTML=toolbarHtml('window',false);const wrap=document.createElement('div');wrap.className='termwrap';col.appendChild(bar);col.appendChild(wrap);el.appendChild(col);
term=new Terminal({fontFamily:'ui-monospace,SFMono-Regular,Menlo,monospace',fontSize:12,cursorBlink:true,scrollback:1000,linkHandler:{activate:(ev,uri)=>{if(/^https?:/i.test(uri))window.open(uri,'_blank','noopener');},allowNonHttpProtocols:false},theme:{background:'#07080c',foreground:'#e6e6e6'}});termFit=new FitAddon.FitAddon();term.loadAddon(termFit);term.open(wrap);try{if(window.WebglAddon){const gl=new WebglAddon.WebglAddon();gl.onContextLoss(()=>{try{gl.dispose();}catch(e){}});term.loadAddon(gl);}}catch(e){}try{if(window.WebLinksAddon)term.loadAddon(new WebLinksAddon.WebLinksAddon((ev,u)=>{if(/^https?:/i.test(u))window.open(u,'_blank','noopener');}));}catch(e){}try{termFit.fit();}catch(e){}
const ent={key:pk,col,wrap,bar,term,ws:null,fit:termFit,ro:null,view:'',mode:'',dead:false,h:createHandoff(),parked:false,destroyed:false};cur=ent;
const tgt=typeof paneId==='string'?'pane='+encodeURIComponent(paneId):'session='+encodeURIComponent(paneId.session)+'&window='+encodeURIComponent(paneId.window);
const q=tgt+'&token='+encodeURIComponent(TERM_TOKEN)+'&cols='+term.cols+'&rows='+term.rows;const ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/term?'+q);ws.binaryType='arraybuffer';termWs=ws;ent.ws=ws;const t=term;let mode='attach';termView='';bar.classList.add('off');
// mirror: the pane is one of several in its window, so it is shown at its real size, scaled down to fit, never resized.
const scale=()=>{if(mode!=='mirror'){wrap.style.transform='';return;}const scr=t.element&&t.element.querySelector('.xterm-screen');if(!scr||!scr.offsetWidth)return;const s=Math.min(wrap.parentNode.clientWidth/scr.offsetWidth,(wrap.parentNode.clientHeight-bar.offsetHeight)/scr.offsetHeight,1);wrap.style.transform='scale('+s+')';};
const layout=()=>{if(ent.parked)return;if(mode==='mirror')scale();else{try{ent.fit.fit();}catch(e){}}};
ws.onmessage=e=>{if(typeof e.data!=='string'){if(livePaint(ent.h).reset)t.write('\x1bc');t.write(new Uint8Array(e.data));return;}let m;try{m=JSON.parse(e.data);}catch(x){return;}if(m.t==='mode'||m.t==='size'){if(m.t==='mode'){mode=m.mode;ent.mode=m.mode;ent.view=m.view||'';if(cur===ent)termView=ent.view;bar.innerHTML=toolbarHtml(m.kind||'window',!!m.zoomed);bar.classList.toggle('off',!ent.view);}wrap.classList.toggle('mirror',mode==='mirror');if(mode==='mirror'){t.resize(m.cols,m.rows);requestAnimationFrame(scale);}else layout();}else if(m.t==='zoom'){zoomLabel(bar,!!m.zoomed);}else if(m.t==='error'){t.write('\\r\\n\\x1b[33m'+String(m.message).replace(/\\n/g,'\\r\\n')+'\\x1b[0m\\r\\n');}};
ws.onclose=()=>{if(ent.destroyed)return;ent.dead=true;if(ent.parked){termPool.drop(ent.key);destroyEnt(ent);return;}if(term===t){termView='';bar.classList.add('off');t.write('\\r\\n\\x1b[2m[terminal closed]\\x1b[0m\\r\\n');}};t.onData(d=>{if(ws.readyState===1)ws.send(JSON.stringify({t:'i',d}));});t.onResize(({cols,rows})=>{if(mode!=='mirror'&&ws.readyState===1)ws.send(JSON.stringify({t:'r',c:cols,r:rows}));});
// Drop files: type their shell-escaped paths (Ghostty behaviour), through paste so a bracketed-paste-aware app (Claude Code) sees a paste.
const hasFiles=e=>e.dataTransfer&&Array.prototype.indexOf.call(e.dataTransfer.types||[],'Files')>=0;
col.addEventListener('dragover',e=>{if(!hasFiles(e))return;e.preventDefault();e.dataTransfer.dropEffect='copy';col.classList.add('dropping');});
col.addEventListener('dragleave',e=>{if(!col.contains(e.relatedTarget))col.classList.remove('dropping');});
col.addEventListener('drop',e=>{col.classList.remove('dropping');if(!hasFiles(e))return;e.preventDefault();e.stopPropagation();const paths=[];for(const f of e.dataTransfer.files||[]){let p='';try{p=window.loomNative?window.loomNative.pathForFile(f):'';}catch(x){}if(p)paths.push(p);}if(!paths.length)for(const p of fileUrlsToPaths(e.dataTransfer.getData('text/uri-list')))paths.push(p);const txt=dropText(paths);if(txt){t.paste(txt);t.focus();}else toast('Could not read the dropped file path','#8a2b2e');});
// Cmd+V with an image and no text: Claude Code reads the clipboard itself on Ctrl+V, so send that.
wrap.addEventListener('paste',e=>{const cd=e.clipboardData;if(!cd||cd.getData('text/plain'))return;for(const it of cd.items||[])if(it.kind==='file'&&it.type.indexOf('image/')===0){e.preventDefault();e.stopPropagation();if(ws.readyState===1)ws.send(JSON.stringify({t:'i',d:'\\x16'}));return;}},true);
bar.addEventListener('mousedown',e=>e.preventDefault());// keep keyboard focus in the terminal
bar.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;const mn=bar.querySelector('.tmenu');if(b.dataset.more!==undefined){if(mn)mn.hidden=!mn.hidden;return;}if(mn)mn.hidden=true;if(b.dataset.act)termCmd(b.dataset.act,bar);t.focus();});
ent.ro=termRO=new ResizeObserver(layout);termRO.observe(el);
if(snapP)snapP.then(r=>{if(ent.destroyed||!r)return;const w=snapPaint(ent.h,fitSnap(r,t.rows));if(w!==null)t.write(w);});
t.focus();});}
// The toolbar acts on the view's current pane through POST /api/term/cmd (whitelisted verbs, same token as the socket).
// A chat view only toggles the chat's zoom (its window is the user's real workspace; the server refuses the rest). A terminal window gets the full set.
function toolbarHtml(kind,zoomed){if(kind==='chat')return '<button data-act="zoom" class="tzoom" title="Toggle between the chat alone and its whole tmux window">'+(zoomed?'Show window':'Show chat')+'</button><span class="tmsg"></span>';return '<button data-act="split-right" title="Split right">Split right</button><button data-act="split-down" title="Split down">Split down</button><button data-act="zoom" title="Zoom or unzoom the current pane">Zoom</button><button data-act="next-pane" title="Move to the next pane">Next pane</button><span class="tmsg"></span><span class="spacer"></span><span class="tmore"><button data-more title="More">⋯</button><div class="tmenu" hidden><button data-act="close-pane" class="danger">Close pane</button></div></span>';}
function zoomLabel(bar,zoomed){const b=bar.querySelector('.tzoom');if(b)b.textContent=zoomed?'Show window':'Show chat';}
function termCmd(action,bar){if(!termView)return;const msg=bar.querySelector('.tmsg');msg.textContent='';fetch('/api/term/cmd',{method:'POST',headers:{'content-type':'application/json','x-loom-term-token':TERM_TOKEN},body:JSON.stringify({view:termView,action})}).then(r=>r.json()).then(j=>{if(!j.ok)msg.textContent=j.detail||'failed';else zoomLabel(bar,!!j.zoomed);}).catch(()=>{msg.textContent='server off?';});}
// Leaving a terminal parks it when it is a plain attach view of one chat (see termwarm.ts), else closes it.
function closeTerm(){termSeq++;const e=cur;termKey='';termView='';cur=null;termRO=null;termWs=null;term=null;termFit=null;termEl=null;if(!e)return;
  if(e.key&&e.mode==='attach'&&!e.dead&&e.ws&&e.ws.readyState===1){e.parked=true;e.col.style.display='none';for(const x of termPool.park(e.key,e))destroyEnt(x.v);}else destroyEnt(e);}
function destroyEnt(e){if(e.destroyed)return;e.destroyed=true;if(e.ro)e.ro.disconnect();try{if(e.ws)e.ws.close();}catch(x){}try{e.term.dispose();}catch(x){}if(e.col.parentNode)e.col.remove();}
function showWarm(e,el){e.parked=false;termEl=el;cur=e;term=e.term;termWs=e.ws;termFit=e.fit;termRO=e.ro;termView=e.view;e.col.style.display='';try{e.fit.fit();}catch(x){}alignTerm();e.term.focus();}
// Hover a sidebar row for 150ms and its screen is fetched, so the click paints at once.
var hoverT=0;function wireHoverPrefetch(){const sl=$('#sidelist');if(!sl)return;sl.addEventListener('mouseover',e=>{const r=e.target.closest&&e.target.closest('.srow[data-sid]');clearTimeout(hoverT);if(!r||!TERM_TOKEN)return;hoverT=setTimeout(()=>{const c=rowChat(r);const p=c&&!c.arch&&livePaneFor(c.session_id,c.agent);if(p&&!termPool.has(p))snapCache.get(p);},150);});sl.addEventListener('mouseleave',()=>clearTimeout(hoverT));}
// ---- Terminals --------------------------------------------------------------------
// tmux windows with no chat in them (dev servers, editors, sessions you made). One
// opens whole and unzoomed in the main area; a session with several windows gets
// a window picker in the header. Server: src/terminals.ts.
var TERMS=[],tsel=null;
function loadTerminals(){fetch('/api/terminals').then(r=>r.json()).then(j=>{if(!j.ok)return;const sig=JSON.stringify(j.sessions);if(sig===JSON.stringify(TERMS))return;TERMS=j.sessions;renderTermList();if(tsel)renderMain();}).catch(()=>{});}
function termRow(t){const w=t.windows.find(x=>x.active)||t.windows[0];const on=tsel&&tsel.session===t.session;return '<div class="srow tsrow'+(on?' sel':'')+'" tabindex="0" data-term="'+esc(t.session)+'" data-win="'+esc(w.index)+'"><span class="sdot d-stale"></span><div class="sbody"><div class="stitle">'+esc(t.session)+'</div><div class="ssub">'+(t.windows.length>1?t.windows.length+' windows':esc(w.name))+' · '+w.panes+(w.panes===1?' pane':' panes')+'</div></div></div>';}
// While searching, terminals that match the query join the Open section and the group itself is hidden.
var termSearchState=false;
function termMatches(q){return TERMS.filter(t=>(t.session+' '+t.windows.map(w=>w.name).join(' ')).toLowerCase().includes(q));}
function renderTermList(){const el=$('#termlist');if(termSearchState){el.innerHTML='';return;}const rows=TERMS.map(termRow).join('');
  el.innerHTML='<div class="sgrp"><span>Terminals <span class="cnt">'+TERMS.length+'</span></span>'+(TERM_TOKEN?'<button class="tnew" id="tnew" title="New terminal session">+</button>':'')+'</div>'+(rows||'<p class="meta sidehint">No terminal sessions.</p>');
  el.querySelectorAll('.tsrow').forEach(r=>{r.onclick=()=>selectTerminal(r.dataset.term,r.dataset.win);r.onkeydown=e=>{if(e.key==='Enter'){e.preventDefault();selectTerminal(r.dataset.term,r.dataset.win);}};});
  if($('#tnew'))$('#tnew').onclick=openTermBox;}
function selectTerminal(session,win){if(!TERM_TOKEN)return;leaveOrch();if(sel)deselect();tsel={session,window:String(win)};$('#mhead').dataset.sig='';renderTermList();renderMain();}
function leaveTerminal(){if(!tsel)return;tsel=null;if(termKey.indexOf('tw|')===0)closeTerm();['#mtabs','#mslack'].forEach(q=>{$(q).style.display='';});$('#mhead').dataset.sig='';renderTermList();}
function renderTermMain(){const box=$('#chatmain');const t=TERMS.find(x=>x.session===tsel.session);
  if(!t){box.classList.add('empty');closeTerm();$('#mempty').innerHTML='<div class="dempty">That terminal session is gone.</div>';return;}
  if(!t.windows.some(w=>w.index===tsel.window))tsel.window=(t.windows.find(w=>w.active)||t.windows[0]).index;
  box.classList.remove('empty');['#mtabs','#mslack','#mtxwrap','#mfoot'].forEach(q=>{$(q).style.display='none';});$('#mterm').style.display='';
  const h=$('#mhead');const sig='tw|'+tsel.session+'|'+tsel.window+'|'+JSON.stringify(t.windows);
  if(h.dataset.sig!==sig){h.dataset.sig=sig;h.innerHTML='<div class="mh-l"><div class="mh-t"><span class="sdot d-stale"></span><b>'+esc(t.session)+'</b></div><div class="ssub">Terminal session · no chat in it</div></div>'+(t.windows.length>1?'<select class="tsel-win" id="tselwin" aria-label="Window">'+t.windows.map(w=>'<option value="'+esc(w.index)+'"'+(w.index===tsel.window?' selected':'')+'>'+esc(w.index+': '+w.name)+'</option>').join('')+'</select>':'');
    if($('#tselwin'))$('#tselwin').onchange=e=>{tsel.window=e.target.value;renderMain();};}
  const key='tw|'+tsel.session+'|'+tsel.window;if(termKey!==key){openTerm({session:tsel.session,window:tsel.window},$('#mterm'));termKey=key;}}
function openTermBox(){const b=$('#termbox');b.hidden=false;const projs=composerProjects();const def=lsGet('loom.lastTermProject')||projs[0]||'';$('#tbproj').innerHTML=projs.map(p=>'<option value="'+esc(p)+'"'+(p===def?' selected':'')+'>'+esc(shortPath(p))+'</option>').join('');$('#tbname').value='';$('#tbmsg').textContent='';setTimeout(()=>$('#tbname').focus(),0);}
function closeTermBox(){$('#termbox').hidden=true;}
function createTermSession(){const name=$('#tbname').value.trim();const project=$('#tbproj').value;if(!name){$('#tbmsg').textContent='Name the session.';return;}if(!project){$('#tbmsg').textContent='Choose a project.';return;}$('#tbmsg').textContent='creating…';
  fetch('/api/terminals',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,project})}).then(r=>r.json()).then(j=>{if(!j.ok){$('#tbmsg').textContent=j.detail||'failed';return;}lsSet('loom.lastTermProject',project);closeTermBox();TERMS=TERMS.concat([{session:j.session,windows:[{index:j.window,name:'',panes:1,active:true}]}]);selectTerminal(j.session,j.window);loadTerminals();}).catch(()=>{$('#tbmsg').textContent='server off?';});}
$('#tbcancel').onclick=closeTermBox;$('#tbgo').onclick=createTermSession;
$('#termbox').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeTermBox();}else if(e.key==='Enter'){e.preventDefault();createTermSession();}});
loadTerminals();setInterval(visOnly(loadTerminals),5000);
var lastRenderAt=0;
function dataSig(){return DATA.defaultAgent+'##'+DATA.chats.map(c=>chatKey(c)+':'+(c.state||'')+':'+(c.summary_pending?'p':'')+':'+(c.saved?'s':'')+':'+(c.tags||[]).join(',')).sort().join('|')+'##'+Object.keys(DATA.live).sort().map(k=>k+(DATA.live[k].working?'⚡':'')).join(',')+'##'+(DATA.slackOwners||[]).slice().sort().join(',')+JSON.stringify(DATA.slackCounts||{})+'##'+(DATA.slackStarts||[]).map(x=>x.key+'@'+x.at).join(',')+'##'+(DATA.drafts||[]).map(x=>x.id+(x.stale?'~':'')).join(',')+'##'+(DATA.parked||[]).map(x=>x.session_id+x.state+x.label).join(',')+'##'+(DATA.launches||[]).map(x=>x.id+(x.status||'')).join(',')+'##'+pipeSig()+'##'+shipSig()+'##'+JSON.stringify(DATA.orch||null)+'##'+JSON.stringify(DATA.tags||[])+'##'+JSON.stringify(DATA.testLinks||{});}
function syncDefaultAgent(){$('#default-agent').value=DATA.defaultAgent;agentMenuSync();}
function refresh(){return fetch('/api/data').then(r=>r.json()).then(d=>{pollFailed=false;DATA.generatedAt=d.generatedAt||Date.now();DATA.slackMode=d.slackMode||DATA.slackMode;DATA.connections=d.connections||DATA.connections||[];DATA.archiveSearch=!!d.archiveSearch;DATA.port=d.port||DATA.port;renderStale();const before=dataSig();const wasLive=!!(sel&&!sel.arch&&livePaneFor(sel.sid,sel.agent));DATA.chats=d.chats;DATA.tags=d.tags||DATA.tags||[];DATA.live=d.live;DATA.defaultAgent=d.defaultAgent;DATA.slackOwners=d.slackOwners||[];DATA.slackCounts=d.slackCounts||{};DATA.testLinks=d.testLinks||{};DATA.slackStarts=d.slackStarts||[];setDrafts(d.drafts||[]);DATA.parked=d.parked||[];DATA.launches=d.launches||[];DATA.pipes=d.pipes||{};DATA.chatPr=d.chatPr||{};DATA.ships=d.ships||[];DATA.projects=d.projects||DATA.projects||null;DATA.orch=d.orch||DATA.orch;DATA.terminal=d.terminal||DATA.terminal;checkInsideFocus(d.focus);checkSlackStarts();
// A chat that just started running (Resume) opens on its terminal.
if(sel&&!sel.arch&&!wasLive&&livePaneFor(sel.sid,sel.agent)&&TERM_TOKEN)mtab='terminal';
if(dataSig()!==before||Date.now()-lastRenderAt>30000){liveToggle();chips();render();lastRenderAt=Date.now();}}).catch(()=>{pollFailed=true;renderStale();});}
function updateDefaultAgent(){const select=$('#default-agent');const agent=select.value;select.disabled=true;fetch('/api/settings/default-agent',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({agent})}).then(r=>r.json()).then(j=>{if(j.ok){DATA.defaultAgent=j.defaultAgent;render();}else{syncDefaultAgent();}}).catch(syncDefaultAgent).finally(()=>{select.disabled=false;});}
function restoreWorkspace(){const btn=$('#restorebtn');const b=btn.querySelector('.mi')||btn;const orig=b.innerHTML;btn.disabled=true;b.textContent='restoring…';fetch('/restore').then(r=>r.json()).then(j=>{const n=(j.restored||[]).length;b.textContent=j.ok?(n?'✓ restored '+n+' tab(s)':'✓ nothing to restore'):'✕ '+(j.detail||'failed');setTimeout(refresh,1500);}).catch(()=>{b.textContent='✕ server off';}).finally(()=>{setTimeout(()=>{btn.disabled=false;b.innerHTML=orig;},2600);});}
$('#restorebtn').onclick=restoreWorkspace;
// ── Archive search ────────────────────────────────────────────────────────────
// #q filters the board client-side. This searches every chat on disk via find-chat
// (/api/search) and renders what the 7-day board can't show. Click/Enter only —
// never per-keystroke, since each search spawns a subprocess.
var archHits=[], archQuery='', archState='idle', archErr='', archTimer=null;
// Typing runs the archive search by itself once it settles (400 ms, 2+ chars); Enter runs it now.
// Hits are only shown for the query they answered, so an older response never lands on a newer one.
function queryInput(){clearTimeout(archTimer);const q=$('#q').value.trim();if(!archiveWanted(q)||DATA.archiveSearch===false){archState='idle';archQuery='';archHits=[];renderArchive();return;}if(q!==archQuery)archState='searching';archTimer=setTimeout(runArchive,400);}
function runArchive(){clearTimeout(archTimer);const q=$('#q').value.trim();if(!archiveWanted(q)||DATA.archiveSearch===false)return;archQuery=q;archState='searching';archErr='';renderArchive();fetch('/api/search?q='+encodeURIComponent(q)).then(r=>r.json()).then(j=>{if(archQuery!==q)return;if(j.ok){archHits=j.results||[];archState='results';}else{archErr=j.detail||'search failed';archState='error';}render();}).catch(()=>{if(archQuery!==q)return;archErr='server off?';archState='error';renderArchive();});}
function adisp(h){const t=(h.title||h.snippet||'Untitled').trim();return t.length>90?t.slice(0,90)+'…':t;}
// Archive hits are chats the board has no row for. They render as sidebar rows and
// select into the main area on the Transcript tab, where Resume / Branch live.
function archChat(h){const pname=(h.project_dir||'').split('/').filter(Boolean).pop()||'unknown';return {agent:'claude',session_id:h.session_id,project:pname,project_dir:h.project_dir||'',jsonl_path:h.jsonl_path,title:h.title||h.snippet||'',claude_auto_title:'',pr_url:'',overview:'',state:'',breakdown:[],first_message:h.snippet||'',message_count:h.message_count,started_at:0,last_active_at:h.ended_at,last_turn_at:0,activity:{},summary_pending:false,saved:false,saved_at:0,arch:{jsonl:h.jsonl_path,proj:h.project_dir||'',title:h.title||''}};}
function renderArchive(){const box=$('#archive');if(!SPLIT||!searchActive()){box.innerHTML='';return;}const q=$('#q').value.trim();const cur=archQuery===q;
  const rowsHtml=SPLIT.archivedBoard.map(srow).join('')+(cur&&archState==='results'?SPLIT.archiveHits.map(h=>srow(archChat(h))).join(''):'');
  const n=SPLIT.archivedBoard.length+(cur&&archState==='results'?SPLIT.archiveHits.length:0);
  let note='';if(archiveWanted(q)&&DATA.archiveSearch!==false){if(!cur||archState==='searching')note='<p class="meta sidehint">searching all history…</p>';else if(archState==='error')note='<p class="meta sidehint">'+esc(archErr)+'</p>';}
  if(!rowsHtml&&!note)note='<p class="meta sidehint">no archived matches</p>';
  box.innerHTML='<div class="ahead">Archived · '+n+'</div>'+rowsHtml+note;}
// ---- Watchers ----------------------------------------------------------------
// Slack channels the Loom server polls itself every 60s. A match starts a Claude
// worker in the first idle loom-tp-N shell pane; no free pane leaves it queued.
let WATCH={watchers:[],spawns:[],dryRun:false};
// The tab count is the watchers that are switched on (what is polling Slack right now),
// not the spawn log: that is capped at the 50 most recent and is empty until /api/watchers
// answers, which read as "Watchers 0" next to two enabled watchers.
function watchCount(){return (WATCH.watchers||[]).filter(w=>w.enabled).length;}
function watchStatus(w){if(!w.enabled)return 'Off';
  if(w.last_error)return 'Error: '+esc(w.last_error)+' · retry '+(w.next_poll_at>Date.now()?'in '+Math.max(1,Math.round((w.next_poll_at-Date.now())/60000))+'m':'now');
  if(!w.baselined)return 'On · setting baseline…';
  return 'On · last poll '+(w.last_poll_at?rel(w.last_poll_at):'never');}
function watchRow(w){const cls=!w.enabled?'':(w.last_error?' w-err':' w-on');
  return '<div class="emrow'+cls+'"><div class="wrow"><div class="grow"><div class="emwho">'+esc(w.label)+'</div>'+
  '<div class="emhead">'+watchStatus(w)+'</div>'+
  '<div class="emwhy">'+esc(w.rule_label)+' · channel '+esc(w.channel)+' · '+w.seen+' seen · brief '+esc(w.brief_path)+'</div></div>'+
  '<div class="emmodes"><button data-w="'+esc(w.id)+'" data-on="0"'+(w.enabled?'':' class="on"')+'>off</button><button data-w="'+esc(w.id)+'" data-on="1" data-m="live"'+(w.enabled?' class="on"':'')+'>on</button></div></div></div>';}
const SPAWN_TAG={queued:'queued',spawned:'started',dry_run:'dry run'};
function spawnRow(sp){const cls=sp.status==='queued'?' w-queued':(sp.status==='spawned'?' w-on':'');
  const at=sp.spawned_at||sp.queued_at;
  const pane=sp.pane_id?(esc(sp.pane_name?'@'+sp.pane_name:sp.pane_id)+' · '+esc(sp.pane_where||sp.pane_id)):'';
  return '<div class="emrow'+cls+'"><div class="wrow"><div class="grow">'+
  '<div class="emhead"><span class="emtag">'+(SPAWN_TAG[sp.status]||esc(sp.status))+'</span>'+rel(at)+'</div>'+
  '<div class="emwho"><a href="'+esc(sp.permalink)+'" target="_blank" rel="noopener">'+esc(sp.title||sp.ts)+'</a></div>'+
  (pane||sp.detail?'<div class="emwhy">'+pane+(pane&&sp.detail?' · ':'')+esc(sp.detail)+'</div>':'')+'</div>'+
  (sp.status==='spawned'&&sp.pane_id?'<button class="wgo" data-sp="'+sp.id+'" title="jump to this pane">go ↗</button>':'')+'</div></div>';}
function renderWatch(){if(typeof wvRender==='function'){wvRender();return;}const ws=WATCH.watchers||[];
  $('#watch-hint').textContent='Loom polls each channel every 60s with no model usage, and starts a Claude worker in the first idle shell pane of a lane session (loom-&lt;lane&gt;-&lt;n&gt;) when a message matches. Turning a watcher on sets a baseline: existing messages are marked seen, not started. Loom never posts or reacts in Slack.'+(WATCH.dryRun?' DRY RUN (LOOM_WATCHERS_DRYRUN=1): panes are chosen and briefs written, nothing is typed.':'');
  $('#watch-list').innerHTML=ws.length?ws.map(watchRow).join(''):'<p class="meta">No watchers.</p>';
  const sps=WATCH.spawns||[];
  $('#watch-spawns').innerHTML=sps.length?sps.map(spawnRow).join(''):'<p class="meta">Nothing started yet.</p>';
  $('#watch-list').querySelectorAll('button[data-w]').forEach(b=>b.onclick=()=>{const on=b.dataset.on==='1';
    fetch('/api/watchers/toggle',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:b.dataset.w,enabled:on})}).then(r=>r.json()).then(()=>refreshWatch()).catch(()=>{});});
  $('#watch-spawns').querySelectorAll('button[data-sp]').forEach(b=>b.onclick=()=>{fetch('/api/watchers/goto?id='+encodeURIComponent(b.dataset.sp),{method:'POST'}).then(r=>r.json()).then(j=>{if(!j.ok)b.textContent=j.detail||'failed';}).catch(()=>{});});}
function refreshWatch(){fetch('/api/watchers').then(r=>r.json()).then(d=>{if(!d.ok)return;WATCH=d;renderTabs();if(tab==='watch')renderWatch();}).catch(()=>{});}
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
    renderTabs();prunePlan();if(tab==='trees'){renderTrees();if(treeSel)loadFiles();}
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
function renderTrees(){renderTreeModes();renderPrune();
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
  // Arm/confirm: the second click is what actually does it. This is the only thing
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
// ---- Tickets -----------------------------------------------------------------
// The board's own chats in columns: the same filtered set the Board tab lists
// (search, project, state chips, Live / All), laid out by whose move it is and
// where the work is. Nothing here fetches; it renders from DATA on every board
// render, and a click selects the chat into the shared detail panel.
// Columns: Needs you (the chat is waiting on Will), Blocked (the pane classifier
// says it is waiting on someone else), then the classifier's stage, and Done
// for a chat no longer running in a pane (only on All).
var KB_COLS=['needsYou','blocked','discovery','implementation','shipping','done'];
var KB_NAME={needsYou:'Needs you',blocked:'Blocked',discovery:'Discovery',implementation:'Implementation',shipping:'Shipping',done:'Done'};
var KB_EMPTY={needsYou:'Nothing is waiting on you.',blocked:'Nothing is waiting on anyone else.',done:'No ended chats in view.'};
function kbCol(c){var L=DATA.live[chatKey(c)];if(!L)return 'done';var s=L.stage||'';var stage=(s==='discovery'||s==='implementation'||s==='shipping')?s:'implementation';
  if(L.working)return stage;
  if(s==='blocked')return 'blocked';
  if(st(c)==='waiting_on_user'||s==='thread')return 'needsYou';
  return stage;}
function kbCount(){return boardBase().filter(function(c){var k=kbCol(c);return k==='needsYou'||k==='blocked';}).length;}
function kbCard(c){var k=chatKey(c),L=DATA.live[k],col=kbCol(c),W=isWorking(c);var ago=agoShort(fresh(c));
  var g=W?['w','~','working '+ago]:col==='needsYou'?['y','●','your turn '+ago]:col==='blocked'?['b','‖','waiting on someone '+ago]:L?['i','◦','idle '+ago]:['r','×','ended '+rel(fresh(c))];
  var tail=(col==='needsYou'||col==='blocked')?TAILS[k]:'';
  var asked=tail?'<div><span class="'+(col==='blocked'?'blk':'need')+'" title="'+esc(tail)+'">'+(col==='blocked'?'last: ':'asked: ')+esc(tail.length>90?tail.slice(0,90)+'…':tail)+'</span></div>':'';
  var p=pipeOf(c);var prk=(DATA.chatPr||{})[k]||'';
  var pr=prk?'<div class="pr"><span class="n">PR #'+esc(prk.split('#')[1]||'')+'</span>'+(p?dotsHtml(p):'')+'</div>':'';
  var cls=W?' work':col==='needsYou'?' you':col==='blocked'?' blkd':st(c)==='error'?' bad':'';
  var on=sel&&sel.sid===c.session_id&&sel.agent===c.agent;
  return '<button class="tk'+cls+(on?' sel':'')+'" data-sid="'+esc(c.session_id)+'" data-agent="'+esc(c.agent)+'">'+
    '<div class="tkh"><span class="lbl" style="'+pcolor(c.project)+'">'+esc(c.project)+'</span>'+(L&&L.name?'<span class="num">'+esc(L.name)+'</span>':'')+'<span class="age">'+esc(ago)+'</span></div>'+
    '<div class="ttl">'+esc(disp(c))+'</div>'+
    '<div class="who"><span class="g '+g[0]+'">'+g[1]+'</span><span class="pn">'+esc(g[2])+(L?' · '+esc(L.tmux_session)+':'+esc(L.pane_index):'')+'</span></div>'+asked+pr+'</button>';}
function kbTails(rows){var keys=rows.filter(function(c){var k=kbCol(c);return k==='needsYou'||k==='blocked';}).map(chatKey);
  if(!keys.length)return;if(Date.now()-tailsAt<15000&&!keys.some(function(k){return !(k in TAILS);}))return;tailsAt=Date.now();
  fetch('/api/tails?keys='+encodeURIComponent(keys.slice(0,40).join(','))).then(function(r){return r.json();}).then(function(j){if(j.ok){Object.assign(TAILS,j.tails);if(tab==='tickets')renderKanban(KB_ROWS);}}).catch(function(){});}
var KB_ROWS=[];
function agoShort(ms){if(!ms)return '';var r=rel(ms);return r==='just now'?'now':r.replace(' ago','');}
function renderKanban(rows){KB_ROWS=rows;var box=$('#kanban');var by={};KB_COLS.forEach(function(k){by[k]=[];});
  rows.forEach(function(c){by[kbCol(c)].push(c);});
  // Longest-waiting first in the waiting columns; most recent first elsewhere.
  ['needsYou','blocked'].forEach(function(k){by[k].sort(function(a,b){return fresh(a)-fresh(b);});});
  var cols=KB_COLS.filter(function(k){return k!=='done'||!liveOnly;});
  box.style.gridTemplateColumns='repeat('+cols.length+',minmax(200px,1fr))';
  box.innerHTML=cols.map(function(k){var wait=k==='needsYou'||k==='blocked';
    return '<div class="col c-'+k+(wait?' wait':'')+'"><div class="colhd"><span class="colnm">'+KB_NAME[k]+'</span><span class="colct">'+by[k].length+'</span></div>'+
      (by[k].map(kbCard).join('')||'<div class="tkempty">'+(KB_EMPTY[k]||'Nothing here.')+'</div>')+'</div>';}).join('');
  box.querySelectorAll('.tk[data-sid]').forEach(function(el){el.onclick=function(){openInBoard(el.dataset.sid,el.dataset.agent);};});
  kbTails(rows);}
// ---- Detail panel ------------------------------------------------------------
// Clicking a card selects it and fills the sticky right column. Everything cheap
// renders from DATA straight away; the expensive half (git, gh, transcript scan)
// comes from /api/detail, fetched on selection and every 20s while selected —
// never on the board poll. With nothing selected the column lists every chat
// waiting on you.
var sel=null, DETAIL=null, detailTimer=null, detailRetry=null, lastOpen=false, TAILS={}, tailsAt=0;
const STAGE_GLYPH={discovery:'?',implementation:'+',shipping:'^',thread:'~',blocked:'!'};
function loadDetail(){if(!sel||sel.arch)return;const k=selKey();fetch('/api/detail?session='+encodeURIComponent(sel.sid)+'&agent='+encodeURIComponent(sel.agent)).then(r=>r.json()).then(d=>{if(selKey()!==k)return;DETAIL=d;renderMain();
  // gh runs in the background on the server; ask again shortly rather than wait on it.
  clearTimeout(detailRetry);if(d.pending)detailRetry=setTimeout(loadDetail,3000);}).catch(()=>{});}
function detailBusy(){const d=$('#mdetail');return !!(d&&d.querySelector('textarea:focus'));}
function shortPath(p){return (p||'').replace(new RegExp('^/Users/[^/]+'),'~');}
function stageBadge(s){return s?'<span class="stage s-'+esc(s)+'">'+esc(STAGE_GLYPH[s]||'')+' '+esc(s)+'</span>':'';}
function whereHtml(w,pr){if(!w)return '<div class="dempty">…</div>';
  if(w.kind==='none')return '<div class="drow">not a git checkout</div><div class="dpath">'+esc(shortPath(w.cwd))+'</div>';
  if(w.kind==='main')return '<div class="drow"><span class="dmono">⎇ '+esc(w.branch)+'</span><span class="dsub">(shared checkout)</span></div><div class="dpath">'+esc(shortPath(w.top))+'</div>';
  const ab=(w.ahead?'<span class="tct a">↑'+w.ahead+'</span>':'')+(w.behind?'<span class="tct b">↓'+w.behind+'</span>':'')+'<span class="dsub">vs '+esc(w.base)+'</span>';
  return '<div class="drow"><span class="dmono">⑂ '+esc(w.branch)+'</span>'+ab+'</div>'+
    '<div class="dpath">'+(w.kind==='worktree'?'worktree ':'primary checkout ')+esc(shortPath(w.top))+'</div>'+
    (pr&&pr.number?'<div class="drow"><a class="prbtn" href="'+esc(pr.url)+'" target="_blank" rel="noopener">'+brandIcon('github')+'PR #'+pr.number+'</a></div>':'');}
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
// The Transcript tab's side column: everything the old right-hand panel showed
// (session, where it is working, files, last message, PR + pipeline, ship, drafts,
// Slack, moments, todo). Cheap parts render from DATA straight away; the git/gh
// half comes from /api/detail (fetched on selection and every 20s).
function renderAside(c,L){const box=$('#mdetail');if(!box)return;
  if(c.arch){box.innerHTML='<div class="dsec"><h3>Archived chat</h3><div class="dempty">This chat is older than the board window, so Loom has no git, PR or summary detail for it. The transcript on the left is read from disk.</div></div>';return;}
  if(detailBusy())return;
  const d=detailFor(c);const lb=d?d.labels:{topic:'',stage:'',name:L&&L.name||''};
  const id=esc(c.session_id);const turn=isTurn(c)&&!!L;
  const head='<div class="dsec"><h3>Session</h3>'+(lb.topic?'<div class="dtitle">'+esc(lb.topic)+'</div>':'')+
    '<div class="drow">'+stageBadge(lb.stage)+(lb.name?'<span class="dname">@'+esc(lb.name)+'</span>':'')+'</div>'+
    '<div class="drow"><code class="sid copyable" data-id="'+id+'" title="click to copy the session id">'+id+'</code></div></div>';
  if(!d){box.innerHTML=head+'<div class="dempty">loading…</div>';wireDetail(box,c);return;}
  const pr=d.pr&&!d.pr.loading?d.pr:null;
  const last=d.last?'<div class="dsec"><h3>Last message'+(turn?' <span class="turnlbl">● waiting on you</span>':'')+'<span class="n">'+rel(d.last.at)+'</span></h3>'+
    '<div class="dlast'+(turn?' turn':'')+(lastOpen?' open':'')+'">'+d.last.html+'</div><button class="linkbtn" data-act="expand">'+(lastOpen?'collapse':'expand')+'</button></div>':'';
  const km=(c.breakdown||[]).length?'<div class="dsec"><h3>Key moments</h3><ul class="timeline">'+c.breakdown.map(b=>'<li>'+esc(b)+'</li>').join('')+'</ul></div>':'';
  box.innerHTML=head+
    '<div class="dsec"><h3>Where it is working</h3>'+whereHtml(d.where,d.where.kind==='main'?null:pr)+'</div>'+
    '<div class="dsec"><h3>Files changed <span class="n">'+(d.files||[]).length+' · '+(d.filesMode==='session'?'edited by this session':'branch vs '+esc(d.where.base))+'</span></h3>'+filesHtml(d)+'</div>'+
    last+
    (d.pr||d.pipeline?'<div class="dsec"><h3>Pull request</h3>'+prHtml(d.pr)+pipelineHtml(d)+'</div>':'')+shipSectionHtml(d,c)+
    slackHtml(d)+km+todoHtml(d);
  wireDetail(box,c);wireSteps(box);wireShips(box);}
function renderDetail(){if(!sel){renderWaiting();return;}const c=selChat();if(c)renderAside(c,c.arch?null:DATA.live[chatKey(c)]);}
const SLACK_STAGE={looking:['info','👀 looking'],blocked:['bad','⛔ blocked'],done:['good','✅ done']};
function slackHtml(d){const t=d.slack||[];if(!t.length)return '';
  return '<div class="dsec"><h3>'+brandIcon('slack')+'Slack <span class="n">'+t.length+'</span></h3>'+t.map(x=>{const sg=SLACK_STAGE[x.stage];
    return '<div class="sthread"><div class="drow"><span class="dmono">'+esc(x.label)+'</span>'+(sg?'<span class="badge '+sg[0]+'">'+sg[1]+'</span>':'')+
      '<span class="spacer"></span><button class="iconbtn ghost" data-tour="slack" data-slack="'+esc(x.key)+'" data-url="'+esc(x.url)+'" title="'+esc(x.deeplink)+'">Open in Slack</button></div>'+
      '<div class="sprev">'+(x.preview===null?'<span class="dsub">loading the thread…</span>':(x.author?'<b>'+esc(x.author)+':</b> ':'')+esc(x.preview))+'</div>'+
      '<a class="dpath" href="'+esc(x.url)+'" target="_blank" rel="noopener">'+esc(x.url)+'</a></div>';}).join('')+'</div>';}
function wireDetail(box,c){
  box.querySelectorAll('[data-slack]').forEach(b=>b.onclick=()=>slackPost({key:b.dataset.slack,url:b.dataset.url}));
  box.querySelectorAll('code.copyable').forEach(el=>el.onclick=()=>copyText(el.dataset.id,'session id copied'));
  box.querySelectorAll('[data-act="expand"]').forEach(b=>b.onclick=()=>{lastOpen=!lastOpen;const l=box.querySelector('.dlast');if(l)l.classList.toggle('open',lastOpen);b.textContent=lastOpen?'collapse':'expand';});
  }
// Empty state: every live chat whose turn it is, longest-waiting first.
function waitingChats(){return DATA.chats.filter(c=>isLive(c)&&isTurn(c)).sort((a,b)=>fresh(a)-fresh(b));}
// No chats at all (a new install, often mid-setup): the hero empty state instead
// of an empty Waiting list. Its sky stops for good once the hero is off screen.
var HERO={sky:null};
function heroOn(){const m=$('#chatmain');return !!m&&m.classList.contains('empty')&&m.classList.contains('hero')&&$('#mhero').offsetParent!==null;}
function heroStop(){if(HERO.sky){HERO.sky.stop();HERO.sky=null;}}
function heroConnect(){if(typeof SX!=='undefined')SX.sec='slack';if(tab==='settings')render();else openSettings();}
function renderHero(){const setup=typeof WZ!=='undefined'&&WZ.v&&WZ.v.show;
  $('#mhero-h').textContent='Nothing on the board yet';
  $('#mhero-p').textContent=setup?'Finish setup to choose your projects and terminal, then start a chat. Chats you start in Claude Code appear here on their own.':'Start a chat here, or keep using Claude Code in your terminal. Every chat on this Mac appears here on its own.';
  const acts=setup?[['setup','Finish setup',1],['chat','Start a chat',0]]:[['chat','Start a chat',1],['connect','Connect Slack, GitHub and Gmail',0]];
  const sig=acts.map(a=>a[0]).join();const box=$('#mhero-acts');
  if(box.dataset.sig!==sig){box.dataset.sig=sig;box.innerHTML=acts.map(a=>'<button type="button" data-hx="'+a[0]+'"'+(a[2]?' class="pri"':'')+'>'+esc(a[1])+'</button>').join('');
    box.querySelectorAll('button').forEach(b=>b.onclick=()=>{const k=b.dataset.hx;if(k==='setup'){if(typeof openWizard==='function')openWizard();}else if(k==='chat')openComposer();else heroConnect();});}
  if(!(HERO.sky&&HERO.sky.running())&&heroOn())HERO.sky=loomSky($('#mhero-sky'),{nebula:LSKY_NEBULA,dim:.55,density:.6,maxStars:420,fps:30,dpr:1,shoot:16000,alive:heroOn});}
function renderWaiting(){const box=$('#mempty');
  const hero=!DATA.chats.length;$('#chatmain').classList.toggle('hero',hero);if(hero){renderHero();return;}heroStop();
  const w=waitingChats();
  const keys=w.map(chatKey);
  if(keys.length&&(Date.now()-tailsAt>15000||keys.some(k=>!(k in TAILS)))){tailsAt=Date.now();fetch('/api/tails?keys='+encodeURIComponent(keys.join(','))).then(r=>r.json()).then(j=>{if(j.ok){Object.assign(TAILS,j.tails);if(!sel)renderWaiting();}}).catch(()=>{});}
  box.innerHTML='<div class="dsec"><h3>Waiting on you <span class="n">'+w.length+'</span></h3>'+
    (w.length?w.map(c=>{const L=DATA.live[chatKey(c)];return '<div class="wait" data-sid="'+esc(c.session_id)+'" data-agent="'+esc(c.agent)+'"><div class="wt">'+esc(disp(c))+'</div>'+
      '<div class="wm">waiting '+rel(fresh(c)).replace(' ago','')+' · '+esc(L.tmux_session)+' · pane '+esc(L.pane_index)+(L.name?' · @'+esc(L.name):'')+'</div>'+
      (TAILS[chatKey(c)]?'<div class="wx">'+esc(TAILS[chatKey(c)])+'</div>':'')+'</div>';}).join(''):'<div class="dempty">Nothing is waiting on you. Select a chat in the list to open it.</div>')+'</div>';
  box.querySelectorAll('.wait').forEach(el=>el.onclick=()=>{selectChat(el.dataset.sid,el.dataset.agent,null);const row=document.querySelector('#sidelist .srow.sel');if(row)row.scrollIntoView({block:'nearest'});});}
function setHeaderHeight(){document.documentElement.style.setProperty('--hh',$('header').offsetHeight+'px');}
// ---- New thread composer ------------------------------------------------------
// "+ New thread" (or n): a prompt, pasted/dropped images, a project and a target
// pane. The server saves the images under ~/.loom/inbox/<id>/, appends their
// paths to the prompt, and launches the agent with the prompt as its CLI
// argument. Until the new chat is indexed its card shows as a placeholder.
var CIMAGES=[], composerOpen=false, composerBusy=false;
function lsGet(k){try{return localStorage.getItem(k)||'';}catch(e){return '';}}
// Session list width. Kept per viewer in localStorage; the terminal refits once a drag ends.
var SIDE_DEFAULT=360,SIDE_MIN=240,SIDE_MAX=720;
function sideClamp(w){const room=Math.max(SIDE_MIN,(window.innerWidth||1200)-420);return Math.round(Math.max(SIDE_MIN,Math.min(SIDE_MAX,room,w)));}
function setSideW(w,save){const bw=$('#boardwrap'),g=$('#sidegrip');if(!bw)return;const v=sideClamp(w);bw.style.setProperty('--sidew',v+'px');if(g)g.setAttribute('aria-valuenow',String(v));if(save){if(v===SIDE_DEFAULT)try{localStorage.removeItem('loom.sidew');}catch(e){}else lsSet('loom.sidew',String(v));}return v;}
function wireSideGrip(){const g=$('#sidegrip'),side=$('#side');if(!g||!side)return;const saved=Number(lsGet('loom.sidew'));setSideW(saved>0?saved:SIDE_DEFAULT,false);
  let dragging=false;
  g.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragging=true;g.setPointerCapture(e.pointerId);document.body.classList.add('sideresizing');e.preventDefault();});
  g.addEventListener('pointermove',e=>{if(!dragging)return;setSideW(e.clientX-side.getBoundingClientRect().left,false);});
  const end=e=>{if(!dragging)return;dragging=false;try{g.releasePointerCapture(e.pointerId);}catch(x){}document.body.classList.remove('sideresizing');setSideW(side.getBoundingClientRect().width,true);if(typeof refitTerm==='function')refitTerm();};
  g.addEventListener('pointerup',end);g.addEventListener('pointercancel',end);
  g.addEventListener('dblclick',()=>{setSideW(SIDE_DEFAULT,true);if(typeof refitTerm==='function')refitTerm();});
  g.addEventListener('keydown',e=>{const cur=side.getBoundingClientRect().width;let w=null;if(e.key==='ArrowLeft')w=cur-16;else if(e.key==='ArrowRight')w=cur+16;else if(e.key==='Home')w=SIDE_DEFAULT;if(w===null)return;e.preventDefault();e.stopPropagation();setSideW(w,true);if(typeof refitTerm==='function')refitTerm();});
  // A narrower window squeezes the list; widening it again restores the width the viewer chose.
  window.addEventListener('resize',()=>{const pref=Number(lsGet('loom.sidew'));setSideW(pref>0?pref:SIDE_DEFAULT,false);});}
function lsSet(k,v){try{localStorage.setItem(k,v);}catch(e){}}
function composerProjects(){if(DATA.projects)return DATA.projects.map(p=>p.path);const seen={},out=[];DATA.chats.slice().sort((a,b)=>b.last_active_at-a.last_active_at).forEach(c=>{if(c.project_dir&&!seen[c.project_dir]){seen[c.project_dir]=1;out.push(c.project_dir);}});return out;}
// prefill ({prompt, project}) seeds the composer — the Tickets panel's "New
// thread on #N" — and otherwise the last-used project is selected.
function openComposer(prefill){if(composerOpen)return;composerOpen=true;const m=$('#composer');m.hidden=false;
  const seed=prefill&&typeof prefill.prompt==='string'?prefill:null;
  let projs=composerProjects();if(seed&&seed.project&&projs.indexOf(seed.project)<0)projs=[seed.project].concat(projs);
  const last=seed&&seed.project?seed.project:lsGet('loom.lastProject');const def=projs.indexOf(last)>=0?last:(projs[0]||'');
  fillCproj(projs,def);
  if(seed)$('#cprompt').value=seed.prompt;else if(!$('#cprompt').value)$('#cprompt').value=lsGet('loom.draft');
  $('#cagent').value=DATA.defaultAgent==='codex'?'codex':'claude';syncTrust();
  $('#ctarget').innerHTML='<option value="">Next open pane</option>';
  fetch('/api/lanes?all=1').then(r=>r.json()).then(ls=>{$('#ctarget').innerHTML='<option value="">Next open pane</option>'+ls.map(l=>'<option value="'+esc(l.lane)+'">loom-'+esc(l.lane)+(l.open?' → '+esc(l.open.where):' (full: splits a new pane)')+'</option>').join('');}).catch(()=>{});
  $('#cmsg').textContent='';renderThumbs();updateRestore();setTimeout(()=>$('#cprompt').focus(),0);}
// Offer to trust a folder Claude Code has not been trusted in (the server reports it per project).
function syncTrust(){const v=$('#cproj').value,x=(DATA.projects||[]).find(q=>q.path===v)||(DATA.allProjects||[]).find(q=>q.path===v);$('#ctrustrow').hidden=!(x&&x.trusted===false&&$('#cagent').value==='claude');}
function projLabel(p){const x=(DATA.projects||[]).find(q=>q.path===p);return x?x.name+'  \u2014  '+shortPath(p):shortPath(p);}
function fillCproj(projs,sel){$('#cproj').innerHTML=projs.map(p=>'<option value="'+esc(p)+'"'+(p===sel?' selected':'')+'>'+esc(projLabel(p))+'</option>').join('')+'<option value="__add__">Add project\u2026</option>';$('#cpathrow').hidden=true;syncTrust();}
function addProjectPath(p){return fetch('/api/projects',{method:'POST',headers:{'content-type':'application/json','x-loom-term-token':TERM_TOKEN},body:JSON.stringify({path:p})}).then(r=>r.json());}
function reloadProjects(){return fetch('/api/projects?all=1').then(r=>r.json()).then(j=>{if(j.ok){DATA.projects=j.projects.filter(p=>!p.hidden);DATA.allProjects=j.projects;projects();}});}
// Native folder picker inside Electron; elsewhere a typed path the server validates.
function pickProject(inputEl){const nat=window.loomNative&&window.loomNative.pickFolder;if(nat)return nat().then(p=>p?addProjectPath(p):null);const v=(inputEl&&inputEl.value||'').trim();return addProjectPath(v);}
function onCprojChange(){const sel=$('#cproj');syncTrust();if(sel.value!=='__add__'){$('#cpathrow').hidden=true;return;}
  if(window.loomNative&&window.loomNative.pickFolder){pickProject().then(j=>{if(!j){fillCproj(composerProjects(),lsGet('loom.lastProject'));return;}if(!j.ok){$('#cmsg').textContent='\u2715 '+j.detail;fillCproj(composerProjects(),lsGet('loom.lastProject'));return;}reloadProjects().then(()=>fillCproj(composerProjects(),j.project.path));});}
  else{$('#cpathrow').hidden=false;$('#cpath').focus();}}
function addTypedProject(){addProjectPath($('#cpath').value.trim()).then(j=>{if(!j.ok){$('#cmsg').textContent='\u2715 '+j.detail;return;}$('#cmsg').textContent='';$('#cpath').value='';reloadProjects().then(()=>fillCproj(composerProjects(),j.project.path));});}
function closeComposer(){composerOpen=false;$('#composer').hidden=true;}
function lsDel(k){try{localStorage.removeItem(k);}catch(e){}}
function saveDraft(){const v=$('#cprompt').value;if(v)lsSet('loom.draft',v);else lsDel('loom.draft');updateRestore();}
function lastPrompt(){try{const o=JSON.parse(lsGet('loom.lastPrompt')||'null');if(o&&typeof o.text==='string'&&o.text&&Date.now()-o.t<86400000)return o.text;}catch(e){}return '';}
function updateRestore(){$('#crestore').hidden=!!$('#cprompt').value||!lastPrompt();}
function resetComposer(){$('#cprompt').value='';lsDel('loom.draft');CIMAGES=[];renderThumbs();updateRestore();}
$('#cprompt').addEventListener('input',saveDraft);
$('#crestore').onclick=e=>{e.preventDefault();const t=lastPrompt();if(t){$('#cprompt').value=t;saveDraft();$('#cprompt').focus();}};
function renderThumbs(){const t=$('#cthumbs');t.innerHTML=CIMAGES.map((im,i)=>'<div class="cthumb"><img src="'+im.url+'" alt="'+esc(im.name)+'"/><button data-i="'+i+'" title="remove">✕</button></div>').join('');
  t.querySelectorAll('button').forEach(b=>b.onclick=()=>{CIMAGES.splice(+b.dataset.i,1);renderThumbs();});}
function addImageFile(f){if(!f||f.type.indexOf('image/')!==0)return;const r=new FileReader();r.onload=()=>{const url=String(r.result);CIMAGES.push({name:f.name||'pasted',type:f.type,url,data:url.slice(url.indexOf(',')+1)});renderThumbs();};r.readAsDataURL(f);}
function launchThread(){if(composerBusy)return;const prompt=$('#cprompt').value;if(!prompt.trim()&&!CIMAGES.length){$('#cmsg').textContent='Write a prompt first.';return;}
  if($('#cproj').value==='__add__'){$('#cmsg').textContent='Choose a project first.';return;}const body={prompt,project:$('#cproj').value,lane:$('#ctarget').value,prefer:lsGet('loom.lastLane'),agent:$('#cagent').value,focus:$('#cfocus').checked,trust:!$('#ctrustrow').hidden&&$('#ctrust').checked,images:CIMAGES.map(i=>({name:i.name,type:i.type,data:i.data}))};
  composerBusy=true;$('#claunch').disabled=true;$('#cmsg').textContent='launching…';
  fetch('/api/new-thread',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(r=>r.json()).then(j=>{
    if(!j.ok){$('#cmsg').textContent='✕ '+(j.detail||'failed');return;}
    lsSet('loom.lastPrompt',JSON.stringify({t:Date.now(),text:prompt}));lsSet('loom.lastProject',body.project);const m=/^loom-(.+)-\\d+ /.exec(j.where||'');if(m)lsSet('loom.lastLane',m[1]);
    $('#cmsg').textContent='✓ started in '+(j.where||j.pane_id);resetComposer();refresh();setTimeout(refresh,2000);setTimeout(refresh,5000);setTimeout(closeComposer,1100);
  }).catch(e=>{$('#cmsg').textContent='✕ launch failed ('+((e&&e.message)||'server off?')+') \\u2014 your text is kept';}).finally(()=>{composerBusy=false;$('#claunch').disabled=false;});}
$('#newbtn').onclick=()=>openComposer();
$('#ccancel').onclick=closeComposer;
$('#claunch').onclick=launchThread;
$('#cproj').onchange=onCprojChange;$('#cagent').addEventListener('change',syncTrust);$('#cpathgo').onclick=addTypedProject;
$('#composer').addEventListener('mousedown',e=>{if(e.target.id==='composer')closeComposer();});
$('#cprompt').addEventListener('paste',e=>{const items=(e.clipboardData&&e.clipboardData.items)||[];let took=false;for(const it of items){if(it.kind==='file'&&it.type.indexOf('image/')===0){addImageFile(it.getAsFile());took=true;}}if(took)e.preventDefault();});
$('.cbox').addEventListener('dragover',e=>{e.preventDefault();$('.cbox').classList.add('drop');});
$('.cbox').addEventListener('dragleave',()=>$('.cbox').classList.remove('drop'));
$('.cbox').addEventListener('drop',e=>{e.preventDefault();$('.cbox').classList.remove('drop');for(const f of (e.dataTransfer&&e.dataTransfer.files)||[])addImageFile(f);});
$('#composer').addEventListener('keydown',e=>{if(e.key==='Escape'){e.stopPropagation();closeComposer();}else if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)){e.preventDefault();launchThread();}});
$('#setbtn').onclick=openSettings;
$('#q').addEventListener('keydown',e=>{if(e.key==='Enter')runArchive();});
$('#q').addEventListener('input',queryInput);
function syncQClear(){const q=$('#q'),w=q&&q.parentElement;if(w&&w.classList.contains('qwrap'))w.classList.toggle('has',!!q.value);}
function clearQuery(){const q=$('#q');q.value='';q.dispatchEvent(new Event('input',{bubbles:true}));q.focus();}
$('#q').addEventListener('input',syncQClear);
$('#q').addEventListener('keydown',e=>{if(e.key==='Escape'&&$('#q').value){e.preventDefault();e.stopPropagation();clearQuery();}});
$('#qclear').addEventListener('mousedown',e=>e.preventDefault());
$('#qclear').addEventListener('click',clearQuery);
setHeaderHeight();window.addEventListener('resize',setHeaderHeight);if(window.ResizeObserver)new ResizeObserver(setHeaderHeight).observe($('header'));
wireMain();wireShipModal();wireJump();wireHeaderMenus();wireUpdates();projects();reloadProjects();syncDefaultAgent();liveToggle();chips();render();refreshWatch();refreshTrees(false);
$('#default-agent').onchange=updateDefaultAgent;
// Codex is offered only when ~/.codex exists (or the codex_visible setting says so).
if(!DATA.codexVisible){['#default-agent','#cagent'].forEach(function(id){const o=$(id+' option[value="codex"]');if(o)o.remove();});const cb=$('#agentmenu [data-agent="codex"]');if(cb)cb.remove();}
['#q','#proj','#sort'].forEach(s=>$(s).addEventListener('input',render));
setInterval(visOnly(refresh),5000);
// Shown again (the hotkey raised the window, or Cmd-Tab): catch up now, not on the next tick.
document.addEventListener('visibilitychange',function(){if(!document.hidden)refresh();});
setInterval(renderStale,5000);renderStale();
// The header's connections come with /api/data, not the first paint: fetch once now rather than after the first 5 s tick.
setTimeout(refresh,0);
setInterval(visOnly(function(){refreshTrees(false);}),300000);
setInterval(visOnly(refreshWatch),15000);
loadShipCands();setInterval(visOnly(loadShipCands),15000);
['dragover','drop'].forEach(n=>document.addEventListener(n,e=>{if(e.dataTransfer&&Array.prototype.indexOf.call(e.dataTransfer.types||[],'Files')>=0)e.preventDefault();}));
document.addEventListener('visibilitychange',()=>{if(!document.hidden){refresh();loadTerminals();}});
</script>
${WIZARD_VIEW_HTML}
${welcomeFirst ? '' : welcomeHtml(false)}
${TOUR_VIEW_HTML}
${WATCHER_VIEW_HTML}
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
