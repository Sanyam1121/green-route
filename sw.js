// Offline support. The app's own files and map data: network first (so updates show at once), cache when offline.
// Leaflet from unpkg: cache first. Map tiles: cached as you browse.
const V = 'gr-v9';
const SHELL = ['./', 'index.html', 'css/style.css', 'js/i18n.js', 'js/core.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon.svg',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css', 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== V && k !== 'gr-tiles').map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (u.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open('gr-tiles').then(async c => (await c.match(e.request)) || fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; })));
    return;
  }
  if (u.hostname === 'unpkg.com') { e.respondWith(caches.match(e.request).then(m => m || fetch(e.request))); return; }
  if (u.origin === location.origin) {
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const rc = r.clone(); caches.open(V).then(c => c.put(e.request, rc)); } return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true })));
  }
});
