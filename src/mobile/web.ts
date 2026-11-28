// The phone's app, served under /m/ (see src/mobile/api.ts for the API behind it).
// mobileFile() maps a pathname to a static file; the server adds the headers (CSP, no-store,
// service-worker-allowed). Everything is embedded as strings so the esbuild bundle needs no
// asset copying. The page has no inline script: the CSP is script-src 'self'.

import { APP_CSS } from './webcss.ts';
import { APP_JS } from './webapp.ts';
import { VOICE_CSS, VOICE_JS } from './voiceapp.ts';
import { ICON_180_B64, ICON_192_B64, ICON_512_B64 } from './icons.ts';

export const MOBILE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Loom</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d0f15">
<meta name="color-scheme" content="light dark">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Loom">
<!-- Not black-translucent: on iOS 26 that sizes the home-screen web view short by the status bar
     height (WebKit 301108), leaving a strip at the bottom nothing can paint. Read at install time. -->
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<link rel="manifest" href="/m/manifest.webmanifest">
<link rel="apple-touch-icon" href="/m/icon-180.png">
<link rel="icon" type="image/png" href="/m/icon-192.png">
<link rel="stylesheet" href="/m/app.css">
</head>
<body>
<div id="app"></div>
<noscript>Loom needs JavaScript.</noscript>
<script src="/m/app.js" defer></script>
</body>
</html>
`;

export const MOBILE_MANIFEST = JSON.stringify({
  id: '/m/',
  name: 'Loom',
  short_name: 'Loom',
  description: 'Your Claude sessions, on your phone.',
  start_url: '/m/',
  scope: '/m/',
  display: 'standalone',
  orientation: 'portrait',
  background_color: '#0d0f15',
  theme_color: '#0d0f15',
  icons: [
    { src: '/m/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/m/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  ],
});

// The service worker: push display, notification taps, and an offline fallback for the app
// shell. It never touches /m/api/*. Plain string, no template pieces.
export const MOBILE_SW = String.raw`
var CACHE = 'loom-m-shell-1';
var SHELL = ['/m/', '/m/app.js', '/m/app.css', '/m/manifest.webmanifest', '/m/icon-192.png'];
self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).catch(function () {}).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var u = new URL(req.url);
  if (u.origin !== self.location.origin || u.pathname.indexOf('/m/') !== 0 || u.pathname.indexOf('/m/api/') === 0) return;
  e.respondWith(fetch(req).then(function (res) {
    if (res && res.ok) { var copy = res.clone(); caches.open(CACHE).then(function (c) { c.put(req, copy); }); }
    return res;
  }).catch(function () { return caches.match(req).then(function (m) { return m || caches.match('/m/'); }); }));
});
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'Loom', body: e.data ? e.data.text() : '' }; }
  var title = d.title || 'Loom';
  e.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    tag: d.tag || undefined,
    icon: '/m/icon-192.png',
    badge: '/m/icon-192.png',
    data: { url: d.url || '/m/' }
  }));
});
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var url = (e.notification.data && e.notification.data.url) || '/m/';
  if (url.indexOf('/m/') !== 0) url = '/m/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf('/m/') >= 0 && 'focus' in c) {
        c.postMessage({ type: 'nav', url: url });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
`;

type MobileFile = { type: string; body: string | Buffer };

const FILES: Record<string, () => MobileFile> = {
  '/m/': () => ({ type: 'text/html; charset=utf-8', body: MOBILE_HTML }),
  '/m/app.js': () => ({ type: 'text/javascript; charset=utf-8', body: APP_JS + VOICE_JS }),
  '/m/app.css': () => ({ type: 'text/css; charset=utf-8', body: APP_CSS + VOICE_CSS }),
  '/m/manifest.webmanifest': () => ({ type: 'application/manifest+json; charset=utf-8', body: MOBILE_MANIFEST }),
  '/m/sw.js': () => ({ type: 'text/javascript; charset=utf-8', body: MOBILE_SW }),
  '/m/icon-180.png': () => ({ type: 'image/png', body: Buffer.from(ICON_180_B64, 'base64') }),
  '/m/icon-192.png': () => ({ type: 'image/png', body: Buffer.from(ICON_192_B64, 'base64') }),
  '/m/icon-512.png': () => ({ type: 'image/png', body: Buffer.from(ICON_512_B64, 'base64') }),
};

export function mobileFile(pathname: string): MobileFile | null {
  const f = FILES[pathname];
  return f ? f() : null;
}
