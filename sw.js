// DiZcover Service Worker: App-Shell offline, Kartenkacheln werden beim Ansehen zwischengespeichert.
const SHELL = 'dizcover-shell-v2';
const TILES = 'dizcover-tiles-v1';
const MAX_TILES = 2000;
const ASSETS = [
  './', 'index.html', 'style.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
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

  // App-Shell & Schriften: Cache zuerst, im Hintergrund aktualisieren
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(res => {
        if (res.ok || res.type === 'opaque') caches.open(SHELL).then(c => c.put(e.request, res.clone()));
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});
