import type Database from 'better-sqlite3';

// Per-chat test links: the pages a chat registers (`loom test-links add`) so a
// person can open them from the board and try what the chat built. Storage,
// validation, and the board's popover (plain browser JS, written without regex
// escapes so it survives being embedded in the page script).

export const TEST_LINKS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_test_links (
  session_id  TEXT NOT NULL,
  url         TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',
  added_at    INTEGER NOT NULL,
  PRIMARY KEY (session_id, url)
);
`;

export const TEST_LINKS_MAX = 10;
const URL_MAX = 2000;
const LABEL_MAX = 120;

export interface TestLink {
  url: string;
  label: string;
  added_at: number;
}

/** The normalised URL when it is http(s), else null. javascript:, file:, data: and the rest are refused. */
export function cleanTestUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > URL_MAX) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname) return null;
    return u.href;
  } catch {
    return null;
  }
}

/** Add or refresh a link (same URL on the same chat updates label and time), keeping the newest 10. */
export function addTestLink(db: Database.Database, sessionId: string, url: unknown, label: unknown, at: number): { ok: boolean; detail: string } {
  if (!sessionId) return { ok: false, detail: 'session is required' };
  const clean = cleanTestUrl(url);
  if (!clean) return { ok: false, detail: 'only http(s) URLs are allowed' };
  const lb = (typeof label === 'string' ? label : '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX);
  db.prepare(
    `INSERT INTO chat_test_links (session_id, url, label, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id, url) DO UPDATE SET label = excluded.label, added_at = excluded.added_at`,
  ).run(sessionId, clean, lb, at);
  db.prepare(
    `DELETE FROM chat_test_links WHERE session_id = ? AND url NOT IN
       (SELECT url FROM chat_test_links WHERE session_id = ? ORDER BY added_at DESC, rowid DESC LIMIT ?)`,
  ).run(sessionId, sessionId, TEST_LINKS_MAX);
  return { ok: true, detail: 'added' };
}

/** Clear one link (by URL) or every link of the chat. */
export function clearTestLinks(db: Database.Database, sessionId: string, url?: unknown): { ok: boolean; detail: string } {
  if (!sessionId) return { ok: false, detail: 'session is required' };
  if (typeof url === 'string' && url.trim()) {
    const clean = cleanTestUrl(url) ?? url.trim();
    const n = db.prepare(`DELETE FROM chat_test_links WHERE session_id = ? AND url = ?`).run(sessionId, clean).changes;
    return { ok: true, detail: n ? 'cleared' : 'not found' };
  }
  db.prepare(`DELETE FROM chat_test_links WHERE session_id = ?`).run(sessionId);
  return { ok: true, detail: 'cleared' };
}

/** One chat's links, newest first. */
export function listTestLinks(db: Database.Database, sessionId: string): TestLink[] {
  return db.prepare(`SELECT url, label, added_at FROM chat_test_links WHERE session_id = ? ORDER BY added_at DESC, rowid DESC`).all(sessionId) as TestLink[];
}

/** Every chat's links keyed by session id: what /api/data carries (at most 10 per chat, only chats that have any). */
export function allTestLinks(db: Database.Database): Record<string, TestLink[]> {
  const rows = db.prepare(`SELECT session_id, url, label, added_at FROM chat_test_links ORDER BY added_at DESC, rowid DESC`).all() as (TestLink & { session_id: string })[];
  const out: Record<string, TestLink[]> = {};
  for (const r of rows) (out[r.session_id] ||= []).push({ url: r.url, label: r.label, added_at: r.added_at });
  return out;
}

export const TEST_LINKS_CSS = `
  #testpop { position:fixed; z-index:40; width:min(460px, calc(100vw - 16px)); max-height:60vh; overflow-y:auto; padding:6px; border-radius:10px; border:1px solid #2f3548; background:#171b28; box-shadow:0 14px 36px rgba(0,0,0,.55); display:flex; flex-direction:column; gap:1px; }
  #testpop[hidden] { display:none; }
  .tlrow { display:grid; grid-template-columns:1fr auto; align-items:center; gap:10px; padding:7px 10px; border-radius:6px; font-size:13px; color:#e4e7ee; }
  .tlrow:hover { background:#222a3d; }
  .tlrow .tlb { min-width:0; display:flex; flex-direction:column; gap:2px; }
  .tlrow .tll { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tlrow .tlu { color:#8a90a2; font-size:11px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .tlrow button, .tlall { font:inherit; font-size:12px; padding:3px 10px; border-radius:6px; border:1px solid #2f3548; background:#1c2133; color:#e4e7ee; cursor:pointer; }
  .tlrow button:hover, .tlall:hover { background:#222a3d; }
  .tlhead { display:flex; align-items:center; justify-content:space-between; padding:4px 10px 6px; color:#8a90a2; font-size:11px; border-bottom:1px solid #2a2f42; margin-bottom:3px; }
`;

export const TEST_LINKS_VIEW_JS = String.raw`
// ---- Test links ---------------------------------------------------------------
var testPop=null;
function testLinksOf(c){return ((DATA.testLinks||{})[c.session_id])||[];}
function testHeadHtml(c){var n=testLinksOf(c).length;if(!n)return '';
  return mbtn('testlinks','Test <span class="chp sl">'+n+'</span>','',' aria-haspopup="menu" aria-expanded="'+(!!testPop)+'" title="open the pages this chat registered for testing"');}
function testShort(u){try{var x=new URL(u);var p=x.pathname+x.search;return x.host+(p==='/'?'':p);}catch(e){return u;}}
function testOpen(u){window.open(u,'_blank','noopener');}
function closeTestPop(){if(!testPop)return;testPop=null;var m=$('#testpop');if(m){m.hidden=true;m.innerHTML='';}var b=document.querySelector('[data-act="testlinks"]');if(b)b.setAttribute('aria-expanded','false');}
function openTestPop(c,anchor){var m=$('#testpop');var list=testLinksOf(c);if(!list.length)return;testPop={sid:c.session_id};
  m.innerHTML='<div class="tlhead"><span>'+list.length+' to check</span>'+(list.length>1?'<button type="button" class="tlall" data-all="1">Open all</button>':'')+'</div>'
    +list.map(function(l,i){return '<div class="tlrow"><span class="tlb"><span class="tll">'+esc(l.label||testShort(l.url))+'</span><span class="tlu" title="'+esc(l.url)+'">'+esc(testShort(l.url))+'</span></span><button type="button" data-i="'+i+'">Open</button></div>';}).join('');
  m.hidden=false;var r=anchor.getBoundingClientRect();var w=m.offsetWidth,h=m.offsetHeight;
  m.style.left=Math.max(8,Math.min(r.right-w,window.innerWidth-w-8))+'px';m.style.top=Math.max(8,Math.min(r.bottom+6,window.innerHeight-h-8))+'px';anchor.setAttribute('aria-expanded','true');}
function toggleTestPop(c,anchor){if(testPop){closeTestPop();return;}openTestPop(c,anchor);}
function wireTestPop(){var m=$('#testpop');
  m.addEventListener('click',function(e){var c=selChat();if(!c)return;var list=testLinksOf(c);var b=e.target.closest('button');if(!b)return;
    if(b.dataset.all){list.forEach(function(l){testOpen(l.url);});closeTestPop();return;}
    var l=list[Number(b.dataset.i)];if(l)testOpen(l.url);});
  document.addEventListener('mousedown',function(e){if(testPop&&!e.target.closest('#testpop,[data-act="testlinks"]'))closeTestPop();});
  document.addEventListener('keydown',function(e){if(testPop&&e.key==='Escape'){e.stopPropagation();closeTestPop();}},true);
  window.addEventListener('blur',closeTestPop);window.addEventListener('resize',closeTestPop);}
`;
