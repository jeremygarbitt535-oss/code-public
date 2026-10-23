const CACHE = 'arbitrageur-v3';
const ASSETS = ['/', '/manifest.json', '/premium.html', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  // Pages: network first so updates show up, cached copy when offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(url.pathname, copy));
          }
          return res;
        })
        .catch(() => caches.match(url.pathname).then((cached) => cached || caches.match('/')))
    );
    return;
  }

  // Static files: cache first. Everything else (API data) always goes to the network.
  if (ASSETS.includes(url.pathname) || /\.(png|svg|css|js|json)$/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
  }
});
