// Loom mobile PWA script (served at /m/app.js). Vanilla JS, no framework, no build step.
// Written for a CSP of script-src 'self': no inline handlers, everything is wired with
// addEventListener, and text goes in through textContent. Plain ES2017 inside a template
// string, so it must never contain a backtick or a dollar-brace; strings are joined with +.
// The desktop sidebar's drag-and-drop helpers (src/grouping.ts: reorderIds, applyGroupHoldsTo,
// dndScrollSpeed) are spliced in ahead of the app, so the phone moves groups the same way.

import { GROUPING_JS } from '../grouping.ts';
import { SCROLLFOLLOW_JS } from './scrollfollow.ts';

export const APP_JS =
  String.raw`
(function () {
'use strict';
` +
  GROUPING_JS +
  SCROLLFOLLOW_JS +
  String.raw`

var app = document.getElementById('app');
var ROOT = document.documentElement;

// ---- small helpers ---------------------------------------------------------------
function append(el, kids) {
  kids.forEach(function (c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  });
}
// Plain text with its http(s) links made tappable. Slack's <url|label> markup shows the label.
// Links open outside the app: a slack.com or github.com link opens the Slack or GitHub app
// when it's installed (iOS universal links), Safari otherwise.
var URL_RE = /<(https?:\/\/[^|>\s]+)\|([^>]+)>|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]'])/g;
function linked(text) {
  var f = document.createDocumentFragment(), s = String(text == null ? '' : text), i = 0, m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(s))) {
    if (m.index > i) f.appendChild(document.createTextNode(s.slice(i, m.index)));
    var url = m[1] || m[3] || m[4], label = m[2] || url;
    f.appendChild(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: 'lnk', text: label }));
    i = m.index + m[0].length;
  }
  if (i < s.length) f.appendChild(document.createTextNode(s.slice(i)));
  return f;
}
function h(tag, props) {
  var el = document.createElement(tag);
  if (props) {
    Object.keys(props).forEach(function (k) {
      var v = props[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'on') Object.keys(v).forEach(function (ev) { el.addEventListener(ev, v[ev]); });
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
  }
  append(el, Array.prototype.slice.call(arguments, 2));
  return el;
}
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
var ICONS = {
  sessions: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"></path></svg>',
  outbox: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 13l3-8h12l3 8M3 13v6h18v-6M3 13h5l1.5 2.5h5L16 13h5"></path></svg>',
  settings: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 10-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 01-3.4 0"></path></svg>',
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"></path></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="2" fill="currentColor"></rect></svg>',
  send: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>',
  warn: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true" style="flex:none;margin-top:1px"><path d="M12 9v4M12 17h.01M10.3 3.9L2 18a2 2 0 001.7 3h16.6a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"></path></svg>',
  talk: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M4 10v4M8 7v10M12 4v16M16 7v10M20 10v4"></path></svg>',
  image: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="3"></rect><circle cx="9" cy="10" r="1.6"></circle><path d="M21 16l-5-5-8 8"></path></svg>',
  share: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" role="img" aria-label="Share icon" style="vertical-align:-2px"><path d="M12 3v12M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6"></path></svg>'
};
function icon(name) { var t = document.createElement('span'); t.className = 'ico'; t.innerHTML = ICONS[name]; return t; }
function ls(k, v) {
  try { if (v === undefined) return localStorage.getItem(k); if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {}
  return null;
}
function toMs(v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  var t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}
function ago(v) {
  var ms = toMs(v);
  if (!ms) return '';
  var d = Math.max(0, Date.now() - ms);
  if (d < 45000) return 'now';
  if (d < 3600000) return Math.max(1, Math.round(d / 60000)) + 'm';
  if (d < 86400000) return Math.round(d / 3600000) + 'h';
  return Math.round(d / 86400000) + 'd';
}
function agoWords(v) {
  var ms = toMs(v);
  if (!ms) return 'never';
  var d = Date.now() - ms;
  if (d < 120000) return 'active now';
  if (d < 3600000) return 'last seen ' + Math.round(d / 60000) + ' minutes ago';
  if (d < 86400000) return 'last seen ' + Math.round(d / 3600000) + ' hours ago';
  var days = Math.round(d / 86400000);
  return 'last seen ' + days + (days === 1 ? ' day ago' : ' days ago');
}
function shortDate(v) {
  var ms = toMs(v);
  if (!ms) return '';
  try { return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); } catch (e) { return ''; }
}

// ---- theme -----------------------------------------------------------------------
function getTheme() { var t = ls('loom.theme'); return t === 'light' || t === 'dark' ? t : 'system'; }
function syncThemeColor() {
  var m = document.querySelector('meta[name="theme-color"]');
  if (!m) return;
  var c = getComputedStyle(ROOT).getPropertyValue('--bg').trim();
  if (c) m.setAttribute('content', c);
}
function applyTheme(t) {
  if (t === 'light' || t === 'dark') ROOT.setAttribute('data-theme', t); else ROOT.removeAttribute('data-theme');
  syncThemeColor();
}
try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeColor); } catch (e) {}

// ---- api -------------------------------------------------------------------------
var S = { me: null, raw: null, groups: [], sections: [], sessions: [], counts: { working: 0, turn: 0, waiting: 0, saved: 0, recent: 0 }, outboxPending: 0, live: true, onSessions: null, tabs: null };
var shellUp = false;

function api(path, opt) {
  opt = opt || {};
  var init = { method: opt.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (opt.body !== undefined) {
    init.method = opt.method || 'POST';
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(opt.body);
  }
  return fetch(path, init).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.status === 401 && !opt.pub) onUnauthed();
      return { ok: r.ok, status: r.status, json: j || {} };
    });
  }, function () { return { ok: false, status: 0, json: {} }; });
}
function errText(r, fallback) {
  var j = r && r.json || {};
  return j.error || j.detail || j.message || (r && r.status === 0 ? 'Can’t reach Loom' : fallback) || 'Something went wrong';
}
function onUnauthed() {
  if (!S.me && !shellUp) return;
  S.me = null;
  stopAll();
  showPairing();
}

// ---- polling ---------------------------------------------------------------------
var pollers = [];
function poll(fn, ms) {
  var t = 0, dead = false;
  function tick() { if (dead) return; if (!document.hidden) fn(); }
  function onVis() { if (!document.hidden) tick(); }
  document.addEventListener('visibilitychange', onVis);
  t = setInterval(tick, ms);
  tick();
  var p = { stop: function () { dead = true; clearInterval(t); document.removeEventListener('visibilitychange', onVis); } };
  pollers.push(p);
  return p;
}
function stopAll() { pollers.forEach(function (p) { p.stop(); }); pollers = []; if (curScreen && curScreen.stop) curScreen.stop(); curScreen = null; }

// ---- toast and sheet -------------------------------------------------------------
var toastEl = null, toastTimer = 0;
function toast(msg, undo) {
  if (toastEl) { toastEl.remove(); toastEl = null; }
  clearTimeout(toastTimer);
  var btn = undo ? h('button', { text: 'Undo', on: { click: function () { hideToast(); undo(); } } }) : null;
  // Top of the screen, so it never covers the composer or the tab bar; a tap anywhere on it dismisses.
  toastEl = h('div', { class: 'toast', role: 'status', on: { click: function (e) { if (!e.target.closest('button')) hideToast(); } } }, h('span', { text: msg }), btn);
  app.appendChild(toastEl);
  toastTimer = setTimeout(hideToast, undo ? 4000 : 2000);
}
function hideToast() { clearTimeout(toastTimer); if (toastEl) { toastEl.remove(); toastEl = null; } }
function openSheet(build, onClose) {
  var ov = h('div', { class: 'overlay' });
  var sheet = h('div', { class: 'sheet', role: 'dialog' });
  ov.appendChild(sheet);
  ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
  function close() { ov.remove(); if (onClose) onClose(); }
  build(sheet, close);
  app.appendChild(ov);
  return close;
}
function confirmSheet(title, body, okLabel, danger) {
  return new Promise(function (res) {
    openSheet(function (sheet, close) {
      sheet.appendChild(h('div', { class: 'ttl', text: title }));
      if (body) sheet.appendChild(h('div', { class: 'muted', text: body }));
      sheet.appendChild(h('div', { class: 'ro' },
        h('button', { class: 'btn big', text: 'Cancel', on: { click: function () { res(false); close(); } } }),
        h('button', { class: danger ? 'btn big dng' : 'btn big pri', text: okLabel, on: { click: function () { res(true); close(); } } })));
    }, function () { res(false); });
  });
}

// ---- stages ----------------------------------------------------------------------
var GLYPH = { discovery: '?', implementation: '+', shipping: '^', thread: '~', blocked: '!' };
var STAGE = { discovery: 'Discovery', implementation: 'Implementing', shipping: 'Launching', thread: 'In a thread', blocked: 'Blocked' };
function stageOf(s) { return GLYPH[s.stage] ? s.stage : 'implementation'; }
function glyphEl(s) { var st = stageOf(s); return h('span', { class: 'glyph st-' + st, title: STAGE[st], text: GLYPH[st] }); }

// ---- shell -----------------------------------------------------------------------
var screenEl = null, tabbarEl = null, curScreen = null, tabBtns = {};
function buildShell() {
  clear(app);
  hideToast();
  screenEl = h('div', { class: 'scr', id: 'screen' });
  tabbarEl = h('nav', { class: 'tabbar', 'aria-label': 'Main' });
  tabBtns = {};
  [['sessions', 'Sessions'], ['outbox', 'Outbox'], ['settings', 'Settings']].forEach(function (t) {
    var badge = h('span', { class: 'badge' });
    badge.style.display = 'none';
    var b = h('button', { class: 'tab', 'aria-label': t[1], on: { click: function () { location.hash = '#' + t[0]; } } }, icon(t[0]), t[1], t[0] === 'settings' ? null : badge);
    tabBtns[t[0]] = { btn: b, badge: badge };
    tabbarEl.appendChild(b);
  });
  app.appendChild(screenEl);
  app.appendChild(tabbarEl);
  shellUp = true;
}
function updateBadges() {
  var n = S.counts.turn || 0, o = S.outboxPending || 0;
  function set(k, v, label) {
    var t = tabBtns[k]; if (!t) return;
    t.badge.textContent = String(v); t.badge.style.display = v > 0 ? '' : 'none';
    t.btn.setAttribute('aria-label', label + (v > 0 ? ', ' + v + (k === 'sessions' ? ' need you' : ' drafts') : ''));
  }
  set('sessions', n, 'Sessions'); set('outbox', o, 'Outbox');
}
function setActiveTab(name) {
  Object.keys(tabBtns).forEach(function (k) { tabBtns[k].btn.classList.toggle('on', k === name); });
  tabbarEl.style.display = name === 'detail' ? 'none' : '';
}

// ---- routing ---------------------------------------------------------------------
function parseHash() {
  var x = (location.hash || '').replace(/^#/, '');
  if (x.indexOf('s=') === 0) { try { return { screen: 'detail', key: decodeURIComponent(x.slice(2)) }; } catch (e) {} }
  if (x === 'outbox') return { screen: 'outbox' };
  // An old #outbox?s=<key> link (the chat's drafts used to be their own screen) opens the chat.
  if (x.indexOf('outbox?s=') === 0) { try { return { screen: 'detail', key: decodeURIComponent(x.slice(9)) }; } catch (e) {} }
  if (x === 'settings') return { screen: 'settings' };
  return { screen: 'sessions' };
}
function route() {
  if (!S.me || !shellUp) return;
  var r = parseHash();
  if (curScreen && curScreen.stop) curScreen.stop();
  hideToast();
  clear(screenEl);
  S.onSessions = null;
  setActiveTab(r.screen === 'detail' ? 'detail' : r.screen);
  if (r.screen === 'detail') { tabBtns.sessions.btn.classList.add('on'); }
  curScreen = SCREENS[r.screen](r) || {};
  if (pendingToast) { toast(pendingToast); pendingToast = ''; }
}

// ---- sessions --------------------------------------------------------------------
// Status sections match the desktop sidebar's (src/grouping.ts); user groups get a neutral heading.
var STATUS = {
  working: { color: 'var(--green)', prefix: 'last:' },
  turn: { color: 'var(--accent)', prefix: 'asked:' },
  waiting: { color: 'var(--warn)', prefix: 'waiting:' },
  saved: { color: 'var(--muted)', prefix: 'last:' },
  recent: { color: 'var(--muted)', prefix: 'last:' }
};
function statusInfo(k) { return STATUS[k] || STATUS.recent; }
function sessionByKey(key) { return S.sessions.filter(function (s) { return s.key === key; })[0] || null; }
function loadSessions() {
  return api('/m/api/sessions').then(function (r) {
    if (r.ok) {
      S.live = true;
      S.raw = r.json;
      if (r.json.version) S.version = r.json.version;
      relayout();
      S.counts = r.json.counts || { working: 0, turn: 0, waiting: 0, saved: 0, recent: 0 };
      S.outboxPending = r.json.outbox_pending || 0;
    } else if (r.status !== 401) S.live = false;
    updateBadges();
    if (S.onSessions) S.onSessions();
  });
}
// ---- groups: optimistic moves, held over polls until the server agrees (grouping.ts) ----
var GH = { chats: {}, order: null };
var HOLD_MS = 15000;
function newestFirst(a, b) { return (toMs(b.last_active_at) || 0) - (toMs(a.last_active_at) || 0) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0); }
// The server's layout (sessionsPayload in api.ts, the desktop's default view): every user group in
// order, empty ones too, then Recent (fresh ungrouped chats), then Stale (older ungrouped ones),
// rebuilt from rows whose group a pending move has changed.
function buildSections(chats, groups) {
  var byG = {}, recent = [], stale = [], out = [];
  groups.forEach(function (g) { byG[g.id] = []; });
  chats.forEach(function (c) {
    var gid = c.group ? c.group.id : 0;
    if (gid && byG[gid]) byG[gid].push(c.row);
    else (c.row.stale ? stale : recent).push(c.row);
  });
  groups.forEach(function (g) { out.push({ key: 'g:' + g.id, name: g.name, kind: 'group', group_id: g.id, sessions: byG[g.id].sort(newestFirst) }); });
  if (recent.length) out.push({ key: 'recent', name: 'Recent', kind: 'list', sessions: recent.sort(newestFirst) });
  if (stale.length) out.push({ key: 'stale', name: 'Stale', kind: 'list', sessions: stale.sort(newestFirst) });
  return out;
}
// Chats closed from the list's swipe, hidden at once until the server drops them (or 15 s pass).
var CLOSING = {};
function relayout() {
  if (!S.raw) return;
  var secs = S.raw.sections || [], groups = (S.raw.groups || []).slice();
  var now = Date.now(), closing = Object.keys(CLOSING).filter(function (k) { if (now > CLOSING[k]) { delete CLOSING[k]; return false; } return true; });
  if (closing.length) secs = secs.map(function (x) { return Object.assign({}, x, { sessions: (x.sessions || []).filter(function (s) { return !CLOSING[s.key]; }) }); });
  if (Object.keys(GH.chats).length || GH.order) {
    var chats = [];
    secs.forEach(function (x) { (x.sessions || []).forEach(function (s) { chats.push({ key: s.key, row: s, group: x.kind === 'group' && x.group_id ? { id: x.group_id } : null }); }); });
    groups = applyGroupHoldsTo(GH, chats, groups, function (c) { return c.key; }, Date.now()).filter(Boolean);
    secs = buildSections(chats, groups);
  }
  S.groups = groups;
  S.sections = secs;
  S.sessions = [].concat.apply([], secs.map(function (x) { return x.sessions || []; }));
}
function redraw() { relayout(); if (S.onSessions) S.onSessions(); }
function groupName(id) { var g = S.groups.filter(function (x) { return x.id === id; })[0]; return g ? g.name : 'group'; }
function moveChat(key, gid, from) {
  gid = gid || 0;
  var name = gid ? groupName(gid) : '';
  GH.chats[key] = { gid: gid, until: Date.now() + HOLD_MS, acked: false };
  redraw();
  api('/m/api/groups/move', { body: { key: key, group_id: gid || null } }).then(function (r) {
    if (r.ok) {
      if (GH.chats[key]) GH.chats[key].acked = true;
      toast(gid ? 'Moved to ' + name : 'Removed from group', from === undefined ? null : function () { moveChat(key, from); });
      loadSessions();
    } else {
      delete GH.chats[key];
      redraw();
      toast(errText(r, 'Could not move that chat'));
    }
  });
}
function reorderGroup(dragId, targetId, after) {
  var ids = S.groups.map(function (g) { return g.id; });
  var next = reorderIds(ids, dragId, targetId, after);
  if (next.join(',') === ids.join(',')) return;
  GH.order = { ids: next, until: Date.now() + HOLD_MS, acked: false };
  redraw();
  api('/m/api/groups/order', { body: { ids: next } }).then(function (r) {
    if (r.ok) { if (GH.order) GH.order.acked = true; loadSessions(); }
    else { GH.order = null; redraw(); toast(errText(r, 'Could not reorder groups')); }
  });
}
function moveSheet(key, cur) {
  var s = sessionByKey(key);
  openSheet(function (sheet, close) {
    sheet.appendChild(h('div', { class: 'ttl', text: 'Move to group' }));
    if (s) sheet.appendChild(h('div', { class: 'muted', text: s.topic || s.name || s.key }));
    var opts = h('div', { class: 'mvlist' });
    function opt(id, label) {
      opts.appendChild(h('button', { class: 'mvopt' + (id === cur ? ' on' : ''), on: { click: function () { close(); if (id !== cur) moveChat(key, id, cur); } } },
        h('span', { text: label }), id === cur ? h('span', { class: 'chk', text: '✓' }) : null));
    }
    S.groups.forEach(function (g) { opt(g.id, g.name); });
    opt(0, 'No group');
    sheet.appendChild(opts);
    if (!S.groups.length) sheet.appendChild(h('div', { class: 'muted', text: 'No groups yet. Make one in the sidebar on your Mac.' }));
    sheet.appendChild(h('div', { class: 'ro' }, h('button', { class: 'btn big', text: 'Cancel', on: { click: close } })));
  });
}
// Collapsed sections, per phone: user groups by id (a rename keeps it), status sections by name.
var COLLAPSE_KEY = 'loom.m.collapsed';
function collapsedMap() { try { var v = JSON.parse(ls(COLLAPSE_KEY) || '{}'); return v && typeof v === 'object' ? v : {}; } catch (e) { return {}; } }
function setCollapsed(k, on) { var m = collapsedMap(); if (on) m[k] = 1; else delete m[k]; ls(COLLAPSE_KEY, JSON.stringify(m)); }
function sessionsScreen() {
  var chipDot = h('span', { class: 'dot' }), chipText = h('span', { text: 'Mac · live' });
  var line = h('p', { text: '' });
  var verEl = h('span', { class: 'ver' });
  var reloadBtn = h('button', { class: 'reloadbtn', 'aria-label': 'Reload app', title: 'Reload app', on: { click: hardReload } }, h('span', { 'aria-hidden': 'true', text: '↻' }), verEl);
  var list = h('div', { class: 'list' });
  var scroller = h('div', { class: 'scroll' }, list);
  screenEl.appendChild(h('div', { class: 'scr' },
    h('header', { class: 'hdr' }, h('div', { class: 'row' }, h('h1', { text: 'Sessions' }), h('span', { class: 'hdrr' }, reloadBtn, h('span', { class: 'chip' }, chipDot, chipText))), line),
    scroller));
  var last = '', deferred = false, justDragged = 0;
  function render() {
    chipDot.className = 'dot' + (S.live ? '' : ' off');
    chipText.textContent = S.live ? 'Mac · live' : 'Mac · offline';
    verEl.textContent = stalePage() ? 'Update' : (S.version || '');
    reloadBtn.classList.toggle('stale', stalePage());
    var c = S.counts;
    line.textContent = '~ ' + (c.working || 0) + ' working · ● ' + (c.turn || 0) + ' your turn · ‖ ' + (c.waiting || 0) + ' waiting';
    if (D) { deferred = true; return; } // never rebuild the list under a finger
    var shut = collapsedMap();
    var sig = JSON.stringify([S.live, shut, S.sections.map(function (x) { return [x.key, x.name, x.sessions.map(function (s) { return [s.key, s.group, s.topic, s.tail, s.stage, ago(s.last_active_at)]; })]; })]);
    if (sig === last) return;
    last = sig;
    var keep = scroller.scrollTop;
    SW = null;
    clear(list);
    var any = false;
    S.sections.forEach(function (g) {
      var items = g.sessions || [];
      if (!items.length && g.kind !== 'group') return;
      if (items.length) any = true;
      var open = !shut[g.key];
      var color = g.key === 'stale' ? 'var(--muted)' : 'var(--text2)';
      var hd = h('h2', { class: 'gh', role: 'button', tabindex: '0', 'aria-expanded': open ? 'true' : 'false', 'data-sec': g.key, style: 'color:' + color, on: { click: function () {
        if (Date.now() - justDragged < 600) return;
        setCollapsed(g.key, open); render();
      } } }, h('span', { class: 'caret', 'aria-hidden': 'true', text: open ? '▾' : '▸' }), h('span', { text: g.name + ' · ' + items.length }));
      var sec = h('section', { class: 'grp' + (g.kind === 'group' ? ' ugrp' : '') + (open ? '' : ' shut'), 'data-gid': g.kind === 'group' ? String(g.group_id) : null }, hd);
      if (open) {
        var card = h('div', { class: 'card' });
        if (!items.length) card.appendChild(h('div', { class: 'gempty', text: 'Empty. Hold a chat and drag it here.' }));
        items.forEach(function (s) {
          var rowEl = h('button', { class: 'srow', 'data-key': s.key, on: { click: function () {
            if (Date.now() - justDragged < 600) return;
            if (SW) { swipeShut(); return; } // a tap with a row swiped open only closes the swipe
            location.hash = '#s=' + encodeURIComponent(s.key);
          } } },
            glyphEl(s),
            h('span', { class: 'sbody' },
              h('span', { class: 'sline' }, h('span', { class: 'stopic', text: s.topic || s.name || s.key }), h('span', { class: 'sage', text: ago(s.last_active_at) })),
              h('span', { class: 'smeta' }, h('span', { class: 'pill', text: s.name || '' }), h('span', { text: s.project || '' })),
              s.tail ? h('span', { class: 'stail' }, h('span', { class: 'pfx', text: statusInfo(s.group).prefix }), ' ' + s.tail) : null));
          // Swipe left on a live chat (one with a pane) shows a Close button behind it.
          card.appendChild(s.pane ? h('div', { class: 'swrap' }, h('button', { class: 'swx', 'aria-label': 'Close chat', tabindex: '-1', on: { click: function () { swipeClose(s); } } }, '✕'), rowEl) : rowEl);
        });
        sec.appendChild(card);
      }
      list.appendChild(sec);
    });
    if (!any) list.appendChild(h('div', { class: 'empty', text: S.live ? 'No live sessions on your Mac right now.' : 'Can’t reach Loom on your Mac. Check that it is running and that Phone access is on.' }));
    scroller.scrollTop = keep;
  }

  // ---- drag and drop (touch). A press held 350 ms without moving lifts a chat row or a group
  // header; any move before that is an ordinary scroll. A lifted chat drops onto a section (a
  // user group moves it in, a status section takes it out of its group); a lifted group drops
  // above or below another group. Lifted and let go without moving: the Move to group sheet.
  // ---- swipe left to close (iOS Mail style). A horizontal move before the long-press fires is a
  // swipe (it cancels the drag); a vertical one is the list scrolling. One row open at a time;
  // a tap elsewhere, a scroll or a swipe back right shuts it.
  var SW = null, SWIPE_W = 76;
  function swipeSet(row, x, animate) { row.style.transition = animate ? 'transform .18s ease-out' : 'none'; row.style.transform = x ? 'translateX(' + x + 'px)' : ''; }
  function swipeShut() { if (SW) { swipeSet(SW.row, 0, true); SW = null; } }
  function swipeClose(s) {
    var nm = s.name || 'chat';
    SW = null;
    CLOSING[s.key] = Date.now() + 15000;
    redraw();
    api('/m/api/close', { body: { key: s.key } }).then(function (x) {
      if (x.ok) { toast('Closed ' + nm); loadSessions(); setTimeout(loadSessions, 1500); return; }
      delete CLOSING[s.key]; redraw();
      if (x.status === 409) { toast('That session isn’t live anymore'); loadSessions(); }
      else if (x.status === 403) toast('That pane isn’t running Claude or Codex');
      else toast(errText(x, 'Could not close the chat'));
    });
  }
  scroller.addEventListener('scroll', function () { if (SW && !D) swipeShut(); }, { passive: true });
  var D = null, HOLD = 350, SLOP = 8;
  function gidOf(el) { var sec = el && el.closest ? el.closest('.grp') : null; return sec ? dropGroupOf(sec.getAttribute('data-gid')) : 0; }
  function unmark() { Array.prototype.forEach.call(list.querySelectorAll('.dropin,.dropbefore,.dropafter'), function (x) { x.classList.remove('dropin', 'dropbefore', 'dropafter'); }); }
  function endDrag() {
    if (!D) return;
    clearTimeout(D.timer);
    if (D.raf) cancelAnimationFrame(D.raf);
    if (D.ghost) D.ghost.remove();
    if (D.dim) D.dim.classList.remove('dsrc');
    unmark();
    ROOT.classList.remove('dragging');
    D = null;
    if (deferred) { deferred = false; render(); }
  }
  function lift() {
    if (!D || !D.src.isConnected) { endDrag(); return; }
    D.lifted = true; D.lx = D.x; D.ly = D.y;
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
    var r = D.src.getBoundingClientRect();
    D.off = D.y - r.top;
    D.ghost = D.src.cloneNode(true);
    D.ghost.className += ' dghost';
    D.ghost.style.width = r.width + 'px';
    D.ghost.style.left = r.left + 'px';
    D.ghost.style.top = r.top + 'px';
    document.body.appendChild(D.ghost);
    D.dim.classList.add('dsrc');
    ROOT.classList.add('dragging');
    D.raf = requestAnimationFrame(autoScroll);
  }
  function autoScroll() {
    if (!D || !D.lifted) return;
    var r = scroller.getBoundingClientRect();
    var v = D.moved ? dndScrollSpeed(r.top, r.bottom, D.y) : 0;
    if (v) { var before = scroller.scrollTop; scroller.scrollTop += v; if (scroller.scrollTop !== before) hit(); }
    D.raf = requestAnimationFrame(autoScroll);
  }
  function hit() {
    unmark();
    D.target = null;
    var el = document.elementFromPoint(D.x, D.y);
    var sec = el && el.closest ? el.closest('.grp') : null;
    if (!sec || !list.contains(sec)) return;
    var gid = dropGroupOf(sec.getAttribute('data-gid'));
    if (D.kind === 'chat') {
      if (gid === D.gid) return;
      D.target = { gid: gid };
      sec.classList.add('dropin');
    } else {
      if (!gid || gid === D.gid) return;
      var r = sec.getBoundingClientRect();
      var after = D.y > r.top + r.height / 2;
      D.target = { gid: gid, after: after };
      sec.classList.add(after ? 'dropafter' : 'dropbefore');
    }
  }
  list.addEventListener('touchstart', function (e) {
    if (D) endDrag();
    if (e.touches.length !== 1) return;
    var t = e.touches[0];
    if (e.target.closest && e.target.closest('.swx')) return; // the Close button takes its own tap
    var row = e.target.closest ? e.target.closest('.srow') : null;
    if (SW && SW.row !== row) swipeShut();
    var hd = !row && e.target.closest ? e.target.closest('.gh') : null;
    if (row) D = { kind: 'chat', key: row.getAttribute('data-key'), gid: gidOf(row), src: row, dim: row };
    else if (hd && dropGroupOf(hd.parentNode.getAttribute('data-gid'))) D = { kind: 'group', gid: dropGroupOf(hd.parentNode.getAttribute('data-gid')), src: hd, dim: hd.parentNode };
    else return;
    D.sx = D.x = t.clientX; D.sy = D.y = t.clientY;
    D.timer = setTimeout(lift, HOLD);
  }, { passive: true });
  list.addEventListener('touchmove', function (e) {
    if (!D) return;
    var t = e.touches[0];
    D.x = t.clientX; D.y = t.clientY;
    if (!D.lifted) {
      var dx = D.x - D.sx, dy = D.y - D.sy;
      // Lock the axis on the first move past SLOP: sideways on a swipeable row is a swipe.
      if (!D.axis && (Math.abs(dx) > SLOP || Math.abs(dy) > SLOP)) D.axis = D.kind === 'chat' && D.src.parentNode.classList.contains('swrap') && Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
      if (D.axis === 'x') {
        clearTimeout(D.timer);
        e.preventDefault();
        var base = SW && SW.row === D.src ? -SWIPE_W : 0;
        D.tx = Math.max(-SWIPE_W - 24, Math.min(0, base + dx));
        swipeSet(D.src, D.tx, false);
        return;
      }
      if (D.axis) endDrag();
      return;
    }
    e.preventDefault();
    if (!D.moved && (Math.abs(D.x - D.lx) > SLOP || Math.abs(D.y - D.ly) > SLOP)) D.moved = true;
    D.ghost.style.top = (D.y - D.off) + 'px';
    hit();
  }, { passive: false });
  list.addEventListener('touchend', function (e) {
    if (!D) return;
    if (D.axis === 'x') {
      e.preventDefault();
      justDragged = Date.now();
      var sw = D;
      endDrag();
      if (sw.tx < -SWIPE_W / 2) { swipeSet(sw.src, -SWIPE_W, true); SW = { row: sw.src }; }
      else { swipeSet(sw.src, 0, true); if (SW && SW.row === sw.src) SW = null; }
      return;
    }
    if (!D.lifted) { endDrag(); return; }
    e.preventDefault();
    justDragged = Date.now();
    var d = D;
    endDrag();
    if (d.kind === 'chat') {
      if (!d.moved) moveSheet(d.key, d.gid);
      else if (d.target) moveChat(d.key, d.target.gid, d.gid);
    } else if (d.moved && d.target) reorderGroup(d.gid, d.target.gid, d.target.after);
  }, { passive: false });
  list.addEventListener('touchcancel', function () { if (D && D.axis === 'x') { swipeSet(D.src, SW && SW.row === D.src ? -SWIPE_W : 0, true); } if (D && D.lifted) justDragged = Date.now(); endDrag(); });
  list.addEventListener('contextmenu', function (e) { if (D) e.preventDefault(); });

  S.onSessions = render;
  render();
  return { stop: function () { endDrag(); S.onSessions = null; } };
}

// ---- session detail --------------------------------------------------------------
var drafts = {};
function detailScreen(r) {
  var key = r.key, sess = sessionByKey(key) || { key: key, name: '', topic: '', project: '', stage: 'implementation', group: 'working', drafts: 0 };
  var moreBtn = h('button', { class: 'iconbtn more', 'aria-label': 'More', 'aria-haspopup': 'dialog', text: '⋯' });
  // Conversation mode (src/mobile/voiceapp.ts): this tap also unlocks audio playback on iOS.
  var talkBtn = h('button', { class: 'iconbtn talkbtn', 'aria-label': 'Talk (conversation mode)', title: 'Talk' }, icon('talk'));
  var title = h('div', { class: 'a' }), sub = h('div', { class: 'b' }), chip = h('span', { class: 'stagechip' });
  var status = h('span'), pane = h('span', { class: 'mono' });
  var msgsEl = h('div', { class: 'msgs' }), optEl = h('div', { class: 'optmsgs' }), liveEl = h('div', { class: 'mlive', 'aria-live': 'polite' });
  var earlierEl = h('button', { class: 'm-earlier', style: 'display:none' });
  var emptyEl = h('div', { class: 'empty', text: 'No messages yet.', style: 'display:none' });
  var pillEl = h('button', { class: 'newpill', style: 'display:none', text: '↓ New messages' });
  var scroller = h('div', { class: 'scroll' }, h('div', { class: 'msgs-top' }, earlierEl), msgsEl, emptyEl, optEl, liveEl, h('div', { class: 'pillwrap' }, pillEl));
  var ta = h('textarea', { class: 'tinput', rows: '1', placeholder: 'Reply', enterkeyhint: 'send', 'aria-label': 'Reply' });
  var sendBtn = h('button', { class: 'sendbtn', 'aria-label': 'Send reply' }, icon('send'));
  var stopBtn = h('button', { class: 'stopbtn', 'aria-label': 'Interrupt (sends Esc)', title: 'Interrupt (Esc)' }, icon('stop'));
  var quick = h('div', { class: 'quick' });
  var attachBtn = h('button', { class: 'attachbtn', 'aria-label': 'Attach photos', title: 'Attach photos' }, icon('image'));
  var fileIn = h('input', { type: 'file', accept: 'image/*', multiple: 'multiple', class: 'filein', 'aria-hidden': 'true', tabindex: '-1' });
  var thumbs = h('div', { class: 'thumbs' });
  var composer = h('div', { class: 'composer' }, quick, thumbs, h('div', { class: 'crow' }, stopBtn, h('div', { class: 'tbox' }, attachBtn, ta), sendBtn, fileIn));
  var pending = [];
  var canReply = true, lastSig = '', busy = false, alive = true;
  // The live row: while the chat works (or for a minute after a reply, before the board catches
  // up) the server sends Claude Code's spinner line, and this screen polls every 1.5 s, else 3 s.
  var sentAt = 0, liveOn = false, lastLoad = 0, lastTool = '', openThinking = {};
  // Replies sent from here, shown at once as dimmed bubbles until the transcript has them (or 20 s).
  // base: how many user messages the transcript had at send time, so an older identical line can't match.
  var sentQ = [], lastMsgs = [];
  // Scrolling (rules in src/mobile/scrollfollow.ts): follow the bottom only until the reader scrolls
  // away; never move scrollTop while a finger is down or the list is still coasting; a poll only
  // rebuilds the messages that changed. A repaint that arrives mid-scroll waits for the list to go idle.
  var follow = true, touching = false, lastScrollAt = 0, wantTop = null, idleTimer = 0, pendingMsgs = null;
  var rendered = [], renderedStart = 0, painted = false;
  // History paging: a poll returns the last 100 messages (histStart = the first one's index in the
  // whole chat). Once the reader scrolls up or loads earlier, fromIdx pins the window's start, and
  // every poll asks for everything from there, so older pages stay put while new messages arrive.
  var histStart = 0, fromIdx = null, paging = false;
  function busyNow() { return scrollBusy(touching, lastScrollAt, Date.now()); }
  function setTop(v) { wantTop = Math.max(0, Math.min(v, scroller.scrollHeight - scroller.clientHeight)); scroller.scrollTop = wantTop; }
  function toBottom() { setTop(scroller.scrollHeight); }
  function toBottomIfFollowing() { if (!follow) return; if (busyNow()) scheduleIdle(); else toBottom(); }
  function scheduleIdle() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(function () {
      if (!alive) return;
      if (busyNow()) { scheduleIdle(); return; }
      if (pendingMsgs) { var m = pendingMsgs; pendingMsgs = null; paintMsgs(m); }
      else if (follow) toBottom();
    }, FOLLOW_IDLE_MS + 30);
  }
  function showPill(on) { pillEl.style.display = on ? '' : 'none'; }
  pillEl.addEventListener('click', function () { follow = true; showPill(false); toBottom(); });
  function loadEarlier() {
    if (paging || histStart <= 0) return;
    paging = true;
    fromIdx = Math.max(0, histStart - 100);
    paintEarlier();
    load().then(function () { paging = false; paintEarlier(); }, function () { paging = false; paintEarlier(); });
  }
  earlierEl.addEventListener('click', loadEarlier);
  function paintEarlier() {
    earlierEl.style.display = histStart > 0 ? '' : 'none';
    earlierEl.textContent = paging ? 'Loading…' : 'Load earlier messages';
  }
  scroller.addEventListener('scroll', function () {
    lastScrollAt = Date.now();
    if (ownScroll(wantTop, scroller.scrollTop)) { wantTop = null; return; }
    wantTop = null;
    follow = followAfterScroll(scroller.scrollHeight, scroller.scrollTop, scroller.clientHeight);
    if (follow) showPill(false);
    else if (fromIdx === null) fromIdx = histStart; // reading back: the window stops sliding under the reader
    if (scroller.scrollTop < 80 && histStart > 0) loadEarlier();
    scheduleIdle();
  }, { passive: true });
  scroller.addEventListener('touchstart', function () { touching = true; }, { passive: true });
  function touchEnd() { touching = false; lastScrollAt = Date.now(); scheduleIdle(); }
  scroller.addEventListener('touchend', touchEnd, { passive: true });
  scroller.addEventListener('touchcancel', touchEnd, { passive: true });

  ta.value = drafts[key] || '';
  function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; }
  ta.addEventListener('input', function () { drafts[key] = ta.value; grow(); });

  // Photos: downscaled in the browser (2048 px long edge, JPEG), uploaded as soon as they are picked,
  // and sent with the reply as ids. A gif goes up as it is.
  function shrink(file) {
    if (file.type === 'image/gif' || !window.createImageBitmap) return Promise.resolve(file);
    return createImageBitmap(file).then(function (bm) {
      var k = Math.min(1, 2048 / Math.max(bm.width, bm.height));
      if (k === 1 && file.type === 'image/jpeg' && file.size < 1500000) { if (bm.close) bm.close(); return file; }
      var cv = document.createElement('canvas');
      cv.width = Math.round(bm.width * k); cv.height = Math.round(bm.height * k);
      cv.getContext('2d').drawImage(bm, 0, 0, cv.width, cv.height);
      if (bm.close) bm.close();
      return new Promise(function (res) { cv.toBlob(function (b) { res(b || file); }, 'image/jpeg', 0.85); });
    }).catch(function () { return file; });
  }
  function paintThumbs() {
    clear(thumbs);
    pending.forEach(function (p) {
      var rm = h('button', { class: 'thumbx', 'aria-label': 'Remove photo', on: { click: function () {
        pending = pending.filter(function (q) { return q !== p; }); URL.revokeObjectURL(p.url); paintThumbs();
      } } }, '×');
      thumbs.appendChild(h('div', { class: 'thumb' + (p.err ? ' bad' : p.id ? '' : ' up') }, h('img', { src: p.url, alt: '' }), rm));
    });
  }
  function addFiles(files) {
    Array.prototype.forEach.call(files || [], function (f) {
      if (!/^image\//.test(f.type) || pending.length >= 10) return;
      var p = { url: URL.createObjectURL(f), id: '', err: false };
      pending.push(p); paintThumbs();
      shrink(f).then(function (blob) {
        return fetch('/m/api/image', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': blob.type || 'application/octet-stream' }, body: blob });
      }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, json: j }; }); })
        .catch(function () { return { ok: false, json: {} }; })
        .then(function (x) {
          if (x.ok && x.json.id) p.id = x.json.id; else { p.err = true; toast(errText({ json: x.json }, 'Could not upload photo')); }
          paintThumbs();
        });
    });
  }
  attachBtn.addEventListener('click', function () { fileIn.click(); });
  fileIn.addEventListener('change', function () { addFiles(fileIn.files); fileIn.value = ''; });
  ta.addEventListener('paste', function (e) {
    var fs = e.clipboardData && e.clipboardData.files;
    if (fs && fs.length) { e.preventDefault(); addFiles(fs); }
  });

  function paintHead() {
    title.textContent = sess.topic || sess.name || 'Session';
    sub.textContent = '';
    sub.appendChild(h('span', { class: 'mono', text: sess.name || '' }));
    sub.appendChild(document.createTextNode(' · ' + (sess.project || '')));
    var st = stageOf(sess);
    chip.className = 'stagechip st-' + st;
    chip.textContent = '';
    chip.appendChild(h('span', { class: 'mono', text: GLYPH[st] }));
    chip.appendChild(document.createTextNode(' ' + STAGE[st]));
    var age = ago(sess.last_active_at);
    var g = sess.group, at = age ? ' · ' + age : '';
    status.textContent = g === 'working' ? '~ working' : g === 'waiting' ? '‖ waiting on others' + at : g === 'turn' ? '● your turn' + at : g === 'saved' ? '○ saved for later' + at : '○ idle' + at;
    status.style.color = statusInfo(g).color;
    status.style.fontWeight = '600';
    pane.textContent = sess.pane || '';
    ta.placeholder = 'Reply to ' + (sess.name || 'session');
  }
  function paintQuick() {
    clear(quick);
    ['Yes, go ahead', 'Keep going', 'What’s left?'].forEach(function (q) {
      quick.appendChild(h('button', { class: 'qbtn', text: q, disabled: !canReply, on: { click: function () { send(q); } } }));
    });
  }
  function msgKey(m) { return m.role + '\u0001' + (m.src ? m.src.kind + ':' + m.src.label : '') + '\u0001' + m.text; }
  function msgEl(m) {
    if (m.role === 'user' && m.src) return h('div', { class: 'm-agent k-' + m.src.kind }, h('div', { class: 'm-from', text: m.src.kind === 'agent' ? 'from ' + m.src.label : m.src.label }), linked(m.text));
    if (m.role === 'user') return h('div', { class: 'm-user' }, linked(m.text));
    if (m.role === 'thinking') return thinkingRow(m.text);
    if (m.role === 'event') return h('div', { class: 'm-event', role: 'separator' }, h('span', { text: m.text }));
    if (m.role === 'tool') return h('div', { class: 'm-tool' }, h('span', { 'aria-hidden': 'true', text: '▸' }), h('span', { text: m.text }));
    return h('div', { class: 'm-asst' }, linked(m.text));
  }
  function paintMsgs(msgs) {
    var keys = msgs.map(msgKey);
    lastTool = '';
    for (var i = msgs.length - 1; i >= 0 && msgs[i].role !== 'user'; i--) if (msgs[i].role === 'tool') { lastTool = msgs[i].text; break; }
    // Already the transcript's last line: the live row doesn't repeat it.
    if (msgs.length && msgs[msgs.length - 1].role === 'tool') lastTool = '';
    paintEarlier();
    if (painted && histStart === renderedStart && firstChange(rendered, keys) < 0) { pendingMsgs = null; return; }
    if (painted && busyNow()) { pendingMsgs = msgs; scheduleIdle(); return; }
    pendingMsgs = null;
    var first = !painted, top0 = scroller.scrollTop;
    // Older messages put above (Load earlier), the window slid (a full rebuild), or the same start.
    var shift = painted && histStart <= renderedStart ? renderedStart - histStart : -1;
    var appended = false;
    if (shift < 0) {
      clear(msgsEl);
      msgs.forEach(function (m) { msgsEl.appendChild(msgEl(m)); });
    } else {
      var tailKeys = keys.slice(shift), fc = firstChange(rendered, tailKeys);
      if (fc >= 0) {
        while (msgsEl.children.length > fc) msgsEl.removeChild(msgsEl.lastChild);
        for (var j = fc; j < tailKeys.length; j++) msgsEl.appendChild(msgEl(msgs[shift + j]));
        appended = tailKeys.length > rendered.length || fc < rendered.length;
      }
      if (shift > 0) {
        var h0 = scroller.scrollHeight, frag = document.createDocumentFragment();
        for (var k = 0; k < shift; k++) frag.appendChild(msgEl(msgs[k]));
        msgsEl.insertBefore(frag, msgsEl.firstChild);
        var grew = scroller.scrollHeight - h0;
      }
    }
    rendered = keys; renderedStart = histStart; painted = true;
    emptyEl.style.display = msgs.length ? 'none' : '';
    var act = afterPaint(first, follow, shift > 0);
    if (act === 'anchor') setTop(top0 + grew);
    else if (act === 'bottom') toBottom();
    else if (appended) showPill(true);
  }
  // A thinking block: one muted line, tap to read it all. Open ones stay open across repaints.
  function thinkingRow(text) {
    var short = text.replace(/\s+/g, ' ');
    if (short.length > 80) short = short.slice(0, 80) + '…';
    var row = h('button', { class: 'm-think' + (openThinking[text] ? ' open' : ''), 'aria-expanded': openThinking[text] ? 'true' : 'false' });
    function fill() { row.textContent = openThinking[text] ? 'Thinking: ' + text : 'Thinking: ' + short; }
    row.addEventListener('click', function () { openThinking[text] = !openThinking[text]; row.classList.toggle('open', !!openThinking[text]); row.setAttribute('aria-expanded', openThinking[text] ? 'true' : 'false'); fill(); });
    fill();
    return row;
  }
  function flatText(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }
  function usersOf(msgs) { return msgs.filter(function (m) { return m.role === 'user'; }).map(function (m) { return flatText(m.text); }); }
  // Photo paths (or Claude Code's [Image #n]) are prefixed to the typed text, so the typed part ends it.
  function sameReply(u, t) { return t ? u === t || (u.length > t.length && u.slice(-t.length) === t && u.charAt(u.length - t.length - 1) === ' ') : true; }
  function dropSent(q) { q.urls.forEach(function (u) { URL.revokeObjectURL(u); }); }
  function reconcile(msgs) {
    var users = usersOf(msgs), now = Date.now();
    sentQ = sentQ.filter(function (q) {
      var fresh = users.length > q.base ? users.slice(q.base) : users.slice(-3);
      var done = now - q.at > 20000 || (q.sent && fresh.some(function (u) { return sameReply(u, q.text); }));
      if (done) dropSent(q);
      return !done;
    });
  }
  function paintOpt() {
    clear(optEl);
    optEl.style.display = sentQ.length ? '' : 'none';
    sentQ.forEach(function (q) {
      var b = h('div', { class: 'm-user sending', 'aria-label': 'Sending' });
      if (q.urls.length) b.appendChild(h('div', { class: 'optthumbs' }, q.urls.map(function (u) { return h('img', { src: u, alt: '' }); })));
      if (q.shown) b.appendChild(h('div', { text: q.shown }));
      optEl.appendChild(b);
    });
    toBottomIfFollowing();
  }
  function paintLive(ls) {
    var on = !!(ls && ls.text) || sess.group === 'working';
    liveOn = on || Date.now() - sentAt < 60000;
    clear(liveEl);
    liveEl.style.display = on ? '' : 'none';
    if (!on) return;
    liveEl.appendChild(h('div', { class: 'mlive-a' }, h('span', { class: 'mlive-dot', 'aria-hidden': 'true' }), h('span', { text: ls && ls.text ? ls.text : 'Working…' })));
    if (lastTool) liveEl.appendChild(h('div', { class: 'mlive-b' }, h('span', { 'aria-hidden': 'true', text: '▸' }), h('span', { text: lastTool })));
    toBottomIfFollowing();
  }
  function paintEnabled() {
    talkBtn.disabled = !canReply; ta.disabled = !canReply; attachBtn.disabled = !canReply; sendBtn.disabled = !canReply; stopBtn.disabled = !canReply;
    if (!canReply) ta.placeholder = 'This session isn’t live on your Mac';
    paintQuick();
  }
  function load() {
    lastLoad = Date.now();
    var live = (Date.now() - sentAt < 60000 ? '&live=1' : '') + (fromIdx !== null ? '&from=' + fromIdx : '');
    return api('/m/api/session?key=' + encodeURIComponent(key) + live).then(function (x) {
      if (!alive) return;
      if (x.status === 404) { toast0('That session has ended'); location.hash = '#sessions'; return; }
      if (!x.ok) return;
      if (x.json.session) sess = x.json.session;
      canReply = x.json.can_reply !== false;
      lastMsgs = x.json.messages || [];
      histStart = typeof x.json.start === 'number' ? x.json.start : 0;
      reconcile(lastMsgs);
      // A reply still in flight means the agent is (about to be) busy, whatever the board says yet.
      if (sentQ.some(function (q) { return q.sent; }) && sess.group !== 'working') sess = Object.assign({}, sess, { group: 'working', tail: '' });
      paintHead(); paintEnabled(); paintMsgs(lastMsgs); paintOpt(); paintLive(x.json.live_status);
      if (Array.isArray(x.json.drafts)) takeDrafts(x.json.drafts);
    });
  }
  function send(text) {
    var own = text == null;
    text = String(own ? ta.value : text).trim();
    var ready = own ? pending.filter(function (p) { return p.id; }) : [];
    if ((!text && !ready.length) || busy || !canReply) return;
    if (own && pending.some(function (p) { return !p.id && !p.err; })) { toast('Photos are still uploading'); return; }
    busy = true; sendBtn.disabled = true;
    var payload = { key: key, text: text };
    if (ready.length) payload.images = ready.map(function (p) { return p.id; });
    var q = { text: flatText(text), shown: text, urls: ready.map(function (p) { return p.url; }), at: Date.now(), base: usersOf(lastMsgs).length, sent: false };
    sentQ.push(q); follow = true; showPill(false); paintOpt();
    api('/m/api/reply', { body: payload }).then(function (x) {
      busy = false; sendBtn.disabled = !canReply;
      if (x.ok) {
        ta.value = ''; drafts[key] = ''; grow();
        if (own) { pending.forEach(function (p) { if (q.urls.indexOf(p.url) < 0) URL.revokeObjectURL(p.url); }); pending = []; paintThumbs(); }
        q.sent = true; q.at = Date.now();
        follow = true; showPill(false); sentAt = Date.now(); liveOn = true;
        sess = Object.assign({}, sess, { group: 'working', tail: '' });
        paintHead(); paintLive(null);
        toast('Sent to ' + (sess.name || 'session'));
        setTimeout(load, 700);
        return;
      }
      sentQ = sentQ.filter(function (o) { return o !== q; }); paintOpt();
      if (x.status === 409) { toast('That session isn’t live anymore'); load(); }
      else if (x.status === 403) toast('That pane isn’t running Claude');
      else toast(errText(x, 'Could not send'));
    });
  }
  sendBtn.addEventListener('click', function () { send(); });
  stopBtn.addEventListener('click', function () {
    api('/m/api/interrupt', { body: { key: key } }).then(function (x) {
      if (x.ok) { toast('Esc sent to ' + (sess.name || 'session')); setTimeout(load, 700); }
      else if (x.status === 409) toast('That session isn’t live anymore');
      else if (x.status === 403) toast('That pane isn’t running Claude');
      else toast(errText(x, 'Could not interrupt'));
    });
  });

  // Close chat: the desktop's Close (Ctrl-C twice, /quit for Codex). The session stays resumable from the Mac.
  function closeChat() {
    var nm = sess.name || 'this chat';
    confirmSheet('Close ' + nm + '?', 'The session stays resumable from the Mac.', 'Close chat', true).then(function (ok) {
      if (!ok) return;
      api('/m/api/close', { body: { key: key } }).then(function (x) {
        if (x.ok) { toast0('Closed ' + nm); location.hash = '#sessions'; loadSessions(); setTimeout(loadSessions, 1500); }
        else if (x.status === 409) { toast('That session isn’t live anymore'); load(); }
        else if (x.status === 403) toast('That pane isn’t running Claude or Codex');
        else toast(errText(x, 'Could not close the chat'));
      });
    });
  }
  moreBtn.addEventListener('click', function () {
    openSheet(function (sheet, close) {
      sheet.appendChild(h('div', { class: 'ttl', text: sess.topic || sess.name || 'Session' }));
      sheet.appendChild(h('button', { class: 'btn big dng', style: 'flex:none', text: 'Close chat', on: { click: function () { close(); closeChat(); } } }));
      sheet.appendChild(h('button', { class: 'btn big', style: 'flex:none', text: 'Cancel', on: { click: close } }));
    });
  });

  // This chat's drafts, docked between the transcript and the composer. Collapsed or open is
  // remembered per chat; a draft this phone hasn't seen before opens it again.
  var kit = draftKit({ mini: true, render: paintDock, reload: load });
  var dockBar = h('button', { class: 'dockbar', on: { click: function () { mem.open = !mem.open; saveMem(); paintDock(); } } });
  var dockList = h('div', { class: 'docklist' });
  var dock = h('div', { class: 'dock' }, dockBar, dockList);
  dock.style.display = 'none';
  var memKey = 'loom.dock.' + key, mem = null, dockSig = '';
  try { mem = JSON.parse(ls(memKey) || 'null'); } catch (e) {}
  if (!mem || typeof mem !== 'object' || !Array.isArray(mem.seen)) mem = { open: true, seen: [] };
  function saveMem() { ls(memKey, JSON.stringify(mem)); }
  function takeDrafts(list) {
    var ids = list.map(function (d) { return d.id; });
    var fresh = ids.some(function (id) { return mem.seen.indexOf(id) < 0; });
    if (fresh) mem.open = true;
    if (fresh || ids.length !== mem.seen.length) { mem.seen = ids; if (ids.length) saveMem(); else ls(memKey, null); }
    if (kit.take(list)) paintDock();
  }
  function paintDock() {
    if (!alive) return;
    var vis = kit.visible(), n = vis.length;
    var sig = JSON.stringify([vis, mem.open, kit.open, kit.editing]);
    if (sig === dockSig) return;
    dockSig = sig;
    dock.style.display = n ? '' : 'none';
    clear(dockBar);
    dockBar.appendChild(h('span', { text: n + (n === 1 ? ' draft' : ' drafts') + ' from this chat' }));
    dockBar.appendChild(h('span', { class: 'chev', 'aria-hidden': 'true', text: mem.open ? '▴' : '▾' }));
    dockBar.setAttribute('aria-expanded', mem.open ? 'true' : 'false');
    var keep = dockList.scrollTop;
    clear(dockList);
    dockList.style.display = mem.open && n ? '' : 'none';
    if (mem.open) vis.forEach(function (d) { dockList.appendChild(kit.card(d)); });
    dockList.scrollTop = keep;
  }

  screenEl.appendChild(h('div', { class: 'scr' },
    h('header', { class: 'dhdr' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back to sessions', on: { click: function () { location.hash = '#sessions'; } } }, icon('back')),
      h('div', { class: 'dtitle' }, title, sub), chip, talkBtn, moreBtn),
    h('div', { class: 'band' }, status, pane),
    scroller, dock, composer));
  talkBtn.addEventListener('click', function () {
    if (!canReply) { toast('This session isn’t live on your Mac'); return; }
    if (!window.LoomTalk) { toast('Conversation mode didn’t load'); return; }
    window.LoomTalk.open({ key: key, name: sess.name || sess.topic || 'session', onClose: function () { if (alive) load(); } });
  });
  paintHead(); paintEnabled(); grow();
  var p = poll(function () { if (liveOn || Date.now() - lastLoad >= 2900) load(); }, 1500);
  return { stop: function () { alive = false; p.stop(); sentQ.forEach(dropSent); sentQ = []; kit.stop(); if (window.LoomTalk) window.LoomTalk.close(); } };
}

// ---- drafts: the card and its sheets, shared by the Outbox tab and a chat's dock -------
var KIND = { thread: 'Thread', dm: 'DM', channel: 'Channel', email: 'Email', review: 'PR review' };
// Edits and undo-able discards are per draft, not per screen: an edit started in the chat shows in the Outbox too.
var DEDITS = {}, DHIDDEN = {};
// o.render(): repaint the host. o.reload(): fetch the drafts again. o.mini: the chat's dock (no "from", clamped text).
function draftKit(o) {
  var k = { drafts: [], done: [], editing: null, sheet: false, open: {} };
  k.msgsOf = function (d) { return DEDITS[d.id] || d.messages || []; };
  k.visible = function () { return k.drafts.filter(function (d) { return !DHIDDEN[d.id]; }); };
  k.busy = function () { return !!(k.editing || k.sheet); };
  // A poll's list. While a card is being edited or its sheet is up, the cards stay put: gone ones drop,
  // new ones queue at the end, and nothing repaints. Returns whether the host should repaint.
  k.take = function (next) {
    if (k.busy()) {
      k.drafts = next.length ? k.drafts.filter(function (x) { return next.some(function (n) { return n.id === x.id; }); }).concat(next.filter(function (n) { return !k.drafts.some(function (x) { return x.id === n.id; }); })) : [];
      return false;
    }
    k.drafts = next;
    return true;
  };
  k.stop = function () { k.editing = null; k.sheet = false; };
  function verbOf(d) { return d.kind === 'email' ? 'Send' : 'Post'; }
  function openLink(d) { return d.url ? h('a', { class: 'openlnk', href: d.url, target: '_blank', rel: 'noopener noreferrer', text: d.kind === 'review' ? 'Open PR' : 'Open in Slack' }) : null; }
  k.card = function (d) {
    var editing = k.editing === d.id;
    var msgs = k.msgsOf(d);
    var body;
    if (editing) {
      body = msgs.map(function (m, i) {
        var t = h('textarea', { rows: o.mini ? '4' : '5' }); t.value = m;
        t.addEventListener('input', function () { var a = k.msgsOf(d).slice(); a[i] = t.value; DEDITS[d.id] = a; });
        return h('label', { class: 'edit' }, msgs.length > 1 ? 'Message ' + (i + 1) + ' of ' + msgs.length : 'Edit before sending', t);
      });
    } else if (o.mini) {
      var full = !!k.open[d.id];
      body = msgs.map(function (m) {
        return h('p', { class: 'dtext' + (full ? '' : ' clamp'), on: { click: function (e) { if (e.target.closest('a')) return; k.open[d.id] = !full; o.render(); } } }, linked(m));
      });
    } else body = msgs.map(function (m) { return h('p', { class: 'dtext' }, linked(m)); });
    var stale = d.stale ? h('div', { class: 'warnband' }, icon('warn'), h('span', { text: d.stale_note || 'There is new activity since this was drafted.' })) : null;
    var top = h('div', { class: 'top' }, h('div', { class: 'l' }, h('span', { class: 'kind', text: KIND[d.kind] || d.kind || 'Draft' }), h('span', { class: 'where', text: d.where || '' })), h('span', { class: 'sage', text: ago(d.created_at) }));
    var ctx = o.mini ? null : h('div', { class: 'ctx' }, (d.ctx || '') + (d.from ? ' · from ' : ''), d.from ? h('span', { class: 'mono', text: d.from }) : null, openLink(d));
    return h('article', { class: 'draft' + (o.mini ? ' mini' : '') }, top, ctx, stale, body,
      h('div', { class: 'actions' },
        o.mini ? openLink(d) : null,
        h('button', { class: 'btn ghost', text: 'Discard', on: { click: function () { k.discard(d); } } }),
        h('button', { class: 'btn', text: editing ? 'Done' : 'Edit', on: { click: function () { k.editing = editing ? null : d.id; o.render(); } } }),
        h('button', { class: 'btn pri', text: d.stale ? 'Review' : verbOf(d), on: { click: function () { k.review(d); } } })));
  };
  k.discard = function (d) {
    DHIDDEN[d.id] = true; if (k.editing === d.id) k.editing = null;
    o.render();
    var timer = setTimeout(function () {
      api('/m/api/outbox/discard', { body: { id: d.id } }).then(function (x) {
        if (!x.ok && x.status !== 404) { delete DHIDDEN[d.id]; toast(errText(x, 'Could not discard')); }
        o.reload();
      });
    }, 4000);
    toast('Draft discarded', function () { clearTimeout(timer); delete DHIDDEN[d.id]; o.render(); });
  };
  k.review = function (d) {
    k.sheet = true; k.editing = null;
    var after = 'none';
    var text = k.msgsOf(d).join('\n\n');
    var first = (d.new_messages && d.new_messages[0] && d.new_messages[0].who) || 'Someone';
    var verb = verbOf(d);
    function gone() { k.drafts = k.drafts.filter(function (z) { return z.id !== d.id; }); }
    openSheet(function (sheet, close) {
      sheet.appendChild(h('div', { class: 'ttl', text: d.stale ? first + ' replied after this was drafted' : verb + ' to ' + (d.where || 'destination') + ' as you?' }));
      if (d.stale) {
        var nm = h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('div', { class: 'wl', text: 'New since this was drafted' }));
        (d.new_messages || []).forEach(function (n) { nm.appendChild(h('div', { class: 'newm' }, h('b', { text: n.who || '' }), ' ' + (n.text || ''))); });
        if (!(d.new_messages || []).length && d.stale_note) nm.appendChild(h('div', { class: 'newm', text: d.stale_note }));
        sheet.appendChild(nm);
      }
      sheet.appendChild(h('div', { class: 'prev', text: text }));
      if (d.from) {
        var seg = h('div', { class: 'seg' });
        var opts = [['none', 'Keep chat'], ['park', 'Park'], ['close', 'Close']];
        var paint = function () { clear(seg); opts.forEach(function (x) { seg.appendChild(h('button', { text: x[1], 'aria-pressed': after === x[0] ? 'true' : 'false', on: { click: function () { after = x[0]; paint(); } } })); }); };
        paint();
        sheet.appendChild(h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('div', { class: 'muted', style: 'font-size:13px', text: 'Then, for ' + d.from }), seg));
      }
      var row = h('div', { class: 'ro' }, h('button', { class: 'btn big', text: 'Cancel', on: { click: close } }));
      if (d.stale) row.appendChild(h('button', { class: 'btn big', style: 'font-size:16px;font-weight:600', text: 'Ask to redraft', on: { click: function () {
        close();
        api('/m/api/outbox/redraft', { body: { id: d.id } }).then(function (x) {
          if (x.ok) { k.done.push({ text: 'Asked ' + (d.from || 'the chat') + ' to redraft against the new messages', accent: true }); gone(); o.render(); toast('Asked ' + (d.from || 'the chat') + ' to redraft'); }
          else toast(errText(x, 'Could not ask for a redraft'));
          o.reload();
        });
      } } }));
      row.appendChild(h('button', { class: 'btn big pri', text: d.stale ? verb + ' anyway' : verb, on: { click: function () {
        var body = { id: d.id, messages: k.msgsOf(d), after: d.from ? after : 'none' };
        if (d.stale) body.ack_stale = true;
        close();
        api('/m/api/outbox/send', { body: body }).then(function (x) {
          var said = (d.kind === 'email' ? 'Sent to ' : 'Posted to ') + (d.where || 'destination');
          if (x.ok) { k.done.push({ text: said }); gone(); delete DEDITS[d.id]; o.render(); toast(said); }
          else if (x.status === 409) toast(errText(x, 'This changed since it was drafted. Review it again.'));
          else toast(errText(x, 'Could not send'));
          o.reload();
        });
      } } }));
      sheet.appendChild(row);
    }, function () { k.sheet = false; });
  };
  return k;
}

// ---- outbox ----------------------------------------------------------------------
function outboxScreen() {
  var line = h('p', { text: '' });
  var list = h('div', { class: 'list', style: 'gap:12px' });
  var scroller = h('div', { class: 'scroll' }, list);
  screenEl.appendChild(h('div', { class: 'scr' }, h('header', { class: 'hdr' }, h('h1', { text: 'Outbox' }), line), scroller));
  var alive = true, loaded = false;
  var kit = draftKit({ render: render, reload: loadOutbox });
  function render() {
    if (!alive) return;
    var vis = kit.visible();
    line.textContent = vis.length === 0 ? 'Nothing waiting. Drafts land here as sessions write them.' : vis.length + (vis.length === 1 ? ' draft waiting on you.' : ' drafts waiting on you.') + ' Nothing posts until you tap Post.';
    var keep = scroller.scrollTop;
    clear(list);
    vis.forEach(function (d) { list.appendChild(kit.card(d)); });
    kit.done.forEach(function (x) { list.appendChild(h('div', { class: 'done' }, h('span', { class: 'dot' + (x.accent ? ' accent' : '') }), h('span', { style: 'flex:1', text: x.text }))); });
    if (!vis.length && !kit.done.length && loaded) list.appendChild(h('div', { class: 'empty', text: 'No drafts.' }));
    scroller.scrollTop = keep;
  }
  function loadOutbox() {
    if (!alive) return Promise.resolve();
    return api('/m/api/outbox').then(function (x) {
      if (!x.ok || !alive) return;
      var next = x.json.drafts || [];
      loaded = true;
      S.outboxPending = next.length; updateBadges();
      if (kit.take(next)) render();
    });
  }
  render();
  var p = poll(loadOutbox, 5000);
  return { stop: function () { alive = false; p.stop(); kit.stop(); } };
}

// ---- push ------------------------------------------------------------------------
function iosLike() { return /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
function standalone() { return !!(navigator.standalone || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)); }
function pushSupported() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; }
function b64ToBytes(s) {
  var pad = '='.repeat((4 - s.length % 4) % 4);
  var raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  var out = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function registerSw() {
  if (!('serviceWorker' in navigator)) return Promise.reject(new Error('unsupported'));
  return navigator.serviceWorker.register('/m/sw.js', { scope: '/m/' }).then(function () { return navigator.serviceWorker.ready; });
}
// Must run from a tap: Notification.requestPermission() is the first thing it does.
function enablePush() {
  if (!pushSupported()) return Promise.reject(new Error(iosLike() && !standalone() ? 'Add Loom to your Home Screen first' : 'This browser can’t receive notifications'));
  return Notification.requestPermission().then(function (perm) {
    if (perm !== 'granted') throw new Error('Notifications are blocked. Turn them on for Loom in the Settings app.');
    return registerSw();
  }).then(function (reg) {
    return api('/m/api/push/key').then(function (k) {
      if (!k.ok || !k.json.publicKey) throw new Error('Loom has no push key yet');
      return reg.pushManager.getSubscription().then(function (sub) {
        return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.json.publicKey) });
      });
    });
  }).then(function (sub) {
    return api('/m/api/push/subscribe', { body: { subscription: sub.toJSON ? sub.toJSON() : sub } }).then(function (x) {
      if (!x.ok) throw new Error(errText(x, 'Loom refused the subscription'));
    });
  });
}
function pushState() {
  if (!pushSupported()) return Promise.resolve(iosLike() && !standalone() ? 'needs-install' : 'unsupported');
  if (Notification.permission === 'denied') return Promise.resolve('denied');
  if (Notification.permission !== 'granted') return Promise.resolve('off');
  return navigator.serviceWorker.getRegistration('/m/').then(function (reg) {
    return reg ? reg.pushManager.getSubscription() : null;
  }).then(function (sub) { return sub ? 'on' : 'off'; }, function () { return 'off'; });
}
function dropPush() {
  if (!('serviceWorker' in navigator)) return Promise.resolve();
  return navigator.serviceWorker.getRegistration('/m/').then(function (reg) { return reg && reg.pushManager.getSubscription(); }).then(function (sub) { return sub && sub.unsubscribe(); }).catch(function () {});
}

// ---- settings --------------------------------------------------------------------
var DEFAULT_PREFS = { turn: true, blocked: true, drafts: true, watcher: false, away: true, quiet: false };
var TOGGLES = [
  ['turn', 'Your turn', 'A session finishes and is waiting on you'],
  ['blocked', 'Blocked', 'A session flips to blocked or waiting on someone'],
  ['drafts', 'New outbox draft', 'A session drafts a Slack, email or PR reply'],
  ['watcher', 'Watchers', 'A watcher finds something that needs you'],
  ['away', 'Only when I’m away', 'Skip pushes while your Mac is in use'],
  ['quiet', 'Quiet hours', '10 pm to 7 am, nothing but blocked']
];
function prefsNow() { var p = Object.assign({}, DEFAULT_PREFS, (S.me && S.me.prefs) || {}); return p; }
// Reload to the newest app: drop the shell cache, ask the service worker to update (it is not
// unregistered: that would end the push subscription), then reload from the network.
function hardReload() {
  var done = function () { location.reload(); };
  var jobs = [];
  try { if (window.caches) jobs.push(caches.keys().then(function (ks) { return Promise.all(ks.map(function (k) { return caches.delete(k); })); })); } catch (e) {}
  try { if (navigator.serviceWorker) jobs.push(navigator.serviceWorker.getRegistration('/m/').then(function (r) { return r && r.update(); })); } catch (e) {}
  Promise.all(jobs.map(function (j) { return j.catch(function () {}); })).then(done, done);
  setTimeout(done, 2500);
}
// The running Loom's version, and whether this page predates it (Loom updated since it loaded).
function versionLabel() { return S.version ? 'Loom ' + S.version : ''; }
function stalePage() { return !!(S.version && S.bootVersion && S.version !== S.bootVersion); }
function settingsScreen() {
  var alive = true, devices = [], pstate = 'off';
  var body = h('div', { class: 'list', style: 'gap:22px;padding-bottom:24px' });
  screenEl.appendChild(h('div', { class: 'scr' }, h('header', { class: 'hdr' }, h('h1', { text: 'Settings' })), h('div', { class: 'scroll' }, body)));

  function render() {
    if (!alive) return;
    var prefs = prefsNow();
    clear(body);
    // push
    var tcard = h('div', { class: 'card' });
    var pushRow = null;
    if (pstate === 'off') pushRow = ['Notifications are off on this phone', 'Turn them on to get pings from your Mac.', 'Turn on', function () { enablePush().then(function () { toast('Notifications on'); refresh(); }, function (e) { toast(e.message || 'Could not turn on notifications'); }); }];
    else if (pstate === 'needs-install') pushRow = ['Add Loom to your Home Screen', 'iPhone only delivers notifications to the Home Screen app.', null, null];
    else if (pstate === 'denied') pushRow = ['Notifications are blocked', 'Allow them for Loom in the Settings app.', null, null];
    else if (pstate === 'unsupported') pushRow = ['Notifications aren’t available here', 'This browser can’t receive push notifications.', null, null];
    if (pushRow) tcard.appendChild(h('div', { class: 'trow' }, h('div', { class: 'tx' }, h('div', { class: 'a', text: pushRow[0] }), h('div', { class: 'b', text: pushRow[1] })), pushRow[2] ? h('button', { class: 'small neutral', text: pushRow[2], on: { click: pushRow[3] } }) : null));
    TOGGLES.forEach(function (t) {
      var on = !!prefs[t[0]];
      tcard.appendChild(h('div', { class: 'trow' }, h('div', { class: 'tx' }, h('div', { class: 'a', text: t[1] }), h('div', { class: 'b', text: t[2] })),
        h('button', { class: 'sw', role: 'switch', 'aria-checked': on ? 'true' : 'false', 'aria-label': t[1], on: { click: function () {
          var next = Object.assign({}, prefsNow()); next[t[0]] = !on;
          S.me.prefs = next; render();
          api('/m/api/prefs', { method: 'PUT', body: next }).then(function (x) { if (!x.ok) { toast(errText(x, 'Could not save')); } });
        } } }, h('i'))));
    });
    body.appendChild(h('section', { class: 'setgrp' }, h('h2', { text: 'Push notifications' }), tcard));
    // devices
    var dcard = h('div', { class: 'card' });
    devices.forEach(function (d) {
      dcard.appendChild(h('div', { class: 'trow', style: 'padding:12px 14px' },
        h('div', { class: 'tx' }, h('div', { class: 'a' }, d.name || 'Device', d.this ? h('span', { class: 'this', text: 'THIS DEVICE' }) : null), h('div', { class: 'b', text: 'Paired ' + shortDate(d.created_at) + ' · ' + (d.this ? 'active now' : agoWords(d.last_seen_at)) })),
        h('button', { class: 'small', text: d.this ? 'Unpair' : 'Revoke', on: { click: function () {
          confirmSheet(d.this ? 'Unpair this phone?' : 'Revoke ' + (d.name || 'this device') + '?', (d.this ? 'This phone' : (d.name || 'That device')) + ' will no longer reach Loom.', d.this ? 'Unpair' : 'Revoke').then(function (ok) {
            if (!ok) return;
            api('/m/api/devices/revoke', { body: { id: d.id } }).then(function (x) {
              if (!x.ok && x.status !== 401) { toast(errText(x, 'Could not revoke')); return; }
              if (d.this) { dropPush(); S.me = null; stopAll(); showPairing(); return; }
              toast((d.name || 'Device') + ' can no longer reach Loom'); refresh();
            });
          });
        } } })));
    });
    if (!devices.length) dcard.appendChild(h('div', { class: 'empty', text: 'No devices.' }));
    body.appendChild(h('section', { class: 'setgrp' }, h('h2', { text: 'Paired devices' }), dcard, h('p', { class: 'note', text: 'Pair another device from Loom on your Mac: Settings › Devices › Pair a phone.' })));
    // appearance
    var seg = h('div', { class: 'seg' });
    [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].forEach(function (o) {
      seg.appendChild(h('button', { text: o[1], 'aria-pressed': getTheme() === o[0] ? 'true' : 'false', on: { click: function () { ls('loom.theme', o[0] === 'system' ? null : o[0]); applyTheme(o[0]); render(); } } }));
    });
    body.appendChild(h('section', { class: 'setgrp' }, h('h2', { text: 'Appearance' }), seg));
    // connection
    var host = (S.me && S.me.tailnetHost) || location.host;
    body.appendChild(h('section', { class: 'setgrp' }, h('h2', { text: 'Connection' }),
      h('div', { class: 'card conn' }, h('div', {}, h('span', { text: 'Loom on' }), h('span', { class: 'mono', text: host })), h('div', { class: 'muted' }, h('span', { text: 'Via' }), h('span', { text: location.protocol === 'https:' ? 'Tailscale · HTTPS' : 'Local · HTTP' }))),
      h('div', { class: 'note', style: 'display:flex;align-items:center;gap:10px' }, h('button', { class: 'btn link', style: 'padding:0;height:auto;font-size:15px', text: stalePage() ? 'Reload to update' : 'Reload app', on: { click: hardReload } }), h('span', { class: 'muted mono', style: 'font-size:12px', text: versionLabel() }))));
  }
  function refresh() {
    api('/m/api/devices').then(function (x) { if (x.ok) devices = x.json.devices || []; render(); });
    pushState().then(function (s) { pstate = s; render(); });
  }
  render(); refresh();
  return { stop: function () { alive = false; } };
}

// ---- pairing ---------------------------------------------------------------------
var P = { step: 1, code: '', name: '', id: '', claim: '', err: '', timer: 0 };
function guessName() { var u = navigator.userAgent; return /iPad/.test(u) ? 'iPad' : /iPhone/.test(u) ? 'iPhone' : /Android/.test(u) ? 'Android phone' : 'Phone'; }
function fmtCode(v) {
  var c = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  return c.length > 4 ? c.slice(0, 4) + '-' + c.slice(4) : c;
}
function showPairing() {
  shellUp = false; S.onSessions = null; hideToast();
  clearInterval(P.timer);
  var saved = null;
  try { saved = JSON.parse(ls('loom.pairing') || 'null'); } catch (e) {}
  if (saved && saved.id && saved.claim && Date.now() - saved.t < 6 * 60000) { P.id = saved.id; P.claim = saved.claim; P.name = saved.name || guessName(); P.step = 3; }
  else { P.id = ''; P.claim = ''; P.step = iosLike() && !standalone() ? 1 : 2; if (!P.name) P.name = guessName(); }
  drawPairing();
  if (P.step === 3) pollPair();
}
function drawPairing() {
  clear(app); hideToast();
  var wrap = h('div', { class: 'pair' });
  wrap.appendChild(h('div', { class: 'bars', 'aria-label': 'Step ' + P.step + ' of 4' }, [1, 2, 3, 4].map(function (n) { return h('span', { class: n <= P.step ? 'on' : '' }); })));
  wrap.appendChild(h('div', { class: 'stepn', text: 'Step ' + P.step + ' of 4' }));
  if (P.step === 1) {
    wrap.appendChild(h('h1', { text: 'Add Loom to your Home Screen' }));
    wrap.appendChild(h('p', { text: 'You scanned the code on your Mac, so Safari is open on Loom. Notifications only work from the Home Screen app, so install it first.' }));
    wrap.appendChild(h('ol', { class: 'steps' },
      h('li', {}, h('span', { class: 'n', text: '1' }), h('span', {}, 'Tap Share ', icon('share'), ' in Safari’s toolbar')),
      h('li', {}, h('span', { class: 'n', text: '2' }), h('span', { text: 'Choose Add to Home Screen' })),
      h('li', {}, h('span', { class: 'n', text: '3' }), h('span', { text: 'Open Loom from the Home Screen' }))));
    wrap.appendChild(h('p', { class: 'fine', text: 'Needs the Tailscale app signed in on this iPhone. Loom is never reachable from the open internet.' }));
    wrap.appendChild(h('div', { class: 'spacer' }));
    wrap.appendChild(h('button', { class: 'btn big pri', style: 'flex:none', text: 'I opened it from the Home Screen', on: { click: function () { P.step = 2; drawPairing(); } } }));
  } else if (P.step === 2) {
    var code = h('input', { class: 'field code', value: P.code, autocomplete: 'one-time-code', autocapitalize: 'characters', autocorrect: 'off', spellcheck: 'false', placeholder: 'XXXX-XXXX', 'aria-label': 'Pairing code' });
    var name = h('input', { class: 'field', value: P.name, autocomplete: 'off', 'aria-label': 'Device name' });
    var err = h('div', { class: 'err', text: P.err });
    var go = h('button', { class: 'btn big pri', style: 'flex:none', text: 'Continue' });
    code.addEventListener('input', function () { var f = fmtCode(code.value); code.value = f; P.code = f; });
    name.addEventListener('input', function () { P.name = name.value; });
    function submit() {
      var c = fmtCode(code.value), n = name.value.trim();
      if (c.replace('-', '').length < 8) { err.textContent = 'Enter the 8-character code from your Mac.'; return; }
      if (!n) { err.textContent = 'Give this device a name.'; return; }
      go.disabled = true; err.textContent = '';
      api('/m/api/pair', { pub: true, body: { code: c, name: n } }).then(function (x) {
        go.disabled = false;
        if (x.ok && x.json.pending_id) {
          P.id = x.json.pending_id; P.claim = x.json.claim; P.name = n; P.err = '';
          ls('loom.pairing', JSON.stringify({ id: P.id, claim: P.claim, name: n, t: Date.now() }));
          P.step = 3; drawPairing(); pollPair();
        } else err.textContent = x.status === 429 ? 'Too many tries. Make a new code on your Mac.' : errText(x, 'That code didn’t work. Check it and try again.');
      });
    }
    go.addEventListener('click', submit);
    code.addEventListener('keydown', function (e) { if (e.key === 'Enter') name.focus(); });
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    wrap.appendChild(h('h1', { text: 'Enter the pairing code' }));
    wrap.appendChild(h('p', { text: 'It’s under the QR code on your Mac, in Loom › Settings › Devices › Pair a phone. It expires in 5 minutes.' }));
    wrap.appendChild(h('label', { class: 'field-l' }, 'Pairing code', code));
    wrap.appendChild(h('label', { class: 'field-l' }, 'Name this device', name));
    wrap.appendChild(err);
    wrap.appendChild(h('div', { class: 'spacer' }));
    wrap.appendChild(go);
  } else if (P.step === 3) {
    wrap.appendChild(h('h1', { text: 'Approve on your Mac' }));
    wrap.appendChild(h('p', { text: 'Loom on your Mac is asking whether to trust this phone. Nothing is unlocked until you click Allow there.' }));
    wrap.appendChild(h('div', { class: 'maccard' },
      h('div', { class: 'k', text: 'On your Mac' }),
      h('div', { class: 'q', text: 'Allow “' + P.name + '”?' }),
      h('ul', {}, h('li', { text: 'Read sessions, transcripts and the outbox' }), h('li', { text: 'Reply to and interrupt Claude sessions' }), h('li', { text: 'Send outbox drafts as you' }), h('li', { text: 'No terminals, shells or settings' }))));
    wrap.appendChild(h('div', { class: 'waiting', id: 'pairwait' }, h('span', { class: 'dot accent' }), h('span', { text: 'Waiting for approval…' })));
    wrap.appendChild(h('div', { class: 'err', id: 'pairerr', text: P.err }));
    wrap.appendChild(h('div', { class: 'spacer' }));
    wrap.appendChild(h('button', { class: 'btn big', style: 'flex:none', text: 'Cancel', on: { click: function () { clearInterval(P.timer); ls('loom.pairing', null); P.step = 2; P.err = ''; drawPairing(); } } }));
  } else {
    var can = pushSupported() && !(iosLike() && !standalone()) && (typeof Notification === 'undefined' || Notification.permission !== 'denied');
    wrap.appendChild(h('h1', { text: 'Turn on notifications' }));
    wrap.appendChild(h('p', { text: 'Loom pings this phone when a session needs you, only while you’re away from your Mac. You can change each kind later in Settings.' }));
    wrap.appendChild(h('div', { class: 'push-prev' }, h('span', { class: 'app', text: 'L' }),
      h('div', { style: 'flex:1;min-width:0' }, h('div', { class: 't' }, h('span', { text: 'LOOM' }), h('span', { text: 'now' })), h('div', { class: 'h', text: 'Your turn: ACH prenote retry' }), h('div', { class: 'bdy', text: 'blue-vanilla · Tests are green. Stage it, or keep going on R01?' }))));
    if (!can) wrap.appendChild(h('p', { class: 'fine', text: pushSupported() ? 'Notifications are blocked or not available in this browser. You can turn them on later in Settings.' : 'Add Loom to your Home Screen to get notifications. You can turn them on later in Settings.' }));
    var perr = h('div', { class: 'err' });
    wrap.appendChild(perr);
    wrap.appendChild(h('div', { class: 'spacer' }));
    if (can) wrap.appendChild(h('button', { class: 'btn big pri', style: 'flex:none', text: 'Turn on notifications', on: { click: function () { enablePush().then(finish, function (e) { perr.textContent = e && e.message || 'Could not turn on notifications'; }); } } }));
    wrap.appendChild(h('button', { class: 'btn link', style: 'height:44px;font-size:16px', text: can ? 'Not now' : 'Continue', on: { click: finish } }));
  }
  app.appendChild(wrap);
}
function pollPair() {
  clearInterval(P.timer);
  function check() {
    api('/m/api/pair/status?id=' + encodeURIComponent(P.id) + '&claim=' + encodeURIComponent(P.claim), { pub: true }).then(function (x) {
      if (P.step !== 3) return;
      var st = x.json && x.json.state;
      if (x.status === 404 || st === 'expired' || st === 'denied') {
        clearInterval(P.timer); ls('loom.pairing', null);
        P.err = st === 'denied' ? 'Your Mac denied that request.' : 'That request expired. Make a new code on your Mac and try again.';
        P.step = 2; drawPairing();
      } else if (st === 'approved') {
        clearInterval(P.timer); ls('loom.pairing', null);
        api('/m/api/me', { pub: true }).then(function (m) {
          if (m.ok) { S.me = m.json; P.step = 4; P.err = ''; drawPairing(); }
          else { P.err = 'Approved, but this phone couldn’t sign in. Try pairing again.'; P.step = 2; drawPairing(); }
        });
      }
    });
  }
  P.timer = setInterval(check, 2000);
  check();
}
function finish() { P.step = 1; toast0('Paired. You’re all set.'); startApp(); }
var pendingToast = '';
function toast0(m) { pendingToast = m; }

// ---- offline ---------------------------------------------------------------------
function showOffline() {
  shellUp = false; clear(app);
  app.appendChild(h('div', { class: 'center' }, h('h1', { text: 'Can’t reach Loom' }), h('p', { text: 'Check that Loom is running on your Mac and that Phone access is on.' }),
    h('button', { class: 'btn pri', text: 'Try again', on: { click: boot } })));
}

// ---- boot ------------------------------------------------------------------------
var SCREENS = { sessions: sessionsScreen, detail: detailScreen, outbox: outboxScreen, settings: settingsScreen };
function startApp() {
  buildShell();
  stopPollsOnly();
  poll(loadSessions, 5000);
  registerSw().catch(function () {});
  route();
  if (pendingToast) { toast(pendingToast); pendingToast = ''; }
}
function stopPollsOnly() { pollers.forEach(function (p) { p.stop(); }); pollers = []; }
window.addEventListener('hashchange', route);
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', function (e) {
    var d = e.data;
    if (d && d.type === 'nav' && typeof d.url === 'string') { var i = d.url.indexOf('#'); location.hash = i >= 0 ? d.url.slice(i) : '#sessions'; }
  });
}
function boot() {
  applyTheme(getTheme());
  api('/m/api/me', { pub: true }).then(function (r) {
    if (r.status === 401) return showPairing();
    if (!r.ok) return showOffline();
    S.me = r.json; S.bootVersion = S.version = r.json.version || ''; startApp();
  });
}
boot();
})();
`;
