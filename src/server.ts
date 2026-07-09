import http from 'node:http';
import fs from 'node:fs';
import { openDb } from './db.ts';
import { toChatViews, renderDashboard, type ChatView, type LiveLoc } from './dashboard.ts';
import { liveSessions, listTmuxPanes, idlePanes } from './placements.ts';
import { gotoPane, resumeInPane, branchInPane, closeSession, sendToPane } from './goto.ts';
import { readTranscript } from './transcript.ts';
import { writeLayout } from './snapshot.ts';

export const SERVER_PORT = 4317;

// Map a running pane's (cleaned) title back to a session, for the bootstrap path
// before the placement hook has recorded anything. Skip the generic default.
function titleToSession(views: ChatView[]): Map<string, string> {
  const m = new Map<string, string>();
  // Claude sets the pane title to its own auto-title, so that's the reliable key;
  // also index Loom's title as a fallback. Skip the ambiguous default.
  for (const v of views) {
    for (const t of [v.claude_auto_title, v.title]) {
      if (t && t !== 'Claude Code' && !m.has(t)) m.set(t, v.session_id);
    }
  }
  return m;
}

// A live chat is "working" if its transcript was written very recently (Claude is
// actively generating / running tools) vs. idle and waiting for the user.
const WORKING_MS = 10_000;

function snapshot(): { views: ChatView[]; live: Record<string, LiveLoc> } {
  const db = openDb();
  const views = toChatViews(db);
  db.close();
  const now = Date.now();
  // The DB's last_active_at only refreshes on a summarizer pass (minutes of lag).
  // The transcript file's mtime is the true last-activity time — read it live so
  // "X ago" is accurate every poll, and reuse it for the working flag.
  const mtime = new Map<string, number>();
  for (const v of views) {
    try {
      const mt = fs.statSync(v.jsonl_path).mtimeMs;
      mtime.set(v.session_id, mt);
      if (mt > v.last_active_at) v.last_active_at = mt;
    } catch {
      /* file gone */
    }
  }
  const liveMap = liveSessions({ titleToSession: titleToSession(views) });
  const live: Record<string, LiveLoc> = {};
  for (const [sid, info] of liveMap) {
    const mt = mtime.get(sid) ?? 0;
    live[sid] = { ...info, working: now - mt < WORKING_MS };
  }
  if (process.env.LOOM_DEBUG) {
    const panes = listTmuxPanes();
    console.error(`[loom-debug] views=${views.length} panes=${panes.length} live=${Object.keys(live).length}`);
  }
  return { views, live };
}

function send(res: http.ServerResponse, code: number, type: string, body: string) {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}

export function createServer(): http.Server {
  return http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');

    if (url.pathname === '/goto') {
      const sid = url.searchParams.get('session') || '';
      const { live } = snapshot();
      const info = live[sid];
      if (!info) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'no live pane' }));
      const r = gotoPane(info.pane_id, info.tmux_session);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    if (url.pathname === '/api/live') {
      const { live } = snapshot();
      return send(res, 200, 'application/json', JSON.stringify(live));
    }

    if (url.pathname === '/api/data') {
      const { views, live } = snapshot();
      return send(res, 200, 'application/json', JSON.stringify({ generatedAt: Date.now(), chats: views, live }));
    }

    if (url.pathname === '/api/idle-panes') {
      return send(res, 200, 'application/json', JSON.stringify(idlePanes()));
    }

    if (url.pathname === '/api/transcript') {
      const sid = url.searchParams.get('session') || '';
      const { views, live } = snapshot();
      const v = views.find((x) => x.session_id === sid);
      if (!v) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'unknown session' }));
      const messages = readTranscript(v.jsonl_path);
      return send(res, 200, 'application/json', JSON.stringify({
        ok: true, title: v.title || v.first_message, project: v.project,
        live: !!live[sid], messages,
      }));
    }

    if (url.pathname === '/send') {
      const sid = url.searchParams.get('session') || '';
      const text = url.searchParams.get('text') || '';
      const { live } = snapshot();
      const info = live[sid];
      if (!info) return send(res, 409, 'application/json', JSON.stringify({ ok: false, detail: 'chat is not live — resume it first' }));
      const r = sendToPane(info.pane_id, text);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    if (url.pathname === '/close') {
      const sid = url.searchParams.get('session') || '';
      const { live } = snapshot();
      const info = live[sid];
      if (!info) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'no live pane' }));
      const r = closeSession(info.pane_id);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    if (url.pathname === '/resume') {
      const sid = url.searchParams.get('session') || '';
      const pane = url.searchParams.get('pane') || '';
      if (!pane) return send(res, 400, 'application/json', JSON.stringify({ ok: false, detail: 'no pane' }));
      const { views } = snapshot();
      const v = views.find((x) => x.session_id === sid);
      if (!v) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'unknown session' }));
      const r = resumeInPane(pane, v.project_dir, sid);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    if (url.pathname === '/branch') {
      const sid = url.searchParams.get('session') || '';
      const pane = url.searchParams.get('pane') || '';
      if (!pane) return send(res, 400, 'application/json', JSON.stringify({ ok: false, detail: 'no pane' }));
      const { views } = snapshot();
      const v = views.find((x) => x.session_id === sid);
      if (!v) return send(res, 404, 'application/json', JSON.stringify({ ok: false, detail: 'unknown session' }));
      const r = branchInPane(pane, v.project_dir, sid);
      return send(res, r.ok ? 200 : 500, 'application/json', JSON.stringify(r));
    }

    if (url.pathname === '/' || url.pathname === '/index.html') {
      const { views, live } = snapshot();
      return send(res, 200, 'text/html; charset=utf-8', renderDashboard(views, Date.now(), live));
    }

    send(res, 404, 'text/plain', 'not found');
  });
}

// Start only when run directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(SERVER_PORT, '127.0.0.1', () => {
    console.log(`[loom] server on http://localhost:${SERVER_PORT}`);
  });
  // Capture a full tmux-layout snapshot for crash recovery while tmux is healthy.
  const snap = () => {
    try {
      writeLayout(Date.now());
    } catch {
      /* tmux not running */
    }
  };
  snap();
  setInterval(snap, 15_000);
}
