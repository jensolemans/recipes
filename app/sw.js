// Keeps a copy of the site on the device, so it opens straight away and works
// in a shop without signal. Google Drive and sign-in calls are not touched.
//
// The site itself (HTML, CSS, JS, fonts, parser) is served from the copy and
// refreshed in the background. The recipe index tries the network first for
// 3 seconds. Photos are kept once seen (a replaced photo gets a new file
// name, so a kept one is never stale) and dropped once the index no longer
// names them.
// On localhost everything else tries the network first, so edits show at once.
//
// build.py replaces the version below with a fingerprint of the site files,
// so every release is a new service worker that installs the whole new
// version at once, and the page offers a reload.
const CACHE = 'recipes-dev';
// Every site file. build.py fills this in from app/ (left empty here: the
// local preview always asks the network first).
const SITE = [];
const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

self.addEventListener('install', (ev) => {
  ev.waitUntil(caches.open(CACHE).then((c) => c.addAll(['./', 'data/recipes.json', ...SITE].map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
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

// Photos of recipes that are gone or got a new photo are never asked for
// again: drop them when a fresh recipe index comes in.
async function prunePhotos(res) {
  try {
    const { recipes = [] } = await res.clone().json();
    const ids = new Set(recipes.map((r) => r.image).filter(Boolean));
    if (!ids.size) return;
    const cache = await caches.open(CACHE);
    for (const req of await cache.keys()) {
      const m = new URL(req.url).pathname.match(/\/(?:img|thumb)\/([^/]+)\.jpg$/);
      if (m && !ids.has(m[1])) await cache.delete(req);
    }
  } catch { /* an index that does not parse prunes nothing */ }
}

async function networkFirst(req, timeout, net = fresh(req)) {
  try {
    if (!timeout) return await net;
    return await Promise.race([net, new Promise((_, no) => setTimeout(no, timeout))]);
  } catch {
    return (await cached(req)) || net;
  }
}

async function cacheFirst(req) {
  return (await cached(req)) || fresh(req);
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
  // A photo's name changes with the photo, so a kept one is always right.
  if (/\/(img|thumb)\/[^/]+\.jpg$/.test(url.pathname)) { ev.respondWith(cacheFirst(req)); return; }
  if (LOCAL) { ev.respondWith(networkFirst(key)); return; }
  if (url.pathname.endsWith('/data/recipes.json')) {
    const net = fresh(req);
    ev.waitUntil(net.then((res) => res.ok && prunePhotos(res)).catch(() => {}));
    ev.respondWith(networkFirst(req, 3000, net));
    return;
  }
  ev.respondWith(staleWhileRevalidate(key, ev));
});
