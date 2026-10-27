// Keeps a copy of the site on the device, so it opens straight away and works
// in a shop without signal. Google Drive and sign-in calls are not touched.
//
// The site itself (HTML, CSS, JS, fonts, parser) is served from the copy and
// refreshed in the background. The
// recipe index tries the network first for 3 seconds. Photos are kept once
// seen and refreshed like the site (a replaced photo keeps its file name).
// On localhost everything tries the network first, so edits show at once.
//
// build.py replaces the version below with a fingerprint of the site files,
// so every release is a new service worker that installs the whole new
// version at once, and the page offers a reload.
const CACHE = 'recipes-dev';
const SITE = [
  './', 'index.html', 'style.css', 'app.js', 'cooklang.js', 'drive.js', 'shopping.js', 'qr.js',
  'icon.svg', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'vendor/cooklang/cooklang_wasm_bg.js', 'vendor/cooklang/cooklang_wasm_bg.wasm',
  'fonts/bricolage-grotesque-latin-opsz-normal.woff2', 'fonts/bricolage-grotesque-latin-ext-opsz-normal.woff2',
  'fonts/newsreader-latin-opsz-normal.woff2', 'fonts/newsreader-latin-ext-opsz-normal.woff2',
  'fonts/newsreader-latin-opsz-italic.woff2', 'data/recipes.json',
];
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(SITE.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const keep = (req, res) => {
  if (res && res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy));
  }
  return res;
};
const cached = (req) => caches.match(req, { ignoreSearch: true });
// Always ask the server, not the browser's own 10 minute cache; an
// unchanged file only costs a short "not modified" answer.
const fresh = (req) => fetch(req, { cache: 'no-cache' }).then((res) => keep(req, res));

async function networkFirst(req, timeout) {
  const net = fresh(req);
  try {
    if (!timeout) return await net;
    return await Promise.race([net, new Promise((_, no) => setTimeout(no, timeout))]);
  } catch {
    return (await cached(req)) || net;
  }
}

async function staleWhileRevalidate(req, ev) {
  const hit = await cached(req);
  const net = fresh(req);
  if (hit) { ev.waitUntil(net.catch(() => {})); return hit; }
  return net;
}

// Tapping a finished timer's notification brings the site back.
self.addEventListener('notificationclick', (ev) => {
  ev.notification.close();
  ev.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => (
    list.length ? list[0].focus() : self.clients.openWindow(self.registration.scope)
  )));
});

self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // Every page of the site is index.html with a different #hash.
  const key = req.mode === 'navigate' ? new Request(new URL('./', self.registration.scope)) : req;
  if (LOCAL) { ev.respondWith(networkFirst(key)); return; }
  if (url.pathname.endsWith('/data/recipes.json')) { ev.respondWith(networkFirst(req, 3000)); return; }
  ev.respondWith(staleWhileRevalidate(key, ev));
});
