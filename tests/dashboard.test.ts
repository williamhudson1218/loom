import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.ts';
import { parseJsonlFile } from '../src/parser.ts';
import { upsertChat } from '../src/indexer.ts';
import path from 'node:path';
import { toChatViews, renderDashboard } from '../src/dashboard.ts';
import { CHAT_MENU_JS } from '../src/chatmenu.ts';

const FIX = path.join(__dirname, 'fixtures', 'sample-chat.jsonl');

describe('dashboard', () => {
  it('builds views and renders self-contained HTML with the data blob', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);
    db.prepare(`UPDATE chats SET title='My Title', overview='ov', breakdown_json='["x","y"]', summary_dirty=0 WHERE session_id=?`).run('sess-abc');

    const views = toChatViews(db);
    expect(views.length).toBe(1);
    expect(views[0].title).toBe('My Title');
    expect(views[0].breakdown).toEqual(['x', 'y']);
    expect(views[0].summary_pending).toBe(false);

    const html = renderDashboard(views, 9999);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('My Title');
    // session_id is embedded in the data blob; the rows, header and menu are
    // assembled client-side from it.
    expect(html).toContain('sess-abc');
    expect(html).toContain("copyText(c.session_id,'session id copied')");
    db.close();
  });

  it('has no EM tab, section or fetch wiring', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).not.toContain('em-section');
    expect(html).not.toContain('em-feed');
    expect(html).not.toContain('em-modes');
    expect(html).not.toMatch(/\/api\/em(\/|'|\?|$)/m);
    expect(html).not.toContain('refreshEm');
    expect(html).not.toContain("['em',");
    // the tab strip is exactly Board, Saved, Tickets, Watchers, Trees
    for (const t of ['board', 'saved', 'tickets', 'watch', 'trees']) expect(html).toContain(`['${t}','`);
  });

  it('shows tab badges only where actionable, and drops the chat count and timestamp', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).not.toContain('id="gen"');
    expect(html).not.toContain("$('#gen')");
    expect(html).toContain("(d[2]>0?'<span class=\"cnt\">'");
    expect(html).toContain("['board','▦ Board',0,'']");
    expect(html).toContain("['saved','★ Saved',0,");
    expect(html).toContain('staleTreeCount()');
    expect(html).toContain('watchBadge()');
  });

  it('has the stale and unreachable header indicator and the Slack chip', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    expect(html).toContain('id="stale"');
    expect(html).toContain('id="slackchip"');
    expect(html).toContain('Loom server not reachable');
    expect(html).toContain('age>30000');
    expect(html).toContain('Slack connected');
    expect(html).toContain('Slack: MCP');
  });

  it('carries the eight tour anchors', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude');
    for (const a of ['filters', 'group', 'chat-tabs', 'outbox', 'ship', 'row', 'slack', 'gear']) {
      expect(html).toContain(`data-tour="${a}"`);
    }
  });

  it('marks summary_pending for un-summarized chats', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000); // summary_dirty=1, no title
    const views = toChatViews(db);
    expect(views[0].summary_pending).toBe(true);
    db.close();
  });

  it('surfaces saved / saved_at on the view', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);

    // Default: not saved.
    expect(toChatViews(db)[0].saved).toBe(false);
    expect(toChatViews(db)[0].saved_at).toBe(0);

    db.prepare(`UPDATE chats SET saved=1, saved_at=4242 WHERE session_id=?`).run('sess-abc');
    const v = toChatViews(db)[0];
    expect(v.saved).toBe(true);
    expect(v.saved_at).toBe(4242);
    db.close();
  });

  it('ships the Board/Saved tab + save scaffolding in the static shell', () => {
    const html = renderDashboard([], 9999);
    expect(html).toContain('id="tabs"'); // segmented Board/Saved switch container
    expect(html).toContain('function renderTabs('); // tab renderer
    expect(html).toContain("tab='board'"); // default view state
    expect(html).toContain('id="restorebtn"'); // Restore workspace (moved to header actions)
    expect(html).toContain('/save?session='); // client save endpoint
    expect(html).toContain('/unsave?session='); // client unsave endpoint
  });

  it('lays out a session sidebar beside the selected chat, not a board and a drawer', () => {
    const html = renderDashboard([], 9999);
    const at = (str: string) => html.indexOf(str);
    const header = html.slice(html.indexOf('<header>'), html.indexOf('</header>'));

    // Header: brand, heatmap, actions, then the view tabs. The filters moved out.
    expect(header.indexOf('class="brand"')).toBeLessThan(header.indexOf('id="heatmap"'));
    expect(header.indexOf('id="heatmap"')).toBeLessThan(header.indexOf('class="actions"'));
    expect(header.indexOf('class="actions"')).toBeLessThan(header.indexOf('id="tabs"'));
    expect(header).toContain('id="sidetoggle"');
    expect(header).not.toContain('id="q"');
    expect(header).not.toContain('id="chips"');

    // Sidebar: filter, selects, chips, live toggle, archive link, then the rows.
    const sideStart = html.indexOf('<aside id="side"');
    const side = html.slice(sideStart, html.indexOf('</aside>', sideStart));
    for (const id of ['id="q"', 'id="proj"', 'id="sort"', 'id="fbtn"', 'id="fchips"', 'id="fpop"', 'id="livetoggle"', 'id="list"', 'id="archive"']) {
      expect(side).toContain(id);
    }
    expect(side.indexOf('id="q"')).toBeLessThan(side.indexOf('id="fchips"'));
    expect(side.indexOf('id="fchips"')).toBeLessThan(side.indexOf('id="livetoggle"'));
    // The status chips row is gone; drafts and issues are checkboxes in the popover.
    expect(side).not.toContain('id="chips"');
    expect(side).toContain('id="fdraft"');
    expect(side).toContain('id="fissue"');
    expect(side.indexOf('id="livetoggle"')).toBeLessThan(side.indexOf('id="list"'));
    expect(side).toContain('<div class="seg" id="livetoggle"');

    // Main: header, tabs, then the terminal and the transcript panes.
    expect(at('id="chatmain"')).toBeGreaterThan(at('id="side"'));
    expect(at('id="mhead"')).toBeLessThan(at('id="mtabs"'));
    expect(at('id="mtabs"')).toBeLessThan(at('id="mterm"'));
    expect(at('id="mterm"')).toBeLessThan(at('id="mtxwrap"'));
    expect(html).toContain('id="mmsgs"');
    expect(html).toContain('id="mdetail"');
    expect(html).toContain('grid-template-columns:var(--sidew,360px) minmax(0,1fr)');
    expect(html).toContain('id="sidegrip" role="separator"');
    // The 560px right drawer and its overlay are gone.
    expect(html).not.toContain('id="panel"');
    expect(html).not.toContain('id="overlay"');
    expect(html).not.toContain('id="detail"');
  });

  it('opens a live chat on its terminal and a chat that is not running on the transcript', () => {
    const html = renderDashboard([], 9999);
    // Terminal is the default for a live chat; a stale one lands on Transcript under the banner.
    expect(html).toContain("mtab=(!sel.arch&&livePaneFor(sid,agent)&&TERM_TOKEN)?'terminal':'transcript'");
    expect(html).toContain("(c.arch?'Archived chat':'Not running')");
    expect(html).toContain('const eff=(live&&TERM_TOKEN&&mtab===\'terminal\')?\'terminal\':\'transcript\'');
    // The terminal mounts into the main area, one at a time, reattaching per chat.
    expect(html).toContain("openTerm(L.pane_id,$('#mterm'))");
    expect(html).toContain('function openTerm(paneId,el){closeTerm();');
    expect(html).toContain('if(my!==termSeq)return;'); // a superseded open must not mount a second terminal
    // Refit on layout change: an attached pane refits (and resizes tmux); a
    // mirrored one keeps the pane's real size and only rescales.
    expect(html).toContain("const layout=()=>{if(ent.parked)return;if(mode==='mirror')scale();else{try{ent.fit.fit();}catch(e){}}};");
    expect(html).toContain('new ResizeObserver(layout)');
    // A chat that starts running (Resume) flips to its terminal.
    expect(html).toContain("&&TERM_TOKEN)mtab='terminal';");
  });

  it('groups sidebar rows and carries state, project, pane, age, PR and Slack on each', () => {
    const html = renderDashboard([], 9999);
    expect(html).toContain("var STATUS_GROUPS=['Working','Your turn','Waiting on others','Saved for later','Recent','Closed'];");
    for (const frag of ['class="sdot ', 'class="stitle"', 'class="ssub"', 'class="sage"', 'class="chp pr"', 'class="chp sl">Slack']) {
      expect(html).toContain(frag);
    }
    // Right-click on any row opens the menu; Enter selects.
    expect(html).toContain("sl.addEventListener('contextmenu'");
    expect(html).toContain('openCtx(c,e.clientX,e.clientY,null)');
  });

  it('puts Resume + Branch, PR with state, Slack, Save and More in the chat header', () => {
    const html = renderDashboard([], 9999);
    expect(html).toContain("mbtn('resume','▶ Resume','pri'");
    expect(html).toContain("mbtn('branch','⑃ Branch'");
    expect(html).toContain('b+=prciHeadHtml(c);');
    expect(html).toContain("mbtn('prci',");
    expect(html).toContain("mbtn('slack','Slack thread'");
    expect(html).toContain("mbtn('save','★ '+(c.saved?'Saved':'Save for later')");
    expect(html).toContain("mbtn('more','⋯'");
    // PR state words come from the PR itself: draft / review / merged.
    expect(html).toContain("pr.state==='MERGED'?'merged':pr.state==='CLOSED'?'closed':pr.isDraft?'draft':'review'");
    // The header reads like the mock: ~/dev/<project> · pane <name> · <tmux target>.
    expect(html).toContain("' · pane '+(L&&L.name?");
    expect(html).toContain(":esc(pn))+' · '+esc(where)");
  });

  it('counts the live toggle over the same board set the chips count', () => {
    const html = renderDashboard([], 9999);
    // Live N is board (unsaved) chats that are live, not every live pane.
    expect(html).toContain('const board=DATA.chats.filter(c=>!isSaved(c));const nLive=board.filter(isLive).length;const nAll=board.length;');
    expect(html).not.toContain('const nLive=Object.keys(DATA.live).length');
    // Row 3 hides with the chips on EM/Trees; the toggle alone hides on Saved.
    expect(html).toContain("$('#row3').style.display=other?'none':'';");
    expect(html).toContain("$('#livetoggle').style.display=(tab==='saved'||other)?'none':'';");
  });

  // Archive hits are fetched from /api/search and turned into cards entirely in the
  // browser, so their rendering can't be asserted here — only that the shell ships
  // the scaffolding those client functions need. Behaviour is covered by
  // scripts/check-dashboard.sh (syntax of the served JS) and end-to-end use.
  it('ships the archive-search scaffolding in the static shell', () => {
    const html = renderDashboard([], 9999);
    expect(html).toContain('id="archive"'); // results container
    expect(html).toContain('/api/search?q='); // client calls the archive endpoint
    expect(html).toContain('function archChat('); // archive hit -> chat the sidebar and main area can show
    expect(html).toContain('function renderArchive('); // archive section renderer
  });

  it('includes each chat source and the chosen default agent in dashboard data', () => {
    const view = {
      agent: 'codex' as const,
      session_id: 'codex-session',
      project: 'project',
      project_dir: '/project',
      jsonl_path: '/tmp/codex.jsonl',
      title: '',
      claude_auto_title: '',
      pr_url: '',
      overview: '',
      state: '',
      breakdown: [],
      first_message: '',
      message_count: 0,
      started_at: 0,
      last_active_at: 0,
      last_turn_at: 0,
      activity: {},
      summary_pending: false,
      saved: false,
      saved_at: 0,
      tags: [],
    };

    const html = renderDashboard([view], 9999, {}, 'codex');

    expect(html).toContain('"agent":"codex"');
    expect(html).toContain('"defaultAgent":"codex"');
    expect(html).toContain('id="default-agent"');
  });

  it('offers "ask every time" alongside the two agents', () => {
    const html = renderDashboard([], 9999, {}, 'ask');

    expect(html).toContain('"defaultAgent":"ask"');
    expect(html).toContain('<option value="ask">Ask every time</option>');
  });

  it('gives every card both a same-agent resume and a cross-agent start', () => {
    const html = renderDashboard([], 9999, {}, 'claude');

    // Each launch button carries the agent it runs, so the action never depends on
    // the header preference to be unambiguous.
    expect(html).toContain('function launchButtons(');
    expect(html).toContain("'⏵ Resume '+agentLabel(sourceAgent)");
    expect(html).toContain("'⊕ Start with '+agentLabel(otherAgent(sourceAgent))");
    // The preference only decorates; it is never read to decide which agent launches.
    expect(html).toContain('function prefClass(agent){return DATA.defaultAgent===agent');
    expect(html).not.toContain('const selectedAgent=DATA.defaultAgent');
  });

  it('launches into a lane, skipping the picker when only one lane has room', () => {
    const html = renderDashboard([], 9999, {}, 'claude');

    expect(html).toContain("fetch('/api/lanes')");
    expect(html).not.toContain('/api/idle-panes');
    expect(html).toContain('if(lanes.length===1){doLaunch(sid,sourceAgent,lanes[0].lane,');
    expect(html).toContain("' into which lane?</div>'");
    expect(html).toContain("'&lane='+encodeURIComponent(lane)");
    expect(html).not.toContain("encodeURIComponent(selectedAgent)+'&pane='");
  });

  it('offers close and branch for both agents, not Claude alone', () => {
    const html = renderDashboard([], 9999, {}, 'claude');

    // Close and Branch are menu/header actions on any chat, never gated on the agent.
    expect(html).toContain("startLaunch(c,'branch')");
    expect(html).toContain('doClose(c.session_id,c.agent)');
    expect(html).not.toContain("c.agent==='claude'?'<button class=\"closebtn\"");
    expect(html).not.toContain('canBranch');
  });
});

describe('per-chat action menu', () => {
  // The menu list is plain JS shared by the header More menu and the right-click
  // menu, so it can be evaluated here without a DOM.
  const chatMenuItems = new Function(`${CHAT_MENU_JS}; return chatMenuItems;`)() as (x: Record<string, unknown>) => {
    key: string; label: string; hint: string; disabled: boolean; danger: boolean; divider: boolean; tip?: string;
  }[];
  const base = { live: true, saved: false, archive: false, prNum: '', prState: '', hasSlack: false, armedClose: false };

  it('keeps the design order, ending on the danger item', () => {
    expect(chatMenuItems(base).map((i) => i.key)).toEqual([
      'open', 'external', 'branch', 'pr', 'slack', 'save', 'tags', 'unpark', 'restore', 'copyResume', 'copyId', 'rename', 'orchestrator', 'close',
    ]);
    const labels = chatMenuItems({ ...base, prNum: '4231', prState: 'draft', hasSlack: true }).map((i) => i.label);
    expect(labels).toEqual([
      'Open terminal', 'Open in external terminal', 'Branch into a new window', 'Open PR #4231', 'Open Slack thread',
      'Save for later', 'Tags', 'Unpark', 'Restore to board', 'Copy resume command', 'Copy session ID', 'Rename', 'Ask the orchestrator about this', 'Close chat',
    ]);
    const last = chatMenuItems(base).at(-1)!;
    expect(last.danger).toBe(true);
    expect(chatMenuItems(base).filter((i) => i.danger)).toHaveLength(1);
  });

  it('disables, never hides, the PR and Slack items when the chat has neither', () => {
    const items = chatMenuItems(base);
    expect(items).toHaveLength(14);
    expect(items.find((i) => i.key === 'pr')).toMatchObject({ label: 'Open PR', disabled: true, hint: 'none' });
    expect(items.find((i) => i.key === 'slack')).toMatchObject({ label: 'Open Slack thread', disabled: true, hint: 'none' });
    const withBoth = chatMenuItems({ ...base, prNum: '4231', prState: 'review', hasSlack: true });
    expect(withBoth.find((i) => i.key === 'pr')).toMatchObject({ disabled: false, hint: 'review' });
    expect(withBoth.find((i) => i.key === 'slack')).toMatchObject({ disabled: false });
  });

  it('offers Resume and Remove from board when the chat is not running', () => {
    const items = chatMenuItems({ ...base, live: false });
    expect(items[0].label).toBe('Resume');
    expect(items.find((i) => i.key === 'external')).toMatchObject({ disabled: true });
    expect(items.at(-1)).toMatchObject({ key: 'close', label: 'Remove from board', danger: true, disabled: false });
    // A saved chat is exempt from removal until it is unsaved.
    expect(chatMenuItems({ ...base, live: false, saved: true }).at(-1)).toMatchObject({ disabled: true, hint: 'unsave first' });
  });

  it('puts Tags right after Save for later, disabled for an archive hit, with the count as its hint', () => {
    const keys = chatMenuItems(base).map((i) => i.key);
    expect(keys.indexOf('tags')).toBe(keys.indexOf('save') + 1);
    expect(chatMenuItems({ ...base, tagCount: 2 }).find((i) => i.key === 'tags')).toMatchObject({ label: 'Tags', hint: '2', disabled: false });
    expect(chatMenuItems({ ...base, live: false, archive: true }).find((i) => i.key === 'tags')?.disabled).toBe(true);
  });

  it('toggles Save / Unsave and warns that saving a live chat closes its pane', () => {
    expect(chatMenuItems(base).find((i) => i.key === 'save')).toMatchObject({ label: 'Save for later', hint: 'closes pane' });
    expect(chatMenuItems({ ...base, saved: true }).find((i) => i.key === 'save')).toMatchObject({ label: 'Unsave', hint: '' });
    expect(chatMenuItems({ ...base, live: false }).find((i) => i.key === 'save')?.hint).toBe('');
  });

  it('enables Ask the orchestrator only while the orchestrator runs, and never for an archive hit', () => {
    expect(chatMenuItems(base).find((i) => i.key === 'orchestrator')).toMatchObject({
      label: 'Ask the orchestrator about this', disabled: true, hint: 'not running', tip: 'The orchestrator is not running',
    });
    expect(chatMenuItems({ ...base, orchLive: true }).find((i) => i.key === 'orchestrator')).toMatchObject({ disabled: false, hint: '', tip: '' });
    expect(chatMenuItems({ ...base, orchLive: true, live: false, archive: true }).find((i) => i.key === 'orchestrator')?.disabled).toBe(true);
  });

  it('asks twice before closing a live chat', () => {
    expect(chatMenuItems({ ...base, armedClose: true }).at(-1)?.label).toBe('Click again to close');
  });

  it('disables chat-bound items for an archive hit, which has no board row', () => {
    const items = chatMenuItems({ ...base, live: false, archive: true });
    for (const key of ['save', 'rename', 'close']) expect(items.find((i) => i.key === key)?.disabled).toBe(true);
    expect(items.find((i) => i.key === 'open')?.label).toBe('Resume');
  });

  it('is embedded in the page and wired to the clipboard, the PR link and the rename dialog', () => {
    const html = renderDashboard([], 9999);
    expect(html).toContain('function chatMenuItems(x)');
    expect(html).toContain('id="ctx"');
    expect(html).toContain("navigator.clipboard.writeText(text)");
    expect(html).toContain("copyText(resumeCmd(c),'resume command copied')");
    expect(html).toContain("window.open(u,'_blank','noopener')");
    expect(html).toContain("fetch('/api/rename'");
    expect(html).toContain("fetch('/api/hide'");
  });
});

describe('rename and hide', () => {
  it('shows a title override over the generated title, and keeps it across re-indexing', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);
    db.prepare(`UPDATE chats SET title='Generated' WHERE session_id=?`).run('sess-abc');
    expect(toChatViews(db)[0].title).toBe('Generated');

    db.prepare(`INSERT INTO chat_titles (agent, session_id, title, updated_at) VALUES ('claude', 'sess-abc', 'Mine', 1)`).run();
    expect(toChatViews(db)[0].title).toBe('Mine');
    // The summarizer and indexer rewrite the chats row; the override is a separate row.
    db.prepare(`UPDATE chats SET title='Regenerated', summary_dirty=1 WHERE session_id=?`).run('sess-abc');
    upsertChat(db, parsed, 2000, 6000);
    expect(toChatViews(db)[0].title).toBe('Mine');
    db.close();
  });

  it('hides a chat from the board until it is active again', async () => {
    const db = openDb(':memory:');
    const parsed = await parseJsonlFile(FIX);
    upsertChat(db, parsed, 1000, 5000);
    const last = toChatViews(db)[0].last_active_at;
    db.prepare(`INSERT INTO chat_hidden (agent, session_id, hidden_at) VALUES ('claude', 'sess-abc', ?)`).run(last + 10);
    expect(toChatViews(db)).toHaveLength(0);
    db.prepare(`UPDATE chats SET last_active_at = ? WHERE session_id=?`).run(last + 1000, 'sess-abc');
    expect(toChatViews(db)).toHaveLength(1);
    db.close();
  });
});

describe('dashboard script', () => {
  it('parses as a whole and carries the Slack-start banner mount', async () => {
    const vm = await import('node:vm');
    const html = renderDashboard([], Date.now(), {}, 'claude', [], [], 'tok');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const src of scripts) new vm.Script(src);
    expect(html).toContain('id="mslack"');
    expect(html).toContain('Started a chat for this Slack thread. No chat owned it.');
  });
});

describe('orchestrator feed filters', () => {
  const load = async () => {
    const { ORCH_VIEW_JS } = await import('../src/orchview.ts');
    return new Function('esc', 'rel', 'DATA', 'chatKey', `var TERM_TOKEN='tok';${ORCH_VIEW_JS}; return { orchRowKind, orchRowShown, orchCounts, orchMerge };`)(
      (s: string) => s, () => '', { chats: [], live: {} }, () => '',
    ) as Record<string, (...a: any[]) => any>;
  };
  const m = (role: string, text: string, at = 1) => ({ t: at, i: 0, m: { role, text, at } });
  const l = (kind: string, text = 'x', target = 'blue-vanilla') => ({ t: 1, i: 0, l: { id: 1, kind, text, target, at: 1 } });
  const defaults = { conv: true, relay: false, ev: false, sys: false, q: '' };

  it('classifies every row kind', async () => {
    const v = await load();
    expect(v.orchRowKind(m('user', 'hi'))).toBe('conv');
    expect(v.orchRowKind(m('assistant', 'hello'))).toBe('conv');
    expect(v.orchRowKind(m('user', '[Loom events] a -- b'))).toBe('ev');
    expect(v.orchRowKind(m('user', 'Loom started you. x'))).toBe('sys');
    expect(v.orchRowKind(m('user', 'Loom restarted you. x'))).toBe('sys');
    for (const k of ['relay', 'queued', 'delivered']) expect(v.orchRowKind(l(k))).toBe('relay');
    expect(v.orchRowKind(l('failed'))).toBe('failed');
    expect(v.orchRowKind(l('started'))).toBe('sys');
  });

  it('shows only the conversation by default, and each chip adds its kind', async () => {
    const v = await load();
    expect(v.orchRowShown(m('user', 'hi'), defaults)).toBe(true);
    expect(v.orchRowShown(l('relay'), defaults)).toBe(false);
    expect(v.orchRowShown(m('user', '[Loom events] a'), defaults)).toBe(false);
    expect(v.orchRowShown(l('started'), defaults)).toBe(false);
    expect(v.orchRowShown(l('delivered'), { ...defaults, relay: true })).toBe(true);
    expect(v.orchRowShown(m('user', '[Loom events] a'), { ...defaults, ev: true })).toBe(true);
    expect(v.orchRowShown(l('started'), { ...defaults, sys: true })).toBe(true);
    expect(v.orchRowShown(m('user', 'hi'), { ...defaults, conv: false })).toBe(false);
  });

  it('always shows a failed relay, whatever the chips', async () => {
    const v = await load();
    expect(v.orchRowShown(l('failed'), { conv: false, relay: false, ev: false, sys: false, q: '' })).toBe(true);
  });

  it('searches case-insensitively across the visible rows, including relay targets', async () => {
    const v = await load();
    expect(v.orchRowShown(m('assistant', 'NE 501N rollup'), { ...defaults, q: 'ne 501n' })).toBe(true);
    expect(v.orchRowShown(m('assistant', 'NE 501N rollup'), { ...defaults, q: 'ach' })).toBe(false);
    expect(v.orchRowShown(l('delivered', 'stop', 'Blue-Vanilla'), { ...defaults, relay: true, q: 'blue-van' })).toBe(true);
    expect(v.orchRowShown(l('failed', 'stop'), { ...defaults, q: 'nomatch' })).toBe(false);
  });

  it('counts rows per kind', async () => {
    const v = await load();
    expect(v.orchCounts([m('user', 'a'), m('assistant', 'b'), l('relay'), l('failed'), l('started'), m('user', '[Loom events] z')])).toEqual({ conv: 2, relay: 1, ev: 1, sys: 1, failed: 1 });
  });

  it('merges pages without duplicating turns and keeps time order', async () => {
    const v = await load();
    const store: any[] = [];
    const keys = {};
    expect(v.orchMerge(store, keys, [{ role: 'user', text: 'b', at: 20 }, { role: 'user', text: 'c', at: 30 }])).toBe(2);
    expect(v.orchMerge(store, keys, [{ role: 'user', text: 'a', at: 10 }, { role: 'user', text: 'b', at: 20 }])).toBe(1);
    expect(store.map((x) => x.text)).toEqual(['a', 'b', 'c']);
  });
});

describe('orchestrator view', () => {
  const load = async () => {
    const { ORCH_VIEW_JS } = await import('../src/orchview.ts');
    const esc = (s: string) => (s || '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]!);
    const rel = () => '6m ago';
    const DATA = { chats: [{ agent: 'claude', session_id: 's1' }], live: {} };
    return new Function('esc', 'rel', 'DATA', 'chatKey', `var TERM_TOKEN='tok';${ORCH_VIEW_JS}; return { orchPinHtml, orchRailHtml, orchTimeline, orchMsgHtml, orchHeadHtml, orchRowKind, orchRowShown, orchCounts, orchMerge };`)(
      esc, rel, DATA, (c: { agent: string; session_id: string }) => c.agent + ':' + c.session_id,
    ) as Record<string, (...a: unknown[]) => any>;
  };

  it('mounts the pinned entry above the list, the view inside the main area, and its wiring', () => {
    const html = renderDashboard([], Date.now(), {}, 'claude', [], [], 'tok', { sessionId: 'o1', needsYou: 2, enabled: true, live: true });
    expect(html.indexOf('id="orchpin"')).toBeLessThan(html.indexOf('id="list"'));
    expect(html).toContain('id="orchview"');
    expect(html).toContain('aria-label="Conversation"');
    expect(html).toContain('aria-label="Status"');
    expect(html).toContain('"needsYou":2');
    for (const route of ['/api/orch', '/api/orch/send', '/api/orch/ask', '/api/orch/notify', '/api/orch/resolve']) expect(html).toContain(`'${route}'`);
    expect(html).toContain("case 'orchestrator':closeCtx();askOrchestrator(c);return;");
    expect(html).toContain('orchLive:!!(DATA.orch&&DATA.orch.live)');
  });

  it('renders the pin as one line: name, Running / Not running, and a Needs you badge', async () => {
    const v = await load();
    const on = v.orchPinHtml({ needsYou: 3, live: true, enabled: true }, false);
    expect(on).toContain('3 need you');
    expect(on).toContain('Running');
    const off = v.orchPinHtml({ needsYou: 0, live: false, enabled: true }, true);
    expect(off).not.toContain('need you');
    expect(off).toContain('Not running');
    expect(off).toContain('opin sel');
  });

  it('renders the rail from the items: Needs you cards with a jump button, Blocked, Moving per agent, Done today', async () => {
    const v = await load();
    const html = v.orchRailHtml({
      items: [
        { id: 1, kind: 'needs_you', ref_type: 'chat', ref_id: 'claude:s1', title: 'NE 501N rollup', why: 'one per FEIN?', who: '', opened_at: 1, updated_at: 1, resolved_at: 0 },
        { id: 2, kind: 'needs_you', ref_type: 'pr', ref_id: 'https://github.com/o/r/pull/4198', title: 'PR #4198', why: 'green', who: '', opened_at: 1, updated_at: 1, resolved_at: 0 },
        { id: 3, kind: 'blocked', ref_type: '', ref_id: '', title: 'NE', why: 'confirmation of the rollup', who: 'Alex', opened_at: 1, updated_at: 1, resolved_at: 0 },
        { id: 4, kind: 'moving', ref_type: 'chat', ref_id: 'claude:s2', title: 'R03 retry', why: 'opening #4231', who: 'blue-vanilla', opened_at: 1, updated_at: 1, resolved_at: 0 },
        { id: 5, kind: 'done', ref_type: '', ref_id: '', title: '#4240 merged', why: '', who: '', opened_at: 1, updated_at: 1, resolved_at: 9 },
      ],
      moving: [{ chat: 'claude:s9', pane: 'lucky-fern', title: 'MO-941', stage: 'implementation' }],
    });
    expect(html).toContain('Needs you · 2');
    expect(html).toContain('data-jump="1">Open chat');
    expect(html).toContain('data-jump="2">Open PR');
    expect(html).toContain('<b>Alex</b>: confirmation of the rollup');
    expect(html).toContain('Moving · 2');
    expect(html).toContain('<b>blue-vanilla</b> · R03 retry');
    expect(html).toContain('<b>lucky-fern</b> · MO-941');
    expect(html).toContain('#4240 merged');
  });

  it('interleaves what Loom did with the conversation, and shows event batches as lines', async () => {
    const v = await load();
    const tl = v.orchTimeline({
      messages: [
        { role: 'user', text: 'where are we', at: 10 },
        { role: 'user', text: '[Loom events] 09:40, 1 change: (1) your turn -- Update the items', at: 20 },
        { role: 'assistant', text: 'Sent.', at: 40 },
      ],
      log: [{ id: 1, at: 30, kind: 'queued', target: 'cozy-donut', text: 'per company' }, { id: 2, at: 21, kind: 'events', target: 'orchestrator', text: 'dup' }],
    });
    const html = tl.map(v.orchMsgHtml).join('');
    expect(html.indexOf('where are we')).toBeLessThan(html.indexOf('Queued for <b>cozy-donut</b>'));
    expect(html.indexOf('Queued for')).toBeLessThan(html.indexOf('Sent.'));
    expect(html).toContain('Loom events · 09:40');
    expect(html).not.toContain('Update the items');
    expect(html).not.toContain('dup');
  });

  it('offers Copy phone link only when the Remote Control link is known', async () => {
    const v = await load();
    expect(v.orchHeadHtml({ live: true, remoteUrl: 'https://claude.ai/code/x', notify: 'needs_you' })).toMatch(/data-oa="phone">Copy phone link/);
    expect(v.orchHeadHtml({ live: true, remoteUrl: '', notify: 'off' })).toMatch(/data-oa="phone" disabled/);
    expect(v.orchHeadHtml({ live: true, remoteUrl: '', notify: 'off' })).toContain('Notify: Off');
  });
});

describe('tag UI wiring', () => {
  it('has the tag filter, group-by switch, header add control and the Tags submenu', () => {
    const html = renderDashboard([], 9999);
    for (const frag of ['id="tagbtn"', 'id="groupby"', 'id="tagpop"', 'data-act="tagpop"', 'function tagsPanel(', 'placeholder="New tag…"', "'/api/chat-tags'", "'/api/tags'"]) {
      expect(html).toContain(frag);
    }
    // Chips on rows truncate to two and show +N; the choices persist like other view prefs.
    expect(html).toContain('ts.slice(0,2)');
    expect(html).toContain("lsSet('loom.groupBy',groupBy)");
    expect(html).toContain("lsSet('loom.tagFilter',JSON.stringify(tagSel))");
    // The status grouping is the default.
    expect(html).toContain("groupBy=lsGet('loom.groupBy')==='tag'?'tag':'status'");
    expect(html).toContain('matchTagFilter(c)');
  });

  it('carries tag definitions in the data blob', () => {
    const html = renderDashboard([], 9999, {}, 'claude', [], [], '', null, [{ name: 'ach', color: '#79b1ff', count: 2 }]);
    expect(html).toContain('"tags":[{"name":"ach","color":"#79b1ff","count":2}]');
  });
});

