// DiZcover Service Worker: App-Shell offline, Kartenkacheln werden beim Ansehen zwischengespeichert.
const SHELL = 'dizcover-shell-v3';
const TILES = 'dizcover-tiles-v1';
const MAX_TILES = 2000;
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(
    keys.filter(k => k !== SHELL && k !== TILES).map(k => caches.delete(k))
  )).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Kartenkacheln: erst Netz, bei Offline aus dem Cache
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(
      fetch(e.request).then(res => {
        const copy = res.clone();
        caches.open(TILES).then(async c => {
          await c.put(e.request, copy);
          const keys = await c.keys();
          if (keys.length > MAX_TILES) for (const k of keys.slice(0, keys.length - MAX_TILES)) c.delete(k);
        });
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Eigene Dateien: erst Netz (immer aktuell), offline aus dem Cache
  if (url.origin === self.location.origin) {
    e.respondWith(
      fetch(e.request, { cache: 'no-cache' }).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Fremde Dateien (Leaflet, Schriften): Cache zuerst
  e.respondWith(
    caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
      return res;
    }))
  );
});
