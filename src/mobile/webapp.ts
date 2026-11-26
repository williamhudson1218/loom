// Loom mobile PWA script (served at /m/app.js). Vanilla JS, no framework, no build step.
// Written for a CSP of script-src 'self': no inline handlers, everything is wired with
// addEventListener, and text goes in through textContent. Plain ES2017 inside a template
// string, so it must never contain a backtick or a dollar-brace; strings are joined with +.

export const APP_JS = String.raw`
(function () {
'use strict';

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
var S = { me: null, sessions: [], counts: { working: 0, needs: 0, blocked: 0 }, outboxPending: 0, live: true, onSessions: null, tabs: null };
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
function confirmSheet(title, body, okLabel) {
  return new Promise(function (res) {
    openSheet(function (sheet, close) {
      sheet.appendChild(h('div', { class: 'ttl', text: title }));
      if (body) sheet.appendChild(h('div', { class: 'muted', text: body }));
      sheet.appendChild(h('div', { class: 'ro' },
        h('button', { class: 'btn big', text: 'Cancel', on: { click: function () { close(); res(false); } } }),
        h('button', { class: 'btn big pri', text: okLabel, on: { click: function () { close(); res(true); } } })));
    });
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
  var n = S.counts.needs || 0, o = S.outboxPending || 0;
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
}

// ---- sessions --------------------------------------------------------------------
var GROUPS = [
  { key: 'needs', label: 'Needs you', color: 'var(--accent)', prefix: 'asked:' },
  { key: 'blocked', label: 'Waiting on someone', color: 'var(--warn)', prefix: 'waiting:' },
  { key: 'working', label: 'Working', color: 'var(--green)', prefix: 'last:' }
];
function loadSessions() {
  return api('/m/api/sessions').then(function (r) {
    if (r.ok) {
      S.live = true;
      S.sessions = r.json.sessions || [];
      S.counts = r.json.counts || { working: 0, needs: 0, blocked: 0 };
      S.outboxPending = r.json.outbox_pending || 0;
    } else if (r.status !== 401) S.live = false;
    updateBadges();
    if (S.onSessions) S.onSessions();
  });
}
function sessionsScreen() {
  var chipDot = h('span', { class: 'dot' }), chipText = h('span', { text: 'Mac · live' });
  var line = h('p', { text: '' });
  var list = h('div', { class: 'list' });
  var scroller = h('div', { class: 'scroll' }, list);
  screenEl.appendChild(h('div', { class: 'scr' },
    h('header', { class: 'hdr' }, h('div', { class: 'row' }, h('h1', { text: 'Sessions' }), h('span', { class: 'chip' }, chipDot, chipText)), line),
    scroller));
  var last = '';
  function render() {
    chipDot.className = 'dot' + (S.live ? '' : ' off');
    chipText.textContent = S.live ? 'Mac · live' : 'Mac · offline';
    var c = S.counts;
    line.textContent = '~ ' + (c.working || 0) + ' working · ● ' + (c.needs || 0) + ' your turn · ‖ ' + (c.blocked || 0) + ' waiting';
    var sig = JSON.stringify([S.live, S.sessions.map(function (s) { return [s.key, s.group, s.topic, s.tail, s.stage, ago(s.last_active_at)]; })]);
    if (sig === last) return;
    last = sig;
    var keep = scroller.scrollTop;
    clear(list);
    var any = false;
    GROUPS.forEach(function (g) {
      var items = S.sessions.filter(function (s) { return s.group === g.key; });
      if (!items.length) return;
      any = true;
      var card = h('div', { class: 'card' });
      items.forEach(function (s) {
        card.appendChild(h('button', { class: 'srow', on: { click: function () { location.hash = '#s=' + encodeURIComponent(s.key); } } },
          glyphEl(s),
          h('span', { class: 'sbody' },
            h('span', { class: 'sline' }, h('span', { class: 'stopic', text: s.topic || s.name || s.key }), h('span', { class: 'sage', text: ago(s.last_active_at) })),
            h('span', { class: 'smeta' }, h('span', { class: 'pill', text: s.name || '' }), h('span', { text: s.project || '' })),
            s.tail ? h('span', { class: 'stail' }, h('span', { class: 'pfx', text: g.prefix }), ' ' + s.tail) : null)));
      });
      list.appendChild(h('section', { class: 'grp' }, h('h2', { style: 'color:' + g.color, text: g.label + ' · ' + items.length }), card));
    });
    if (!any) list.appendChild(h('div', { class: 'empty', text: S.live ? 'No live sessions on your Mac right now.' : 'Can’t reach Loom on your Mac. Check that it is running and that Phone access is on.' }));
    scroller.scrollTop = keep;
  }
  S.onSessions = render;
  render();
  return { stop: function () { S.onSessions = null; } };
}

// ---- session detail --------------------------------------------------------------
var drafts = {};
function detailScreen(r) {
  var key = r.key, sess = (S.sessions.filter(function (s) { return s.key === key; })[0]) || { key: key, name: '', topic: '', project: '', stage: 'implementation', group: 'working' };
  var title = h('div', { class: 'a' }), sub = h('div', { class: 'b' }), chip = h('span', { class: 'stagechip' });
  var status = h('span'), pane = h('span', { class: 'mono' });
  var msgsEl = h('div', { class: 'msgs' }), scroller = h('div', { class: 'scroll' }, msgsEl);
  var ta = h('textarea', { class: 'tinput', rows: '1', placeholder: 'Reply', enterkeyhint: 'send', 'aria-label': 'Reply' });
  var sendBtn = h('button', { class: 'sendbtn', 'aria-label': 'Send reply' }, icon('send'));
  var stopBtn = h('button', { class: 'stopbtn', 'aria-label': 'Interrupt (sends Esc)', title: 'Interrupt (Esc)' }, icon('stop'));
  var quick = h('div', { class: 'quick' });
  var composer = h('div', { class: 'composer' }, quick, h('div', { class: 'crow' }, stopBtn, ta, sendBtn));
  var canReply = true, lastSig = '', busy = false;
  // Follow new messages only while the reader is at the bottom. Scrolling up, even a little,
  // stops the follow; scrolling back down resumes it. While a finger is on the list, a poll's
  // repaint waits for the touch (and its momentum) to end, so it can't snap the view back down.
  var stick = true, touching = false, pendingMsgs = null, settleTimer = 0;
  scroller.addEventListener('scroll', function () {
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    if (pendingMsgs && !touching) { clearTimeout(settleTimer); settleTimer = setTimeout(flushPending, 250); }
  }, { passive: true });
  scroller.addEventListener('touchstart', function () { touching = true; }, { passive: true });
  function touchEnd() { touching = false; clearTimeout(settleTimer); settleTimer = setTimeout(flushPending, 250); }
  scroller.addEventListener('touchend', touchEnd, { passive: true });
  scroller.addEventListener('touchcancel', touchEnd, { passive: true });
  function flushPending() { if (touching || !pendingMsgs) return; var m = pendingMsgs; pendingMsgs = null; paintMsgs(m); }

  ta.value = drafts[key] || '';
  function grow() { ta.style.height = 'auto'; ta.style.height = Math.min(140, ta.scrollHeight) + 'px'; }
  ta.addEventListener('input', function () { drafts[key] = ta.value; grow(); });

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
    var g = sess.group;
    status.textContent = g === 'working' ? '~ working' : g === 'blocked' ? '‖ waiting on someone' + (age ? ' · ' + age : '') : '● your turn' + (age ? ' · ' + age : '');
    status.style.color = g === 'working' ? 'var(--green)' : g === 'blocked' ? 'var(--warn)' : 'var(--accent)';
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
  function paintMsgs(msgs) {
    var sig = JSON.stringify(msgs);
    if (sig === lastSig) return;
    if (touching) { pendingMsgs = msgs; return; }
    lastSig = sig;
    var first = !msgsEl.firstChild, keep = scroller.scrollTop;
    clear(msgsEl);
    msgs.forEach(function (m) {
      if (m.role === 'user') msgsEl.appendChild(h('div', { class: 'm-user', text: m.text }));
      else if (m.role === 'tool') msgsEl.appendChild(h('div', { class: 'm-tool' }, h('span', { 'aria-hidden': 'true', text: '▸' }), h('span', { text: m.text })));
      else msgsEl.appendChild(h('div', { class: 'm-asst', text: m.text }));
    });
    if (!msgs.length) msgsEl.appendChild(h('div', { class: 'empty', text: 'No messages yet.' }));
    scroller.scrollTop = first || stick ? scroller.scrollHeight : keep;
  }
  function paintEnabled() {
    ta.disabled = !canReply; sendBtn.disabled = !canReply; stopBtn.disabled = !canReply;
    if (!canReply) ta.placeholder = 'This session isn’t live on your Mac';
    paintQuick();
  }
  function load() {
    return api('/m/api/session?key=' + encodeURIComponent(key)).then(function (x) {
      if (x.status === 404) { toast('That session has ended'); location.hash = '#sessions'; return; }
      if (!x.ok) return;
      if (x.json.session) sess = x.json.session;
      canReply = x.json.can_reply !== false;
      paintHead(); paintEnabled(); paintMsgs(x.json.messages || []);
    });
  }
  function send(text) {
    text = String(text == null ? ta.value : text).trim();
    if (!text || busy || !canReply) return;
    busy = true; sendBtn.disabled = true;
    api('/m/api/reply', { body: { key: key, text: text } }).then(function (x) {
      busy = false; sendBtn.disabled = !canReply;
      if (x.ok) {
        ta.value = ''; drafts[key] = ''; grow();
        stick = true;
        toast('Sent to ' + (sess.name || 'session'));
        setTimeout(load, 700);
      } else if (x.status === 409) { toast('That session isn’t live anymore'); load(); }
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
  screenEl.appendChild(h('div', { class: 'scr' },
    h('header', { class: 'dhdr' },
      h('button', { class: 'iconbtn', 'aria-label': 'Back to sessions', on: { click: function () { location.hash = '#sessions'; } } }, icon('back')),
      h('div', { class: 'dtitle' }, title, sub), chip),
    h('div', { class: 'band' }, status, pane),
    scroller, composer));
  paintHead(); paintEnabled(); grow();
  var p = poll(load, 3000);
  return { stop: function () { p.stop(); } };
}

// ---- outbox ----------------------------------------------------------------------
var KIND = { thread: 'Thread', dm: 'DM', channel: 'Channel', email: 'Email', review: 'PR review' };
var OB = { drafts: [], done: [], editing: null, edits: {}, hidden: {}, sheet: false };
function outboxScreen() {
  var line = h('p', { text: '' });
  var list = h('div', { class: 'list', style: 'gap:12px' });
  var scroller = h('div', { class: 'scroll' }, list);
  screenEl.appendChild(h('div', { class: 'scr' }, h('header', { class: 'hdr' }, h('h1', { text: 'Outbox' }), line), scroller));
  var alive = true, loaded = false;

  function msgsOf(d) { return OB.edits[d.id] || d.messages || []; }
  function visible() { return OB.drafts.filter(function (d) { return !OB.hidden[d.id]; }); }
  function render() {
    if (!alive) return;
    var vis = visible();
    line.textContent = vis.length === 0 ? 'Nothing waiting. Drafts land here as sessions write them.' : vis.length + (vis.length === 1 ? ' draft waiting on you.' : ' drafts waiting on you.') + ' Nothing posts until you tap Post.';
    var keep = scroller.scrollTop;
    clear(list);
    vis.forEach(function (d) { list.appendChild(card(d)); });
    OB.done.forEach(function (x) { list.appendChild(h('div', { class: 'done' }, h('span', { class: 'dot' + (x.accent ? ' accent' : '') }), h('span', { style: 'flex:1', text: x.text }))); });
    if (!vis.length && !OB.done.length && loaded) list.appendChild(h('div', { class: 'empty', text: 'No drafts.' }));
    scroller.scrollTop = keep;
  }
  function card(d) {
    var editing = OB.editing === d.id;
    var msgs = msgsOf(d);
    var body;
    if (editing) {
      body = msgs.map(function (m, i) {
        var t = h('textarea', { rows: '5' }); t.value = m;
        t.addEventListener('input', function () { var a = msgsOf(d).slice(); a[i] = t.value; OB.edits[d.id] = a; });
        return h('label', { class: 'edit' }, msgs.length > 1 ? 'Message ' + (i + 1) + ' of ' + msgs.length : 'Edit before sending', t);
      });
    } else body = msgs.map(function (m) { return h('p', { class: 'dtext', text: m }); });
    var stale = d.stale ? h('div', { class: 'warnband' }, icon('warn'), h('span', { text: d.stale_note || 'There is new activity since this was drafted.' })) : null;
    return h('article', { class: 'draft' },
      h('div', { class: 'top' }, h('div', { class: 'l' }, h('span', { class: 'kind', text: KIND[d.kind] || d.kind || 'Draft' }), h('span', { class: 'where', text: d.where || '' })), h('span', { class: 'sage', text: ago(d.created_at) })),
      h('div', { class: 'ctx' }, (d.ctx || '') + (d.from ? ' · from ' : ''), d.from ? h('span', { class: 'mono', text: d.from }) : null),
      stale, body,
      h('div', { class: 'actions' },
        h('button', { class: 'btn ghost', text: 'Discard', on: { click: function () { discard(d); } } }),
        h('button', { class: 'btn', text: editing ? 'Done' : 'Edit', on: { click: function () { OB.editing = editing ? null : d.id; render(); } } }),
        h('button', { class: 'btn pri', text: d.stale ? 'Review' : (d.kind === 'email' ? 'Send' : 'Post'), on: { click: function () { review(d); } } })));
  }
  function discard(d) {
    OB.hidden[d.id] = true; if (OB.editing === d.id) OB.editing = null;
    render();
    var timer = setTimeout(function () {
      api('/m/api/outbox/discard', { body: { id: d.id } }).then(function (x) {
        if (!x.ok && x.status !== 404) { delete OB.hidden[d.id]; toast(errText(x, 'Could not discard')); }
        loadOutbox();
      });
    }, 4000);
    toast('Draft discarded', function () { clearTimeout(timer); delete OB.hidden[d.id]; render(); });
  }
  function review(d) {
    OB.sheet = true; OB.editing = null;
    var after = 'none';
    var text = msgsOf(d).join('\n\n');
    var first = (d.new_messages && d.new_messages[0] && d.new_messages[0].who) || 'Someone';
    var verb = d.kind === 'email' ? 'Send' : 'Post';
    openSheet(function (sheet, close) {
      function done() { close(); }
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
        var paint = function () { clear(seg); opts.forEach(function (o) { seg.appendChild(h('button', { text: o[1], 'aria-pressed': after === o[0] ? 'true' : 'false', on: { click: function () { after = o[0]; paint(); } } })); }); };
        paint();
        sheet.appendChild(h('div', { style: 'display:flex;flex-direction:column;gap:6px' }, h('div', { class: 'muted', style: 'font-size:13px', text: 'Then, for ' + d.from }), seg));
      }
      var row = h('div', { class: 'ro' }, h('button', { class: 'btn big', text: 'Cancel', on: { click: done } }));
      if (d.stale) row.appendChild(h('button', { class: 'btn big', style: 'font-size:16px;font-weight:600', text: 'Ask to redraft', on: { click: function () {
        done();
        api('/m/api/outbox/redraft', { body: { id: d.id } }).then(function (x) {
          if (x.ok) { OB.done.push({ text: 'Asked ' + (d.from || 'the chat') + ' to redraft against the new messages', accent: true }); OB.drafts = OB.drafts.filter(function (z) { return z.id !== d.id; }); toast('Asked ' + (d.from || 'the chat') + ' to redraft'); }
          else toast(errText(x, 'Could not ask for a redraft'));
          loadOutbox();
        });
      } } }));
      row.appendChild(h('button', { class: 'btn big pri', text: d.stale ? verb + ' anyway' : verb, on: { click: function () {
        var body = { id: d.id, messages: msgsOf(d), after: d.from ? after : 'none' };
        if (d.stale) body.ack_stale = true;
        done();
        api('/m/api/outbox/send', { body: body }).then(function (x) {
          if (x.ok) { OB.done.push({ text: (d.kind === 'email' ? 'Sent to ' : 'Posted to ') + (d.where || 'destination') }); OB.drafts = OB.drafts.filter(function (z) { return z.id !== d.id; }); delete OB.edits[d.id]; toast((d.kind === 'email' ? 'Sent to ' : 'Posted to ') + (d.where || 'destination')); }
          else if (x.status === 409) toast(errText(x, 'This changed since it was drafted. Review it again.'));
          else toast(errText(x, 'Could not send'));
          loadOutbox();
        });
      } } }));
      sheet.appendChild(row);
    }, function () { OB.sheet = false; });
  }
  function loadOutbox() {
    if (!alive) return Promise.resolve();
    return api('/m/api/outbox').then(function (x) {
      if (!x.ok || !alive) return;
      var next = x.json.drafts || [];
      loaded = true; S.outboxPending = next.length; updateBadges();
      if (OB.editing || OB.sheet) { OB.drafts = next.length ? OB.drafts.filter(function (o) { return next.some(function (n) { return n.id === o.id; }); }).concat(next.filter(function (n) { return !OB.drafts.some(function (o) { return o.id === n.id; }); })) : []; return; }
      OB.drafts = next;
      render();
    });
  }
  OB.done = [];
  render();
  var p = poll(loadOutbox, 5000);
  return { stop: function () { alive = false; p.stop(); OB.editing = null; OB.sheet = false; } };
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
      h('div', { class: 'note', style: 'display:flex' }, h('button', { class: 'btn link', style: 'padding:0;height:auto;font-size:15px', text: 'Reload app', on: { click: function () { location.reload(); } } }))));
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
    S.me = r.json; startApp();
  });
}
boot();
})();
`;
