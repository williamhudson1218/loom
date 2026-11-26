// Conversation mode on the phone: the Talk overlay for one chat. Served right after the
// app script in /m/app.js and opened from the chat screen with window.LoomTalk.open({ key, name }).
// Same rules as webapp.ts: CSP script-src 'self', no inline handlers, text through
// textContent, plain ES2017 inside a template string (no backtick, no dollar-brace).
//
// The loop: Listening (the mic, a WebAudio RMS voice detector: ~1.2 s of quiet after speech
// ends the utterance; tapping the orb sends at once) -> Transcribing (16 kHz mono WAV, encoded
// here, to /m/api/voice/transcribe) -> Sending (the words, 1.5 s to cancel) -> the ordinary
// /m/api/reply -> Working (polls /m/api/voice/turn) -> Summarizing (/m/api/voice/summary) ->
// Speaking (tap to skip) -> Listening. The mic is released while the agent works and while the
// summary plays, so iOS routes the voice to the speaker at full volume rather than the earpiece.
// One <audio> element, unlocked inside the Talk tap, plays every summary.

export const VOICE_JS = String.raw`
(function () {
'use strict';

var VAD = { silenceMs: 1200, minSpeechMs: 250, maxMs: 60000, calibrateMs: 300, preRollMs: 300, floorK: 3, minThresh: 0.012 };
var T = null; // the open session
var AUD = null; // the one audio element, unlocked by the Talk tap

function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function btn(cls, text, fn, label) { var b = el('button', cls, text); b.type = 'button'; if (label) b.setAttribute('aria-label', label); b.addEventListener('click', fn); return b; }
function flat(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

function req(path, opt) {
  opt = opt || {};
  var init = { method: opt.method || 'GET', credentials: 'same-origin', cache: 'no-store', headers: {} };
  if (opt.json !== undefined) { init.method = 'POST'; init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(opt.json); }
  if (opt.raw) { init.method = 'POST'; init.headers['content-type'] = opt.type || 'application/octet-stream'; init.body = opt.raw; }
  return fetch(path, init).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, status: r.status, json: j || {} }; });
  }, function () { return { ok: false, status: 0, json: {} }; });
}
function why(r, fallback) { var j = (r && r.json) || {}; return j.detail || j.error || (r && r.status === 0 ? 'Can’t reach Loom' : fallback); }

// ---- WAV ---------------------------------------------------------------------------
function resample(chunks, rate, out) {
  var n = 0, i; for (i = 0; i < chunks.length; i++) n += chunks[i].length;
  var all = new Float32Array(n), o = 0;
  for (i = 0; i < chunks.length; i++) { all.set(chunks[i], o); o += chunks[i].length; }
  if (rate === out) return all;
  var k = rate / out, len = Math.floor(n / k), res = new Float32Array(len);
  for (i = 0; i < len; i++) {
    // A box average over each output sample's span: a cheap low-pass before dropping samples.
    var a = Math.floor(i * k), b = Math.min(n, Math.floor((i + 1) * k)), s = 0;
    for (var j = a; j < b; j++) s += all[j];
    res[i] = b > a ? s / (b - a) : all[a] || 0;
  }
  return res;
}
function wavBlob(samples, rate) {
  var buf = new ArrayBuffer(44 + samples.length * 2), v = new DataView(buf);
  function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (var i = 0; i < samples.length; i++) { var x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 0x8000 : x * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

// ---- audio out -----------------------------------------------------------------------
function unlockAudio() {
  if (!AUD) { AUD = new Audio(); AUD.setAttribute('playsinline', ''); AUD.preload = 'auto'; }
  try {
    var u = URL.createObjectURL(wavBlob(new Float32Array(800), 16000));
    AUD.src = u;
    var p = AUD.play();
    if (p && p.then) p.then(function () { URL.revokeObjectURL(u); }, function () { URL.revokeObjectURL(u); });
  } catch (e) { /* playback may still work later */ }
}

// A soft two-note chime when the agent's turn ends, so the ear knows the summary is coming.
function earcon(ctx) {
  if (!ctx) return;
  try {
    if (ctx.resume) ctx.resume();
    var t0 = ctx.currentTime + 0.02;
    [[660, 0], [880, 0.14]].forEach(function (n) {
      var o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = n[0];
      g.gain.setValueAtTime(0.0001, t0 + n[1]);
      g.gain.exponentialRampToValueAtTime(0.12, t0 + n[1] + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + n[1] + 0.22);
      o.connect(g); g.connect(ctx.destination);
      o.start(t0 + n[1]); o.stop(t0 + n[1] + 0.25);
    });
  } catch (e) { /* no chime, no harm */ }
}

// ---- the overlay -----------------------------------------------------------------------
var LABEL = { idle: 'Tap to talk', listening: 'Listening…', heard: 'Listening…', transcribing: 'Transcribing…', sending: 'Sending…', working: 'Agent working…',
  summarizing: 'Summarizing…', speaking: 'Speaking', setup: 'Voice isn’t set up', error: 'Something went wrong' };
var HINT = { idle: 'Tap the circle and speak', listening: 'Speak. Pause to send, or tap to send now.', heard: 'Pause to send, or tap to send now.', transcribing: '', sending: 'Tap to cancel',
  working: 'You’ll hear a summary when its turn ends', summarizing: '', speaking: 'Tap to skip', setup: 'Set up voice on your Mac: Settings › Devices › Conversation mode', error: '' };

function open(opts) {
  if (T) close();
  unlockAudio();
  var t = T = { key: opts.key, name: opts.name || 'session', state: '', alive: true, log: [], poll: 0, timers: [], mic: null, ctx: null, node: null, lock: null, sent: '', seenWorking: false, idleStreak: 0, sentAt: 0, onClose: opts.onClose };
  try { var AC = window.AudioContext || window.webkitAudioContext; t.ctx = new AC(); if (t.ctx.resume) t.ctx.resume(); } catch (e) { t.ctx = null; }
  t.ov = el('div', 'talk'); t.ov.setAttribute('role', 'dialog'); t.ov.setAttribute('aria-label', 'Conversation with ' + t.name);
  var top = el('div', 'talktop');
  top.appendChild(el('div', 'talkname', t.name));
  t.catchBtn = btn('talkchip', 'Catch me up', function () { if (t.state === 'listening' || t.state === 'idle' || t.state === 'error') { stopMic(t); summarize(t); } });
  top.appendChild(t.catchBtn);
  top.appendChild(btn('talkend', 'End', close, 'End conversation'));
  t.orb = btn('talkorb', '', function () { orbTap(t); }, 'Talk');
  t.ring = el('span', 'talkring'); t.orb.appendChild(t.ring);
  t.label = el('div', 'talklabel'); t.hint = el('div', 'talkhint'); t.live = el('div', 'talklive');
  t.stopBtn = btn('talkchip', 'Stop agent', function () { req('/m/api/interrupt', { json: { key: t.key } }); }, 'Interrupt the agent (sends Esc)');
  t.logEl = el('div', 'talklog');
  var mid = el('div', 'talkmid'); mid.appendChild(t.orb); mid.appendChild(t.label); mid.appendChild(t.hint); mid.appendChild(t.live); mid.appendChild(t.stopBtn);
  t.ov.appendChild(top); t.ov.appendChild(mid); t.ov.appendChild(t.logEl);
  document.body.appendChild(t.ov);
  wake(t);
  t.onVis = function () { if (!document.hidden && T === t) { wake(t); if (t.state === 'listening' || t.state === 'heard') { stopMic(t); listen(t); } } };
  document.addEventListener('visibilitychange', t.onVis);
  set(t, 'transcribing'); t.label.textContent = 'Starting…';
  req('/m/api/voice/status').then(function (r) {
    if (!t.alive) return;
    if (!r.ok || !r.json.ready) { set(t, 'setup', r.json.hint); return; }
    return req('/m/api/voice/turn?key=' + encodeURIComponent(t.key)).then(function (x) {
      if (!t.alive) return;
      if (x.ok && x.json.working) { t.seenWorking = true; t.sent = ''; working(t); }
      else listen(t);
    });
  });
}

function set(t, state, hint) {
  t.state = state;
  t.ov.setAttribute('data-state', state);
  t.label.textContent = LABEL[state] || '';
  t.hint.textContent = hint != null ? hint : (HINT[state] || '');
  t.stopBtn.style.display = state === 'working' ? '' : 'none';
  t.catchBtn.style.display = state === 'listening' || state === 'idle' ? '' : 'none';
  if (state !== 'heard' && state !== 'listening') t.ring.style.transform = '';
}
function later(t, fn, ms) { var id = setTimeout(function () { if (t.alive) fn(); }, ms); t.timers.push(id); return id; }
function say(t, who, text) {
  t.log.push({ who: who, text: text });
  var row = el('div', 'talkmsg ' + who);
  row.appendChild(el('b', '', who === 'you' ? 'You' : t.name));
  row.appendChild(el('span', '', text));
  t.logEl.appendChild(row);
  t.logEl.scrollTop = t.logEl.scrollHeight;
}

function wake(t) {
  try { if (navigator.wakeLock && navigator.wakeLock.request) navigator.wakeLock.request('screen').then(function (l) { if (T === t) t.lock = l; else l.release(); }, function () {}); } catch (e) { /* unsupported */ }
}

function close() {
  var t = T; if (!t) return;
  T = null; t.alive = false;
  t.timers.forEach(clearTimeout); clearInterval(t.poll);
  stopMic(t);
  if (AUD) { try { AUD.pause(); } catch (e) {} }
  if (t.lock) { try { t.lock.release(); } catch (e) {} }
  if (t.ctx && t.ctx.close) { try { t.ctx.close(); } catch (e) {} }
  document.removeEventListener('visibilitychange', t.onVis);
  t.ov.remove();
  if (t.onClose) t.onClose(t.log);
}

function orbTap(t) {
  if (t.state === 'heard') return finish(t);
  if (t.state === 'listening') return; // nothing said yet
  if (t.state === 'idle' || t.state === 'error') { if (t.ctx && t.ctx.resume) t.ctx.resume(); return listen(t); }
  if (t.state === 'sending') { t.timers.forEach(clearTimeout); t.timers = []; say(t, 'you', '(cancelled) ' + t.pendingText); t.pendingText = ''; return listen(t); }
  if (t.state === 'speaking') { try { AUD.pause(); } catch (e) {} return listen(t); }
}

// ---- listening -------------------------------------------------------------------------
function stopMic(t) {
  if (t.node) { try { t.node.disconnect(); } catch (e) {} t.node.onaudioprocess = null; t.node = null; }
  if (t.src) { try { t.src.disconnect(); } catch (e) {} t.src = null; }
  if (t.mic) { t.mic.getTracks().forEach(function (k) { k.stop(); }); t.mic = null; }
}

function listen(t) {
  set(t, 'listening');
  if (!t.ctx || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { set(t, 'error', 'This browser can’t record audio.'); return; }
  if (t.ctx.resume) t.ctx.resume();
  navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }).then(function (stream) {
    if (!t.alive || (t.state !== 'listening')) { stream.getTracks().forEach(function (k) { k.stop(); }); return; }
    t.mic = stream;
    capture(t, stream);
  }, function () {
    if (!t.alive) return;
    // iOS asks again after the mic was released and no tap started this: one tap brings it back.
    set(t, 'idle', 'Tap the circle to talk. If it keeps failing, allow the microphone for Loom in Settings.');
  });
}

function capture(t, stream) {
  var ctx = t.ctx, rate = ctx.sampleRate, size = 4096, msPer = size / rate * 1000;
  var src = ctx.createMediaStreamSource(stream), node = ctx.createScriptProcessor(size, 1, 1), mute = ctx.createGain();
  mute.gain.value = 0; src.connect(node); node.connect(mute); mute.connect(ctx.destination);
  t.src = src; t.node = node;
  var pre = [], chunks = [], floor = 0, nCal = 0, speech = 0, quiet = 0, started = false, total = 0;
  var preMax = Math.ceil(VAD.preRollMs / msPer);
  t.rec = { rate: rate, chunks: chunks, started: function () { return started; } };
  node.onaudioprocess = function (e) {
    if (t.node !== node) return;
    var d = new Float32Array(e.inputBuffer.getChannelData(0)), s = 0;
    for (var i = 0; i < d.length; i++) s += d[i] * d[i];
    var rms = Math.sqrt(s / d.length);
    total += msPer;
    if (total <= VAD.calibrateMs) { floor = (floor * nCal + rms) / (++nCal); pre.push(d); return; }
    var th = Math.max(VAD.minThresh, floor * VAD.floorK);
    t.ring.style.transform = 'scale(' + (1 + Math.min(0.5, rms * 6)).toFixed(3) + ')';
    if (!started) {
      pre.push(d); if (pre.length > preMax) pre.shift();
      if (rms > th) { speech += msPer; if (speech >= VAD.minSpeechMs) { started = true; for (var p = 0; p < pre.length; p++) chunks.push(pre[p]); pre = []; set(t, 'heard'); } }
      else { speech = 0; floor = floor * 0.95 + rms * 0.05; }
      return;
    }
    chunks.push(d);
    quiet = rms > th ? 0 : quiet + msPer;
    if (quiet >= VAD.silenceMs || chunks.length * msPer >= VAD.maxMs) finish(t);
  };
}

function finish(t) {
  var rec = t.rec; if (!rec || !rec.started()) return;
  t.rec = null; stopMic(t);
  set(t, 'transcribing');
  var wav = wavBlob(resample(rec.chunks, rec.rate, 16000), 16000);
  req('/m/api/voice/transcribe', { raw: wav, type: 'audio/wav' }).then(function (r) {
    if (!t.alive) return;
    var text = r.ok ? String(r.json.text || '').trim() : '';
    if (!r.ok) { t.live.textContent = why(r, 'Could not transcribe'); return later(t, function () { t.live.textContent = ''; listen(t); }, 1500); }
    if (!text) { t.live.textContent = 'Didn’t catch that.'; return later(t, function () { t.live.textContent = ''; listen(t); }, 900); }
    sending(t, text);
  });
}

// ---- sending and the agent's turn -------------------------------------------------------
function sending(t, text) {
  t.pendingText = text;
  set(t, 'sending');
  t.live.textContent = '“' + text + '”';
  later(t, function () {
    if (t.state !== 'sending') return;
    req('/m/api/reply', { json: { key: t.key, text: text } }).then(function (r) {
      if (!t.alive) return;
      t.live.textContent = '';
      if (!r.ok) { set(t, 'error', r.status === 409 ? 'That session isn’t live anymore' : r.status === 403 ? 'That pane isn’t running Claude' : why(r, 'Could not send')); return; }
      say(t, 'you', text);
      t.sent = flat(text).slice(0, 40); t.seenWorking = false; t.sentAt = Date.now();
      working(t);
    });
  }, 1500);
}

function working(t) {
  set(t, 'working');
  t.idleStreak = 0;
  clearInterval(t.poll);
  t.poll = setInterval(function () {
    if (!t.alive || t.state !== 'working' || document.hidden) return;
    req('/m/api/voice/turn?key=' + encodeURIComponent(t.key)).then(function (r) {
      if (!t.alive || t.state !== 'working') return;
      if (r.status === 404) { clearInterval(t.poll); set(t, 'error', 'That session has ended'); return; }
      if (!r.ok) return;
      var j = r.json;
      var mine = !t.sent || flat(j.last_user).indexOf(t.sent) === 0;
      if (j.working) { t.seenWorking = true; t.idleStreak = 0; return; }
      // Idle: the turn is over once our words are in the transcript (or the agent was seen working)
      // and it has said or done something since, or it is stopped at a prompt. Two idle reads in a row.
      var began = t.seenWorking || mine || Date.now() - t.sentAt > 20000;
      if (began && mine && (j.since_user > 0 || j.at_prompt)) t.idleStreak++;
      else t.idleStreak = 0;
      if (t.idleStreak >= 2) { clearInterval(t.poll); earcon(t.ctx); summarize(t); }
    });
  }, 1500);
}

function summarize(t) {
  set(t, 'summarizing');
  req('/m/api/voice/summary', { json: { key: t.key } }).then(function (r) {
    if (!t.alive) return;
    if (!r.ok) { t.live.textContent = why(r, 'Could not summarize'); return later(t, function () { t.live.textContent = ''; listen(t); }, 1500); }
    var text = String(r.json.text || '');
    if (text) say(t, 'agent', text);
    speak(t, r.json.audio, text);
  });
}

function speak(t, id, text) {
  set(t, 'speaking');
  t.live.textContent = text || '';
  var done = function () { if (t.alive && t.state === 'speaking') { t.live.textContent = ''; listen(t); } };
  if (!id || !AUD) return later(t, done, 2500);
  AUD.onended = done;
  AUD.onerror = function () { later(t, done, 2000); };
  AUD.src = '/m/api/voice/audio?id=' + encodeURIComponent(id);
  var p = AUD.play();
  if (p && p.catch) p.catch(function () { t.hint.textContent = 'Couldn’t play the voice. Tap to continue.'; set(t, 'speaking', 'Couldn’t play the voice. Tap to continue.'); });
}

window.LoomTalk = { open: open, close: close, _wav: wavBlob, _resample: resample, _earcon: earcon };
})();
`;

export const VOICE_CSS = String.raw`
.talk { position:fixed; inset:0; z-index:60; display:flex; flex-direction:column; background:var(--bg, #0d0f15); color:var(--text, #e8eaf0);
  padding:calc(env(safe-area-inset-top) + 10px) 16px calc(env(safe-area-inset-bottom) + 12px); }
.talktop { display:flex; align-items:center; gap:8px; }
.talkname { flex:1; min-width:0; font-weight:600; font-size:16px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.talkend { border:0; border-radius:999px; padding:8px 16px; font:600 15px/1 inherit; background:#d9443a; color:#fff; }
.talkchip { border:1px solid var(--border); background:transparent; color:inherit; border-radius:999px; padding:7px 12px; font:500 13px/1 inherit; }
.talkmid { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:12px; text-align:center; min-height:0; }
.talkorb { position:relative; width:168px; height:168px; border-radius:50%; border:0; background:radial-gradient(circle at 35% 30%, #7aa8ff, #3b6fe0 70%); box-shadow:0 10px 40px rgba(59,111,224,.35); }
.talkring { position:absolute; inset:-10px; border-radius:50%; border:3px solid rgba(122,168,255,.55); transition:transform .08s linear; pointer-events:none; }
.talk[data-state="heard"] .talkorb { background:radial-gradient(circle at 35% 30%, #8ee6a1, #2ea043 70%); box-shadow:0 10px 40px rgba(46,160,67,.35); }
.talk[data-state="heard"] .talkring { border-color:rgba(142,230,161,.6); }
.talk[data-state="working"] .talkorb, .talk[data-state="transcribing"] .talkorb, .talk[data-state="summarizing"] .talkorb { background:radial-gradient(circle at 35% 30%, #f3d27a, #e8b04a 70%); box-shadow:0 10px 40px rgba(232,176,74,.3); animation:talkpulse 1.4s ease-in-out infinite; }
.talk[data-state="speaking"] .talkorb { background:radial-gradient(circle at 35% 30%, #c9a6ff, #8b5cf6 70%); box-shadow:0 10px 40px rgba(139,92,246,.35); animation:talkpulse 1s ease-in-out infinite; }
.talk[data-state="sending"] .talkorb { background:radial-gradient(circle at 35% 30%, #9fb4d8, #55698f 70%); }
.talk[data-state="setup"] .talkorb, .talk[data-state="error"] .talkorb, .talk[data-state="idle"] .talkorb { background:radial-gradient(circle at 35% 30%, #8a93a6, #4b5263 70%); box-shadow:none; }
.talk[data-state="working"] .talkring, .talk[data-state="speaking"] .talkring, .talk[data-state="setup"] .talkring, .talk[data-state="error"] .talkring { display:none; }
@keyframes talkpulse { 0%,100% { transform:scale(1); } 50% { transform:scale(1.05); } }
@media (prefers-reduced-motion:reduce) { .talkorb { animation:none !important; } .talkring { transition:none; } }
.talklabel { font-weight:600; font-size:20px; margin-top:8px; }
.talkhint { color:var(--muted, #9aa3b5); font-size:14px; max-width:320px; line-height:1.4; }
.talklive { font-size:16px; line-height:1.45; max-width:340px; min-height:1.45em; }
.talklog { flex:none; max-height:34vh; overflow-y:auto; border-top:1px solid var(--border); padding-top:8px; display:flex; flex-direction:column; gap:8px; -webkit-overflow-scrolling:touch; }
.talkmsg { font-size:14px; line-height:1.45; }
.talkmsg b { display:block; font-size:11.5px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted, #9aa3b5); margin-bottom:1px; }
.talkmsg.you span { color:var(--text, #e8eaf0); }
.talkmsg.agent span { color:var(--text2, #c5cbd8); }
`;
