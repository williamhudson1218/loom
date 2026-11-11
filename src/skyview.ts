// The night sky behind the welcome screen, the empty board and the setup wizard:
// faint nebulae in the logo's three thread colours, three parallax star layers,
// the odd shooting star, and (optionally) three thin threads drifting across.
// One renderer, many canvases: each caller gets a handle and stops it.
//
// Cost. The nebula is painted once into a half-size offscreen canvas; glowing
// stars are a pre-rendered sprite, not a gradient per star per frame; device
// pixel ratio and star count are capped; ambient uses run at 30 fps. The loop
// stops for good when stop() is called or alive() turns false, pauses while
// the page is hidden, and draws a single still frame under reduced motion.
//
// Plain browser JS in a string, spliced verbatim by dashboard.ts: no backtick,
// no dollar-brace and no backslash. Everything is prefixed loomSky / LSKY.

export const SKY_JS = String.raw`
// ---- Night sky (src/skyview.ts) ---------------------------------------------------
var LSKY_TINTS = ['255,255,255', '255,255,255', '255,255,255', '207,233,255', '255,230,194', '255,211,224'];
var LSKY_THREADS = ['255,95,143', '255,178,56', '94,200,255'];
var LSKY_SPRITES = {};
// The welcome screen's nebula: pink upper left, cyan lower right, amber low.
var LSKY_NEBULA = [
  { x: .18, y: .22, r: .30, c: '255,95,143', a: .055, sx: 1.4 },
  { x: .86, y: .62, r: .34, c: '94,200,255', a: .055, sx: 1.2 },
  { x: .55, y: .95, r: .30, c: '255,178,56', a: .04, sx: 1.8 },
  { x: .62, y: .12, r: .18, c: '94,200,255', a: .04, sx: 1 }
];
function lskyRand(a, b) { return a + Math.random() * (b - a); }
function lskySprite(tint) {
  if (LSKY_SPRITES[tint]) return LSKY_SPRITES[tint];
  var s = document.createElement('canvas'); s.width = s.height = 32;
  var x = s.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
  g.addColorStop(0, 'rgba(' + tint + ',1)'); g.addColorStop(.25, 'rgba(' + tint + ',.35)'); g.addColorStop(1, 'rgba(' + tint + ',0)');
  x.fillStyle = g; x.fillRect(0, 0, 32, 32);
  return (LSKY_SPRITES[tint] = s);
}
// opts: nebula [{x,y,r,c:'r,g,b',a,sx}], density (stars per area, 1 = the welcome
// screen), maxStars, dpr (cap), fps, shoot (ms between shooting stars, 0 = none),
// parallax (follow the pointer), threads (drifting thread strands), dim (0..1
// overall alpha), alive() (false stops the loop for good).
function loomSky(canvas, opts) {
  opts = opts || {};
  var reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  var ctx = canvas.getContext('2d');
  var S = { W: 0, H: 0, layers: [], neb: null, shots: [], next: 1800, raf: 0, last: 0, t0: performance.now(),
    ptr: { x: 0, y: 0, tx: 0, ty: 0 }, ls: [], stopped: false, frames: 0, ms: 0 };
  var step = 1000 / (opts.fps || 60) - 2;
  function on(t, type, fn) { t.addEventListener(type, fn); S.ls.push([t, type, fn]); }
  function stars(n, r0, r1, a0, a1, w0, w1, glow) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ x: Math.random() * S.W, y: Math.random() * S.H, r: lskyRand(r0, r1), a: lskyRand(a0, a1), tw: lskyRand(w0, w1), ph: lskyRand(0, 6.3), c: LSKY_TINTS[Math.floor(Math.random() * LSKY_TINTS.length)], glow: glow });
    return out;
  }
  function nebula() {
    var n = document.createElement('canvas'), x = n.getContext('2d');
    n.width = Math.max(1, Math.ceil(S.W / 2)); n.height = Math.max(1, Math.ceil(S.H / 2));
    x.globalCompositeOperation = 'lighter';
    (opts.nebula || []).forEach(function (c) {
      for (var i = 0; i < 26; i++) {
        var cx = (c.x + lskyRand(-c.r, c.r) * .7 * (c.sx || 1)) * n.width, cy = (c.y + lskyRand(-c.r, c.r) * .45) * n.height;
        var rr = lskyRand(.25, .7) * c.r * n.width, g = x.createRadialGradient(cx, cy, 0, cx, cy, rr);
        g.addColorStop(0, 'rgba(' + c.c + ',' + (c.a * lskyRand(.4, 1)) + ')'); g.addColorStop(1, 'rgba(' + c.c + ',0)');
        x.fillStyle = g; x.fillRect(cx - rr, cy - rr, rr * 2, rr * 2);
      }
    });
    return n;
  }
  function size() {
    var d = Math.min(window.devicePixelRatio || 1, opts.dpr || 1.5);
    S.W = Math.max(1, canvas.clientWidth); S.H = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(S.W * d); canvas.height = Math.round(S.H * d);
    ctx.setTransform(d, 0, 0, d, 0, 0);
    var area = S.W * S.H * (opts.density == null ? 1 : opts.density), cap = opts.maxStars || 900;
    var n0 = Math.min(Math.floor(area / 2600), Math.floor(cap * .74)), n1 = Math.min(Math.floor(area / 9000), Math.floor(cap * .22)), n2 = Math.min(Math.floor(area / 45000), Math.floor(cap * .04));
    S.layers = [
      { depth: .15, stars: stars(n0, .25, .7, .25, .7, .5, 2, false) },
      { depth: .45, stars: stars(n1, .6, 1.1, .4, .85, .3, 1.2, false) },
      { depth: 1, stars: stars(n2, 1, 1.7, .6, 1, .2, .8, true) }
    ];
    S.neb = nebula();
  }
  function threads(t) {
    var W = S.W, H = S.H;
    ctx.lineCap = 'round';
    for (var i = 0; i < 3; i++) {
      var base = H * (.3 + i * .2), amp = H * .07, ph = t / 9000 + i * 2.1, k = 2.2 + i * .35;
      for (var pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = 'rgba(' + LSKY_THREADS[i] + ',' + (pass ? .5 : .08) + ')';
        ctx.lineWidth = pass ? 1.2 : 6;
        ctx.beginPath();
        for (var j = 0; j <= 48; j++) {
          var s = j / 48, px = s * W, py = base + Math.sin(s * k * Math.PI + ph) * amp + Math.sin(s * 5 + ph * 1.7) * amp * .25;
          if (j) ctx.lineTo(px, py); else ctx.moveTo(px, py);
        }
        ctx.stroke();
      }
    }
  }
  function draw(now) {
    var c0 = performance.now(), W = S.W, H = S.H, p = S.ptr;
    var t = reduce ? 6000 : now - S.t0;
    ctx.globalAlpha = 1; ctx.fillStyle = opts.bg || '#05060b'; ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = opts.dim == null ? 1 : opts.dim;
    p.x += (p.tx - p.x) * .02; p.y += (p.ty - p.y) * .02;
    ctx.drawImage(S.neb, (reduce ? 0 : Math.sin(t / 40000) * 20) - p.x * 10, -p.y * 8, W, H);
    var dim = ctx.globalAlpha;
    S.layers.forEach(function (L) {
      var ox = t * -.005 * L.depth - p.x * 24 * L.depth, oy = t * .0012 * L.depth - p.y * 18 * L.depth;
      L.stars.forEach(function (s) {
        var px = ((s.x + ox) % W + W) % W, py = ((s.y + oy) % H + H) % H;
        var a = s.a * (.65 + .35 * Math.sin(t / 1000 * s.tw + s.ph)) * dim;
        if (s.glow) { ctx.globalAlpha = a; ctx.drawImage(lskySprite(s.c), px - s.r * 5, py - s.r * 5, s.r * 10, s.r * 10); }
        else { ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(' + s.c + ',' + a + ')'; ctx.fillRect(px, py, s.r * 1.6, s.r * 1.6); }
      });
    });
    ctx.globalAlpha = dim;
    if (opts.threads) threads(t);
    if (opts.shoot && !reduce && t > S.next) {
      S.shots.push({ x: lskyRand(.1, .9) * W, y: lskyRand(.05, .45) * H, a: Math.random() < .5 ? .35 : Math.PI - .35, born: t, life: lskyRand(700, 1100), len: lskyRand(120, 220), v: lskyRand(.6, .9) });
      S.next = t + opts.shoot * lskyRand(.6, 1.4);
    }
    S.shots = S.shots.filter(function (s) { return t - s.born < s.life; });
    S.shots.forEach(function (s) {
      var k = (t - s.born) / s.life, d = (t - s.born) * s.v;
      var hx = s.x + Math.cos(s.a) * d, hy = s.y + Math.sin(s.a) * d, tx = hx - Math.cos(s.a) * s.len, ty = hy - Math.sin(s.a) * s.len;
      var g = ctx.createLinearGradient(tx, ty, hx, hy);
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,' + (.75 * Math.sin(k * Math.PI)) + ')');
      ctx.strokeStyle = g; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
    });
    ctx.globalAlpha = 1;
    S.frames++; S.ms += performance.now() - c0;
  }
  function frame(now) {
    S.raf = 0;
    if (S.stopped) return;
    if (opts.alive && !opts.alive()) { stop(); return; }
    if (now - S.last >= step) { S.last = now; draw(now); }
    if (!reduce && !document.hidden) S.raf = requestAnimationFrame(frame);
  }
  function kick() { if (!S.stopped && !S.raf && !document.hidden) S.raf = requestAnimationFrame(frame); }
  function halt() { if (S.raf) { cancelAnimationFrame(S.raf); S.raf = 0; } }
  function stop() {
    if (S.stopped) return;
    S.stopped = true; halt();
    S.ls.forEach(function (l) { l[0].removeEventListener(l[1], l[2]); }); S.ls = [];
    if (S.ro) { S.ro.disconnect(); S.ro = null; }
    S.layers = []; S.neb = null; S.shots = [];
  }
  size();
  var onResize = function () { if (S.stopped || (canvas.clientWidth === S.W && canvas.clientHeight === S.H)) return; size(); if (reduce) { halt(); S.last = 0; kick(); } };
  if (window.ResizeObserver) { S.ro = new ResizeObserver(onResize); S.ro.observe(canvas); } else on(window, 'resize', onResize);
  if (opts.parallax && !reduce) on(window, 'pointermove', function (e) { S.ptr.tx = e.clientX / window.innerWidth - .5; S.ptr.ty = e.clientY / window.innerHeight - .5; });
  on(document, 'visibilitychange', function () { if (document.hidden) halt(); else kick(); });
  kick();
  return { stop: stop, running: function () { return !S.stopped; }, stats: function () { return { frames: S.frames, ms: S.ms, stars: S.layers.reduce(function (a, L) { return a + L.stars.length; }, 0), w: canvas.width, h: canvas.height }; } };
}
`;
