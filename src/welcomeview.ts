// The welcome screen (the "Still" direction): a quiet, layered starfield with
// faint nebulae in the logo's three thread colours, the logo drawing itself in,
// the wordmark, two lines of copy and one Enter button. It shows in front of the
// setup wizard on a first launch, and again from Settings > Help. The gate is
// src/welcome.ts; the route that records "seen" is POST /api/wizard/welcome.
//
// Offline by design: the wordmark face is Cormorant Garamond Light (SIL Open Font
// License 1.1, github.com/CatharsisFonts/Cormorant), embedded below as a woff2
// subset holding only the letters L, o and m. Everything else uses the system font.
//
// Plain browser CSS/HTML/JS in strings, spliced verbatim by dashboard.ts like
// wizardview.ts: no backtick, no dollar-brace and no backslash anywhere in them.
// Everything is prefixed lw so it cannot collide with the dashboard's classes.
//
// The animation runs only while the screen is up and the page is visible: Enter
// cancels the frame loop and removes every listener it added, and a hidden page
// cancels the loop until it is visible again.

const SERIF_WOFF2 = 'd09GMgABAAAAAASYAA8AAAAACHgAAARAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGhYbeBwuBmA/U1RBVEQATBEICoUghF0LDAABNgIkAxQEIAWEZgcgGyQHyAQe6L2qV5WMkgydIbnbS+LI3wXwdSD7/99vVjx541DxSGjUyL8fv5g/xHxLpiWL1kWx6KGIl7KFnvcaLmEb6kcU73ksox8BGJioRESoHG8DGskUopZX1rfjN2bhrClKOn6WZbJ0ysicaT7U/83TRtdky6xp2F/pvbaKxB5BJC6y0XD8yKlIO+WRLd3ibkxSHk88CtsHPRKze5AlQfquIT1FPDaz5CbZDdSdjxeDpPIlm4mTSCviw8Voj36+obGpsYJzmExXjvz/kZpSa4S/idj/XUuskjPBWAWQeQIeR0b4HeaPnzBH6DBxzsgUYSDwQLoYfuGYlFPsGwgh4ivUAKj4gwuciUp2EUF2psSknqlML47lPsv6qfVt617rHhnTplcgrFacr2jzRjSo2sZfIEIcnOpXqORnkaAatqpma6iqnmiaYa5OPXaOtot0NHShCV1o7ec+rUPotH+hCDsYRrtXh+Ae6tZ5e/ua2XW7Ibni4Nu6vvlp2Mq9HHjECs3YtFJNvXtYKCsPvaMZ62VIX9U3r4DYWwec5w94UYiV2qZH8V4Xn+qb78OK5xnbO3ZLjNB6CP54JnzPPu+u/frml/W/pGPTkydi5dOHT/XNjx+z4tGj2M1PxconT7RNj1jx+PGA25cFXzqnrS2JLDWfMUsjS82zfPFMaGnFWLM8LCSsZLA0vDR0bGVpyDNrl6wLfWaMWfZ6qE9osqU5ZOYzM8eWBD4z8xmzKdmSvLa7siIx5JkQS3miGfoMrwfdCLhZE74iI6tigXJCibGpDnZ2viUNGdlzO/Bu4K3eSGlIn1Nm6ClvacjI3tskS0PGbIw7Pb8nojb1Rt57relx6ZsKL8RNjFUMxfW+n+99d8VQYhbGnZ7fHfJuay6MlYZ0O8//yO0p10L/99De9UquSZmW5qLYVUd9HSfwA76+H/GZkdeZkzicnR5R92GNd3h+R17CQHpxTt9gyvnsstqugpih2qzUnKLG2rxoS01+m2H+SJnzKf1ubofLkHP+b/aK0o9kH61b5nvqJ2cLPK2H/v/M5mXliELbtk23dxOeuMh66L8Wm5eV3kfZp9iI3xiUboTKP9HEe0TwdT8hNnzZolfT0s2bmMG+XuNVHYLEGRF/VwqS+VcpceJ7pUI5L6xUeaUNfuxQ2pLIaMGJTOQYIqERikodAy+mwdXQsb99RCvTmcoI06hhDiNMYSJj6MLCRMYzgTnUL2A/OYcZzCaXJJqczgwsTGMcJqYxxw/ezp+NhUSmM4vxlJ1xKkESkjlUwR3et09jLAnylU4szCKc+P23JukkkkwyKVfdPBppopGKJRRmthqAzGUKP4/f2qbWN8E1OoOFZH4jJqmZqWRg0g5My7yCtmbonc4kLIwhUsLcqgTeNhtr0Yxnou6dyyiJjGmQWhJljHxxjlRHYjaV1YyzmTkTwZixmbJ7WY+QygYA';

export const WELCOME_VIEW_CSS = String.raw`
  @font-face { font-family:'Loom Wordmark'; font-style:normal; font-weight:300; font-display:block; src:url(data:font/woff2;base64,` + SERIF_WOFF2 + String.raw`) format('woff2'); }
  #lw { --lw-space:#05060b; --lw-pink:#ff5f8f; --lw-amber:#ffb238; --lw-cyan:#5ec8ff; --lw-star:#eef1fb; --lw-dust:#8d93ab;
    position:fixed; inset:0; z-index:150; display:none; background:var(--lw-space); color:var(--lw-star); overflow:hidden;
    font:14px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; }
  #lw.open { display:block; }
  #lw * { box-sizing:border-box; }
  #lw canvas { position:absolute; inset:0; width:100%; height:100%; display:block; }
  #lw .lw-main { position:relative; z-index:2; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:22px; text-align:center; padding:24px max(16px, env(safe-area-inset-right, 0px)) 24px max(16px, env(safe-area-inset-left, 0px)); }
  #lw .lw-halo { position:absolute; width:420px; height:420px; max-width:90vw; border-radius:50%; left:50%; top:50%; transform:translate(-50%,-78%); pointer-events:none;
    background:radial-gradient(circle, rgba(255,178,56,.10), rgba(255,95,143,.06) 40%, transparent 70%); }
  #lw .lw-mark { display:block; overflow:visible; width:clamp(104px,12vw,168px); height:auto;
    filter:drop-shadow(0 0 6px rgba(255,178,56,.45)) drop-shadow(0 0 22px rgba(255,95,143,.35)) drop-shadow(0 0 40px rgba(94,200,255,.3)); }
  #lw.run .lw-mark { animation:lw-breathe 7s ease-in-out 3s infinite; }
  #lw .lw-mark path[pathLength] { stroke-dasharray:1; stroke-dashoffset:0; }
  #lw.run .lw-mark path[pathLength] { stroke-dashoffset:1; animation:lw-draw 1.9s cubic-bezier(.6,0,.2,1) .3s forwards; }
  #lw.run .lw-mark path.lw-t2[pathLength] { animation-delay:1.4s; }
  #lw .lw-word { margin:-6px 0 0; font-family:'Loom Wordmark','Cormorant Garamond','Iowan Old Style','Hoefler Text',Georgia,serif; font-weight:300;
    font-size:clamp(64px,8vw,116px); line-height:1; letter-spacing:.32em; padding-left:.32em; color:var(--lw-star);
    text-shadow:0 0 14px rgba(238,241,251,.35), 0 0 50px rgba(94,200,255,.18); }
  #lw.run .lw-word { animation:lw-flicker 1.4s linear 1.6s 1 both, lw-glow 7s ease-in-out 3.2s infinite; }
  #lw .lw-lines { margin:0; display:flex; flex-direction:column; gap:6px; font-size:clamp(15px,1.25vw,18px); line-height:1.5; text-wrap:balance; }
  #lw .lw-l1 { font-weight:500; color:var(--lw-star); }
  #lw .lw-l2 { color:var(--lw-dust); }
  #lw.run .lw-lines { animation:lw-rise 1.6s ease 2.4s both; }
  #lw .lw-enter { margin-top:18px; padding:15px 50px; border-radius:999px; cursor:pointer; color:var(--lw-star);
    font:500 12px/1 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif; letter-spacing:.38em; text-indent:.38em; text-transform:uppercase;
    border:1px solid transparent;
    background:linear-gradient(rgba(10,12,22,.82), rgba(10,12,22,.82)) padding-box, linear-gradient(90deg, var(--lw-pink), var(--lw-amber), var(--lw-cyan)) border-box;
    box-shadow:0 0 30px rgba(94,200,255,.10), 0 0 30px rgba(255,95,143,.10); transition:box-shadow .4s; }
  #lw.run .lw-enter { animation:lw-rise 1.6s ease 2.9s both; }
  #lw .lw-enter:hover { box-shadow:0 0 36px rgba(94,200,255,.28), 0 0 36px rgba(255,95,143,.24); }
  #lw .lw-enter:focus-visible { outline:1px solid rgba(94,200,255,.55); outline-offset:5px; }
  #lw.leaving { transition:opacity 1.1s ease-in, filter 1.1s ease-in; opacity:0; filter:blur(8px); pointer-events:none; }
  @keyframes lw-draw { to { stroke-dashoffset:0; } }
  @keyframes lw-breathe { 50% { filter:drop-shadow(0 0 4px rgba(255,178,56,.3)) drop-shadow(0 0 14px rgba(255,95,143,.22)) drop-shadow(0 0 28px rgba(94,200,255,.2)); } }
  @keyframes lw-flicker { 0% { opacity:0; } 12% { opacity:.7; } 16% { opacity:.15; } 26% { opacity:.9; } 31% { opacity:.45; } 44% { opacity:1; } 100% { opacity:1; } }
  @keyframes lw-glow { 50% { text-shadow:0 0 10px rgba(238,241,251,.25), 0 0 40px rgba(94,200,255,.12); } }
  @keyframes lw-rise { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
  @media (prefers-reduced-motion: reduce) {
    #lw.run *, #lw.run .lw-mark path[pathLength] { animation:none !important; }
    #lw.run .lw-mark path[pathLength] { stroke-dashoffset:0; }
    #lw.leaving { transition:none; }
  }
`;

// The logo from app/assets/icon.svg without its tile. Where the second strokes
// cross the first, a mask cuts the first ones (the tile's colour did that before),
// so the weave reads over the starfield.
const MARK = '<svg class="lw-mark" viewBox="180 180 660 640" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
  + '<defs><clipPath id="lw-x"><rect x="340" y="500" width="230" height="220"/></clipPath>'
  + '<mask id="lw-m" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024"><rect x="0" y="0" width="1024" height="1024" fill="#fff"/>'
  + '<g fill="none" stroke-linecap="round" clip-path="url(#lw-x)"><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="#000" stroke-width="62"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" stroke="#000" stroke-width="62"/><path d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="#000" stroke-width="62"/></g></mask></defs>'
  + '<g fill="none" stroke-linecap="round"><g mask="url(#lw-m)"><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="26" pathLength="1"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" stroke="#ffb238" stroke-width="26" pathLength="1"/><path d="M240 770 C380 730 560 570 600 410 C630 290 592 216 532 222" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="26" pathLength="1"/></g><path class="lw-t2" d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(-30 0)" stroke="#ff5f8f" stroke-width="26" pathLength="1"/><path class="lw-t2" d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" stroke="#ffb238" stroke-width="26" pathLength="1"/><path class="lw-t2" d="M532 222 C462 230 440 330 448 460 C456 590 470 720 560 760 C640 796 720 766 790 700" transform="translate(30 0)" stroke="#5ec8ff" stroke-width="26" pathLength="1"/></g></svg>';

export const WELCOME_VIEW_HTML = String.raw`
<div id="lw" role="dialog" aria-modal="true" aria-label="Welcome to Loom" aria-hidden="true">
  <canvas id="lw-sky" aria-hidden="true"></canvas>
  <div class="lw-main">
    <div class="lw-halo" aria-hidden="true"></div>
    ` + MARK + String.raw`
    <h1 class="lw-word">Loom</h1>
    <p class="lw-lines"><span class="lw-l1">Claude Code meets Slack, GitHub and Gmail.</span><span class="lw-l2">Every thread, in one loom.</span></p>
    <button class="lw-enter" id="lw-enter" type="button">Enter</button>
  </div>
</div>
`;

export const WELCOME_VIEW_JS = String.raw`
// ---- Welcome screen ---------------------------------------------------------------
var LW = { open: false, raf: 0, t0: 0, W: 0, H: 0, layers: [], shots: [], nextShot: 1800, neb: null,
  ptr: { x: 0, y: 0, tx: 0, ty: 0 }, ls: [], done: null, reduce: false };
var LW_NEBULA = [
  { x: .18, y: .22, r: .30, c: '255,95,143', a: .055, sx: 1.4 },
  { x: .86, y: .62, r: .34, c: '94,200,255', a: .055, sx: 1.2 },
  { x: .55, y: .95, r: .30, c: '255,178,56', a: .04, sx: 1.8 },
  { x: .62, y: .12, r: .18, c: '94,200,255', a: .04, sx: 1 }
];
var LW_TINTS = ['255,255,255', '255,255,255', '255,255,255', '207,233,255', '255,230,194', '255,211,224'];
function lwRand(a, b) { return a + Math.random() * (b - a); }
function lwStars(n, r0, r1, a0, a1, w0, w1, glow) {
  var out = [];
  for (var i = 0; i < n; i++) out.push({ x: Math.random() * LW.W, y: Math.random() * LW.H, r: lwRand(r0, r1), a: lwRand(a0, a1), tw: lwRand(w0, w1), ph: lwRand(0, 6.3), c: LW_TINTS[Math.floor(Math.random() * LW_TINTS.length)], glow: glow });
  return out;
}
function lwNebula() {
  var n = document.createElement('canvas'), x = n.getContext('2d');
  n.width = Math.ceil(LW.W / 2); n.height = Math.ceil(LW.H / 2);
  x.globalCompositeOperation = 'lighter';
  LW_NEBULA.forEach(function (c) {
    for (var i = 0; i < 26; i++) {
      var cx = (c.x + lwRand(-c.r, c.r) * .7 * c.sx) * n.width, cy = (c.y + lwRand(-c.r, c.r) * .45) * n.height;
      var rr = lwRand(.25, .7) * c.r * n.width;
      var g = x.createRadialGradient(cx, cy, 0, cx, cy, rr);
      g.addColorStop(0, 'rgba(' + c.c + ',' + (c.a * lwRand(.4, 1)) + ')');
      g.addColorStop(1, 'rgba(' + c.c + ',0)');
      x.fillStyle = g; x.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
    }
  });
  return n;
}
function lwSize() {
  var cv = document.getElementById('lw-sky'), d = Math.min(window.devicePixelRatio || 1, 2);
  LW.W = window.innerWidth; LW.H = window.innerHeight;
  cv.width = LW.W * d; cv.height = LW.H * d;
  cv.getContext('2d').setTransform(d, 0, 0, d, 0, 0);
  var area = LW.W * LW.H;
  LW.layers = [
    { depth: .15, stars: lwStars(Math.floor(area / 2600), .25, .7, .25, .7, .5, 2, false) },
    { depth: .45, stars: lwStars(Math.floor(area / 9000), .6, 1.1, .4, .85, .3, 1.2, false) },
    { depth: 1, stars: lwStars(Math.floor(area / 45000), 1, 1.7, .6, 1, .2, .8, true) }
  ];
  LW.neb = lwNebula();
}
function lwFrame(now) {
  LW.raf = 0;
  if (!LW.open) return;
  var x = document.getElementById('lw-sky').getContext('2d'), W = LW.W, H = LW.H, p = LW.ptr;
  var t = LW.reduce ? 6000 : now - LW.t0;
  x.fillStyle = '#05060b'; x.fillRect(0, 0, W, H);
  p.x += (p.tx - p.x) * .02; p.y += (p.ty - p.y) * .02;
  x.drawImage(LW.neb, (LW.reduce ? 0 : Math.sin(t / 40000) * 20) - p.x * 10, -p.y * 8, W, H);
  LW.layers.forEach(function (L) {
    var ox = t * -.005 * L.depth - p.x * 24 * L.depth, oy = t * .0012 * L.depth - p.y * 18 * L.depth;
    L.stars.forEach(function (s) {
      var px = ((s.x + ox) % W + W) % W, py = ((s.y + oy) % H + H) % H;
      var a = s.a * (.65 + .35 * Math.sin(t / 1000 * s.tw + s.ph));
      if (s.glow) {
        var g = x.createRadialGradient(px, py, 0, px, py, s.r * 5);
        g.addColorStop(0, 'rgba(' + s.c + ',' + a + ')'); g.addColorStop(.25, 'rgba(' + s.c + ',' + (a * .35) + ')'); g.addColorStop(1, 'rgba(' + s.c + ',0)');
        x.fillStyle = g; x.fillRect(px - s.r * 5, py - s.r * 5, s.r * 10, s.r * 10);
      } else { x.fillStyle = 'rgba(' + s.c + ',' + a + ')'; x.fillRect(px, py, s.r * 1.6, s.r * 1.6); }
    });
  });
  if (!LW.reduce && t > LW.nextShot) {
    LW.shots.push({ x: lwRand(.1, .9) * W, y: lwRand(.05, .45) * H, a: Math.random() < .5 ? .35 : Math.PI - .35, born: t, life: lwRand(700, 1100), len: lwRand(120, 220), v: lwRand(.6, .9) });
    LW.nextShot = t + 7000 * lwRand(.6, 1.4);
  }
  LW.shots = LW.shots.filter(function (s) { return t - s.born < s.life; });
  LW.shots.forEach(function (s) {
    var k = (t - s.born) / s.life, d = (t - s.born) * s.v;
    var hx = s.x + Math.cos(s.a) * d, hy = s.y + Math.sin(s.a) * d, tx = hx - Math.cos(s.a) * s.len, ty = hy - Math.sin(s.a) * s.len;
    var g = x.createLinearGradient(tx, ty, hx, hy);
    g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,' + (.75 * Math.sin(k * Math.PI)) + ')');
    x.strokeStyle = g; x.lineWidth = 1.2; x.beginPath(); x.moveTo(tx, ty); x.lineTo(hx, hy); x.stroke();
  });
  if (!LW.reduce && !document.hidden) LW.raf = requestAnimationFrame(lwFrame);
}
function lwKick() { if (LW.open && !LW.raf && !document.hidden) LW.raf = requestAnimationFrame(lwFrame); }
function lwHalt() { if (LW.raf) { cancelAnimationFrame(LW.raf); LW.raf = 0; } }
function lwOn(target, type, fn) { target.addEventListener(type, fn); LW.ls.push([target, type, fn]); }
function lwOffAll() { LW.ls.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); }); LW.ls = []; }
// opts.replay: Settings > Help asked for it. opts.done: called once Enter has faded the screen out.
function showWelcome(opts) {
  opts = opts || {};
  var el = document.getElementById('lw');
  if (!el || LW.open) return;
  LW.open = true; LW.done = opts.done || null; LW.replay = !!opts.replay;
  LW.reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  LW.t0 = performance.now(); LW.shots = []; LW.nextShot = 1800; LW.ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  el.classList.remove('leaving', 'run');
  void el.offsetWidth;
  el.classList.add('open', 'run'); el.setAttribute('aria-hidden', 'false');
  lwSize();
  lwOn(window, 'resize', function () { lwSize(); if (LW.reduce) { lwHalt(); lwKick(); } });
  if (!LW.reduce) lwOn(window, 'pointermove', function (e) { LW.ptr.tx = e.clientX / LW.W - .5; LW.ptr.ty = e.clientY / LW.H - .5; });
  lwOn(document, 'visibilitychange', function () { if (document.hidden) lwHalt(); else lwKick(); });
  lwOn(document, 'keydown', function (e) { if (e.key === 'Enter' && document.activeElement && document.activeElement.id !== 'lw-enter') { e.preventDefault(); lwEnter(); } });
  lwOn(document.getElementById('lw-enter'), 'click', lwEnter);
  lwKick();
  setTimeout(function () { var b = document.getElementById('lw-enter'); if (b && LW.open) b.focus({ preventScroll: true }); }, 50);
}
function lwEnter() {
  if (!LW.open) return;
  var el = document.getElementById('lw'), done = LW.done;
  LW.open = false;
  lwHalt(); lwOffAll();
  if (typeof wzJson === 'function') wzJson('POST', '/api/wizard/welcome', {}).catch(function () {});
  var finish = function () {
    el.classList.remove('open', 'run', 'leaving'); el.setAttribute('aria-hidden', 'true');
    var c = document.getElementById('lw-sky'); c.width = 1; c.height = 1;
    LW.layers = []; LW.neb = null; LW.shots = [];
  };
  // The wizard (or the board) opens underneath, so the fade reveals it.
  if (done) done();
  if (LW.reduce) { finish(); return; }
  el.classList.add('leaving');
  setTimeout(finish, 1100);
}
window.showWelcome = showWelcome;
`;
