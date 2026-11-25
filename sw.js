// Offline support: app shell cache-first, map data network-first, map tiles cached as you browse.
const V = 'gr-v4';
const SHELL = ['./', 'index.html', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon.svg',
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
  const isData = u.origin === location.origin && (u.pathname.includes('/data/') || u.pathname.endsWith('/') || u.pathname.endsWith('index.html'));
  if (isData) {
    e.respondWith(fetch(e.request).then(r => { if (r.ok) { const rc = r.clone(); caches.open(V).then(c => c.put(e.request, rc)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true })));
    return;
  }
  if (SHELL.some(s => e.request.url.endsWith(s.replace('./', '')) || e.request.url === s)) {
    e.respondWith(caches.match(e.request).then(m => m || fetch(e.request)));
  }
});
